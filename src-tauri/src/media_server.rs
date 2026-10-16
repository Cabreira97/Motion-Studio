//! A loopback HTTP server that feeds the editor preview on Linux/BSD.
//!
//! WebKitGTK will not play media from a custom URI scheme. A `<video>` pointed
//! at Tauri's `asset://` protocol fails with `MEDIA_ERR_SRC_NOT_SUPPORTED` even
//! though the scheme handler is called and answers the request — measured in
//! webkit2gtk-4.1 against the same recording that plays fine over `file://`,
//! both when answering the `Range` with a 206 and when ignoring it and sending
//! the whole file with a 200. And `file://` is itself out of reach, because the
//! app document lives on a custom scheme and cross-origin file access is
//! blocked; pointing a `file://` video at it from an `asset://` document fails
//! the same way.
//!
//! `http://` is the one scheme left that WebKitGTK hands to its media pipeline,
//! so recordings are read from here instead. Windows and macOS keep the asset
//! protocol, which works there.
//!
//! This is not a network service. It binds 127.0.0.1 on an ephemeral port, so
//! it is unreachable from off the machine; it serves nothing but regular files
//! under the recordings directory; and every URL carries a random per-run token
//! that other local processes cannot guess. It is read-only: anything that is
//! not a `GET` or `HEAD` of a valid token path is refused.

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};

/// Bytes copied per write while streaming a response body.
const CHUNK: usize = 64 * 1024;

/// Refuses absurd request lines rather than buffering them.
const MAX_REQUEST_LINE: u64 = 8 * 1024;

pub struct MediaServer {
    port: u16,
    token: String,
    root: PathBuf,
}

impl MediaServer {
    /// Binds the server and starts serving `root` in the background.
    pub fn start(root: PathBuf) -> std::io::Result<Self> {
        let root = root.canonicalize().unwrap_or(root);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = listener.local_addr()?.port();
        let token = random_token()?;

        let accept_token = token.clone();
        let accept_root = root.clone();
        std::thread::Builder::new()
            .name("media-server".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let token = accept_token.clone();
                    let root = accept_root.clone();
                    // A connection per request: WebKit opens several while
                    // seeking, and a slow read must not block the others.
                    let spawned = std::thread::Builder::new()
                        .name("media-server-conn".into())
                        .spawn(move || {
                            // A dropped client is normal here; nothing to report.
                            let _ = serve(stream, &token, &root);
                        });
                    if spawned.is_err() {
                        log::warn!("media server could not spawn a connection thread");
                    }
                }
            })?;

        Ok(Self { port, token, root })
    }

    /// The URL the webview should load for `path`, or `None` when the file is
    /// not one this server is willing to serve.
    pub fn url_for(&self, path: &Path) -> Option<String> {
        let canonical = path.canonicalize().ok()?;
        if !canonical.is_file() || !canonical.starts_with(&self.root) {
            return None;
        }
        Some(format!(
            "http://127.0.0.1:{}/{}/{}",
            self.port,
            self.token,
            percent_encode(canonical.to_str()?)
        ))
    }
}

/// 32 hex characters of kernel randomness, used as the path prefix every
/// request must carry.
fn random_token() -> std::io::Result<String> {
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn serve(stream: TcpStream, token: &str, root: &Path) -> std::io::Result<()> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(15)))?;
    stream.set_write_timeout(Some(std::time::Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut writer = stream;

    let mut request_line = String::new();
    (&mut reader)
        .take(MAX_REQUEST_LINE)
        .read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();

    // Headers, up to the blank line. Only Range matters.
    let mut range_header = None;
    loop {
        let mut line = String::new();
        if (&mut reader).take(MAX_REQUEST_LINE).read_line(&mut line)? == 0 {
            break;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("range") {
                range_header = Some(value.trim().to_string());
            }
        }
    }

    if method != "GET" && method != "HEAD" {
        return write_status(&mut writer, 405, "Method Not Allowed");
    }

    let Some(file) = resolve(&target, token, root) else {
        return write_status(&mut writer, 404, "Not Found");
    };

    let size = file.metadata()?.len();
    let handle = std::fs::File::open(&file)?;
    let (start, end, partial) = match range_header.as_deref().map(|h| parse_range(h, size)) {
        // A range we understand but cannot satisfy must say so explicitly, or
        // the player retries the same impossible request.
        Some(None) => {
            write_status_with(
                &mut writer,
                416,
                "Range Not Satisfiable",
                &[format!("Content-Range: bytes */{size}")],
                0,
                None,
            )?;
            return Ok(());
        }
        Some(Some((start, end))) => (start, end, true),
        None => (0, size.saturating_sub(1), false),
    };

    let length = if size == 0 { 0 } else { end - start + 1 };
    let mut headers = vec![
        format!("Content-Type: {}", content_type(&file)),
        "Accept-Ranges: bytes".to_string(),
        // The preview is the only consumer and the token changes every run.
        "Cache-Control: no-store".to_string(),
    ];
    if partial {
        headers.push(format!("Content-Range: bytes {start}-{end}/{size}"));
    }

    let body = if method == "HEAD" {
        None
    } else {
        Some((handle, start, length))
    };
    write_status_with(
        &mut writer,
        if partial { 206 } else { 200 },
        if partial { "Partial Content" } else { "OK" },
        &headers,
        length,
        body,
    )
}

/// Maps a request target onto a file this server may serve.
///
/// The target must be `/<token>/<percent-encoded absolute path>`, the token
/// must match, and the path must resolve — after following symlinks — to a
/// regular file inside the recordings directory.
fn resolve(target: &str, token: &str, root: &Path) -> Option<PathBuf> {
    let target = target.split(['?', '#']).next().unwrap_or(target);
    let rest = target.strip_prefix('/')?;
    let (given, encoded) = rest.split_once('/')?;
    if !constant_time_eq(given.as_bytes(), token.as_bytes()) {
        return None;
    }
    let decoded = percent_decode(encoded)?;
    let candidate = PathBuf::from(decoded).canonicalize().ok()?;
    if !candidate.is_file() || !candidate.starts_with(root) {
        return None;
    }
    Some(candidate)
}

/// Compares without an early exit, so a wrong token leaks no prefix length.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Parses a single byte range. `None` means the header was a range request
/// that cannot be satisfied; a missing header is the caller's business.
fn parse_range(header: &str, size: u64) -> Option<(u64, u64)> {
    // No range over an empty file is satisfiable, and the arithmetic below
    // would underflow trying.
    if size == 0 {
        return None;
    }
    let spec = header.trim().strip_prefix("bytes=")?.trim();
    // Multiple ranges are legal but no player here asks for them.
    if spec.contains(',') {
        return None;
    }
    let (first, last) = spec.split_once('-')?;
    let (start, end) = match (first.trim(), last.trim()) {
        ("", "") => return None,
        // A suffix range: the last N bytes.
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            if n == 0 {
                return None;
            }
            (size.saturating_sub(n), size.saturating_sub(1))
        }
        (s, "") => (s.parse().ok()?, size.saturating_sub(1)),
        (s, e) => (s.parse().ok()?, e.parse::<u64>().ok()?.min(size - 1)),
    };
    if start > end || start >= size {
        return None;
    }
    Some((start, end))
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("webm") => "video/webm",
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("mkv") => "video/x-matroska",
        Some("gif") => "image/gif",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

fn write_status(writer: &mut TcpStream, code: u16, reason: &str) -> std::io::Result<()> {
    write_status_with(writer, code, reason, &[], 0, None)
}

fn write_status_with(
    writer: &mut TcpStream,
    code: u16,
    reason: &str,
    headers: &[String],
    length: u64,
    body: Option<(std::fs::File, u64, u64)>,
) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {code} {reason}\r\nContent-Length: {length}\r\n");
    for header in headers {
        head.push_str(header);
        head.push_str("\r\n");
    }
    // One request per connection keeps the parser honest; WebKit reconnects.
    head.push_str("Connection: close\r\n\r\n");
    writer.write_all(head.as_bytes())?;

    if let Some((mut file, start, mut remaining)) = body {
        file.seek(SeekFrom::Start(start))?;
        let mut buffer = vec![0u8; CHUNK];
        while remaining > 0 {
            let want = remaining.min(CHUNK as u64) as usize;
            let read = file.read(&mut buffer[..want])?;
            if read == 0 {
                break;
            }
            writer.write_all(&buffer[..read])?;
            remaining -= read as u64;
        }
    }
    writer.flush()
}

/// Percent-encodes everything outside the unreserved set, so a path with
/// spaces, `#` or `?` survives the round trip intact.
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ranges() {
        assert_eq!(parse_range("bytes=0-1445", 4_895_249), Some((0, 1445)));
        assert_eq!(parse_range("bytes=100-", 1000), Some((100, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        // Past the end, so the server answers 416 rather than an empty body.
        assert_eq!(parse_range("bytes=2000-", 1000), None);
        assert_eq!(parse_range("bytes=0-0", 0), None);
        assert_eq!(parse_range("bytes=0-1,5-6", 1000), None);
        assert_eq!(parse_range("seconds=0-1", 1000), None);
    }

    #[test]
    fn round_trips_awkward_paths() {
        let path = "/home/u/.local/share/recordings/Recording 2026-10-16 11-04-51.webm";
        let encoded = percent_encode(path);
        assert!(!encoded.contains(' '));
        assert_eq!(percent_decode(&encoded).as_deref(), Some(path));
    }

    #[test]
    fn rejects_a_wrong_token() {
        let root = std::env::temp_dir();
        assert!(resolve("/not-the-token/%2Fetc%2Fpasswd", "token", &root).is_none());
    }

    #[test]
    fn rejects_a_file_outside_the_root() {
        let root = std::env::temp_dir().join("motion-studio-empty-root");
        std::fs::create_dir_all(&root).unwrap();
        let outside = percent_encode("/etc/passwd");
        assert!(resolve(&format!("/token/{outside}"), "token", &root).is_none());
    }

    /// Drives a real request over the socket, which is the only way to cover
    /// the status line, the headers and the body together.
    fn request(url: &str, extra: &[&str]) -> (String, Vec<u8>) {
        let rest = url.strip_prefix("http://").unwrap();
        let (authority, target) = rest.split_once('/').unwrap();
        let mut stream = TcpStream::connect(authority).unwrap();
        let mut head = format!("GET /{target} HTTP/1.1\r\nHost: {authority}\r\n");
        for header in extra {
            head.push_str(header);
            head.push_str("\r\n");
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes()).unwrap();
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).unwrap();
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        (
            String::from_utf8_lossy(&raw[..split]).to_string(),
            raw[split + 4..].to_vec(),
        )
    }

    #[test]
    fn serves_whole_files_and_ranges_over_the_socket() {
        let root = std::env::temp_dir().join("motion-studio-socket-root");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("clip name.webm");
        std::fs::write(&file, b"0123456789").unwrap();

        let server = MediaServer::start(root).unwrap();
        let url = server.url_for(&file).expect("the file is inside the root");

        let (head, body) = request(&url, &[]);
        assert!(head.starts_with("HTTP/1.1 200 OK"), "{head}");
        assert!(head.contains("Content-Type: video/webm"), "{head}");
        assert!(head.contains("Accept-Ranges: bytes"), "{head}");
        assert_eq!(body, b"0123456789");

        let (head, body) = request(&url, &["Range: bytes=2-5"]);
        assert!(head.starts_with("HTTP/1.1 206 Partial Content"), "{head}");
        assert!(head.contains("Content-Range: bytes 2-5/10"), "{head}");
        assert_eq!(body, b"2345");

        let (head, _) = request(&url, &["Range: bytes=99-"]);
        assert!(head.starts_with("HTTP/1.1 416"), "{head}");
    }

    #[test]
    fn will_not_serve_a_path_outside_the_root_it_was_given() {
        let root = std::env::temp_dir().join("motion-studio-guard-root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("inside.webm"), b"ok").unwrap();
        let server = MediaServer::start(root.clone()).unwrap();

        // A real URL, so the token is right — only the path is not.
        let legit = server.url_for(&root.join("inside.webm")).unwrap();
        let (prefix, _) = legit.rsplit_once('/').unwrap();
        let attack = format!("{prefix}/{}", percent_encode("/etc/passwd"));
        let (head, _) = request(&attack, &[]);
        assert!(head.starts_with("HTTP/1.1 404"), "{head}");

        assert!(server.url_for(Path::new("/etc/passwd")).is_none());
    }

    #[test]
    fn serves_a_file_inside_the_root() {
        let root = std::env::temp_dir().join("motion-studio-served-root");
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("clip name.webm");
        std::fs::write(&file, b"body").unwrap();
        let encoded = percent_encode(file.canonicalize().unwrap().to_str().unwrap());
        let resolved = resolve(&format!("/token/{encoded}"), "token", &root.canonicalize().unwrap());
        assert_eq!(resolved, Some(file.canonicalize().unwrap()));
    }
}

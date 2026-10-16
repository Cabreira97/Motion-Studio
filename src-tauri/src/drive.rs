//! Optional Google Drive upload. The only network access in the app, and only
//! after the user explicitly connects an account. OAuth uses the installed-app
//! loopback flow with PKCE. The OAuth client (entered in the app or set via
//! GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET) and the refresh token are kept in the
//! app-data directory.

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";
const FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL: &str = "https://www.googleapis.com/upload/drive/v3/files";
const SCOPES: &str = "openid email https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME: &str = "Motion Studio";
const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(300);
// Resumable upload chunks must be a multiple of 256 KiB.
const CHUNK_BYTES: usize = 32 * 256 * 1024;

pub struct DrivePaths {
    pub client: PathBuf,
    pub token: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveStatus {
    pub configured: bool,
    pub client_source: Option<&'static str>,
    pub client_id: Option<String>,
    pub connected: bool,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    pub web_view_link: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadProgress {
    pub path: String,
    pub sent: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredToken {
    refresh_token: String,
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthError {
    error: String,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadedFile {
    id: String,
    name: String,
    web_view_link: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ClientConfig {
    id: String,
    secret: String,
}

fn env_client() -> Option<ClientConfig> {
    let id = std::env::var("GOOGLE_CLIENT_ID").ok().filter(|v| !v.trim().is_empty())?;
    let secret = std::env::var("GOOGLE_CLIENT_SECRET").ok().filter(|v| !v.trim().is_empty())?;
    Some(ClientConfig { id, secret })
}

fn client_config(paths: &DrivePaths) -> Option<(ClientConfig, &'static str)> {
    if let Some(saved) = read_json::<ClientConfig>(&paths.client) {
        return Some((saved, "app"));
    }
    env_client().map(|c| (c, "env"))
}

fn require_config(paths: &DrivePaths) -> Result<ClientConfig, String> {
    client_config(paths).map(|(c, _)| c).ok_or_else(|| {
        "Google Drive is not configured. Add your OAuth client in the Google Drive screen.".to_string()
    })
}

pub fn validate_client(id: &str, secret: &str) -> Result<(), String> {
    if !id.ends_with(".apps.googleusercontent.com") || id.contains(char::is_whitespace) {
        return Err("The Client ID should look like 1234-abc.apps.googleusercontent.com.".into());
    }
    if secret.len() < 8 || secret.contains(char::is_whitespace) {
        return Err("The Client secret looks incomplete.".into());
    }
    Ok(())
}

pub fn save_client(paths: &DrivePaths, id: &str, secret: &str) -> Result<DriveStatus, String> {
    let (id, secret) = (id.trim(), secret.trim());
    validate_client(id, secret)?;
    let previous = read_json::<ClientConfig>(&paths.client);
    write_json(&paths.client, &ClientConfig { id: id.into(), secret: secret.into() })?;
    if previous.is_some_and(|p| p.id != id) && paths.token.exists() {
        std::fs::remove_file(&paths.token).map_err(|e| e.to_string())?;
    }
    Ok(status(paths))
}

pub async fn clear_client(paths: &DrivePaths) -> Result<DriveStatus, String> {
    disconnect(paths).await?;
    if paths.client.exists() {
        std::fs::remove_file(&paths.client).map_err(|e| e.to_string())?;
    }
    Ok(status(paths))
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn read_token(path: &Path) -> Option<StoredToken> {
    read_json(path)
}

fn write_token(path: &Path, token: &StoredToken) -> Result<(), String> {
    write_json(path, token)
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_string(value).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn status(paths: &DrivePaths) -> DriveStatus {
    let token = read_token(&paths.token);
    let client = client_config(paths);
    DriveStatus {
        configured: client.is_some(),
        client_source: client.as_ref().map(|(_, source)| *source),
        client_id: client.map(|(c, _)| c.id),
        connected: token.is_some(),
        email: token.and_then(|t| t.email),
    }
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

async fn oauth_error(res: reqwest::Response) -> String {
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    match serde_json::from_str::<OAuthError>(&body) {
        Ok(err) => format!(
            "Google rejected the request ({}): {}",
            err.error,
            err.error_description.unwrap_or_default()
        ),
        Err(_) => format!("Google request failed with HTTP {status}"),
    }
}

fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn query_param(request_line: &str, key: &str) -> Option<String> {
    let target = request_line.split_whitespace().nth(1)?;
    let query = target.split_once('?')?.1;
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

async fn respond(stream: &mut tokio::net::TcpStream, message: &str) {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Motion Studio</title>\
         <body style=\"font-family:system-ui;padding:48px;text-align:center\">\
         <h2>{message}</h2><p>You can close this tab and return to Motion Studio.</p></body>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn wait_for_code(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let n = stream.read(&mut buf).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        let line = request.lines().next().unwrap_or_default();

        if let Some(error) = query_param(line, "error") {
            respond(&mut stream, "Google Drive was not connected.").await;
            return Err(format!("Google sign-in was cancelled ({error})."));
        }
        let Some(code) = query_param(line, "code") else {
            respond(&mut stream, "Waiting for Google sign-in…").await;
            continue;
        };
        if query_param(line, "state").as_deref() != Some(expected_state) {
            respond(&mut stream, "Sign-in could not be verified.").await;
            return Err("Google sign-in returned an unexpected state; try again.".into());
        }
        respond(&mut stream, "Google Drive connected.").await;
        return Ok(code);
    }
}

pub async fn connect(app: &AppHandle, paths: &DrivePaths) -> Result<DriveStatus, String> {
    use tauri_plugin_opener::OpenerExt;

    let config = require_config(paths)?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");
    let verifier = random_token(48);
    let state = random_token(16);

    let auth_url = reqwest::Url::parse_with_params(
        AUTH_URL,
        &[
            ("client_id", config.id.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", SCOPES),
            ("code_challenge", pkce_challenge(&verifier).as_str()),
            ("code_challenge_method", "S256"),
            ("state", state.as_str()),
            ("access_type", "offline"),
            ("prompt", "consent"),
        ],
    )
    .map_err(|e| e.to_string())?;

    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|e| format!("Could not open the browser for Google sign-in: {e}"))?;

    let code = tokio::time::timeout(CONNECT_TIMEOUT, wait_for_code(listener, &state))
        .await
        .map_err(|_| "Timed out waiting for Google sign-in.".to_string())??;

    let client = http()?;
    let res = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", config.id.as_str()),
            ("client_secret", config.secret.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(oauth_error(res).await);
    }
    let tokens: TokenResponse = res.json().await.map_err(|e| e.to_string())?;
    let refresh_token = tokens
        .refresh_token
        .ok_or("Google did not return a refresh token; try connecting again.")?;

    let email = client
        .get(USERINFO_URL)
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .ok()
        .filter(|r| r.status().is_success());
    let email = match email {
        Some(r) => r
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("email").and_then(|e| e.as_str()).map(str::to_string)),
        None => None,
    };

    write_token(&paths.token, &StoredToken { refresh_token, email })?;
    Ok(status(paths))
}

pub async fn disconnect(paths: &DrivePaths) -> Result<DriveStatus, String> {
    let token_path = &paths.token;
    if let Some(token) = read_token(token_path) {
        if let Ok(client) = http() {
            let _ = client
                .post(REVOKE_URL)
                .form(&[("token", token.refresh_token.as_str())])
                .send()
                .await;
        }
    }
    if token_path.exists() {
        std::fs::remove_file(token_path).map_err(|e| e.to_string())?;
    }
    Ok(status(paths))
}

async fn access_token(client: &reqwest::Client, paths: &DrivePaths) -> Result<String, String> {
    let config = require_config(paths)?;
    let token_path = &paths.token;
    let stored = read_token(token_path).ok_or("Google Drive is not connected.")?;
    let res = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", config.id.as_str()),
            ("client_secret", config.secret.as_str()),
            ("refresh_token", stored.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if res.status().is_success() {
        let tokens: TokenResponse = res.json().await.map_err(|e| e.to_string())?;
        return Ok(tokens.access_token);
    }
    let message = oauth_error(res).await;
    if message.contains("invalid_grant") {
        let _ = std::fs::remove_file(token_path);
        return Err("Google Drive access expired or was revoked. Connect again.".into());
    }
    Err(message)
}

async fn ensure_folder(client: &reqwest::Client, token: &str) -> Result<String, String> {
    let query = format!("name = '{FOLDER_NAME}' and mimeType = '{FOLDER_MIME}' and trashed = false");
    let res = client
        .get(FILES_URL)
        .bearer_auth(token)
        .query(&[("q", query.as_str()), ("fields", "files(id)"), ("spaces", "drive")])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Could not list Google Drive folders (HTTP {}).", res.status()));
    }
    let listing: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if let Some(id) = listing["files"][0]["id"].as_str() {
        return Ok(id.to_string());
    }

    let res = client
        .post(FILES_URL)
        .bearer_auth(token)
        .query(&[("fields", "id")])
        .json(&serde_json::json!({ "name": FOLDER_NAME, "mimeType": FOLDER_MIME }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Could not create the Google Drive folder (HTTP {}).", res.status()));
    }
    let created: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    created["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Google Drive did not return a folder id.".to_string())
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("md") => "text/markdown",
        Some("txt") | Some("srt") | Some("vtt") => "text/plain",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

/// Parses the `Range: bytes=0-N` header of a 308 response into the next offset.
fn next_offset(range: Option<&str>) -> Option<u64> {
    let end = range?.strip_prefix("bytes=")?.split_once('-')?.1;
    end.trim().parse::<u64>().ok().map(|n| n + 1)
}

pub async fn upload(app: &AppHandle, paths: &DrivePaths, file_path: PathBuf) -> Result<DriveFile, String> {
    let meta = std::fs::metadata(&file_path).map_err(|e| format!("Cannot read {}: {e}", file_path.display()))?;
    let total = meta.len();
    let name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid file name.")?
        .to_string();
    let mime = mime_for(&file_path);
    let path_label = file_path.to_string_lossy().to_string();

    let client = http()?;
    let token = access_token(&client, paths).await?;
    let folder = ensure_folder(&client, &token).await?;

    let res = client
        .post(UPLOAD_URL)
        .bearer_auth(&token)
        .query(&[("uploadType", "resumable"), ("fields", "id,name,webViewLink")])
        .header("X-Upload-Content-Type", mime)
        .header("X-Upload-Content-Length", total.to_string())
        .json(&serde_json::json!({ "name": name, "parents": [folder] }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Google Drive refused the upload (HTTP {}).", res.status()));
    }
    let session = res
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or("Google Drive did not return an upload session.")?
        .to_string();

    let mut file = tokio::fs::File::open(&file_path).await.map_err(|e| e.to_string())?;
    let mut offset: u64 = 0;
    let mut buf = vec![0u8; CHUNK_BYTES];
    let emit = |sent: u64| {
        let _ = app.emit(
            "drive://progress",
            UploadProgress { path: path_label.clone(), sent, total },
        );
    };
    emit(0);

    loop {
        use tokio::io::AsyncSeekExt;
        file.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| e.to_string())?;
        let mut len = 0;
        while len < buf.len() {
            let n = file.read(&mut buf[len..]).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            len += n;
        }
        let range = if total == 0 {
            "bytes */0".to_string()
        } else {
            format!("bytes {}-{}/{}", offset, offset + len as u64 - 1, total)
        };

        let res = client
            .put(&session)
            .header(reqwest::header::CONTENT_RANGE, range)
            .header(reqwest::header::CONTENT_LENGTH, len)
            .body(buf[..len].to_vec())
            .send()
            .await
            .map_err(|e| e.to_string())?;

        match res.status().as_u16() {
            200 | 201 => {
                emit(total);
                let uploaded: UploadedFile = res.json().await.map_err(|e| e.to_string())?;
                let web_view_link = uploaded
                    .web_view_link
                    .unwrap_or_else(|| format!("https://drive.google.com/file/d/{}/view", uploaded.id));
                return Ok(DriveFile { id: uploaded.id, name: uploaded.name, web_view_link });
            }
            308 => {
                let header = res
                    .headers()
                    .get(reqwest::header::RANGE)
                    .and_then(|v| v.to_str().ok());
                offset = next_offset(header).unwrap_or(0);
                emit(offset);
            }
            code => return Err(format!("Upload to Google Drive failed (HTTP {code}).")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636_example() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn reads_query_params_from_request_line() {
        let line = "GET /?state=abc&code=4%2F0Ab-x&scope=email HTTP/1.1";
        assert_eq!(query_param(line, "code").as_deref(), Some("4/0Ab-x"));
        assert_eq!(query_param(line, "state").as_deref(), Some("abc"));
        assert_eq!(query_param(line, "error"), None);
        assert_eq!(query_param("GET /favicon.ico HTTP/1.1", "code"), None);
    }

    #[test]
    fn parses_resumable_range_header() {
        assert_eq!(next_offset(Some("bytes=0-8388607")), Some(8388608));
        assert_eq!(next_offset(None), None);
        assert_eq!(next_offset(Some("garbage")), None);
    }

    #[test]
    fn maps_video_mime_types() {
        assert_eq!(mime_for(Path::new("a/b/clip.MP4")), "video/mp4");
        assert_eq!(mime_for(Path::new("clip.webm")), "video/webm");
        assert_eq!(mime_for(Path::new("clip")), "application/octet-stream");
    }

    #[test]
    fn validates_oauth_client_fields() {
        assert!(validate_client("123-abc.apps.googleusercontent.com", "GOCSPX-secret").is_ok());
        assert!(validate_client("123-abc", "GOCSPX-secret").is_err());
        assert!(validate_client("123 abc.apps.googleusercontent.com", "GOCSPX-secret").is_err());
        assert!(validate_client("123-abc.apps.googleusercontent.com", "short").is_err());
    }

    #[test]
    fn saved_client_wins_and_changing_it_drops_the_token() {
        let dir = std::env::temp_dir().join(format!("motion-drive-{}", random_token(6)));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = DrivePaths { client: dir.join("client.json"), token: dir.join("token.json") };

        save_client(&paths, " 1-a.apps.googleusercontent.com ", "GOCSPX-one").unwrap();
        let s = status(&paths);
        assert!(s.configured);
        assert_eq!(s.client_source, Some("app"));
        assert_eq!(s.client_id.as_deref(), Some("1-a.apps.googleusercontent.com"));

        write_token(&paths.token, &StoredToken { refresh_token: "r".into(), email: None }).unwrap();
        save_client(&paths, "1-a.apps.googleusercontent.com", "GOCSPX-rotated").unwrap();
        assert!(status(&paths).connected);
        save_client(&paths, "2-b.apps.googleusercontent.com", "GOCSPX-two").unwrap();
        assert!(!status(&paths).connected);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn chunk_size_is_multiple_of_256_kib() {
        assert_eq!(CHUNK_BYTES % (256 * 1024), 0);
    }
}

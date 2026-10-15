//! Safe, cross-platform filename generation.
//!
//! The webview is never trusted with a raw filename: every write that lands on
//! disk goes through [`sanitize`], so a name typed by a user (or derived from a
//! page title) can never escape the target directory or collide with a
//! reserved device name.

const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Produces a filename (no directory separators) that is safe on macOS,
/// Windows and Linux. Never returns an empty string or a reserved name.
pub fn sanitize(input: &str, fallback: &str, max_len: usize) -> String {
    let max = max_len.max(8);

    // Collapse traversal segments before stripping separators.
    let without_traversal = input.replace("..", ".");

    let mut name: String = without_traversal
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '-'
            } else {
                c
            }
        })
        .collect();

    // Squeeze runs of separators and collapse whitespace.
    name = collapse(&name, '-');
    name = collapse(&name, ' ');
    name = name.trim().to_string();
    name = name
        .trim_matches(|c| c == '.' || c == '-' || c == ' ')
        .to_string();

    if name.chars().count() > max {
        let truncated: String = name.chars().take(max).collect();
        name = truncated
            .trim_matches(|c| c == '.' || c == '-' || c == ' ')
            .to_string();
    }

    if name.is_empty() {
        return fallback.to_string();
    }

    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    if RESERVED.contains(&stem.as_str()) {
        name = format!("_{name}");
    }

    name
}

fn collapse(input: &str, ch: char) -> String {
    let mut out = String::with_capacity(input.len());
    let mut prev = false;
    for c in input.chars() {
        if c == ch {
            if !prev {
                out.push(c);
            }
            prev = true;
        } else {
            out.push(c);
            prev = false;
        }
    }
    out
}

/// Joins a directory and a sanitized filename.
#[allow(dead_code)]
pub fn safe_join(dir: &str, filename: &str) -> std::path::PathBuf {
    std::path::Path::new(dir).join(sanitize(filename, "recording", 80))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_ordinary_names() {
        assert_eq!(sanitize("My Recording", "x", 80), "My Recording");
    }

    #[test]
    fn strips_separators_and_traversal() {
        assert_eq!(sanitize("../../etc/passwd", "x", 80), "etc-passwd");
        assert_eq!(
            sanitize("C:\\Windows\\System32", "x", 80),
            "C-Windows-System32"
        );
        assert_eq!(sanitize("a/b\\c", "x", 80), "a-b-c");
    }

    #[test]
    fn strips_illegal_characters() {
        assert_eq!(sanitize("weird:name*?\"<>|", "x", 80), "weird-name");
    }

    #[test]
    fn avoids_reserved_device_names() {
        assert_eq!(sanitize("CON", "x", 80), "_CON");
        assert_eq!(sanitize("com1.txt", "x", 80), "_com1.txt");
        assert_eq!(sanitize("NUL", "x", 80), "_NUL");
    }

    #[test]
    fn falls_back_when_empty() {
        assert_eq!(sanitize("   ", "recording", 80), "recording");
        assert_eq!(sanitize("///", "recording", 80), "recording");
    }

    #[test]
    fn enforces_max_length() {
        let long = "x".repeat(500);
        assert!(sanitize(&long, "fallback", 32).chars().count() <= 32);
    }

    #[test]
    fn never_escapes_directory() {
        for sample in ["..", "....", "../..", "a/../../b", "\u{0}evil"] {
            let name = sanitize(sample, "fallback", 80);
            assert!(!name.contains('/'));
            assert!(!name.contains('\\'));
            assert!(!name.starts_with('.'));
        }
    }

    #[test]
    fn safe_join_stays_inside_dir() {
        let joined = safe_join("/tmp/out", "../evil");
        assert!(joined.starts_with("/tmp/out"));
        assert_eq!(joined.file_name().unwrap(), "evil");
    }
}

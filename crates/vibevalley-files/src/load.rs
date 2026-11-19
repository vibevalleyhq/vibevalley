use std::io::Read;
use std::path::Path;

use crate::walk::io_error;
use crate::{FileContent, Language, Result};

const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "tif", "tiff", "heic", "heif", "avif", "svg",
];

/// How much of a file is inspected to decide whether it is binary.
const SNIFF_BYTES: usize = 8192;

pub(crate) fn language_from_path(path: &Path) -> Option<&'static str> {
    let name = path.file_name()?.to_str()?;
    let by_name = match name {
        "Cargo.lock" | "Pipfile" | "poetry.lock" | "uv.lock" => Some("toml"),
        ".bashrc" | ".bash_profile" | ".bash_aliases" | ".zshrc" | ".zshenv" | ".zprofile" | ".profile" | ".envrc" | "PKGBUILD" => Some("bash"),
        ".babelrc" | ".eslintrc" | ".prettierrc" | "composer.lock" | "flake.lock" => Some("json"),
        ".clang-format" | ".clang-tidy" => Some("yaml"),
        _ => None,
    };
    if by_name.is_some() {
        return by_name;
    }
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "json" | "jsonc" | "json5" | "geojson" | "webmanifest" | "ipynb" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "md" | "markdown" | "mdown" | "mkd" => "markdown",
        "py" | "pyi" | "pyw" => "python",
        "go" => "go",
        "sh" | "bash" | "zsh" | "ksh" | "command" => "bash",
        "html" | "htm" | "xhtml" => "html",
        "css" => "css",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "c++" | "hh" | "hpp" | "hxx" | "h++" | "ipp" | "inl" | "mm" => "cpp",
        "zig" | "zon" => "zig",
        "swift" => "swift",
        _ => return None,
    })
}

/// `#!/usr/bin/env python3` and friends, for scripts without an extension.
fn language_from_shebang(text: &str) -> Option<&'static str> {
    let line = text.lines().next()?.strip_prefix("#!")?;
    let mut words = line.split_whitespace();
    let mut program = words.next()?.rsplit('/').next()?;
    if program == "env" {
        program = words.find(|w| !w.starts_with('-') && !w.contains('='))?;
    }
    let program = program.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
    Some(match program {
        "sh" | "bash" | "zsh" | "dash" | "ksh" => "bash",
        "python" | "pypy" => "python",
        "node" | "nodejs" | "bun" | "deno" => "javascript",
        "swift" => "swift",
        _ => return None,
    })
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> String {
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            if little_endian {
                u16::from_le_bytes(*pair)
            } else {
                u16::from_be_bytes(*pair)
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

pub(crate) fn load_file(path: &Path, max_bytes: u64) -> Result<FileContent> {
    let meta = std::fs::metadata(path).map_err(|e| io_error(path, e))?;
    if meta.is_dir() {
        return Err(io_error(path, "is a directory"));
    }
    if is_image(path) {
        return Ok(FileContent::Image { path: path.to_path_buf() });
    }
    let size = meta.len();
    let mut file = std::fs::File::open(path).map_err(|e| io_error(path, e))?;

    // Sniffed before the size check so a huge binary reads as "binary"
    // rather than "too large to show".
    let mut head = vec![0u8; SNIFF_BYTES.min(size as usize)];
    let mut filled = 0;
    while filled < head.len() {
        match file.read(&mut head[filled..]).map_err(|e| io_error(path, e))? {
            0 => break,
            n => filled += n,
        }
    }
    head.truncate(filled);
    let utf16 = match head.as_slice() {
        [0xFF, 0xFE, ..] => Some(true),
        [0xFE, 0xFF, ..] => Some(false),
        _ => None,
    };
    if utf16.is_none() && head.contains(&0) {
        return Ok(FileContent::Binary { size });
    }
    if size > max_bytes {
        return Ok(FileContent::TooLarge { size });
    }

    let mut bytes = head;
    // The size can have changed since the metadata call; the limit holds
    // regardless.
    file.take(max_bytes.saturating_sub(bytes.len() as u64))
        .read_to_end(&mut bytes)
        .map_err(|e| io_error(path, e))?;

    let text = match utf16 {
        Some(little_endian) => decode_utf16(&bytes[2..], little_endian),
        None => {
            let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
            match std::str::from_utf8(body) {
                Ok(text) => text.to_string(),
                Err(_) => String::from_utf8_lossy(body).into_owned(),
            }
        }
    };
    let language = language_from_path(path)
        .or_else(|| language_from_shebang(&text))
        .map(|name| Language(name.to_string()));
    Ok(FileContent::Text { text, language })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::FilesError;

    fn lang(path: &str) -> Option<String> {
        Language::from_path(Path::new(path)).map(|l| l.0)
    }

    #[test]
    fn language_from_path_covers_every_highlighted_language() {
        let cases = [
            ("src/main.rs", "rust"),
            ("a/b.ts", "typescript"),
            ("App.tsx", "tsx"),
            ("x.mjs", "javascript"),
            ("x.jsx", "javascript"),
            ("package.json", "json"),
            ("Cargo.toml", "toml"),
            ("Cargo.lock", "toml"),
            (".github/workflows/ci.yml", "yaml"),
            ("读我.MD", "markdown"),
            ("tool.py", "python"),
            ("main.go", "go"),
            ("run.sh", "bash"),
            (".zshrc", "bash"),
            ("index.html", "html"),
            ("site.css", "css"),
            ("x.c", "c"),
            ("x.h", "c"),
            ("x.cpp", "cpp"),
            ("x.hpp", "cpp"),
            ("build.zig", "zig"),
            ("App.swift", "swift"),
        ];
        for (path, expected) in cases {
            assert_eq!(lang(path).as_deref(), Some(expected), "{path}");
            assert!(Language::supported().contains(&expected), "{expected}");
        }
        for path in ["Makefile", "notes.txt", "photo.png", "noext", ""] {
            assert_eq!(lang(path), None, "{path}");
        }
    }

    #[test]
    fn load_text_image_binary_and_too_large() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let write = |name: &str, bytes: &[u8]| {
            fs::write(dir.join(name), bytes).unwrap();
            dir.join(name)
        };

        let rust = write("主 程序.rs", "fn main() { println!(\"你好\"); }\n".as_bytes());
        assert_eq!(
            load_file(&rust, 1 << 20).unwrap(),
            FileContent::Text {
                text: "fn main() { println!(\"你好\"); }\n".into(),
                language: Some(Language("rust".into())),
            }
        );

        let plain = write("notes.txt", b"");
        assert_eq!(
            load_file(&plain, 10).unwrap(),
            FileContent::Text {
                text: String::new(),
                language: None
            }
        );

        // Invalid UTF-8 falls back to lossy decoding instead of failing.
        let latin1 = write("latin1.txt", b"caf\xe9 au lait\n");
        let FileContent::Text { text, .. } = load_file(&latin1, 1 << 20).unwrap() else {
            panic!("expected text");
        };
        assert_eq!(text, "caf\u{fffd} au lait\n");

        let bom = write("bom.json", b"\xEF\xBB\xBF{\"a\": 1}");
        let FileContent::Text { text, language } = load_file(&bom, 1 << 20).unwrap() else {
            panic!("expected text");
        };
        assert_eq!(text, "{\"a\": 1}");
        assert_eq!(language, Some(Language("json".into())));

        let mut utf16 = vec![0xFF, 0xFE];
        utf16.extend("héllo 世界\n".encode_utf16().flat_map(u16::to_le_bytes));
        let utf16 = write("utf16.txt", &utf16);
        let FileContent::Text { text, .. } = load_file(&utf16, 1 << 20).unwrap() else {
            panic!("expected text");
        };
        assert_eq!(text, "héllo 世界\n");

        let script = write("deploy", b"#!/usr/bin/env -S python3 -u\nprint(1)\n");
        let FileContent::Text { language, .. } = load_file(&script, 1 << 20).unwrap() else {
            panic!("expected text");
        };
        assert_eq!(language, Some(Language("python".into())));

        // Images are recognised by name and never read.
        let image = write("Logo.PNG", &[0x89, b'P', b'N', b'G', 0, 0, 0]);
        assert_eq!(load_file(&image, 2).unwrap(), FileContent::Image { path: image.clone() });
        let svg = write("icon.svg", b"<svg/>");
        assert_eq!(load_file(&svg, 1 << 20).unwrap(), FileContent::Image { path: svg.clone() });

        let binary = write("app.bin", &[0x7f, b'E', b'L', b'F', 0, 1, 2, 3]);
        assert_eq!(load_file(&binary, 1 << 20).unwrap(), FileContent::Binary { size: 8 });
        assert_eq!(load_file(&binary, 2).unwrap(), FileContent::Binary { size: 8 });

        let big = write("big.txt", "0123456789\n".repeat(1000).as_bytes());
        assert_eq!(load_file(&big, 10_999).unwrap(), FileContent::TooLarge { size: 11_000 });
        assert!(matches!(load_file(&big, 11_000).unwrap(), FileContent::Text { .. }));

        assert!(matches!(load_file(&dir.join("missing"), 10), Err(FilesError::Io(_))));
        assert!(matches!(load_file(dir, 10), Err(FilesError::Io(_))));
    }
}

use std::io::{BufWriter, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use sha2::Digest as _;

use super::releases::{self, Build};

const MAX_TEXT_BYTES: usize = 1_048_576;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const TEXT_TIMEOUT: Duration = Duration::from_secs(60);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(1800);
const MAX_HTTPS_REDIRECTS: usize = 10;

fn is_loopback_http(url: &str) -> bool {
    url.strip_prefix("http://")
        .and_then(|rest| rest.split('/').next())
        .and_then(|authority| authority.parse::<std::net::SocketAddr>().ok())
        .is_some_and(|address| address.ip().is_loopback())
}

fn validate_url(url: &str) -> Result<bool, String> {
    if url.starts_with("https://") {
        return Ok(false);
    }
    if is_loopback_http(url) {
        return Ok(true);
    }
    Err("only https URLs (or loopback http feeds) are allowed".into())
}

fn build_client(local_http: bool, total_timeout: Duration) -> Result<reqwest::Client, String> {
    let redirect_policy = reqwest::redirect::Policy::custom(move |attempt| {
        if local_http {
            return attempt.error("redirects are disabled for local loopback feeds");
        }
        if attempt.previous().len() >= MAX_HTTPS_REDIRECTS {
            return attempt.error("too many redirects");
        }
        if attempt.url().scheme() != "https" {
            return attempt.error("redirect to non-https URL refused");
        }
        attempt.follow()
    });
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(total_timeout)
        .redirect(redirect_policy)
        .user_agent(concat!("VibeValley/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

fn is_retryable_status(status: u16) -> bool {
    matches!(status, 408 | 429 | 500 | 502 | 503 | 504)
}

fn text_once(url: &str) -> Result<(u16, String), String> {
    let local = validate_url(url)?;
    let url = url.to_string();
    vibevalley_runtime::rt::block_on(async move {
        let client = build_client(local, TEXT_TIMEOUT)?;
        let mut resp = client
            .get(&url)
            .header(reqwest::header::ACCEPT, "application/json, application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("http: {e}"))?;
        let status = resp.status().as_u16();
        if let Some(len) = resp.content_length()
            && len > MAX_TEXT_BYTES as u64
        {
            return Err(format!("response exceeds {MAX_TEXT_BYTES} byte limit"));
        }
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("http: {e}"))? {
            if body.len().saturating_add(chunk.len()) > MAX_TEXT_BYTES {
                return Err(format!("response exceeds {MAX_TEXT_BYTES} byte limit"));
            }
            body.extend_from_slice(&chunk);
        }
        Ok((status, String::from_utf8_lossy(&body).into_owned()))
    })
}

pub fn text(url: &str) -> Result<(u16, String), String> {
    use backon::BackoffBuilder as _;
    text_with_backoff(
        url,
        backon::ExponentialBuilder::new()
            .with_min_delay(Duration::from_millis(250))
            .with_max_delay(Duration::from_secs(2))
            .with_max_times(2)
            .build(),
    )
}

fn text_with_backoff(url: &str, mut backoff: impl Iterator<Item = Duration>) -> Result<(u16, String), String> {
    loop {
        let (status, body) = text_once(url)?;
        if is_retryable_status(status)
            && let Some(delay) = backoff.next()
        {
            std::thread::sleep(delay);
            continue;
        }
        return Ok((status, body));
    }
}

fn download(url: &str, to: &Path, size: u64, mut percent: impl FnMut(u8)) -> Result<(), String> {
    let local = validate_url(url)?;
    let url = url.to_string();
    let to = to.to_path_buf();
    vibevalley_runtime::rt::block_on(async move {
        let client = build_client(local, DOWNLOAD_TIMEOUT)?;
        let mut resp = client.get(&url).send().await.map_err(|e| format!("http: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("http status {}", resp.status().as_u16()));
        }
        if let Some(len) = resp.content_length()
            && len > size
        {
            return Err(format!("download exceeds expected {size} bytes"));
        }
        let file = std::fs::File::create(&to).map_err(|e| format!("{}: {e}", to.display()))?;
        let mut writer = BufWriter::new(file);
        let mut got = 0u64;
        let mut last_pct = None;
        percent(0);
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("http: {e}"))? {
            got = got.saturating_add(chunk.len() as u64);
            if got > size {
                drop(writer);
                let _ = std::fs::remove_file(&to);
                return Err(format!("download exceeded expected {size} bytes"));
            }
            writer.write_all(&chunk).map_err(|e| format!("{}: {e}", to.display()))?;
            let pct = (got.saturating_mul(100) / size.max(1)).min(100) as u8;
            if last_pct != Some(pct) {
                last_pct = Some(pct);
                percent(pct);
            }
        }
        writer.flush().map_err(|e| format!("{}: {e}", to.display()))?;
        Ok(())
    })
}

pub fn measure(path: &Path) -> std::io::Result<(u64, String)> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = sha2::Sha512::new();
    let mut buffer = vec![0u8; 1 << 16];
    let mut size = 0u64;
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        size += n as u64;
    }
    let hex = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    Ok((size, hex))
}

/// Validates every zip entry path and rejects symbolic links directly in Rust without
/// spawning `/usr/bin/zipinfo`.
fn inspect_archive(zip_path: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("zip: {e}"))?;
    let mut names = String::new();
    for i in 0..archive.len() {
        let entry = archive.by_index_raw(i).map_err(|e| format!("zip: {e}"))?;
        let name = entry.name().map_err(|e| format!("archive paths: {e}"))?;
        if entry.is_symlink() || entry.unix_mode().is_some_and(|mode| (mode & 0o170000) == 0o120000) {
            return Err("the update archive contains symbolic links".into());
        }
        names.push_str(&name);
        names.push('\n');
    }
    if !releases::safe_archive(&names) {
        return Err("the update archive contains paths outside its app".into());
    }
    Ok(())
}

fn signature(app: &Path) -> Result<String, String> {
    let verified = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(app)
        .output()
        .map_err(|e| format!("codesign: {e}"))?;
    if !verified.status.success() {
        return Err(String::from_utf8_lossy(&verified.stderr).trim().to_string());
    }
    let said = Command::new("/usr/bin/codesign")
        .args(["-dv", "--verbose=2"])
        .arg(app)
        .output()
        .map_err(|e| format!("codesign: {e}"))?;
    Ok(String::from_utf8_lossy(&said.stderr).into_owned())
}

fn unpacked_app(folder: &Path, bundle: &Path) -> Result<PathBuf, String> {
    let expected = folder.join(bundle.file_name().ok_or("the app has no name")?);
    if expected.is_dir() {
        return Ok(expected);
    }
    releases::CHANNEL_BUNDLE_NAMES
        .iter()
        .map(|name| folder.join(name))
        .find(|path| path.is_dir())
        .ok_or_else(|| "the update archive contains no VibeValley app bundle".into())
}

fn validate_bundle_id(running_bundle_id: Option<&str>, next_plist: &str, file: &str) -> Result<(), String> {
    let next_id = releases::plist_bundle_id(next_plist);
    if !releases::valid_update_bundle_id(running_bundle_id, next_id) {
        return Err(match (running_bundle_id, next_id) {
            (Some(running), Some(next)) if releases::is_channel_bundle_id(next) => {
                format!("{file}: bundle identifier {next} does not match running app {running}")
            }
            _ => format!("{file}: not a VibeValley app"),
        });
    }
    Ok(())
}

pub fn staged_app(url: &str, build: &Build, version: &str, bundle: &Path, folder: &Path, percent: impl FnMut(u8)) -> Result<PathBuf, String> {
    let running = signature(bundle).map_err(|why| format!("running app signature: {why}"))?;
    let running_plist = std::fs::read_to_string(bundle.join("Contents/Info.plist")).unwrap_or_default();
    let running_bundle_id = releases::plist_bundle_id(&running_plist);
    let _ = std::fs::remove_dir_all(folder);
    std::fs::create_dir_all(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    let zip = folder.join("update.zip");
    download(url, &zip, build.size, percent)?;
    let (size, sha512) = measure(&zip).map_err(|e| e.to_string())?;
    if size != build.size || !sha512.eq_ignore_ascii_case(&build.sha512) {
        return Err(format!("{}: not the file the release lists", build.file));
    }
    inspect_archive(&zip)?;
    // ditto keeps what a .app holds that unzip would lose (symlinks, extended attributes).
    let unpacked = Command::new("/usr/bin/ditto")
        .args(["-x", "-k"])
        .arg(&zip)
        .arg(folder)
        .output()
        .map_err(|e| format!("ditto: {e}"))?;
    if !unpacked.status.success() {
        return Err(format!("{}: {}", build.file, String::from_utf8_lossy(&unpacked.stderr).trim()));
    }
    let _ = std::fs::remove_file(&zip);
    let app = unpacked_app(folder, bundle)?;
    let plist = std::fs::read_to_string(app.join("Contents/Info.plist")).unwrap_or_default();
    if releases::plist_version(&plist) != Some(version) {
        return Err(format!("{}: no VibeValley {version} in it", build.file));
    }
    validate_bundle_id(running_bundle_id, &plist, &build.file)?;
    let said = signature(&app).map_err(|why| format!("{}: its signature does not hold: {why}", build.file))?;
    if !releases::same_signer(releases::team_of(&running), releases::team_of(&said)) {
        return Err(format!("{}: not signed by the team that signed this app", build.file));
    }
    Ok(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_plain_http_is_only_allowed_for_a_loopback_feed_without_redirects() {
        use std::io::Write as _;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut connection, _) = listener.accept().unwrap();
            let mut request = [0u8; 2048];
            assert!(connection.read(&mut request).unwrap() > 0);
            connection
                .write_all(b"HTTP/1.1 302 Found\r\nLocation: http://example.invalid/release.json\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .unwrap();
        });
        assert!(text(&format!("http://{address}/release.json")).is_err());
        server.join().unwrap();
        assert!(text("http://example.invalid/release.json").is_err());
    }

    #[test]
    fn a_files_size_and_sha512_are_measured() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a");
        std::fs::write(&file, b"abc").unwrap();
        let (size, hex) = measure(&file).unwrap();
        assert_eq!(size, 3);
        assert_eq!(
            hex,
            "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
        );
    }

    #[test]
    fn text_retries_transient_server_errors_with_backon() {
        use backon::BackoffBuilder as _;
        use std::io::Write as _;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for response in [
                "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbusy",
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
            ] {
                let (mut connection, _) = listener.accept().unwrap();
                let mut request = [0u8; 2048];
                assert!(connection.read(&mut request).unwrap() > 0);
                connection.write_all(response.as_bytes()).unwrap();
            }
        });
        let backoff = backon::ExponentialBuilder::new()
            .with_min_delay(Duration::from_millis(1))
            .with_max_delay(Duration::from_millis(5))
            .with_max_times(2)
            .build();
        let (status, body) = text_with_backoff(&format!("http://{address}/release.json"), backoff).unwrap();
        assert_eq!((status, body.as_str()), (200, "{}"));
        server.join().unwrap();
    }

    #[test]
    fn download_streams_with_progress_and_enforces_max_size() {
        use std::io::Write as _;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("payload.bin");
        let payload = b"vibevalley-update-bytes";

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut conn, _) = listener.accept().unwrap();
                let mut req = [0u8; 2048];
                assert!(conn.read(&mut req).unwrap() > 0);
                let header = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", payload.len());
                conn.write_all(header.as_bytes()).unwrap();
                conn.write_all(payload).unwrap();
            }
        });

        let mut progress = Vec::new();
        download(&format!("http://{address}/app.zip"), &target, payload.len() as u64, |p| progress.push(p)).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), payload);
        assert_eq!(progress.last().copied(), Some(100));

        // Exceeding declared max size is rejected.
        let oversized = dir.path().join("oversized.bin");
        assert!(download(&format!("http://{address}/app.zip"), &oversized, 4, |_| {}).is_err());
        server.join().unwrap();
    }

    #[test]
    fn inspect_archive_validates_paths_and_rejects_symlinks() {
        use zip::write::SimpleFileOptions;

        let dir = tempfile::tempdir().unwrap();

        let make_zip = |name: &str, entries: &[(&str, u32, &[u8])]| -> PathBuf {
            let path = dir.path().join(name);
            let file = std::fs::File::create(&path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            for (entry_name, mode, data) in entries {
                let opts = SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored)
                    .unix_permissions(*mode);
                writer.start_file(*entry_name, opts).unwrap();
                writer.write_all(data).unwrap();
            }
            writer.finish().unwrap();
            path
        };

        let safe = make_zip("safe.zip", &[("VibeValley.app/Contents/Info.plist", 0o100644, b"<plist/>")]);
        assert!(inspect_archive(&safe).is_ok());

        let alpha = make_zip("alpha.zip", &[("VibeValley-Alpha.app/Contents/Info.plist", 0o100644, b"<plist/>")]);
        assert!(inspect_archive(&alpha).is_ok());

        let traversal = make_zip("traversal.zip", &[("VibeValley.app/../../evil", 0o100644, b"x")]);
        assert!(inspect_archive(&traversal).unwrap_err().contains("outside its app"));

        let symlink = dir.path().join("symlink.zip");
        {
            let file = std::fs::File::create(&symlink).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            writer.add_symlink("VibeValley.app/Contents/MacOS/link", "/etc/passwd", opts).unwrap();
            writer.finish().unwrap();
        }
        assert!(inspect_archive(&symlink).unwrap_err().contains("symbolic links"));
    }

    #[test]
    fn validate_bundle_id_accepts_all_channels_and_rejects_mismatches() {
        let plist_for = |id: &str| format!("<dict><key>CFBundleIdentifier</key><string>{id}</string></dict>");

        for id in releases::CHANNEL_BUNDLE_IDS {
            assert!(validate_bundle_id(Some(id), &plist_for(id), "update.zip").is_ok());
            assert!(validate_bundle_id(None, &plist_for(id), "update.zip").is_ok());
        }

        let mismatch = validate_bundle_id(Some("dev.vibevalley.app.alpha"), &plist_for("dev.vibevalley.app"), "VibeValley-0.2.0.zip").unwrap_err();
        assert!(mismatch.contains("does not match running app dev.vibevalley.app.alpha"), "{mismatch}");

        let foreign = validate_bundle_id(None, &plist_for("com.evil.app"), "evil.zip").unwrap_err();
        assert!(foreign.contains("not a VibeValley app"), "{foreign}");

        let missing = validate_bundle_id(Some("dev.vibevalley.app.alpha"), "<dict/>", "empty.zip").unwrap_err();
        assert!(missing.contains("not a VibeValley app"), "{missing}");
    }

    #[test]
    fn unpacked_app_resolves_channel_bundle_names() {
        let dir = tempfile::tempdir().unwrap();
        let alpha = dir.path().join("VibeValley-Alpha.app");
        std::fs::create_dir(&alpha).unwrap();

        assert_eq!(unpacked_app(dir.path(), Path::new("/Applications/VibeValley-Alpha.app")).unwrap(), alpha);
        assert_eq!(unpacked_app(dir.path(), Path::new("/Applications/Renamed.app")).unwrap(), alpha);
    }
}

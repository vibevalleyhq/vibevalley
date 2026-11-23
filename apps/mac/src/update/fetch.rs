use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use sha2::Digest as _;

use super::releases::{self, Build};

const CURL: &str = "/usr/bin/curl";

fn transfer(url: &str) -> Command {
    let local = url
        .strip_prefix("http://")
        .and_then(|rest| rest.split('/').next())
        .and_then(|authority| authority.parse::<std::net::SocketAddr>().ok())
        .is_some_and(|address| address.ip().is_loopback());
    let mut command = Command::new(CURL);
    command.args(["--proto", if local { "=http" } else { "=https" }, "--proto-redir", "=https"]);
    if local {
        command.args(["--max-redirs", "0"]);
    }
    command
}

fn is_retryable_status(status: u16) -> bool {
    matches!(status, 408 | 429 | 500 | 502 | 503 | 504)
}

fn text_once(url: &str) -> Result<(u16, String), String> {
    let out = transfer(url)
        .args(["-sSL", "--connect-timeout", "20", "--max-time", "60", "--max-filesize", "1048576"])
        .args(["-H", "accept: application/json, application/vnd.github+json", "-w", "\n%{http_code}", "--"])
        .arg(url)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("curl: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let body = String::from_utf8_lossy(&out.stdout);
    let (body, status) = body.rsplit_once('\n').ok_or("curl: no status")?;
    Ok((status.trim().parse().map_err(|_| "curl: no status")?, body.to_string()))
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
    let mut child = transfer(url)
        .arg("--max-filesize")
        .arg(size.to_string())
        .args(["-fsSL", "--connect-timeout", "20", "--max-time", "1800", "-o"])
        .arg(to)
        .arg("--")
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("curl: {e}"))?;
    let status = loop {
        let got = std::fs::metadata(to).map_or(0, |m| m.len());
        percent((got.saturating_mul(100) / size.max(1)).min(100) as u8);
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None => std::thread::sleep(Duration::from_millis(200)),
        }
    };
    if status.success() {
        return Ok(());
    }
    let mut why = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut why);
    }
    Err(if why.trim().is_empty() {
        format!("curl exited with {status}")
    } else {
        why.trim().to_string()
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

pub fn staged_app(url: &str, build: &Build, version: &str, bundle: &Path, folder: &Path, percent: impl FnMut(u8)) -> Result<PathBuf, String> {
    let running = signature(bundle).map_err(|why| format!("running app signature: {why}"))?;
    let _ = std::fs::remove_dir_all(folder);
    std::fs::create_dir_all(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
    let zip = folder.join("update.zip");
    download(url, &zip, build.size, percent)?;
    let (size, sha512) = measure(&zip).map_err(|e| e.to_string())?;
    if size != build.size || !sha512.eq_ignore_ascii_case(&build.sha512) {
        return Err(format!("{}: not the file the release lists", build.file));
    }
    let listing = Command::new("/usr/bin/zipinfo")
        .arg("-1")
        .arg(&zip)
        .output()
        .map_err(|e| format!("zipinfo: {e}"))?;
    let names = String::from_utf8(listing.stdout).map_err(|e| format!("archive paths: {e}"))?;
    if !listing.status.success() || !releases::safe_archive(&names) {
        return Err("the update archive contains paths outside its app".into());
    }
    let metadata = Command::new("/usr/bin/zipinfo")
        .arg("-l")
        .arg(&zip)
        .output()
        .map_err(|e| format!("zipinfo: {e}"))?;
    if !metadata.status.success() || String::from_utf8_lossy(&metadata.stdout).lines().any(|line| line.starts_with('l')) {
        return Err("the update archive contains symbolic links".into());
    }
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
    let app = folder.join(bundle.file_name().ok_or("the app has no name")?);
    let plist = std::fs::read_to_string(app.join("Contents/Info.plist")).unwrap_or_default();
    if releases::plist_version(&plist) != Some(version) {
        return Err(format!("{}: no VibeValley {version} in it", build.file));
    }
    if !plist.contains("<key>CFBundleIdentifier</key><string>dev.vibevalley.app</string>") {
        return Err(format!("{}: not a VibeValley app", build.file));
    }
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
}

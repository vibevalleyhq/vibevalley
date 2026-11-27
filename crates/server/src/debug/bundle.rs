//! Standard DEFLATE-compressed ZIP writer exporting redacted diagnostics
//! bundles to `<home>/debug-bundles/debug-bundle-<ts>.zip`.

use std::io::Write as _;
use std::path::Path;

use vibevalley_protocol::{ApiError, BizCode, DebugBundleResult};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::redact::Redactor;
use crate::context::now;

pub struct BundlePayloads {
    pub overview_json: String,
    pub routes_json: String,
    pub timeline_json: String,
    pub graph_json: String,
    pub state_cache_json: String,
    pub overrides_json: String,
    pub trajectories_json: String,
}

pub async fn export_bundle_async(home: &Path, redactor: &Redactor, payloads: BundlePayloads, prior_redactions: u32) -> Result<DebugBundleResult, ApiError> {
    let mut redacted_count = prior_redactions;
    let raw_entries: [(&str, String); 7] = [
        ("overview.json", payloads.overview_json),
        ("routes.json", payloads.routes_json),
        ("timeline.json", payloads.timeline_json),
        ("graph.json", payloads.graph_json),
        ("state-cache.json", payloads.state_cache_json),
        ("overrides.json", payloads.overrides_json),
        ("trajectories.json", payloads.trajectories_json),
    ];

    let mut prepared: Vec<(&str, Vec<u8>)> = Vec::with_capacity(raw_entries.len());
    for (name, raw_json) in raw_entries {
        let bytes = redactor
            .redact_json_pretty_bytes(&raw_json, &mut redacted_count)
            .map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?;
        if let Some(reason) = redactor.contains_leak(&bytes) {
            return Err(ApiError::new(BizCode::InternalError, format!("redaction guard tripped on {name}: {reason}")));
        }
        prepared.push((name, bytes));
    }

    let zip_entries: Vec<(&str, &[u8])> = prepared.iter().map(|(n, b)| (*n, b.as_slice())).collect();
    let archive = write_zip_deflated(&zip_entries).map_err(|e| ApiError::new(BizCode::InternalError, format!("build debug bundle zip: {e}")))?;

    let dir = home.join("debug-bundles");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| ApiError::new(BizCode::InternalError, format!("create debug-bundles: {e}")))?;
    let stamp = now();
    let file_name = format!("debug-bundle-{stamp}.zip");
    let final_path = dir.join(&file_name);
    let tmp_path = dir.join(format!(".{file_name}.tmp"));

    write_private_bytes_async(&tmp_path, &archive)
        .await
        .map_err(|e| ApiError::new(BizCode::InternalError, format!("write debug bundle: {e}")))?;
    tokio::fs::rename(&tmp_path, &final_path)
        .await
        .map_err(|e| ApiError::new(BizCode::InternalError, format!("finalize debug bundle: {e}")))?;

    Ok(DebugBundleResult {
        path: final_path.to_string_lossy().into_owned(),
        size_bytes: archive.len() as i64,
        files: prepared.into_iter().map(|(n, _)| n.to_string()).collect(),
        redacted_count,
    })
}

async fn write_private_bytes_async(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut f = tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .await?;
    tokio::io::AsyncWriteExt::write_all(&mut f, bytes).await?;
    f.sync_all().await
}

/// Packs `(name, bytes)` entries into a valid ZIP archive using DEFLATE compression.
pub(crate) fn write_zip_deflated(entries: &[(&str, &[u8])]) -> zip::result::ZipResult<Vec<u8>> {
    let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    for &(name, data) in entries {
        writer.start_file(name, options)?;
        writer.write_all(data)?;
    }
    Ok(writer.finish()?.into_inner())
}

#[cfg(test)]
mod tests {
    use std::io::Read as _;

    use super::*;

    fn parse_zip_deflated(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("valid ZIP archive");
        let mut out = Vec::with_capacity(archive.len());
        for i in 0..archive.len() {
            let mut file = archive.by_index(i).expect("zip entry");
            assert_eq!(file.compression(), CompressionMethod::Deflated);
            let name = file.name().to_string();
            let mut data = Vec::with_capacity(file.size() as usize);
            file.read_to_end(&mut data).expect("read deflated entry");
            out.push((name, data));
        }
        out
    }

    #[test]
    fn zip_writer_round_trips_multiple_entries_with_deflate() {
        let zip = write_zip_deflated(&[("a.json", br#"{"ok":true}"#), ("b.txt", b"hello devtools")]).unwrap();
        let entries = parse_zip_deflated(&zip);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].0, "a.json");
        assert_eq!(entries[0].1, br#"{"ok":true}"#);
        assert_eq!(entries[1].0, "b.txt");
        assert_eq!(entries[1].1, b"hello devtools");
    }
}

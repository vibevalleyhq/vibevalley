//! Pure-Rust standard ZIP (STORE method 0 + IEEE CRC32) writer exporting
//! redacted diagnostics bundles to `<home>/debug-bundles/debug-bundle-<ts>.zip`.

use std::path::Path;

use vibevalley_protocol::{ApiError, BizCode, DebugBundleResult};

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
    let archive = write_zip_store(&zip_entries);

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

/// Packs `(name, bytes)` entries into a valid ZIP archive using STORE (method 0)
/// and IEEE 802.3 CRC32.
pub(crate) fn write_zip_store(entries: &[(&str, &[u8])]) -> Vec<u8> {
    const DOS_TIME: u16 = 0;
    // 2026-01-01 in MS-DOS date format: ((2026 - 1980) << 9) | (1 << 5) | 1
    const DOS_DATE: u16 = ((2026 - 1980) << 9) | (1 << 5) | 1;
    const UTF8_FLAG: u16 = 0x0800;

    let total_data: usize = entries.iter().map(|(n, d)| 30 + n.len() + d.len()).sum();
    let total_cd: usize = entries.iter().map(|(n, _)| 46 + n.len()).sum();
    let mut out = Vec::with_capacity(total_data + total_cd + 22);
    let mut central = Vec::with_capacity(total_cd);

    for &(name, data) in entries {
        let name_bytes = name.as_bytes();
        let crc = crc32fast::hash(data);
        let size = u32::try_from(data.len()).expect("zip entry exceeds 4 GiB");
        let name_len = u16::try_from(name_bytes.len()).expect("zip entry name too long");
        let offset = u32::try_from(out.len()).expect("zip archive exceeds 4 GiB");

        // Local file header (30 bytes + name)
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&UTF8_FLAG.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // method 0 = STORE
        out.extend_from_slice(&DOS_TIME.to_le_bytes());
        out.extend_from_slice(&DOS_DATE.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&name_len.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra len
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(data);

        // Central directory header (46 bytes + name)
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central.extend_from_slice(&UTF8_FLAG.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // method 0 = STORE
        central.extend_from_slice(&DOS_TIME.to_le_bytes());
        central.extend_from_slice(&DOS_DATE.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&name_len.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra len
        central.extend_from_slice(&0u16.to_le_bytes()); // comment len
        central.extend_from_slice(&0u16.to_le_bytes()); // disk number start
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        central.extend_from_slice(&(0o100_644u32 << 16).to_le_bytes()); // external attrs
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name_bytes);
    }

    let cd_offset = u32::try_from(out.len()).expect("zip archive exceeds 4 GiB");
    let cd_size = u32::try_from(central.len()).expect("zip central directory exceeds 4 GiB");
    let count = u16::try_from(entries.len()).expect("too many zip entries");

    out.extend_from_slice(&central);

    // End of central directory record (22 bytes)
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // this disk
    out.extend_from_slice(&0u16.to_le_bytes()); // cd start disk
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment len

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal standard ZIP parser verifying local headers, central directory,
    /// EOCD, and IEEE CRC32 checksums.
    pub(crate) fn parse_zip_store(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
        let eocd_pos = bytes
            .windows(4)
            .rposition(|w| w == 0x0605_4b50u32.to_le_bytes())
            .expect("EOCD signature present");
        let count = u16::from_le_bytes([bytes[eocd_pos + 10], bytes[eocd_pos + 11]]) as usize;
        let cd_offset = u32::from_le_bytes(bytes[eocd_pos + 16..eocd_pos + 20].try_into().unwrap()) as usize;

        let mut pos = cd_offset;
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            assert_eq!(&bytes[pos..pos + 4], &0x0201_4b50u32.to_le_bytes());
            let method = u16::from_le_bytes([bytes[pos + 10], bytes[pos + 11]]);
            assert_eq!(method, 0);
            let crc = u32::from_le_bytes(bytes[pos + 16..pos + 20].try_into().unwrap());
            let size = u32::from_le_bytes(bytes[pos + 20..pos + 24].try_into().unwrap()) as usize;
            let name_len = u16::from_le_bytes([bytes[pos + 28], bytes[pos + 29]]) as usize;
            let extra_len = u16::from_le_bytes([bytes[pos + 30], bytes[pos + 31]]) as usize;
            let comment_len = u16::from_le_bytes([bytes[pos + 32], bytes[pos + 33]]) as usize;
            let local_off = u32::from_le_bytes(bytes[pos + 42..pos + 46].try_into().unwrap()) as usize;
            let name = std::str::from_utf8(&bytes[pos + 46..pos + 46 + name_len]).unwrap().to_string();
            pos += 46 + name_len + extra_len + comment_len;

            assert_eq!(&bytes[local_off..local_off + 4], &0x0403_4b50u32.to_le_bytes());
            let l_name_len = u16::from_le_bytes([bytes[local_off + 26], bytes[local_off + 27]]) as usize;
            let l_extra_len = u16::from_le_bytes([bytes[local_off + 28], bytes[local_off + 29]]) as usize;
            let data_start = local_off + 30 + l_name_len + l_extra_len;
            let data = bytes[data_start..data_start + size].to_vec();
            assert_eq!(crc32fast::hash(&data), crc, "CRC32 mismatch for {name}");
            out.push((name, data));
        }
        out
    }

    #[test]
    fn zip_writer_round_trips_multiple_entries_with_valid_crc32() {
        let zip = write_zip_store(&[("a.json", br#"{"ok":true}"#), ("b.txt", b"hello devtools")]);
        let entries = parse_zip_store(&zip);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].0, "a.json");
        assert_eq!(entries[0].1, br#"{"ok":true}"#);
        assert_eq!(entries[1].0, "b.txt");
        assert_eq!(entries[1].1, b"hello devtools");
    }
}

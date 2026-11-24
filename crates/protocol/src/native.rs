//! Endpoints only the native app serves (not in packages/protocol). They sit
//! beside the generated table: [`crate::endpoint`] finds them too.

use serde::{Deserialize, Serialize};

use crate::wire::{Caller, Endpoint, Op};

pub const NATIVE_ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "media.input.file",
        module: "media",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaInputFileInput"),
        result: Some("AttachmentFile"),
    },
    Endpoint {
        op: "media.input.uploadFile",
        module: "media",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaInputUploadFileInput"),
        result: Some("MediaInput"),
    },
    // POST /api/v1/attachment/file stays blocked as a native endpoint; GET /api/v1/attachment/{id}
    // authorizes authenticated remote read-only downloads through this spec.
    Endpoint {
        op: "attachment.file",
        module: "attachment",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("AttachmentFileInput"),
        result: Some("AttachmentFile"),
    },
];

/// Compile-time exhaustive identifier for every endpoint in [`NATIVE_ENDPOINTS`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(usize)]
pub enum NativeEndpointId {
    MediaInputFile = 0,
    MediaInputUploadFile = 1,
    AttachmentFile = 2,
}

impl NativeEndpointId {
    pub const ALL: &'static [Self] = &[Self::MediaInputFile, Self::MediaInputUploadFile, Self::AttachmentFile];

    pub fn from_op(op: &str) -> Option<Self> {
        match op {
            "media.input.file" => Some(Self::MediaInputFile),
            "media.input.uploadFile" => Some(Self::MediaInputUploadFile),
            "attachment.file" => Some(Self::AttachmentFile),
            _ => None,
        }
    }

    pub const fn op(self) -> &'static str {
        match self {
            Self::MediaInputFile => "media.input.file",
            Self::MediaInputUploadFile => "media.input.uploadFile",
            Self::AttachmentFile => "attachment.file",
        }
    }

    pub const fn spec(self) -> &'static Endpoint {
        &NATIVE_ENDPOINTS[self as usize]
    }
}

/// The attachment's id (the sha256 of its bytes).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentFileInput {
    pub id: String,
}

/// Where a kept attachment's bytes are on this machine, and its media type:
/// the views show it from the path; the HTTP adapter serves it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentFile {
    /// Absolute.
    pub path: String,
    pub r#type: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MediaInputFileInput {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MediaInputUploadFileInput {
    pub id: String,
    pub path: String,
}

pub mod native_ops {
    use super::*;

    pub struct MediaInputFile;
    impl Op for MediaInputFile {
        const NAME: &'static str = "media.input.file";
        type Input = MediaInputFileInput;
        type Result = super::AttachmentFile;
    }

    pub struct MediaInputUploadFile;
    impl Op for MediaInputUploadFile {
        const NAME: &'static str = "media.input.uploadFile";
        type Input = MediaInputUploadFileInput;
        type Result = crate::MediaInput;
    }

    /// A kept attachment's file: its absolute path and media type.
    pub struct AttachmentFile;
    impl Op for AttachmentFile {
        const NAME: &'static str = "attachment.file";
        type Input = AttachmentFileInput;
        type Result = super::AttachmentFile;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn native_endpoint_id_matches_native_endpoints_table_exhaustively() {
        assert_eq!(NativeEndpointId::ALL.len(), NATIVE_ENDPOINTS.len());

        let mut seen = HashSet::new();
        for (idx, ep) in NATIVE_ENDPOINTS.iter().enumerate() {
            let id = NativeEndpointId::from_op(ep.op).unwrap_or_else(|| panic!("missing NativeEndpointId for {}", ep.op));
            assert_eq!(id, NativeEndpointId::ALL[idx], "order mismatch at index {idx} ({})", ep.op);
            assert_eq!(id.op(), ep.op);
            assert_eq!(id.spec().op, ep.op);
            assert_eq!(id.spec(), ep);
            assert!(seen.insert(id), "duplicate NativeEndpointId for {}", ep.op);
        }

        for &id in NativeEndpointId::ALL {
            assert_eq!(NativeEndpointId::from_op(id.op()), Some(id));
            assert_eq!(id.spec().op, id.op());
        }

        assert_eq!(NativeEndpointId::from_op(""), None);
        assert_eq!(NativeEndpointId::from_op("unknown.op"), None);
    }
}

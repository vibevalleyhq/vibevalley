//! Layer 1 conversation export wrappers that drop live inbox/verdict docs
//! and scrub pending governance state when slicing a conversation at `at_seq`.

use std::path::Path;

use crate::core::doc::{DocSpec, GovernanceDoc, GovernanceState, InboxDoc};
use crate::durable::{Document, ExportManifest, ExportOptions, Result, Store};

const VERDICT_DOC_KIND: &str = "pi.verdict";

fn sanitize_core_doc(mut doc: Document, sliced: bool) -> Result<Option<Document>> {
    if !sliced {
        return Ok(Some(doc));
    }
    if doc.doc_kind == InboxDoc::KIND || doc.doc_kind == VERDICT_DOC_KIND {
        return Ok(None);
    }
    if doc.doc_kind == GovernanceDoc::KIND {
        let mut gov: GovernanceState = serde_json::from_value(doc.state).unwrap_or_default();
        gov.pending_permissions.clear();
        gov.last_rubric_verdict = None;
        doc.state = serde_json::to_value(gov)?;
    }
    Ok(Some(doc))
}

impl Store {
    pub async fn export_conversation_to(&self, conv_id: &str, dest: &Store, opts: ExportOptions) -> Result<ExportManifest> {
        self.export_conversation_filtered(conv_id, dest, opts, sanitize_core_doc).await
    }

    pub async fn export_conversation_jsonl(&self, conv_id: &str, dest_dir: &Path, opts: ExportOptions) -> Result<ExportManifest> {
        self.export_conversation_jsonl_filtered(conv_id, dest_dir, opts, sanitize_core_doc).await
    }
}

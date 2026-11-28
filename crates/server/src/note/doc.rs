//! Structured Block Doc view projection and block-append endpoints (#38, #39).

use vibevalley_core::note::doc::{DocDocument, append_block, parse_doc_document, project_doc_view, serialize_doc_document};
use vibevalley_protocol::{ApiError, DocView, NoteDocAppendBlockRequest, NoteFileEncoding, NoteFileWriteItem, NoteFileWriteRequest, NoteType};

use super::{Maker, Manager, NOTE_USER_ORIGIN, note_type_of, refused};

impl Manager {
    /// Projects `structure/doc.json` of a note into [`DocView`].
    pub async fn doc_view_async(&self, id: &str) -> Result<DocView, ApiError> {
        self.flush_pending_writes_async(id).await;
        let row = self.row_async(id).await?;
        let ty = note_type_of(&row.note_type)?;
        if ty != NoteType::Doc {
            return Err(refused(format!("note `{}` is `{}`, expected `doc`", row.id, ty.as_str())));
        }
        let raw_files = self.storage.note.read_all_raw_async(&row.id, None).await?;
        Ok(project_doc_view(&row.id, &row.title, &raw_files))
    }

    /// Appends or inserts a [`DocBlock`] into `structure/doc.json` through the collaborative write path.
    pub async fn doc_append_block_async(&self, maker: &Maker, req: &NoteDocAppendBlockRequest) -> Result<DocView, ApiError> {
        self.flush_pending_writes_async(&req.id).await;
        let row = self.row_async(&req.id).await?;
        let ty = note_type_of(&row.note_type)?;
        if ty != NoteType::Doc {
            return Err(refused(format!("note `{}` is `{}`, expected `doc`", row.id, ty.as_str())));
        }

        let raw_files = self.storage.note.read_all_raw_async(&row.id, None).await?;
        let mut doc = if let Some(bytes) = raw_files.get("structure/doc.json")
            && let Ok(text) = std::str::from_utf8(bytes)
        {
            parse_doc_document(text).map_err(refused)?
        } else {
            DocDocument::default()
        };

        append_block(&mut doc, req.block.clone(), req.after_block_id.as_deref());
        let encoded = serialize_doc_document(&doc).map_err(refused)?;
        let meta = super::collab::commit_meta_for_maker(maker, Some("Append block".to_owned()), self.ctx.now());
        self.write_files_with_meta_async(
            maker,
            &NoteFileWriteRequest {
                id: row.id.clone(),
                files: vec![NoteFileWriteItem {
                    path: "structure/doc.json".to_owned(),
                    content: encoded,
                    encoding: Some(NoteFileEncoding::Utf8),
                    mime: Some("application/json".to_owned()),
                    expected_hash: None,
                }],
                origin: req.origin.clone().or_else(|| Some(NOTE_USER_ORIGIN.to_owned())),
                summary: Some("Append doc block".to_owned()),
                announce: Some(false),
            },
            &meta,
        )
        .await?;

        self.doc_view_async(&row.id).await
    }
}

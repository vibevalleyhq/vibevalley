pub mod artifact;
pub mod attachment;
pub mod library;
pub mod media;

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::path::Path;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::time::Duration;

    use sea_orm::{ActiveModelTrait, ActiveValue::Set};
    use serde_json::json;
    use vibevalley_core::ManualClock;
    use vibevalley_protocol::{
        Actor, ApiError, ArtifactBody, ArtifactCard, ArtifactDisplay, ArtifactEntryBatchRequest, ArtifactEntryGetRequest, ArtifactEntryKind,
        ArtifactEntryListRequest, ArtifactEntryOp, ArtifactEntryWriteInput, ArtifactHistoryCompactRequest, ArtifactHistoryForkRequest,
        ArtifactHistoryListRequest, ArtifactHistoryPreviewRequest, ArtifactHistoryRestoreRequest, ArtifactKind, ArtifactListRequest, ArtifactRequest,
        ArtifactType, ArtifactUpdateRequest, ArtifactVersionRequest, BizCode, BlockCreate, BlockOp, BlockOpStatus, BlockOpUpdateText, BlockRef, BlockUpdate,
        ChatMessage, LibraryAddRequest, LibraryFileKind, LibraryListRequest, LibraryOriginKind, LibrarySort, MediaImageFormat, MediaImageRequest,
        MediaInputKind, MediaInputPhase, MediaInputRequest, MediaJob, MediaSource, MessageKind, SuggestionChange, SuggestionCreate, SuggestionStatus, USER_ID,
    };

    use super::artifact::{Artifacts, BlockQuoter, Maker, spans_of};
    use super::attachment::Attachments;
    use super::library::{AddedBy, Library};
    use super::media::inputs::Inputs;
    use super::media::jobs::{Jobs, Parts};
    use crate::Hub;
    use crate::app::hub::ports::{ChannelAnnouncePort, ChannelQuotePort};
    use crate::db::ServerDb;
    use crate::db::entities::collab_channel::{channel, channel_message, channel_participant};
    use crate::db::entities::content_artifact::{artifact, artifact_change};
    use crate::db::error::{is_fk_violation, is_unique_violation};
    use crate::db::test_pg::EphemeralPostgres;
    use crate::infra::setting::{Setting, SettingConfig};

    struct TestAnnounce {
        db: Arc<ServerDb>,
        seq: AtomicI64,
    }

    impl TestAnnounce {
        fn new(db: Arc<ServerDb>) -> Arc<Self> {
            vibevalley_runtime::rt::block_on(async {
                let w = db.write_conn();
                channel_participant::ActiveModel {
                    id: Set(USER_ID.into()),
                    kind: Set("user".into()),
                    name: Set("User".into()),
                    agent_id: Set(None),
                    home_id: Set(None),
                    joined_at: Set(100),
                    left_at: Set(None),
                }
                .insert(w)
                .await
                .unwrap();
                channel::ActiveModel {
                    id: Set("general".into()),
                    channel_type: Set("channel".into()),
                    is_default: Set(true),
                    root_id: Set(None),
                    root_number: Set(None),
                    subject_kind: Set(None),
                    subject_id: Set(None),
                    last_number: Set(Some(0)),
                    reply_count: Set(0),
                    created_at: Set(100),
                    name: Set(Some("general".into())),
                    description: Set(None),
                    repo: Set(None),
                    parent_id: Set(None),
                    peer_id: Set(None),
                    revision: Set(1),
                    category: Set(None),
                    position: Set(None),
                    archived_at: Set(None),
                    notify: Set("all".into()),
                }
                .insert(w)
                .await
                .unwrap();
            });
            Arc::new(Self { db, seq: AtomicI64::new(1) })
        }
    }

    impl ChannelAnnouncePort for TestAnnounce {
        fn default_channel(&self) -> String {
            "general".into()
        }
        fn place_exists(&self, id: &str) -> bool {
            id == "general"
        }
        fn orchestrator_in(&self, _channel: &str) -> String {
            "orch".into()
        }
        fn place_of_async<'a>(&'a self, _who: &'a str, target: &'a str) -> crate::BoxFuture<'a, Result<String, ApiError>> {
            let trimmed = target.trim();
            let out = if trimmed.is_empty() { "general".to_owned() } else { trimmed.to_owned() };
            Box::pin(async move { Ok(out) })
        }
        fn post_card_async<'a>(
            &'a self,
            _from: &'a str,
            ch: &'a str,
            text: &'a str,
            card: ArtifactCard,
            _run: Option<String>,
            _send_key: String,
        ) -> crate::BoxFuture<'a, Result<ChatMessage, ApiError>> {
            Box::pin(async move {
                let num = self.seq.fetch_add(1, Ordering::SeqCst);
                let msg_id = format!("msg-{num}");
                channel_message::ActiveModel {
                    id: Set(msg_id.clone()),
                    channel_id: Set(ch.to_owned()),
                    number: Set(num),
                    sender_id: Set(USER_ID.into()),
                    kind: Set("chat".into()),
                    body: Set(text.to_owned()),
                    meta: Set(None),
                    system_code: Set(None),
                    send_key: Set(None),
                    created_at: Set(1000 + num),
                    revision: Set(num),
                    reply_number: Set(None),
                    edited_at: Set(None),
                    deleted_at: Set(None),
                    pinned_at: Set(None),
                    reactions: Set(None),
                }
                .insert(self.db.write_conn())
                .await
                .unwrap();
                Ok(ChatMessage {
                    id: msg_id,
                    number: num,
                    channel: ch.to_owned(),
                    from: USER_ID.into(),
                    actor: Actor::User {
                        id: USER_ID.into(),
                        name: Some("User".into()),
                    },
                    name: "User".into(),
                    agent: None,
                    kind: MessageKind::Chat,
                    text: text.to_owned(),
                    mentions: vec![],
                    session: None,
                    run: None,
                    outcome: None,
                    spent: None,
                    spoken: false,
                    send_key: None,
                    at: 1000 + num,
                    revision: num,
                    reply_to: None,
                    edited: None,
                    deleted: None,
                    pinned: None,
                    reactions: vec![],
                    attachments: vec![],
                    embeds: vec![],
                    artifact: Some(card),
                    blocks: None,
                    view_context: None,
                })
            })
        }
        fn post_attachments_async<'a>(
            &'a self,
            _from: &'a str,
            _ch: &'a str,
            _text: &'a str,
            _attachments: Vec<String>,
            _send_key: String,
        ) -> crate::BoxFuture<'a, Result<ChatMessage, ApiError>> {
            unimplemented!()
        }
        fn issue_thread_async<'a>(
            &'a self,
            _issue_id: &'a str,
            _title: &'a str,
            _preferred_channel: Option<&'a str>,
        ) -> crate::BoxFuture<'a, Result<String, ApiError>> {
            unimplemented!()
        }
        fn issue_thread_id(&self, _issue_id: &str) -> Option<String> {
            None
        }
        fn say_in_async<'a>(&'a self, _channel: &'a str, _text: &'a str, _send_key: String) -> crate::BoxFuture<'a, Result<ChatMessage, ApiError>> {
            unimplemented!()
        }
        fn history_async<'a>(&'a self, _channel: &'a str, _limit: i64) -> crate::BoxFuture<'a, Result<Vec<ChatMessage>, ApiError>> {
            Box::pin(async { Ok(vec![]) })
        }
        fn message_locations<'a>(&'a self, ids: &'a [String]) -> crate::app::hub::ports::MessageLocationsFuture<'a> {
            Box::pin(async move {
                use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
                if ids.is_empty() {
                    return std::collections::HashMap::new();
                }
                let rows: Vec<(String, String, i64)> = channel_message::Entity::find()
                    .select_only()
                    .column(channel_message::Column::Id)
                    .column(channel_message::Column::ChannelId)
                    .column(channel_message::Column::Number)
                    .filter(channel_message::Column::Id.is_in(ids.to_vec()))
                    .into_tuple()
                    .all(self.db.read_conn())
                    .await
                    .unwrap_or_default();
                rows.into_iter().map(|(id, ch, num)| (id, (ch, num))).collect()
            })
        }
    }

    async fn verify_content_on(home: &Path, db: Arc<ServerDb>) {
        // 1. Attachments
        let files = Attachments::open(home, db.clone());
        let att_png = files
            .keep_async(b"\x89PNG\r\n\x1a\ncontent-bytes".to_vec(), "100%_chart.png".into(), "image/png".into())
            .await
            .unwrap();
        let att_dup = files
            .keep_async(b"\x89PNG\r\n\x1a\ncontent-bytes".to_vec(), "dup.png".into(), "image/png".into())
            .await
            .unwrap();
        assert_eq!(att_png.id, att_dup.id);
        let att_txt = files
            .keep_async(b"plain text note".to_vec(), "notes.txt".into(), "text/plain".into())
            .await
            .unwrap();
        assert_eq!(
            files
                .of_async(&[att_png.id.clone(), att_txt.id.clone(), att_png.id.clone()])
                .await
                .unwrap()
                .len(),
            2
        );
        let f_info = files.file_async(&att_png.id).await.unwrap();
        assert_eq!(f_info.name, "100%_chart.png");

        // 2. Library (add, filter including LIKE escaping & 'other', sort, soft vs hard remove)
        let library = Library::open(db.clone(), files.clone());
        let lib_png = library
            .add_async(
                &LibraryAddRequest {
                    attachment: Some(att_png.id.clone()),
                    url: None,
                    path: None,
                    name: None,
                },
                &AddedBy::User,
            )
            .await
            .unwrap();
        assert_eq!(lib_png.attachment.id, att_png.id);
        library
            .add_async(
                &LibraryAddRequest {
                    attachment: Some(att_txt.id.clone()),
                    url: None,
                    path: None,
                    name: None,
                },
                &AddedBy::User,
            )
            .await
            .unwrap();
        let like_escaped = library
            .list_async(&LibraryListRequest {
                origin: Some(LibraryOriginKind::Uploaded),
                r#type: Some(LibraryFileKind::Image),
                text: Some("100%_".into()),
                sort: Some(LibrarySort::Name),
            })
            .await
            .unwrap();
        assert_eq!(like_escaped.len(), 1);
        assert_eq!(like_escaped[0].attachment.id, att_png.id);
        let others = library
            .list_async(&LibraryListRequest {
                origin: None,
                r#type: Some(LibraryFileKind::Other),
                text: None,
                sort: Some(LibrarySort::Size),
            })
            .await
            .unwrap();
        assert_eq!(others.len(), 1);
        assert_eq!(others[0].attachment.id, att_txt.id);

        let gen_att = files.keep_async(b"generated-art".to_vec(), "gen.png".into(), "image/png".into()).await.unwrap();
        let job: MediaJob = serde_json::from_value(json!({
            "kind":"image","id":"job-lib-1","prompt":"p","model":"m","connection":"c","revision":1,
            "source":{"kind":"user"},"phase":"ready","phaseText":"","problem":"","canCancel":false,
            "canRetryDownload":false,"createdAt":10,"updatedAt":20,"attachment":gen_att
        }))
        .unwrap();
        library.record_made_async(std::slice::from_ref(&job)).await.unwrap();
        library.record_made_async(std::slice::from_ref(&job)).await.unwrap();
        assert_eq!(
            library
                .list_async(&LibraryListRequest {
                    origin: Some(LibraryOriginKind::Generated),
                    ..Default::default()
                })
                .await
                .unwrap()
                .len(),
            1
        );
        library.remove_async(&gen_att.id).await.unwrap();
        library.record_made_async(&[job]).await.unwrap();
        assert!(
            library
                .list_async(&LibraryListRequest {
                    origin: Some(LibraryOriginKind::Generated),
                    ..Default::default()
                })
                .await
                .unwrap()
                .is_empty()
        );
        library.remove_async(&att_txt.id).await.unwrap();
        library.close_async().await;

        // 3. Media Inputs + Jobs
        let clock = Arc::new(ManualClock::new(1_700_000_000_000));
        let inputs = Inputs::open_with_clock(home, db.clone(), files.clone(), clock.clone()).unwrap();
        let req = MediaInputRequest {
            kind: MediaInputKind::Image,
            mime: "image/png".into(),
            name: "sample.png".into(),
            size: 24,
        };
        let reserved = inputs.create_async(&req).await.unwrap();
        let mut png_bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        png_bytes.resize(24, 0);
        let ready = inputs.upload_async(&reserved.id, Box::new(Cursor::new(png_bytes))).await.unwrap();
        assert_eq!(ready.phase, MediaInputPhase::Ready);
        inputs.pin_async(std::slice::from_ref(&ready.id), "job-pin-1").await.unwrap();
        assert!(!inputs.get_async(&ready.id).await.unwrap().can_delete);
        clock.advance(Duration::from_millis(86_400_000));
        inputs.sweep_async().await.unwrap();
        assert!(inputs.content_async(&ready.id).await.is_ok());
        inputs.release_async("job-pin-1").await.unwrap();
        inputs.sweep_async().await.unwrap();
        assert!(inputs.list_async().await.unwrap().is_empty());

        let hub = Hub::new(vibevalley_core::empty_space_state());
        let setting = Setting::open(SettingConfig {
            home: home.to_path_buf(),
            work_root: home.to_path_buf(),
            version: "0.1.0-test".into(),
            deepseek_api_key: String::new(),
        });
        let announce = TestAnnounce::new(db.clone());
        let (vendor, download) = crate::app::fakes::moss::network();
        let jobs = Jobs::open_with_clock(
            Parts {
                db: db.clone(),
                hub: Arc::downgrade(&hub),
                setting,
                files: files.clone(),
                inputs: inputs.clone(),
                channel: announce.clone(),
                vendor,
                download,
            },
            clock.clone(),
        )
        .unwrap();
        let bad_img = jobs
            .image_async(
                MediaImageRequest {
                    id: "bad-id".into(),
                    prompt: "a tree".into(),
                    format: MediaImageFormat::Text,
                    width: 512,
                    height: 512,
                    seed: None,
                    steps: None,
                    guidance: None,
                    negative_prompt: None,
                    enhance: false,
                    watermark: false,
                },
                MediaSource::User {},
            )
            .await;
        // Offline without bound provider returns ProviderRefused (verifies known_async read path succeeds).
        assert_eq!(bad_img.unwrap_err().biz_code, BizCode::ProviderRefused);
        jobs.close();
        inputs.close();

        // 4. Artifacts (blocks + html + store + collab/history + constraints)
        let artifacts = Artifacts::open(db.clone(), files.clone(), announce.clone());
        let quoter = BlockQuoter::new(db.clone());
        let maker = Maker::user();

        // 4a. Blocks artifact + quote + suggestions + replay + history
        let doc = artifacts
            .create_async(
                &maker,
                &ArtifactRequest {
                    title: "Spec".into(),
                    kind: Some(ArtifactKind::Markdown),
                    artifact_type: Some(ArtifactType::Docs),
                    display: None,
                    content: Some("# Heading\n\nInitial paragraph\n".into()),
                    entries: None,
                    is_default: None,
                    announce: None,
                    note: Some("v0".into()),
                    channel: Some("general".into()),
                    issue: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(doc.body, ArtifactBody::Blocks);
        assert!(doc.said.is_some());
        let blocks = artifacts.live_blocks_async(&doc.id).await.unwrap();
        assert_eq!(blocks.len(), 2);
        let para_id = blocks[1].id.clone();

        let quoted = quoter.quote(&[BlockRef {
            artifact_id: doc.id.clone(),
            block_id: para_id.clone(),
            rev: 1,
        }]);
        assert_eq!(quoted.len(), 1);
        assert_eq!(quoted[0].text.as_deref(), Some("Initial paragraph"));

        let inserted = artifacts
            .insert_block_async(
                &doc.id,
                USER_ID,
                &BlockCreate {
                    r#type: Some("paragraph".into()),
                    level: None,
                    checked: None,
                    language: None,
                    text: "Added block".into(),
                    after_block: Some(para_id.clone()),
                    parent_id: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(inserted.status, BlockOpStatus::Applied);

        let ack1 = artifacts
            .submit_async(
                &doc.id,
                USER_ID,
                "batch-idem-1",
                vec![BlockOp::UpdateText(BlockOpUpdateText {
                    block_id: para_id.clone(),
                    base_rev: 1,
                    text: spans_of(blocks[1].r#type, "Updated paragraph"),
                })],
            )
            .await
            .unwrap();
        let ack2 = artifacts
            .submit_async(
                &doc.id,
                USER_ID,
                "batch-idem-1",
                vec![BlockOp::UpdateText(BlockOpUpdateText {
                    block_id: para_id.clone(),
                    base_rev: 1,
                    text: spans_of(blocks[1].r#type, "Updated paragraph"),
                })],
            )
            .await
            .unwrap();
        assert_eq!(ack1.seq, ack2.seq);

        // Unique violation check on duplicate batch_id in artifact_change
        let dup_batch = artifact_change::ActiveModel {
            artifact_id: Set(doc.id.clone()),
            seq: Set(999),
            kind: Set("blocks".into()),
            batch_id: Set(Some("batch-idem-1".into())),
            actor: Set(USER_ID.into()),
            targets: Set("[]".into()),
            payload: Set("[]".into()),
            created_at: Set(100),
        }
        .insert(db.write_conn())
        .await
        .unwrap_err();
        assert!(is_unique_violation(&dup_batch), "expected unique violation: {dup_batch:?}");

        // FK violation check on artifact.issue -> issue.id
        let bad_fk = artifact::ActiveModel {
            id: Set("bad-fk-art".into()),
            title: Set("Bad".into()),
            body: Set("blocks".into()),
            artifact_type: Set(None),
            is_default: Set(false),
            display: Set(None),
            channel_id: Set(None),
            message_id: Set(None),
            issue: Set(Some("missing-issue".into())),
            by_id: Set(USER_ID.into()),
            by_name: Set("User".into()),
            version: Set(0),
            seq: Set(0),
            created_at: Set(100),
            updated_at: Set(100),
        }
        .insert(db.write_conn())
        .await
        .unwrap_err();
        assert!(is_fk_violation(&bad_fk), "expected fk violation: {bad_fk:?}");

        let sug = artifacts
            .suggest_async(
                &doc.id,
                "reviewer",
                &SuggestionCreate {
                    block: para_id.clone(),
                    base_rev: 2,
                    change: SuggestionChange {
                        text: Some(spans_of(blocks[1].r#type, "Suggested paragraph")),
                        r#type: None,
                        attrs: None,
                        unset: None,
                        delete: None,
                    },
                },
            )
            .await
            .unwrap();
        assert_eq!(sug.status, SuggestionStatus::Open);
        let accepted = artifacts.accept_suggestion_async(&doc.id, &sug.id, USER_ID).await.unwrap();
        assert_eq!(accepted.status, SuggestionStatus::Accepted);

        let rej = artifacts
            .suggest_async(
                &doc.id,
                "reviewer",
                &SuggestionCreate {
                    block: inserted.block_id.clone(),
                    base_rev: 1,
                    change: SuggestionChange {
                        text: Some(spans_of(blocks[1].r#type, "Nope")),
                        r#type: None,
                        attrs: None,
                        unset: None,
                        delete: None,
                    },
                },
            )
            .await
            .unwrap();
        assert_eq!(
            artifacts.reject_suggestion_async(&doc.id, &rej.id, USER_ID).await.unwrap().status,
            SuggestionStatus::Rejected
        );

        let updated_blk = artifacts
            .update_block_async(
                &doc.id,
                USER_ID,
                &BlockUpdate {
                    block: para_id.clone(),
                    base_rev: 3,
                    text: Some("Final paragraph".into()),
                    r#type: None,
                    level: None,
                    checked: None,
                    language: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(updated_blk.status, BlockOpStatus::Applied);

        let hist = artifacts
            .history_list_async(&ArtifactHistoryListRequest {
                id: doc.id.clone(),
                limit: Some(10),
            })
            .await
            .unwrap();
        assert!(hist.len() >= 2);
        let prev_frontiers = hist.last().unwrap().frontiers.clone();
        let preview = artifacts
            .history_preview_async(&ArtifactHistoryPreviewRequest {
                id: doc.id.clone(),
                frontiers: prev_frontiers.clone(),
            })
            .await
            .unwrap();
        assert!(preview.markdown.is_some());
        let forked = artifacts
            .history_fork_async(&ArtifactHistoryForkRequest {
                id: doc.id.clone(),
                frontiers: prev_frontiers.clone(),
                title: Some("Forked Spec".into()),
                channel: None,
            })
            .await
            .unwrap();
        assert_eq!(forked.title, "Forked Spec");
        artifacts
            .history_restore_async(&ArtifactHistoryRestoreRequest {
                id: doc.id.clone(),
                frontiers: prev_frontiers,
                note: Some("restore".into()),
            })
            .await
            .unwrap();
        artifacts
            .history_compact_async(&ArtifactHistoryCompactRequest { id: doc.id.clone() })
            .await
            .unwrap();

        // 4b. HTML artifact + version + update
        let page = artifacts
            .create_async(
                &maker,
                &ArtifactRequest {
                    title: "Demo".into(),
                    kind: Some(ArtifactKind::Html),
                    artifact_type: None,
                    display: Some(ArtifactDisplay::Page),
                    content: Some("<html><body><h1>Hello</h1></body></html>".into()),
                    entries: None,
                    is_default: None,
                    announce: None,
                    note: None,
                    channel: Some("general".into()),
                    issue: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(page.version, 1);
        let page_v2 = artifacts
            .version_async(
                &maker,
                &ArtifactVersionRequest {
                    id: page.id.clone(),
                    content: "<html><body><h1>Hello v2</h1></body></html>".into(),
                    note: Some("v2".into()),
                },
            )
            .await
            .unwrap();
        assert_eq!(page_v2.version, 2);
        assert_eq!(page_v2.versions.len(), 2);
        let page_upd = artifacts
            .update_async(&ArtifactUpdateRequest {
                id: page.id.clone(),
                title: Some("Demo Renamed".into()),
                display: Some(ArtifactDisplay::Slides),
                is_default: None,
            })
            .await
            .unwrap();
        assert_eq!(page_upd.title, "Demo Renamed");
        assert_eq!(page_upd.display, Some(ArtifactDisplay::Slides));

        // 4c. Store artifact + default design-system + entries CRUD + optimistic concurrency
        let ds1 = artifacts
            .create_async(
                &maker,
                &ArtifactRequest {
                    title: "Brand A".into(),
                    kind: Some(ArtifactKind::Store),
                    artifact_type: Some(ArtifactType::DesignSystem),
                    display: None,
                    content: None,
                    entries: None,
                    is_default: Some(true),
                    announce: Some(false),
                    note: None,
                    channel: None,
                    issue: None,
                },
            )
            .await
            .unwrap();
        assert!(ds1.is_default);
        let ds2 = artifacts
            .create_async(
                &maker,
                &ArtifactRequest {
                    title: "Brand B".into(),
                    kind: Some(ArtifactKind::Store),
                    artifact_type: Some(ArtifactType::DesignSystem),
                    display: None,
                    content: None,
                    entries: None,
                    is_default: Some(true),
                    announce: Some(false),
                    note: None,
                    channel: None,
                    issue: None,
                },
            )
            .await
            .unwrap();
        assert!(ds2.is_default);
        assert!(!artifacts.get_async(&ds1.id).await.unwrap().is_default);
        let types = artifacts.list_types_async().await.unwrap();
        let ds_info = types.into_iter().find(|t| t.r#type == ArtifactType::DesignSystem).unwrap();
        assert_eq!(ds_info.default_artifact_id.as_deref(), Some(ds2.id.as_str()));

        let batch_ok = artifacts
            .batch_entries_async(
                &maker,
                &ArtifactEntryBatchRequest {
                    id: ds2.id.clone(),
                    writes: vec![
                        ArtifactEntryWriteInput {
                            op: ArtifactEntryOp::Set,
                            path: "project/notes/a.txt".into(),
                            kind: Some(ArtifactEntryKind::Text),
                            value: Some("hello".into()),
                            from: None,
                            mime: None,
                            if_rev: None,
                        },
                        ArtifactEntryWriteInput {
                            op: ArtifactEntryOp::Copy,
                            path: "project/notes/b.txt".into(),
                            kind: None,
                            value: None,
                            from: Some("project/notes/a.txt".into()),
                            mime: None,
                            if_rev: None,
                        },
                    ],
                    note: None,
                    announce: Some(false),
                },
            )
            .await
            .unwrap();
        assert!(batch_ok.applied);
        let conflict = artifacts
            .batch_entries_async(
                &maker,
                &ArtifactEntryBatchRequest {
                    id: ds2.id.clone(),
                    writes: vec![ArtifactEntryWriteInput {
                        op: ArtifactEntryOp::Set,
                        path: "project/notes/a.txt".into(),
                        kind: Some(ArtifactEntryKind::Text),
                        value: Some("stale".into()),
                        from: None,
                        mime: None,
                        if_rev: Some(99),
                    }],
                    note: None,
                    announce: Some(false),
                },
            )
            .await
            .unwrap();
        assert!(!conflict.applied);
        assert_eq!(conflict.conflicts.len(), 1);
        let prefixed = artifacts
            .list_entries_async(&ArtifactEntryListRequest {
                id: ds2.id.clone(),
                prefix: Some("project/notes/".into()),
                include_values: Some(true),
            })
            .await
            .unwrap();
        assert_eq!(prefixed.entries.len(), 2);
        let got_b = artifacts
            .get_entry_async(&ArtifactEntryGetRequest {
                id: ds2.id.clone(),
                path: "project/notes/b.txt".into(),
            })
            .await
            .unwrap();
        assert_eq!(got_b.value.as_deref(), Some("hello"));

        let listed = artifacts
            .list_async(&ArtifactListRequest {
                channel: None,
                issue: None,
                artifact_type: None,
            })
            .await
            .unwrap();
        assert!(listed.len() >= 5);

        super::artifact::db::prune(db.write_conn(), i64::MAX).await.unwrap();
        artifacts.remove_async(&forked.id).await.unwrap();
        artifacts.close();
        hub.close_async().await;
    }

    #[test]
    fn dual_db_content_sqlite() {
        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open(dir.path()).unwrap();
        vibevalley_runtime::rt::block_on(verify_content_on(dir.path(), db.clone()));
        db.close();
    }

    #[test]
    fn dual_db_content_postgres() {
        let Some(pg) = EphemeralPostgres::start() else {
            eprintln!("skipping dual_db_content_postgres: initdb/pg_ctl not found");
            return;
        };
        pg.create_database("content_w3_test");
        let url = pg.db_url("content_w3_test");
        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open_url(&url).unwrap();
        vibevalley_runtime::rt::block_on(verify_content_on(dir.path(), db.clone()));
        db.close();
    }
}

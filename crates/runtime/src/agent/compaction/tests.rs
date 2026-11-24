use std::sync::{Arc, Mutex};

use serde_json::json;

use crate::agent::ai::ModelClient;
use crate::agent::ai::types::{ChatRequest, Completion, Delta, FinishReason, Message, Role, Usage};
use crate::agent::compaction::file_ops::{FileOps, extract_file_ops, render_file_ops};
use crate::agent::compaction::summarizer::LlmSummarizer;
use crate::agent::compaction::{Compactor, Level, estimate_str_tokens, estimate_tokens};
use crate::agent::durable::{Entry, Store};

struct MockModel {
    reply: String,
    seen: Mutex<Vec<ChatRequest>>,
}

impl MockModel {
    fn new(reply: impl Into<String>) -> Arc<Self> {
        Arc::new(Self {
            reply: reply.into(),
            seen: Mutex::new(vec![]),
        })
    }
}

impl ModelClient for MockModel {
    fn complete<'a>(&'a self, request: &'a ChatRequest, on: &'a mut (dyn FnMut(Delta) + Send)) -> crate::BoxFuture<'a, crate::agent::Result<Completion>> {
        Box::pin(async move {
            self.seen.lock().unwrap().push(request.clone());
            on(Delta::Text(self.reply.clone()));
            Ok(Completion {
                message: Message {
                    role: Role::Assistant,
                    content: Some(self.reply.clone()),
                    reasoning: None,
                    tool_calls: vec![],
                    tool_call_id: None,
                },
                finish: FinishReason::Stop,
                usage: Usage {
                    input: 100,
                    output: 30,
                    cache_read: 0,
                },
            })
        })
    }
}

#[test]
fn cjk_aware_token_estimation_accounts_for_ascii_and_cjk() {
    assert_eq!(estimate_str_tokens("abcdefgh"), 2);
    // 6 CJK chars => ceil(6 / 1.5) = 4 tokens, instead of 18/4 = 5 or 1 char = 0.
    assert_eq!(estimate_str_tokens("你好世界测试"), 4);
    let entries = vec![Entry {
        conversation_id: "c".into(),
        seq: 1,
        kind: "pi.user".into(),
        payload: json!({"text": "你好世界测试"}),
        created_at_ms: 0,
    }];
    assert!(estimate_tokens(&entries) > 16);
}

#[test]
fn extract_file_ops_tracks_reads_modifies_and_merges_prior_compactions() {
    let entries = vec![
        Entry {
            conversation_id: "c".into(),
            seq: 1,
            kind: "pi.compaction".into(),
            payload: json!({
                "summary": "## Goal\nkeep\n\n<file_ops>\nread:\n- old.rs\nmodified:\n- prev.rs\n</file_ops>",
                "fileOps": { "read": ["extra.rs"], "modified": [] }
            }),
            created_at_ms: 0,
        },
        Entry {
            conversation_id: "c".into(),
            seq: 2,
            kind: "pi.assistant".into(),
            payload: json!({
                "toolCalls": [
                    { "id": "1", "toolName": "read", "argsJson": { "path": "src/lib.rs" } },
                    { "id": "2", "toolName": "grep", "argsJson": { "path": "src/" } },
                    { "id": "3", "toolName": "find", "argsJson": { "path": "crates/" } },
                    { "id": "4", "toolName": "write", "argsJson": { "path": "src/new.rs" } },
                    { "id": "5", "toolName": "edit", "rawArguments": "{\"path\":\"src/lib.rs\"}" }
                ]
            }),
            created_at_ms: 0,
        },
    ];
    let ops = extract_file_ops(&entries);
    assert_eq!(
        ops.read.into_iter().collect::<Vec<_>>(),
        vec!["crates/", "extra.rs", "old.rs", "src/", "src/lib.rs"]
    );
    assert_eq!(ops.modified.into_iter().collect::<Vec<_>>(), vec!["prev.rs", "src/lib.rs", "src/new.rs"]);
}

#[tokio::test]
async fn llm_summarizer_formats_structured_summary_and_file_ops() {
    let model = MockModel::new("## Goal\nShip compaction\n## Decisions\nUse SQLite");
    let summarizer = LlmSummarizer {
        client: model.clone(),
        model: "deepseek-flash".into(),
    };
    let mut ops = FileOps::default();
    ops.read.insert("a.rs".into());
    ops.modified.insert("b.rs".into());
    let entries = vec![Entry {
        conversation_id: "c".into(),
        seq: 1,
        kind: "pi.user".into(),
        payload: json!({"text": "compact please"}),
        created_at_ms: 0,
    }];
    let out = crate::agent::compaction::Summarizer::summarize(&summarizer, Level::Manual, &entries, &ops)
        .await
        .unwrap();
    assert!(out.contains("## Goal"));
    assert!(out.contains("<file_ops>"));
    assert!(out.contains("- a.rs"));
    assert!(out.contains("- b.rs"));
    assert_eq!(render_file_ops(&FileOps::default()), "");
}

#[tokio::test]
async fn compactor_persists_summary_and_pi_file_ops_doc_and_checks_base_head() {
    let store = Store::memory().unwrap();
    store
        .write_async(|tx| {
            Box::pin(async move {
                tx.create_conversation_async("conv", "deepseek-flash").await?;
                tx.append_entry_async("conv", "pi.user", &json!({"text": "first"})).await?;
                tx.append_entry_async(
                    "conv",
                    "pi.assistant",
                    &json!({
                        "text": "checking",
                        "toolCalls": [
                            { "id": "t1", "toolName": "read", "argsJson": { "path": "Cargo.toml" } },
                            { "id": "t2", "toolName": "edit", "argsJson": { "path": "src/lib.rs" } }
                        ]
                    }),
                )
                .await?;
                tx.append_entry_async("conv", "pi.user", &json!({"text": "second"})).await?;
                tx.append_entry_async("conv", "pi.user", &json!({"text": "third"})).await?;
                Ok(())
            })
        })
        .await
        .unwrap();

    let model = MockModel::new("## Goal\nTest\n## Decisions\nNone\n## Progress\nDone\n## Remaining\nMore\n## User Constraints\nKeep tests");
    let mut compactor = Compactor::with_llm(store.clone(), model.clone(), "deepseek-flash");
    compactor.keep_recent = 2;
    let entry = compactor.compact("conv", Level::Manual, None).await.unwrap().unwrap();
    assert_eq!(entry.kind, "pi.compaction");
    assert!(entry.payload["summary"].as_str().unwrap().contains("<file_ops>"));

    let doc = store
        .read_async(|r| Box::pin(async move { r.document_async("conversation", "conv", "pi.file_ops").await }))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(doc.state["read"], json!(["Cargo.toml"]));
    assert_eq!(doc.state["modified"], json!(["src/lib.rs"]));

    // Overflow keeps at most 1 recent entry and merges prior file_ops across compactions.
    store
        .write_async(|tx| {
            Box::pin(async move {
                tx.append_entry_async(
                    "conv",
                    "pi.assistant",
                    &json!({"toolCalls": [{ "id": "t3", "toolName": "write", "argsJson": { "path": "src/new.rs" } }]}),
                )
                .await?;
                tx.append_entry_async("conv", "pi.user", &json!({"text": "latest"})).await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    let overflow = compactor.compact("conv", Level::Overflow, None).await.unwrap().unwrap();
    assert!(overflow.payload["summary"].as_str().unwrap().contains("Cargo.toml"));
    assert!(overflow.payload["summary"].as_str().unwrap().contains("src/new.rs"));
    let visible = store
        .read_async(|r| Box::pin(async move { r.visible_entries_async("conv").await }))
        .await
        .unwrap();
    assert_eq!(visible.len(), 2); // summary + 1 kept recent entry

    // Subsequent hard compaction via before_request preserves prior file_ops across chained compactions.
    compactor.hard_tokens = 1;
    compactor.keep_recent = 0;
    compactor.before_request("conv").await.unwrap();
    let doc2 = store
        .read_async(|r| Box::pin(async move { r.document_async("conversation", "conv", "pi.file_ops").await }))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(doc2.state["read"], json!(["Cargo.toml"]));
    assert_eq!(doc2.state["modified"], json!(["src/lib.rs", "src/new.rs"]));

    // Concurrent compaction advancing head_seq causes stale base_head to return None.
    let stale = store
        .write_async(|tx| {
            Box::pin(async move {
                tx.append_entry_async("conv", "pi.user", &json!({"text": "after"})).await?;
                let conv = tx.conversation_async("conv").await?;
                assert!(
                    tx.compact_async(
                        "conv",
                        crate::agent::durable::Compaction {
                            level: "manual",
                            base_head: conv.head_seq - 1,
                            from: conv.head_seq,
                            cut: conv.next_seq - 1,
                            summary: "stale",
                            token_count: 1,
                        },
                    )
                    .await?
                    .is_none()
                );
                Ok(())
            })
        })
        .await;
    stale.unwrap();
}

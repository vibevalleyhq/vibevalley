use std::sync::Arc;
use std::time::{Duration, Instant};

use vibevalley_core::system_clock;
use vibevalley_protocol::{SayRequest, USER_ID};

use super::service::Chat;
use super::types::{DeliveryTargetKind, Saying};
use crate::context::{Context, Http, LiveState, Outbox, PublicDownload, StateFeed, TaskGroup};
use crate::service::Service;
use crate::storage::Storage;

async fn test_context(home: &std::path::Path) -> (Arc<Context>, Arc<Storage>) {
    let service = Service::open(home).await.unwrap();
    let outbox = Arc::new(Outbox::new(service.clone()));
    let ctx = Arc::new(Context::new(
        service,
        TaskGroup::new(),
        Arc::new(LiveState::new()),
        outbox,
        Arc::new(StateFeed::new()),
        system_clock(),
        Arc::new(Http),
        Arc::new(PublicDownload),
    ));
    let storage = Storage::open_async(home, ctx.clone()).await.unwrap();
    (ctx, storage)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_paths_bypass_write_mutex_and_use_wal_read_pool() {
    let dir = tempfile::tempdir().unwrap();
    let (ctx, storage) = test_context(dir.path()).await;
    let chat = Chat::open_async(ctx.clone(), storage, false).await.unwrap();
    let gid = chat.default_channel();

    let (msg, _) = chat
        .say_async(Saying {
            channel: Some(gid.clone()),
            text: "decontended wal read check".into(),
            send_key: "decontend-1".into(),
            ..Saying::default()
        })
        .await
        .unwrap();
    chat.pin_async(&msg.id, true).await.unwrap();

    // Hold BOTH the channel write mutex (`chat.inner`) AND a write transaction simultaneously.
    let _write_mutex_guard = chat.locked().await;
    let write_tx = ctx.service.begin_tx().await.unwrap();
    let _ = ctx.service.channel.bump_revision_in_tx(&write_tx, &gid).await.unwrap();

    let started = Instant::now();
    let reader_chat = chat.clone();
    let reader_gid = gid.clone();
    let reader = tokio::spawn(async move {
        let channels = reader_chat.list_async().await.unwrap();
        assert!(!channels.is_empty());
        let history = reader_chat.history_async(&reader_gid, None, Some(20)).await.unwrap();
        assert_eq!(history.len(), 1);
        let hits = reader_chat.search_async("decontended", None).await.unwrap();
        assert_eq!(hits.len(), 1);
        let pins = reader_chat.pins_async(&reader_gid).await.unwrap();
        assert_eq!(pins.len(), 1);
        let recent = reader_chat.recent_rows_async(&reader_gid, 10).await.unwrap();
        assert_eq!(recent.len(), 1);
        let _unread = reader_chat.unread_async(USER_ID, None).await;
        let _pending = reader_chat.pending_deliveries_async(DeliveryTargetKind::Orchestrator).await.unwrap();
        assert_eq!(reader_chat.default_channel(), reader_gid);
    });

    tokio::time::timeout(Duration::from_secs(2), reader)
        .await
        .expect("channel read paths must not block on AsyncMutex<Inner> or write_pool")
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));

    ctx.service.rollback_tx(write_tx).await.unwrap();
    drop(_write_mutex_guard);
    ctx.shutdown(Duration::from_secs(2)).await;
    ctx.service.close().await;
}

#[tokio::test]
async fn async_channel_operations_and_thread_idempotency() {
    let dir = tempfile::tempdir().unwrap();
    let (ctx, storage) = test_context(dir.path()).await;
    let chat = Chat::open_async(ctx.clone(), storage, false).await.unwrap();

    let cid = chat.open_channel_async("async-room", "native async room", "").await.unwrap().id;

    chat.handle_message_send(
        SayRequest {
            id: cid.clone(),
            text: "hello async flat channel".into(),
            send_key: Some("async-send-1".into()),
            agent: None,
            repo: None,
            station: None,
            reply_to: None,
            attachments: None,
            to: None,
            view_context: None,
            command: None,
        },
        None,
        None,
    )
    .await
    .unwrap();

    let history = chat.history_async(&cid, None, Some(10)).await.unwrap();
    assert_eq!(history.len(), 1);
    let msg_id = history[0].id.clone();

    let t1 = chat.create_thread_async(&msg_id, Some("thread-key-1")).await.unwrap();
    let t2 = chat.create_thread_async(&msg_id, Some("thread-key-1")).await.unwrap();
    assert_eq!(t1, t2);

    let listed = chat.list_async().await.unwrap();
    assert!(listed.iter().any(|c| c.id == cid));

    ctx.shutdown(Duration::from_secs(2)).await;
    ctx.service.close().await;
}

#[tokio::test]
async fn channel_follow_and_reports_emit_reset_when_history_catch_up_fails() {
    let dir = tempfile::tempdir().unwrap();
    let (ctx, storage) = test_context(dir.path()).await;
    let chat = Chat::open_async(ctx.clone(), storage, false).await.unwrap();
    let cid = chat.open_channel_async("reset-room", "reset room", "").await.unwrap().id;

    // Close DB so history catch-up fails inside the spawned follow/reports tasks.
    ctx.service.close().await;

    let (follow_sink, mut follow_rx) = crate::context::Sink::with_default_capacity(tokio_util::sync::CancellationToken::new());
    chat.follow(&cid, 0, follow_sink).unwrap();
    let follow_ev: vibevalley_protocol::ChannelEvent = serde_json::from_value(
        tokio::time::timeout(Duration::from_secs(2), follow_rx.recv())
            .await
            .expect("follow must emit Reset instead of silently closing")
            .expect("expected Reset event on follow"),
    )
    .expect("valid ChannelEvent");
    assert!(matches!(follow_ev, vibevalley_protocol::ChannelEvent::Reset {}));

    let (reports_sink, mut reports_rx) = crate::context::Sink::with_default_capacity(tokio_util::sync::CancellationToken::new());
    chat.reports(None, reports_sink).unwrap();
    let reports_ev: vibevalley_protocol::ChannelEvent = serde_json::from_value(
        tokio::time::timeout(Duration::from_secs(2), reports_rx.recv())
            .await
            .expect("reports must emit Reset instead of silently closing")
            .expect("expected Reset event on reports"),
    )
    .expect("valid ChannelEvent");
    assert!(matches!(reports_ev, vibevalley_protocol::ChannelEvent::Reset {}));

    ctx.shutdown(Duration::from_secs(2)).await;
}

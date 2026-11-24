//! Integration and concurrency convergence tests for the Loro 1.18.0
//! collaborative content-plane kernel (`crates/core/src/collab/`).

use std::collections::HashSet;

use serde_json::json;
use vibevalley_core::artifact::{presence_highlight_from_payloads, presence_highlight_script};
use vibevalley_core::collab::{
    CollabDoc, CommitMeta, DEFAULT_PRESENCE_TTL_MS, HTML_TEXT_KEY, PresenceHub, PresenceKind, PresencePayload, PresenceViewport, SuggestionSpan,
    coalesce_suggestions, decode_frontiers, decode_version_vector, encode_frontiers, encode_version_vector,
};

fn sample_presence(id: &str, name: &str, updated_at: i64) -> PresencePayload {
    PresencePayload {
        id: id.into(),
        name: name.into(),
        color: "#22c55e".into(),
        kind: PresenceKind::Highlight,
        x: Some(120.0),
        y: Some(240.0),
        w: Some(320.0),
        h: Some(180.0),
        status: Some("editing".into()),
        block_id: Some("blk-1".into()),
        offset: Some(4),
        end_offset: Some(12),
        selector: Some("[data-slide='2']".into()),
        viewport: Some(PresenceViewport {
            x: 0.0,
            y: 0.0,
            w: 1280.0,
            h: 800.0,
            zoom: Some(1.0),
        }),
        updated_at,
    }
}

#[test]
fn presence_hub_syncs_incrementally_evicts_ttl_and_projects_sandbox_highlight() {
    let hub_a = PresenceHub::new(5_000);
    let hub_b = PresenceHub::new(5_000);
    assert_eq!(PresenceHub::with_default_ttl().ttl_ms(), DEFAULT_PRESENCE_TTL_MS);

    let p_user = sample_presence("user:1", "Alice", 10_000);
    let p_agent = sample_presence("session:s1", "Codex", 13_000);

    let delta_user = hub_a.upsert(p_user.clone()).unwrap();
    let delta_agent = hub_a.upsert(p_agent.clone()).unwrap();
    assert!(!delta_user.is_empty());
    assert!(!delta_agent.is_empty());

    // Incremental binary sync into peer B.
    hub_b.apply(&delta_user).unwrap();
    hub_b.apply(&delta_agent).unwrap();
    assert_eq!(hub_b.snapshot().len(), 2);
    assert_eq!(hub_b.get("user:1"), Some(p_user.clone()));
    assert_eq!(hub_b.get("session:s1"), Some(p_agent.clone()));

    // Deterministic TTL eviction: at t = 16_000, user (updated_at=10_000, age 6s > 5s)
    // is evicted while session:s1 (age 3s <= 5s) stays alive.
    let evicted = hub_b.evict_stale(16_000);
    assert_eq!(evicted, vec!["user:1".to_string()]);
    assert_eq!(hub_b.snapshot(), vec![p_agent.clone()]);

    // Explicit removal propagates as binary tombstone.
    let tombstone = hub_a.remove("session:s1");
    hub_b.apply(&tombstone).unwrap();
    assert!(hub_b.is_empty());

    // Sandbox PresenceHighlight command + CSP-safe script injection.
    let cmd = presence_highlight_from_payloads(&[p_user, p_agent]);
    assert_eq!(cmd.vibevalley, "presence-highlight");
    assert_eq!(cmd.items.len(), 2);
    assert_eq!(cmd.items[0].selector.as_deref(), Some("[data-slide='2']"));
    assert!(presence_highlight_script().contains("presence-highlight"));
    assert!(presence_highlight_script().contains("vv-presence-pulse"));
}

#[test]
fn regression_same_millisecond_upsert_update_and_remove_propagate() {
    let hub_a = PresenceHub::with_default_ttl();
    let hub_b = PresenceHub::with_default_ttl();

    for i in 0..5 {
        let mut p1 = sample_presence("rapid:1", "Alice", 20_000 + i * 2);
        p1.x = Some(10.0 + i as f64);
        let d1 = hub_a.upsert(p1.clone()).unwrap();
        hub_b.apply(&d1).unwrap();
        assert_eq!(hub_b.get("rapid:1"), Some(p1));

        let mut p2 = sample_presence("rapid:1", "Alice", 20_001 + i * 2);
        p2.x = Some(200.0 + i as f64);
        let d2 = hub_a.upsert(p2.clone()).unwrap();
        hub_b.apply(&d2).unwrap();
        assert_eq!(hub_b.get("rapid:1"), Some(p2));

        let tombstone = hub_a.remove("rapid:1");
        hub_b.apply(&tombstone).unwrap();
        assert!(hub_b.is_empty());
    }
}

#[test]
fn concurrent_two_sessions_and_human_converge_across_text_map_list_and_tree() {
    // Seed shared base document (human peer 1).
    let base = CollabDoc::with_peer_id(1).unwrap();
    base.upsert_block("root-a", None, None, "heading", "Title", None).unwrap();
    base.upsert_block("blk-1", Some("root-a"), None, "paragraph", "Hello world", None).unwrap();
    base.upsert_block("blk-2", Some("root-a"), None, "paragraph", "Second item", None).unwrap();
    base.html_update("<main><h1>Title</h1><p>Body</p></main>").unwrap();
    base.entry_patch_json(
        "elements/card-1",
        &json!({ "id": "card-1", "type": "shape", "x": 100, "y": 200, "style": { "fill": "#ffffff", "stroke": "#111111" } }),
    )
    .unwrap();
    base.list_push("slides", &json!("s1")).unwrap();
    base.commit(&CommitMeta::user("human", Some("seed".into()), 1_000)).unwrap();

    let seed = base.export_snapshot().unwrap();
    let human = CollabDoc::from_snapshot_with_peer(&seed, 10).unwrap();
    let session_a = CollabDoc::from_snapshot_with_peer(&seed, 20).unwrap();
    let session_b = CollabDoc::from_snapshot_with_peer(&seed, 30).unwrap();

    // 1. Concurrent character-level edits to the SAME LoroText ("blk-1") and HTML.
    human.text_insert("blk-1", 0, "Prefix: ").unwrap();
    human.html_update("<main><h1>Human Title</h1><p>Body</p></main>").unwrap();
    // Human updates coordinates on card-1.
    human.entry_patch_json("elements/card-1", &json!({ "x": 250 })).unwrap();
    // Human creates a child block under root-a.
    human
        .upsert_block("blk-human", Some("root-a"), Some(0), "paragraph", "Human note", None)
        .unwrap();
    human.commit(&CommitMeta::user("human", Some("human edit".into()), 2_000)).unwrap();

    // Session A edits middle of blk-1, changes style.fill on the SAME card-1, and moves blk-2 under blk-1.
    session_a.text_insert("blk-1", 5, " brave").unwrap();
    session_a
        .entry_patch_json("elements/card-1", &json!({ "style": { "fill": "#22c55e" } }))
        .unwrap();
    session_a.tree_move("blk-2", Some("blk-1"), None).unwrap();
    session_a.list_push("slides", &json!("s-a")).unwrap();
    session_a
        .commit(&CommitMeta::session("agent-a", "codex", "sess-a", 1, Some("session A".into()), 2_100))
        .unwrap();

    // Session B appends to blk-1, updates y & style.stroke on card-1, and tries a concurrent reparent (potential cycle with A!).
    session_b.text_insert("blk-1", 11, "!").unwrap();
    session_b
        .entry_patch_json("elements/card-1", &json!({ "y": 350, "style": { "stroke": "#3b82f6" } }))
        .unwrap();
    // Concurrent opposite move: Session A moved blk-2 -> blk-1 while Session B moves blk-1 -> blk-2.
    // Kleppmann's Movable Tree must converge deterministically with ZERO cycles.
    session_b.tree_move("blk-1", Some("blk-2"), None).unwrap();
    session_b.list_push("slides", &json!("s-b")).unwrap();
    session_b
        .commit(&CommitMeta::session("agent-b", "antigravity", "sess-b", 1, Some("session B".into()), 2_200))
        .unwrap();

    // Sync all 3 peers in different arrival orders to verify strong eventual consistency.
    let u_h = human.export_snapshot().unwrap();
    let u_a = session_a.export_snapshot().unwrap();
    let u_b = session_b.export_snapshot().unwrap();

    human.import_bytes(&u_a).unwrap();
    human.import_bytes(&u_b).unwrap();

    session_a.import_bytes(&u_b).unwrap();
    session_a.import_bytes(&u_h).unwrap();

    session_b.import_bytes(&u_h).unwrap();
    session_b.import_bytes(&u_a).unwrap();

    let snap_h = human.project_snapshot();
    let snap_a = session_a.project_snapshot();
    let snap_b = session_b.project_snapshot();
    assert_eq!(snap_h, snap_a);
    assert_eq!(snap_a, snap_b);

    // Verify all 3 character-level edits merged without conflict.
    assert_eq!(snap_h.texts.get("blk-1").map(String::as_str), Some("Prefix: Hello brave world!"));

    // Verify property-level merge on the SAME whiteboard element.
    let card = snap_h.entries.get("elements/card-1").expect("card-1 exists");
    assert_eq!(card["x"], json!(250));
    assert_eq!(card["y"], json!(350));
    assert_eq!(card["style"]["fill"], json!("#22c55e"));
    assert_eq!(card["style"]["stroke"], json!("#3b82f6"));

    // Verify list contains all 3 slides.
    let slides = snap_h.lists.get("slides").expect("slides list");
    assert_eq!(slides.len(), 3);
    assert!(slides.contains(&json!("s1")));
    assert!(slides.contains(&json!("s-a")));
    assert!(slides.contains(&json!("s-b")));

    // Verify LoroTree remained strictly acyclic and preserved all 4 blocks.
    let block_ids: HashSet<&str> = snap_h.blocks.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(block_ids, HashSet::from(["root-a", "blk-1", "blk-2", "blk-human"]));
    assert!(snap_h.tree.iter().all(|n| !n.order_key.is_empty()));
}

#[test]
fn persistent_cursor_survives_upstream_and_downstream_edits_and_coalesces_suggestions() {
    let doc = CollabDoc::with_peer_id(1).unwrap();
    doc.text_insert("p1", 0, "The quick brown fox jumps over the lazy dog.").unwrap();
    doc.commit(&CommitMeta::user("human", Some("draft".into()), 1_000)).unwrap();

    // Anchor "brown fox" (indices 10..19) and EOF word "dog." (40..44).
    let anchor_mid = doc.anchor_text_range("p1", 10, 19).unwrap();
    let anchor_eof = doc.anchor_text_range("p1", 40, 44).unwrap();

    // Human edits UPSTREAM (insert 14 chars at 0, delete "quick " at 18..24) AND appends AFTER EOF.
    doc.text_insert("p1", 0, "[Intro 2026] ").unwrap(); // +13 chars
    doc.text_delete("p1", 17, 6).unwrap(); // delete "quick " (-6 chars -> net +7)
    let cur_len = doc.text_get("p1").unwrap().chars().count();
    doc.text_insert("p1", cur_len, " Always!").unwrap();
    doc.commit(&CommitMeta::user("human", Some("revise intro & tail".into()), 2_000)).unwrap();

    let text = doc.text_get("p1").unwrap();
    let r_mid = doc.resolve_text_range(&anchor_mid).unwrap();
    let slice_mid: String = text.chars().skip(r_mid.start).take(r_mid.end - r_mid.start).collect();
    assert_eq!(slice_mid, "brown fox", "resolved mid range in `{text}`");

    let r_eof = doc.resolve_text_range(&anchor_eof).unwrap();
    let slice_eof: String = text.chars().skip(r_eof.start).take(r_eof.end - r_eof.start).collect();
    assert_eq!(slice_eof, "dog.", "trailing append must not stretch EOF anchor in `{text}`");

    // Apply anchored suggestion replacement ("golden wolf") cleanly after upstream drift.
    doc.apply_anchored_replacement(&anchor_mid, "golden wolf").unwrap();
    doc.commit(&CommitMeta::session("agent", "claude", "s1", 1, Some("accept suggestion".into()), 3_000))
        .unwrap();
    assert_eq!(doc.text_get("p1").unwrap(), "[Intro 2026] The golden wolf jumps over the lazy dog. Always!");

    // Verify coalescing adjacent/overlapping suggestions from the same origin, while keeping other origins distinct.
    let collapsed = coalesce_suggestions(vec![
        SuggestionSpan {
            id: "sug-1".into(),
            origin: "session:s1:turn:1".into(),
            text_key: "p1".into(),
            start: 0,
            end: 5,
            replacement: "Hello".into(),
            cursor_start: Some("c0".into()),
            cursor_end: Some("c5".into()),
        },
        SuggestionSpan {
            id: "sug-other".into(),
            origin: "session:s2:turn:1".into(),
            text_key: "p1".into(),
            start: 0,
            end: 5,
            replacement: "Other".into(),
            cursor_start: Some("o0".into()),
            cursor_end: Some("o5".into()),
        },
        SuggestionSpan {
            id: "sug-2".into(),
            origin: "session:s1:turn:1".into(),
            text_key: "p1".into(),
            start: 5,
            end: 11,
            replacement: " world".into(),
            cursor_start: Some("c5".into()),
            cursor_end: Some("c11".into()),
        },
        SuggestionSpan {
            id: "sug-disjoint".into(),
            origin: "session:s1:turn:1".into(),
            text_key: "p1".into(),
            start: 20,
            end: 25,
            replacement: "end".into(),
            cursor_start: Some("c20".into()),
            cursor_end: Some("c25".into()),
        },
    ]);
    assert_eq!(collapsed.len(), 3);
    assert_eq!(collapsed[0].start, 0);
    assert_eq!(collapsed[0].end, 11);
    assert_eq!(collapsed[0].replacement, "Hello world");
    assert_eq!(collapsed[0].cursor_start.as_deref(), Some("c0"));
    assert_eq!(collapsed[0].cursor_end.as_deref(), Some("c11"));
    assert_eq!(collapsed[1].origin, "session:s2:turn:1");
    assert_eq!(collapsed[2].start, 20);
}

#[test]
fn time_travel_checkout_fork_restore_and_shallow_snapshot_compaction() {
    let doc = CollabDoc::with_peer_id(1).unwrap();
    doc.html_update("<h1>v1</h1>").unwrap();
    let f1 = doc.commit(&CommitMeta::user("alice", Some("initial".into()), 1_000)).unwrap();

    doc.html_update("<h1>v2</h1><p>draft</p>").unwrap();
    let f2 = doc
        .commit(&CommitMeta::session("coder", "antigravity", "s1", 1, Some("add draft".into()), 2_000))
        .unwrap();

    doc.html_update("<h1>v3</h1><p>final</p>").unwrap();
    let _f3 = doc.commit(&CommitMeta::user("alice", Some("finalize".into()), 3_000)).unwrap();

    // Encode/decode Frontiers & VersionVector roundtrip.
    let f1_b64 = encode_frontiers(&f1);
    assert_eq!(decode_frontiers(&f1_b64).unwrap(), f1);
    let vv_b64 = encode_version_vector(&doc.version_vector());
    assert_eq!(decode_version_vector(&vv_b64).unwrap(), doc.version_vector());

    // History decodes all 3 CommitMeta records in order.
    let history = doc.history().unwrap();
    assert_eq!(history.len(), 3);
    assert_eq!(history[0].meta.as_ref().unwrap().origin, "user");
    assert_eq!(history[1].meta.as_ref().unwrap().origin, "session:s1:turn:1");
    assert_eq!(history[1].meta.as_ref().unwrap().agent.as_deref(), Some("antigravity"));
    assert_eq!(history[2].meta.as_ref().unwrap().summary.as_deref(), Some("finalize"));

    // Read-only checkout preview at f1 and f2 without mutating latest state.
    assert_eq!(doc.checkout_snapshot(&f1).unwrap().html.as_deref(), Some("<h1>v1</h1>"));
    assert_eq!(doc.checkout_snapshot(&f2).unwrap().html.as_deref(), Some("<h1>v2</h1><p>draft</p>"));
    assert_eq!(doc.html_get().as_deref(), Some("<h1>v3</h1><p>final</p>"));

    // Fork at f2 starts an independent branch at v2.
    let forked = doc.fork_at(&f2).unwrap();
    assert_eq!(forked.html_get().as_deref(), Some("<h1>v2</h1><p>draft</p>"));
    assert_eq!(forked.history().unwrap().len(), 2);

    // Shallow snapshot compaction preserves exact latest state.
    let full_before = doc.project_snapshot();
    let shallow_bytes = doc.compact_shallow_snapshot().unwrap();
    let compacted = CollabDoc::from_snapshot(&shallow_bytes).unwrap();
    assert!(compacted.is_shallow());
    assert_eq!(compacted.project_snapshot(), full_before);

    // Forward restore to f1 records a 4th commit and restores HTML cleanly.
    doc.restore_to(&f1, &CommitMeta::user("alice", Some("restore v1".into()), 4_000)).unwrap();
    assert_eq!(doc.html_get().as_deref(), Some("<h1>v1</h1>"));
    assert_eq!(doc.history().unwrap().len(), 4);
    assert_eq!(doc.text_get(HTML_TEXT_KEY).as_deref(), Some("<h1>v1</h1>"));
}

#[test]
fn selective_undo_origin_reverts_only_target_session_turn_across_interleaved_history() {
    let doc = CollabDoc::with_peer_id(1).unwrap();

    // Commit 1 (human): baseline text + whiteboard element + outline root.
    doc.text_insert("doc", 0, "Hello world").unwrap();
    doc.entry_patch_json("elements/n1", &json!({ "x": 10, "y": 20, "color": "gray" })).unwrap();
    doc.commit(&CommitMeta::user("human", Some("base".into()), 1_000)).unwrap();

    // Commit 2 (session:A:turn:1): inserts " brave" at pos 5 + changes color -> "red".
    doc.text_insert("doc", 5, " brave").unwrap();
    doc.entry_patch_json("elements/n1", &json!({ "color": "red" })).unwrap();
    doc.commit(&CommitMeta::session("agent-a", "codex", "A", 1, Some("turn 1a".into()), 2_000))
        .unwrap();

    // Commit 3 (human): prepends "Hi, " BEFORE session A's text (shifting offsets!) + changes x -> 100.
    doc.text_insert("doc", 0, "Hi, ").unwrap();
    doc.entry_patch_json("elements/n1", &json!({ "x": 100 })).unwrap();
    doc.commit(&CommitMeta::user("human", Some("human prefix".into()), 3_000)).unwrap();

    // Commit 4 (session:A:turn:1 second commit): appends " new" right after " brave" + sets color -> "crimson".
    // Current text: "Hi, Hello brave world" -> pos 15 is right after " brave".
    doc.text_insert("doc", 15, " new").unwrap();
    doc.entry_patch_json("elements/n1", &json!({ "color": "crimson" })).unwrap();
    doc.commit(&CommitMeta::session("agent-a", "codex", "A", 1, Some("turn 1b".into()), 4_000))
        .unwrap();

    // Commit 5 (session:B:turn:1): appends "!" at end + changes y -> 200.
    let len = doc.text_get("doc").unwrap().chars().count();
    doc.text_insert("doc", len, "!").unwrap();
    doc.entry_patch_json("elements/n1", &json!({ "y": 200 })).unwrap();
    doc.commit(&CommitMeta::session("agent-b", "antigravity", "B", 1, Some("session B".into()), 5_000))
        .unwrap();

    assert_eq!(doc.text_get("doc").as_deref(), Some("Hi, Hello brave new world!"));

    // Selectively undo ONLY `session:A:turn:1` (both Commit 2 and Commit 4).
    let reverted = doc
        .selective_undo_origin(
            "session:A:turn:1",
            &CommitMeta::undo("human", "session:A:turn:1", Some("undo A turn 1".into()), 6_000),
        )
        .unwrap();
    assert_eq!(reverted, 2);

    // Human's "Hi, " and x=100 AND session B's "!" and y=200 MUST remain intact,
    // while session A's " brave", " new", and color changes are cleanly undone back to "gray"!
    assert_eq!(doc.text_get("doc").as_deref(), Some("Hi, Hello world!"));
    let n1 = doc.entry_get_json("elements/n1").unwrap();
    assert_eq!(n1["x"], json!(100));
    assert_eq!(n1["y"], json!(200));
    assert_eq!(n1["color"], json!("gray"));

    // Calling selective_undo_origin a second time for the same origin is a safe idempotent no-op.
    let reverted_again = doc
        .selective_undo_origin(
            "session:A:turn:1",
            &CommitMeta::undo("human", "session:A:turn:1", Some("undo again".into()), 7_000),
        )
        .unwrap();
    assert_eq!(reverted_again, 0);
    assert_eq!(doc.text_get("doc").as_deref(), Some("Hi, Hello world!"));
}

#[test]
fn property_three_peers_converge_across_all_sync_permutations_without_cycles() {
    // Deterministic xorshift64 PRNG so every CI run reproduces identical random schedules.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        fn range(&mut self, bound: usize) -> usize {
            (self.next() as usize) % bound
        }
    }

    let mut rng = Rng(0x5EED_C011_AB01_1800);
    for round in 0..8u64 {
        let base = CollabDoc::with_peer_id(100 + round).unwrap();
        base.upsert_block("n0", None, None, "heading", "Start", None).unwrap();
        base.upsert_block("n1", Some("n0"), None, "paragraph", "Alpha Beta Gamma", None).unwrap();
        base.upsert_block("n2", Some("n0"), None, "paragraph", "Delta", None).unwrap();
        base.upsert_block("n3", Some("n0"), None, "paragraph", "Epsilon", None).unwrap();
        base.entry_patch_json("elements/e1", &json!({ "x": 0, "y": 0, "fill": "#000", "label": "init" }))
            .unwrap();
        base.commit(&CommitMeta::user("seed", None, 100)).unwrap();
        let seed_bytes = base.export_snapshot().unwrap();

        let peers: Vec<CollabDoc> = (0..3)
            .map(|p| CollabDoc::from_snapshot_with_peer(&seed_bytes, 1_000 + round * 10 + p as u64).unwrap())
            .collect();

        let node_ids = ["n1", "n2", "n3"];
        let fields = ["x", "y", "fill", "label"];
        for (p_idx, peer) in peers.iter().enumerate() {
            for step in 0..6usize {
                match rng.range(4) {
                    0 => {
                        let cur_len = peer.text_get("n1").map_or(0, |s| s.chars().count());
                        let pos = if cur_len == 0 { 0 } else { rng.range(cur_len + 1) };
                        let token = format!("p{p_idx}s{step} ");
                        peer.text_insert("n1", pos, &token).unwrap();
                    }
                    1 => {
                        let cur_len = peer.text_get("n1").map_or(0, |s| s.chars().count());
                        if cur_len > 2 {
                            let pos = rng.range(cur_len - 1);
                            peer.text_delete("n1", pos, 1).unwrap();
                        }
                    }
                    2 => {
                        let field = fields[rng.range(fields.len())];
                        let val = if matches!(field, "x" | "y") {
                            json!((p_idx * 100 + step) as i64)
                        } else {
                            json!(format!("v-{p_idx}-{step}"))
                        };
                        let mut obj = serde_json::Map::new();
                        obj.insert(field.into(), val);
                        peer.entry_patch_json("elements/e1", &serde_json::Value::Object(obj)).unwrap();
                    }
                    _ => {
                        let child = node_ids[rng.range(node_ids.len())];
                        let target_parent = match rng.range(4) {
                            0 => None,
                            1 => Some("n0"),
                            2 => Some("n1"),
                            _ => Some("n2"),
                        };
                        if target_parent != Some(child) {
                            // Ignore self-descendant move rejection from Kleppmann tree.
                            let _ = peer.tree_move(child, target_parent, None);
                        }
                    }
                }
                peer.commit(&CommitMeta::session(
                    format!("peer-{p_idx}"),
                    "worker",
                    format!("s-{p_idx}"),
                    step as u32 + 1,
                    None,
                    1_000 + (step as i64) * 10,
                ))
                .unwrap();
            }
        }

        let updates: Vec<Vec<u8>> = peers.iter().map(|p| p.export_snapshot().unwrap()).collect();
        let permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
        let mut expected = None;
        for (perm_idx, order) in permutations.iter().enumerate() {
            let replica = CollabDoc::from_snapshot_with_peer(&seed_bytes, 9_000 + round * 10 + perm_idx as u64).unwrap();
            for &idx in order {
                replica.import_bytes(&updates[idx]).unwrap();
            }
            let snap = replica.project_snapshot();
            // Tree must remain acyclic and preserve all 4 nodes.
            let ids: HashSet<&str> = snap.tree.iter().map(|n| n.id.as_str()).collect();
            assert_eq!(ids.len(), 4, "round {round} perm {order:?} lost or cycled a node: {ids:?}");
            if let Some(prev) = &expected {
                assert_eq!(&snap, prev, "round {round} diverged on permutation {order:?}");
            } else {
                expected = Some(snap);
            }
        }
    }
}

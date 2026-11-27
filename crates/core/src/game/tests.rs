use std::collections::BTreeMap;

use vibevalley_protocol::{
    LedgerEntry, LedgerEntryCheckPassed, LedgerEntryDailySettled, LedgerEntryDelivered, LedgerEntryHarvested, LedgerEntryPurchased, LedgerEntryReviewCompleted,
    LedgerEntryReviewed, MAX_RUNNING, ShopItemKind,
};

use super::progress::{Folded, progress_fold, progress_step};
use super::{daily_specs_for_day, daily_task_id, local_day, shop_catalog, shop_items_view, unsettled_daily_tasks, yard_decorations_for};

#[test]
fn shop_catalog_sells_only_decorations_and_issue_templates() {
    let catalog = shop_catalog();
    assert!(!catalog.is_empty());
    let mut deco_count = 0;
    let mut tmpl_count = 0;
    for item in catalog {
        assert!(item.price > 0, "shop item {} must have positive price", item.id);
        match item.kind {
            ShopItemKind::Decoration => {
                assert!(item.decoration.is_some(), "decoration {} missing placement", item.id);
                deco_count += 1;
            }
            ShopItemKind::Template => {
                assert!(item.decoration.is_none(), "template {} must not carry placement", item.id);
                tmpl_count += 1;
            }
        }
        // Guard against any productivity boost or concurrency slot creeping into IDs or specs.
        assert!(!item.id.contains("slot") && !item.id.contains("boost") && !item.id.contains("concurrency"));
    }
    assert!(deco_count >= 4);
    assert!(tmpl_count >= 4);
    assert_eq!(MAX_RUNNING, 6, "shop must never alter MAX_RUNNING concurrency limit");

    let items = shop_items_view(&["deco_stone_lantern".to_string()], None);
    let owned_lantern = items.iter().find(|i| i.id == "deco_stone_lantern").unwrap();
    assert!(owned_lantern.owned);
    assert!(owned_lantern.decoration.is_some());
    assert!(items.iter().filter(|i| i.id != "deco_stone_lantern").all(|i| !i.owned));

    let decos = yard_decorations_for(&["deco_stone_lantern".to_string(), "tmpl_regression_guard".to_string()]);
    assert_eq!(decos.len(), 1);
    assert_eq!(decos[0].asset, "p_lantern");
}

#[test]
fn purchasing_deducts_coins_and_persists_across_ledger_fold() {
    let entries = vec![
        LedgerEntry::Harvested(LedgerEntryHarvested {
            at: 1_795_700_000_000,
            session: "w1".into(),
            agent: Some("coder".into()),
            repo: "demo".into(),
            runtime: "scripted".into(),
            commits: 3,
            cny: None,
            runs: 1,
        }),
        LedgerEntry::Purchased(LedgerEntryPurchased {
            at: 1_795_700_010_000,
            item_id: "deco_stone_lantern".into(),
            item_kind: ShopItemKind::Decoration,
            price: 40,
        }),
    ];
    let folded = progress_fold(&entries);
    assert!(folded.progress.purchased.contains(&"deco_stone_lantern".to_string()));
    assert_eq!(yard_decorations_for(&folded.progress.purchased).len(), 1);
    let without_purchase = progress_fold(&entries[..1]);
    assert_eq!(folded.progress.coins, without_purchase.progress.coins - 40);
}

#[test]
fn daily_tasks_are_deterministic_per_calendar_day_and_dedupe_churn() {
    let day = "2026-11-27";
    let first = daily_specs_for_day(day);
    let second = daily_specs_for_day(day);
    assert_eq!(first.len(), 3);
    assert_eq!(
        first.iter().map(|s| s.kind).collect::<Vec<_>>(),
        second.iter().map(|s| s.kind).collect::<Vec<_>>()
    );

    // Pick a timestamp whose local_day matches its own computed day, and simulate repeated review/check spam.
    let at = 1_795_739_000_000i64;
    let actual_day = local_day(at);
    let mut folded = Folded::default();
    for _ in 0..5 {
        (folded, _) = progress_step(&folded, &LedgerEntry::Reviewed(LedgerEntryReviewed { at, session: "w1".into() }));
        (folded, _) = progress_step(&folded, &LedgerEntry::CheckPassed(LedgerEntryCheckPassed { at, key: "i1:abc".into() }));
    }
    let act = folded.seen.daily.get(&actual_day).unwrap();
    assert_eq!(act.reviews_completed.len(), 1, "repeated diff views on same session must dedupe");
    assert_eq!(act.tests_passed.len(), 1, "repeated checks on same key must dedupe");

    let mut settled_sum = 0i64;
    for task in unsettled_daily_tasks(&folded.seen.daily, &actual_day) {
        settled_sum += task.reward_coins;
        let (next, news) = progress_step(
            &folded,
            &LedgerEntry::DailySettled(LedgerEntryDailySettled {
                at,
                day: actual_day.clone(),
                task_id: task.id.clone(),
                task_kind: task.kind,
                coins: task.reward_coins,
            }),
        );
        assert_eq!(news.coins, Some(task.reward_coins));
        folded = next;
        // Replaying the same DailySettled entry must be idempotent and award 0 extra coins.
        let (dup, dup_news) = progress_step(
            &folded,
            &LedgerEntry::DailySettled(LedgerEntryDailySettled {
                at,
                day: actual_day.clone(),
                task_id: task.id,
                task_kind: task.kind,
                coins: task.reward_coins,
            }),
        );
        assert_eq!(dup.progress.coins, folded.progress.coins);
        assert_eq!(dup_news.coins, None);
    }
    assert!(settled_sum > 0);
    assert!(unsettled_daily_tasks(&folded.seen.daily, &actual_day).is_empty());

    // Advancing to the next calendar day produces a fresh unsettled task board for that day.
    let next_at = at + 24 * 3_600 * 1_000;
    let next_day = local_day(next_at);
    assert_ne!(next_day, actual_day);
    let next_board = super::daily_board_for(&folded.seen.daily, &next_day);
    assert_eq!(next_board.day, next_day);
    assert_eq!(next_board.settled_coins_today, 0);
    assert!(next_board.tasks.iter().all(|t| t.progress == 0 && !t.settled));
}

#[test]
fn daily_review_completed_and_delivered_entries_advance_tasks() {
    let at = 1_795_739_000_000i64;
    let day = local_day(at);
    let specs = daily_specs_for_day(&day);
    let mut folded = Folded::default();
    let entries = [
        LedgerEntry::CheckPassed(LedgerEntryCheckPassed { at, key: "i1:c1".into() }),
        LedgerEntry::ReviewCompleted(LedgerEntryReviewCompleted {
            at,
            key: "i1".into(),
            passed: true,
        }),
        LedgerEntry::Delivered(LedgerEntryDelivered {
            at,
            issue: "i1".into(),
            clean: true,
        }),
    ];
    for e in &entries {
        (folded, _) = progress_step(&folded, e);
    }
    let board = folded.progress.daily.as_ref().unwrap();
    assert_eq!(board.tasks.len(), 3);
    for spec in specs {
        let tid = daily_task_id(&day, spec.kind);
        let t = board.tasks.iter().find(|t| t.id == tid).unwrap();
        assert!(t.completed, "expected {:?} to be completed", spec.kind);
    }
    let empty: BTreeMap<String, super::DayActivity> = BTreeMap::new();
    assert_eq!(super::daily_board_for(&empty, &day).tasks.len(), 3);
}

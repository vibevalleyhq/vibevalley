//! Batch 1 cleanup: drops `channel_event`, `remote_config`, and `pull_event`,
//! migrates open PR dedup keys onto `pull.known_events`, moves `auto_review`,
//! `helper_mode`, and `needs_reconciliation` off `durable_document` onto first-class
//! server columns, denormalizes `note.human_touched_paths`, and adds issue lookup indexes.

use std::collections::{BTreeMap, BTreeSet};

use sea_orm::sea_query::{Condition, Expr, Index, JoinType, Query, Table};
use sea_orm_migration::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use vibevalley_kit::db::schema::batch_chunk_rows;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnownPullEventJson {
    key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bot_round_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bot_round: Option<i64>,
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        add_new_columns(manager).await?;
        backfill_pull_known_events(manager).await?;
        backfill_durable_documents(manager).await?;
        backfill_note_human_touched_paths(manager).await?;
        drop_redundant_tables(manager).await?;
        create_issue_lookup_indexes(manager).await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}

async fn add_col_if_missing(manager: &SchemaManager<'_>, table: &str, mut col: ColumnDef) -> Result<(), DbErr> {
    let col_name = col.get_column_name().to_owned();
    if manager.has_table(table).await? && !manager.has_column(table, &col_name).await? {
        manager
            .alter_table(Table::alter().table(Alias::new(table)).add_column(&mut col).to_owned())
            .await?;
    }
    Ok(())
}

async fn add_new_columns(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    add_col_if_missing(
        manager,
        "pull",
        ColumnDef::new(Alias::new("known_events")).text().not_null().default("[]").take(),
    )
    .await?;
    add_col_if_missing(
        manager,
        "session_run",
        ColumnDef::new(Alias::new("needs_reconciliation")).boolean().not_null().default(false).take(),
    )
    .await?;
    add_col_if_missing(manager, "session", ColumnDef::new(Alias::new("helper_mode")).text().null().take()).await?;
    add_col_if_missing(manager, "issue", ColumnDef::new(Alias::new("auto_review")).text().null().take()).await?;
    add_col_if_missing(
        manager,
        "note",
        ColumnDef::new(Alias::new("human_touched_paths")).text().not_null().default("[]").take(),
    )
    .await?;
    Ok(())
}

async fn backfill_pull_known_events(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    if !manager.has_table("pull").await? || !manager.has_table("pull_event").await? {
        return Ok(());
    }
    let conn = manager.get_connection();
    let pe = Alias::new("pe");
    let p = Alias::new("p");
    let select = Query::select()
        .columns([
            (pe.clone(), Alias::new("pull_id")),
            (pe.clone(), Alias::new("key")),
            (pe.clone(), Alias::new("bot_round_key")),
            (pe.clone(), Alias::new("bot_round")),
        ])
        .from_as(Alias::new("pull_event"), pe.clone())
        .join_as(
            JoinType::InnerJoin,
            Alias::new("pull"),
            p.clone(),
            Expr::col((p.clone(), Alias::new("id"))).equals((pe, Alias::new("pull_id"))),
        )
        .and_where(Expr::col((p, Alias::new("state"))).eq("open"))
        .to_owned();
    let rows = conn.query_all(&select).await?;
    let mut grouped: BTreeMap<String, Vec<KnownPullEventJson>> = BTreeMap::new();
    for row in rows {
        let pull_id: String = row.try_get_by_index(0)?;
        let key: String = row.try_get_by_index(1)?;
        let bot_round_key: Option<String> = row.try_get_by_index(2)?;
        let bot_round: Option<i64> = row.try_get_by_index(3)?;
        grouped.entry(pull_id).or_default().push(KnownPullEventJson { key, bot_round_key, bot_round });
    }
    for (pull_id, events) in grouped {
        let raw = serde_json::to_string(&events).map_err(|e| DbErr::Custom(e.to_string()))?;
        manager
            .exec_stmt(
                Query::update()
                    .table(Alias::new("pull"))
                    .value(Alias::new("known_events"), raw)
                    .and_where(Expr::col(Alias::new("id")).eq(pull_id))
                    .to_owned(),
            )
            .await?;
    }
    Ok(())
}

async fn backfill_durable_documents(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    if !manager.has_table("durable_document").await? {
        return Ok(());
    }
    let conn = manager.get_connection();

    // 1. workspace.reconciliation -> session_run.needs_reconciliation = true
    if manager.has_table("session_run").await? {
        let select_recon = Query::select()
            .column(Alias::new("scope_id"))
            .from(Alias::new("durable_document"))
            .and_where(Expr::col(Alias::new("scope_kind")).eq("run"))
            .and_where(Expr::col(Alias::new("doc_kind")).eq("workspace.reconciliation"))
            .to_owned();
        let run_ids: Vec<String> = conn
            .query_all(&select_recon)
            .await?
            .into_iter()
            .map(|r| r.try_get_by_index(0))
            .collect::<Result<_, _>>()?;
        for chunk in run_ids.chunks(batch_chunk_rows(2)) {
            manager
                .exec_stmt(
                    Query::update()
                        .table(Alias::new("session_run"))
                        .value(Alias::new("needs_reconciliation"), true)
                        .and_where(Expr::col(Alias::new("id")).is_in(chunk.iter().cloned()))
                        .to_owned(),
                )
                .await?;
        }
    }

    // 2. session helper_mode -> session.helper_mode
    if manager.has_table("session").await? {
        let select_mode = Query::select()
            .columns([Alias::new("scope_id"), Alias::new("state_json")])
            .from(Alias::new("durable_document"))
            .and_where(Expr::col(Alias::new("scope_kind")).eq("session"))
            .and_where(Expr::col(Alias::new("doc_kind")).eq("helper_mode"))
            .to_owned();
        for row in conn.query_all(&select_mode).await? {
            let sid: String = row.try_get_by_index(0)?;
            let state_json: String = row.try_get_by_index(1)?;
            let Ok(Value::String(tag)) = serde_json::from_str::<Value>(&state_json) else {
                continue;
            };
            if tag.is_empty() {
                continue;
            }
            manager
                .exec_stmt(
                    Query::update()
                        .table(Alias::new("session"))
                        .value(Alias::new("helper_mode"), tag)
                        .and_where(Expr::col(Alias::new("id")).eq(sid))
                        .to_owned(),
                )
                .await?;
        }
    }

    // 3. issue auto_review -> issue.auto_review
    if manager.has_table("issue").await? {
        let select_ar = Query::select()
            .columns([Alias::new("scope_id"), Alias::new("state_json")])
            .from(Alias::new("durable_document"))
            .and_where(Expr::col(Alias::new("scope_kind")).eq("issue"))
            .and_where(Expr::col(Alias::new("doc_kind")).eq("auto_review"))
            .to_owned();
        for row in conn.query_all(&select_ar).await? {
            let issue_id: String = row.try_get_by_index(0)?;
            let state_json: String = row.try_get_by_index(1)?;
            manager
                .exec_stmt(
                    Query::update()
                        .table(Alias::new("issue"))
                        .value(Alias::new("auto_review"), state_json)
                        .and_where(Expr::col(Alias::new("id")).eq(issue_id))
                        .to_owned(),
                )
                .await?;
        }
    }

    // Remove migrated cross-layer durable_document rows (including issue.report now owned by outbox_item).
    manager
        .exec_stmt(
            Query::delete()
                .from_table(Alias::new("durable_document"))
                .cond_where(
                    Condition::any()
                        .add(
                            Condition::all()
                                .add(Expr::col(Alias::new("scope_kind")).eq("run"))
                                .add(Expr::col(Alias::new("doc_kind")).is_in(["workspace.reconciliation", "issue.report"])),
                        )
                        .add(
                            Condition::all()
                                .add(Expr::col(Alias::new("scope_kind")).eq("session"))
                                .add(Expr::col(Alias::new("doc_kind")).eq("helper_mode")),
                        )
                        .add(
                            Condition::all()
                                .add(Expr::col(Alias::new("scope_kind")).eq("issue"))
                                .add(Expr::col(Alias::new("doc_kind")).eq("auto_review")),
                        ),
                )
                .to_owned(),
        )
        .await?;

    Ok(())
}

async fn backfill_note_human_touched_paths(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    if !manager.has_table("note").await? || !manager.has_table("note_change").await? {
        return Ok(());
    }
    let conn = manager.get_connection();
    let select = Query::select()
        .columns([Alias::new("note_id"), Alias::new("actor"), Alias::new("targets")])
        .from(Alias::new("note_change"))
        .and_where(Expr::col(Alias::new("kind")).eq("files"))
        .to_owned();
    let rows = conn.query_all(&select).await?;
    let mut touched_by_note: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for row in rows {
        let note_id: String = row.try_get_by_index(0)?;
        let actor: String = row.try_get_by_index(1)?;
        let targets_json: String = row.try_get_by_index(2)?;
        if !matches!(actor.as_str(), "user" | "user:self") {
            continue;
        }
        let Ok(paths) = serde_json::from_str::<Vec<String>>(&targets_json) else {
            continue;
        };
        let entry = touched_by_note.entry(note_id).or_default();
        for p in paths {
            if p != "manifest.json" {
                entry.insert(p);
            }
        }
    }
    for (note_id, paths) in touched_by_note {
        if paths.is_empty() {
            continue;
        }
        let list: Vec<String> = paths.into_iter().collect();
        let raw = serde_json::to_string(&list).map_err(|e| DbErr::Custom(e.to_string()))?;
        manager
            .exec_stmt(
                Query::update()
                    .table(Alias::new("note"))
                    .value(Alias::new("human_touched_paths"), raw)
                    .and_where(Expr::col(Alias::new("id")).eq(note_id))
                    .to_owned(),
            )
            .await?;
    }
    Ok(())
}

async fn drop_redundant_tables(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    for table in ["channel_event", "pull_event", "remote_config"] {
        manager.drop_table(Table::drop().table(Alias::new(table)).if_exists().to_owned()).await?;
    }
    Ok(())
}

async fn create_issue_lookup_indexes(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    if manager.has_table("pull").await? {
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("pull_by_issue")
                    .table(Alias::new("pull"))
                    .col(Alias::new("issue_id"))
                    .to_owned(),
            )
            .await?;
    }
    if manager.has_table("cron").await? {
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("cron_by_issue")
                    .table(Alias::new("cron"))
                    .col(Alias::new("issue_id"))
                    .to_owned(),
            )
            .await?;
    }
    Ok(())
}

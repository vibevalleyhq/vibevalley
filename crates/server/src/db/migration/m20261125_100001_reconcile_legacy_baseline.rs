use std::collections::BTreeSet;

use sea_orm::{DatabaseBackend, Statement};
use sea_orm_migration::{prelude::*, schema::*};

#[derive(DeriveMigrationName)]
pub struct Migration;

const VALID_ARTIFACT_TYPES: &[&str] = &[
    "docs",
    "outline",
    "slides",
    "dashboard",
    "motion",
    "whiteboard",
    "design",
    "design-system",
    "sheet",
    "prototype",
    "diagram",
    "storyboard",
];

const OBSOLETE_LEGACY_TABLES: &[&str] = &[
    "artifact_block_revision",
    "artifact_block",
    "artifact_entry_change",
    "artifact_entry",
    "issue_counter",
    "issue_delivery_evidence",
    "issue_word",
    "media_library_job",
    "pkm_change",
    "pkm_comment",
    "pkm_term",
    "session_counter",
    "session_extra",
    "session_run_subagents",
    "watch_cursor",
];

async fn table_columns(manager: &SchemaManager<'_>, table: &str) -> Result<BTreeSet<String>, DbErr> {
    let conn = manager.get_connection();
    let backend = manager.get_database_backend();
    let mut cols = BTreeSet::new();
    match backend {
        DatabaseBackend::Postgres => {
            let rows = conn
                .query_all_raw(Statement::from_sql_and_values(
                    backend,
                    "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1",
                    [table.into()],
                ))
                .await?;
            for row in rows {
                let name: String = row.try_get_by_index(0)?;
                cols.insert(name);
            }
        }
        _ => {
            let escaped = table.replace('"', "\"\"");
            let rows = conn
                .query_all_raw(Statement::from_string(backend, format!("PRAGMA table_info(\"{escaped}\")")))
                .await?;
            for row in rows {
                let name: String = row.try_get_by_index(1)?;
                cols.insert(name);
            }
        }
    }
    Ok(cols)
}

fn col_or_null(cols: &BTreeSet<String>, name: &str) -> String {
    if cols.contains(name) {
        format!("\"{name}\"")
    } else {
        format!("NULL AS \"{name}\"")
    }
}

async fn alter_additive_tables(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    let issue_cols = table_columns(manager, "issue").await?;
    if !issue_cols.is_empty() {
        if !issue_cols.contains("machine_id") {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("issue"))
                        .add_column(text_null(Alias::new("machine_id")))
                        .to_owned(),
                )
                .await?;
        }
        if !issue_cols.contains("delivery_evidence") {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("issue"))
                        .add_column(text_null(Alias::new("delivery_evidence")))
                        .to_owned(),
                )
                .await?;
        }
        if !issue_cols.contains("queued_words") {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("issue"))
                        .add_column(text(Alias::new("queued_words")).default("[]"))
                        .to_owned(),
                )
                .await?;
        }
    }

    let run_cols = table_columns(manager, "session_run").await?;
    if !run_cols.is_empty() && !run_cols.contains("subagent_summary") {
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("session_run"))
                    .add_column(text_null(Alias::new("subagent_summary")))
                    .to_owned(),
            )
            .await?;
    }

    let msg_cols = table_columns(manager, "channel_message").await?;
    if !msg_cols.is_empty() && !msg_cols.contains("system_code") {
        manager
            .drop_index(
                Index::drop()
                    .if_exists()
                    .name("channel_message_system_code")
                    .table(Alias::new("channel_message"))
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("channel_message"))
                    .add_column(text_null(Alias::new("system_code")))
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("channel_message_system_code")
                    .table(Alias::new("channel_message"))
                    .col(Alias::new("channel_id"))
                    .col(Alias::new("system_code"))
                    .to_owned(),
            )
            .await?;
    }

    let lib_cols = table_columns(manager, "media_library_item").await?;
    if !lib_cols.is_empty() && (!lib_cols.contains("source_job_id") || !lib_cols.contains("removed_at")) {
        manager
            .drop_index(
                Index::drop()
                    .if_exists()
                    .name("media_library_item_by_job")
                    .table(Alias::new("media_library_item"))
                    .to_owned(),
            )
            .await?;
        manager
            .drop_index(
                Index::drop()
                    .if_exists()
                    .name("media_library_item_recent")
                    .table(Alias::new("media_library_item"))
                    .to_owned(),
            )
            .await?;
        if !lib_cols.contains("source_job_id") {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("media_library_item"))
                        .add_column(text_null(Alias::new("source_job_id")))
                        .to_owned(),
                )
                .await?;
        }
        if !lib_cols.contains("removed_at") {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("media_library_item"))
                        .add_column(big_integer_null(Alias::new("removed_at")))
                        .to_owned(),
                )
                .await?;
        }
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("media_library_item_recent")
                    .table(Alias::new("media_library_item"))
                    .col((Alias::new("last_at"), IndexOrder::Desc))
                    .col(Alias::new("attachment_id"))
                    .and_where(Expr::col(Alias::new("removed_at")).is_null())
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("media_library_item_by_job")
                    .table(Alias::new("media_library_item"))
                    .col(Alias::new("source_job_id"))
                    .unique()
                    .and_where(Expr::col(Alias::new("source_job_id")).is_not_null())
                    .to_owned(),
            )
            .await?;
    }

    let mem_cols = table_columns(manager, "memory").await?;
    if !mem_cols.is_empty() {
        for legacy_col in ["terms", "terms_of"] {
            if mem_cols.contains(legacy_col) {
                manager
                    .alter_table(Table::alter().table(Alias::new("memory")).drop_column(Alias::new(legacy_col)).to_owned())
                    .await?;
            }
        }
    }

    Ok(())
}

struct LegacySessionRow {
    id: String,
    controller: Option<String>,
    role: Option<String>,
    name: String,
    profile: Option<String>,
    agent: Option<String>,
    runtime: String,
    brief: String,
    cwd: Option<String>,
    policy: Option<String>,
    bindings: Option<String>,
    repo: Option<String>,
    branch: Option<String>,
    worktree: Option<String>,
    hired_at: i64,
    runs: i64,
    last_run: Option<String>,
    spent: Option<String>,
    tool_connections: Option<String>,
    machine: Option<String>,
    phase: String,
    departed: bool,
    channel: Option<String>,
    issue: Option<String>,
    refining: bool,
    title: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
    agent_session: Option<String>,
    base: Option<String>,
    run: Option<String>,
}

async fn rebuild_legacy_session_table(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    let cols = table_columns(manager, "session").await?;
    if cols.is_empty() || (cols.contains("controller") && !cols.contains("agent")) {
        return Ok(());
    }

    let select_list = [
        "id",
        "controller",
        "role",
        "name",
        "profile",
        "agent",
        "runtime",
        "brief",
        "cwd",
        "policy",
        "bindings",
        "repo",
        "branch",
        "worktree",
        "hired_at",
        "runs",
        "last_run",
        "spent",
        "tool_connections",
        "machine",
        "phase",
        "departed",
        "channel",
        "issue",
        "refining",
        "title",
        "model",
        "effort",
        "permission_mode",
        "agent_session",
        "base",
        "run",
    ]
    .into_iter()
    .map(|c| col_or_null(&cols, c))
    .collect::<Vec<_>>()
    .join(", ");

    let backend = manager.get_database_backend();
    let rows = manager
        .get_connection()
        .query_all_raw(Statement::from_string(backend, format!("SELECT {select_list} FROM session")))
        .await?;

    let mut legacy_rows = Vec::with_capacity(rows.len());
    for row in rows {
        legacy_rows.push(LegacySessionRow {
            id: row.try_get_by_index(0)?,
            controller: row.try_get_by_index(1)?,
            role: row.try_get_by_index(2)?,
            name: row.try_get_by_index(3)?,
            profile: row.try_get_by_index(4)?,
            agent: row.try_get_by_index(5)?,
            runtime: row.try_get_by_index(6)?,
            brief: row.try_get_by_index(7)?,
            cwd: row.try_get_by_index(8)?,
            policy: row.try_get_by_index(9)?,
            bindings: row.try_get_by_index(10)?,
            repo: row.try_get_by_index(11)?,
            branch: row.try_get_by_index(12)?,
            worktree: row.try_get_by_index(13)?,
            hired_at: row.try_get_by_index(14)?,
            runs: row.try_get_by_index(15)?,
            last_run: row.try_get_by_index(16)?,
            spent: row.try_get_by_index(17)?,
            tool_connections: row.try_get_by_index(18)?,
            machine: row.try_get_by_index(19)?,
            phase: row.try_get_by_index(20)?,
            departed: row.try_get_by_index::<Option<bool>>(21)?.unwrap_or(false),
            channel: row.try_get_by_index(22)?,
            issue: row.try_get_by_index(23)?,
            refining: row.try_get_by_index::<Option<bool>>(24)?.unwrap_or(false),
            title: row.try_get_by_index(25)?,
            model: row.try_get_by_index(26)?,
            effort: row.try_get_by_index(27)?,
            permission_mode: row.try_get_by_index(28)?,
            agent_session: row.try_get_by_index(29)?,
            base: row.try_get_by_index(30)?,
            run: row.try_get_by_index(31)?,
        });
    }

    manager.drop_table(Table::drop().if_exists().table(Alias::new("session")).to_owned()).await?;
    super::m20261124_100001_create_server_tables::create_session_table_and_index(manager).await?;

    for row in legacy_rows {
        let controller = row
            .controller
            .unwrap_or_else(|| if row.issue.is_some() { "issueBoard".into() } else { "user".into() });
        let profile = row.profile.or(row.agent);
        let cwd = row.cwd.or_else(|| row.worktree.clone()).or_else(|| row.repo.clone());
        let policy = row.policy.unwrap_or_else(|| match &row.repo {
            Some(repo) => serde_json::json!({
                "kind": "managedWorktree",
                "repo": repo,
                "branch": row.branch,
            })
            .to_string(),
            None => serde_json::json!({ "kind": "sandboxDir" }).to_string(),
        });
        let bindings = row.bindings.unwrap_or_else(|| {
            let mut list = Vec::new();
            if let Some(issue_id) = row.issue {
                list.push(serde_json::json!({
                    "kind": "issue",
                    "id": issue_id,
                    "refining": row.refining.then_some(true),
                }));
            }
            if let Some(channel_id) = row.channel {
                list.push(serde_json::json!({
                    "kind": "channel",
                    "id": channel_id,
                }));
            }
            serde_json::Value::Array(list).to_string()
        });
        let base = row.base.or(row.branch);

        let stmt = Query::insert()
            .into_table(Alias::new("session"))
            .columns([
                Alias::new("id"),
                Alias::new("controller"),
                Alias::new("role"),
                Alias::new("name"),
                Alias::new("profile"),
                Alias::new("runtime"),
                Alias::new("brief"),
                Alias::new("cwd"),
                Alias::new("policy"),
                Alias::new("bindings"),
                Alias::new("hired_at"),
                Alias::new("runs"),
                Alias::new("last_run"),
                Alias::new("spent"),
                Alias::new("tool_connections"),
                Alias::new("machine"),
                Alias::new("phase"),
                Alias::new("departed"),
                Alias::new("title"),
                Alias::new("model"),
                Alias::new("effort"),
                Alias::new("permission_mode"),
                Alias::new("agent_session"),
                Alias::new("base"),
                Alias::new("run"),
            ])
            .values_panic([
                row.id.into(),
                controller.into(),
                row.role.into(),
                row.name.into(),
                profile.into(),
                row.runtime.into(),
                row.brief.into(),
                cwd.into(),
                policy.into(),
                bindings.into(),
                row.hired_at.into(),
                row.runs.into(),
                row.last_run.into(),
                row.spent.into(),
                row.tool_connections.into(),
                row.machine.into(),
                row.phase.into(),
                row.departed.into(),
                row.title.into(),
                row.model.into(),
                row.effort.into(),
                row.permission_mode.into(),
                row.agent_session.into(),
                base.into(),
                row.run.into(),
            ])
            .to_owned();
        manager.exec_stmt(stmt).await?;
    }

    Ok(())
}

struct LegacyArtifactRow {
    id: String,
    title: String,
    artifact_type: Option<String>,
    display: Option<String>,
    is_default: bool,
    channel_id: Option<String>,
    message_id: Option<String>,
    issue: Option<String>,
    by_id: String,
    by_name: String,
    version: i64,
    seq: i64,
    created_at: i64,
    updated_at: i64,
}

struct LegacyArtifactVersionRow {
    artifact_id: String,
    version: i64,
    storage_id: String,
    size: i64,
    note: Option<String>,
    by_id: String,
    by_name: String,
    message_id: Option<String>,
    created_at: i64,
}

struct LegacyArtifactChangeRow {
    artifact_id: String,
    seq: i64,
    kind: String,
    batch_id: Option<String>,
    actor: String,
    targets: String,
    payload: String,
    created_at: i64,
}

struct LegacyArtifactSuggestionRow {
    id: String,
    artifact_id: String,
    path: String,
    author: String,
    origin: Option<String>,
    at_rev: i64,
    base_hash: Option<String>,
    change: String,
    cursor_start: Option<String>,
    cursor_end: Option<String>,
    start_offset: Option<i64>,
    end_offset: Option<i64>,
    status: String,
    created_at: i64,
    resolved_at: Option<i64>,
    resolved_by: Option<String>,
}

struct LegacyArtifactCollabRow {
    artifact_id: String,
    snapshot: Vec<u8>,
    updated_at: i64,
}

fn normalize_artifact_type(artifact_type: Option<String>, display: Option<&str>) -> String {
    if let Some(kind) = artifact_type
        && VALID_ARTIFACT_TYPES.contains(&kind.as_str())
    {
        return kind;
    }
    match display {
        Some("slides") => "slides".to_owned(),
        Some("motion") => "motion".to_owned(),
        _ => "docs".to_owned(),
    }
}

async fn rebuild_legacy_artifact_tables(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    let artifact_cols = table_columns(manager, "artifact").await?;
    if artifact_cols.is_empty() {
        return Ok(());
    }
    let version_cols = table_columns(manager, "artifact_version").await?;
    let change_cols = table_columns(manager, "artifact_change").await?;
    let suggestion_cols = table_columns(manager, "artifact_suggestion").await?;
    let collab_cols = table_columns(manager, "artifact_collab").await?;

    let needs_rebuild = artifact_cols.contains("body")
        || artifact_cols.contains("display")
        || (!version_cols.is_empty() && !version_cols.contains("storage_id"))
        || (!change_cols.is_empty() && !change_cols.contains("kind"))
        || (!suggestion_cols.is_empty() && !suggestion_cols.contains("path"));
    if !needs_rebuild {
        return Ok(());
    }

    let backend = manager.get_database_backend();
    let conn = manager.get_connection();

    let artifact_select = [
        "id",
        "title",
        "artifact_type",
        "display",
        "is_default",
        "channel_id",
        "message_id",
        "issue",
        "by_id",
        "by_name",
        "version",
        "seq",
        "created_at",
        "updated_at",
    ]
    .into_iter()
    .map(|c| col_or_null(&artifact_cols, c))
    .collect::<Vec<_>>()
    .join(", ");
    let mut artifacts = Vec::new();
    for row in conn
        .query_all_raw(Statement::from_string(backend, format!("SELECT {artifact_select} FROM artifact")))
        .await?
    {
        artifacts.push(LegacyArtifactRow {
            id: row.try_get_by_index(0)?,
            title: row.try_get_by_index(1)?,
            artifact_type: row.try_get_by_index(2)?,
            display: row.try_get_by_index(3)?,
            is_default: row.try_get_by_index::<Option<bool>>(4)?.unwrap_or(false),
            channel_id: row.try_get_by_index(5)?,
            message_id: row.try_get_by_index(6)?,
            issue: row.try_get_by_index(7)?,
            by_id: row.try_get_by_index(8)?,
            by_name: row.try_get_by_index(9)?,
            version: row.try_get_by_index(10)?,
            seq: row.try_get_by_index::<Option<i64>>(11)?.unwrap_or(0),
            created_at: row.try_get_by_index(12)?,
            updated_at: row.try_get_by_index(13)?,
        });
    }

    let mut versions = Vec::new();
    if !version_cols.is_empty() {
        let select = [
            "artifact_id",
            "version",
            "storage_id",
            "attachment_id",
            "size",
            "note",
            "by_id",
            "by_name",
            "message_id",
            "created_at",
        ]
        .into_iter()
        .map(|c| col_or_null(&version_cols, c))
        .collect::<Vec<_>>()
        .join(", ");
        for row in conn
            .query_all_raw(Statement::from_string(backend, format!("SELECT {select} FROM artifact_version")))
            .await?
        {
            let storage_id: Option<String> = row.try_get_by_index(2)?;
            let attachment_id: Option<String> = row.try_get_by_index(3)?;
            versions.push(LegacyArtifactVersionRow {
                artifact_id: row.try_get_by_index(0)?,
                version: row.try_get_by_index(1)?,
                storage_id: storage_id.or(attachment_id).unwrap_or_default(),
                size: row.try_get_by_index(4)?,
                note: row.try_get_by_index(5)?,
                by_id: row.try_get_by_index(6)?,
                by_name: row.try_get_by_index(7)?,
                message_id: row.try_get_by_index(8)?,
                created_at: row.try_get_by_index(9)?,
            });
        }
    }

    let mut changes = Vec::new();
    if !change_cols.is_empty() {
        let select = [
            "artifact_id",
            "seq",
            "kind",
            "batch_id",
            "actor",
            "targets",
            "block_ids",
            "payload",
            "results",
            "created_at",
        ]
        .into_iter()
        .map(|c| col_or_null(&change_cols, c))
        .collect::<Vec<_>>()
        .join(", ");
        for row in conn
            .query_all_raw(Statement::from_string(backend, format!("SELECT {select} FROM artifact_change")))
            .await?
        {
            let kind: Option<String> = row.try_get_by_index(2)?;
            let targets: Option<String> = row.try_get_by_index(5)?;
            let block_ids: Option<String> = row.try_get_by_index(6)?;
            let payload: Option<String> = row.try_get_by_index(7)?;
            let results: Option<String> = row.try_get_by_index(8)?;
            changes.push(LegacyArtifactChangeRow {
                artifact_id: row.try_get_by_index(0)?,
                seq: row.try_get_by_index(1)?,
                kind: kind.filter(|k| k == "files").unwrap_or_else(|| "files".to_owned()),
                batch_id: row.try_get_by_index(3)?,
                actor: row.try_get_by_index(4)?,
                targets: targets.or(block_ids).unwrap_or_else(|| "[]".to_owned()),
                payload: payload.or(results).unwrap_or_else(|| "{}".to_owned()),
                created_at: row.try_get_by_index(9)?,
            });
        }
    }

    let mut suggestions = Vec::new();
    if !suggestion_cols.is_empty() {
        let select = [
            "id",
            "artifact_id",
            "path",
            "block_id",
            "author",
            "origin",
            "at_rev",
            "base_hash",
            "change",
            "cursor_start",
            "cursor_end",
            "start_offset",
            "end_offset",
            "status",
            "created_at",
            "resolved_at",
            "resolved_by",
        ]
        .into_iter()
        .map(|c| col_or_null(&suggestion_cols, c))
        .collect::<Vec<_>>()
        .join(", ");
        for row in conn
            .query_all_raw(Statement::from_string(backend, format!("SELECT {select} FROM artifact_suggestion")))
            .await?
        {
            let path: Option<String> = row.try_get_by_index(2)?;
            let block_id: Option<String> = row.try_get_by_index(3)?;
            suggestions.push(LegacyArtifactSuggestionRow {
                id: row.try_get_by_index(0)?,
                artifact_id: row.try_get_by_index(1)?,
                path: path.or(block_id).unwrap_or_default(),
                author: row.try_get_by_index(4)?,
                origin: row.try_get_by_index(5)?,
                at_rev: row.try_get_by_index(6)?,
                base_hash: row.try_get_by_index(7)?,
                change: row.try_get_by_index(8)?,
                cursor_start: row.try_get_by_index(9)?,
                cursor_end: row.try_get_by_index(10)?,
                start_offset: row.try_get_by_index(11)?,
                end_offset: row.try_get_by_index(12)?,
                status: row.try_get_by_index(13)?,
                created_at: row.try_get_by_index(14)?,
                resolved_at: row.try_get_by_index(15)?,
                resolved_by: row.try_get_by_index(16)?,
            });
        }
    }

    let mut collabs = Vec::new();
    if !collab_cols.is_empty() {
        for row in conn
            .query_all_raw(Statement::from_string(backend, "SELECT artifact_id, snapshot, updated_at FROM artifact_collab"))
            .await?
        {
            collabs.push(LegacyArtifactCollabRow {
                artifact_id: row.try_get_by_index(0)?,
                snapshot: row.try_get_by_index(1)?,
                updated_at: row.try_get_by_index(2)?,
            });
        }
    }

    // Drop legacy artifact children first so foreign-key checks pass during rebuild.
    for table in [
        "artifact_block_revision",
        "artifact_block",
        "artifact_entry_change",
        "artifact_entry",
        "artifact_suggestion",
        "artifact_change",
        "artifact_version",
        "artifact_collab",
        "artifact",
    ] {
        manager.drop_table(Table::drop().if_exists().table(Alias::new(table)).to_owned()).await?;
    }

    super::m20261124_100001_create_server_tables::create_content_artifact(manager).await?;

    for row in artifacts {
        let artifact_type = normalize_artifact_type(row.artifact_type, row.display.as_deref());
        let is_default = row.is_default && artifact_type == "design-system";
        let stmt = Query::insert()
            .into_table(Alias::new("artifact"))
            .columns([
                Alias::new("id"),
                Alias::new("title"),
                Alias::new("artifact_type"),
                Alias::new("is_default"),
                Alias::new("channel_id"),
                Alias::new("message_id"),
                Alias::new("issue"),
                Alias::new("by_id"),
                Alias::new("by_name"),
                Alias::new("version"),
                Alias::new("seq"),
                Alias::new("created_at"),
                Alias::new("updated_at"),
            ])
            .values_panic([
                row.id.into(),
                row.title.into(),
                artifact_type.into(),
                is_default.into(),
                row.channel_id.into(),
                row.message_id.into(),
                row.issue.into(),
                row.by_id.into(),
                row.by_name.into(),
                row.version.into(),
                row.seq.into(),
                row.created_at.into(),
                row.updated_at.into(),
            ])
            .to_owned();
        manager.exec_stmt(stmt).await?;
    }

    for row in versions {
        let stmt = Query::insert()
            .into_table(Alias::new("artifact_version"))
            .columns([
                Alias::new("artifact_id"),
                Alias::new("version"),
                Alias::new("storage_id"),
                Alias::new("size"),
                Alias::new("note"),
                Alias::new("by_id"),
                Alias::new("by_name"),
                Alias::new("message_id"),
                Alias::new("created_at"),
            ])
            .values_panic([
                row.artifact_id.into(),
                row.version.into(),
                row.storage_id.into(),
                row.size.into(),
                row.note.into(),
                row.by_id.into(),
                row.by_name.into(),
                row.message_id.into(),
                row.created_at.into(),
            ])
            .to_owned();
        manager.exec_stmt(stmt).await?;
    }

    for row in changes {
        let stmt = Query::insert()
            .into_table(Alias::new("artifact_change"))
            .columns([
                Alias::new("artifact_id"),
                Alias::new("seq"),
                Alias::new("kind"),
                Alias::new("batch_id"),
                Alias::new("actor"),
                Alias::new("targets"),
                Alias::new("payload"),
                Alias::new("created_at"),
            ])
            .values_panic([
                row.artifact_id.into(),
                row.seq.into(),
                row.kind.into(),
                row.batch_id.into(),
                row.actor.into(),
                row.targets.into(),
                row.payload.into(),
                row.created_at.into(),
            ])
            .to_owned();
        manager.exec_stmt(stmt).await?;
    }

    for row in suggestions {
        let stmt = Query::insert()
            .into_table(Alias::new("artifact_suggestion"))
            .columns([
                Alias::new("id"),
                Alias::new("artifact_id"),
                Alias::new("path"),
                Alias::new("author"),
                Alias::new("origin"),
                Alias::new("at_rev"),
                Alias::new("base_hash"),
                Alias::new("change"),
                Alias::new("cursor_start"),
                Alias::new("cursor_end"),
                Alias::new("start_offset"),
                Alias::new("end_offset"),
                Alias::new("status"),
                Alias::new("created_at"),
                Alias::new("resolved_at"),
                Alias::new("resolved_by"),
            ])
            .values_panic([
                row.id.into(),
                row.artifact_id.into(),
                row.path.into(),
                row.author.into(),
                row.origin.into(),
                row.at_rev.into(),
                row.base_hash.into(),
                row.change.into(),
                row.cursor_start.into(),
                row.cursor_end.into(),
                row.start_offset.into(),
                row.end_offset.into(),
                row.status.into(),
                row.created_at.into(),
                row.resolved_at.into(),
                row.resolved_by.into(),
            ])
            .to_owned();
        manager.exec_stmt(stmt).await?;
    }

    for row in collabs {
        let stmt = Query::insert()
            .into_table(Alias::new("artifact_collab"))
            .columns([Alias::new("artifact_id"), Alias::new("snapshot"), Alias::new("updated_at")])
            .values_panic([row.artifact_id.into(), row.snapshot.into(), row.updated_at.into()])
            .to_owned();
        manager.exec_stmt(stmt).await?;
    }

    Ok(())
}

async fn drop_obsolete_legacy_tables(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    for table in OBSOLETE_LEGACY_TABLES {
        manager.drop_table(Table::drop().if_exists().table(Alias::new(*table)).to_owned()).await?;
    }
    Ok(())
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        alter_additive_tables(manager).await?;
        rebuild_legacy_session_table(manager).await?;
        rebuild_legacy_artifact_tables(manager).await?;
        drop_obsolete_legacy_tables(manager).await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}

//! Upgrades pre-unified `AgentSession`, `Landing`, and `ParticipantId` rows and
//! rebuilds `channel_delivery` so its `recipient_kind` CHECK constraint matches
//! `('user', 'agent', 'session')`.

use std::collections::{BTreeMap, BTreeSet};

use sea_orm::{DatabaseBackend, Statement};
use sea_orm_migration::prelude::*;
use serde_json::Value;
use vibevalley_kit::db::schema::batch_chunk_rows;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        reconcile_sessions(manager).await?;
        reconcile_issues(manager).await?;
        reconcile_channel_participants(manager).await?;
        reconcile_channel_deliveries(manager).await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}

async fn reconcile_sessions(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    manager
        .exec_stmt(
            Query::update()
                .table(Alias::new("session"))
                .value(Alias::new("controller"), "daemon")
                .and_where(Expr::col(Alias::new("controller")).eq("orchestrator"))
                .to_owned(),
        )
        .await?;

    let conn = manager.get_connection();
    let select = Query::select()
        .columns([Alias::new("id"), Alias::new("policy"), Alias::new("permission_mode")])
        .from(Alias::new("session"))
        .and_where(Expr::col(Alias::new("policy")).like("%managedWorktree%"))
        .to_owned();
    let rows = conn.query_all(&select).await?;
    for row in rows {
        let id: String = row.try_get_by_index(0)?;
        let raw_policy: String = row.try_get_by_index(1)?;
        let permission_mode: Option<String> = row.try_get_by_index(2)?;
        let Some(upgraded) = upgrade_execution_policy(&raw_policy, permission_mode.as_deref()) else {
            continue;
        };
        manager
            .exec_stmt(
                Query::update()
                    .table(Alias::new("session"))
                    .value(Alias::new("policy"), upgraded)
                    .and_where(Expr::col(Alias::new("id")).eq(id))
                    .to_owned(),
            )
            .await?;
    }
    Ok(())
}

fn upgrade_execution_policy(raw_policy: &str, permission_mode: Option<&str>) -> Option<String> {
    let parsed: Value = serde_json::from_str(raw_policy).ok()?;
    if parsed.get("kind").and_then(Value::as_str) != Some("managedWorktree") {
        return None;
    }
    let repo = parsed.get("repo").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let mode = permission_mode
        .filter(|m| matches!(*m, "default" | "acceptEdits" | "plan" | "bypass"))
        .unwrap_or("bypass");
    let mut obj = serde_json::Map::new();
    obj.insert("kind".to_owned(), Value::String("directCwd".to_owned()));
    if let Some(repo) = repo {
        obj.insert("repo".to_owned(), Value::String(repo.to_owned()));
    }
    obj.insert("permissionMode".to_owned(), Value::String(mode.to_owned()));
    serde_json::to_string(&Value::Object(obj)).ok()
}

async fn reconcile_issues(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    manager
        .exec_stmt(
            Query::update()
                .table(Alias::new("issue"))
                .value(Alias::new("delivered"), "merged")
                .and_where(Expr::col(Alias::new("delivered")).eq("merged_into_parent"))
                .to_owned(),
        )
        .await
}

#[derive(Clone)]
struct LegacyParticipant {
    id: String,
    kind: String,
    name: String,
    agent_id: Option<String>,
    home_id: Option<String>,
    joined_at: i64,
    left_at: Option<i64>,
}

fn map_legacy_participant_id(id: &str) -> Option<String> {
    if id == "user" {
        return Some("user:self".to_owned());
    }
    if let Some(profile) = id.strip_prefix("profile:").map(str::trim).filter(|p| !p.is_empty()) {
        return Some(format!("agent:{profile}"));
    }
    None
}

async fn reconcile_channel_participants(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    let conn = manager.get_connection();
    let rows = conn
        .query_all(
            &Query::select()
                .columns([
                    Alias::new("id"),
                    Alias::new("kind"),
                    Alias::new("name"),
                    Alias::new("agent_id"),
                    Alias::new("home_id"),
                    Alias::new("joined_at"),
                    Alias::new("left_at"),
                ])
                .from(Alias::new("channel_participant"))
                .to_owned(),
        )
        .await?;

    let mut by_id: BTreeMap<String, LegacyParticipant> = BTreeMap::new();
    for row in rows {
        let p = LegacyParticipant {
            id: row.try_get_by_index(0)?,
            kind: row.try_get_by_index(1)?,
            name: row.try_get_by_index(2)?,
            agent_id: row.try_get_by_index(3)?,
            home_id: row.try_get_by_index(4)?,
            joined_at: row.try_get_by_index(5)?,
            left_at: row.try_get_by_index(6)?,
        };
        by_id.insert(p.id.clone(), p);
    }

    let legacy_pairs: Vec<(LegacyParticipant, String)> = by_id
        .values()
        .filter_map(|p| map_legacy_participant_id(&p.id).map(|next_id| (p.clone(), next_id)))
        .collect();

    for (old, new_id) in legacy_pairs {
        ensure_canonical_participant(manager, &mut by_id, &old, &new_id).await?;
        migrate_participant_channels(manager, &old.id, &new_id).await?;
        migrate_participant_messages(manager, &old.id, &new_id).await?;
        migrate_participant_mentions(manager, &old.id, &new_id).await?;
        migrate_participant_members(manager, &old.id, &new_id).await?;
        migrate_participant_read_cursors(manager, &old.id, &new_id).await?;
        migrate_participant_seen(manager, &old.id, &new_id).await?;
        manager
            .exec_stmt(
                Query::delete()
                    .from_table(Alias::new("channel_participant"))
                    .and_where(Expr::col(Alias::new("id")).eq(old.id.as_str()))
                    .to_owned(),
            )
            .await?;
        by_id.remove(&old.id);
    }

    reconcile_message_reactions(manager).await
}

async fn ensure_canonical_participant(
    manager: &SchemaManager<'_>,
    by_id: &mut BTreeMap<String, LegacyParticipant>,
    old: &LegacyParticipant,
    new_id: &str,
) -> Result<(), DbErr> {
    if let Some(existing) = by_id.get(new_id).cloned() {
        let joined_at = std::cmp::min(existing.joined_at, old.joined_at);
        let agent_id = existing.agent_id.clone().or_else(|| old.agent_id.clone());
        let home_id = existing.home_id.clone().or_else(|| old.home_id.clone());
        let left_at = match (existing.left_at, old.left_at) {
            (None, _) | (_, None) => None,
            (Some(a), Some(b)) => Some(std::cmp::max(a, b)),
        };
        manager
            .exec_stmt(
                Query::update()
                    .table(Alias::new("channel_participant"))
                    .values([
                        (Alias::new("agent_id"), agent_id.clone().into()),
                        (Alias::new("home_id"), home_id.clone().into()),
                        (Alias::new("joined_at"), joined_at.into()),
                        (Alias::new("left_at"), left_at.into()),
                    ])
                    .and_where(Expr::col(Alias::new("id")).eq(new_id))
                    .to_owned(),
            )
            .await?;
        by_id.insert(
            new_id.to_owned(),
            LegacyParticipant {
                agent_id,
                home_id,
                joined_at,
                left_at,
                ..existing
            },
        );
    } else {
        manager
            .exec_stmt(
                Query::insert()
                    .into_table(Alias::new("channel_participant"))
                    .columns([
                        Alias::new("id"),
                        Alias::new("kind"),
                        Alias::new("name"),
                        Alias::new("agent_id"),
                        Alias::new("home_id"),
                        Alias::new("joined_at"),
                        Alias::new("left_at"),
                    ])
                    .values_panic([
                        new_id.into(),
                        old.kind.clone().into(),
                        old.name.clone().into(),
                        old.agent_id.clone().into(),
                        old.home_id.clone().into(),
                        old.joined_at.into(),
                        old.left_at.into(),
                    ])
                    .to_owned(),
            )
            .await?;
        by_id.insert(
            new_id.to_owned(),
            LegacyParticipant {
                id: new_id.to_owned(),
                ..old.clone()
            },
        );
    }
    Ok(())
}

async fn migrate_participant_channels(manager: &SchemaManager<'_>, old_id: &str, new_id: &str) -> Result<(), DbErr> {
    let conn = manager.get_connection();
    let existing_peer = conn
        .query_one(
            &Query::select()
                .column(Alias::new("id"))
                .from(Alias::new("channel"))
                .and_where(Expr::col(Alias::new("peer_id")).eq(new_id))
                .limit(1)
                .to_owned(),
        )
        .await?;
    if existing_peer.is_some() {
        manager
            .exec_stmt(
                Query::update()
                    .table(Alias::new("channel"))
                    .value(Alias::new("peer_id"), Option::<String>::None)
                    .and_where(Expr::col(Alias::new("peer_id")).eq(old_id))
                    .to_owned(),
            )
            .await?;
    } else {
        manager
            .exec_stmt(
                Query::update()
                    .table(Alias::new("channel"))
                    .value(Alias::new("peer_id"), new_id)
                    .and_where(Expr::col(Alias::new("peer_id")).eq(old_id))
                    .to_owned(),
            )
            .await?;
    }
    manager
        .exec_stmt(
            Query::update()
                .table(Alias::new("channel"))
                .value(Alias::new("subject_id"), new_id)
                .and_where(Expr::col(Alias::new("subject_kind")).eq("talk"))
                .and_where(Expr::col(Alias::new("subject_id")).eq(old_id))
                .to_owned(),
        )
        .await
}

async fn migrate_participant_messages(manager: &SchemaManager<'_>, old_id: &str, new_id: &str) -> Result<(), DbErr> {
    let conn = manager.get_connection();
    let new_keys_rows = conn
        .query_all(
            &Query::select()
                .column(Alias::new("send_key"))
                .from(Alias::new("channel_message"))
                .and_where(Expr::col(Alias::new("sender_id")).eq(new_id))
                .and_where(Expr::col(Alias::new("send_key")).is_not_null())
                .to_owned(),
        )
        .await?;
    let mut new_keys = BTreeSet::new();
    for r in new_keys_rows {
        if let Some(k) = r.try_get_by_index::<Option<String>>(0)? {
            new_keys.insert(k);
        }
    }
    if !new_keys.is_empty() {
        manager
            .exec_stmt(
                Query::update()
                    .table(Alias::new("channel_message"))
                    .value(Alias::new("send_key"), Option::<String>::None)
                    .and_where(Expr::col(Alias::new("sender_id")).eq(old_id))
                    .and_where(Expr::col(Alias::new("send_key")).is_in(new_keys))
                    .to_owned(),
            )
            .await?;
    }
    manager
        .exec_stmt(
            Query::update()
                .table(Alias::new("channel_message"))
                .value(Alias::new("sender_id"), new_id)
                .and_where(Expr::col(Alias::new("sender_id")).eq(old_id))
                .to_owned(),
        )
        .await
}

async fn migrate_participant_mentions(manager: &SchemaManager<'_>, old_id: &str, new_id: &str) -> Result<(), DbErr> {
    let conn = manager.get_connection();
    let existing = conn
        .query_all(
            &Query::select()
                .column(Alias::new("message_id"))
                .from(Alias::new("channel_mention"))
                .and_where(Expr::col(Alias::new("target_id")).eq(new_id))
                .to_owned(),
        )
        .await?;
    let mut message_ids = BTreeSet::new();
    for r in existing {
        message_ids.insert(r.try_get_by_index::<String>(0)?);
    }
    if !message_ids.is_empty() {
        manager
            .exec_stmt(
                Query::delete()
                    .from_table(Alias::new("channel_mention"))
                    .and_where(Expr::col(Alias::new("target_id")).eq(old_id))
                    .and_where(Expr::col(Alias::new("message_id")).is_in(message_ids))
                    .to_owned(),
            )
            .await?;
    }
    manager
        .exec_stmt(
            Query::update()
                .table(Alias::new("channel_mention"))
                .value(Alias::new("target_id"), new_id)
                .and_where(Expr::col(Alias::new("target_id")).eq(old_id))
                .to_owned(),
        )
        .await
}

async fn migrate_participant_members(manager: &SchemaManager<'_>, old_id: &str, new_id: &str) -> Result<(), DbErr> {
    let conn = manager.get_connection();
    let rows = conn
        .query_all(
            &Query::select()
                .columns([
                    Alias::new("channel_id"),
                    Alias::new("participant_id"),
                    Alias::new("reason"),
                    Alias::new("from_number"),
                    Alias::new("left_at"),
                ])
                .from(Alias::new("channel_member"))
                .and_where(Expr::col(Alias::new("participant_id")).is_in([old_id, new_id]))
                .to_owned(),
        )
        .await?;

    let mut old_by_channel: BTreeMap<String, (String, i64, Option<i64>)> = BTreeMap::new();
    let mut new_by_channel: BTreeMap<String, (String, i64, Option<i64>)> = BTreeMap::new();
    for r in rows {
        let ch: String = r.try_get_by_index(0)?;
        let pid: String = r.try_get_by_index(1)?;
        let reason: String = r.try_get_by_index(2)?;
        let from_number: i64 = r.try_get_by_index(3)?;
        let left_at: Option<i64> = r.try_get_by_index(4)?;
        if pid == old_id {
            old_by_channel.insert(ch, (reason, from_number, left_at));
        } else {
            new_by_channel.insert(ch, (reason, from_number, left_at));
        }
    }

    for (ch, (old_reason, old_from, old_left)) in old_by_channel {
        if let Some((_new_reason, new_from, new_left)) = new_by_channel.get(&ch).cloned() {
            let from_number = std::cmp::min(new_from, old_from);
            let left_at = match (new_left, old_left) {
                (None, _) | (_, None) => None,
                (Some(a), Some(b)) => Some(std::cmp::max(a, b)),
            };
            manager
                .exec_stmt(
                    Query::update()
                        .table(Alias::new("channel_member"))
                        .values([(Alias::new("from_number"), from_number.into()), (Alias::new("left_at"), left_at.into())])
                        .and_where(Expr::col(Alias::new("channel_id")).eq(ch))
                        .and_where(Expr::col(Alias::new("participant_id")).eq(new_id))
                        .to_owned(),
                )
                .await?;
        } else {
            manager
                .exec_stmt(
                    Query::insert()
                        .into_table(Alias::new("channel_member"))
                        .columns([
                            Alias::new("channel_id"),
                            Alias::new("participant_id"),
                            Alias::new("reason"),
                            Alias::new("from_number"),
                            Alias::new("left_at"),
                        ])
                        .values_panic([ch.into(), new_id.into(), old_reason.into(), old_from.into(), old_left.into()])
                        .to_owned(),
                )
                .await?;
        }
    }

    manager
        .exec_stmt(
            Query::delete()
                .from_table(Alias::new("channel_member"))
                .and_where(Expr::col(Alias::new("participant_id")).eq(old_id))
                .to_owned(),
        )
        .await
}

async fn migrate_participant_read_cursors(manager: &SchemaManager<'_>, old_id: &str, new_id: &str) -> Result<(), DbErr> {
    let conn = manager.get_connection();
    let rows = conn
        .query_all(
            &Query::select()
                .columns([
                    Alias::new("participant_id"),
                    Alias::new("channel_id"),
                    Alias::new("read_number"),
                    Alias::new("updated_at"),
                ])
                .from(Alias::new("channel_read_cursor"))
                .and_where(Expr::col(Alias::new("participant_id")).is_in([old_id, new_id]))
                .to_owned(),
        )
        .await?;

    let mut old_by_channel: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    let mut new_by_channel: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    for r in rows {
        let pid: String = r.try_get_by_index(0)?;
        let ch: String = r.try_get_by_index(1)?;
        let read_number: i64 = r.try_get_by_index(2)?;
        let updated_at: i64 = r.try_get_by_index(3)?;
        if pid == old_id {
            old_by_channel.insert(ch, (read_number, updated_at));
        } else {
            new_by_channel.insert(ch, (read_number, updated_at));
        }
    }

    for (ch, (old_read, old_updated)) in old_by_channel {
        if let Some((new_read, new_updated)) = new_by_channel.get(&ch).copied() {
            manager
                .exec_stmt(
                    Query::update()
                        .table(Alias::new("channel_read_cursor"))
                        .values([
                            (Alias::new("read_number"), std::cmp::max(new_read, old_read).into()),
                            (Alias::new("updated_at"), std::cmp::max(new_updated, old_updated).into()),
                        ])
                        .and_where(Expr::col(Alias::new("participant_id")).eq(new_id))
                        .and_where(Expr::col(Alias::new("channel_id")).eq(ch))
                        .to_owned(),
                )
                .await?;
        } else {
            manager
                .exec_stmt(
                    Query::insert()
                        .into_table(Alias::new("channel_read_cursor"))
                        .columns([
                            Alias::new("participant_id"),
                            Alias::new("channel_id"),
                            Alias::new("read_number"),
                            Alias::new("updated_at"),
                        ])
                        .values_panic([new_id.into(), ch.into(), old_read.into(), old_updated.into()])
                        .to_owned(),
                )
                .await?;
        }
    }

    manager
        .exec_stmt(
            Query::delete()
                .from_table(Alias::new("channel_read_cursor"))
                .and_where(Expr::col(Alias::new("participant_id")).eq(old_id))
                .to_owned(),
        )
        .await
}

async fn migrate_participant_seen(manager: &SchemaManager<'_>, old_id: &str, new_id: &str) -> Result<(), DbErr> {
    let conn = manager.get_connection();
    let rows = conn
        .query_all(
            &Query::select()
                .columns([Alias::new("participant_id"), Alias::new("message_id"), Alias::new("seen_at")])
                .from(Alias::new("channel_seen"))
                .and_where(Expr::col(Alias::new("participant_id")).is_in([old_id, new_id]))
                .to_owned(),
        )
        .await?;

    let mut old_by_msg: BTreeMap<String, i64> = BTreeMap::new();
    let mut new_by_msg: BTreeMap<String, i64> = BTreeMap::new();
    for r in rows {
        let pid: String = r.try_get_by_index(0)?;
        let msg: String = r.try_get_by_index(1)?;
        let seen_at: i64 = r.try_get_by_index(2)?;
        if pid == old_id {
            old_by_msg.insert(msg, seen_at);
        } else {
            new_by_msg.insert(msg, seen_at);
        }
    }

    for (msg, old_seen) in old_by_msg {
        if let Some(new_seen) = new_by_msg.get(&msg).copied() {
            manager
                .exec_stmt(
                    Query::update()
                        .table(Alias::new("channel_seen"))
                        .value(Alias::new("seen_at"), std::cmp::min(new_seen, old_seen))
                        .and_where(Expr::col(Alias::new("participant_id")).eq(new_id))
                        .and_where(Expr::col(Alias::new("message_id")).eq(msg))
                        .to_owned(),
                )
                .await?;
        } else {
            manager
                .exec_stmt(
                    Query::insert()
                        .into_table(Alias::new("channel_seen"))
                        .columns([Alias::new("participant_id"), Alias::new("message_id"), Alias::new("seen_at")])
                        .values_panic([new_id.into(), msg.into(), old_seen.into()])
                        .to_owned(),
                )
                .await?;
        }
    }

    manager
        .exec_stmt(
            Query::delete()
                .from_table(Alias::new("channel_seen"))
                .and_where(Expr::col(Alias::new("participant_id")).eq(old_id))
                .to_owned(),
        )
        .await
}

async fn reconcile_message_reactions(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    let conn = manager.get_connection();
    let rows = conn
        .query_all(
            &Query::select()
                .columns([Alias::new("id"), Alias::new("reactions")])
                .from(Alias::new("channel_message"))
                .and_where(Expr::col(Alias::new("reactions")).is_not_null())
                .to_owned(),
        )
        .await?;

    for row in rows {
        let id: String = row.try_get_by_index(0)?;
        let Some(raw) = row.try_get_by_index::<Option<String>>(1)? else {
            continue;
        };
        let Some(upgraded) = upgrade_reactions_json(&raw) else {
            continue;
        };
        manager
            .exec_stmt(
                Query::update()
                    .table(Alias::new("channel_message"))
                    .value(Alias::new("reactions"), upgraded)
                    .and_where(Expr::col(Alias::new("id")).eq(id))
                    .to_owned(),
            )
            .await?;
    }
    Ok(())
}

fn upgrade_reactions_json(raw: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let obj = parsed.as_object()?;
    let mut changed = false;
    let mut entries: Vec<String> = Vec::with_capacity(obj.len());
    for (emoji, val) in obj {
        let arr = val.as_array()?;
        let mut out: Vec<String> = Vec::with_capacity(arr.len());
        for item in arr {
            let who = item.as_str()?;
            let mapped = if let Some(next) = map_legacy_participant_id(who) {
                changed = true;
                next
            } else {
                who.to_owned()
            };
            if !out.contains(&mapped) {
                out.push(mapped);
            } else {
                changed = true;
            }
        }
        if !out.is_empty() {
            entries.push(format!("{}:{}", serde_json::to_string(emoji).ok()?, serde_json::to_string(&out).ok()?));
        }
    }
    if !changed {
        return None;
    }
    Some(format!("{{{}}}", entries.join(",")))
}

struct DeliveryRecord {
    id: i64,
    message_id: String,
    channel_id: String,
    recipient_kind: String,
    recipient_id: String,
    reason: String,
    wakes: bool,
    held_by: Option<String>,
    status: String,
    created_at: i64,
    settled_at: Option<i64>,
}

fn map_delivery_recipient(kind: &str, id: &str) -> Option<(String, String)> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return None;
    }
    match kind {
        "user" => {
            let uid = if trimmed == "user" {
                "self".to_owned()
            } else {
                trimmed.strip_prefix("user:").unwrap_or(trimmed).to_owned()
            };
            (!uid.is_empty()).then(|| ("user".to_owned(), uid))
        }
        "agent" | "orchestrator" | "direct" => {
            let profile = trimmed
                .strip_prefix("agent:")
                .or_else(|| trimmed.strip_prefix("profile:"))
                .unwrap_or(trimmed)
                .to_owned();
            (!profile.is_empty()).then(|| ("agent".to_owned(), profile))
        }
        "issue" => {
            let sid = if trimmed.starts_with("issue:") {
                trimmed.to_owned()
            } else {
                format!("issue:{trimmed}")
            };
            Some(("session".to_owned(), sid))
        }
        "session" => {
            let sid = trimmed.strip_prefix("session:").unwrap_or(trimmed).to_owned();
            (!sid.is_empty()).then(|| ("session".to_owned(), sid))
        }
        _ => None,
    }
}

async fn reconcile_channel_deliveries(manager: &SchemaManager<'_>) -> Result<(), DbErr> {
    let conn = manager.get_connection();
    let backend = manager.get_database_backend();
    let rows = conn
        .query_all_raw(Statement::from_string(
            backend,
            "SELECT d.id, d.message_id, d.channel_id, d.recipient_kind, d.recipient_id, d.reason, d.wakes, d.held_by, d.status, d.created_at, d.settled_at \
             FROM channel_delivery d \
             INNER JOIN channel_message m ON m.id = d.message_id \
             INNER JOIN channel c ON c.id = d.channel_id \
             ORDER BY d.id ASC",
        ))
        .await?;

    let mut seen_keys: BTreeSet<(String, String, String)> = BTreeSet::new();
    let mut kept: Vec<DeliveryRecord> = Vec::with_capacity(rows.len());
    for row in rows {
        let id: i64 = row.try_get_by_index(0)?;
        let message_id: String = row.try_get_by_index(1)?;
        let channel_id: String = row.try_get_by_index(2)?;
        let raw_kind: String = row.try_get_by_index(3)?;
        let raw_recipient: String = row.try_get_by_index(4)?;
        let Some((recipient_kind, recipient_id)) = map_delivery_recipient(&raw_kind, &raw_recipient) else {
            continue;
        };
        if !seen_keys.insert((message_id.clone(), recipient_kind.clone(), recipient_id.clone())) {
            continue;
        }
        let reason: String = row.try_get_by_index(5)?;
        let wakes: bool = match backend {
            DatabaseBackend::Postgres => row.try_get_by_index::<bool>(6)?,
            _ => row.try_get_by_index::<i64>(6)? != 0,
        };
        let held_by: Option<String> = row.try_get_by_index(7)?;
        let status: String = row.try_get_by_index(8)?;
        let created_at: i64 = row.try_get_by_index(9)?;
        let settled_at: Option<i64> = row.try_get_by_index(10)?;
        kept.push(DeliveryRecord {
            id,
            message_id,
            channel_id,
            recipient_kind,
            recipient_id,
            reason,
            wakes,
            held_by,
            status,
            created_at,
            settled_at,
        });
    }

    manager
        .drop_table(Table::drop().if_exists().table(Alias::new("channel_delivery")).to_owned())
        .await?;
    super::m20261124_100001_create_server_tables::create_channel_delivery_table_and_indexes(manager).await?;
    manager
        .create_index(
            Index::create()
                .if_not_exists()
                .name("channel_delivery_kind_pending_id")
                .table(Alias::new("channel_delivery"))
                .col(Alias::new("recipient_kind"))
                .col(Alias::new("id"))
                .and_where(Expr::col(Alias::new("status")).eq("pending"))
                .to_owned(),
        )
        .await?;
    manager
        .create_index(
            Index::create()
                .if_not_exists()
                .name("channel_delivery_settled_prune")
                .table(Alias::new("channel_delivery"))
                .col(Alias::new("settled_at"))
                .col(Alias::new("id"))
                .and_where(Expr::col(Alias::new("status")).ne("pending"))
                .and_where(Expr::col(Alias::new("settled_at")).is_not_null())
                .to_owned(),
        )
        .await?;

    for chunk in kept.chunks(batch_chunk_rows(11)) {
        let mut insert = Query::insert();
        insert.into_table(Alias::new("channel_delivery")).columns([
            Alias::new("id"),
            Alias::new("message_id"),
            Alias::new("channel_id"),
            Alias::new("recipient_kind"),
            Alias::new("recipient_id"),
            Alias::new("reason"),
            Alias::new("wakes"),
            Alias::new("held_by"),
            Alias::new("status"),
            Alias::new("created_at"),
            Alias::new("settled_at"),
        ]);
        for rec in chunk {
            insert.values_panic([
                rec.id.into(),
                rec.message_id.clone().into(),
                rec.channel_id.clone().into(),
                rec.recipient_kind.clone().into(),
                rec.recipient_id.clone().into(),
                rec.reason.clone().into(),
                rec.wakes.into(),
                rec.held_by.clone().into(),
                rec.status.clone().into(),
                rec.created_at.into(),
                rec.settled_at.into(),
            ]);
        }
        manager.exec_stmt(insert.to_owned()).await?;
    }

    if backend == DatabaseBackend::Postgres {
        conn.execute_unprepared(
            "SELECT setval(\
                pg_get_serial_sequence('channel_delivery', 'id'), \
                COALESCE((SELECT MAX(id) FROM channel_delivery), 1), \
                EXISTS (SELECT 1 FROM channel_delivery)\
            )",
        )
        .await?;
    }

    Ok(())
}

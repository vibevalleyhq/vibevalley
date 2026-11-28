//! Dual-backend persistence for channels, threads, direct messages, participants,
//! memberships, messages, mentions, read cursors, seen markers, events, and deliveries.

use std::sync::Arc;

use sea_orm::sea_query::SimpleExpr;
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait, QueryFilter, Select};

use crate::db::{Database, DbResult};

mod message;
mod participant;
mod room;

pub(crate) use message::{DeliveryRow, MsgRow, NewDelivery, NewMessage, SearchParams};
pub(crate) use participant::ParticipantRow;
pub(crate) use room::{ChannelRow, NewThread};

#[derive(Debug, Clone)]
pub(crate) struct PlacedRow {
    pub(crate) row: MsgRow,
    pub(crate) channel_type: String,
    pub(crate) root_number: Option<i64>,
    pub(crate) top_id: String,
    pub(crate) channel_name: String,
}

#[derive(Debug, Clone)]
pub(crate) struct UnreadRow {
    pub(crate) r#type: String,
    pub(crate) root_number: Option<i64>,
    pub(crate) channel_name: String,
    pub(crate) unread: i64,
    pub(crate) mentions_you: bool,
    pub(crate) latest_sender_name: Option<String>,
}

#[derive(Clone)]
pub(crate) struct ChannelService {
    db: Arc<Database>,
}

impl ChannelService {
    pub(super) fn new(db: Arc<Database>) -> Self {
        Self { db }
    }
}

pub(super) fn limit_u64(n: i64) -> u64 {
    u64::try_from(n).unwrap_or(0)
}

pub(super) async fn count_by_two<E, C, V1, V2>(conn: &C, c1: E::Column, v1: V1, c2: E::Column, v2: V2) -> DbResult<i64>
where
    E: EntityTrait,
    E::Column: ColumnTrait,
    V1: Into<sea_orm::Value>,
    V2: Into<sea_orm::Value>,
    C: ConnectionTrait,
    for<'a> Select<E>: PaginatorTrait<'a, C>,
{
    let f1: SimpleExpr = c1.eq(v1);
    let f2: SimpleExpr = c2.eq(v2);
    let count = E::find().filter(f1).filter(f2).count(conn).await?;
    Ok(count as i64)
}

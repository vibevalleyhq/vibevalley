//! Dual-backend persistence for paired remote device tokens (`remote_device`).

use std::sync::Arc;

use sea_orm::sea_query::Expr;
use sea_orm::{ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use vibevalley_protocol::{Millis, RemoteDeviceSummary, RemotePlatform};

use super::with_write_tx;
use crate::db::column::{db_word, read_db_word};
use crate::db::entity::remote_device;
use crate::db::{Database, DbResult};

fn summary_from_model(row: remote_device::Model) -> RemoteDeviceSummary {
    RemoteDeviceSummary {
        id: row.id,
        name: row.name,
        platform: read_db_word(row.platform).unwrap_or(RemotePlatform::Other),
        scope: row.scope,
        created_at: row.created_at,
        last_seen_at: row.last_seen_at,
        revoked_at: row.revoked_at,
    }
}

#[derive(Clone)]
pub(crate) struct RemoteService {
    db: Arc<Database>,
}

impl RemoteService {
    pub(super) fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub(crate) async fn insert_device(&self, device: &RemoteDeviceSummary, token_hash: &str) -> DbResult<()> {
        let platform = db_word(&device.platform)?;
        remote_device::ActiveModel {
            id: Set(device.id.clone()),
            name: Set(device.name.clone()),
            platform: Set(platform),
            token_hash: Set(token_hash.to_owned()),
            scope: Set(device.scope.clone()),
            created_at: Set(device.created_at),
            last_seen_at: Set(device.last_seen_at),
            revoked_at: Set(device.revoked_at),
        }
        .insert(self.db.write_conn())
        .await?;
        Ok(())
    }

    pub(crate) async fn find_device_by_token_hash(&self, token_hash: &str) -> DbResult<Option<RemoteDeviceSummary>> {
        let row = remote_device::Entity::find()
            .filter(remote_device::Column::TokenHash.eq(token_hash))
            .one(self.db.read_conn())
            .await?;
        Ok(row.map(summary_from_model))
    }

    pub(crate) async fn find_device_by_id(&self, id: &str) -> DbResult<Option<RemoteDeviceSummary>> {
        let row = remote_device::Entity::find_by_id(id.to_owned()).one(self.db.read_conn()).await?;
        Ok(row.map(summary_from_model))
    }

    pub(crate) async fn list_devices(&self) -> DbResult<Vec<RemoteDeviceSummary>> {
        let rows = remote_device::Entity::find()
            .order_by_desc(remote_device::Column::CreatedAt)
            .order_by_desc(remote_device::Column::Id)
            .all(self.db.read_conn())
            .await?;
        Ok(rows.into_iter().map(summary_from_model).collect())
    }

    pub(crate) async fn touch_device_last_seen(&self, id: &str, at: Millis) -> DbResult<()> {
        remote_device::Entity::update_many()
            .col_expr(remote_device::Column::LastSeenAt, Expr::value(Some(at)))
            .filter(remote_device::Column::Id.eq(id))
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }

    pub(crate) async fn revoke_device(&self, id: &str, at: Millis) -> DbResult<bool> {
        with_write_tx(&self.db, async |tx| {
            let Some(device) = remote_device::Entity::find_by_id(id.to_owned()).one(tx).await? else {
                return Ok(false);
            };
            if device.revoked_at.is_none() {
                remote_device::Entity::update_many()
                    .col_expr(remote_device::Column::RevokedAt, Expr::value(Some(at)))
                    .filter(remote_device::Column::Id.eq(id))
                    .filter(remote_device::Column::RevokedAt.is_null())
                    .exec(tx)
                    .await?;
            }
            Ok(true)
        })
        .await
    }
}

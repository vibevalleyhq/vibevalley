//! Dual-backend persistence for remote access configuration and paired device tokens.

use std::sync::Arc;

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use vibevalley_protocol::{Millis, RemoteDeviceSummary, RemotePlatform};

use crate::db::column::{db_word, read_db_word};
use crate::db::entity::{remote_config, remote_device};
use crate::db::{Database, DbResult, begin_write_tx, commit_tx, rollback_tx};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRemoteConfig {
    pub enabled: bool,
    pub bind_addr: Option<String>,
    pub port: u16,
    pub updated_at: Millis,
}

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
pub struct RemoteService {
    db: Arc<Database>,
}

impl RemoteService {
    pub(super) fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub async fn get_config(&self) -> DbResult<Option<StoredRemoteConfig>> {
        let row = remote_config::Entity::find_by_id(1i64).one(self.db.read_conn()).await?;
        Ok(row.map(|r| StoredRemoteConfig {
            enabled: r.enabled,
            bind_addr: r.bind_addr.filter(|s| !s.is_empty()),
            port: u16::try_from(r.port).unwrap_or(0),
            updated_at: r.updated_at,
        }))
    }

    pub async fn save_config(&self, enabled: bool, bind_addr: Option<&str>, port: u16, updated_at: Millis) -> DbResult<()> {
        let bind_addr = bind_addr.map(str::trim).filter(|s| !s.is_empty()).map(String::from);
        let model = remote_config::ActiveModel {
            id: Set(1),
            enabled: Set(enabled),
            bind_addr: Set(bind_addr),
            port: Set(i64::from(port)),
            updated_at: Set(updated_at),
        };
        let on_conflict = OnConflict::column(remote_config::Column::Id)
            .update_columns([
                remote_config::Column::Enabled,
                remote_config::Column::BindAddr,
                remote_config::Column::Port,
                remote_config::Column::UpdatedAt,
            ])
            .to_owned();
        remote_config::Entity::insert(model).on_conflict(on_conflict).exec(self.db.write_conn()).await?;
        Ok(())
    }

    pub async fn insert_device(&self, device: &RemoteDeviceSummary, token_hash: &str) -> DbResult<()> {
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

    pub async fn find_device_by_token_hash(&self, token_hash: &str) -> DbResult<Option<RemoteDeviceSummary>> {
        let row = remote_device::Entity::find()
            .filter(remote_device::Column::TokenHash.eq(token_hash))
            .one(self.db.read_conn())
            .await?;
        Ok(row.map(summary_from_model))
    }

    pub async fn find_device_by_id(&self, id: &str) -> DbResult<Option<RemoteDeviceSummary>> {
        let row = remote_device::Entity::find_by_id(id.to_owned()).one(self.db.read_conn()).await?;
        Ok(row.map(summary_from_model))
    }

    pub async fn list_devices(&self) -> DbResult<Vec<RemoteDeviceSummary>> {
        let rows = remote_device::Entity::find()
            .order_by_desc(remote_device::Column::CreatedAt)
            .order_by_desc(remote_device::Column::Id)
            .all(self.db.read_conn())
            .await?;
        Ok(rows.into_iter().map(summary_from_model).collect())
    }

    pub async fn touch_device_last_seen(&self, id: &str, at: Millis) -> DbResult<()> {
        remote_device::Entity::update_many()
            .col_expr(remote_device::Column::LastSeenAt, Expr::value(Some(at)))
            .filter(remote_device::Column::Id.eq(id))
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }

    pub async fn revoke_device(&self, id: &str, at: Millis) -> DbResult<bool> {
        let tx = begin_write_tx(self.db.write_conn()).await?;
        let outcome: DbResult<bool> = async {
            let Some(device) = remote_device::Entity::find_by_id(id.to_owned()).one(&tx).await? else {
                return Ok(false);
            };
            if device.revoked_at.is_none() {
                remote_device::Entity::update_many()
                    .col_expr(remote_device::Column::RevokedAt, Expr::value(Some(at)))
                    .filter(remote_device::Column::Id.eq(id))
                    .filter(remote_device::Column::RevokedAt.is_null())
                    .exec(&tx)
                    .await?;
            }
            Ok(true)
        }
        .await;
        match outcome {
            Ok(found) => {
                if found {
                    commit_tx(tx).await?;
                } else {
                    let _ = rollback_tx(tx).await;
                }
                Ok(found)
            }
            Err(err) => {
                let _ = rollback_tx(tx).await;
                Err(err)
            }
        }
    }
}

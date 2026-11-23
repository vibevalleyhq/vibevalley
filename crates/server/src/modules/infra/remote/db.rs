//! SQLite persistence for remote access configuration and paired device tokens.

use std::sync::Arc;

use sqlx::Connection;
use vibevalley_protocol::{ApiError, Millis, RemoteDeviceSummary, RemotePlatform};

use crate::base::{ServerDb, internal};
use crate::db::generated::infra_remote as q;
use crate::modules::infra::column::optional;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StoredConfig {
    pub enabled: bool,
    pub bind_addr: Option<String>,
    pub port: u16,
    pub updated_at: Millis,
}

pub(crate) struct RemoteDb {
    db: Arc<ServerDb>,
}

fn parse_platform(raw: &str) -> RemotePlatform {
    RemotePlatform::from_str(raw).unwrap_or(RemotePlatform::Other)
}

fn summary_from(
    id: String,
    name: String,
    platform: String,
    scope: String,
    created_at: i64,
    last_seen_at: Option<i64>,
    revoked_at: Option<i64>,
) -> RemoteDeviceSummary {
    RemoteDeviceSummary {
        id,
        name,
        platform: parse_platform(&platform),
        scope,
        created_at,
        last_seen_at,
        revoked_at,
    }
}

impl RemoteDb {
    pub(crate) fn new(db: Arc<ServerDb>) -> Self {
        Self { db }
    }

    pub(crate) fn get_config(&self) -> Result<Option<StoredConfig>, ApiError> {
        let row = self.db.run(async |c| optional(q::get_config(c).await)).map_err(internal)?;
        Ok(row.map(|r| StoredConfig {
            enabled: r.enabled != 0,
            bind_addr: r.bind_addr.filter(|s| !s.is_empty()),
            port: u16::try_from(r.port).unwrap_or(0),
            updated_at: r.updated_at,
        }))
    }

    pub(crate) fn save_config(&self, enabled: bool, bind_addr: Option<&str>, port: u16, updated_at: Millis) -> Result<(), ApiError> {
        let bind_addr = bind_addr.map(str::trim).filter(|s| !s.is_empty()).map(String::from);
        self.db
            .run(async |c| {
                q::save_config(
                    c,
                    q::SaveConfigParams {
                        enabled: i64::from(enabled),
                        bind_addr,
                        port: i64::from(port),
                        updated_at,
                    },
                )
                .await
            })
            .map_err(internal)
    }

    pub(crate) fn insert_device(&self, device: &RemoteDeviceSummary, token_hash: &str) -> Result<(), ApiError> {
        self.db
            .run(async |c| {
                q::insert_device(
                    c,
                    q::InsertDeviceParams {
                        id: device.id.clone(),
                        name: device.name.clone(),
                        platform: device.platform.as_str().into(),
                        token_hash: token_hash.into(),
                        scope: device.scope.clone(),
                        created_at: device.created_at,
                    },
                )
                .await
            })
            .map_err(internal)
    }

    pub(crate) fn find_by_token_hash(&self, token_hash: &str) -> Result<Option<RemoteDeviceSummary>, ApiError> {
        let row = self
            .db
            .run(async |c| optional(q::find_device_by_token_hash(c, q::FindDeviceByTokenHashParams { token_hash: token_hash.into() }).await))
            .map_err(internal)?;
        Ok(row.map(|r| summary_from(r.id, r.name, r.platform, r.scope, r.created_at, r.last_seen_at, r.revoked_at)))
    }

    pub(crate) fn find_by_id(&self, id: &str) -> Result<Option<RemoteDeviceSummary>, ApiError> {
        let row = self
            .db
            .run(async |c| optional(q::find_device_by_id(c, q::FindDeviceByIdParams { id: id.into() }).await))
            .map_err(internal)?;
        Ok(row.map(|r| summary_from(r.id, r.name, r.platform, r.scope, r.created_at, r.last_seen_at, r.revoked_at)))
    }

    pub(crate) fn list_devices(&self) -> Result<Vec<RemoteDeviceSummary>, ApiError> {
        let rows = self.db.run(async |c| q::list_devices(c).await).map_err(internal)?;
        Ok(rows
            .into_iter()
            .map(|r| summary_from(r.id, r.name, r.platform, r.scope, r.created_at, r.last_seen_at, r.revoked_at))
            .collect())
    }

    pub(crate) fn touch_last_seen(&self, id: &str, at: Millis) -> Result<(), ApiError> {
        self.db
            .run(async |c| {
                q::touch_device_last_seen(
                    c,
                    q::TouchDeviceLastSeenParams {
                        id: id.into(),
                        last_seen_at: Some(at),
                    },
                )
                .await
            })
            .map_err(internal)
    }

    pub(crate) fn revoke_device(&self, id: &str, at: Millis) -> Result<bool, ApiError> {
        self.db
            .run(async |c| {
                let mut tx = c.begin_with("BEGIN IMMEDIATE").await?;
                let found = optional(q::find_device_by_id(&mut *tx, q::FindDeviceByIdParams { id: id.into() }).await)?;
                let Some(device) = found else {
                    return Ok(false);
                };
                if device.revoked_at.is_none() {
                    q::revoke_device(
                        &mut *tx,
                        q::RevokeDeviceParams {
                            id: id.into(),
                            revoked_at: Some(at),
                        },
                    )
                    .await?;
                }
                tx.commit().await?;
                Ok(true)
            })
            .map_err(internal)
    }
}

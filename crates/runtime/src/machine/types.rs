use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::oar::{Runtime, find_runtime};

pub const LOCAL_MACHINE_ID: &str = "local";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MachinePlatform {
    Macos,
    Linux,
    Container,
    Other,
}

impl MachinePlatform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Macos
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Other
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MachineStatus {
    Online,
    Offline,
    Draining,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkdirSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_root: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    pub task_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkdirHandle {
    pub path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub ephemeral: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineDescriptor {
    pub machine_id: String,
    pub label: String,
    pub platform: MachinePlatform,
    pub status: MachineStatus,
    pub ephemeral: bool,
    pub local: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RuntimeRefParseError {
    #[error("runtime ref `{0}` must be formatted as `<machine_id>/<runtime_id>`")]
    InvalidFormat(String),
    #[error("runtime ref `{0}` has an empty machine_id")]
    EmptyMachineId(String),
    #[error("runtime ref `{0}` has an empty runtime_id")]
    EmptyRuntimeId(String),
}

/// Composite routing key `<machine_id>/<runtime_id>`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRef {
    pub machine_id: String,
    pub runtime_id: String,
}

impl RuntimeRef {
    pub fn new(machine_id: impl Into<String>, runtime_id: impl Into<String>) -> Self {
        Self {
            machine_id: machine_id.into(),
            runtime_id: runtime_id.into(),
        }
    }

    pub fn local(runtime_id: impl Into<String>) -> Self {
        Self::new(LOCAL_MACHINE_ID, runtime_id)
    }

    pub fn parse(raw: &str) -> Result<Self, RuntimeRefParseError> {
        raw.parse()
    }

    pub fn is_local(&self) -> bool {
        self.machine_id == LOCAL_MACHINE_ID
    }
}

impl fmt::Display for RuntimeRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.machine_id, self.runtime_id)
    }
}

impl FromStr for RuntimeRef {
    type Err = RuntimeRefParseError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        let Some((machine_id, runtime_id)) = raw.split_once('/') else {
            return Err(RuntimeRefParseError::InvalidFormat(raw.to_string()));
        };
        if runtime_id.contains('/') {
            return Err(RuntimeRefParseError::InvalidFormat(raw.to_string()));
        }
        let machine_id = machine_id.trim();
        let runtime_id = runtime_id.trim();
        if machine_id.is_empty() {
            return Err(RuntimeRefParseError::EmptyMachineId(raw.to_string()));
        }
        if runtime_id.is_empty() {
            return Err(RuntimeRefParseError::EmptyRuntimeId(raw.to_string()));
        }
        Ok(Self {
            machine_id: machine_id.to_string(),
            runtime_id: runtime_id.to_string(),
        })
    }
}

/// An execution host (local process, remote machine over WS, or ephemeral
/// sandbox container) that owns a set of OAR `Runtime`s and optional isolated
/// working directory primitives.
pub trait Machine: Send + Sync {
    fn descriptor(&self) -> MachineDescriptor;
    fn machine_id(&self) -> &str;
    fn runtimes(&self) -> Vec<Arc<dyn Runtime>>;

    fn runtime(&self, runtime_id: &str) -> Option<Arc<dyn Runtime>> {
        let runtimes = self.runtimes();
        find_runtime(&runtimes, runtime_id)
    }

    fn prepare_workdir(&self, _spec: &WorkdirSpec) -> Result<WorkdirHandle, String> {
        Err("workdir preparation unsupported".to_string())
    }

    fn cleanup_workdir(&self, _handle: &WorkdirHandle) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MachineRegistryEvent {
    Registered { descriptor: MachineDescriptor },
    Updated { descriptor: MachineDescriptor },
    Unregistered { descriptor: MachineDescriptor },
}

impl MachineRegistryEvent {
    pub fn descriptor(&self) -> &MachineDescriptor {
        match self {
            Self::Registered { descriptor } | Self::Updated { descriptor } | Self::Unregistered { descriptor } => descriptor,
        }
    }

    pub fn machine_id(&self) -> &str {
        &self.descriptor().machine_id
    }
}

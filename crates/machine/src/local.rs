use std::fmt;
use std::sync::Arc;

use vibevalley_oar::{Registry, Runtime};

use super::types::{LOCAL_MACHINE_ID, Machine, MachineDescriptor, MachinePlatform, MachineStatus};

/// In-process local host adapter wrapping `oar::Registry` with zero network
/// serialization.
pub struct LocalMachine {
    label: String,
    registry: Arc<Registry>,
}

impl LocalMachine {
    pub fn new(registry: impl Into<Arc<Registry>>) -> Self {
        Self {
            label: "Local".to_string(),
            registry: registry.into(),
        }
    }

    pub fn from_runtimes(runtimes: Vec<Arc<dyn Runtime>>) -> Self {
        let mut registry = Registry::new();
        for runtime in runtimes {
            registry.register(runtime);
        }
        Self::new(registry)
    }

    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = label.into();
        self
    }

    pub fn registry(&self) -> &Arc<Registry> {
        &self.registry
    }
}

impl fmt::Debug for LocalMachine {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let runtime_ids: Vec<&str> = self.registry.list().iter().map(|r| r.id()).collect();
        f.debug_struct("LocalMachine")
            .field("machine_id", &LOCAL_MACHINE_ID)
            .field("label", &self.label)
            .field("runtimes", &runtime_ids)
            .finish()
    }
}

impl Machine for LocalMachine {
    fn descriptor(&self) -> MachineDescriptor {
        MachineDescriptor {
            machine_id: LOCAL_MACHINE_ID.to_string(),
            label: self.label.clone(),
            platform: MachinePlatform::current(),
            status: MachineStatus::Online,
            ephemeral: false,
            local: true,
        }
    }

    fn machine_id(&self) -> &str {
        LOCAL_MACHINE_ID
    }

    fn runtimes(&self) -> Vec<Arc<dyn Runtime>> {
        self.registry.list().to_vec()
    }

    fn runtime(&self, runtime_id: &str) -> Option<Arc<dyn Runtime>> {
        self.registry.get(runtime_id)
    }
}

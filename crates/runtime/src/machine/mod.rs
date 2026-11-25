//! Execution-layer `Machine` abstraction and lock-free `MachineRegistry`.

pub mod remote;

use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;

use arc_swap::ArcSwap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::oar::{Registry, Runtime, find_runtime};

pub use remote::{RemoteDispatchMeta, RemoteMachine, RemoteRuntime, RemoteSession, attach_dispatch_meta};

pub const LOCAL_MACHINE_ID: &str = "local";

const DEFAULT_EVENT_CAPACITY: usize = 128;

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

#[derive(Clone, Default)]
struct MachineTable {
    machines: BTreeMap<String, Arc<dyn Machine>>,
}

/// Dynamic routing table of active `Machine`s with lock-free reads via
/// `ArcSwap` and serialized copy-on-write mutations.
pub struct MachineRegistry {
    table: ArcSwap<MachineTable>,
    // Serializes copy-on-write mutations and event broadcast ordering; reads never acquire this lock.
    write_lock: Mutex<()>,
    events: broadcast::Sender<MachineRegistryEvent>,
}

impl MachineRegistry {
    pub fn new() -> Self {
        Self::with_event_capacity(DEFAULT_EVENT_CAPACITY)
    }

    pub fn with_event_capacity(capacity: usize) -> Self {
        let (events, _) = broadcast::channel(capacity.max(1));
        Self {
            table: ArcSwap::from_pointee(MachineTable::default()),
            write_lock: Mutex::new(()),
            events,
        }
    }

    pub fn with_local(registry: impl Into<Arc<Registry>>) -> Self {
        let machines = Self::new();
        machines.register(Arc::new(LocalMachine::new(registry)));
        machines
    }

    /// Registers or replaces a machine by `machine.machine_id()`, emitting
    /// `Registered` for new entries and `Updated` when replacing an existing one.
    pub fn register(&self, machine: Arc<dyn Machine>) {
        let _guard = self.write_lock.lock();
        let machine_id = machine.machine_id().to_string();
        let descriptor = machine.descriptor();
        debug_assert_eq!(
            descriptor.machine_id, machine_id,
            "Machine::descriptor().machine_id must match Machine::machine_id()"
        );

        let mut next = (**self.table.load()).clone();
        let replaced = next.machines.insert(machine_id, machine).is_some();
        self.table.store(Arc::new(next));

        let event = if replaced {
            MachineRegistryEvent::Updated { descriptor }
        } else {
            MachineRegistryEvent::Registered { descriptor }
        };
        let _ = self.events.send(event);
    }

    /// Broadcasts an `Updated` event for a registered machine whose live
    /// descriptor changed in place (e.g. `Online` -> `Draining` or `Offline`).
    pub fn notify_updated(&self, machine_id: &str) -> bool {
        let _guard = self.write_lock.lock();
        let current = self.table.load();
        let Some(machine) = current.machines.get(machine_id) else {
            return false;
        };
        let _ = self.events.send(MachineRegistryEvent::Updated {
            descriptor: machine.descriptor(),
        });
        true
    }

    /// Removes `machine_id` if present and emits `Unregistered`.
    pub fn unregister(&self, machine_id: &str) -> Option<Arc<dyn Machine>> {
        let _guard = self.write_lock.lock();
        let mut next = (**self.table.load()).clone();
        let removed = next.machines.remove(machine_id)?;
        let descriptor = removed.descriptor();
        self.table.store(Arc::new(next));
        let _ = self.events.send(MachineRegistryEvent::Unregistered { descriptor });
        Some(removed)
    }

    pub fn get(&self, machine_id: &str) -> Option<Arc<dyn Machine>> {
        self.table.load().machines.get(machine_id).cloned()
    }

    pub fn len(&self) -> usize {
        self.table.load().machines.len()
    }

    pub fn is_empty(&self) -> bool {
        self.table.load().machines.is_empty()
    }

    /// Returns descriptors for all registered machines, local machines first
    /// then sorted by `machine_id`.
    pub fn list(&self) -> Vec<MachineDescriptor> {
        let table = self.table.load();
        let mut descriptors: Vec<MachineDescriptor> = table.machines.values().map(|machine| machine.descriptor()).collect();
        descriptors.sort_by(|a, b| b.local.cmp(&a.local).then_with(|| a.machine_id.cmp(&b.machine_id)));
        descriptors
    }

    /// Resolves an explicit `<machine_id>/<runtime_id>` reference regardless of
    /// status so callers can report `Offline`/`Draining` explicitly rather than
    /// collapsing them into "not found".
    pub fn resolve(&self, target: &RuntimeRef) -> Option<(Arc<dyn Machine>, Arc<dyn Runtime>)> {
        let table = self.table.load();
        let machine = table.machines.get(&target.machine_id)?;
        let runtime = machine.runtime(&target.runtime_id)?;
        Some((Arc::clone(machine), runtime))
    }

    /// Resolves `runtime_id` by checking online `"local"` first, then falling
    /// back to the first `Online` machine in deterministic `machine_id` order.
    pub fn resolve_local_or_any(&self, runtime_id: &str) -> Option<(Arc<dyn Machine>, Arc<dyn Runtime>)> {
        let table = self.table.load();
        if let Some(local) = table.machines.get(LOCAL_MACHINE_ID)
            && local.descriptor().status == MachineStatus::Online
            && let Some(runtime) = local.runtime(runtime_id)
        {
            return Some((Arc::clone(local), runtime));
        }
        for (id, machine) in &table.machines {
            if id == LOCAL_MACHINE_ID {
                continue;
            }
            if machine.descriptor().status != MachineStatus::Online {
                continue;
            }
            if let Some(runtime) = machine.runtime(runtime_id) {
                return Some((Arc::clone(machine), runtime));
            }
        }
        None
    }

    /// Flattens every `(MachineDescriptor, Runtime)` pair across all registered
    /// machines, local machines first then sorted by `machine_id`.
    pub fn all_runtimes(&self) -> Vec<(MachineDescriptor, Arc<dyn Runtime>)> {
        let table = self.table.load();
        let mut entries: Vec<(MachineDescriptor, Vec<Arc<dyn Runtime>>)> =
            table.machines.values().map(|machine| (machine.descriptor(), machine.runtimes())).collect();
        entries.sort_by(|(a, _), (b, _)| b.local.cmp(&a.local).then_with(|| a.machine_id.cmp(&b.machine_id)));

        let mut out = Vec::new();
        for (descriptor, runtimes) in entries {
            for runtime in runtimes {
                out.push((descriptor.clone(), runtime));
            }
        }
        out
    }

    pub fn subscribe(&self) -> broadcast::Receiver<MachineRegistryEvent> {
        self.events.subscribe()
    }
}

impl Default for MachineRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for MachineRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let table = self.table.load();
        let ids: Vec<&str> = table.machines.keys().map(String::as_str).collect();
        f.debug_struct("MachineRegistry").field("machines", &ids).finish()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Barrier;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use parking_lot::RwLock;

    use super::*;
    use crate::oar::scripted::{Script, ScriptedRuntime};
    use crate::oar::{ContentBlock, EventKind, SessionOptions};

    struct MockMachine {
        machine_id: String,
        label: String,
        platform: MachinePlatform,
        status: RwLock<MachineStatus>,
        ephemeral: bool,
        runtimes: Vec<Arc<dyn Runtime>>,
        prepared: AtomicUsize,
        cleaned: AtomicUsize,
    }

    impl MockMachine {
        fn new(
            machine_id: impl Into<String>,
            label: impl Into<String>,
            platform: MachinePlatform,
            status: MachineStatus,
            ephemeral: bool,
            runtimes: Vec<Arc<dyn Runtime>>,
        ) -> Self {
            Self {
                machine_id: machine_id.into(),
                label: label.into(),
                platform,
                status: RwLock::new(status),
                ephemeral,
                runtimes,
                prepared: AtomicUsize::new(0),
                cleaned: AtomicUsize::new(0),
            }
        }

        fn set_status(&self, status: MachineStatus) {
            *self.status.write() = status;
        }
    }

    impl Machine for MockMachine {
        fn descriptor(&self) -> MachineDescriptor {
            MachineDescriptor {
                machine_id: self.machine_id.clone(),
                label: self.label.clone(),
                platform: self.platform,
                status: *self.status.read(),
                ephemeral: self.ephemeral,
                local: false,
            }
        }

        fn machine_id(&self) -> &str {
            &self.machine_id
        }

        fn runtimes(&self) -> Vec<Arc<dyn Runtime>> {
            self.runtimes.clone()
        }

        fn prepare_workdir(&self, spec: &WorkdirSpec) -> Result<WorkdirHandle, String> {
            self.prepared.fetch_add(1, Ordering::SeqCst);
            Ok(WorkdirHandle {
                path: PathBuf::from(format!("/work/{}/{}", self.machine_id, spec.task_id)),
                branch: spec.branch.clone(),
                ephemeral: self.ephemeral,
            })
        }

        fn cleanup_workdir(&self, _handle: &WorkdirHandle) -> Result<(), String> {
            self.cleaned.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn scripted(id: &str) -> Arc<dyn Runtime> {
        Arc::new(ScriptedRuntime::new(id, Script::echo()))
    }

    #[tokio::test]
    async fn local_machine_wraps_scripted_runtime_and_runs_session() {
        let mut oar_registry = Registry::new();
        oar_registry.register(scripted("scripted"));
        oar_registry.register(scripted("acp:opencode"));

        let local = Arc::new(LocalMachine::new(oar_registry).with_label("MacBook Pro"));
        let desc = local.descriptor();
        assert_eq!(desc.machine_id, LOCAL_MACHINE_ID);
        assert_eq!(desc.label, "MacBook Pro");
        assert_eq!(desc.platform, MachinePlatform::current());
        assert_eq!(desc.status, MachineStatus::Online);
        assert!(!desc.ephemeral);
        assert!(desc.local);
        assert_eq!(local.machine_id(), LOCAL_MACHINE_ID);
        assert_eq!(local.runtimes().len(), 2);
        assert_eq!(local.runtime("opencode").expect("acp prefix match").id(), "acp:opencode");
        assert!(local.prepare_workdir(&WorkdirSpec::default()).is_err());
        assert!(
            local
                .cleanup_workdir(&WorkdirHandle {
                    path: PathBuf::from("/tmp/noop"),
                    branch: None,
                    ephemeral: false,
                })
                .is_ok()
        );

        let machines = MachineRegistry::new();
        machines.register(local);

        let (machine, runtime) = machines.resolve(&RuntimeRef::local("scripted")).expect("local scripted runtime");
        assert_eq!(machine.machine_id(), LOCAL_MACHINE_ID);
        assert_eq!(runtime.id(), "scripted");

        let session = runtime
            .open(SessionOptions {
                cwd: std::env::temp_dir(),
                ..Default::default()
            })
            .await
            .expect("open scripted session");
        let mut events = session.events();
        session.prompt(vec![ContentBlock::Text("hello local".into())]).await.expect("prompt");

        let mut echoed = String::new();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
                .await
                .expect("event before timeout")
                .expect("channel open");
            match event.kind {
                EventKind::TextDelta { text } => echoed.push_str(&text),
                EventKind::TurnFinished { .. } => break,
                _ => {}
            }
        }
        assert_eq!(echoed, "hello local");
    }

    #[test]
    fn hot_plug_register_update_unregister_remote_and_ephemeral_machines() {
        let registry = MachineRegistry::with_local(Registry::new());
        assert_eq!(registry.len(), 1);
        assert!(!registry.is_empty());

        let remote = Arc::new(MockMachine::new(
            "gpu-1",
            "GPU Devbox",
            MachinePlatform::Linux,
            MachineStatus::Online,
            false,
            vec![scripted("claude"), scripted("codex")],
        ));
        let sandbox = Arc::new(MockMachine::new(
            "sbx-42",
            "CI Sandbox #42",
            MachinePlatform::Container,
            MachineStatus::Online,
            true,
            vec![scripted("claude")],
        ));

        registry.register(remote.clone());
        registry.register(sandbox.clone());
        assert_eq!(registry.len(), 3);

        let listed = registry.list();
        let ids: Vec<&str> = listed.iter().map(|d| d.machine_id.as_str()).collect();
        assert_eq!(ids, vec!["local", "gpu-1", "sbx-42"]);
        assert!(listed[0].local);
        assert!(!listed[1].ephemeral);
        assert!(listed[2].ephemeral);
        assert_eq!(listed[2].platform, MachinePlatform::Container);

        let handle = sandbox
            .prepare_workdir(&WorkdirSpec {
                repo_root: None,
                repo_url: Some("https://example.com/org/repo.git".into()),
                branch: Some("feat/test".into()),
                base_ref: Some("main".into()),
                task_id: "issue-99".into(),
            })
            .expect("prepare sandbox workdir");
        assert_eq!(handle.path, PathBuf::from("/work/sbx-42/issue-99"));
        assert_eq!(handle.branch.as_deref(), Some("feat/test"));
        assert!(handle.ephemeral);
        sandbox.cleanup_workdir(&handle).expect("cleanup sandbox workdir");
        assert_eq!(sandbox.prepared.load(Ordering::SeqCst), 1);
        assert_eq!(sandbox.cleaned.load(Ordering::SeqCst), 1);

        let all = registry.all_runtimes();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].0.machine_id, "gpu-1");
        assert_eq!(all[2].0.machine_id, "sbx-42");

        let remote_v2 = Arc::new(MockMachine::new(
            "gpu-1",
            "GPU Devbox (upgraded)",
            MachinePlatform::Linux,
            MachineStatus::Online,
            false,
            vec![scripted("claude")],
        ));
        registry.register(remote_v2);
        assert_eq!(registry.len(), 3);
        assert_eq!(registry.get("gpu-1").unwrap().descriptor().label, "GPU Devbox (upgraded)");
        assert!(registry.resolve(&RuntimeRef::new("gpu-1", "codex")).is_none());
        assert!(registry.resolve(&RuntimeRef::new("gpu-1", "claude")).is_some());

        let removed = registry.unregister("sbx-42").expect("sandbox removed");
        assert_eq!(removed.machine_id(), "sbx-42");
        assert!(removed.descriptor().ephemeral);
        assert!(registry.get("sbx-42").is_none());
        assert!(registry.resolve(&RuntimeRef::new("sbx-42", "claude")).is_none());
        assert!(registry.unregister("sbx-42").is_none());
    }

    #[test]
    fn runtime_ref_display_parse_and_validation() {
        let local = RuntimeRef::local("claude");
        assert!(local.is_local());
        assert_eq!(local.to_string(), "local/claude");
        assert_eq!(RuntimeRef::parse("local/claude").unwrap(), local);

        let remote = RuntimeRef::parse("gpu-1/acp:opencode").unwrap();
        assert!(!remote.is_local());
        assert_eq!(remote.machine_id, "gpu-1");
        assert_eq!(remote.runtime_id, "acp:opencode");
        assert_eq!(remote.to_string(), "gpu-1/acp:opencode");

        assert!(matches!(RuntimeRef::parse(""), Err(RuntimeRefParseError::InvalidFormat(_))));
        assert!(matches!(RuntimeRef::parse("claude"), Err(RuntimeRefParseError::InvalidFormat(_))));
        assert!(matches!(RuntimeRef::parse("a/b/c"), Err(RuntimeRefParseError::InvalidFormat(_))));
        assert!(matches!(RuntimeRef::parse("/claude"), Err(RuntimeRefParseError::EmptyMachineId(_))));
        assert!(matches!(RuntimeRef::parse("  /claude"), Err(RuntimeRefParseError::EmptyMachineId(_))));
        assert!(matches!(RuntimeRef::parse("local/"), Err(RuntimeRefParseError::EmptyRuntimeId(_))));
        assert!(matches!(RuntimeRef::parse("local/  "), Err(RuntimeRefParseError::EmptyRuntimeId(_))));
    }

    #[test]
    fn resolve_and_fallback_respect_local_priority_and_online_status() {
        let registry = MachineRegistry::new();
        registry.register(Arc::new(LocalMachine::from_runtimes(vec![scripted("claude")])));

        let gpu_online = Arc::new(MockMachine::new(
            "gpu-1",
            "GPU Online",
            MachinePlatform::Linux,
            MachineStatus::Online,
            false,
            vec![scripted("claude"), scripted("codex")],
        ));
        let gpu_offline = Arc::new(MockMachine::new(
            "gpu-2",
            "GPU Offline",
            MachinePlatform::Linux,
            MachineStatus::Offline,
            false,
            vec![scripted("only-offline"), scripted("codex")],
        ));
        let gpu_draining = Arc::new(MockMachine::new(
            "gpu-3",
            "GPU Draining",
            MachinePlatform::Container,
            MachineStatus::Draining,
            true,
            vec![scripted("only-draining"), scripted("codex")],
        ));

        registry.register(gpu_online.clone());
        registry.register(gpu_offline);
        registry.register(gpu_draining);

        let (m, r) = registry.resolve_local_or_any("claude").expect("prefers local");
        assert_eq!(m.machine_id(), LOCAL_MACHINE_ID);
        assert_eq!(r.id(), "claude");

        let (m, r) = registry.resolve(&RuntimeRef::new("gpu-1", "claude")).expect("explicit remote target");
        assert_eq!(m.machine_id(), "gpu-1");
        assert_eq!(r.id(), "claude");

        let (m, r) = registry.resolve_local_or_any("codex").expect("falls back to online remote");
        assert_eq!(m.machine_id(), "gpu-1");
        assert_eq!(r.id(), "codex");

        assert!(registry.resolve_local_or_any("only-offline").is_none());
        assert!(registry.resolve_local_or_any("only-draining").is_none());

        let (offline_machine, _) = registry
            .resolve(&RuntimeRef::new("gpu-2", "only-offline"))
            .expect("explicit resolve exposes offline descriptor");
        assert_eq!(offline_machine.descriptor().status, MachineStatus::Offline);

        gpu_online.set_status(MachineStatus::Draining);
        assert!(registry.notify_updated("gpu-1"));
        assert!(registry.resolve_local_or_any("codex").is_none());

        assert!(registry.resolve(&RuntimeRef::new("missing", "claude")).is_none());
        assert!(registry.resolve(&RuntimeRef::new("gpu-1", "missing")).is_none());

        let headless = MachineRegistry::new();
        headless.register(Arc::new(MockMachine::new(
            "remote-a",
            "Remote A",
            MachinePlatform::Linux,
            MachineStatus::Online,
            false,
            vec![scripted("claude")],
        )));
        let (m, r) = headless.resolve_local_or_any("claude").expect("resolves remote without local");
        assert_eq!(m.machine_id(), "remote-a");
        assert_eq!(r.id(), "claude");
    }

    #[test]
    fn broadcast_events_report_register_update_and_unregister() {
        let registry = MachineRegistry::new();
        let mut rx_a = registry.subscribe();
        let mut rx_b = registry.subscribe();

        let box_v1 = Arc::new(MockMachine::new(
            "dev-1",
            "Dev Box",
            MachinePlatform::Linux,
            MachineStatus::Online,
            false,
            vec![scripted("claude")],
        ));
        registry.register(box_v1.clone());

        let box_v2 = Arc::new(MockMachine::new(
            "dev-1",
            "Dev Box v2",
            MachinePlatform::Linux,
            MachineStatus::Draining,
            false,
            vec![scripted("claude")],
        ));
        registry.register(box_v2.clone());

        box_v2.set_status(MachineStatus::Offline);
        assert!(registry.notify_updated("dev-1"));
        assert!(!registry.notify_updated("ghost"));

        assert!(registry.unregister("dev-1").is_some());
        assert!(registry.unregister("dev-1").is_none());

        let drain = |rx: &mut broadcast::Receiver<MachineRegistryEvent>| -> Vec<MachineRegistryEvent> {
            let mut out = Vec::new();
            while let Ok(event) = rx.try_recv() {
                out.push(event);
            }
            out
        };

        let events_a = drain(&mut rx_a);
        let events_b = drain(&mut rx_b);
        assert_eq!(events_a, events_b);
        assert_eq!(events_a.len(), 4);

        match &events_a[0] {
            MachineRegistryEvent::Registered { descriptor } => {
                assert_eq!(descriptor.machine_id, "dev-1");
                assert_eq!(descriptor.label, "Dev Box");
                assert_eq!(descriptor.status, MachineStatus::Online);
            }
            other => panic!("expected Registered, got {other:?}"),
        }
        match &events_a[1] {
            MachineRegistryEvent::Updated { descriptor } => {
                assert_eq!(descriptor.label, "Dev Box v2");
                assert_eq!(descriptor.status, MachineStatus::Draining);
            }
            other => panic!("expected Updated, got {other:?}"),
        }
        match &events_a[2] {
            MachineRegistryEvent::Updated { descriptor } => {
                assert_eq!(descriptor.status, MachineStatus::Offline);
            }
            other => panic!("expected Updated, got {other:?}"),
        }
        match &events_a[3] {
            MachineRegistryEvent::Unregistered { descriptor } => {
                assert_eq!(descriptor.machine_id, "dev-1");
                assert_eq!(events_a[3].machine_id(), "dev-1");
            }
            other => panic!("expected Unregistered, got {other:?}"),
        }

        let wire = serde_json::to_string(&events_a[0]).expect("serialize event");
        let decoded: MachineRegistryEvent = serde_json::from_str(&wire).expect("deserialize event");
        assert_eq!(decoded, events_a[0]);
    }

    #[test]
    fn concurrent_lock_free_reads_stay_consistent_under_hot_plug_writes() {
        let registry = Arc::new(MachineRegistry::new());
        registry.register(Arc::new(LocalMachine::from_runtimes(vec![scripted("scripted")])));

        let reader_count = 4;
        let writer_count = 2;
        let iterations = 200;
        let barrier = Arc::new(Barrier::new(reader_count + writer_count));
        let mut handles = Vec::new();

        for writer_idx in 0..writer_count {
            let registry = Arc::clone(&registry);
            let barrier = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                for step in 0..iterations {
                    let id = format!("sbx-{writer_idx}-{}", step % 8);
                    let machine = Arc::new(MockMachine::new(
                        id.clone(),
                        format!("Sandbox {id}"),
                        MachinePlatform::Container,
                        MachineStatus::Online,
                        true,
                        vec![scripted("claude")],
                    ));
                    registry.register(machine);
                    if step % 2 == 0 {
                        let _ = registry.unregister(&id);
                    }
                }
            }));
        }

        for _ in 0..reader_count {
            let registry = Arc::clone(&registry);
            let barrier = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                for _ in 0..iterations * 3 {
                    let (local, rt) = registry.resolve(&RuntimeRef::local("scripted")).expect("local always resolves");
                    assert_eq!(local.machine_id(), LOCAL_MACHINE_ID);
                    assert_eq!(rt.id(), "scripted");

                    let (fallback_m, _) = registry.resolve_local_or_any("scripted").expect("fallback always resolves");
                    assert_eq!(fallback_m.machine_id(), LOCAL_MACHINE_ID);

                    let list = registry.list();
                    assert!(!list.is_empty());
                    assert_eq!(list[0].machine_id, LOCAL_MACHINE_ID);

                    let _ = registry.all_runtimes();
                }
            }));
        }

        for handle in handles {
            handle.join().expect("thread finished without panic");
        }

        assert!(registry.get(LOCAL_MACHINE_ID).is_some());
    }
}

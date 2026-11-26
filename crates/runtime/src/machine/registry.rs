use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use arc_swap::ArcSwap;
use parking_lot::Mutex;
use tokio::sync::broadcast;

use crate::oar::{Registry, Runtime};

use super::local::LocalMachine;
use super::types::{LOCAL_MACHINE_ID, Machine, MachineDescriptor, MachineRegistryEvent, MachineStatus, RuntimeRef};

const DEFAULT_EVENT_CAPACITY: usize = 128;

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

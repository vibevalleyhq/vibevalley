//! Execution-layer `Machine` abstraction and lock-free `MachineRegistry`.

mod local;
mod registry;
pub mod remote;
mod types;

#[cfg(test)]
mod tests;

pub use local::LocalMachine;
pub use registry::MachineRegistry;
pub use remote::{RemoteDispatchMeta, RemoteMachine, RemoteRuntime, RemoteSession, attach_dispatch_meta};
pub use types::{
    LOCAL_MACHINE_ID, Machine, MachineDescriptor, MachinePlatform, MachineRegistryEvent, MachineStatus, RuntimeRef, RuntimeRefParseError, WorkdirHandle,
    WorkdirSpec,
};

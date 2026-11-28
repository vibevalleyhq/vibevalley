//! Execution-layer `Machine` abstraction, lock-free `MachineRegistry`, remote
//! OAR proxy, and optional ephemeral container sandboxes (`sandbox` feature).

mod local;
mod registry;
pub mod remote;
#[cfg(any(test, feature = "sandbox"))]
pub mod sandbox;
#[cfg(any(test, feature = "sandbox"))]
mod teardown_gate;
mod types;

#[cfg(test)]
mod tests;

pub use local::LocalMachine;
pub use registry::MachineRegistry;
pub use remote::{RemoteDispatchMeta, RemoteMachine, RemoteRuntime, RemoteSession};
#[cfg(any(test, feature = "sandbox"))]
pub use sandbox::{
    AppleContainerSandboxProvider, DockerSandboxProvider, MockSandboxProvider, SandboxCommand, SandboxError, SandboxHandle, SandboxMachine, SandboxProvider,
    SandboxSpec,
};
pub use types::{LOCAL_MACHINE_ID, Machine, MachineDescriptor, MachinePlatform, MachineRegistryEvent, MachineStatus, RuntimeRef, RuntimeRefParseError};

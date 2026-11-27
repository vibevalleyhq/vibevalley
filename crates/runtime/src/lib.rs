//! VibeValley agent runtimes: external engines (`oar`), dynamic execution
//! machines (`machine`), and the built-in DeepSeek durable harness (`agent`).

#[cfg(feature = "agent")]
pub mod agent;
mod loom_sync;
pub mod machine;
pub mod oar;
#[cfg(any(test, feature = "sandbox"))]
pub mod sandbox;
#[cfg(any(test, feature = "sandbox"))]
mod teardown_gate;

pub use vibevalley_rt as rt;

pub type BoxFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

pub use machine::{
    LOCAL_MACHINE_ID, LocalMachine, Machine, MachineDescriptor, MachinePlatform, MachineRegistry, MachineRegistryEvent, MachineStatus, RuntimeRef,
    RuntimeRefParseError, WorkdirHandle, WorkdirSpec,
};
#[cfg(any(test, feature = "sandbox"))]
pub use sandbox::{
    AppleContainerSandboxProvider, DockerSandboxProvider, MockSandboxProvider, SandboxCommand, SandboxError, SandboxHandle, SandboxMachine, SandboxProvider,
    SandboxSpec,
};

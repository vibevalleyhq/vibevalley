//! VibeValley agent runtimes: external engines (`oar`), dynamic execution
//! machines (`machine`), and the built-in DeepSeek durable harness (`agent`).

pub mod agent;
mod loom_sync;
pub mod machine;
pub mod oar;
pub mod rt;
pub mod sandbox;
mod teardown_gate;

pub type BoxFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

pub use machine::{
    LOCAL_MACHINE_ID, LocalMachine, Machine, MachineDescriptor, MachinePlatform, MachineRegistry, MachineRegistryEvent, MachineStatus, RuntimeRef,
    RuntimeRefParseError, WorkdirHandle, WorkdirSpec,
};
pub use sandbox::{
    AppleContainerSandboxProvider, DockerSandboxProvider, MockSandboxProvider, SandboxCommand, SandboxError, SandboxHandle, SandboxMachine, SandboxProvider,
    SandboxSpec,
};

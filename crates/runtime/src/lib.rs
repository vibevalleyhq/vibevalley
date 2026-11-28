//! VibeValley agent runtimes facade: re-exports [`vibevalley_kit::rt`] and the
//! acyclic sub-crates `vibevalley-oar`, `vibevalley-machine` (with optional
//! `sandbox`), and optional `vibevalley-agent`.

#[cfg(feature = "agent")]
pub use vibevalley_agent as agent;
pub use vibevalley_kit::rt;
pub use vibevalley_machine as machine;
#[cfg(feature = "sandbox")]
pub use vibevalley_machine::sandbox;
pub use vibevalley_oar as oar;
pub use vibevalley_oar::BoxFuture;

#[cfg(feature = "sandbox")]
pub use vibevalley_machine::sandbox::{
    AppleContainerSandboxProvider, DockerSandboxProvider, MockSandboxProvider, SandboxCommand, SandboxError, SandboxHandle, SandboxMachine, SandboxProvider,
    SandboxSpec,
};
pub use vibevalley_machine::{
    LOCAL_MACHINE_ID, LocalMachine, Machine, MachineDescriptor, MachinePlatform, MachineRegistry, MachineRegistryEvent, MachineStatus, RuntimeRef,
    RuntimeRefParseError,
};

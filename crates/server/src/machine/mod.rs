//! Execution Machine Registry (`machine.list` + WS `MachineBus`):
//! owns `Arc<MachineRegistry>` (`"local"` + dynamic remote/sandbox hosts),
//! drives authenticated `/api/v1/machine/ws` connections, serves
//! `MachineAttachmentFetch` via [`Storage`](crate::storage::Storage), projects
//! machine presence into [`LiveState`](crate::context::LiveState) +
//! [`StateFeed`](crate::context::StateFeed), and triggers heartbeats on
//! [`TaskGroup`](crate::context::TaskGroup) system wake notifications.

mod service;

pub use service::{MACHINE_HEARTBEAT_MS, Machine, MachineBusAdapter};
pub use vibevalley_runtime::machine::{RemoteDispatchMeta, RemoteMachine, RemoteRuntime, RemoteSession};

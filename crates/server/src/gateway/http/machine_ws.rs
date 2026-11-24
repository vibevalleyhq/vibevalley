//! `GET /api/v1/machine/ws`: authenticated bidirectional WebSocket transport for
//! remote execution machines and ephemeral sandboxes.
//!
//! Security wall:
//! - Mounted on both loopback and remote routers; NEVER falls back to `LocalOwner`.
//! - Authenticates strictly via `RemoteAuth` (`Authorization: Bearer <token>` or `?token=`).
//! - Missing/invalid/revoked tokens -> HTTP 401 (`BizCode::Unauthorized`).
//! - Wrong scope (e.g. `remote:default` client token) -> HTTP 403 (`BizCode::Forbidden`);
//!   requires `SCOPE_REMOTE_MACHINE` (`"remote:runtime"`).
//! - Every text frame decodes into strongly typed `MachineWireFrame` at the door;
//!   `MachineMcpRequest` tunnels through `GatewayPorts::mcp` with zero business-domain imports.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;
use vibevalley_protocol::{BizCode, MachinePing, MachinePong, MachineWireError, MachineWireFrame};

use crate::gateway::api::{MachineConnection, RemoteDeviceIdentity, Server, SharedMachineBus};

use super::auth::MachineAuth;
use super::{HttpState, refuse};

const WS_CHANNEL_CAPACITY: usize = 256;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

pub(super) async fn upgrade(
    State(state): State<HttpState>,
    MachineAuth(identity): MachineAuth,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let Some(bus) = state.ports().machine else {
        return refuse(BizCode::ServiceUnavailable, "machine bus unavailable");
    };

    let ws = match ws {
        Ok(ws) => ws,
        Err(rejection) => return rejection.into_response(),
    };

    let server = state.server;
    let shutdown = state.shutdown;
    let span = tracing::debug_span!("machine.ws", device_id = %identity.device_id);
    ws.on_upgrade(move |socket| handle_socket(socket, server, shutdown, bus, identity).instrument(span))
}

async fn handle_socket(socket: WebSocket, server: Arc<dyn Server>, shutdown: CancellationToken, bus: SharedMachineBus, device: RemoteDeviceIdentity) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (in_tx, in_rx) = flume::bounded::<MachineWireFrame>(WS_CHANNEL_CAPACITY);
    let (out_tx, out_rx) = flume::bounded::<MachineWireFrame>(WS_CHANNEL_CAPACITY);

    bus.accept_connection(MachineConnection {
        device,
        incoming: in_rx,
        outgoing: out_tx.clone(),
    });

    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Consume the immediate first tick so pings wait one full interval.
    heartbeat.tick().await;

    loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => {
                let _ = ws_tx.send(Message::Close(None)).await;
                break;
            }
            out_frame = out_rx.recv_async() => match out_frame {
                Ok(frame) => {
                    let Ok(text) = serde_json::to_string(&frame) else { continue };
                    if ws_tx.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = ws_tx.send(Message::Close(None)).await;
                    break;
                }
            },
            _ = heartbeat.tick() => {
                let ping = MachineWireFrame::MachinePing(MachinePing { ts: crate::context::now() });
                if let Ok(text) = serde_json::to_string(&ping)
                    && ws_tx.send(Message::Text(text.into())).await.is_err()
                {
                    break;
                }
            }
            ws_msg = ws_rx.next() => match ws_msg {
                Some(Ok(Message::Text(text))) => {
                    match serde_json::from_str::<MachineWireFrame>(&text) {
                        Ok(MachineWireFrame::MachinePing(ping)) => {
                            let pong = MachineWireFrame::MachinePong(MachinePong { ts: ping.ts });
                            let _ = out_tx.try_send(pong);
                            let _ = in_tx.try_send(MachineWireFrame::MachinePing(ping));
                        }
                        Ok(MachineWireFrame::MachineMcpRequest(req)) => {
                            let srv = server.clone();
                            let bus_ref = bus.clone();
                            let tx = out_tx.clone();
                            crate::log::spawn_traced(async move {
                                let resp = bus_ref.mcp_tunnel_async(srv, req).await;
                                let _ = tx.send_async(MachineWireFrame::MachineMcpResponse(resp)).await;
                            });
                        }
                        Ok(frame) => {
                            if in_tx.send_async(frame).await.is_err() {
                                break;
                            }
                        }
                        Err(err) => {
                            let wire_err = MachineWireFrame::MachineWireError(MachineWireError {
                                request_id: None,
                                code: "invalid_frame".into(),
                                message: err.to_string(),
                            });
                            let _ = out_tx.try_send(wire_err);
                        }
                    }
                }
                Some(Ok(Message::Ping(payload))) => {
                    if ws_tx.send(Message::Pong(payload)).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Binary(_))) => {
                    let wire_err = MachineWireFrame::MachineWireError(MachineWireError {
                        request_id: None,
                        code: "unsupported_binary".into(),
                        message: "machine WebSocket expects UTF-8 JSON text frames".into(),
                    });
                    let _ = out_tx.try_send(wire_err);
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
            }
        }
    }

    drop(in_tx);
    drop(out_tx);
}

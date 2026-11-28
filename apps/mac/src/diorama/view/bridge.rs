use std::sync::{Arc, Weak};
use std::time::Instant;

use gpui::Context;
use serde_json::{Value, json};
use vibevalley_protocol::{BoardSlice, CollabSlice, FarmFrame, InboxSlice, SessionsSlice, SliceKind};

use crate::hosted::BridgeHub;

use super::{DioramaView, SceneState};

struct SliceOutlet(tokio::sync::mpsc::UnboundedSender<(String, Value)>);

impl vibevalley_server::gateway::bridge::Outlet for SliceOutlet {
    fn send(&self, event: &str, data: Value) {
        let _ = self.0.send((event.to_string(), data));
    }
}

pub(super) const DIORAMA_SLICES: &[SliceKind] = &[SliceKind::Farm, SliceKind::Board, SliceKind::Sessions, SliceKind::Inbox, SliceKind::Collab];

pub(super) fn attach_diorama_bridge(
    bridge: &vibevalley_server::gateway::bridge::Bridge,
    kind: &str,
) -> (
    Arc<vibevalley_server::gateway::bridge::Client>,
    tokio::sync::mpsc::UnboundedReceiver<(String, Value)>,
) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<(String, Value)>();
    let identity = crate::hosted::next_client_identity(vibevalley_server::ClientKind::GpuiPixel, kind);
    let client = Arc::new(bridge.attach(identity, Arc::new(SliceOutlet(tx))));
    for slice in DIORAMA_SLICES {
        let topic = format!("slice:{}", slice.as_str());
        if let Err(error) = client.watch(&topic) {
            eprintln!("diorama watch {topic}: {error}");
        }
    }
    (client, rx)
}

fn decode_slice_frame<'a>(event: &'a str, envelope: &Value) -> Option<(&'a str, u64, Value)> {
    let topic = event.strip_prefix("frame:")?;
    let rev = envelope["rev"].as_u64().unwrap_or(0);
    let data = envelope["data"].clone();
    Some((topic, rev, data))
}

pub(super) async fn pump_diorama_slices(
    mut rx: tokio::sync::mpsc::UnboundedReceiver<(String, Value)>,
    ack_client: Weak<vibevalley_server::gateway::bridge::Client>,
    mut apply: impl FnMut(&str, Value) -> bool,
) {
    while let Some((event, envelope)) = rx.recv().await {
        let Some((topic, rev, data)) = decode_slice_frame(&event, &envelope) else {
            continue;
        };
        if !apply(topic, data) {
            break;
        }
        if let Some(client) = ack_client.upgrade() {
            client.applied_slice(topic, rev);
        }
    }
}

impl DioramaView {
    pub(super) fn on_scene_ready(&mut self, cx: &mut Context<Self>) {
        if let SceneState::Ready(d) = &mut self.scene {
            if self.frames_seen > 0 {
                d.apply_frame(self.frame.clone());
                d.phone.feed(&d.frame.inbox, Instant::now());
            }
            if let Some(repo) = self.props["repo"].as_str() {
                d.repo = Some(repo.to_string());
                d.sync_from_frame();
            }
            self.fetch_agents(cx);
        }
    }

    pub(super) fn on_slice(&mut self, topic: &str, value: Value, cx: &mut Context<Self>) {
        if value.is_null() {
            return;
        }
        self.frames_seen += 1;
        match topic {
            "slice:farm" => {
                let Ok(farm) = serde_json::from_value::<FarmFrame>(value) else { return };
                self.frame.apply_farm(farm.clone());
                if let SceneState::Ready(d) = &mut self.scene {
                    d.apply_farm(farm);
                }
            }
            "slice:board" => {
                let Ok(board) = serde_json::from_value::<BoardSlice>(value) else { return };
                self.frame.apply_board(board.clone());
                if let SceneState::Ready(d) = &mut self.scene {
                    d.apply_board(board);
                }
            }
            "slice:sessions" => {
                let Ok(sessions) = serde_json::from_value::<SessionsSlice>(value) else {
                    return;
                };
                self.frame.apply_sessions(sessions.clone());
                if let SceneState::Ready(d) = &mut self.scene {
                    d.apply_sessions(sessions);
                }
            }
            "slice:inbox" => {
                let Ok(inbox) = serde_json::from_value::<InboxSlice>(value) else { return };
                self.frame.apply_inbox(inbox.clone());
                if let SceneState::Ready(d) = &mut self.scene {
                    d.apply_inbox(inbox);
                    d.phone.feed(&d.frame.inbox, Instant::now());
                }
            }
            "slice:collab" => {
                let Ok(collab) = serde_json::from_value::<CollabSlice>(value) else { return };
                self.frame.apply_collab(collab.clone());
                if let SceneState::Ready(d) = &mut self.scene {
                    d.apply_collab(collab);
                }
            }
            _ => return,
        }
        cx.notify();
    }

    fn fetch_agents(&mut self, cx: &mut Context<Self>) {
        let server = cx.global::<BridgeHub>().0.server().clone();
        let task = vibevalley_kit::rt::current_or_global_handle().spawn(async move {
            server
                .call_with_async(vibevalley_server::gateway::bridge::CallerContext::local(), "agent.list".into(), json!({}))
                .await
        });
        cx.spawn(async move |this, cx| {
            let Ok(envelope) = task.await else { return };
            let _ = this.update(cx, |v, cx| {
                let agents = match envelope.error() {
                    Some(e) => Err(e.message),
                    None => serde_json::from_value::<Vec<vibevalley_protocol::Agent>>(envelope.data.unwrap_or(Value::Null)).map_err(|err| err.to_string()),
                };
                if let SceneState::Ready(d) = &mut v.scene {
                    match agents {
                        Ok(agents) => d.set_profiles(agents),
                        Err(error) => d.show_toast(error),
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
}

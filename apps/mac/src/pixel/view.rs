//! A pane showing one pixel scene, fed by the server's state frames.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, App, AppContext as _, Bounds, Context, Entity, EventEmitter, FocusHandle, Focusable, InteractiveElement as _, IntoElement, KeyDownEvent,
    MouseButton, MouseDownEvent, MouseMoveEvent, ParentElement as _, Pixels, Point, Render, Styled as _, Subscription, Window, canvas, div, px,
};
use serde_json::{Value, json};

use super::atlas::Atlas;
use super::draw::DrawList;
use super::element::{SpriteCache, framing, paint};
use super::farm::frame::Frame;
use super::farm::hud::{self, Action, Panel};
use super::farm::islands::{MapHit, MapScene, RepoSummary};
use super::farm::scene::{FarmScene, FarmTap, FarmTool};
use super::level::{Point as ArtPoint, pt};
use super::opening::OpeningScene;
use super::sky::Framing;
use super::tree::TreeScene;
use crate::hosted::{BridgeHub, HostedEvent, HostedView};
use vibevalley_i18n::t;
use vibevalley_protocol::{AchievementList, ActWords, BoardSlice, CollabSlice, FarmFrame, InboxSlice, IssueAction, SessionsSlice, SliceKind};

/// What a scene asks the shell for.
#[derive(Debug, Clone)]
pub enum PixelEvent {
    Sound(&'static str),
    HostCall {
        op: vibevalley_protocol::HostOp,
        reply: crate::hosted::Replier,
    },
    /// A VibeValley page (`/issues/<id>`, `/agents`…), hosted.
    Route(String),
    /// VibeValley's addition: a terminal in a session's worktree or a repo.
    Terminal {
        cwd: String,
        title: String,
    },
    /// Another pixel scene (the map's island opens that repo's farm).
    Pixel {
        scene: String,
        props: Value,
    },
}

pub enum Scene {
    Loading,
    Failed(String),
    Farm(Box<FarmScene>),
    Map(Box<MapScene>),
    Tree(Box<TreeScene>),
    Opening(Box<OpeningScene>),
}

impl Scene {
    pub fn needs_animation(&self) -> bool {
        matches!(self, Scene::Farm(_) | Scene::Map(_) | Scene::Tree(_) | Scene::Opening(_))
    }

    fn atlas(&self) -> Option<Arc<Atlas>> {
        match self {
            Scene::Farm(f) => Some(f.atlas.clone()),
            Scene::Map(m) => Some(m.atlas.clone()),
            Scene::Tree(t) => Some(t.atlas.clone()),
            _ => None,
        }
    }
}

type Placed = (Bounds<Pixels>, Framing);

pub struct PixelView {
    pub kind: String,
    props: Value,
    pub scene: Scene,
    frame: Frame,
    focus: FocusHandle,
    cache: SpriteCache,
    last: Instant,
    /// Where the picture was last painted, for pointer hits.
    placed: Rc<Cell<Option<Placed>>>,
    pub last_list: Option<Arc<DrawList>>,
    pub frames_seen: u64,
    pub taps: Vec<String>,
    pub unpainted_draws: u64,
    /// A phase set before the scene loaded.
    phone: Option<(Entity<HostedView>, Subscription)>,
    sheet_request: Option<Value>,
    sheet: Option<(Entity<HostedView>, Subscription)>,
    pending_phase: Option<(super::opening::Phase, f32)>,
    command_pending: bool,
    /// Only reveals the cold-load indicator after 150ms so fast loads never flash.
    show_loading: bool,
    _bridge: Option<Arc<vibevalley_server::transport::bridge::Client>>,
}

impl EventEmitter<PixelEvent> for PixelView {}

impl Focusable for PixelView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

fn slices_for_scene(kind: &str) -> &'static [SliceKind] {
    match kind {
        "farm" => &[SliceKind::Farm, SliceKind::Board, SliceKind::Sessions, SliceKind::Inbox, SliceKind::Collab],
        "map" => &[SliceKind::Farm, SliceKind::Board, SliceKind::Sessions],
        "opening" | "opening:launch" => &[SliceKind::Board],
        _ => &[],
    }
}

struct SliceOutlet(flume::Sender<(String, Value)>);

impl vibevalley_server::transport::bridge::Outlet for SliceOutlet {
    fn send(&self, event: &str, data: Value) {
        let _ = self.0.send((event.to_string(), data));
    }
}

impl PixelView {
    pub fn new(kind: &str, props: Value, cx: &mut Context<Self>) -> PixelView {
        let slices = slices_for_scene(kind);
        let bridge_client = (!slices.is_empty()).then(|| {
            let (tx, rx) = flume::unbounded::<(String, Value)>();
            let identity = crate::hosted::next_client_identity(vibevalley_server::ClientKind::GpuiPixel, kind);
            let client = Arc::new(cx.global::<BridgeHub>().0.attach(identity, Arc::new(SliceOutlet(tx))));
            for slice in slices {
                let topic = format!("slice:{}", slice.as_str());
                if let Err(error) = client.watch(&topic) {
                    eprintln!("pixel watch {topic}: {error}");
                }
            }
            let ack_client = client.clone();
            cx.spawn(async move |this, cx| {
                while let Ok((event, envelope)) = rx.recv_async().await {
                    let Some(topic) = event.strip_prefix("frame:") else {
                        continue;
                    };
                    let rev = envelope["rev"].as_u64().unwrap_or(0);
                    let data = envelope["data"].clone();
                    let alive = this.update(cx, |v, cx| v.on_slice(topic, data, cx));
                    ack_client.applied_slice(topic, rev);
                    if alive.is_err() {
                        break;
                    }
                }
            })
            .detach();
            client
        });
        let cached = try_load_cached(kind);
        let is_cached = cached.is_some();
        let mut view = PixelView {
            kind: kind.to_string(),
            props,
            scene: cached.unwrap_or(Scene::Loading),
            frame: Frame::default(),
            focus: cx.focus_handle(),
            cache: SpriteCache::default(),
            last: Instant::now(),
            placed: Rc::new(Cell::new(None)),
            last_list: None,
            frames_seen: 0,
            taps: Vec::new(),
            unpainted_draws: 0,
            pending_phase: None,
            phone: None,
            sheet_request: None,
            sheet: None,
            command_pending: false,
            show_loading: false,
            _bridge: bridge_client,
        };
        if is_cached {
            view.on_scene_ready(cx);
        } else {
            let load_kind = kind.to_string();
            let task = cx.background_executor().spawn(async move { load(&load_kind) });
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(150)).await;
                let _ = this.update(cx, |v, cx| {
                    if matches!(v.scene, Scene::Loading) {
                        v.show_loading = true;
                        cx.notify();
                    }
                });
            })
            .detach();
            cx.spawn(async move |this, cx| {
                let scene = task.await;
                let _ = this.update(cx, |v, cx| {
                    v.scene = scene;
                    v.show_loading = false;
                    v.on_scene_ready(cx);
                    cx.notify();
                });
            })
            .detach();
        }
        view
    }

    fn on_scene_ready(&mut self, cx: &mut Context<Self>) {
        if let (Scene::Opening(o), Some((phase, progress))) = (&mut self.scene, self.pending_phase) {
            o.phase = phase;
            o.progress = progress;
        }
        if self.frames_seen > 0 {
            if let Scene::Opening(o) = &mut self.scene
                && !o.demo
                && o.phase == super::opening::Phase::Starting
            {
                o.phase = super::opening::Phase::Reading;
                o.progress = 40.0;
            }
            match &mut self.scene {
                Scene::Farm(f) => {
                    f.apply_frame(self.frame.clone());
                    f.phone.feed(&f.frame.inbox, Instant::now());
                }
                Scene::Map(m) => m.apply_frame(self.frame.clone()),
                _ => {}
            }
        }
        if let (Scene::Farm(f), Some(repo)) = (&mut self.scene, self.props["repo"].as_str()) {
            f.repo = Some(repo.to_string());
        }
        if matches!(self.scene, Scene::Farm(_) | Scene::Map(_)) {
            self.fetch_agents(cx);
        }
        if matches!(self.scene, Scene::Farm(_)) {
            self.fetch_runtimes(cx);
        }
        if matches!(self.scene, Scene::Map(_)) {
            self.fetch_repos(cx);
        }
        if matches!(self.scene, Scene::Tree(_)) {
            self.fetch_memories(cx);
        }
    }

    fn on_slice(&mut self, topic: &str, value: Value, cx: &mut Context<Self>) {
        if value.is_null() {
            return;
        }
        self.frames_seen += 1;
        if let Scene::Opening(o) = &mut self.scene
            && !o.demo
            && o.phase == super::opening::Phase::Starting
        {
            o.phase = super::opening::Phase::Reading;
            o.progress = 40.0;
        }
        match topic {
            "slice:farm" => {
                let Ok(farm) = serde_json::from_value::<FarmFrame>(value) else { return };
                self.frame.apply_farm(farm.clone());
                match &mut self.scene {
                    Scene::Farm(f) => f.apply_farm(farm),
                    Scene::Map(m) => m.apply_farm(farm),
                    _ => {}
                }
            }
            "slice:board" => {
                let Ok(board) = serde_json::from_value::<BoardSlice>(value) else { return };
                self.frame.apply_board(board.clone());
                match &mut self.scene {
                    Scene::Farm(f) => f.apply_board(board),
                    Scene::Map(m) => m.apply_board(board),
                    _ => {}
                }
            }
            "slice:sessions" => {
                let Ok(sessions) = serde_json::from_value::<SessionsSlice>(value) else {
                    return;
                };
                self.frame.apply_sessions(sessions.clone());
                match &mut self.scene {
                    Scene::Farm(f) => f.apply_sessions(sessions),
                    Scene::Map(m) => m.apply_sessions(sessions),
                    _ => {}
                }
            }
            "slice:inbox" => {
                let Ok(inbox) = serde_json::from_value::<InboxSlice>(value) else { return };
                self.frame.apply_inbox(inbox.clone());
                if let Scene::Farm(f) = &mut self.scene {
                    f.apply_inbox(inbox);
                    f.phone.feed(&f.frame.inbox, Instant::now());
                }
            }
            "slice:collab" => {
                let Ok(collab) = serde_json::from_value::<CollabSlice>(value) else { return };
                self.frame.apply_collab(collab.clone());
                if let Scene::Farm(f) = &mut self.scene {
                    f.apply_collab(collab);
                }
            }
            _ => return,
        }
        cx.notify();
    }

    /// `repo.list` from the server, off the UI thread.
    fn fetch_repos(&mut self, cx: &mut Context<Self>) {
        let server = cx.global::<BridgeHub>().0.server().clone();
        let task = cx.background_executor().spawn(async move { server.call("repo.list", json!({})) });
        cx.spawn(async move |this, cx| {
            let envelope = task.await;
            let _ = this.update(cx, |v, cx| {
                if let Scene::Map(m) = &mut v.scene {
                    let result = match envelope.error() {
                        Some(err) => Err(err.message),
                        None => serde_json::from_value::<Vec<RepoSummary>>(envelope.data.unwrap_or(Value::Null)).map_err(|err| err.to_string()),
                    };
                    match result {
                        Ok(repos) => m.set_repos(repos),
                        Err(error) => m.load_error = Some(error),
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// `agent.list` from the server so helpers wear their configured animal and outfit.
    fn fetch_agents(&mut self, cx: &mut Context<Self>) {
        let server = cx.global::<BridgeHub>().0.server().clone();
        let task = cx.background_executor().spawn(async move { server.call("agent.list", json!({})) });
        cx.spawn(async move |this, cx| {
            let envelope = task.await;
            let _ = this.update(cx, |v, cx| {
                let agents = match envelope.error() {
                    Some(e) => Err(e.message),
                    None => serde_json::from_value::<Vec<vibevalley_protocol::Agent>>(envelope.data.unwrap_or(Value::Null)).map_err(|err| err.to_string()),
                };
                match (&mut v.scene, agents) {
                    (Scene::Farm(f), Ok(agents)) => {
                        f.agent_looks = super::farm::scene::profile_looks(&agents);
                        f.profiles = agents;
                    }
                    (Scene::Farm(f), Err(error)) => f.show_toast(error),
                    (Scene::Map(m), Ok(agents)) => m.agent_looks = super::farm::scene::profile_looks(&agents),
                    (Scene::Map(m), Err(error)) => m.load_error = Some(error),
                    _ => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn fetch_runtimes(&mut self, cx: &mut Context<Self>) {
        let server = cx.global::<BridgeHub>().0.server().clone();
        let task = cx.background_executor().spawn(async move { server.call("runtime.list", json!({})) });
        cx.spawn(async move |this, cx| {
            let reply = task.await;
            let _ = this.update(cx, |v, cx| {
                if let Scene::Farm(f) = &mut v.scene
                    && let Some(data) = reply.data
                    && let Ok(runtimes) = serde_json::from_value::<Vec<vibevalley_protocol::RuntimeInfo>>(data)
                {
                    f.runtimes = runtimes
                        .into_iter()
                        .filter(|info| info.settings.enabled && matches!(info.installation, vibevalley_protocol::Installation::Available(_)))
                        .collect();
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// `memory.list` from the server so the memory tree reflects real stored memories when present.
    fn fetch_memories(&mut self, cx: &mut Context<Self>) {
        let server = cx.global::<BridgeHub>().0.server().clone();
        let task = cx.background_executor().spawn(async move { server.call("memory.list", json!({})) });
        cx.spawn(async move |this, cx| {
            let envelope = task.await;
            let _ = this.update(cx, |v, cx| {
                let data = serde_json::to_value(&envelope).ok().and_then(|e| e.get("data").cloned()).unwrap_or(Value::Null);
                let arr = data.get("memories").and_then(Value::as_array).or_else(|| data.as_array());
                if let (Scene::Tree(t), Some(items)) = (&mut v.scene, arr) {
                    let rows: Vec<_> = items
                        .iter()
                        .enumerate()
                        .filter_map(|(i, m)| {
                            let id = m["id"].as_str().map(String::from).unwrap_or_else(|| format!("m-{i}"));
                            let text = m["content"].as_str().or_else(|| m["text"].as_str())?.to_string();
                            let kind = match i % 10 {
                                0 => super::tree::Kind::Seed,
                                1 | 2 => super::tree::Kind::Fruit,
                                _ => super::tree::Kind::Leaf,
                            };
                            Some((id, kind, text))
                        })
                        .collect();
                    t.set_memories(rows);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn overlay(&mut self, name: &'static str, request: Value, window: &mut Window, cx: &mut Context<Self>) -> (Entity<HostedView>, Subscription) {
        let params = request.as_object().cloned().unwrap_or_default();
        let view = cx.new(|cx| HostedView::new(name, params, false, window, cx));
        let sub = cx.subscribe_in(&view, window, move |this, _, event: &HostedEvent, window, cx| match event {
            HostedEvent::Action(crate::hosted::Action::DismissFarmForm) => {
                if name == "farm-phone" {
                    if let Scene::Farm(f) = &mut this.scene {
                        f.phone.close();
                    }
                } else {
                    this.sheet = None;
                }
                window.focus(&this.focus, cx);
                cx.notify();
            }
            HostedEvent::Action(crate::hosted::Action::GlobalRoute { path }) => {
                this.sheet = None;
                cx.emit(PixelEvent::Route(path.clone()));
            }
            HostedEvent::Action(crate::hosted::Action::FarmHandset {
                unfolded,
                large,
                game,
                active_call,
            }) if name == "farm-phone" => {
                if let Scene::Farm(f) = &mut this.scene {
                    f.phone.unfolded = *unfolded;
                    f.phone.large = *large;
                    f.phone.game = *game;
                    f.phone.active_call = *active_call;
                }
                cx.notify();
            }
            HostedEvent::Action(crate::hosted::Action::SilenceFarmPhone) => {
                if let Scene::Farm(f) = &mut this.scene {
                    f.phone.silence();
                }
                cx.notify();
            }
            HostedEvent::Action(crate::hosted::Action::FarmCall { id, answered }) => {
                if let Scene::Farm(f) = &mut this.scene
                    && let Some(call) = f.frame.inbox.iter().find(|c| &c.id == id).cloned()
                {
                    f.phone.settle(call, *answered);
                }
                cx.notify();
            }
            HostedEvent::HostCall { op, reply } => cx.emit(PixelEvent::HostCall {
                op: op.clone(),
                reply: reply.clone(),
            }),
            _ => {}
        });
        (view, sub)
    }

    fn mount_sheet(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(request) = self.sheet_request.take() {
            self.sheet = Some(self.overlay("farm-form", request, window, cx));
        }
        let Scene::Farm(f) = &self.scene else { return };
        let calls = json!({"open":f.phone.open,"narrow":f.view_size.0-16.0<640.0, "ringing":f.phone.ringing, "missed":f.phone.missed(&f.frame.inbox).collect::<Vec<_>>(),"log":f.phone.log});
        if self.phone.is_none() && f.phone.open {
            self.phone = Some(self.overlay("farm-phone", json!({"calls":calls,"unfolded":f.phone.unfolded}), window, cx));
        }
        if let Some((view, _)) = &self.phone {
            view.update(cx, |v, cx| v.push("calls", calls, cx));
        }
    }

    fn hud_point(&self, at: Point<Pixels>) -> Option<(f32, f32)> {
        let (bounds, _) = self.placed.get()?;
        Some((f32::from(at.x - bounds.origin.x), f32::from(at.y - bounds.origin.y)))
    }

    fn tap_farm_hud(&mut self, x: f32, y: f32, cx: &mut Context<Self>) -> bool {
        let Scene::Farm(f) = &mut self.scene else { return false };
        let Some(action) = hud::hit(f, x, y) else { return false };
        match action {
            Action::Tool(tool) if f.tool != tool => cx.emit(PixelEvent::Sound("pick")),
            Action::Panel(_) | Action::Phone => cx.emit(PixelEvent::Sound("open")),
            Action::Close => cx.emit(PixelEvent::Sound("close")),
            _ => {}
        }
        self.taps.push(format!("{action:?}"));
        match action {
            Action::Route(route) => cx.emit(PixelEvent::Route(route)),
            Action::Tree => cx.emit(PixelEvent::Pixel {
                scene: "tree".into(),
                props: json!({}),
            }),
            Action::Panel(panel) => {
                f.panel = Some(panel);
                f.panel_page = 0;
                match panel {
                    Panel::Achievements => self.fetch_achievements(cx),
                    Panel::Quota => self.fetch_runtimes(cx),
                    Panel::Orchestrator | Panel::Friends => self.fetch_agents(cx),
                    _ => {}
                }
            }
            Action::Close => f.panel = None,
            Action::Page(by) => hud::page(f, by),
            Action::Phone => {
                if f.phone.open {
                    f.phone.close()
                } else {
                    f.phone.open = true;
                }
            }
            Action::Tool(tool) => f.tool = tool,
            Action::Clock(tod) => f.clock.set_time_of_day(tod),
            Action::Block => {}
        }
        cx.notify();
        true
    }

    fn art_point(&self, at: Point<Pixels>) -> Option<ArtPoint> {
        let (bounds, f) = self.placed.get()?;
        let x = (f32::from(at.x - bounds.origin.x) - f.bx.x) / f.scale;
        let y = (f32::from(at.y - bounds.origin.y) - f.bx.y) / f.scale;
        Some(pt(x, y))
    }

    pub fn point(&mut self, p: Option<ArtPoint>) {
        match &mut self.scene {
            Scene::Farm(f) => f.point(p),
            Scene::Map(m) => m.hover = p.and_then(|p| m.hit_at(p)),
            _ => {}
        }
    }

    /// A click at `p` (art pixels); `secondary` is a right click.
    pub fn tap(&mut self, p: ArtPoint, secondary: bool, cx: &mut Context<Self>) {
        if let Scene::Tree(t) = &mut self.scene {
            t.tap(p);
            self.taps.push(format!("{:?}", t.selected));
            cx.notify();
            return;
        }
        if let Scene::Map(m) = &self.scene {
            let hit = m.hit_at(p);
            self.taps.push(format!("{hit:?}"));
            match hit {
                Some(MapHit::Island(repo)) if secondary => {
                    if let Some(path) = m.repo_path(&repo) {
                        cx.emit(PixelEvent::Terminal { cwd: path.into(), title: repo });
                    }
                }
                Some(MapHit::Plot {
                    worktree: Some(cwd), agent, ..
                }) if secondary => cx.emit(PixelEvent::Terminal { cwd, title: agent }),
                Some(hit) if !secondary => cx.emit(PixelEvent::Route(hit.route())),
                _ => {}
            }
            return;
        }
        let Scene::Farm(f) = &mut self.scene else { return };
        let tap = f.tap(p);
        self.taps.push(format!("{tap:?}"));
        match tap {
            FarmTap::Plot { session: Some(id), issue, .. } if secondary => {
                let s = f.frame.sessions.iter().find(|s| s.id == id);
                let cwd = s.and_then(|s| s.cwd.clone()).or_else(|| self.props["cwd"].as_str().map(String::from));
                if let Some(cwd) = cwd {
                    cx.emit(PixelEvent::Terminal {
                        cwd,
                        title: issue
                            .as_ref()
                            .and_then(|id| f.frame.issues.iter().find(|i| &i.id == id))
                            .map(|i| format!("#{}", i.number))
                            .or(issue)
                            .unwrap_or(id),
                    });
                }
            }
            FarmTap::Plot {
                bed, session: Some(id), issue, ..
            } => {
                let action = issue
                    .as_ref()
                    .and_then(|id| f.frame.issues.iter().find(|i| &i.id == id))
                    .and_then(|i| f.tool.action(&i.stage))
                    .cloned();
                let requested = match (f.tool, &action) {
                    (FarmTool::Hand, _) => Some("inspect"),
                    (FarmTool::Harvest, Some(_)) => Some("harvest"),
                    (FarmTool::Water, Some(_)) => Some("water"),
                    _ => None,
                };
                if let Some(kind) = requested {
                    self.sheet_request = Some(json!({"kind": kind, "repo": f.repo, "station":bed, "session":id, "issue":issue}));
                    cx.notify();
                    return;
                }
                match (action, issue) {
                    (
                        Some(IssueAction::Move {
                            status,
                            words: ActWords::None | ActWords::Optional,
                            ..
                        }),
                        Some(issue),
                    ) => {
                        self.command("issue.status.update", json!({ "id": issue, "status": status }), bed, cx);
                    }
                    (Some(IssueAction::Stop { .. }), _) => self.command("session.stop", json!({ "id": id }), bed, cx),
                    _ => f.show_toast(f.tool.label()),
                }
            }
            FarmTap::Plot { bed, session: None, .. } if bed < 6 => {
                if f.tool == FarmTool::Hand {
                    self.sheet_request = Some(json!({"kind":"sow","station":bed,"repo":f.repo}));
                } else {
                    f.show_toast(f.tool.label());
                }
            }
            FarmTap::Spot { opens, .. } => match opens {
                "panel:graphs" | "panel:achievements" => {
                    f.panel = Some(Panel::Achievements);
                    f.panel_page = 0;
                    self.fetch_achievements(cx);
                }
                "panel:log" => {
                    f.panel = Some(Panel::Log);
                    f.panel_page = 0;
                }
                "panel:shop" => {
                    f.panel = Some(Panel::Shop);
                    f.panel_page = 0;
                }
                "panel:warehouse" => {
                    f.panel = Some(Panel::Warehouse);
                    f.panel_page = 0;
                }
                "chat" => {
                    f.phone.open = true;
                    f.phone.unfolded = true;
                    if let Some((phone, _)) = &self.phone {
                        phone.update(cx, |v, cx| v.push("unfold", json!(self.taps.len()), cx));
                    }
                }
                other => cx.emit(PixelEvent::Route(other.to_string())),
            },
            _ => {}
        }
        cx.notify();
    }

    fn command(&mut self, op: &'static str, payload: Value, bed: usize, cx: &mut Context<Self>) {
        if self.command_pending {
            return;
        }
        self.command_pending = true;
        if let Scene::Farm(f) = &mut self.scene {
            f.show_toast(t("web.farm.native.pending", &[]));
        }
        let server = cx.global::<BridgeHub>().0.server().clone();
        let task = cx.background_executor().spawn(async move { server.call(op, payload) });
        cx.spawn(async move |this, cx| {
            let reply = task.await;
            let _ = this.update(cx, |v, cx| {
                v.command_pending = false;
                if let Scene::Farm(f) = &mut v.scene {
                    match reply.error() {
                        Some(error) => f.show_toast(error.message),
                        None => {
                            f.show_toast(t("web.farm.native.accepted", &[]));
                            f.play_bed_fx(bed);
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn fetch_achievements(&mut self, cx: &mut Context<Self>) {
        let server = cx.global::<BridgeHub>().0.server().clone();
        let task = cx.background_executor().spawn(async move { server.call("game.achievement.list", json!({})) });
        cx.spawn(async move |this, cx| {
            let reply = task.await;
            let _ = this.update(cx, |v, cx| {
                if let Scene::Farm(f) = &mut v.scene {
                    match reply.error() {
                        Some(e) => f.show_toast(e.message),
                        None => match serde_json::from_value::<AchievementList>(reply.data.unwrap_or(Value::Null)) {
                            Ok(list) => f.achievements = list,
                            Err(e) => f.show_toast(e.to_string()),
                        },
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub fn set_phase(&mut self, phase: super::opening::Phase, progress: f32) {
        if let Scene::Opening(o) = &mut self.scene {
            o.phase = phase;
            o.progress = progress;
        }
        self.pending_phase = Some((phase, progress));
    }

    pub fn set_clock(&mut self, tod: Option<f32>, speed: Option<f32>) {
        let clock = match &mut self.scene {
            Scene::Farm(f) => &mut f.clock,
            Scene::Tree(t) => &mut t.clock,
            _ => return,
        };
        if let Some(t) = tod {
            clock.set_time_of_day(t);
        }
        if let Some(s) = speed {
            clock.set_speed(s);
        }
    }

    pub fn debug_state(&self) -> Value {
        let scene = match &self.scene {
            Scene::Loading => json!("loading"),
            Scene::Failed(e) => json!({ "failed": e }),
            Scene::Farm(f) => f.debug_state(),
            Scene::Map(m) => m.debug_state(),
            Scene::Tree(t) => t.debug_state(),
            Scene::Opening(o) => o.debug_state(),
        };
        let sampled_fireflies = scene.get("captureMotion").is_some_and(Value::is_object).then(|| {
            self.last_list
                .as_ref()
                .and_then(|list| list.farm_light.as_ref())
                .into_iter()
                .flat_map(|f| &f.lighting.lamps)
                .filter(|l| l.z == 4.0 && l.radius == 14.0)
                .map(|l| [l.x, l.y, l.intensity])
                .collect::<Vec<_>>()
        });
        json!({
            "kind": self.kind,
            "frames_seen": self.frames_seen,
            "scene": scene,
            "draw": self.last_list.as_deref().map(DrawList::census),
            "cached_pictures": self.cache.len(),
            "pictures_made_last_paint": self.cache.made,
            "last_paint_ms": self.cache.last_paint_ms,
            "placed": self.placed.get().map(|(b, f)| json!({
                "w": f32::from(b.size.width), "h": f32::from(b.size.height), "scale": f.scale,
            })),
            "sampledFireflies": sampled_fireflies,
            "taps": self.taps,
            "unpainted_draws": self.unpainted_draws,
        })
    }

    /// For the dump while the window does not paint (a locked screen): moves
    /// the scene on and draws the list as `render` would.
    pub fn draw_unpainted(&mut self) {
        if self.last.elapsed().as_secs_f32() > 0.5 {
            self.last_list = self.draw().map(Arc::new);
            self.unpainted_draws += 1;
        }
    }

    /// The last drawn list and its sprites, for a CPU raster.
    pub fn snapshot(&self) -> Option<(Arc<DrawList>, Option<Arc<Atlas>>)> {
        Some((self.last_list.clone()?, self.scene.atlas()))
    }

    fn draw(&mut self) -> Option<DrawList> {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last);
        let dt = elapsed.as_secs_f32();
        self.last = now;
        let scale = self.placed.get().map(|(_, f)| f.scale).unwrap_or(2.0);
        let aspect = self
            .placed
            .get()
            .map(|(b, _)| f32::from(b.size.width) / f32::from(b.size.height).max(1.0))
            .unwrap_or(1.5);
        let view = self
            .placed
            .get()
            .map(|(b, _)| (f32::from(b.size.width), f32::from(b.size.height)))
            .unwrap_or((768.0, 512.0));
        match &mut self.scene {
            Scene::Farm(f) => {
                f.view_size = view;
                f.tick(elapsed.as_secs_f64());
                Some(f.draw(scale))
            }
            Scene::Map(m) => {
                m.tick(dt);
                Some(m.draw(aspect))
            }
            Scene::Tree(t) => {
                t.view_size = view;
                t.tick(dt);
                Some(t.draw())
            }
            Scene::Opening(o) => {
                o.tick(dt);
                Some(o.draw())
            }
            _ => None,
        }
    }
}

fn try_load_cached(kind: &str) -> Option<Scene> {
    match kind {
        "farm" => super::try_cached_village().map(|(world, atlas)| Scene::Farm(Box::new(FarmScene::new(world, atlas)))),
        "map" => super::try_cached_atlas().map(|atlas| Scene::Map(Box::new(MapScene::new(atlas)))),
        "tree" => super::try_cached_atlas().map(|atlas| Scene::Tree(Box::new(TreeScene::new(atlas)))),
        _ => None,
    }
}

fn load(kind: &str) -> Scene {
    match kind {
        "farm" => match super::load_village() {
            Ok((world, atlas)) => Scene::Farm(Box::new(FarmScene::new(world, atlas))),
            Err(e) => Scene::Failed(e),
        },
        "map" => match super::load_atlas() {
            Ok(atlas) => Scene::Map(Box::new(MapScene::new(atlas))),
            Err(e) => Scene::Failed(e),
        },
        "tree" => match super::load_atlas() {
            Ok(atlas) => Scene::Tree(Box::new(TreeScene::new(atlas))),
            Err(e) => Scene::Failed(e),
        },
        "opening" => {
            let mut o = OpeningScene::load(None);
            o.demo = true;
            Scene::Opening(Box::new(o))
        }
        "opening:launch" => Scene::Opening(Box::new(OpeningScene::load(None))),
        other => Scene::Failed(format!("no pixel scene named {other}")),
    }
}

impl Render for PixelView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.mount_sheet(window, cx);
        let list = self.draw().map(Arc::new);
        if let Scene::Farm(f) = &mut self.scene {
            for cue in f.drain_sounds() {
                cx.emit(PixelEvent::Sound(cue));
            }
        }
        self.last_list = list.clone();
        let loading_overlay = matches!(self.scene, Scene::Loading) && self.show_loading;
        let failed_message = match &self.scene {
            Scene::Failed(e) => Some(e.clone()),
            _ => None,
        };
        let allow_animation = cx
            .try_global::<crate::theme::Ui>()
            .is_none_or(|ui| ui.settings.effective_motion() != crate::theme::MotionChoice::Off);
        if list.is_some() && self.scene.needs_animation() && allow_animation && window.is_window_active() {
            window.request_animation_frame();
        }
        let atlas = self.scene.atlas();
        let placed = self.placed.clone();
        let entity = cx.entity();
        let canvas_layer = div()
            .id("pixel")
            .track_focus(&self.focus)
            .size_full()
            .bg(gpui::rgb(0x1d2316))
            .on_key_down(cx.listener(|v, e: &KeyDownEvent, _, cx| {
                let Scene::Farm(f) = &mut v.scene else { return };
                match e.keystroke.key.as_str() {
                    "1" | "2" | "3" | "4" | "5" | "6" => {
                        let idx = (e.keystroke.key.as_bytes()[0] - b'1') as usize;
                        if let Some(tool) = FarmTool::from_index(idx) {
                            f.tool = tool;
                            cx.notify();
                        }
                    }
                    "p" => {
                        if f.phone.open {
                            f.phone.close()
                        } else {
                            f.phone.open = true;
                        }
                        cx.notify();
                    }
                    "escape" => {
                        if f.phone.open {
                            f.phone.close();
                        } else if f.panel.is_some() {
                            f.panel = None;
                        } else if f.tool == FarmTool::Hand {
                            f.panel = Some(Panel::Menu);
                            f.panel_page = 0;
                        } else {
                            f.tool = FarmTool::Hand;
                        }
                        cx.notify();
                    }
                    _ => {}
                }
            }))
            .on_modifiers_changed(cx.listener(|v, event: &gpui::ModifiersChangedEvent, _, cx| {
                if let Scene::Farm(f) = &mut v.scene
                    && f.reveal_names != event.modifiers.alt
                {
                    f.reveal_names = event.modifiers.alt;
                    cx.notify();
                }
            }))
            .on_mouse_move(cx.listener(|v, e: &MouseMoveEvent, _, cx| {
                if v.sheet.is_some() {
                    return;
                }
                let p = v.art_point(e.position);
                v.point(p);
                cx.notify();
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|v, e: &MouseDownEvent, window, cx| {
                    if v.sheet.is_some() {
                        return;
                    }
                    window.focus(&v.focus, cx);
                    if let Some((hx, hy)) = v.hud_point(e.position)
                        && v.tap_farm_hud(hx, hy, cx)
                    {
                        return;
                    }
                    if let Some(p) = v.art_point(e.position) {
                        if let Scene::Farm(f) = &mut v.scene {
                            f.press_at(p);
                            cx.notify();
                        } else {
                            v.tap(p, false, cx);
                        }
                    }
                }),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|v, e: &gpui::MouseUpEvent, _, cx| {
                    let p = v.art_point(e.position);
                    let hud = v.hud_point(e.position);
                    if let Scene::Farm(f) = &mut v.scene {
                        if v.sheet.is_some() || hud.is_some_and(|(x, y)| hud::hit(f, x, y).is_some()) {
                            f.clear_press();
                            return;
                        }
                        if let Some(p) = p
                            && f.release_at(p)
                        {
                            v.tap(p, false, cx);
                        }
                    }
                }),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|v, _, _, cx| {
                    if let Scene::Farm(f) = &mut v.scene {
                        f.clear_press();
                        cx.notify();
                    }
                }),
            )
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|v, e: &MouseDownEvent, _, cx| {
                    if v.sheet.is_some() {
                        return;
                    }
                    if let (Scene::Farm(f), Some((x, y))) = (&v.scene, v.hud_point(e.position))
                        && hud::hit(f, x, y).is_some()
                    {
                        return;
                    }
                    if let Some(p) = v.art_point(e.position) {
                        v.tap(p, true, cx);
                    }
                }),
            )
            .children(loading_overlay.then(pixel_loading_overlay))
            .children(failed_message.map(|m| div().p_4().text_color(gpui::rgb(0xfdf6e3)).child(m)))
            .children(list.map(|list| {
                canvas(
                    move |bounds, _, _| bounds,
                    move |bounds, _, window, cx| {
                        let f = framing(&list, bounds);
                        placed.set(Some((bounds, f)));
                        entity.update(cx, |v, cx| {
                            let mut cache = std::mem::take(&mut v.cache);
                            paint(&list, atlas.as_deref(), f, bounds, &mut cache, window, cx);
                            v.cache = cache;
                        });
                    },
                )
                .size_full()
            }));
        let sheet = self.sheet.as_ref().map(|(view, _)| view.clone());
        let phone = self.phone.as_ref().and_then(|(view, _)| {
            let Scene::Farm(f) = &self.scene else { return None };
            if !f.phone.open {
                return None;
            }
            let b = hud::Layout::new(f).phone;
            Some(div().absolute().left(px(b.x)).top(px(b.y)).w(px(b.w)).h(px(b.h)).child(view.clone()))
        });
        div().relative().size_full().child(canvas_layer).children(phone).children(sheet.map(|view| {
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .bg(gpui::rgba(0x2f1f134d))
                .child(div().w(px(540.0)).max_w_full().h(px(430.0)).max_h_full().child(view))
        }))
    }
}

/// Subtle sprout emblem + slim progress track shown only when cold asset
/// decoding exceeds 150ms.
fn pixel_loading_overlay() -> AnyElement {
    let leaf_hi = gpui::rgb(0x9ec867);
    let leaf_lo = gpui::rgb(0x6e9c3c);
    let stem = gpui::rgb(0x527a2d);
    let soil = gpui::rgb(0x5c4430);
    let sprout = div()
        .w(px(28.0))
        .h(px(24.0))
        .relative()
        .child(div().absolute().left(px(4.0)).top(px(4.0)).w(px(8.0)).h(px(5.0)).rounded(px(2.0)).bg(leaf_hi))
        .child(div().absolute().left(px(16.0)).top(px(2.0)).w(px(8.0)).h(px(5.0)).rounded(px(2.0)).bg(leaf_lo))
        .child(div().absolute().left(px(12.0)).top(px(7.0)).w(px(4.0)).h(px(11.0)).rounded(px(1.5)).bg(stem))
        .child(div().absolute().left(px(6.0)).top(px(18.0)).w(px(16.0)).h(px(4.0)).rounded(px(2.0)).bg(soil));
    div()
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(10.0))
        .child(sprout)
        .child(
            div()
                .w(px(120.0))
                .h(px(4.0))
                .rounded_full()
                .bg(gpui::rgba(0xfdf6e31f))
                .overflow_hidden()
                .child(div().w(px(52.0)).h_full().rounded_full().bg(leaf_hi)),
        )
        .child(
            div()
                .text_size(px(11.5))
                .text_color(gpui::rgba(0xfdf6e399))
                .child(t("web.farm.native.loading", &[])),
        )
        .into_any_element()
}

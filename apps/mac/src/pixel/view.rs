//! A pane showing one pixel scene, fed by the server's state frames.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;

use gpui_kit::{
    App, Bounds, Context, EventEmitter, FocusHandle, Focusable, InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton, MouseDownEvent,
    MouseMoveEvent, ParentElement as _, Pixels, Point, Render, Styled as _, Window, canvas, div,
};
use serde_json::{Value, json};

use super::atlas::Atlas;
use super::catalog::CatalogScene;
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
use crate::hosted::BridgeHub;
use vibevalley_i18n::t;
use vibevalley_protocol::{ActWords, IssueAction};

/// What a scene asks the shell for.
#[derive(Debug, Clone)]
pub enum PixelEvent {
    /// A VibeValley page (`/issues/<id>`, `/agents`…), hosted.
    Route(String),
    /// VibeValley's addition: a terminal in a session's worktree or a repo.
    Terminal { cwd: String, title: String },
    /// Another pixel scene (the map's island opens that repo's farm).
    Pixel { scene: String, props: Value },
}

pub enum Scene {
    Loading,
    Failed(String),
    Farm(Box<FarmScene>),
    Map(Box<MapScene>),
    Tree(Box<TreeScene>),
    Opening(Box<OpeningScene>),
    Catalog(Box<CatalogScene>),
}

impl Scene {
    fn atlas(&self) -> Option<Arc<Atlas>> {
        match self {
            Scene::Farm(f) => Some(f.atlas.clone()),
            Scene::Map(m) => Some(m.atlas.clone()),
            Scene::Tree(t) => Some(t.atlas.clone()),
            Scene::Catalog(c) => Some(c.atlas.clone()),
            _ => None,
        }
    }
}

type Placed = (Bounds<Pixels>, Framing);

pub struct PixelView {
    pub kind: String,
    props: Value,
    pub scene: Scene,
    frame: Value,
    focus: FocusHandle,
    cache: SpriteCache,
    last: Instant,
    /// Where the picture was last painted, for pointer hits.
    placed: Rc<Cell<Option<Placed>>>,
    pub last_list: Option<DrawList>,
    pub frames_seen: u64,
    pub taps: Vec<String>,
    pub unpainted_draws: u64,
    /// A phase set before the scene loaded.
    pending_phase: Option<(super::opening::Phase, f32)>,
    command_pending: bool,
}

impl EventEmitter<PixelEvent> for PixelView {}

impl Focusable for PixelView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl PixelView {
    pub fn new(kind: &str, props: Value, cx: &mut Context<Self>) -> PixelView {
        let server = cx.global::<BridgeHub>().0.server().clone();
        let rx = server.state();
        cx.spawn(async move |this, cx| {
            while let Ok(value) = rx.recv_async().await {
                if this.update(cx, |v, cx| v.on_frame(value, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
        let load_kind = kind.to_string();
        let task = cx.background_executor().spawn(async move { load(&load_kind) });
        cx.spawn(async move |this, cx| {
            let scene = task.await;
            let _ = this.update(cx, |v, cx| {
                v.scene = scene;
                if let (Scene::Opening(o), Some((phase, progress))) = (&mut v.scene, v.pending_phase) {
                    o.phase = phase;
                    o.progress = progress;
                }
                let frame = v.frame.clone();
                v.on_frame(frame, cx);
                if let (Scene::Farm(f), Some(repo)) = (&mut v.scene, v.props["repo"].as_str()) {
                    f.repo = Some(repo.to_string());
                }
                if matches!(v.scene, Scene::Farm(_)) {
                    v.fetch_agents(cx);
                }
                if matches!(v.scene, Scene::Map(_)) {
                    v.fetch_repos(cx);
                }
                if matches!(v.scene, Scene::Tree(_)) {
                    v.fetch_memories(cx);
                }
                cx.notify();
            });
        })
        .detach();
        PixelView {
            kind: kind.to_string(),
            props,
            scene: Scene::Loading,
            frame: Value::Null,
            focus: cx.focus_handle(),
            cache: SpriteCache::default(),
            last: Instant::now(),
            placed: Rc::new(Cell::new(None)),
            last_list: None,
            frames_seen: 0,
            taps: Vec::new(),
            unpainted_draws: 0,
            pending_phase: None,
            command_pending: false,
        }
    }

    fn on_frame(&mut self, value: Value, cx: &mut Context<Self>) {
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
        match &mut self.scene {
            Scene::Farm(f) => f.frame = Frame::parse(&value),
            Scene::Map(m) => m.frame = Frame::parse(&value),
            _ => {}
        }
        self.frame = value;
        cx.notify();
    }

    /// `repo.list` from the server, off the UI thread.
    fn fetch_repos(&mut self, cx: &mut Context<Self>) {
        let server = cx.global::<BridgeHub>().0.server().clone();
        let task = cx.background_executor().spawn(async move { server.call("repo.list", json!({})) });
        cx.spawn(async move |this, cx| {
            let envelope = task.await;
            let _ = this.update(cx, |v, cx| {
                let data = serde_json::to_value(&envelope).ok().and_then(|e| e.get("data").cloned()).unwrap_or(Value::Null);
                let list = data.get("repos").cloned().unwrap_or(data);
                if let Scene::Map(m) = &mut v.scene {
                    m.repos = serde_json::from_value::<Vec<RepoSummary>>(list).unwrap_or_default();
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
                if let Scene::Farm(f) = &mut v.scene {
                    match envelope.error() {
                        Some(e) => f.show_toast(e.message),
                        None => match serde_json::from_value::<Vec<vibevalley_protocol::Agent>>(envelope.data.unwrap_or(Value::Null)) {
                            Ok(agents) => {
                                f.agent_looks.clear();
                                for agent in agents {
                                    if let Some(species) = agent.look.species {
                                        let outfit = agent.look.outfit.map(|o| o.as_str()).unwrap_or("farmer");
                                        f.agent_looks.insert(agent.id, (species.as_str().into(), outfit.into()));
                                    }
                                }
                            }
                            Err(e) => f.show_toast(e.to_string()),
                        },
                    }
                }
                cx.notify();
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

    fn hud_point(&self, at: Point<Pixels>) -> Option<(f32, f32)> {
        let (bounds, _) = self.placed.get()?;
        Some((f32::from(at.x - bounds.origin.x), f32::from(at.y - bounds.origin.y)))
    }

    fn tap_farm_hud(&mut self, x: f32, y: f32, cx: &mut Context<Self>) -> bool {
        let Scene::Farm(f) = &mut self.scene else { return false };
        let Some(action) = hud::hit(f, x, y) else { return false };
        self.taps.push(format!("{action:?}"));
        match action {
            Action::Route(route) => cx.emit(PixelEvent::Route(route)),
            Action::Map => cx.emit(PixelEvent::Pixel {
                scene: "map".into(),
                props: json!({}),
            }),
            Action::Tree => cx.emit(PixelEvent::Pixel {
                scene: "tree".into(),
                props: json!({}),
            }),
            Action::Panel(panel) => {
                f.panel = Some(panel);
                f.panel_page = 0;
                self.fetch_agents(cx);
            }
            Action::Close => f.panel = None,
            Action::Page(by) => hud::page(f, by),
            Action::Phone => f.phone_open = !f.phone_open,
            Action::RestartSnake => f.snake = super::farm::snake::SnakeGame::new(),
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
        if let Scene::Catalog(c) = &mut self.scene {
            c.tap(p);
            self.taps.push(format!("{:?}", c.selected));
            cx.notify();
            return;
        }
        if let Scene::Map(m) = &self.scene {
            let hit = m.hit_at(p);
            self.taps.push(format!("{hit:?}"));
            let path_of = |repo: &str| m.repos.iter().find(|r| r.name == repo).map(|r| r.path.clone());
            match hit {
                Some(MapHit::Island(repo)) if secondary => {
                    if let Some(cwd) = path_of(&repo) {
                        cx.emit(PixelEvent::Terminal { cwd, title: repo });
                    }
                }
                Some(MapHit::Island(repo)) => cx.emit(PixelEvent::Pixel {
                    scene: "farm".into(),
                    props: json!({ "repo": repo }),
                }),
                Some(MapHit::Sow(repo)) => cx.emit(PixelEvent::Route(format!("/issues/new?repo={repo}"))),
                Some(MapHit::Plot { issue: Some(i), .. }) => cx.emit(PixelEvent::Route(format!("/issues/{i}"))),
                Some(MapHit::Plot { session, .. }) => cx.emit(PixelEvent::Route(format!("/sessions/{session}"))),
                None => {}
            }
            return;
        }
        let Scene::Farm(f) = &mut self.scene else { return };
        let tap = f.tap(p);
        self.taps.push(format!("{tap:?}"));
        match tap {
            FarmTap::Plot { session: Some(id), issue, .. } if secondary => {
                let s = f.frame.state.sessions.iter().find(|s| s.id == id);
                let cwd = s.and_then(|s| s.worktree.clone()).or_else(|| self.props["cwd"].as_str().map(String::from));
                if let Some(cwd) = cwd {
                    cx.emit(PixelEvent::Terminal {
                        cwd,
                        title: issue.unwrap_or(id),
                    });
                }
            }
            FarmTap::Plot {
                bed, session: Some(id), issue, ..
            } => {
                let route = issue.as_ref().map(|i| format!("/issues/{i}")).unwrap_or_else(|| format!("/sessions/{id}"));
                let action = issue
                    .as_ref()
                    .and_then(|id| f.frame.state.issues.iter().find(|i| &i.id == id))
                    .and_then(|i| i.stage.as_ref())
                    .and_then(|stage| f.tool.action(stage))
                    .cloned();
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
                    _ => cx.emit(PixelEvent::Route(route)),
                }
            }
            FarmTap::Plot { bed, session: None, .. } if bed < 6 => {
                let route = match f.repo.as_deref().filter(|r| !r.is_empty()) {
                    Some(repo) => format!("/issues/new?repo={repo}"),
                    None => "/issues/new".to_string(),
                };
                cx.emit(PixelEvent::Route(route));
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
                    f.panel = Some(Panel::Chat);
                    f.panel_page = 0;
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
                            f.play_bed_fx(bed, 0x9be564);
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
                        None => match serde_json::from_value(reply.data.unwrap_or(Value::Null)) {
                            Ok(items) => f.achievements = items,
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
            Scene::Catalog(c) => c.debug_state(),
        };
        json!({
            "kind": self.kind,
            "frames_seen": self.frames_seen,
            "scene": scene,
            "draw": self.last_list.as_ref().map(DrawList::census),
            "cached_pictures": self.cache.len(),
            "pictures_made_last_paint": self.cache.made,
            "last_paint_ms": self.cache.last_paint_ms,
            "placed": self.placed.get().map(|(b, f)| json!({
                "w": f32::from(b.size.width), "h": f32::from(b.size.height), "scale": f.scale,
            })),
            "taps": self.taps,
            "unpainted_draws": self.unpainted_draws,
        })
    }

    /// For the dump while the window does not paint (a locked screen): moves
    /// the scene on and draws the list as `render` would.
    pub fn draw_unpainted(&mut self) {
        if self.last.elapsed().as_secs_f32() > 0.5 {
            self.last_list = self.draw();
            self.unpainted_draws += 1;
        }
    }

    /// The last drawn list and its sprites, for a CPU raster.
    pub fn snapshot(&self) -> Option<(DrawList, Option<Arc<Atlas>>)> {
        Some((self.last_list.clone()?, self.scene.atlas()))
    }

    fn draw(&mut self) -> Option<DrawList> {
        let now = Instant::now();
        let dt = now.duration_since(self.last).as_secs_f32();
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
                f.tick(dt);
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
            Scene::Catalog(c) => Some(c.draw()),
            _ => None,
        }
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
        "catalog" => match super::load_atlas() {
            Ok(atlas) => Scene::Catalog(Box::new(CatalogScene::new(atlas))),
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
        let list = self.draw();
        self.last_list = list.clone();
        let message = match &self.scene {
            Scene::Loading => Some(t("web.farm.native.loading", &[])),
            Scene::Failed(e) => Some(e.clone()),
            _ => None,
        };
        if list.is_some() {
            window.request_animation_frame();
        }
        let atlas = self.scene.atlas();
        let placed = self.placed.clone();
        let entity = cx.entity();
        div()
            .id("pixel")
            .track_focus(&self.focus)
            .size_full()
            .bg(gpui_kit::rgb(0x1d2316))
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
                        f.phone_open = !f.phone_open;
                        cx.notify();
                    }
                    "up" | "w" if f.phone_open => {
                        f.snake.steer(0, -1);
                        cx.notify();
                    }
                    "down" | "s" if f.phone_open => {
                        f.snake.steer(0, 1);
                        cx.notify();
                    }
                    "left" | "a" if f.phone_open => {
                        f.snake.steer(-1, 0);
                        cx.notify();
                    }
                    "right" | "d" if f.phone_open => {
                        f.snake.steer(1, 0);
                        cx.notify();
                    }
                    "space" | "enter" if f.phone_open && f.snake.over => {
                        f.snake = super::farm::snake::SnakeGame::new();
                        cx.notify();
                    }
                    "escape" => {
                        if f.phone_open {
                            f.phone_open = false;
                        } else if f.panel.is_some() {
                            f.panel = None;
                        } else {
                            f.tool = FarmTool::Hand;
                        }
                        cx.notify();
                    }
                    _ => {}
                }
            }))
            .on_mouse_move(cx.listener(|v, e: &MouseMoveEvent, _, cx| {
                let p = v.art_point(e.position);
                v.point(p);
                cx.notify();
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|v, e: &MouseDownEvent, window, cx| {
                    window.focus(&v.focus, cx);
                    if let Some((hx, hy)) = v.hud_point(e.position)
                        && v.tap_farm_hud(hx, hy, cx)
                    {
                        return;
                    }
                    if let Some(p) = v.art_point(e.position) {
                        v.tap(p, false, cx);
                    }
                }),
            )
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|v, e: &MouseDownEvent, _, cx| {
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
            .children(message.map(|m| div().p_4().text_color(gpui_kit::rgb(0xfdf6e3)).child(m)))
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
            }))
    }
}

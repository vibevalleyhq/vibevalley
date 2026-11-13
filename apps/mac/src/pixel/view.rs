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
use super::farm::islands::{MapHit, MapScene, RepoSummary};
use super::farm::scene::{FarmScene, FarmTap, FarmTool};
use super::level::{Point as ArtPoint, pt};
use super::opening::OpeningScene;
use super::sky::Framing;
use super::tree::TreeScene;
use crate::hosted::BridgeHub;

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
                let data = serde_json::to_value(&envelope).ok().and_then(|e| e.get("data").cloned()).unwrap_or(Value::Null);
                if let (Scene::Farm(f), Some(arr)) = (&mut v.scene, data.as_array()) {
                    for item in arr {
                        let Some(id) = item["id"].as_str() else { continue };
                        let species = item["look"]["species"].as_str().unwrap_or("bear");
                        let outfit = item["look"]["outfit"].as_str().unwrap_or("farmer");
                        f.agent_looks.insert(id.to_string(), (species.to_string(), outfit.to_string()));
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

    fn hud_point(&self, at: Point<Pixels>) -> Option<(f32, f32, f32, f32)> {
        let (bounds, f) = self.placed.get()?;
        let hx = f32::from(at.x - bounds.origin.x) - f.bx.x;
        let hy = f32::from(at.y - bounds.origin.y) - f.bx.y;
        Some((hx, hy, f.bx.w, f.bx.h))
    }

    fn tap_farm_hud(&mut self, hx: f32, hy: f32, view_w: f32, view_h: f32, cx: &mut Context<Self>) -> bool {
        let Scene::Farm(f) = &mut self.scene else { return false };
        // Top HUD navigation cards
        let top_buttons: [(&str, f32, f32); 6] = [
            ("workbench", 216.0, 76.0),
            ("map", 298.0, 76.0),
            ("tree", 380.0, 76.0),
            ("chat", 462.0, 64.0),
            ("ledger", 532.0, 64.0),
            ("phone", 602.0, 64.0),
        ];
        if (12.0..=46.0).contains(&hy) {
            for (action, bx, bw) in top_buttons {
                if hx >= bx && hx <= bx + bw {
                    match action {
                        "workbench" => cx.emit(PixelEvent::Route("/issues".into())),
                        "map" => cx.emit(PixelEvent::Pixel {
                            scene: "map".into(),
                            props: json!({}),
                        }),
                        "tree" => cx.emit(PixelEvent::Route("/tree".into())),
                        "chat" => cx.emit(PixelEvent::Route("/chat".into())),
                        "ledger" => f.panel_open = !f.panel_open,
                        "phone" => f.phone_open = !f.phone_open,
                        _ => {}
                    }
                    cx.notify();
                    return true;
                }
            }
        }
        if f.phone_open {
            let pw = 216.0;
            let ph = 224.0;
            let px = 12.0;
            let py = (view_h - ph - 12.0).max(80.0);
            if hx >= px && hx <= px + pw && hy >= py && hy <= py + ph {
                if hy <= py + 24.0 && hx >= px + pw - 28.0 {
                    f.phone_open = false;
                } else if f.snake.over {
                    f.snake = super::farm::scene::SnakeGame::new();
                }
                cx.notify();
                return true;
            }
        }
        // Bottom 6-slot Tool Hotbar
        let slot_w = 48.0;
        let slot_h = 38.0;
        let slot_gap = 4.0;
        let total_w = 6.0 * slot_w + 5.0 * slot_gap;
        let start_x = (view_w - total_w) / 2.0;
        let bar_y = (view_h - slot_h - 12.0).max(60.0);
        if hy >= bar_y && hy <= bar_y + slot_h && hx >= start_x && hx <= start_x + total_w {
            let idx = ((hx - start_x) / (slot_w + slot_gap)).floor() as usize;
            if let Some(tool) = FarmTool::from_index(idx) {
                f.tool = tool;
                cx.notify();
                return true;
            }
        }
        // Ledger / Clock modal overlay
        if f.panel_open {
            let pw = 280.0;
            let ph = 166.0;
            let px = (view_w - pw) / 2.0;
            let py = ((view_h - ph) / 2.0).max(64.0);
            if hx >= px && hx <= px + pw && hy >= py && hy <= py + ph {
                if hy <= py + 32.0 && hx >= px + pw - 32.0 {
                    f.panel_open = false;
                    cx.notify();
                    return true;
                }
                for (idx, tod) in [0.30f32, 0.50, 0.76, 0.92].iter().enumerate() {
                    let bx = px + 14.0 + idx as f32 * 64.0;
                    let by = py + 126.0;
                    if hx >= bx && hx <= bx + 56.0 && hy >= by && hy <= by + 24.0 {
                        f.clock.set_time_of_day(*tod);
                        cx.notify();
                        return true;
                    }
                }
                return true;
            }
        }
        false
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
                let tool = f.tool;
                match tool {
                    FarmTool::Weed => {
                        f.play_bed_fx(bed, 0x9be564);
                        f.show_toast("已清理田间杂草");
                    }
                    FarmTool::Water => {
                        f.play_bed_fx(bed, 0x5bc0eb);
                        cx.emit(PixelEvent::Route(match issue {
                            Some(i) => format!("/issues/{i}"),
                            None => format!("/sessions/{id}"),
                        }));
                    }
                    FarmTool::Harvest => {
                        f.play_bed_fx(bed, 0xffd166);
                        cx.emit(PixelEvent::Route(match issue {
                            Some(i) => format!("/issues/{i}"),
                            None => format!("/sessions/{id}"),
                        }));
                    }
                    FarmTool::Shovel => {
                        f.play_bed_fx(bed, 0x8d5b4c);
                        cx.emit(PixelEvent::Route(match issue {
                            Some(i) => format!("/issues/{i}"),
                            None => format!("/sessions/{id}"),
                        }));
                    }
                    FarmTool::Bug => {
                        f.play_bed_fx(bed, 0x9be564);
                        if let Some(issue_id) = issue.clone() {
                            let server = cx.global::<BridgeHub>().0.server().clone();
                            cx.background_executor()
                                .spawn(async move {
                                    let _ = server.call("issue.status.update", json!({ "id": issue_id, "status": "working" }));
                                })
                                .detach();
                            f.show_toast("已除虫并重新唤醒帮工");
                        } else {
                            cx.emit(PixelEvent::Route(format!("/sessions/{id}")));
                        }
                    }
                    _ => {
                        cx.emit(PixelEvent::Route(match issue {
                            Some(i) => format!("/issues/{i}"),
                            None => format!("/sessions/{id}"),
                        }));
                    }
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
                "panel:achievements" | "panel:log" | "panel:shop" | "panel:warehouse" => {
                    f.panel_open = !f.panel_open;
                }
                "chat" => cx.emit(PixelEvent::Route("/chat".into())),
                other => cx.emit(PixelEvent::Route(other.to_string())),
            },
            _ => {}
        }
        cx.notify();
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
        match &mut self.scene {
            Scene::Farm(f) => {
                f.tick(dt);
                Some(f.draw(scale))
            }
            Scene::Map(m) => {
                m.tick(dt);
                Some(m.draw(aspect))
            }
            Scene::Tree(t) => {
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
            Scene::Loading => Some("载入中…".to_string()),
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
                        f.snake = super::farm::scene::SnakeGame::new();
                        cx.notify();
                    }
                    "escape" => {
                        if f.phone_open {
                            f.phone_open = false;
                        } else if f.panel_open {
                            f.panel_open = false;
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
                    if let Some((hx, hy, vw, vh)) = v.hud_point(e.position)
                        && v.tap_farm_hud(hx, hy, vw, vh, cx)
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

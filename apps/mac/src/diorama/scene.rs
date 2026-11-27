//! Cross-platform 3D papercraft Jiangnan diorama scene backed by `vibevalley-diorama`
//! (`wgpu` + WGSL) and painted into GPUI via a double-buffered off-thread frame mailbox.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use vibevalley_diorama::pick::pick;
use vibevalley_diorama::world::is_cutaway_building;
use vibevalley_diorama::{
    AssetBundle, DecorationSync, DioramaHit, DioramaWorld, DofMode, HelperTaskSync, MetalRenderer, PlotStage, PlotTicketSync, RenderQuality, RenderSceneInput,
    ScreenAnchor, TimeOfDay, YardSnapshotSync, prepare_scene_input,
};
use vibevalley_protocol::{
    Agent, BoardSlice, CallState, CollabSlice, Crop, FarmFrame, GameEffect, InboxSlice, Issue, IssueStage, IssueStageKind, SessionView, SessionsSlice,
    StuckReason,
};

use super::frame::{Frame, SessionExt};
use super::phone::Phone;

const IDLE_PACE_MS: u64 = 66;
const ACTIVE_PACE_MS: u64 = 16;
const CAMERA_SETTLE: Duration = Duration::from_millis(300);
const ACTIVE_WINDOW: Duration = Duration::from_secs(2);
const ANCHOR_SYNC_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bed {
    pub index: usize,
    pub unlock_level: Option<u32>,
}

pub const BEDS: [Bed; 9] = [
    Bed { index: 0, unlock_level: None },
    Bed { index: 1, unlock_level: None },
    Bed { index: 2, unlock_level: None },
    Bed { index: 3, unlock_level: None },
    Bed { index: 4, unlock_level: None },
    Bed { index: 5, unlock_level: None },
    Bed {
        index: 6,
        unlock_level: Some(5),
    },
    Bed {
        index: 7,
        unlock_level: Some(8),
    },
    Bed {
        index: 8,
        unlock_level: Some(12),
    },
];

pub fn place_of_action(action: &str) -> &'static str {
    match action {
        "read_file" | "search" => "library",
        "run_command" | "mcp" => "workshop",
        "web" => "mast",
        "wait" => "bench",
        _ => "plot",
    }
}

/// Returned RGBA frame buffer that returns its backing allocation to the worker's 3-slot pool on drop.
pub struct PooledFrameBuf {
    data: Option<Vec<u8>>,
    pool: Arc<Mutex<Vec<Vec<u8>>>>,
    expected_bytes: Arc<AtomicUsize>,
}

impl PooledFrameBuf {
    pub fn bytes(&self) -> &[u8] {
        self.data.as_deref().unwrap_or(&[])
    }
}

impl Drop for PooledFrameBuf {
    fn drop(&mut self) {
        if let Some(buf) = self.data.take() {
            let needed = self.expected_bytes.load(Ordering::Relaxed);
            if buf.capacity() >= needed
                && (needed == 0 || buf.capacity() <= needed.saturating_mul(2))
                && let Ok(mut guard) = self.pool.lock()
                && guard.len() < 3
            {
                guard.push(buf);
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct TelemetrySnapshot {
    pub gpu_ms: f32,
    pub readback_ms: f32,
    pub draw_calls: u32,
    pub shadow_cached: bool,
    pub width: u32,
    pub height: u32,
}

pub struct RenderedFrame {
    pub width: u32,
    pub height: u32,
    pub bgra: PooledFrameBuf,
    pub telemetry: TelemetrySnapshot,
}

struct RenderRequest {
    scene_input: RenderSceneInput,
    width: u32,
    height: u32,
    quality: RenderQuality,
}

struct RenderWorker {
    renderer: Arc<Mutex<MetalRenderer>>,
    completed: Arc<Mutex<Option<RenderedFrame>>>,
    buf_pool: Arc<Mutex<Vec<Vec<u8>>>>,
    expected_bytes: Arc<AtomicUsize>,
    busy: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
}

impl RenderWorker {
    async fn init(full_bundle: AssetBundle) -> Result<Self, String> {
        let renderer = MetalRenderer::new(&full_bundle).await?;
        // Free ~19 MB of CPU mesh/texture copies right after GPU upload completes.
        drop(full_bundle);
        Ok(Self {
            renderer: Arc::new(Mutex::new(renderer)),
            completed: Arc::new(Mutex::new(None)),
            buf_pool: Arc::new(Mutex::new(Vec::with_capacity(3))),
            expected_bytes: Arc::new(AtomicUsize::new(0)),
            busy: Arc::new(AtomicBool::new(false)),
            alive: Arc::new(AtomicBool::new(true)),
        })
    }

    fn submit(&self, req: RenderRequest) -> bool {
        if self.busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
            return false;
        }
        let renderer = self.renderer.clone();
        let completed = self.completed.clone();
        let buf_pool = self.buf_pool.clone();
        let expected_bytes = self.expected_bytes.clone();
        let busy = self.busy.clone();
        let alive = self.alive.clone();
        vibevalley_runtime::rt::current_or_global_handle().spawn_blocking(move || {
            struct BusyReset(Arc<AtomicBool>);
            impl Drop for BusyReset {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::Release);
                }
            }
            let _guard = BusyReset(busy);
            if !alive.load(Ordering::Acquire) {
                return;
            }
            let needed_bytes = (req.width as usize) * (req.height as usize) * 4;
            expected_bytes.store(needed_bytes, Ordering::Relaxed);
            let reuse_buf = buf_pool
                .lock()
                .ok()
                .and_then(|mut pool| {
                    while let Some(buf) = pool.pop() {
                        if buf.capacity() >= needed_bytes && buf.capacity() <= needed_bytes.saturating_mul(2) {
                            return Some(buf);
                        }
                    }
                    None
                })
                .unwrap_or_default();
            let Ok(mut guard) = renderer.lock() else { return };
            if !alive.load(Ordering::Acquire) {
                return;
            }
            if let Ok((stats, bgra)) = guard.render_bgra_with_buf(&req.scene_input, req.width, req.height, req.quality, reuse_buf)
                && let Ok(mut out) = completed.lock()
            {
                *out = Some(RenderedFrame {
                    width: req.width,
                    height: req.height,
                    bgra: PooledFrameBuf {
                        data: Some(bgra),
                        pool: buf_pool,
                        expected_bytes,
                    },
                    telemetry: TelemetrySnapshot {
                        gpu_ms: stats.gpu_ms,
                        readback_ms: stats.readback_ms,
                        draw_calls: stats.draw_calls,
                        shadow_cached: stats.static_shadow_cached,
                        width: req.width,
                        height: req.height,
                    },
                });
            }
        });
        true
    }
}

impl Drop for RenderWorker {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum DioramaAction {
    OpenForm(Value),
    Route(String),
    OpenTerminal { cwd: String, title: String },
    OpenPhone,
    FocusedBuilding,
    None,
}

pub struct DioramaScene {
    pub bundle: Arc<AssetBundle>,
    pub world: DioramaWorld,
    pub frame: Frame,
    pub profiles: Vec<Agent>,
    pub repo: Option<String>,
    pub phone: Phone,
    pub manual_tod: Option<TimeOfDay>,
    pub hovered: Option<DioramaHit>,
    pub anchors: Vec<ScreenAnchor>,
    pub toast: Option<(String, Instant)>,
    pub view_size: (f32, f32),
    pub last_telemetry: TelemetrySnapshot,
    frame_gen: u64,
    latest_frame: Option<RenderedFrame>,
    last_tick: Instant,
    last_activity: Instant,
    last_camera_motion: Instant,
    last_submit: Instant,
    last_anchors_at: Instant,
    heard_farm: Option<u64>,
    heard_board: Option<u64>,
    heard_sessions: Option<u64>,
    heard_inbox: Option<u64>,
    sounds: Vec<&'static str>,
    worker: Option<RenderWorker>,
}

impl DioramaScene {
    pub async fn load_async(dist_dir: &Path) -> Result<Self, String> {
        let full_bundle = AssetBundle::load(dist_dir)?;
        let meta_bundle = Arc::new(full_bundle.metadata_only());
        let mut world = DioramaWorld::new(&meta_bundle);
        world.set_show_routes(true);
        world.set_time_of_day(wall_clock_time_of_day(), true);
        let worker = RenderWorker::init(full_bundle).await?;
        let now = Instant::now();
        let mut scene = Self {
            bundle: meta_bundle,
            world,
            frame: Frame::default(),
            profiles: Vec::new(),
            repo: None,
            phone: Phone::default(),
            manual_tod: None,
            hovered: None,
            anchors: Vec::new(),
            toast: None,
            view_size: (960.0, 640.0),
            last_telemetry: TelemetrySnapshot::default(),
            frame_gen: 0,
            latest_frame: None,
            last_tick: now,
            last_activity: now,
            last_camera_motion: now,
            last_submit: now.checked_sub(Duration::from_millis(100)).unwrap_or(now),
            last_anchors_at: now.checked_sub(ANCHOR_SYNC_INTERVAL).unwrap_or(now),
            heard_farm: None,
            heard_board: None,
            heard_sessions: None,
            heard_inbox: None,
            sounds: Vec::new(),
            worker: Some(worker),
        };
        scene.sync_from_frame();
        scene.refresh_anchors(true);
        Ok(scene)
    }

    #[cfg(test)]
    pub fn new_for_test(repo: Option<String>) -> Self {
        let dist = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../assets/diorama"));
        let full = AssetBundle::load(dist).expect("repo diorama assets");
        let meta = Arc::new(full.metadata_only());
        let world = DioramaWorld::new(&meta);
        let now = Instant::now();
        Self {
            bundle: meta,
            world,
            frame: Frame::default(),
            profiles: Vec::new(),
            repo,
            phone: Phone::default(),
            manual_tod: None,
            hovered: None,
            anchors: Vec::new(),
            toast: None,
            view_size: (960.0, 640.0),
            last_telemetry: TelemetrySnapshot::default(),
            frame_gen: 0,
            latest_frame: None,
            last_tick: now,
            last_activity: now,
            last_camera_motion: now,
            last_submit: now,
            last_anchors_at: now,
            heard_farm: None,
            heard_board: None,
            heard_sessions: None,
            heard_inbox: None,
            sounds: Vec::new(),
            worker: None,
        }
    }

    pub fn touch(&mut self) {
        self.last_activity = Instant::now();
    }

    pub fn drain_sounds(&mut self) -> impl Iterator<Item = &'static str> + '_ {
        self.sounds.drain(..)
    }

    pub fn show_toast(&mut self, msg: impl Into<String>) {
        self.toast = Some((msg.into(), Instant::now() + Duration::from_secs(3)));
    }

    pub fn active_toast(&mut self) -> Option<&str> {
        if let Some((_, until)) = &self.toast
            && Instant::now() >= *until
        {
            self.toast = None;
        }
        self.toast.as_ref().map(|(m, _)| m.as_str())
    }

    pub fn set_time_of_day(&mut self, tod: TimeOfDay, snap: bool) {
        self.manual_tod = Some(tod);
        self.world.set_time_of_day(tod, snap);
        self.touch();
    }

    pub fn reset_camera(&mut self) {
        self.world.camera.clear_focus();
        self.world.camera.set_preset(vibevalley_diorama::CameraPreset::Overview, false);
        self.world.camera.reset_offsets();
        self.world.set_roof_cutaway(false);
        self.touch();
        self.refresh_anchors(true);
    }

    pub fn toggle_cutaway(&mut self) -> bool {
        let open = self.world.toggle_roof_cutaway();
        self.sounds.push(if open { "open" } else { "close" });
        self.touch();
        self.refresh_anchors(true);
        open
    }

    pub fn exit_focus(&mut self) -> bool {
        if self.world.focused_building.is_none() && !self.world.camera.is_focused() {
            return false;
        }
        self.world.focused_building = None;
        self.world.camera.clear_focus();
        self.world.set_roof_cutaway(false);
        self.sounds.push("close");
        self.touch();
        self.refresh_anchors(true);
        true
    }

    pub fn apply_frame(&mut self, frame: Frame) {
        self.diff_farm_sounds(frame.seq, &frame.effects);
        self.diff_board_sounds(frame.seq, &frame.issues);
        self.diff_session_sounds(frame.seq, &frame.sessions);
        self.diff_inbox_sounds(frame.seq, frame.call);
        self.frame = frame;
        self.sync_from_frame();
        self.touch();
    }

    pub fn apply_farm(&mut self, farm: FarmFrame) {
        self.diff_farm_sounds(farm.seq.max(0) as u64, &farm.effects);
        self.frame.apply_farm(farm);
        self.sync_from_frame();
        self.touch();
    }

    pub fn apply_board(&mut self, board: BoardSlice) {
        self.diff_board_sounds(board.seq.max(0) as u64, &board.issues);
        self.frame.apply_board(board);
        self.sync_from_frame();
        self.touch();
    }

    pub fn apply_sessions(&mut self, sessions: SessionsSlice) {
        self.diff_session_sounds(sessions.seq.max(0) as u64, &sessions.sessions);
        self.frame.apply_sessions(sessions);
        self.sync_from_frame();
        self.touch();
    }

    pub fn apply_inbox(&mut self, inbox: InboxSlice) {
        self.diff_inbox_sounds(inbox.seq.max(0) as u64, inbox.call);
        self.frame.apply_inbox(inbox);
    }

    pub fn apply_collab(&mut self, collab: CollabSlice) {
        self.frame.apply_collab(collab);
    }

    pub fn set_profiles(&mut self, agents: Vec<Agent>) {
        self.profiles = agents;
        self.sync_from_frame();
        self.touch();
    }

    fn diff_farm_sounds(&mut self, seq: u64, effects: &[GameEffect]) {
        if self.heard_farm != Some(seq) {
            for effect in effects {
                match effect {
                    GameEffect::Reward(_) => self.sounds.push("coin"),
                    GameEffect::LevelUp(_) => self.sounds.push("levelUp"),
                    GameEffect::Achievement(_) => self.sounds.push("achievement"),
                    GameEffect::Penalty(_) => {}
                }
            }
            self.heard_farm = Some(seq);
        }
    }

    fn diff_board_sounds(&mut self, seq: u64, issues: &[Issue]) {
        if self.heard_board != Some(seq) {
            if self.heard_board.is_some() {
                for issue in issues {
                    let Some(was) = self.frame.issues.iter().find(|i| i.id == issue.id).map(|i| &i.stage) else {
                        continue;
                    };
                    let now = &issue.stage;
                    if now.state == IssueStageKind::Reviewing && was.state != now.state {
                        self.sounds.push("ripe");
                    }
                    if now.state == IssueStageKind::Stuck
                        && matches!(now.stuck, Some(StuckReason::Failed | StuckReason::Conflict))
                        && (was.state != now.state || was.stuck != now.stuck)
                    {
                        self.sounds.push("bug");
                    }
                }
            }
            self.heard_board = Some(seq);
        }
    }

    fn diff_session_sounds(&mut self, seq: u64, sessions: &[SessionView]) {
        if self.heard_sessions != Some(seq) {
            if self.heard_sessions.is_some() {
                for session in sessions {
                    if !self.frame.sessions.iter().any(|s| s.id == session.id) {
                        self.sounds.push("arrive");
                    }
                }
            }
            self.heard_sessions = Some(seq);
        }
    }

    fn diff_inbox_sounds(&mut self, seq: u64, call: CallState) {
        if self.heard_inbox != Some(seq) {
            if self.heard_inbox.is_some() && self.frame.call != call {
                if call == CallState::Live {
                    self.sounds.push("voiceOn");
                } else if call == CallState::Idle && matches!(self.frame.call, CallState::Live | CallState::Ending) {
                    self.sounds.push("voiceOff");
                }
            }
            self.heard_inbox = Some(seq);
        }
    }

    fn session_at_bed(&self, bed_index: usize) -> Option<&SessionView> {
        self.frame
            .sessions
            .iter()
            .find(|s| s.is_worker() && self.repo.as_deref().is_none_or(|repo| s.repo_name() == Some(repo)) && self.frame.station_of(s) == bed_index as i32)
    }

    pub fn sync_from_frame(&mut self) {
        let level = self.frame.view.level.level;
        let mut plots = Vec::with_capacity(BEDS.len());
        for bed in BEDS {
            if let Some(unlock) = bed.unlock_level {
                let locked = level < i64::from(unlock);
                plots.push(PlotTicketSync {
                    index: bed.index,
                    stage: PlotStage::Empty,
                    title: if locked { format!("Lv.{unlock} 解锁") } else { "空闲花坛".into() },
                    locked: Some(locked),
                });
                continue;
            }

            if let Some(session) = self.session_at_bed(bed.index) {
                let crop = self.frame.plot_of(session).map(|p| p.crop);
                let issue = session.issue_id().and_then(|id| self.frame.issues.iter().find(|i| i.id == id));
                let stage = issue
                    .map(|i| map_issue_to_plot_stage(&i.stage, crop))
                    .unwrap_or_else(|| map_crop_fallback(crop));
                let title = issue.map(|i| format!("#{} {}", i.number, i.title)).unwrap_or_else(|| session.name.clone());
                plots.push(PlotTicketSync {
                    index: bed.index,
                    stage,
                    title,
                    locked: Some(false),
                });
            } else {
                plots.push(PlotTicketSync {
                    index: bed.index,
                    stage: PlotStage::Empty,
                    title: format!("{} 号地块", bed.index + 1),
                    locked: Some(false),
                });
            }
        }

        let puppet_ids: [&str; 6] = ["architect", "coder", "reviewer", "tester", "designer", "orchestrator"];
        let mut helpers = Vec::new();
        let worker_sessions: Vec<&SessionView> = self
            .frame
            .sessions
            .iter()
            .filter(|s| s.is_worker() && self.repo.as_deref().is_none_or(|r| s.repo_name() == Some(r)))
            .collect();

        for (slot_idx, session) in worker_sessions.iter().take(5).enumerate() {
            let station = self.frame.station_of(session);
            let home_plot = if (0..6).contains(&station) { station as usize } else { slot_idx };
            let default_spot = match session.doing().map(place_of_action) {
                Some("library") => "skills",
                Some("workshop") => "runtimes",
                Some("mast") => "log",
                Some("bench") => "manager",
                _ => "taskBoard",
            };
            let profile_name = session
                .profile
                .as_deref()
                .and_then(|pid| self.profiles.iter().find(|a| a.id == pid))
                .map(|a| a.name.clone())
                .unwrap_or_else(|| session.name.clone());
            helpers.push(HelperTaskSync {
                id: puppet_ids[slot_idx].into(),
                home_plot: Some(home_plot),
                default_spot: Some(default_spot.into()),
                name: Some(profile_name),
                role: Some(session.runtime.clone()),
            });
        }

        if let Some(orc) = self.profiles.iter().find(|a| a.id == "orchestrator") {
            helpers.push(HelperTaskSync {
                id: "orchestrator".into(),
                home_plot: Some(3),
                default_spot: Some("manager".into()),
                name: Some(orc.name.clone()),
                role: Some("主助手".into()),
            });
        }

        let decorations = self
            .frame
            .view
            .decorations
            .iter()
            .map(|d| DecorationSync {
                id: d.id.clone(),
                asset: d.asset.clone(),
                x: d.x.0 as f32,
                z: d.z.0 as f32,
                yaw_deg: d.yaw_deg.0 as f32,
                scale: d.scale.0 as f32,
            })
            .collect();

        self.world.apply_domain_sync(YardSnapshotSync {
            plots,
            helpers,
            decorations,
            time_of_day: self.manual_tod.or_else(|| Some(wall_clock_time_of_day())),
        });
    }

    pub fn tick_and_submit(&mut self, view_w: f32, view_h: f32, scale_factor: f32, active: bool, animate: bool) {
        let now = Instant::now();
        let size = (view_w.max(1.0), view_h.max(1.0));
        if self.view_size != size || self.world.camera.is_moving() {
            self.last_camera_motion = now;
        }
        self.view_size = size;
        let dt = now.duration_since(self.last_tick).as_secs_f32();
        self.last_tick = now;

        self.phone.tick(now);
        self.world.step(dt);
        if !animate {
            self.world.settle_view();
        }
        self.refresh_anchors(false);

        let Some(worker) = &self.worker else { return };

        if let Ok(mut slot) = worker.completed.lock()
            && let Some(done) = slot.take()
        {
            self.last_telemetry = done.telemetry;
            self.latest_frame = Some(done);
            self.frame_gen = self.frame_gen.wrapping_add(1).max(1);
        }

        if !active && self.latest_frame.is_some() {
            return;
        }

        let is_active_motion = self.is_active_motion();
        let pace = Duration::from_millis(if is_active_motion { ACTIVE_PACE_MS } else { IDLE_PACE_MS });
        if now.duration_since(self.last_submit) < pace {
            return;
        }
        if worker.busy.load(Ordering::Acquire) {
            return;
        }

        let settled = !animate || (self.latest_frame.is_some() && now.duration_since(self.last_camera_motion) >= CAMERA_SETTLE);
        let (rw, rh) = align_render_dims(view_w, view_h, scale_factor, settled);
        if !animate && !self.changed_since_submit() && (self.last_telemetry.width, self.last_telemetry.height) == (rw, rh) {
            return;
        }
        let aspect = self.view_size.0 / self.view_size.1.max(1.0);
        let mut scene_input = prepare_scene_input(&self.world, &self.bundle, aspect);
        scene_input.dof_mode = DofMode::Crisp;
        if worker.submit(RenderRequest {
            scene_input,
            width: rw,
            height: rh,
            quality: RenderQuality::Interactive,
        }) {
            self.last_submit = now;
        }
    }

    pub fn is_active_motion(&self) -> bool {
        self.latest_frame.is_none() || Instant::now().duration_since(self.last_activity) < ACTIVE_WINDOW || self.world.camera.is_moving()
    }

    fn changed_since_submit(&self) -> bool {
        self.last_activity > self.last_submit || self.last_camera_motion > self.last_submit
    }

    pub fn needs_frame(&self) -> bool {
        self.latest_frame.is_none()
            || self.changed_since_submit()
            || self
                .worker
                .as_ref()
                .is_some_and(|w| w.busy.load(Ordering::Acquire) || w.completed.lock().is_ok_and(|slot| slot.is_some()))
    }

    pub fn latest_bgra(&self) -> Option<(u32, u32, u64, &[u8])> {
        self.latest_frame.as_ref().map(|f| (f.width, f.height, self.frame_gen, f.bgra.bytes()))
    }

    pub fn hover_at(&mut self, nx: f32, ny: f32) {
        let aspect = self.view_size.0 / self.view_size.1.max(1.0);
        let hit = pick(&self.world, &self.bundle, nx.clamp(0.0, 1.0), ny.clamp(0.0, 1.0), aspect);
        let next = match hit {
            DioramaHit::Ground => None,
            other => Some(other),
        };
        let building_changed = !matches!(
            (&self.hovered, &next),
            (Some(DioramaHit::Building { id: a, .. }), Some(DioramaHit::Building { id: b, .. })) if a == b
        ) && (matches!(self.hovered, Some(DioramaHit::Building { .. })) || matches!(next, Some(DioramaHit::Building { .. })));
        self.world.hovered = next.clone();
        self.hovered = next;
        if building_changed {
            self.refresh_anchors(true);
        }
    }

    pub fn pan(&mut self, dx: f32, dy: f32) {
        self.world.camera.pan(dx, dy);
        self.touch();
        self.refresh_anchors(true);
    }

    pub fn zoom_at(&mut self, delta: f32, nx: f32, ny: f32) {
        let aspect = self.view_size.0 / self.view_size.1.max(1.0);
        self.world.camera.zoom_at(delta, nx.clamp(0.0, 1.0), ny.clamp(0.0, 1.0), aspect);
        self.touch();
        self.refresh_anchors(true);
    }

    pub fn click_at(&mut self, nx: f32, ny: f32, secondary: bool) -> DioramaAction {
        let aspect = self.view_size.0 / self.view_size.1.max(1.0);
        let hit = pick(&self.world, &self.bundle, nx.clamp(0.0, 1.0), ny.clamp(0.0, 1.0), aspect);
        self.world.selected = Some(hit.clone());
        self.touch();
        match hit {
            DioramaHit::Plot { index, stage, .. } => self.handle_plot_click(index, stage, secondary),
            DioramaHit::Building { id, opens, .. } => {
                if secondary {
                    return DioramaAction::None;
                }
                let asset = self.world.buildings.iter().find(|b| b.id == id).map(|b| b.asset.as_str()).unwrap_or("");
                if is_cutaway_building(asset) && self.world.focus_building_interior(&id) {
                    self.sounds.push("open");
                    self.refresh_anchors(true);
                    return DioramaAction::FocusedBuilding;
                }
                self.dispatch_building_opens(&opens)
            }
            DioramaHit::Helper { id, name, .. } => {
                if secondary {
                    return DioramaAction::None;
                }
                self.sounds.push("tap");
                self.show_toast(name);
                if id == "orchestrator" {
                    DioramaAction::Route("/chat".into())
                } else {
                    DioramaAction::Route("/agents".into())
                }
            }
            DioramaHit::Prop { label, .. } => {
                if !secondary {
                    self.sounds.push("tap");
                    self.show_toast(label);
                }
                DioramaAction::None
            }
            DioramaHit::Ground => {
                self.world.selected = None;
                DioramaAction::None
            }
        }
    }

    pub fn activate_anchor(&mut self, anchor: &ScreenAnchor) -> DioramaAction {
        if let Some(plot_index) = anchor.plot_index {
            let stage = self.world.plots.get(plot_index).map(|p| p.stage).unwrap_or(PlotStage::Empty);
            self.handle_plot_click(plot_index, stage, false)
        } else if anchor.kind == "building" {
            if let Some((id, opens, asset)) = self
                .world
                .buildings
                .iter()
                .find(|b| b.id == anchor.id)
                .map(|b| (b.id.clone(), b.opens.clone(), b.asset.clone()))
            {
                if is_cutaway_building(&asset) && self.world.focus_building_interior(&id) {
                    self.sounds.push("open");
                    self.refresh_anchors(true);
                    return DioramaAction::FocusedBuilding;
                }
                return self.dispatch_building_opens(&opens);
            }
            DioramaAction::None
        } else {
            DioramaAction::None
        }
    }

    pub fn dispatch_building_opens(&mut self, opens: &str) -> DioramaAction {
        self.sounds.push("open");
        match opens {
            "chat" => DioramaAction::OpenPhone,
            "panel:log" => DioramaAction::Route("/runs".into()),
            "panel:warehouse" => DioramaAction::Route("/issues".into()),
            "panel:achievements" | "panel:graphs" => DioramaAction::Route("/agents".into()),
            "panel:shop" => DioramaAction::OpenForm(json!({ "kind": "shop", "repo": self.repo })),
            route if route.starts_with('/') => DioramaAction::Route(route.to_string()),
            other => DioramaAction::Route(other.to_string()),
        }
    }

    fn handle_plot_click(&mut self, index: usize, stage: PlotStage, secondary: bool) -> DioramaAction {
        let session = self.session_at_bed(index).cloned();
        let issue_id = session.as_ref().and_then(|s| s.issue_id().map(String::from));

        if secondary {
            if let Some(s) = session
                && let Some(cwd) = s.cwd.clone()
            {
                let title = issue_id
                    .as_deref()
                    .and_then(|id| self.frame.issues.iter().find(|i| i.id == id))
                    .map(|i| format!("#{}", i.number))
                    .unwrap_or_else(|| s.name.clone());
                return DioramaAction::OpenTerminal { cwd, title };
            }
            return DioramaAction::None;
        }

        if let Some(s) = session {
            let kind = match stage {
                PlotStage::Reviewing => "harvest",
                PlotStage::Asking => "water",
                _ => "inspect",
            };
            self.sounds.push(match stage {
                PlotStage::Reviewing => "harvest",
                PlotStage::Asking => "water",
                _ => "open",
            });
            return DioramaAction::OpenForm(json!({
                "kind": kind,
                "repo": self.repo,
                "station": index,
                "session": s.id,
                "issue": issue_id,
            }));
        }

        if index < 6 && !self.world.plots.get(index).is_some_and(|p| p.locked) {
            self.sounds.push("plant");
            return DioramaAction::OpenForm(json!({
                "kind": "sow",
                "station": index,
                "repo": self.repo,
            }));
        }

        DioramaAction::None
    }

    fn refresh_anchors(&mut self, force: bool) {
        let now = Instant::now();
        if !force && now.duration_since(self.last_anchors_at) < ANCHOR_SYNC_INTERVAL {
            return;
        }
        self.last_anchors_at = now;
        let aspect = self.view_size.0 / self.view_size.1.max(1.0);
        self.anchors = self.world.project_screen_anchors(aspect);
    }

    pub fn debug_state(&self) -> Value {
        json!({
            "renderer": "diorama-wgpu",
            "timeOfDay": format!("{:?}", self.world.time_of_day),
            "focusedBuilding": self.world.focused_building,
            "roofCutaway": self.world.roof_cutaway_open(),
            "plots": self.world.plots.len(),
            "helpers": self.world.helpers.len(),
            "telemetry": {
                "gpuMs": self.last_telemetry.gpu_ms,
                "readbackMs": self.last_telemetry.readback_ms,
                "drawCalls": self.last_telemetry.draw_calls,
                "shadowCached": self.last_telemetry.shadow_cached,
                "width": self.last_telemetry.width,
                "height": self.last_telemetry.height,
            },
        })
    }
}

pub fn wall_clock_time_of_day() -> TimeOfDay {
    let hour = u32::try_from(jiff::ZonedDateTime::now().hour()).unwrap_or(12);
    match hour {
        5..=8 => TimeOfDay::Dawn,
        9..=16 => TimeOfDay::Noon,
        17..=19 => TimeOfDay::Dusk,
        _ => TimeOfDay::Night,
    }
}

fn align_render_dims(view_w: f32, view_h: f32, scale_factor: f32, settled: bool) -> (u32, u32) {
    let (max_w, max_h) = if settled { (2048, 1312) } else { (1280, 832) };
    let scale = scale_factor.clamp(1.0, 2.0);
    let rw = view_w.max(128.0) * scale;
    let rh = view_h.max(96.0) * scale;
    let cap = (max_w as f32 / rw).min(max_h as f32 / rh).min(1.0);
    let w = ((rw * cap).round() as u32 & !1).clamp(128, max_w);
    let h = ((rh * cap).round() as u32 & !1).clamp(96, max_h);
    (w, h)
}

pub fn map_issue_to_plot_stage(stage: &IssueStage, crop: Option<Crop>) -> PlotStage {
    match stage.state {
        IssueStageKind::Draft | IssueStageKind::Queued => PlotStage::Seeded,
        IssueStageKind::Working => map_crop_fallback(crop),
        IssueStageKind::Asking => PlotStage::Asking,
        IssueStageKind::Reviewing => PlotStage::Reviewing,
        IssueStageKind::Stuck => match stage.stuck {
            Some(StuckReason::Conflict) => PlotStage::Conflict,
            Some(StuckReason::Failed) | None => PlotStage::Failed,
            Some(StuckReason::Quiet) => PlotStage::Asking,
            Some(StuckReason::Interrupted) => PlotStage::Weeds,
        },
        IssueStageKind::Done | IssueStageKind::Canceled => match crop {
            Some(Crop::Wheat) => PlotStage::Reviewing,
            Some(Crop::Carrot) => PlotStage::Failed,
            _ => PlotStage::Empty,
        },
    }
}

fn map_crop_fallback(crop: Option<Crop>) -> PlotStage {
    match crop {
        Some(Crop::Seeded) => PlotStage::Seeded,
        Some(Crop::Sprout) => PlotStage::Sprout,
        Some(Crop::Leafy) | None => PlotStage::Leafy,
        Some(Crop::Flowering) => PlotStage::Flowering,
        Some(Crop::Wheat) => PlotStage::Reviewing,
        Some(Crop::Carrot) => PlotStage::Failed,
        Some(Crop::Dry) => PlotStage::Asking,
        Some(Crop::Withered) => PlotStage::Conflict,
        Some(Crop::Weeds) => PlotStage::Weeds,
        Some(Crop::Empty | Crop::Harvested | Crop::Locked) => PlotStage::Empty,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stage(kind: IssueStageKind, stuck: Option<StuckReason>) -> IssueStage {
        IssueStage {
            state: kind,
            since: None,
            stuck,
            lead: None,
            acts: vec![],
        }
    }

    #[test]
    fn issue_stage_mapping_covers_all_states_deterministically() {
        assert_eq!(map_issue_to_plot_stage(&stage(IssueStageKind::Draft, None), None), PlotStage::Seeded);
        assert_eq!(map_issue_to_plot_stage(&stage(IssueStageKind::Queued, None), None), PlotStage::Seeded);
        assert_eq!(
            map_issue_to_plot_stage(&stage(IssueStageKind::Working, None), Some(Crop::Sprout)),
            PlotStage::Sprout
        );
        assert_eq!(map_issue_to_plot_stage(&stage(IssueStageKind::Asking, None), None), PlotStage::Asking);
        assert_eq!(map_issue_to_plot_stage(&stage(IssueStageKind::Reviewing, None), None), PlotStage::Reviewing);
        assert_eq!(
            map_issue_to_plot_stage(&stage(IssueStageKind::Stuck, Some(StuckReason::Conflict)), None),
            PlotStage::Conflict
        );
        assert_eq!(
            map_issue_to_plot_stage(&stage(IssueStageKind::Stuck, Some(StuckReason::Failed)), None),
            PlotStage::Failed
        );
        assert_eq!(
            map_issue_to_plot_stage(&stage(IssueStageKind::Stuck, Some(StuckReason::Quiet)), None),
            PlotStage::Asking
        );
        assert_eq!(
            map_issue_to_plot_stage(&stage(IssueStageKind::Stuck, Some(StuckReason::Interrupted)), None),
            PlotStage::Weeds
        );
        assert_eq!(map_issue_to_plot_stage(&stage(IssueStageKind::Done, None), None), PlotStage::Empty);
        assert_eq!(map_issue_to_plot_stage(&stage(IssueStageKind::Canceled, None), None), PlotStage::Empty);
    }

    #[test]
    fn regression_retina_view_recovers_detail_after_camera_motion() {
        assert_eq!(align_render_dims(960.0, 600.0, 2.0, false), (1280, 800));
        assert_eq!(align_render_dims(960.0, 600.0, 2.0, true), (1920, 1200));
        assert_eq!(align_render_dims(1800.0, 1125.0, 2.0, true), (2048, 1280));
        assert_eq!(align_render_dims(960.0, 600.0, 1.0, true), (960, 600));
    }

    #[test]
    fn align_render_dims_preserves_aspect_and_bounds() {
        for (vw, vh, sf) in [(640.0, 400.0, 1.0), (1100.0, 720.0, 2.0), (2000.0, 1400.0, 2.0), (100.0, 80.0, 1.0)] {
            let (w, h) = align_render_dims(vw, vh, sf, false);
            assert!(w.is_multiple_of(2) && h.is_multiple_of(2));
            assert!((128..=1280).contains(&w));
            assert!((96..=832).contains(&h));
            let expected = vw.max(128.0) / vh.max(96.0);
            let actual = w as f32 / h as f32;
            assert!((expected - actual).abs() < 0.03, "aspect mismatch: {expected} vs {actual}");
        }
    }

    #[test]
    fn panel_shop_opens_shop_form_with_repo_and_syncs_unlocked_decorations() {
        let mut scene = DioramaScene::new_for_test(Some("demo".into()));
        let action = scene.dispatch_building_opens("panel:shop");
        assert_eq!(action, DioramaAction::OpenForm(json!({ "kind": "shop", "repo": "demo" })));
        scene.apply_farm(FarmFrame {
            seq: 5,
            view: vibevalley_protocol::FarmView {
                level: vibevalley_protocol::FarmLevel { level: 1, xp: 0, need: 10 },
                plots: Default::default(),
                plays: Default::default(),
                decorations: vec![vibevalley_protocol::YardDecoration {
                    id: "deco_stone_lantern".into(),
                    asset: "p_lantern".into(),
                    title: "Stone Lantern".into(),
                    x: vibevalley_protocol::JsNumber::from(2.15),
                    z: vibevalley_protocol::JsNumber::from(-1.85),
                    yaw_deg: vibevalley_protocol::JsNumber::from(12.0),
                    scale: vibevalley_protocol::JsNumber::from(1.15),
                }],
            },
            progress: None,
            effects: vec![],
        });
        assert!(
            scene
                .world
                .props
                .iter()
                .any(|p| p.id == "shop_deco_deco_stone_lantern" && p.asset == "p_lantern"),
            "unlocked yard decoration must appear in diorama world props"
        );
    }
}

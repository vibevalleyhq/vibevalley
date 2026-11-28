use std::collections::{BTreeMap, BTreeSet};

use crate::asset::{AssetBundle, SceneSpec};
use crate::camera::CameraRig;
use crate::domain::{DecorationSync, PlayerIntent, PlotActionOutcome, ScreenAnchor, YardSnapshotSync};
use crate::foley::SoundKind;
use crate::math::Vec3;
use crate::nav::{NavGraph, surface_height_at};
use crate::rig::{PuppetAnimState, PuppetRig};
use crate::spring::FlapSpring;

use super::DioramaWorld;
use super::types::{
    BuildingState, DioramaHit, EditAction, EditorCursor, HelperAnimSummary, HelperState, PlotStage, PlotState, PropState, TimeOfDay, is_cutaway_building,
};

const DEMO_STAGES: [(PlotStage, &str); 9] = [
    (PlotStage::Reviewing, "#104 OAuth Token Refresh"),
    (PlotStage::Leafy, "#108 Metal 5-Pass Pipeline"),
    (PlotStage::Asking, "#112 Clarify Retry Backoff"),
    (PlotStage::Flowering, "#115 Live Board Shortcuts"),
    (PlotStage::Sprout, "#118 Cut-Edge Ribbon Mesh"),
    (PlotStage::Failed, "#121 Fix Flaky Shadow Bias"),
    (PlotStage::Empty, "闲置扩展地 #7"),
    (PlotStage::Seeded, "#124 Paper Foley Tuning"),
    (PlotStage::Empty, "闲置扩展地 #9"),
];

pub(super) fn build_scene_entities(scene: &SceneSpec) -> (Vec<PlotState>, Vec<BuildingState>, Vec<PropState>, Vec<HelperState>) {
    let plots: Vec<PlotState> = scene
        .plots
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let (stage, title) = DEMO_STAGES[i % DEMO_STAGES.len()];
            let mut crop_spring = FlapSpring::new(0.0, i as f32 * 0.9, 0.025);
            crop_spring.fold_down_and_rise(0.15 + i as f32 * 0.055);
            let mut sign_spring = FlapSpring::new(0.0, i as f32 * 1.3 + 0.5, 0.045);
            sign_spring.fold_down_and_rise(0.25 + i as f32 * 0.055);
            PlotState {
                index: p.index,
                pos: Vec3::new(p.pos[0], p.pos[1], p.pos[2]),
                size: p.size,
                stage,
                title: title.into(),
                crop_spring,
                sign_spring,
                locked: false,
            }
        })
        .collect();

    let buildings: Vec<BuildingState> = scene
        .buildings
        .iter()
        .enumerate()
        .map(|(i, b)| {
            let mut spring = FlapSpring::new(0.0, i as f32 * 0.6, 0.0);
            spring.fold_down_and_rise(0.04 + i as f32 * 0.04);
            BuildingState {
                id: b.id.clone(),
                label: b.label.clone(),
                opens: b.opens.clone(),
                asset: b.asset.clone(),
                pos: Vec3::new(b.pos[0], b.pos[1], b.pos[2]),
                scale: b.scale,
                yaw_rad: b.yaw_deg.to_radians(),
                spring,
                is_dynamic: false,
            }
        })
        .collect();

    let props: Vec<PropState> = scene
        .props
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let mut spring = FlapSpring::new(0.0, i as f32 * 1.1, if p.is_lamp { 0.0 } else { 0.035 });
            spring.fold_down_and_rise(0.08 + i as f32 * 0.025);
            PropState {
                id: format!("base_prop_{i}"),
                asset: p.asset.clone(),
                pos: Vec3::new(p.pos[0], p.pos[1], p.pos[2]),
                scale: p.scale,
                yaw_rad: p.yaw_deg.to_radians(),
                is_lamp: p.is_lamp || p.asset.contains("lantern"),
                spring,
                is_dynamic: false,
            }
        })
        .collect();

    let helpers: Vec<HelperState> = scene
        .helpers
        .iter()
        .enumerate()
        .map(|(i, h)| {
            let p = if !scene.plots.is_empty() {
                let base_plot = &scene.plots[h.home_plot % scene.plots.len()];
                Vec3::new(base_plot.pos[0] + 0.72, 0.0, base_plot.pos[2] + 0.95)
            } else {
                Vec3::new(-1.5 + i as f32 * 0.7, 0.0, 1.5)
            };
            let mut spring = FlapSpring::new(0.0, i as f32 * 0.7, 0.018);
            spring.fold_down_and_rise(0.32 + i as f32 * 0.06);
            let init_state = plots
                .get(h.home_plot % plots.len().max(1))
                .map(|pl| PuppetAnimState::for_plot_stage(pl.stage))
                .unwrap_or(PuppetAnimState::Idle);
            HelperState {
                id: h.id.clone(),
                name: h.name.clone(),
                role: h.role.clone(),
                asset: h.asset.clone(),
                home_plot: h.home_plot,
                default_spot: h.default_spot.clone(),
                pos: p,
                target_pos: p,
                path: Vec::new(),
                going_to_building: i % 2 == 0,
                yaw_rad: 0.0,
                yaw_vel: 0.0,
                slope_pitch: 0.0,
                scale: 1.02,
                wait_timer: 1.5 + i as f32 * 1.2,
                celebrate_timer: 0.0,
                walk_phase: 0.0,
                spring,
                rig: PuppetRig::new(init_state, 0.7 + i as f32 * 1.37),
                is_dynamic: false,
            }
        })
        .collect();

    (plots, buildings, props, helpers)
}

impl DioramaWorld {
    pub fn new(bundle: &AssetBundle) -> Self {
        let mut w = Self::from_scene(bundle.manifest.scene.clone(), bundle.manifest.ground_size);
        w.available_meshes = bundle.manifest.meshes.keys().cloned().collect();
        w.mesh_bones = bundle
            .manifest
            .meshes
            .iter()
            .filter(|(_, m)| !m.bones.is_empty())
            .map(|(k, m)| (k.clone(), m.bones.clone()))
            .collect();
        w
    }

    pub fn from_scene(scene: SceneSpec, ground_size: f32) -> Self {
        let (plots, buildings, props, mut helpers) = build_scene_entities(&scene);
        let nav = NavGraph::build(&plots, &buildings, &props);

        // Seed realistic road/bridge patrol routes so animals visibly climb over Bridge #1 & Bridge #2!
        for h in &mut helpers {
            h.pos.y = surface_height_at(&props, h.pos.x, h.pos.z);
            if h.id == "designer" {
                if let Some(start_idx) = nav.node_by_tag("bridge_1_w") {
                    let start = nav.nodes[start_idx].pos;
                    h.pos = start;
                    h.target_pos = start;
                    if let Some(goal_idx) = nav.node_by_tag("bldg_shop").or_else(|| nav.node_by_tag("bridge_1_e")) {
                        h.path = nav.find_path_to_node(start, goal_idx);
                        h.going_to_building = true;
                        h.wait_timer = 0.0;
                    }
                }
            } else if h.id == "coder" {
                if let Some(start_idx) = nav.node_by_tag("bridge_2_w") {
                    let start = nav.nodes[start_idx].pos;
                    h.pos = start;
                    h.target_pos = start;
                    if let Some(goal_idx) = nav.node_by_tag("bldg_runtimes").or_else(|| nav.node_by_tag("bridge_2_e")) {
                        h.path = nav.find_path_to_node(start, goal_idx);
                        h.going_to_building = true;
                        h.wait_timer = 0.0;
                    }
                }
            } else if h.id == "reviewer"
                && let Some(start_idx) = nav.node_by_tag("plaza_center")
            {
                let start = nav.nodes[start_idx].pos;
                h.pos = start;
                h.target_pos = start;
                h.yaw_rad = std::f32::consts::PI;
                if let Some(goal_idx) = nav.node_by_tag("bldg_agents").or_else(|| nav.node_by_tag("bldg_taskBoard")) {
                    h.path = nav.find_path_to_node(start, goal_idx);
                    h.going_to_building = true;
                    h.wait_timer = 0.0;
                }
            }
        }

        let mut roof_cutaway_spring = FlapSpring::new(0.0, 0.0, 0.0);
        roof_cutaway_spring.stiffness = 165.0;
        roof_cutaway_spring.damping = 16.0;
        Self {
            plots,
            buildings,
            props,
            helpers,
            camera: CameraRig::default(),
            time_of_day: TimeOfDay::Noon,
            prev_tod: TimeOfDay::Noon,
            tod_blend: 1.0,
            hovered: None,
            selected: None,
            editor_cursor: None,
            elapsed: 0.0,
            pending_sounds: Vec::new(),
            ground_size: if ground_size > 1.0 { ground_size } else { 16.0 },
            active_preset: "fullTown".into(),
            roof_cutaway_open: false,
            roof_cutaway_spring,
            show_routes: false,
            nav,
            harvest_count: 0,
            focused_building: None,
            available_meshes: BTreeSet::new(),
            mesh_bones: BTreeMap::new(),
            base_scene: scene,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            atlas_cache: BTreeMap::new(),
            next_dynamic_seq: 1,
        }
    }

    pub fn rebuild_nav(&mut self) {
        self.nav = NavGraph::build(&self.plots, &self.buildings, &self.props);
    }

    /// Rebuilds the navigation graph and immediately clears stale helper routes & snaps Y elevation
    /// so helpers never keep walking over a removed bridge or clip through a newly placed building.
    pub fn rebuild_nav_and_repath(&mut self) {
        self.nav = NavGraph::build(&self.plots, &self.buildings, &self.props);
        for h in &mut self.helpers {
            h.path.clear();
            h.pos.y = surface_height_at(&self.props, h.pos.x, h.pos.z);
            h.target_pos = h.pos;
            h.slope_pitch = 0.0;
            h.wait_timer = h.wait_timer.min(0.6);
        }
    }

    /// Recalls any helper assigned to `plot_index` back to that plot when a ticket becomes urgent.
    pub fn recall_helper_to_plot(&mut self, plot_index: usize) {
        if self.plots.is_empty() {
            return;
        }
        let Some(plot) = self.plots.get(plot_index) else {
            return;
        };
        let plot_pos = plot.pos;
        let Some(goal_node) = self.nav.node_by_tag(&format!("plot_{}", plot.index)) else {
            return;
        };
        let plot_len = self.plots.len();
        for h in &mut self.helpers {
            if h.home_plot % plot_len != plot_index {
                continue;
            }
            let dist = (h.pos.x - plot_pos.x).hypot(h.pos.z - plot_pos.z);
            if dist > 1.75 {
                let route = self.nav.find_path_to_node(h.pos, goal_node);
                if !route.is_empty() {
                    h.target_pos = route[0];
                    h.path = route;
                    h.going_to_building = false;
                    h.wait_timer = 0.0;
                }
            }
        }
    }

    /// Executes a semantic Play Mode action on `plots[index]` (harvest ripe crop, resolve asking
    /// prompt, repair failed/conflict plot, clean weeds, or seed an empty bed).
    pub fn interact_plot(&mut self, index: usize) -> Option<PlotActionOutcome> {
        let (prev_stage, title) = {
            let p = self.plots.get(index)?;
            (p.stage, p.title.clone())
        };
        let (next_stage, harvest_delta, summary, sound, intent) = match prev_stage {
            PlotStage::Reviewing => {
                self.harvest_count = self.harvest_count.saturating_add(1);
                let count = self.harvest_count;
                (
                    PlotStage::Empty,
                    1,
                    format!("验收收获「{title}」+1"),
                    SoundKind::HarvestChime,
                    PlayerIntent::HarvestPlot {
                        index,
                        title: title.clone(),
                        harvest_count: count,
                    },
                )
            }
            PlotStage::Asking => (
                PlotStage::Flowering,
                0,
                format!("已回应「{title}」，工单继续推进"),
                SoundKind::FoldUp,
                PlayerIntent::ResolveAskingPlot { index, title: title.clone() },
            ),
            PlotStage::Conflict | PlotStage::Failed => (
                PlotStage::Leafy,
                0,
                format!("已派工排查「{title}」"),
                SoundKind::FoldUp,
                PlayerIntent::RepairPlot { index, title: title.clone() },
            ),
            PlotStage::Weeds => (
                PlotStage::Empty,
                0,
                format!("已清理地块 #{} 杂草", index + 1),
                SoundKind::CardTap,
                PlayerIntent::CleanWeedsPlot { index, title: title.clone() },
            ),
            PlotStage::Empty => (
                PlotStage::Seeded,
                0,
                format!("已在地块 #{} 播下新工单", index + 1),
                SoundKind::FoldUp,
                PlayerIntent::SeedPlot { index, title: title.clone() },
            ),
            _ => {
                if let Some(p) = self.plots.get_mut(index) {
                    p.crop_spring.impulse(5.0);
                    p.sign_spring.impulse(6.0);
                }
                self.pending_sounds.push(SoundKind::CardTap);
                return None;
            }
        };

        if let Some(p) = self.plots.get_mut(index) {
            p.stage = next_stage;
            p.crop_spring.fold_down_and_rise(0.0);
            p.sign_spring.fold_down_and_rise(0.06);
            self.selected = Some(DioramaHit::Plot {
                index: p.index,
                stage: p.stage,
                title: p.title.clone(),
            });
        }
        self.pending_sounds.push(sound);

        let plot_len = self.plots.len().max(1);
        if prev_stage == PlotStage::Reviewing {
            for h in &mut self.helpers {
                if h.home_plot % plot_len == index {
                    h.rig.set_state(PuppetAnimState::Celebrate);
                    h.rig.trigger_cardboard_flip();
                    h.spring.impulse(6.4);
                    h.celebrate_timer = 2.4;
                    h.wait_timer = 3.2;
                }
            }
        } else if matches!(prev_stage, PlotStage::Asking | PlotStage::Conflict | PlotStage::Failed) {
            self.recall_helper_to_plot(index);
        }

        Some(PlotActionOutcome {
            index,
            prev_stage,
            next_stage,
            harvest_delta,
            harvest_count: self.harvest_count,
            summary,
            sound,
            intent,
        })
    }

    /// Idempotent host-to-diorama snapshot sync (`YardSnapshotSync`).
    pub fn apply_domain_sync(&mut self, sync: YardSnapshotSync) {
        let mut urgent_plots: Vec<usize> = Vec::new();
        for pt in sync.plots {
            if let Some((slot, p)) = self.plots.iter_mut().enumerate().find(|(_, p)| p.index == pt.index) {
                let changed = p.stage != pt.stage;
                p.stage = pt.stage;
                if !pt.title.is_empty() {
                    p.title = pt.title;
                }
                if let Some(locked) = pt.locked {
                    p.locked = locked;
                }
                if changed {
                    p.crop_spring.fold_down_and_rise(0.0);
                    p.sign_spring.fold_down_and_rise(0.06);
                    if matches!(p.stage, PlotStage::Asking | PlotStage::Reviewing | PlotStage::Conflict | PlotStage::Failed) {
                        urgent_plots.push(slot);
                    }
                }
            }
        }
        for ht in sync.helpers {
            if let Some(h) = self.helpers.iter_mut().find(|h| h.id == ht.id) {
                if let Some(hp) = ht.home_plot {
                    h.home_plot = hp;
                }
                if let Some(spot) = ht.default_spot {
                    h.default_spot = spot;
                }
                if let Some(name) = ht.name.filter(|s| !s.is_empty()) {
                    h.name = name;
                }
                if let Some(role) = ht.role.filter(|s| !s.is_empty()) {
                    h.role = role;
                }
            }
        }
        if let Some(tod) = sync.time_of_day {
            self.set_time_of_day(tod, false);
        }
        self.apply_decorations_sync(sync.decorations);
        for slot in urgent_plots {
            self.recall_helper_to_plot(slot);
        }
    }

    fn apply_decorations_sync(&mut self, decorations: Vec<DecorationSync>) {
        let mut wanted = std::collections::HashSet::with_capacity(decorations.len());
        for deco in &decorations {
            wanted.insert(format!("shop_deco_{}", deco.id));
        }
        self.props.retain(|p| !p.id.starts_with("shop_deco_") || wanted.contains(&p.id));
        for deco in decorations {
            let prop_id = format!("shop_deco_{}", deco.id);
            let is_lamp = deco.asset.contains("lantern") || deco.asset.contains("lamp");
            let yaw_rad = deco.yaw_deg.to_radians();
            let scale = if deco.scale > 0.1 { deco.scale } else { 1.0 };
            let pos = Vec3::new(deco.x, 0.0, deco.z);
            if let Some(existing) = self.props.iter_mut().find(|p| p.id == prop_id) {
                existing.asset = deco.asset;
                existing.pos = pos;
                existing.scale = scale;
                existing.yaw_rad = yaw_rad;
                existing.is_lamp = is_lamp;
                continue;
            }
            let sway = if is_lamp { 0.0 } else { 0.035 };
            let mut spring = FlapSpring::new(0.0, 0.4, sway);
            spring.fold_down_and_rise(0.0);
            self.props.push(PropState {
                id: prop_id,
                asset: deco.asset,
                pos,
                scale,
                yaw_rad,
                is_lamp,
                spring,
                is_dynamic: false,
            });
        }
    }

    /// Smoothly flies the camera into a building (opening its hinged cutaway roof when supported).
    pub fn focus_building_interior(&mut self, id: &str) -> bool {
        let Some((b_id, b_label, b_opens, b_asset, b_pos)) = self.buildings.iter_mut().find(|b| b.id == id).map(|b| {
            b.spring.impulse(3.6);
            (b.id.clone(), b.label.clone(), b.opens.clone(), b.asset.clone(), b.pos)
        }) else {
            return false;
        };
        let cutaway = is_cutaway_building(&b_asset);
        let (target, dist, pitch, yaw) = match b_asset.as_str() {
            "b_workshop" => (Vec3::new(b_pos.x - 0.18, 0.68, b_pos.z + 0.12), 7.4, 43.0, -26.0),
            "b_guild_hall" => (Vec3::new(b_pos.x, 0.72, b_pos.z + 0.15), 7.6, 44.0, 10.0),
            "b_library" => (Vec3::new(b_pos.x, 0.70, b_pos.z + 0.15), 7.6, 44.0, -18.0),
            _ => (Vec3::new(b_pos.x, 0.65, b_pos.z + 0.10), 9.6, 38.0, -8.0),
        };
        self.camera.focus_target(target, dist, pitch, yaw);
        if cutaway {
            self.set_roof_cutaway(true);
        } else {
            self.pending_sounds.push(SoundKind::CardTap);
        }
        self.focused_building = Some(b_id.clone());
        self.selected = Some(DioramaHit::Building {
            id: b_id,
            label: b_label,
            opens: b_opens,
        });
        true
    }

    /// Smoothly flies back out of building interior focus and closes the hinged cutaway roof.
    pub fn exit_interior_focus(&mut self) -> bool {
        if self.focused_building.is_none() && !self.camera.is_focused() {
            return false;
        }
        self.focused_building = None;
        self.camera.clear_focus();
        if self.roof_cutaway_open {
            self.set_roof_cutaway(false);
        }
        true
    }

    /// Projects urgent plot status badges and hovered building plaques into normalized viewport `[0..1]` space.
    pub fn project_screen_anchors(&self, aspect: f32) -> Vec<ScreenAnchor> {
        let vp = self.camera.view_params(aspect.max(0.1)).view_proj;
        let m = &vp.0;
        let project = |p: Vec3| -> Option<(f32, f32)> {
            let cx = m[0][0] * p.x + m[1][0] * p.y + m[2][0] * p.z + m[3][0];
            let cy = m[0][1] * p.x + m[1][1] * p.y + m[2][1] * p.z + m[3][1];
            let cw = m[0][3] * p.x + m[1][3] * p.y + m[2][3] * p.z + m[3][3];
            if cw <= 0.05 || !cw.is_finite() {
                return None;
            }
            let sx = (cx / cw) * 0.5 + 0.5;
            let sy = 0.5 - (cy / cw) * 0.5;
            if (0.04..=0.96).contains(&sx) && (0.10..=0.86).contains(&sy) {
                Some(((sx * 1000.0).round() / 1000.0, (sy * 1000.0).round() / 1000.0))
            } else {
                None
            }
        };

        let mut out = Vec::new();
        for p in &self.plots {
            let (badge, tone) = match p.stage {
                PlotStage::Reviewing => ("可收获", "ochre"),
                PlotStage::Asking => ("等你回答", "vermilion"),
                PlotStage::Conflict => ("合并冲突", "vermilion"),
                PlotStage::Failed => ("测试告警", "vermilion"),
                _ => continue,
            };
            if let Some((sx, sy)) = project(Vec3::new(p.pos.x, 1.38, p.pos.z)) {
                out.push(ScreenAnchor {
                    kind: "plot".into(),
                    id: format!("plot_{}", p.index),
                    label: p.title.clone(),
                    badge: badge.into(),
                    tone: tone.into(),
                    x: sx,
                    y: sy,
                    plot_index: Some(p.index),
                    urgent: true,
                });
            }
        }

        if let Some(DioramaHit::Building { id, label, .. }) = &self.hovered
            && let Some(b) = self.buildings.iter().find(|b| &b.id == id)
            && self.focused_building.as_deref() != Some(b.id.as_str())
            && let Some((sx, sy)) = project(Vec3::new(b.pos.x, 1.90, b.pos.z))
        {
            let badge = if is_cutaway_building(&b.asset) {
                "点击掀顶参观"
            } else {
                "点击查看"
            };
            out.push(ScreenAnchor {
                kind: "building".into(),
                id: b.id.clone(),
                label: label.clone(),
                badge: badge.into(),
                tone: "indigo".into(),
                x: sx,
                y: sy,
                plot_index: None,
                urgent: false,
            });
        }
        out
    }

    pub fn set_show_routes(&mut self, show: bool) {
        self.show_routes = show;
    }

    pub fn toggle_show_routes(&mut self) -> bool {
        self.show_routes = !self.show_routes;
        self.pending_sounds.push(SoundKind::CardTap);
        self.show_routes
    }

    pub fn show_routes(&self) -> bool {
        self.show_routes
    }

    /// Live world position of Rabbit Lead's handheld mini glowing paper lantern (when present).
    pub fn rabbit_lantern_pos(&self) -> Option<Vec3> {
        self.helpers
            .iter()
            .find(|h| h.asset == "h_rabbit")
            .map(|h| Vec3::new(h.pos.x + 0.14, h.pos.y + 0.45, h.pos.z + 0.16))
    }

    /// Opens or closes hinged cutaway roofs (`b_workshop`, `b_guild_hall`, `b_library`) smoothly on a `FlapSpring`.
    pub fn set_roof_cutaway(&mut self, open: bool) {
        self.set_roof_cutaway_snap(open, false);
    }

    /// Sets cutaway roof state with optional instant snap (useful for still captures in `render_shots.rs`).
    pub fn set_roof_cutaway_snap(&mut self, open: bool, snap: bool) {
        self.roof_cutaway_open = open;
        let target = if open { 1.0 } else { 0.0 };
        self.roof_cutaway_spring.set_target(target, 0.0);
        if snap {
            self.roof_cutaway_spring.settle();
        } else {
            self.pending_sounds.push(if open { SoundKind::FoldUp } else { SoundKind::CardTap });
        }
    }

    pub fn toggle_roof_cutaway(&mut self) -> bool {
        let next = !self.roof_cutaway_open;
        self.set_roof_cutaway(next);
        if next && !self.camera.is_focused() && self.camera.zoom_scale > 0.82 {
            self.camera.set_target_zoom(0.76);
        } else if !next && self.focused_building.is_some() {
            self.focused_building = None;
            self.camera.clear_focus();
        }
        next
    }

    pub fn roof_cutaway_open(&self) -> bool {
        self.roof_cutaway_open
    }

    pub fn helper_anim_summary(&self) -> Vec<HelperAnimSummary> {
        self.helpers
            .iter()
            .map(|h| HelperAnimSummary {
                id: h.id.clone(),
                name: h.name.clone(),
                role: h.role.clone(),
                state: h.rig.state,
                label: h.rig.state.label().into(),
            })
            .collect()
    }

    pub fn set_time_of_day(&mut self, tod: TimeOfDay, snap: bool) {
        if self.time_of_day == tod && !snap {
            return;
        }
        self.prev_tod = self.time_of_day;
        self.time_of_day = tod;
        self.tod_blend = if snap { 1.0 } else { 0.0 };
    }

    pub fn set_editor_cursor(&mut self, cursor: Option<EditorCursor>) {
        self.editor_cursor = cursor;
    }

    pub fn clear_editor_cursor(&mut self) {
        self.editor_cursor = None;
    }

    pub fn set_plot_stage(&mut self, index: usize, stage: PlotStage) {
        let Some(p) = self.plots.get_mut(index) else {
            return;
        };
        let prev_stage = p.stage;
        let prev_title = p.title.clone();
        let was_ripe = p.stage == PlotStage::Reviewing;
        p.stage = stage;
        p.crop_spring.fold_down_and_rise(0.0);
        p.sign_spring.fold_down_and_rise(0.06);
        let new_title = p.title.clone();
        self.push_undo(EditAction::SetPlotStage {
            index,
            prev_stage,
            prev_title,
            new_stage: stage,
            new_title,
        });
        let snd = if stage == PlotStage::Empty && was_ripe {
            SoundKind::HarvestStamp
        } else {
            SoundKind::FoldUp
        };
        self.pending_sounds.push(snd);
        let plot_len = self.plots.len().max(1);
        for h in &mut self.helpers {
            if h.home_plot % plot_len == index {
                h.celebrate_timer = 0.0;
            }
        }
        if matches!(stage, PlotStage::Asking | PlotStage::Reviewing | PlotStage::Conflict | PlotStage::Failed) {
            self.recall_helper_to_plot(index);
        }
    }

    pub fn trigger_fold_wave(&mut self) {
        for (i, b) in self.buildings.iter_mut().enumerate() {
            b.spring.fold_down_and_rise(i as f32 * 0.045);
        }
        for (i, p) in self.props.iter_mut().enumerate() {
            p.spring.fold_down_and_rise(0.08 + i as f32 * 0.025);
        }
        for (i, p) in self.plots.iter_mut().enumerate() {
            p.crop_spring.fold_down_and_rise(0.18 + i as f32 * 0.04);
            p.sign_spring.fold_down_and_rise(0.24 + i as f32 * 0.04);
        }
        for (i, h) in self.helpers.iter_mut().enumerate() {
            h.spring.fold_down_and_rise(0.28 + i as f32 * 0.05);
        }
        self.pending_sounds.push(SoundKind::FoldUp);
    }

    pub fn set_busy_courtyard_preset(&mut self) {
        let stages = [
            PlotStage::Reviewing,
            PlotStage::Flowering,
            PlotStage::Asking,
            PlotStage::Leafy,
            PlotStage::Reviewing,
            PlotStage::Sprout,
            PlotStage::Weeds,
            PlotStage::Seeded,
            PlotStage::Conflict,
        ];
        for (i, p) in self.plots.iter_mut().enumerate() {
            p.stage = stages[i % stages.len()];
            p.crop_spring.fold_down_and_rise(i as f32 * 0.04);
            p.sign_spring.fold_down_and_rise(0.06 + i as f32 * 0.04);
        }
        self.pending_sounds.push(SoundKind::FoldUp);
    }

    /// Pans the 3D camera target directly to `(world_x, world_z)` (used by minimap click-to-pan).
    pub fn pan_camera_to(&mut self, world_x: f32, world_z: f32) {
        let base_target = self.camera.view_params(1.0).target.sub(self.camera.pan_offset);
        let limit = (self.ground_size * 0.42).max(4.2);
        let nx = (world_x - base_target.x).clamp(-limit, limit);
        let nz = (world_z - base_target.z).clamp(-limit, limit);
        self.camera.set_pan_offset(Vec3::new(nx, 0.0, nz));
    }

    pub fn settle_view(&mut self) {
        self.tod_blend = 1.0;
        self.camera.settle();
        self.roof_cutaway_spring.settle();
        for building in &mut self.buildings {
            building.spring.settle();
        }
        for prop in &mut self.props {
            prop.spring.settle();
        }
        for plot in &mut self.plots {
            plot.crop_spring.settle();
            plot.sign_spring.settle();
        }
        for helper in &mut self.helpers {
            helper.spring.settle();
        }
    }
}

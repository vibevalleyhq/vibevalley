use crate::asset::{AssetBundle, BoneDesc, LightPreset, SceneSpec};
use crate::camera::CameraRig;
use crate::domain::{PlayerIntent, PlotActionOutcome, ScreenAnchor, YardSnapshotSync};
use crate::foley::SoundKind;
use crate::math::{Mat4, Vec3};
use crate::nav::{NavEdgeSummary, NavGraph, PlacementStatus, is_in_canal, surface_height_at, validate_placement};
use crate::pick::{raycast_ground as pick_raycast_ground, snap_coord};
use crate::rig::{MAX_BONES, MachineRig, PuppetAnimState, PuppetRig, identity_palette};
use crate::spring::FlapSpring;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TimeOfDay {
    Dawn,
    Noon,
    Dusk,
    Night,
}

impl TimeOfDay {
    pub fn key(self) -> &'static str {
        match self {
            TimeOfDay::Dawn => "dawn",
            TimeOfDay::Noon => "noon",
            TimeOfDay::Dusk => "dusk",
            TimeOfDay::Night => "night",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlotStage {
    Empty,
    Seeded,
    Sprout,
    Leafy,
    Flowering,
    Asking,
    Reviewing,
    Conflict,
    Failed,
    Weeds,
}

impl PlotStage {
    pub fn from_key(key: &str) -> Option<Self> {
        match key {
            "empty" => Some(Self::Empty),
            "seeded" => Some(Self::Seeded),
            "sprout" => Some(Self::Sprout),
            "leafy" => Some(Self::Leafy),
            "flowering" => Some(Self::Flowering),
            "asking" => Some(Self::Asking),
            "reviewing" => Some(Self::Reviewing),
            "conflict" => Some(Self::Conflict),
            "failed" => Some(Self::Failed),
            "weeds" => Some(Self::Weeds),
            _ => None,
        }
    }

    pub fn crop_mesh(self) -> Option<&'static str> {
        match self {
            PlotStage::Empty => None,
            PlotStage::Seeded => Some("c_seeded"),
            PlotStage::Sprout => Some("c_sprout"),
            PlotStage::Leafy => Some("c_leafy"),
            PlotStage::Flowering => Some("c_flowering"),
            PlotStage::Asking => Some("c_dry"),
            PlotStage::Reviewing => Some("c_wheat_ripe"),
            PlotStage::Conflict => Some("c_withered"),
            PlotStage::Failed => Some("c_carrot_ripe"),
            PlotStage::Weeds => Some("c_weeds"),
        }
    }

    pub fn sign_mesh(self) -> Option<&'static str> {
        match self {
            PlotStage::Asking => Some("s_ask"),
            PlotStage::Reviewing => Some("s_review"),
            PlotStage::Conflict | PlotStage::Failed => Some("s_bug"),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PlotStage::Empty => "空地",
            PlotStage::Seeded => "已播种",
            PlotStage::Sprout => "发芽中",
            PlotStage::Leafy => "枝叶繁茂",
            PlotStage::Flowering => "含苞待放",
            PlotStage::Asking => "等你回答",
            PlotStage::Reviewing => "可收获验收",
            PlotStage::Conflict => "合并冲突",
            PlotStage::Failed => "测试告警",
            PlotStage::Weeds => "清理杂草",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntityKind {
    Building,
    Prop,
    Helper,
    Plot,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DioramaHit {
    Plot {
        index: usize,
        stage: PlotStage,
        title: String,
    },
    Building {
        id: String,
        label: String,
        opens: String,
    },
    Prop {
        id: String,
        asset: String,
        label: String,
        is_lamp: bool,
    },
    Helper {
        id: String,
        name: String,
        role: String,
        anim_state: PuppetAnimState,
    },
    Ground,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperAnimSummary {
    pub id: String,
    pub name: String,
    pub role: String,
    pub state: PuppetAnimState,
    pub label: String,
}

/// Live 3D snapped placement cursor rendered in Editor Mode using existing meshes + highlight glow.
#[derive(Clone, Debug, PartialEq)]
pub struct EditorCursor {
    pub x: f32,
    pub z: f32,
    pub kind: EntityKind,
    pub asset_id: String,
    pub yaw_deg: f32,
    pub scale: f32,
    pub valid: bool,
    pub reason: Option<String>,
}

/// Readout of the currently selected entity's 3D transform for the Editor Inspector.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedTransform {
    pub x: f32,
    pub z: f32,
    pub yaw_deg: f32,
    pub scale: f32,
    pub can_transform: bool,
}

#[derive(Clone, Debug)]
pub struct PlotState {
    pub index: usize,
    pub pos: Vec3,
    pub size: [f32; 2],
    pub stage: PlotStage,
    pub title: String,
    pub crop_spring: FlapSpring,
    pub sign_spring: FlapSpring,
    pub locked: bool,
}

#[derive(Clone, Debug)]
pub struct BuildingState {
    pub id: String,
    pub label: String,
    pub opens: String,
    pub asset: String,
    pub pos: Vec3,
    pub scale: f32,
    pub yaw_rad: f32,
    pub spring: FlapSpring,
    pub is_dynamic: bool,
}

#[derive(Clone, Debug)]
pub struct PropState {
    pub id: String,
    pub asset: String,
    pub pos: Vec3,
    pub scale: f32,
    pub yaw_rad: f32,
    pub is_lamp: bool,
    pub spring: FlapSpring,
    pub is_dynamic: bool,
}

#[derive(Clone, Debug)]
pub struct HelperState {
    pub id: String,
    pub name: String,
    pub role: String,
    pub asset: String,
    pub home_plot: usize,
    pub default_spot: String,
    pub pos: Vec3,
    pub target_pos: Vec3,
    pub path: Vec<Vec3>,
    pub going_to_building: bool,
    pub yaw_rad: f32,
    pub yaw_vel: f32,
    pub slope_pitch: f32,
    pub scale: f32,
    pub wait_timer: f32,
    pub celebrate_timer: f32,
    pub walk_phase: f32,
    pub spring: FlapSpring,
    pub rig: PuppetRig,
    pub is_dynamic: bool,
}

#[derive(Clone, Debug)]
pub struct RenderInstance {
    pub mesh_id: String,
    pub model: Mat4,
    pub highlight: f32,
    /// Flat GPU bone buffer start offset (0 = static identity palette; 16*k = animated palette).
    pub bone_base: u32,
    /// Local-space 16-bone rigid-joint palette when animated (`None` = static identity).
    pub bone_palette: Option<[Mat4; MAX_BONES]>,
}

#[derive(Clone, Debug)]
enum EditAction {
    PlaceBuilding {
        state: BuildingState,
    },
    RemoveBuilding {
        index: usize,
        state: BuildingState,
    },
    PlaceProp {
        state: PropState,
    },
    RemoveProp {
        index: usize,
        state: PropState,
    },
    PlaceHelper {
        state: HelperState,
    },
    RemoveHelper {
        index: usize,
        state: HelperState,
    },
    TransformEntity {
        target: DioramaHit,
        prev_pos: Vec3,
        prev_yaw_rad: f32,
        prev_scale: f32,
        new_pos: Vec3,
        new_yaw_rad: f32,
        new_scale: f32,
    },
    SetPlotStage {
        index: usize,
        prev_stage: PlotStage,
        prev_title: String,
        new_stage: PlotStage,
        new_title: String,
    },
    Snapshot {
        plots: Vec<PlotState>,
        buildings: Vec<BuildingState>,
        props: Vec<PropState>,
        helpers: Vec<HelperState>,
        preset: String,
    },
}

#[derive(Clone, Debug)]
struct AtlasSnapshot {
    plots: Vec<PlotState>,
    buildings: Vec<BuildingState>,
    props: Vec<PropState>,
    helpers: Vec<HelperState>,
    undo_stack: Vec<EditAction>,
    redo_stack: Vec<EditAction>,
}

pub fn is_cutaway_building(asset: &str) -> bool {
    matches!(asset, "b_workshop" | "b_guild_hall" | "b_library")
}

pub fn building_display_info(asset: &str) -> (&'static str, &'static str) {
    match asset {
        "b_workshop" => ("水车工坊", "/runtimes"),
        "b_library" => ("藏书阁", "/team/skills"),
        "b_guild_hall" => ("档案厅", "/agents"),
        "b_warehouse" => ("粮仓货栈", "panel:warehouse"),
        "b_stall" => ("市集小摊", "panel:shop"),
        "b_task_board" => ("工单牌楼", "/issues"),
        "b_trophy_arch" => ("成就牌坊", "panel:achievements"),
        "b_radio_kiosk" => ("电台日志亭", "panel:log"),
        "b_orchestrator_desk" => ("主助手凉亭", "chat"),
        _ => ("纸艺建筑", "custom"),
    }
}

pub fn prop_display_label(asset: &str) -> &'static str {
    match asset {
        "p_lantern" => "江南石灯笼",
        "p_tree_pine" => "迎客青松",
        "p_tree_oak" => "垂荫古树",
        "p_willow" => "河畔垂柳",
        "p_bamboo" => "翠竹丛",
        "p_bush" => "庭院灌木",
        "p_flower_bush" => "花境灌木",
        "p_reed" => "水畔芦苇",
        "p_bridge_arch" => "江南石拱桥",
        "p_boat" => "乌篷画舫",
        "p_dock_crates" => "码头木箱",
        "p_fence" => "竹木栅栏",
        "p_house_a" => "粉墙民居",
        "p_house_b" => "黛瓦民居",
        "p_terrace_hill" => "叠翠假山",
        "p_mountain_ridge" => "远山剪影",
        _ => "庭院景物",
    }
}

pub fn helper_display_info(asset: &str) -> (&'static str, &'static str, &'static str) {
    match asset {
        "h_bear" => ("Bear Architect", "架构师", "skills"),
        "h_fox" => ("Fox Coder", "程序员", "runtimes"),
        "h_owl" => ("Owl Reviewer", "审查员", "taskBoard"),
        "h_shiba" => ("Shiba Tester", "测试员", "runtimes"),
        "h_cat" => ("Cat Designer", "设计师", "shop"),
        "h_rabbit" => ("Rabbit Lead", "主助手", "manager"),
        _ => ("Paper Helper", "帮工", "manager"),
    }
}

pub struct DioramaWorld {
    pub plots: Vec<PlotState>,
    pub buildings: Vec<BuildingState>,
    pub props: Vec<PropState>,
    pub helpers: Vec<HelperState>,
    pub camera: CameraRig,
    pub time_of_day: TimeOfDay,
    pub prev_tod: TimeOfDay,
    pub tod_blend: f32,
    pub hovered: Option<DioramaHit>,
    pub selected: Option<DioramaHit>,
    pub editor_cursor: Option<EditorCursor>,
    pub elapsed: f32,
    pub pending_sounds: Vec<SoundKind>,
    pub ground_size: f32,
    pub active_preset: String,
    pub roof_cutaway_open: bool,
    pub roof_cutaway_spring: FlapSpring,
    pub show_routes: bool,
    pub nav: NavGraph,
    pub harvest_count: u32,
    pub focused_building: Option<String>,
    available_meshes: BTreeSet<String>,
    mesh_bones: BTreeMap<String, Vec<BoneDesc>>,
    base_scene: SceneSpec,
    undo_stack: Vec<EditAction>,
    redo_stack: Vec<EditAction>,
    atlas_cache: BTreeMap<String, AtlasSnapshot>,
    next_dynamic_seq: u32,
}

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

fn build_scene_entities(scene: &SceneSpec) -> (Vec<PlotState>, Vec<BuildingState>, Vec<PropState>, Vec<HelperState>) {
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

type PresetEntities = (Vec<PlotState>, Vec<BuildingState>, Vec<PropState>, Vec<HelperState>);

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
                // Start Cat at Bridge #1 west landing heading over the arched stone bridge to Market Stall
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
                // Start Fox at Bridge #2 west landing heading over Bridge #2 to the Waterwheel Workshop
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
            } else if h.id == "reviewer" {
                // Start Owl walking northward along the central stone promenade toward Guild Hall
                // so back-side craft (apron straps, head back, tail) is immediately visible in motion!
                if let Some(start_idx) = nav.node_by_tag("plaza_center") {
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
            // Home helper cheers with a crisp cardboard flip on harvest!
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
        for slot in urgent_plots {
            self.recall_helper_to_plot(slot);
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

    // -------------------------------------------------------------------------
    // Interactive Map Editor APIs
    // -------------------------------------------------------------------------

    /// Raycasts from NDC (`[-1, 1]`) onto the `y = 0` ground board, returning a snapped `(x, z)` coordinate.
    pub fn raycast_ground(&self, ndc_x: f32, ndc_y: f32, aspect: f32) -> Option<(f32, f32)> {
        pick_raycast_ground(self, ndc_x, ndc_y, aspect)
    }

    /// Validates terrain & places a new building, prop, helper, or updates a plot stage on a live
    /// `FlapSpring` hinge. Returns `Err(reason)` + queues `SoundKind::AlertSoft` when blocked (e.g.,
    /// placing a land building inside the canal or placing a boat on dry land).
    pub fn try_place_entity(&mut self, kind: EntityKind, asset_id: &str, x: f32, z: f32, yaw_deg: f32, scale: f32) -> Result<DioramaHit, String> {
        let margin = (self.ground_size * 0.5 - 0.5).max(1.0);
        let sx = snap_coord(x).clamp(-margin, margin);
        let sz = snap_coord(z).clamp(-margin, margin);

        if let PlacementStatus::Blocked(reason) = validate_placement(kind, asset_id, sx, sz, &self.buildings, &self.props) {
            self.pending_sounds.push(SoundKind::AlertSoft);
            return Err(reason);
        }

        let yaw_rad = yaw_deg.to_radians();
        let seq = self.next_dynamic_seq;
        self.next_dynamic_seq = self.next_dynamic_seq.wrapping_add(1).max(1);

        match kind {
            EntityKind::Building => {
                let (label, opens) = building_display_info(asset_id);
                let id = format!("dyn_bldg_{seq}");
                let mut spring = FlapSpring::new(0.0, (seq as f32) * 0.7, 0.0);
                spring.fold_down_and_rise(0.0);
                let s = if scale > 0.1 { scale } else { 1.95 };
                let state = BuildingState {
                    id: id.clone(),
                    label: label.into(),
                    opens: opens.into(),
                    asset: asset_id.into(),
                    pos: Vec3::new(sx, 0.0, sz),
                    scale: s,
                    yaw_rad,
                    spring,
                    is_dynamic: true,
                };
                self.buildings.push(state.clone());
                self.push_undo(EditAction::PlaceBuilding { state });
                self.rebuild_nav_and_repath();
                self.pending_sounds.push(SoundKind::FoldUp);
                let hit = DioramaHit::Building {
                    id,
                    label: label.into(),
                    opens: opens.into(),
                };
                self.selected = Some(hit.clone());
                Ok(hit)
            }
            EntityKind::Prop => {
                let id = format!("dyn_prop_{seq}");
                let is_lamp = asset_id.contains("lantern") || asset_id.contains("lamp");
                let sway = if is_lamp { 0.0 } else { 0.035 };
                let mut spring = FlapSpring::new(0.0, (seq as f32) * 1.1, sway);
                spring.fold_down_and_rise(0.0);
                let default_scale = if is_lamp {
                    1.08
                } else if asset_id.contains("tree") {
                    1.95
                } else {
                    0.95
                };
                let s = if scale > 0.1 { scale } else { default_scale };
                let state = PropState {
                    id: id.clone(),
                    asset: asset_id.into(),
                    pos: Vec3::new(sx, 0.0, sz),
                    scale: s,
                    yaw_rad,
                    is_lamp,
                    spring,
                    is_dynamic: true,
                };
                self.props.push(state.clone());
                self.push_undo(EditAction::PlaceProp { state });
                if asset_id == "p_bridge_arch" {
                    self.rebuild_nav_and_repath();
                }
                self.pending_sounds.push(SoundKind::FoldUp);
                let hit = DioramaHit::Prop {
                    id,
                    asset: asset_id.into(),
                    label: prop_display_label(asset_id).into(),
                    is_lamp,
                };
                self.selected = Some(hit.clone());
                Ok(hit)
            }
            EntityKind::Helper => {
                let (name, role, default_spot) = helper_display_info(asset_id);
                let id = format!("dyn_helper_{seq}");
                let mut spring = FlapSpring::new(0.0, (seq as f32) * 0.9, 0.018);
                spring.fold_down_and_rise(0.0);
                let pos = Vec3::new(sx, surface_height_at(&self.props, sx, sz), sz);
                let home_plot = self
                    .plots
                    .iter()
                    .enumerate()
                    .min_by(|(_, a), (_, b)| {
                        let da = (a.pos.x - sx).hypot(a.pos.z - sz);
                        let db = (b.pos.x - sx).hypot(b.pos.z - sz);
                        da.total_cmp(&db)
                    })
                    .map(|(idx, _)| idx)
                    .unwrap_or(0);
                let s = if scale > 0.1 { scale } else { 1.02 };
                let init_state = self
                    .plots
                    .get(home_plot)
                    .map(|pl| PuppetAnimState::for_plot_stage(pl.stage))
                    .unwrap_or(PuppetAnimState::Idle);
                let state = HelperState {
                    id: id.clone(),
                    name: name.into(),
                    role: role.into(),
                    asset: asset_id.into(),
                    home_plot,
                    default_spot: default_spot.into(),
                    pos,
                    target_pos: pos,
                    path: Vec::new(),
                    going_to_building: true,
                    yaw_rad,
                    yaw_vel: 0.0,
                    slope_pitch: 0.0,
                    scale: s,
                    wait_timer: 4.5,
                    celebrate_timer: 0.0,
                    walk_phase: 0.0,
                    spring,
                    rig: PuppetRig::new(init_state, seq as f32 * 1.31),
                    is_dynamic: true,
                };
                self.helpers.push(state.clone());
                self.push_undo(EditAction::PlaceHelper { state });
                self.pending_sounds.push(SoundKind::PaperStep);
                let hit = DioramaHit::Helper {
                    id,
                    name: name.into(),
                    role: role.into(),
                    anim_state: init_state,
                };
                self.selected = Some(hit.clone());
                Ok(hit)
            }
            EntityKind::Plot => {
                let stage = PlotStage::from_key(asset_id).unwrap_or(PlotStage::Flowering);
                let Some(plot_idx) = self
                    .plots
                    .iter()
                    .enumerate()
                    .min_by(|(_, a), (_, b)| {
                        let da = (a.pos.x - x).hypot(a.pos.z - z);
                        let db = (b.pos.x - x).hypot(b.pos.z - z);
                        da.total_cmp(&db)
                    })
                    .and_then(|(idx, p)| if (p.pos.x - x).hypot(p.pos.z - z) <= 2.4 { Some(idx) } else { None })
                    .or(match &self.selected {
                        Some(DioramaHit::Plot { index, .. }) => Some(*index),
                        _ => None,
                    })
                else {
                    return Err("请点击农田地块以修改作物状态".into());
                };
                self.set_plot_stage(plot_idx, stage);
                let p = &self.plots[plot_idx];
                let hit = DioramaHit::Plot {
                    index: p.index,
                    stage: p.stage,
                    title: p.title.clone(),
                };
                self.selected = Some(hit.clone());
                Ok(hit)
            }
        }
    }

    /// Places a new building, prop, helper, or updates a plot stage on a live `FlapSpring` hinge.
    pub fn place_entity(&mut self, kind: EntityKind, asset_id: &str, x: f32, z: f32, yaw_deg: f32, scale: f32) -> Option<DioramaHit> {
        self.try_place_entity(kind, asset_id, x, z, yaw_deg, scale).ok()
    }

    /// Removes the explicitly provided entity hit, or falls back to removing `self.selected`.
    pub fn remove_entity_at_or_selected(&mut self, target: Option<&DioramaHit>) -> bool {
        let hit = match target.cloned().or_else(|| self.selected.clone()) {
            Some(h) => h,
            None => return false,
        };
        match hit {
            DioramaHit::Building { id, .. } => {
                if let Some(pos) = self.buildings.iter().position(|b| b.id == id) {
                    let state = self.buildings.remove(pos);
                    self.push_undo(EditAction::RemoveBuilding { index: pos, state });
                    if matches!(&self.selected, Some(DioramaHit::Building { id: sid, .. }) if sid == &id) {
                        self.selected = None;
                    }
                    if self.focused_building.as_deref() == Some(id.as_str()) {
                        self.exit_interior_focus();
                    }
                    self.rebuild_nav_and_repath();
                    self.pending_sounds.push(SoundKind::CardTap);
                    return true;
                }
            }
            DioramaHit::Prop { id, .. } => {
                if let Some(pos) = self.props.iter().position(|p| p.id == id) {
                    let state = self.props.remove(pos);
                    let was_bridge = state.asset == "p_bridge_arch";
                    self.push_undo(EditAction::RemoveProp { index: pos, state });
                    if matches!(&self.selected, Some(DioramaHit::Prop { id: sid, .. }) if sid == &id) {
                        self.selected = None;
                    }
                    if was_bridge {
                        self.rebuild_nav_and_repath();
                    }
                    self.pending_sounds.push(SoundKind::CardTap);
                    return true;
                }
            }
            DioramaHit::Helper { id, .. } => {
                if let Some(pos) = self.helpers.iter().position(|h| h.id == id) {
                    let state = self.helpers.remove(pos);
                    self.push_undo(EditAction::RemoveHelper { index: pos, state });
                    if matches!(&self.selected, Some(DioramaHit::Helper { id: sid, .. }) if sid == &id) {
                        self.selected = None;
                    }
                    self.pending_sounds.push(SoundKind::CardTap);
                    return true;
                }
            }
            DioramaHit::Plot { index, .. } => {
                if let Some(p) = self.plots.get(index)
                    && p.stage != PlotStage::Empty
                {
                    self.set_plot_stage(index, PlotStage::Empty);
                    if let Some(updated) = self.plots.get(index) {
                        self.selected = Some(DioramaHit::Plot {
                            index: updated.index,
                            stage: updated.stage,
                            title: updated.title.clone(),
                        });
                    }
                    return true;
                }
            }
            DioramaHit::Ground => {}
        }
        false
    }

    /// Removes the nearest building, prop, or helper within `max_dist` of `(x, z)`.
    pub fn remove_nearest_at(&mut self, x: f32, z: f32, max_dist: f32) -> bool {
        let mut best_score = max_dist;
        let mut best_hit: Option<DioramaHit> = None;

        for p in &self.props {
            let d = (p.pos.x - x).hypot(p.pos.z - z);
            let bias = if p.is_dynamic { 0.85 } else { 1.0 };
            if d < max_dist && d * bias < best_score {
                best_score = d * bias;
                best_hit = Some(DioramaHit::Prop {
                    id: p.id.clone(),
                    asset: p.asset.clone(),
                    label: prop_display_label(&p.asset).into(),
                    is_lamp: p.is_lamp,
                });
            }
        }
        for h in &self.helpers {
            let d = (h.pos.x - x).hypot(h.pos.z - z);
            let bias = if h.is_dynamic { 0.85 } else { 1.0 };
            if d < max_dist && d * bias < best_score {
                best_score = d * bias;
                best_hit = Some(DioramaHit::Helper {
                    id: h.id.clone(),
                    name: h.name.clone(),
                    role: h.role.clone(),
                    anim_state: h.rig.state,
                });
            }
        }
        for b in &self.buildings {
            let d = (b.pos.x - x).hypot(b.pos.z - z);
            let bias = if b.is_dynamic { 0.85 } else { 1.0 };
            if d < max_dist && d * bias < best_score {
                best_score = d * bias;
                best_hit = Some(DioramaHit::Building {
                    id: b.id.clone(),
                    label: b.label.clone(),
                    opens: b.opens.clone(),
                });
            }
        }

        if let Some(hit) = best_hit {
            self.remove_entity_at_or_selected(Some(&hit))
        } else {
            false
        }
    }

    /// Rotates the currently selected building, prop, or helper by `delta_deg` around the Y axis.
    pub fn rotate_selected(&mut self, delta_deg: f32) -> bool {
        self.transform_selected(0.0, 0.0, delta_deg.to_radians(), 0.0)
    }

    /// Nudges the currently selected building, prop, or helper along world X/Z.
    pub fn nudge_selected(&mut self, dx: f32, dz: f32) -> bool {
        self.transform_selected(dx, dz, 0.0, 0.0)
    }

    /// Adjusts the scale of the currently selected building, prop, or helper.
    pub fn scale_selected(&mut self, delta_scale: f32) -> bool {
        self.transform_selected(0.0, 0.0, 0.0, delta_scale)
    }

    fn transform_selected(&mut self, dx: f32, dz: f32, delta_yaw_rad: f32, delta_scale: f32) -> bool {
        let Some(sel) = self.selected.clone() else {
            return false;
        };
        let margin = (self.ground_size * 0.5 - 0.5).max(1.0);
        match &sel {
            DioramaHit::Building { id, .. } => {
                if let Some(b) = self.buildings.iter_mut().find(|b| &b.id == id) {
                    let prev_pos = b.pos;
                    let prev_yaw_rad = b.yaw_rad;
                    let prev_scale = b.scale;
                    b.pos.x = (b.pos.x + dx).clamp(-margin, margin);
                    b.pos.z = (b.pos.z + dz).clamp(-margin, margin);
                    b.yaw_rad += delta_yaw_rad;
                    b.scale = (b.scale + delta_scale).clamp(0.45, 3.6);
                    b.spring.impulse(3.0);
                    let new_pos = b.pos;
                    let new_yaw_rad = b.yaw_rad;
                    let new_scale = b.scale;
                    self.push_undo(EditAction::TransformEntity {
                        target: sel,
                        prev_pos,
                        prev_yaw_rad,
                        prev_scale,
                        new_pos,
                        new_yaw_rad,
                        new_scale,
                    });
                    if dx.abs() > 1e-4 || dz.abs() > 1e-4 {
                        self.rebuild_nav_and_repath();
                    }
                    self.pending_sounds.push(SoundKind::CardTap);
                    return true;
                }
            }
            DioramaHit::Prop { id, .. } => {
                if let Some(p) = self.props.iter_mut().find(|p| &p.id == id) {
                    let is_bridge = p.asset == "p_bridge_arch";
                    let prev_pos = p.pos;
                    let prev_yaw_rad = p.yaw_rad;
                    let prev_scale = p.scale;
                    p.pos.x = (p.pos.x + dx).clamp(-margin, margin);
                    p.pos.z = (p.pos.z + dz).clamp(-margin, margin);
                    p.yaw_rad += delta_yaw_rad;
                    p.scale = (p.scale + delta_scale).clamp(0.45, 3.6);
                    p.spring.impulse(3.4);
                    let new_pos = p.pos;
                    let new_yaw_rad = p.yaw_rad;
                    let new_scale = p.scale;
                    self.push_undo(EditAction::TransformEntity {
                        target: sel,
                        prev_pos,
                        prev_yaw_rad,
                        prev_scale,
                        new_pos,
                        new_yaw_rad,
                        new_scale,
                    });
                    if is_bridge {
                        self.rebuild_nav_and_repath();
                    }
                    self.pending_sounds.push(SoundKind::CardTap);
                    return true;
                }
            }
            DioramaHit::Helper { id, .. } => {
                if let Some(h) = self.helpers.iter_mut().find(|h| &h.id == id) {
                    let prev_pos = h.pos;
                    let prev_yaw_rad = h.yaw_rad;
                    let prev_scale = h.scale;
                    h.pos.x = (h.pos.x + dx).clamp(-margin, margin);
                    h.pos.z = (h.pos.z + dz).clamp(-margin, margin);
                    h.target_pos = h.pos;
                    h.wait_timer = 5.0;
                    h.yaw_rad += delta_yaw_rad;
                    h.scale = (h.scale + delta_scale).clamp(0.5, 2.4);
                    h.spring.impulse(3.8);
                    let new_pos = h.pos;
                    let new_yaw_rad = h.yaw_rad;
                    let new_scale = h.scale;
                    self.push_undo(EditAction::TransformEntity {
                        target: sel,
                        prev_pos,
                        prev_yaw_rad,
                        prev_scale,
                        new_pos,
                        new_yaw_rad,
                        new_scale,
                    });
                    self.pending_sounds.push(SoundKind::PaperStep);
                    return true;
                }
            }
            _ => {}
        }
        false
    }

    fn apply_entity_transform(&mut self, target: &DioramaHit, pos: Vec3, yaw_rad: f32, scale: f32) {
        match target {
            DioramaHit::Building { id, .. } => {
                if let Some(b) = self.buildings.iter_mut().find(|b| &b.id == id) {
                    b.pos = pos;
                    b.yaw_rad = yaw_rad;
                    b.scale = scale;
                    b.spring.impulse(2.5);
                }
            }
            DioramaHit::Prop { id, .. } => {
                if let Some(p) = self.props.iter_mut().find(|p| &p.id == id) {
                    p.pos = pos;
                    p.yaw_rad = yaw_rad;
                    p.scale = scale;
                    p.spring.impulse(2.5);
                }
            }
            DioramaHit::Helper { id, .. } => {
                if let Some(h) = self.helpers.iter_mut().find(|h| &h.id == id) {
                    h.pos = pos;
                    h.target_pos = pos;
                    h.yaw_rad = yaw_rad;
                    h.scale = scale;
                    h.spring.impulse(2.5);
                }
            }
            _ => {}
        }
    }

    /// Returns the live transform of `self.selected` for the Editor Inspector.
    pub fn selected_transform(&self) -> Option<SelectedTransform> {
        let r2 = |v: f32| (v * 100.0).round() / 100.0;
        let norm_deg = |rad: f32| {
            let d = rad.to_degrees().rem_euclid(360.0);
            r2(if d > 359.95 { 0.0 } else { d })
        };
        match self.selected.as_ref()? {
            DioramaHit::Building { id, .. } => self.buildings.iter().find(|b| &b.id == id).map(|b| SelectedTransform {
                x: r2(b.pos.x),
                z: r2(b.pos.z),
                yaw_deg: norm_deg(b.yaw_rad),
                scale: r2(b.scale),
                can_transform: true,
            }),
            DioramaHit::Prop { id, .. } => self.props.iter().find(|p| &p.id == id).map(|p| SelectedTransform {
                x: r2(p.pos.x),
                z: r2(p.pos.z),
                yaw_deg: norm_deg(p.yaw_rad),
                scale: r2(p.scale),
                can_transform: true,
            }),
            DioramaHit::Helper { id, .. } => self.helpers.iter().find(|h| &h.id == id).map(|h| SelectedTransform {
                x: r2(h.pos.x),
                z: r2(h.pos.z),
                yaw_deg: norm_deg(h.yaw_rad),
                scale: r2(h.scale),
                can_transform: true,
            }),
            DioramaHit::Plot { index, .. } => self.plots.get(*index).map(|p| SelectedTransform {
                x: r2(p.pos.x),
                z: r2(p.pos.z),
                yaw_deg: 0.0,
                scale: 1.0,
                can_transform: false,
            }),
            DioramaHit::Ground => None,
        }
    }

    fn push_undo(&mut self, action: EditAction) {
        self.undo_stack.push(action);
        self.redo_stack.clear();
    }

    /// Reverts the most recent editor mutation and pushes its inverse onto the redo stack.
    pub fn undo_last_edit(&mut self) -> bool {
        let Some(action) = self.undo_stack.pop() else {
            return false;
        };
        match action {
            EditAction::PlaceBuilding { state } => {
                let id = state.id.clone();
                let removed = self
                    .buildings
                    .iter()
                    .position(|b| b.id == id)
                    .map(|idx| self.buildings.remove(idx))
                    .unwrap_or(state);
                if matches!(&self.selected, Some(DioramaHit::Building { id: sid, .. }) if sid == &id) {
                    self.selected = None;
                }
                self.redo_stack.push(EditAction::PlaceBuilding { state: removed });
            }
            EditAction::RemoveBuilding { index, mut state } => {
                state.spring.fold_down_and_rise(0.0);
                let restored_hit = DioramaHit::Building {
                    id: state.id.clone(),
                    label: state.label.clone(),
                    opens: state.opens.clone(),
                };
                let idx = index.min(self.buildings.len());
                self.buildings.insert(idx, state.clone());
                self.selected = Some(restored_hit);
                self.redo_stack.push(EditAction::RemoveBuilding { index: idx, state });
            }
            EditAction::PlaceProp { state } => {
                let id = state.id.clone();
                let removed = self.props.iter().position(|p| p.id == id).map(|idx| self.props.remove(idx)).unwrap_or(state);
                if matches!(&self.selected, Some(DioramaHit::Prop { id: sid, .. }) if sid == &id) {
                    self.selected = None;
                }
                self.redo_stack.push(EditAction::PlaceProp { state: removed });
            }
            EditAction::RemoveProp { index, mut state } => {
                state.spring.fold_down_and_rise(0.0);
                let restored_hit = DioramaHit::Prop {
                    id: state.id.clone(),
                    asset: state.asset.clone(),
                    label: prop_display_label(&state.asset).into(),
                    is_lamp: state.is_lamp,
                };
                let idx = index.min(self.props.len());
                self.props.insert(idx, state.clone());
                self.selected = Some(restored_hit);
                self.redo_stack.push(EditAction::RemoveProp { index: idx, state });
            }
            EditAction::PlaceHelper { state } => {
                let id = state.id.clone();
                let removed = self
                    .helpers
                    .iter()
                    .position(|h| h.id == id)
                    .map(|idx| self.helpers.remove(idx))
                    .unwrap_or(state);
                if matches!(&self.selected, Some(DioramaHit::Helper { id: sid, .. }) if sid == &id) {
                    self.selected = None;
                }
                self.redo_stack.push(EditAction::PlaceHelper { state: removed });
            }
            EditAction::RemoveHelper { index, mut state } => {
                state.spring.fold_down_and_rise(0.0);
                let restored_hit = DioramaHit::Helper {
                    id: state.id.clone(),
                    name: state.name.clone(),
                    role: state.role.clone(),
                    anim_state: state.rig.state,
                };
                let idx = index.min(self.helpers.len());
                self.helpers.insert(idx, state.clone());
                self.selected = Some(restored_hit);
                self.redo_stack.push(EditAction::RemoveHelper { index: idx, state });
            }
            EditAction::TransformEntity {
                target,
                prev_pos,
                prev_yaw_rad,
                prev_scale,
                new_pos,
                new_yaw_rad,
                new_scale,
            } => {
                self.apply_entity_transform(&target, prev_pos, prev_yaw_rad, prev_scale);
                self.selected = Some(target.clone());
                self.redo_stack.push(EditAction::TransformEntity {
                    target,
                    prev_pos,
                    prev_yaw_rad,
                    prev_scale,
                    new_pos,
                    new_yaw_rad,
                    new_scale,
                });
            }
            EditAction::SetPlotStage {
                index,
                prev_stage,
                prev_title,
                new_stage,
                new_title,
            } => {
                if let Some(p) = self.plots.get_mut(index) {
                    p.stage = prev_stage;
                    p.title = prev_title.clone();
                    p.crop_spring.fold_down_and_rise(0.0);
                    p.sign_spring.fold_down_and_rise(0.05);
                    self.selected = Some(DioramaHit::Plot {
                        index: p.index,
                        stage: p.stage,
                        title: p.title.clone(),
                    });
                }
                self.redo_stack.push(EditAction::SetPlotStage {
                    index,
                    prev_stage,
                    prev_title,
                    new_stage,
                    new_title,
                });
            }
            EditAction::Snapshot {
                plots,
                buildings,
                props,
                helpers,
                preset,
            } => {
                let redo_snap = EditAction::Snapshot {
                    plots: self.plots.clone(),
                    buildings: self.buildings.clone(),
                    props: self.props.clone(),
                    helpers: self.helpers.clone(),
                    preset: self.active_preset.clone(),
                };
                self.plots = plots;
                self.buildings = buildings;
                self.props = props;
                self.helpers = helpers;
                self.active_preset = preset;
                self.selected = None;
                self.redo_stack.push(redo_snap);
                self.trigger_fold_wave();
            }
        }
        self.rebuild_nav_and_repath();
        self.pending_sounds.push(SoundKind::CardTap);
        true
    }

    /// Re-applies the most recently undone editor mutation.
    pub fn redo_last_edit(&mut self) -> bool {
        let Some(action) = self.redo_stack.pop() else {
            return false;
        };
        match action {
            EditAction::PlaceBuilding { mut state } => {
                state.spring.fold_down_and_rise(0.0);
                let hit = DioramaHit::Building {
                    id: state.id.clone(),
                    label: state.label.clone(),
                    opens: state.opens.clone(),
                };
                self.buildings.push(state.clone());
                self.selected = Some(hit);
                self.undo_stack.push(EditAction::PlaceBuilding { state });
                self.pending_sounds.push(SoundKind::FoldUp);
            }
            EditAction::RemoveBuilding { index, state } => {
                let id = state.id.clone();
                let removed = self
                    .buildings
                    .iter()
                    .position(|b| b.id == id)
                    .map(|idx| self.buildings.remove(idx))
                    .unwrap_or(state);
                if matches!(&self.selected, Some(DioramaHit::Building { id: sid, .. }) if sid == &id) {
                    self.selected = None;
                }
                self.undo_stack.push(EditAction::RemoveBuilding { index, state: removed });
                self.pending_sounds.push(SoundKind::CardTap);
            }
            EditAction::PlaceProp { mut state } => {
                state.spring.fold_down_and_rise(0.0);
                let hit = DioramaHit::Prop {
                    id: state.id.clone(),
                    asset: state.asset.clone(),
                    label: prop_display_label(&state.asset).into(),
                    is_lamp: state.is_lamp,
                };
                self.props.push(state.clone());
                self.selected = Some(hit);
                self.undo_stack.push(EditAction::PlaceProp { state });
                self.pending_sounds.push(SoundKind::FoldUp);
            }
            EditAction::RemoveProp { index, state } => {
                let id = state.id.clone();
                let removed = self.props.iter().position(|p| p.id == id).map(|idx| self.props.remove(idx)).unwrap_or(state);
                if matches!(&self.selected, Some(DioramaHit::Prop { id: sid, .. }) if sid == &id) {
                    self.selected = None;
                }
                self.undo_stack.push(EditAction::RemoveProp { index, state: removed });
                self.pending_sounds.push(SoundKind::CardTap);
            }
            EditAction::PlaceHelper { mut state } => {
                state.spring.fold_down_and_rise(0.0);
                let hit = DioramaHit::Helper {
                    id: state.id.clone(),
                    name: state.name.clone(),
                    role: state.role.clone(),
                    anim_state: state.rig.state,
                };
                self.helpers.push(state.clone());
                self.selected = Some(hit);
                self.undo_stack.push(EditAction::PlaceHelper { state });
                self.pending_sounds.push(SoundKind::PaperStep);
            }
            EditAction::RemoveHelper { index, state } => {
                let id = state.id.clone();
                let removed = self
                    .helpers
                    .iter()
                    .position(|h| h.id == id)
                    .map(|idx| self.helpers.remove(idx))
                    .unwrap_or(state);
                if matches!(&self.selected, Some(DioramaHit::Helper { id: sid, .. }) if sid == &id) {
                    self.selected = None;
                }
                self.undo_stack.push(EditAction::RemoveHelper { index, state: removed });
                self.pending_sounds.push(SoundKind::CardTap);
            }
            EditAction::TransformEntity {
                target,
                prev_pos,
                prev_yaw_rad,
                prev_scale,
                new_pos,
                new_yaw_rad,
                new_scale,
            } => {
                self.apply_entity_transform(&target, new_pos, new_yaw_rad, new_scale);
                self.selected = Some(target.clone());
                self.undo_stack.push(EditAction::TransformEntity {
                    target,
                    prev_pos,
                    prev_yaw_rad,
                    prev_scale,
                    new_pos,
                    new_yaw_rad,
                    new_scale,
                });
                self.pending_sounds.push(SoundKind::CardTap);
            }
            EditAction::SetPlotStage {
                index,
                prev_stage,
                prev_title,
                new_stage,
                new_title,
            } => {
                if let Some(p) = self.plots.get_mut(index) {
                    p.stage = new_stage;
                    p.title = new_title.clone();
                    p.crop_spring.fold_down_and_rise(0.0);
                    p.sign_spring.fold_down_and_rise(0.05);
                    self.selected = Some(DioramaHit::Plot {
                        index: p.index,
                        stage: p.stage,
                        title: p.title.clone(),
                    });
                }
                self.undo_stack.push(EditAction::SetPlotStage {
                    index,
                    prev_stage,
                    prev_title,
                    new_stage,
                    new_title,
                });
                self.pending_sounds.push(SoundKind::FoldUp);
            }
            EditAction::Snapshot {
                plots,
                buildings,
                props,
                helpers,
                preset,
            } => {
                let undo_snap = EditAction::Snapshot {
                    plots: self.plots.clone(),
                    buildings: self.buildings.clone(),
                    props: self.props.clone(),
                    helpers: self.helpers.clone(),
                    preset: self.active_preset.clone(),
                };
                self.plots = plots;
                self.buildings = buildings;
                self.props = props;
                self.helpers = helpers;
                self.active_preset = preset;
                self.selected = None;
                self.undo_stack.push(undo_snap);
                self.trigger_fold_wave();
            }
        }
        self.rebuild_nav_and_repath();
        true
    }

    /// Removes all dynamically added editor entities (buildings, props, helpers). Undoable.
    pub fn clear_dynamic_edits(&mut self) -> bool {
        if self.dynamic_entity_count() == 0 {
            return false;
        }
        self.push_snapshot();
        self.buildings.retain(|b| !b.is_dynamic);
        self.props.retain(|p| !p.is_dynamic);
        self.helpers.retain(|h| !h.is_dynamic);
        self.selected = None;
        self.rebuild_nav_and_repath();
        self.pending_sounds.push(SoundKind::CardTap);
        true
    }

    fn build_preset_layout(&mut self, preset_id: &str) -> Option<PresetEntities> {
        if !matches!(preset_id, "fullTown" | "starterFarm" | "busyFactory") {
            return None;
        }
        let (mut plots, mut buildings, mut props, mut helpers) = build_scene_entities(&self.base_scene);

        match preset_id {
            "fullTown" => {}
            "starterFarm" => {
                let starter_stages = [
                    PlotStage::Reviewing,
                    PlotStage::Sprout,
                    PlotStage::Seeded,
                    PlotStage::Leafy,
                    PlotStage::Empty,
                    PlotStage::Empty,
                    PlotStage::Empty,
                    PlotStage::Empty,
                    PlotStage::Empty,
                ];
                for (i, p) in plots.iter_mut().enumerate() {
                    p.stage = starter_stages[i % starter_stages.len()];
                }
                let keep_bldgs = ["taskBoard", "runtimes", "warehouse", "manager"];
                buildings.retain(|b| keep_bldgs.iter().any(|k| *k == b.id));
                props.retain(|p| p.is_lamp || p.pos.z < -4.0 || p.pos.x < -5.5);
                let keep_helpers = ["coder", "reviewer", "orchestrator"];
                helpers.retain(|h| keep_helpers.iter().any(|k| *k == h.id));
            }
            "busyFactory" => {
                let factory_stages = [
                    PlotStage::Reviewing,
                    PlotStage::Flowering,
                    PlotStage::Asking,
                    PlotStage::Leafy,
                    PlotStage::Reviewing,
                    PlotStage::Sprout,
                    PlotStage::Conflict,
                    PlotStage::Seeded,
                    PlotStage::Reviewing,
                ];
                for (i, p) in plots.iter_mut().enumerate() {
                    p.stage = factory_stages[i % factory_stages.len()];
                }
                let extras: [(&str, f32, f32, f32, f32, bool); 6] = [
                    ("p_lantern", -1.5, -4.5, 0.0, 1.12, true),
                    ("p_lantern", 1.5, -4.5, 0.0, 1.12, true),
                    ("p_lantern", -1.5, 4.5, 0.0, 1.12, true),
                    ("p_lantern", 1.5, 4.5, 0.0, 1.12, true),
                    ("p_bush", -5.5, 0.0, 12.0, 0.98, false),
                    ("p_bush", 5.5, 0.0, -14.0, 0.98, false),
                ];
                for (asset, x, z, yaw_deg, scale, is_lamp) in extras {
                    let seq = self.next_dynamic_seq;
                    self.next_dynamic_seq += 1;
                    let mut spring = FlapSpring::new(0.0, seq as f32 * 0.8, if is_lamp { 0.0 } else { 0.03 });
                    spring.fold_down_and_rise(0.12);
                    props.push(PropState {
                        id: format!("dyn_prop_{seq}"),
                        asset: asset.into(),
                        pos: Vec3::new(x, 0.0, z),
                        scale,
                        yaw_rad: yaw_deg.to_radians(),
                        is_lamp,
                        spring,
                        is_dynamic: true,
                    });
                }
            }
            _ => unreachable!(),
        }

        Some((plots, buildings, props, helpers))
    }

    /// Resets the scene to a clean named map preset (`"fullTown"`, `"starterFarm"`, `"busyFactory"`). Undoable.
    pub fn apply_map_preset(&mut self, preset_id: &str) -> bool {
        let Some((plots, buildings, props, helpers)) = self.build_preset_layout(preset_id) else {
            return false;
        };
        self.push_snapshot();
        self.plots = plots;
        self.buildings = buildings;
        self.props = props;
        self.helpers = helpers;
        self.active_preset = preset_id.into();
        self.atlas_cache.remove(preset_id);
        self.selected = None;
        self.exit_interior_focus();
        self.rebuild_nav_and_repath();
        self.trigger_fold_wave();
        true
    }

    /// Switches between project Atlas maps (`fullTown` / `starterFarm` / `busyFactory`), preserving
    /// each map's session edits, undo stack, and redo stack in memory.
    pub fn switch_atlas_map(&mut self, preset_id: &str) -> bool {
        if !matches!(preset_id, "fullTown" | "starterFarm" | "busyFactory") {
            return false;
        }
        if self.active_preset == preset_id {
            return true;
        }

        // Save current map's live edits into session atlas cache
        let current_key = self.active_preset.clone();
        self.atlas_cache.insert(
            current_key,
            AtlasSnapshot {
                plots: self.plots.clone(),
                buildings: self.buildings.clone(),
                props: self.props.clone(),
                helpers: self.helpers.clone(),
                undo_stack: self.undo_stack.clone(),
                redo_stack: self.redo_stack.clone(),
            },
        );

        if let Some(saved) = self.atlas_cache.remove(preset_id) {
            self.plots = saved.plots;
            self.buildings = saved.buildings;
            self.props = saved.props;
            self.helpers = saved.helpers;
            self.undo_stack = saved.undo_stack;
            self.redo_stack = saved.redo_stack;
        } else if let Some((plots, buildings, props, helpers)) = self.build_preset_layout(preset_id) {
            self.plots = plots;
            self.buildings = buildings;
            self.props = props;
            self.helpers = helpers;
            self.undo_stack.clear();
            self.redo_stack.clear();
        }

        self.active_preset = preset_id.into();
        self.selected = None;
        self.exit_interior_focus();
        self.rebuild_nav_and_repath();
        self.trigger_fold_wave();
        true
    }

    /// Returns preset keys that currently hold saved session edits in the Atlas cache (plus active if modified).
    pub fn atlas_saved_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self
            .atlas_cache
            .iter()
            .filter(|(_, snap)| {
                !snap.undo_stack.is_empty()
                    || snap.buildings.iter().any(|b| b.is_dynamic)
                    || snap.props.iter().any(|p| p.is_dynamic)
                    || snap.helpers.iter().any(|h| h.is_dynamic)
            })
            .map(|(k, _)| k.clone())
            .collect();
        if (!self.undo_stack.is_empty() || self.dynamic_entity_count() > 0) && !keys.iter().any(|k| k == &self.active_preset) {
            keys.push(self.active_preset.clone());
        }
        keys.sort();
        keys
    }

    /// Imports and applies a serialized scene JSON document (compatible with `export_scene_json()`).
    /// Undoable via `undo_last_edit()`.
    pub fn import_scene_json(&mut self, json: &str) -> Result<usize, String> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ImportPlot {
            index: usize,
            pos: [f32; 3],
            #[serde(default = "default_plot_size")]
            size: [f32; 2],
            stage: PlotStage,
            #[serde(default)]
            title: String,
        }
        fn default_plot_size() -> [f32; 2] {
            [2.1, 2.1]
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ImportBuilding {
            id: String,
            #[serde(default)]
            label: String,
            #[serde(default)]
            opens: String,
            asset: String,
            pos: [f32; 3],
            #[serde(default = "default_bldg_scale")]
            scale: f32,
            #[serde(default)]
            yaw_deg: f32,
            #[serde(default)]
            is_dynamic: bool,
        }
        fn default_bldg_scale() -> f32 {
            2.0
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ImportProp {
            #[serde(default)]
            id: String,
            asset: String,
            pos: [f32; 3],
            #[serde(default = "default_prop_scale")]
            scale: f32,
            #[serde(default)]
            yaw_deg: f32,
            #[serde(default)]
            is_lamp: bool,
            #[serde(default)]
            is_dynamic: bool,
        }
        fn default_prop_scale() -> f32 {
            1.0
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ImportHelper {
            id: String,
            #[serde(default)]
            name: String,
            #[serde(default)]
            role: String,
            asset: String,
            #[serde(default)]
            home_plot: usize,
            #[serde(default)]
            default_spot: String,
            #[serde(default)]
            pos: [f32; 3],
            #[serde(default)]
            yaw_deg: f32,
            #[serde(default = "default_helper_scale")]
            scale: f32,
            #[serde(default)]
            is_dynamic: bool,
        }
        fn default_helper_scale() -> f32 {
            1.02
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ImportDoc {
            #[serde(default)]
            preset: Option<String>,
            #[serde(default)]
            time_of_day: Option<TimeOfDay>,
            #[serde(default)]
            plots: Vec<ImportPlot>,
            #[serde(default)]
            buildings: Vec<ImportBuilding>,
            #[serde(default)]
            props: Vec<ImportProp>,
            #[serde(default)]
            helpers: Vec<ImportHelper>,
        }

        let trimmed = json.trim();
        if trimmed.is_empty() {
            return Err("JSON 内容为空".into());
        }
        let doc: ImportDoc = serde_json::from_str(trimmed).map_err(|e| format!("JSON 解析失败: {e}"))?;
        let total = doc.plots.len() + doc.buildings.len() + doc.props.len() + doc.helpers.len();
        if total == 0 {
            return Err("场景 JSON 中未包含任何地块、建筑、景物或帮工".into());
        }

        self.push_snapshot();
        let margin = (self.ground_size * 0.5 - 0.25).max(1.0);

        self.plots = doc
            .plots
            .into_iter()
            .enumerate()
            .map(|(i, p)| {
                let mut crop_spring = FlapSpring::new(0.0, i as f32 * 0.9, 0.025);
                crop_spring.fold_down_and_rise(0.12 + i as f32 * 0.04);
                let mut sign_spring = FlapSpring::new(0.0, i as f32 * 1.3 + 0.5, 0.045);
                sign_spring.fold_down_and_rise(0.18 + i as f32 * 0.04);
                PlotState {
                    index: p.index,
                    pos: Vec3::new(p.pos[0].clamp(-margin, margin), 0.0, p.pos[2].clamp(-margin, margin)),
                    size: [p.size[0].clamp(0.8, 4.0), p.size[1].clamp(0.8, 4.0)],
                    stage: p.stage,
                    title: if p.title.is_empty() {
                        format!("导入地块 #{}", p.index + 1)
                    } else {
                        p.title
                    },
                    crop_spring,
                    sign_spring,
                    locked: false,
                }
            })
            .collect();

        self.buildings = doc
            .buildings
            .into_iter()
            .enumerate()
            .map(|(i, b)| {
                let (def_label, def_opens) = building_display_info(&b.asset);
                let mut spring = FlapSpring::new(0.0, i as f32 * 0.6, 0.0);
                spring.fold_down_and_rise(0.04 + i as f32 * 0.035);
                BuildingState {
                    id: b.id,
                    label: if b.label.is_empty() { def_label.into() } else { b.label },
                    opens: if b.opens.is_empty() { def_opens.into() } else { b.opens },
                    asset: b.asset,
                    pos: Vec3::new(b.pos[0].clamp(-margin, margin), 0.0, b.pos[2].clamp(-margin, margin)),
                    scale: b.scale.clamp(0.45, 3.6),
                    yaw_rad: b.yaw_deg.to_radians(),
                    spring,
                    is_dynamic: b.is_dynamic,
                }
            })
            .collect();

        self.props = doc
            .props
            .into_iter()
            .enumerate()
            .map(|(i, p)| {
                let is_lamp = p.is_lamp || p.asset.contains("lantern");
                let mut spring = FlapSpring::new(0.0, i as f32 * 1.1, if is_lamp { 0.0 } else { 0.035 });
                spring.fold_down_and_rise(0.06 + i as f32 * 0.02);
                PropState {
                    id: if p.id.is_empty() { format!("imp_prop_{i}") } else { p.id },
                    asset: p.asset,
                    pos: Vec3::new(p.pos[0].clamp(-margin, margin), 0.0, p.pos[2].clamp(-margin, margin)),
                    scale: p.scale.clamp(0.45, 3.6),
                    yaw_rad: p.yaw_deg.to_radians(),
                    is_lamp,
                    spring,
                    is_dynamic: p.is_dynamic,
                }
            })
            .collect();

        self.helpers = doc
            .helpers
            .into_iter()
            .enumerate()
            .map(|(i, h)| {
                let (def_name, def_role, def_spot) = helper_display_info(&h.asset);
                let mut spring = FlapSpring::new(0.0, i as f32 * 0.7, 0.018);
                spring.fold_down_and_rise(0.24 + i as f32 * 0.05);
                let pos = Vec3::new(h.pos[0].clamp(-margin, margin), 0.0, h.pos[2].clamp(-margin, margin));
                HelperState {
                    id: h.id,
                    name: if h.name.is_empty() { def_name.into() } else { h.name },
                    role: if h.role.is_empty() { def_role.into() } else { h.role },
                    asset: h.asset,
                    home_plot: h.home_plot,
                    default_spot: if h.default_spot.is_empty() { def_spot.into() } else { h.default_spot },
                    pos,
                    target_pos: pos,
                    path: Vec::new(),
                    going_to_building: i % 2 == 0,
                    yaw_rad: h.yaw_deg.to_radians(),
                    yaw_vel: 0.0,
                    slope_pitch: 0.0,
                    scale: h.scale.clamp(0.5, 2.4),
                    wait_timer: 2.5 + i as f32 * 0.8,
                    celebrate_timer: 0.0,
                    walk_phase: 0.0,
                    spring,
                    rig: PuppetRig::new(PuppetAnimState::Idle, 0.9 + i as f32 * 1.17),
                    is_dynamic: h.is_dynamic,
                }
            })
            .collect();

        if let Some(preset) = doc.preset
            && matches!(preset.as_str(), "fullTown" | "starterFarm" | "busyFactory")
        {
            self.active_preset = preset;
        }
        if let Some(tod) = doc.time_of_day {
            self.set_time_of_day(tod, false);
        }
        self.selected = None;
        self.exit_interior_focus();
        self.rebuild_nav_and_repath();
        self.trigger_fold_wave();
        Ok(total)
    }

    /// Pans the 3D camera target directly to `(world_x, world_z)` (used by minimap click-to-pan).
    pub fn pan_camera_to(&mut self, world_x: f32, world_z: f32) {
        let base_target = self.camera.view_params(1.0).target.sub(self.camera.pan_offset);
        let limit = (self.ground_size * 0.42).max(4.2);
        let nx = (world_x - base_target.x).clamp(-limit, limit);
        let nz = (world_z - base_target.z).clamp(-limit, limit);
        self.camera.set_pan_offset(Vec3::new(nx, 0.0, nz));
    }

    pub fn undo_count(&self) -> usize {
        self.undo_stack.len()
    }

    pub fn redo_count(&self) -> usize {
        self.redo_stack.len()
    }

    pub fn dynamic_entity_count(&self) -> usize {
        self.buildings.iter().filter(|b| b.is_dynamic).count()
            + self.props.iter().filter(|p| p.is_dynamic).count()
            + self.helpers.iter().filter(|h| h.is_dynamic).count()
    }

    /// Serializes the full current diorama layout to clean pretty-printed JSON.
    pub fn export_scene_json(&self) -> String {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct ExportPlot<'a> {
            index: usize,
            pos: [f32; 3],
            size: [f32; 2],
            stage: PlotStage,
            title: &'a str,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct ExportBuilding<'a> {
            id: &'a str,
            label: &'a str,
            opens: &'a str,
            asset: &'a str,
            pos: [f32; 3],
            scale: f32,
            yaw_deg: f32,
            is_dynamic: bool,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct ExportProp<'a> {
            id: &'a str,
            asset: &'a str,
            pos: [f32; 3],
            scale: f32,
            yaw_deg: f32,
            is_lamp: bool,
            is_dynamic: bool,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct ExportHelper<'a> {
            id: &'a str,
            name: &'a str,
            role: &'a str,
            asset: &'a str,
            home_plot: usize,
            default_spot: &'a str,
            pos: [f32; 3],
            yaw_deg: f32,
            scale: f32,
            is_dynamic: bool,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct ExportDoc<'a> {
            version: u32,
            preset: &'a str,
            ground_size: f32,
            time_of_day: TimeOfDay,
            plots: Vec<ExportPlot<'a>>,
            buildings: Vec<ExportBuilding<'a>>,
            props: Vec<ExportProp<'a>>,
            helpers: Vec<ExportHelper<'a>>,
        }

        let round2 = |v: f32| (v * 100.0).round() / 100.0;
        let doc = ExportDoc {
            version: 2,
            preset: &self.active_preset,
            ground_size: self.ground_size,
            time_of_day: self.time_of_day,
            plots: self
                .plots
                .iter()
                .map(|p| ExportPlot {
                    index: p.index,
                    pos: [round2(p.pos.x), round2(p.pos.y), round2(p.pos.z)],
                    size: [round2(p.size[0]), round2(p.size[1])],
                    stage: p.stage,
                    title: &p.title,
                })
                .collect(),
            buildings: self
                .buildings
                .iter()
                .map(|b| ExportBuilding {
                    id: &b.id,
                    label: &b.label,
                    opens: &b.opens,
                    asset: &b.asset,
                    pos: [round2(b.pos.x), round2(b.pos.y), round2(b.pos.z)],
                    scale: round2(b.scale),
                    yaw_deg: round2(b.yaw_rad.to_degrees()),
                    is_dynamic: b.is_dynamic,
                })
                .collect(),
            props: self
                .props
                .iter()
                .map(|p| ExportProp {
                    id: &p.id,
                    asset: &p.asset,
                    pos: [round2(p.pos.x), round2(p.pos.y), round2(p.pos.z)],
                    scale: round2(p.scale),
                    yaw_deg: round2(p.yaw_rad.to_degrees()),
                    is_lamp: p.is_lamp,
                    is_dynamic: p.is_dynamic,
                })
                .collect(),
            helpers: self
                .helpers
                .iter()
                .map(|h| ExportHelper {
                    id: &h.id,
                    name: &h.name,
                    role: &h.role,
                    asset: &h.asset,
                    home_plot: h.home_plot,
                    default_spot: &h.default_spot,
                    pos: [round2(h.pos.x), round2(h.pos.y), round2(h.pos.z)],
                    yaw_deg: round2(h.yaw_rad.to_degrees()),
                    scale: round2(h.scale),
                    is_dynamic: h.is_dynamic,
                })
                .collect(),
        };
        serde_json::to_string_pretty(&doc).unwrap_or_else(|_| "{}".into())
    }

    /// Returns compact JSON snapshot of plots, buildings, props/dynamic placements, helpers,
    /// live editor cursor, and current camera target for the bottom-left parchment minimap.
    pub fn minimap_snapshot_json(&self) -> String {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct MiniPlot {
            index: usize,
            x: f32,
            z: f32,
            w: f32,
            h: f32,
            stage: PlotStage,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct MiniBuilding<'a> {
            id: &'a str,
            label: &'a str,
            x: f32,
            z: f32,
            is_dynamic: bool,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct MiniProp<'a> {
            id: &'a str,
            asset: &'a str,
            x: f32,
            z: f32,
            is_lamp: bool,
            is_dynamic: bool,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct MiniHelper<'a> {
            id: &'a str,
            name: &'a str,
            x: f32,
            z: f32,
            is_dynamic: bool,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct MiniCam {
            x: f32,
            z: f32,
            zoom: f32,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct MiniPoint {
            x: f32,
            z: f32,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct MiniHelperPath<'a> {
            id: &'a str,
            points: Vec<MiniPoint>,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct MinimapSnapshot<'a> {
            ground_size: f32,
            camera: MiniCam,
            plots: Vec<MiniPlot>,
            buildings: Vec<MiniBuilding<'a>>,
            props: Vec<MiniProp<'a>>,
            helpers: Vec<MiniHelper<'a>>,
            nav_edges: Vec<NavEdgeSummary>,
            helper_paths: Vec<MiniHelperPath<'a>>,
            selected: Option<MiniPoint>,
            #[serde(skip_serializing_if = "Option::is_none")]
            cursor: Option<MiniPoint>,
        }

        let r2 = |v: f32| (v * 100.0).round() / 100.0;
        let cam_target = self.camera.view_params(1.0).target;

        let selected = self.selected.as_ref().and_then(|sel| match sel {
            DioramaHit::Plot { index, .. } => self.plots.get(*index).map(|p| MiniPoint {
                x: r2(p.pos.x),
                z: r2(p.pos.z),
            }),
            DioramaHit::Building { id, .. } => self.buildings.iter().find(|b| &b.id == id).map(|b| MiniPoint {
                x: r2(b.pos.x),
                z: r2(b.pos.z),
            }),
            DioramaHit::Prop { id, .. } => self.props.iter().find(|p| &p.id == id).map(|p| MiniPoint {
                x: r2(p.pos.x),
                z: r2(p.pos.z),
            }),
            DioramaHit::Helper { id, .. } => self.helpers.iter().find(|h| &h.id == id).map(|h| MiniPoint {
                x: r2(h.pos.x),
                z: r2(h.pos.z),
            }),
            DioramaHit::Ground => None,
        });

        let cursor = self.editor_cursor.as_ref().map(|c| MiniPoint { x: r2(c.x), z: r2(c.z) });

        let snap = MinimapSnapshot {
            ground_size: self.ground_size,
            camera: MiniCam {
                x: r2(cam_target.x),
                z: r2(cam_target.z),
                zoom: r2(self.camera.zoom_scale),
            },
            plots: self
                .plots
                .iter()
                .map(|p| MiniPlot {
                    index: p.index,
                    x: r2(p.pos.x),
                    z: r2(p.pos.z),
                    w: r2(p.size[0]),
                    h: r2(p.size[1]),
                    stage: p.stage,
                })
                .collect(),
            buildings: self
                .buildings
                .iter()
                .map(|b| MiniBuilding {
                    id: &b.id,
                    label: &b.label,
                    x: r2(b.pos.x),
                    z: r2(b.pos.z),
                    is_dynamic: b.is_dynamic,
                })
                .collect(),
            props: self
                .props
                .iter()
                .map(|p| MiniProp {
                    id: &p.id,
                    asset: &p.asset,
                    x: r2(p.pos.x),
                    z: r2(p.pos.z),
                    is_lamp: p.is_lamp,
                    is_dynamic: p.is_dynamic,
                })
                .collect(),
            helpers: self
                .helpers
                .iter()
                .map(|h| MiniHelper {
                    id: &h.id,
                    name: &h.name,
                    x: r2(h.pos.x),
                    z: r2(h.pos.z),
                    is_dynamic: h.is_dynamic,
                })
                .collect(),
            nav_edges: self.nav.minimap_edges(),
            helper_paths: self
                .helpers
                .iter()
                .filter(|h| !h.path.is_empty())
                .map(|h| {
                    let mut pts = Vec::with_capacity(h.path.len() + 1);
                    pts.push(MiniPoint {
                        x: r2(h.pos.x),
                        z: r2(h.pos.z),
                    });
                    for wp in &h.path {
                        pts.push(MiniPoint { x: r2(wp.x), z: r2(wp.z) });
                    }
                    MiniHelperPath { id: &h.id, points: pts }
                })
                .collect(),
            selected,
            cursor,
        };
        serde_json::to_string(&snap).unwrap_or_else(|_| "{}".into())
    }

    fn push_snapshot(&mut self) {
        let snap = EditAction::Snapshot {
            plots: self.plots.clone(),
            buildings: self.buildings.clone(),
            props: self.props.clone(),
            helpers: self.helpers.clone(),
            preset: self.active_preset.clone(),
        };
        self.push_undo(snap);
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

    pub fn step(&mut self, elapsed: f32) {
        let dt = elapsed.min(0.05);
        self.elapsed += dt;
        self.camera.update(dt);
        self.roof_cutaway_spring.step(dt);

        if self.tod_blend < 1.0 {
            self.tod_blend = (self.tod_blend + elapsed / 1.1).min(1.0);
        }

        for p in &mut self.plots {
            p.crop_spring.step(dt);
            p.sign_spring.step(dt);
        }
        for b in &mut self.buildings {
            b.spring.step(dt);
        }
        for pr in &mut self.props {
            pr.spring.step(dt);
        }

        let wrap_angle = |mut a: f32| {
            while a > std::f32::consts::PI {
                a -= std::f32::consts::TAU;
            }
            while a <= -std::f32::consts::PI {
                a += std::f32::consts::TAU;
            }
            a
        };

        let step_heading = |yaw: &mut f32, vel: &mut f32, desired: f32, dt: f32| {
            // Snappy Paper-Mario damped angular spring following shortest arc
            let err = wrap_angle(desired - *yaw);
            let k = 105.0;
            let c = 15.5;
            for _ in 0..2 {
                let h = dt * 0.5;
                let e = wrap_angle(desired - *yaw);
                let acc = e * k - *vel * c;
                *vel += acc * h;
                *yaw = wrap_angle(*yaw + *vel * h);
            }
            if err.abs() < 0.004 && vel.abs() < 0.01 {
                *yaw = wrap_angle(desired);
                *vel = 0.0;
            }
        };

        // Autonomous multi-hop road & arched-bridge patrolling with exact bridge-deck climbing
        // and natural travel-direction facing (front south / back north / slight oblique east-west)
        let mut new_paths: Vec<(usize, Vec<Vec3>)> = Vec::new();
        for (idx, h) in self.helpers.iter_mut().enumerate() {
            h.spring.step(dt);
            // Advance along queued NavGraph road/bridge waypoints (never cutting across canals!)
            while let Some(wp) = h.path.first() {
                let d_xz = (wp.x - h.pos.x).hypot(wp.z - h.pos.z);
                if d_xz <= 0.08 {
                    h.path.remove(0);
                } else {
                    break;
                }
            }

            if let Some(&next_wp) = h.path.first() {
                h.target_pos = next_wp;
                let dx = next_wp.x - h.pos.x;
                let dz = next_wp.z - h.pos.z;
                let dist = dx.hypot(dz);
                let speed = 1.25;
                let step_d = (speed * dt).min(dist);
                let prev_y = h.pos.y;
                if dist > 1e-4 {
                    h.pos.x += dx / dist * step_d;
                    h.pos.z += dz / dist * step_d;
                }
                // Climb smoothly UP stone bridge steps, OVER the arch crest, and DOWN the far ramp!
                h.pos.y = surface_height_at(&self.props, h.pos.x, h.pos.z);
                if step_d > 1e-4 {
                    let slope = ((h.pos.y - prev_y) / step_d).atan().clamp(-0.14, 0.14);
                    h.slope_pitch += (-slope - h.slope_pitch) * (dt * 10.0).min(1.0);
                }
                h.walk_phase += dt * 11.0;
                h.rig.set_facing_dir(dx);
                h.rig.set_state(PuppetAnimState::Walk);
                h.rig.step(dt, speed);

                // True physical travel direction `atan2(dx, dz)`:
                // south (+Z) -> 0° (front), north (-Z) -> 180° (back), east/west (±X) -> ±90°
                // with subtle ~11° oblique readability nudge only when dead edge-on to camera!
                if dist > 0.01 {
                    let mut desired_yaw = dx.atan2(dz);
                    let edge_on = (1.0 - desired_yaw.cos().abs() / 0.22).clamp(0.0, 1.0);
                    if edge_on > 0.0 {
                        let nudge = 0.20 * edge_on; // ~11.5° toward front readability
                        desired_yaw = if desired_yaw >= 0.0 { desired_yaw - nudge } else { desired_yaw + nudge };
                    }
                    step_heading(&mut h.yaw_rad, &mut h.yaw_vel, desired_yaw, dt);
                }
            } else {
                h.pos.y = surface_height_at(&self.props, h.pos.x, h.pos.z);
                h.slope_pitch *= (1.0 - dt * 8.0).max(0.0);
                h.wait_timer -= dt;
                h.celebrate_timer = (h.celebrate_timer - dt).max(0.0);
                h.walk_phase *= (1.0 - dt * 8.0).max(0.0);
                // Location-aware animation: only hoe/wave/celebrate when actually near home_plot!
                let (station_state, near_home_plot) = if !self.plots.is_empty() {
                    let plot = &self.plots[h.home_plot % self.plots.len()];
                    let d_plot = (h.pos.x - plot.pos.x).hypot(h.pos.z - plot.pos.z);
                    if d_plot <= 1.75 {
                        (PuppetAnimState::for_plot_stage(plot.stage), true)
                    } else {
                        (PuppetAnimState::Idle, false)
                    }
                } else {
                    (PuppetAnimState::Idle, false)
                };
                // Preserve an active Celebrate cheer briefly right after a harvest
                if h.celebrate_timer > 0.0 {
                    h.rig.set_state(PuppetAnimState::Celebrate);
                } else {
                    h.rig.set_state(station_state);
                }
                h.rig.step(dt, 0.0);

                // Context-aware stationary facing:
                // - TendCrop (near plot) -> face the farm plot being tended
                // - WaveAsk / Celebrate -> turn cheerfully toward camera (+Z)
                // - Idle -> gentle natural stance (dynamic editor helpers keep their placed yaw)
                if !h.is_dynamic {
                    let desired_yaw = match h.rig.state {
                        PuppetAnimState::TendCrop if near_home_plot && !self.plots.is_empty() => {
                            let plot = &self.plots[h.home_plot % self.plots.len()];
                            let pdx = plot.pos.x - h.pos.x;
                            let pdz = plot.pos.z - h.pos.z;
                            if pdx.hypot(pdz) > 0.05 { pdx.atan2(pdz) } else { 0.0 }
                        }
                        PuppetAnimState::WaveAsk | PuppetAnimState::Celebrate => 0.0,
                        _ => ((idx as f32 - 2.5) * 0.14).clamp(-0.32, 0.32),
                    };
                    step_heading(&mut h.yaw_rad, &mut h.yaw_vel, desired_yaw, dt);
                }

                if h.wait_timer <= 0.0 && (!self.plots.is_empty() || !self.buildings.is_empty()) {
                    h.wait_timer = 2.6 + ((idx * 37) % 5) as f32 * 0.55;
                    h.going_to_building = !h.going_to_building;
                    let goal_node = if h.going_to_building && !self.buildings.is_empty() {
                        self.nav
                            .node_by_tag(&format!("bldg_{}", h.default_spot))
                            .or_else(|| self.buildings.first().and_then(|b| self.nav.node_by_tag(&format!("bldg_{}", b.id))))
                    } else if !self.plots.is_empty() {
                        let plot_idx = self.plots[h.home_plot % self.plots.len()].index;
                        self.nav.node_by_tag(&format!("plot_{plot_idx}"))
                    } else {
                        None
                    };
                    if let Some(goal) = goal_node {
                        let mut route = self.nav.find_path_to_node(h.pos, goal);
                        // Fan out helpers arriving at the same building so they stand side-by-side cleanly
                        if h.going_to_building
                            && let Some(last) = route.last_mut()
                        {
                            let ang = (idx as f32 * 2.15) % std::f32::consts::TAU;
                            let ox = last.x + ang.cos() * 0.36;
                            let oz = last.z + ang.sin() * 0.36;
                            if !is_in_canal(ox, oz) {
                                last.x = ox;
                                last.z = oz;
                            }
                        }
                        if !route.is_empty() {
                            new_paths.push((idx, route));
                        }
                    }
                }
            }
        }
        for (idx, route) in new_paths {
            if let Some(&first) = route.first() {
                self.helpers[idx].target_pos = first;
            }
            self.helpers[idx].path = route;
        }

        // Gentle soft crowd separation so helpers never overlap on plazas (never pushing into canals)
        let n_helpers = self.helpers.len();
        if n_helpers > 1 {
            let mut pushes = vec![(0.0f32, 0.0f32); n_helpers];
            for i in 0..n_helpers {
                for j in (i + 1)..n_helpers {
                    let dx = self.helpers[j].pos.x - self.helpers[i].pos.x;
                    let dz = self.helpers[j].pos.z - self.helpers[i].pos.z;
                    let d = dx.hypot(dz);
                    let min_sep = 0.46;
                    if d > 1e-4 && d < min_sep {
                        let push = ((min_sep - d) * 0.35).min(dt * 0.85);
                        let nx = dx / d;
                        let nz = dz / d;
                        pushes[i].0 -= nx * push;
                        pushes[i].1 -= nz * push;
                        pushes[j].0 += nx * push;
                        pushes[j].1 += nz * push;
                    }
                }
            }
            for (i, (px, pz)) in pushes.into_iter().enumerate() {
                if px.abs() + pz.abs() <= 1e-5 {
                    continue;
                }
                let h = &mut self.helpers[i];
                // Keep bridge walkers tightly centered on the arch deck
                if h.pos.y > 0.05 {
                    continue;
                }
                let nx = h.pos.x + px;
                let nz = h.pos.z + pz;
                if !is_in_canal(nx, nz) {
                    h.pos.x = nx;
                    h.pos.z = nz;
                    h.pos.y = surface_height_at(&self.props, h.pos.x, h.pos.z);
                }
            }
        }
    }

    /// Interpolates active light preset cleanly during dawn/noon/dusk/night blends.
    pub fn blended_light(&self, bundle: &AssetBundle) -> LightPreset {
        let a = bundle
            .lights
            .presets
            .get(self.prev_tod.key())
            .copied()
            .unwrap_or_else(|| *bundle.lights.presets.values().next().unwrap());
        let b = bundle.lights.presets.get(self.time_of_day.key()).copied().unwrap_or(a);
        let t = self.tod_blend;
        let e = t * t * (3.0 - 2.0 * t);
        let lerp3 = |x: [f32; 3], y: [f32; 3]| [x[0] + (y[0] - x[0]) * e, x[1] + (y[1] - x[1]) * e, x[2] + (y[2] - x[2]) * e];
        let lerp1 = |x: f32, y: f32| x + (y - x) * e;
        LightPreset {
            azimuth_deg: lerp1(a.azimuth_deg, b.azimuth_deg),
            elevation_deg: lerp1(a.elevation_deg, b.elevation_deg),
            key_color: lerp3(a.key_color, b.key_color),
            key_intensity: lerp1(a.key_intensity, b.key_intensity),
            sky_color: lerp3(a.sky_color, b.sky_color),
            ground_color: lerp3(a.ground_color, b.ground_color),
            hemi_intensity: lerp1(a.hemi_intensity, b.hemi_intensity),
            shadow_leak: lerp3(a.shadow_leak, b.shadow_leak),
            shadow_strength: lerp1(a.shadow_strength, b.shadow_strength),
            table_bg: lerp3(a.table_bg, b.table_bg),
            fog_color: lerp3(a.fog_color, b.fog_color),
            lamp_intensity: lerp1(a.lamp_intensity, b.lamp_intensity),
            lamp_color: lerp3(a.lamp_color, b.lamp_color),
            exposure: lerp1(a.exposure, b.exposure),
        }
    }

    /// Computes live animated canal boat world position & water bob/roll/pitch angles.
    fn boat_live_transform(&self, pr: &PropState, boat_idx: usize) -> (Vec3, f32, f32, f32) {
        let ph = boat_idx as f32 * 1.9 + pr.pos.x * 0.6 + pr.pos.z * 0.4;
        let bob_y = (self.elapsed * 1.7 + ph).sin() * 0.024;
        let roll = (self.elapsed * 1.3 + ph).sin() * 0.032;
        let pitch = (self.elapsed * 1.55 + ph * 0.8).cos() * 0.020;
        let mut pos = Vec3::new(pr.pos.x, pr.pos.y + bob_y, pr.pos.z);

        // Gentle canal cruise drift along safe water axes for base canal boats
        if !pr.is_dynamic {
            let drift = (self.elapsed * 0.18 + ph).sin();
            match boat_idx {
                0 => {
                    // West north canal branch
                    pos.x += drift * 0.10;
                    pos.z += drift * 0.62;
                }
                2 => {
                    // Southern basin
                    let (sy, cy) = pr.yaw_rad.sin_cos();
                    pos.x += cy * drift * 0.45;
                    pos.z -= sy * drift * 0.45;
                }
                3 => {
                    // East canal branch
                    pos.z += drift * 0.65;
                }
                _ => {}
            }
        }
        (pos, pr.yaw_rad, pitch, roll)
    }

    pub fn lamp_positions(&self) -> Vec<Vec3> {
        let mut out: Vec<Vec3> = Vec::with_capacity(16);
        // Rabbit Lead's live moving handheld mini glowing lantern!
        if let Some(rabbit_lamp) = self.rabbit_lantern_pos() {
            out.push(rabbit_lamp);
        }
        // Drifting canal boats' glowing bow paper lanterns (cast moving reflections on water!)
        let mut boat_idx = 0usize;
        for p in &self.props {
            if p.asset == "p_boat" {
                if boat_idx < 2 {
                    let (bpos, yaw, _, _) = self.boat_live_transform(p, boat_idx);
                    let (sy, cy) = yaw.sin_cos();
                    let bow_x = 0.64 * p.scale;
                    out.push(Vec3::new(bpos.x + bow_x * cy, bpos.y + 0.42 * p.scale, bpos.z - bow_x * sy));
                }
                boat_idx += 1;
            }
        }
        for p in self.props.iter().rev().filter(|p| p.is_lamp && p.is_dynamic) {
            out.push(Vec3::new(p.pos.x, 0.55, p.pos.z));
        }
        for p in self.props.iter().filter(|p| p.is_lamp && !p.is_dynamic) {
            out.push(Vec3::new(p.pos.x, 0.55, p.pos.z));
        }
        for id in ["runtimes", "manager", "skills", "log"] {
            if let Some(b) = self.buildings.iter().find(|b| b.id == id) {
                out.push(Vec3::new(b.pos.x, 0.75, b.pos.z + 0.4));
            }
        }
        out.truncate(16);
        out
    }

    /// Collects all render instances together with a flat GPU bone-matrix buffer
    /// (`bone_mats[0..16]` = static identity palette; `bone_mats[16*k..16*(k+1)]` = animated palettes).
    pub fn collect_render_batch(&self, bundle: &AssetBundle) -> (Vec<RenderInstance>, Vec<[[f32; 4]; 4]>) {
        self.collect_batch_with(|mesh_id| bundle.manifest.meshes.get(mesh_id).map(|m| m.bones.as_slice()).unwrap_or(&[]))
    }

    /// Collects all render instances using cached mesh bone tables (from `DioramaWorld::new`).
    pub fn collect_instances(&self) -> Vec<RenderInstance> {
        let (instances, _bones) = self.collect_batch_with(|mesh_id| self.mesh_bones.get(mesh_id).map(|v| v.as_slice()).unwrap_or(&[]));
        instances
    }

    fn collect_batch_with<'a, F>(&self, bones_for: F) -> (Vec<RenderInstance>, Vec<[[f32; 4]; 4]>)
    where
        F: Fn(&str) -> &'a [BoneDesc],
    {
        let route_cap = if self.show_routes {
            self.helpers.iter().map(|h| h.path.len().min(10)).sum::<usize>()
        } else {
            0
        };
        let fx_cap = (self.available_meshes.contains("fx_petal") as usize) * 10
            + (self.available_meshes.contains("fx_firefly") as usize) * 10
            + (self.available_meshes.contains("fx_splash") as usize) * 5;
        let cursor_cap = if self.editor_cursor.is_some() { 2 } else { 0 };
        let inst_cap = 1 + self.plots.len() * 3 + self.buildings.len() + self.props.len() + self.helpers.len() + fx_cap + route_cap + cursor_cap;
        let rigged_est = self.buildings.len() + self.helpers.len() + self.props.iter().filter(|p| !bones_for(&p.asset).is_empty()).count();
        let mut out = Vec::with_capacity(inst_cap);
        let mut bone_mats: Vec<[[f32; 4]; 4]> = Vec::with_capacity(MAX_BONES * (1 + rigged_est));
        bone_mats.extend_from_slice(&identity_palette());

        let push_palette = |bone_mats: &mut Vec<[[f32; 4]; 4]>, pal: [[[f32; 4]; 4]; MAX_BONES]| -> (u32, Option<[Mat4; MAX_BONES]>) {
            let base = bone_mats.len() as u32;
            bone_mats.extend_from_slice(&pal);
            let mut mat4_arr = [Mat4::IDENTITY; MAX_BONES];
            for i in 0..MAX_BONES {
                mat4_arr[i] = Mat4(pal[i]);
            }
            (base, Some(mat4_arr))
        };

        out.push(RenderInstance {
            mesh_id: "ground_slab".into(),
            model: Mat4::IDENTITY,
            highlight: 0.0,
            bone_base: 0,
            bone_palette: None,
        });

        let is_plot_hl = |i: usize| {
            matches!(&self.hovered, Some(DioramaHit::Plot { index, .. }) if *index == i)
                || matches!(&self.selected, Some(DioramaHit::Plot { index, .. }) if *index == i)
        };
        let is_bldg_hl = |id: &str| {
            matches!(&self.hovered, Some(DioramaHit::Building { id: hid, .. }) if hid == id)
                || matches!(&self.selected, Some(DioramaHit::Building { id: sid, .. }) if sid == id)
        };
        let is_prop_hl = |id: &str| {
            matches!(&self.hovered, Some(DioramaHit::Prop { id: hid, .. }) if hid == id)
                || matches!(&self.selected, Some(DioramaHit::Prop { id: sid, .. }) if sid == id)
        };
        let is_helper_hl = |id: &str| {
            matches!(&self.hovered, Some(DioramaHit::Helper { id: hid, .. }) if hid == id)
                || matches!(&self.selected, Some(DioramaHit::Helper { id: sid, .. }) if sid == id)
        };

        for p in &self.plots {
            let hl = if is_plot_hl(p.index) { 1.0 } else { 0.0 };
            let bed_scale = Vec3::new(p.size[0] / 1.55, 1.0, p.size[1] / 1.25);
            out.push(RenderInstance {
                mesh_id: "plot_frame".into(),
                model: Mat4::translation(p.pos).mul(Mat4::scale_xyz(bed_scale)),
                highlight: hl * 0.75,
                bone_base: 0,
                bone_palette: None,
            });
            if let Some(crop_id) = p.stage.crop_mesh() {
                let scale = match p.stage {
                    PlotStage::Seeded => 0.78,
                    PlotStage::Sprout => 0.90,
                    PlotStage::Reviewing => 1.28,
                    _ => 1.15,
                };
                let hinge = p.crop_spring.hinge_angle(self.elapsed);
                let lift = 0.025 * (1.0 - p.crop_spring.pos).clamp(0.0, 1.0);
                let model = Mat4::translation(Vec3::new(p.pos.x, 0.01 + lift, p.pos.z))
                    .mul(Mat4::rotation_x(hinge))
                    .mul(Mat4::scale_xyz(Vec3::new(scale, scale, scale)));
                out.push(RenderInstance {
                    mesh_id: crop_id.into(),
                    model,
                    highlight: hl,
                    bone_base: 0,
                    bone_palette: None,
                });
            }
            if let Some(sign_id) = p.stage.sign_mesh() {
                let hinge = p.sign_spring.hinge_angle(self.elapsed);
                let lift = 0.025 * (1.0 - p.sign_spring.pos).clamp(0.0, 1.0);
                let urgent_bounce = (self.elapsed * 3.8 + p.index as f32 * 1.1).sin().abs() * 0.075;
                let sign_hl = hl.max(0.26 + 0.16 * (self.elapsed * 3.2 + p.index as f32).sin().abs());
                let model = Mat4::translation(Vec3::new(p.pos.x + 0.65, 0.01 + lift + urgent_bounce, p.pos.z + 0.52))
                    .mul(Mat4::rotation_y(-0.22))
                    .mul(Mat4::rotation_x(hinge))
                    .mul(Mat4::scale_xyz(Vec3::new(0.88, 0.88, 0.88)));
                out.push(RenderInstance {
                    mesh_id: sign_id.into(),
                    model,
                    highlight: sign_hl,
                    bone_base: 0,
                    bone_palette: None,
                });
            }
        }

        let cutaway_pos = self.roof_cutaway_spring.pos;
        for (idx, b) in self.buildings.iter().enumerate() {
            let hl = if is_bldg_hl(&b.id) { 1.0 } else { 0.0 };
            let hinge = b.spring.hinge_angle(self.elapsed);
            let lift = 0.025 * (1.0 - b.spring.pos).clamp(0.0, 1.0);
            let s = b.scale * (1.0 + hl * 0.04);
            let model = Mat4::translation(Vec3::new(b.pos.x, b.pos.y + lift, b.pos.z))
                .mul(Mat4::rotation_y(b.yaw_rad))
                .mul(Mat4::rotation_x(hinge))
                .mul(Mat4::scale_xyz(Vec3::new(s, s, s)));
            let bones = bones_for(&b.asset);
            let (bone_base, bone_palette) = if !bones.is_empty() {
                let pal = MachineRig::evaluate_palette(bones, self.elapsed, 0.5 + idx as f32 * 1.17, cutaway_pos);
                push_palette(&mut bone_mats, pal)
            } else {
                (0, None)
            };
            out.push(RenderInstance {
                mesh_id: b.asset.clone(),
                model,
                highlight: hl,
                bone_base,
                bone_palette,
            });
        }

        let mut boat_idx = 0usize;
        for (idx, pr) in self.props.iter().enumerate() {
            let hl = if is_prop_hl(&pr.id) { 1.0 } else { 0.0 };
            let hinge = pr.spring.hinge_angle(self.elapsed);
            let lift = 0.025 * (1.0 - pr.spring.pos).clamp(0.0, 1.0);
            let s = pr.scale * (1.0 + hl * 0.05);
            let model = if pr.asset == "p_boat" {
                let (bpos, yaw, pitch, roll) = self.boat_live_transform(pr, boat_idx);
                boat_idx += 1;
                Mat4::translation(Vec3::new(bpos.x, bpos.y + lift, bpos.z))
                    .mul(Mat4::rotation_y(yaw))
                    .mul(Mat4::rotation_z(roll))
                    .mul(Mat4::rotation_x(hinge + pitch))
                    .mul(Mat4::scale_xyz(Vec3::new(s, s, s)))
            } else {
                Mat4::translation(Vec3::new(pr.pos.x, pr.pos.y + lift, pr.pos.z))
                    .mul(Mat4::rotation_y(pr.yaw_rad))
                    .mul(Mat4::rotation_x(hinge))
                    .mul(Mat4::scale_xyz(Vec3::new(s, s, s)))
            };
            let bones = bones_for(&pr.asset);
            let (bone_base, bone_palette) = if !bones.is_empty() {
                let pal = MachineRig::evaluate_palette(bones, self.elapsed, 1.2 + idx as f32 * 0.89, cutaway_pos);
                push_palette(&mut bone_mats, pal)
            } else {
                (0, None)
            };
            out.push(RenderInstance {
                mesh_id: pr.asset.clone(),
                model,
                highlight: hl,
                bone_base,
                bone_palette,
            });
        }

        for h in &self.helpers {
            let hl = if is_helper_hl(&h.id) { 1.0 } else { 0.0 };
            let bones = bones_for(&h.asset);
            let has_rig = !bones.is_empty();
            // Rigged Paper-Mario puppets animate stride/bounce inside their hierarchical skeleton;
            // unrigged fallback cards retain whole-card hop/wobble.
            let hop = if has_rig { 0.0 } else { h.walk_phase.sin().abs() * 0.14 };
            let wobble = if has_rig {
                0.0
            } else {
                (h.walk_phase * 0.5).sin() * 0.08 * h.walk_phase.min(1.0)
            };
            let hinge = h.spring.hinge_angle(self.elapsed);
            let lift = 0.025 * (1.0 - h.spring.pos).clamp(0.0, 1.0);
            let s = h.scale * (1.0 + hl * 0.06);
            let model = Mat4::translation(Vec3::new(h.pos.x, h.pos.y + hop + lift, h.pos.z))
                .mul(Mat4::rotation_y(h.yaw_rad))
                .mul(Mat4::rotation_z(wobble))
                .mul(Mat4::rotation_x(hinge + h.slope_pitch))
                .mul(Mat4::scale_xyz(Vec3::new(s, s, s)));
            let (bone_base, bone_palette) = if has_rig {
                let pal = h.rig.evaluate_palette(bones);
                push_palette(&mut bone_mats, pal)
            } else {
                (0, None)
            };
            out.push(RenderInstance {
                mesh_id: h.asset.clone(),
                model,
                highlight: hl,
                bone_base,
                bone_palette,
            });
        }

        // Ambient papercraft micro-life particles (auto-enabled when compiled meshes exist)
        if self.available_meshes.contains("fx_petal") && matches!(self.time_of_day, TimeOfDay::Dawn | TimeOfDay::Noon | TimeOfDay::Dusk) {
            const PETAL_ANCHORS: [(f32, f32, f32); 10] = [
                (-2.6, -2.4, 7.2),
                (-1.2, 0.4, 8.5),
                (-0.4, 2.2, 7.8),
                (1.1, -1.8, 9.1),
                (2.4, 0.9, 8.0),
                (3.7, -1.2, 7.5),
                (4.4, 1.8, 8.8),
                (-3.4, 1.6, 8.3),
                (0.5, -3.1, 7.6),
                (2.9, 3.2, 9.4),
            ];
            for (i, &(ax, az, period)) in PETAL_ANCHORS.iter().enumerate() {
                let phase = ((self.elapsed + i as f32 * 1.37) % period) / period;
                let y = 2.75 - phase * 2.55;
                let sway_x = (self.elapsed * 1.15 + i as f32 * 1.7).sin() * 0.55 + phase * 0.65;
                let sway_z = (self.elapsed * 0.92 + i as f32 * 2.3).cos() * 0.40 + phase * 0.35;
                let s = 0.85 + (i % 3) as f32 * 0.14;
                let model = Mat4::translation(Vec3::new(ax + sway_x, y.max(0.12), az + sway_z))
                    .mul(Mat4::rotation_y(self.elapsed * 1.4 + i as f32))
                    .mul(Mat4::rotation_z((self.elapsed * 2.1 + i as f32).sin() * 0.65))
                    .mul(Mat4::scale_xyz(Vec3::new(s, s, s)));
                out.push(RenderInstance {
                    mesh_id: "fx_petal".into(),
                    model,
                    highlight: 0.0,
                    bone_base: 0,
                    bone_palette: None,
                });
            }
        }

        if self.available_meshes.contains("fx_firefly") && matches!(self.time_of_day, TimeOfDay::Dusk | TimeOfDay::Night) {
            const FIREFLY_ANCHORS: [(f32, f32); 10] = [
                (-1.1, -2.2),
                (-0.7, 0.9),
                (-0.2, 2.9),
                (1.4, 3.8),
                (3.7, 1.9),
                (3.9, -0.8),
                (-2.8, 1.1),
                (-3.3, -1.6),
                (2.2, -1.5),
                (4.6, 0.2),
            ];
            for (i, &(ax, az)) in FIREFLY_ANCHORS.iter().enumerate() {
                let t = self.elapsed * (0.75 + (i % 4) as f32 * 0.12) + i as f32 * 1.9;
                let x = ax + t.sin() * 0.42;
                let z = az + (t * 1.3).cos() * 0.38;
                let y = 0.34 + (t * 1.7).sin().abs() * 0.48;
                let twinkle = 0.72 + (self.elapsed * 3.6 + i as f32 * 1.4).sin().abs() * 0.55;
                let model = Mat4::translation(Vec3::new(x, y, z))
                    .mul(Mat4::rotation_y(self.elapsed * 1.8 + i as f32))
                    .mul(Mat4::scale_xyz(Vec3::new(twinkle, twinkle, twinkle)));
                out.push(RenderInstance {
                    mesh_id: "fx_firefly".into(),
                    model,
                    highlight: 0.35,
                    bone_base: 0,
                    bone_palette: None,
                });
            }
        }

        if self.available_meshes.contains("fx_splash")
            && let Some(ws) = self.buildings.iter().find(|b| b.asset == "b_workshop")
        {
            let (sy, cy) = ws.yaw_rad.sin_cos();
            let lx = -0.54 * ws.scale;
            let lz = 0.14 * ws.scale;
            let wx = ws.pos.x + lx * cy + lz * sy;
            let wz = ws.pos.z - lx * sy + lz * cy;
            for i in 0..5 {
                let u = ((self.elapsed * 1.55 + i as f32 * 0.20) % 1.0).clamp(0.0, 1.0);
                let arc_y = 0.14 + 0.52 * u - 0.58 * u * u;
                let spread = (i as f32 - 2.0) * 0.08;
                let s = (1.0 - u * 0.45) * 0.95;
                let model = Mat4::translation(Vec3::new(wx - u * 0.28 + spread * 0.5, arc_y.max(0.04), wz + u * 0.32 + spread))
                    .mul(Mat4::rotation_y(self.elapsed * 3.0 + i as f32))
                    .mul(Mat4::scale_xyz(Vec3::new(s, s, s)));
                out.push(RenderInstance {
                    mesh_id: "fx_splash".into(),
                    model,
                    highlight: 0.0,
                    bone_base: 0,
                    bone_palette: None,
                });
            }
        }

        // Subtle 3D stepping-stone route markers along active helper paths & bridge crests when `show_routes` is ON
        if self.show_routes {
            let pulse = 0.88 + (self.elapsed * 3.4).sin() * 0.12;
            for h in &self.helpers {
                for (wi, wp) in h.path.iter().take(10).enumerate() {
                    let s = 0.12 * pulse * (1.0 - wi as f32 * 0.04).max(0.55);
                    let y = surface_height_at(&self.props, wp.x, wp.z) + 0.032;
                    out.push(RenderInstance {
                        mesh_id: "plot_frame".into(),
                        model: Mat4::translation(Vec3::new(wp.x, y, wp.z))
                            .mul(Mat4::rotation_y(std::f32::consts::FRAC_PI_4))
                            .mul(Mat4::scale_xyz(Vec3::new(s, 0.25, s))),
                        highlight: 0.92,
                        bone_base: 0,
                        bone_palette: None,
                    });
                }
            }
        }

        // 3D Snapped Placement Cursor Gizmo (valid = golden glow, blocked = vermilion warning `-1.0`)
        if let Some(cur) = &self.editor_cursor {
            let pulse = 0.92 + (self.elapsed * 4.2).sin() * 0.08;
            let yaw = cur.yaw_deg.to_radians();
            let frame_xz = match cur.kind {
                EntityKind::Building => 0.88,
                EntityKind::Plot => 1.05,
                _ => 0.56,
            } * pulse;
            let cursor_hl = if cur.valid { 1.0 } else { -1.0 };
            out.push(RenderInstance {
                mesh_id: "plot_frame".into(),
                model: Mat4::translation(Vec3::new(cur.x, 0.03, cur.z))
                    .mul(Mat4::rotation_y(yaw))
                    .mul(Mat4::scale_xyz(Vec3::new(frame_xz, 0.65, frame_xz))),
                highlight: cursor_hl,
                bone_base: 0,
                bone_palette: None,
            });
            if cur.kind != EntityKind::Plot && !cur.asset_id.is_empty() {
                let bob = 0.06 + (self.elapsed * 4.2).sin().abs() * 0.05;
                let preview_s = (if cur.scale > 0.1 { cur.scale } else { 1.0 }) * 0.88;
                out.push(RenderInstance {
                    mesh_id: cur.asset_id.clone(),
                    model: Mat4::translation(Vec3::new(cur.x, bob, cur.z))
                        .mul(Mat4::rotation_y(yaw))
                        .mul(Mat4::scale_xyz(Vec3::new(preview_s, preview_s, preview_s))),
                    highlight: if cur.valid { 0.95 } else { -1.0 },
                    bone_base: 0,
                    bone_palette: None,
                });
            }
        }

        (out, bone_mats)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asset::{BuildingSpec, HelperSpec, PlotSpec, PropSpec};

    fn sample_world() -> DioramaWorld {
        DioramaWorld::from_scene(
            SceneSpec {
                plots: vec![
                    PlotSpec {
                        index: 0,
                        station: 0,
                        pos: [-3.0, 0.0, -3.0],
                        size: [2.1, 2.1],
                        unlock_level: None,
                    },
                    PlotSpec {
                        index: 1,
                        station: 1,
                        pos: [0.0, 0.0, -3.0],
                        size: [2.1, 2.1],
                        unlock_level: None,
                    },
                ],
                buildings: vec![
                    BuildingSpec {
                        id: "runtimes".into(),
                        label: "工坊".into(),
                        opens: "/runtimes".into(),
                        asset: "b_workshop".into(),
                        pos: [-6.0, 0.0, -2.5],
                        scale: 2.2,
                        yaw_deg: 20.0,
                    },
                    BuildingSpec {
                        id: "skills".into(),
                        label: "书屋".into(),
                        opens: "/team/skills".into(),
                        asset: "b_library".into(),
                        pos: [6.0, 0.0, -2.5],
                        scale: 2.1,
                        yaw_deg: -20.0,
                    },
                ],
                props: vec![PropSpec {
                    asset: "p_lantern".into(),
                    pos: [-4.0, 0.0, -4.0],
                    scale: 1.05,
                    yaw_deg: 0.0,
                    is_lamp: true,
                }],
                helpers: vec![HelperSpec {
                    id: "coder".into(),
                    name: "Fox Coder".into(),
                    role: "程序员".into(),
                    asset: "h_fox".into(),
                    home_plot: 0,
                    default_spot: "runtimes".into(),
                }],
            },
            16.0,
        )
    }

    #[test]
    fn regression_lighting_finishes_after_an_idle_gap_without_advancing_physics_by_seconds() {
        let mut world = sample_world();
        world.set_time_of_day(TimeOfDay::Night, true);
        world.set_time_of_day(TimeOfDay::Noon, false);
        let before = world.elapsed;
        world.step(2.0);
        assert_eq!(world.tod_blend, 1.0);
        assert!((world.elapsed - before - 0.05).abs() < 1e-5);
    }

    #[test]
    fn regression_reduced_motion_paints_the_destination_light_and_folds() {
        let mut world = sample_world();
        world.set_time_of_day(TimeOfDay::Night, true);
        world.set_time_of_day(TimeOfDay::Noon, false);
        world.toggle_roof_cutaway();
        world.plots[0].sign_spring.fold_down_and_rise(0.2);
        world.settle_view();
        assert_eq!(world.tod_blend, 1.0);
        assert!(world.roof_cutaway_open() && !world.roof_cutaway_spring.is_moving());
        assert!(!world.camera.is_moving());
        assert_eq!(world.plots[0].sign_spring.pos, 1.0);
    }

    #[test]
    fn place_nudge_rotate_scale_undo_and_redo_lifecycle() {
        let mut w = sample_world();
        let init_bldgs = w.buildings.len();
        let hit = w.place_entity(EntityKind::Building, "b_stall", 1.12, 2.38, 15.0, 1.85).expect("place building");
        assert_eq!(w.buildings.len(), init_bldgs + 1);
        assert_eq!(w.dynamic_entity_count(), 1);
        assert_eq!(w.redo_count(), 0);
        // Snapped to 0.5 grid: 1.12 -> 1.0, 2.38 -> 2.5
        let placed = w.buildings.last().unwrap();
        assert!((placed.pos.x - 1.0).abs() < 1e-4);
        assert!((placed.pos.z - 2.5).abs() < 1e-4);
        assert!(placed.spring.pos < 0.05);
        assert_eq!(placed.spring.target, 1.0);

        // Nudge, rotate, and scale selected entity
        assert!(w.nudge_selected(0.5, -0.5));
        assert!(w.rotate_selected(15.0));
        assert!(w.scale_selected(0.2));
        let tf = w.selected_transform().expect("selected transform");
        assert!((tf.x - 1.5).abs() < 1e-3);
        assert!((tf.z - 2.0).abs() < 1e-3);
        assert!((tf.yaw_deg - 30.0).abs() < 1e-2);
        assert!((tf.scale - 2.05).abs() < 1e-2);

        // Undo scale & redo scale
        assert!(w.undo_last_edit());
        assert_eq!(w.redo_count(), 1);
        assert!((w.selected_transform().unwrap().scale - 1.85).abs() < 1e-2);
        assert!(w.redo_last_edit());
        assert_eq!(w.redo_count(), 0);
        assert!((w.selected_transform().unwrap().scale - 2.05).abs() < 1e-2);

        // Remove placed building, undo removal, redo removal, undo removal
        assert!(w.remove_entity_at_or_selected(Some(&hit)));
        assert_eq!(w.buildings.len(), init_bldgs);
        assert!(w.undo_last_edit());
        assert_eq!(w.buildings.len(), init_bldgs + 1);
        assert!(w.redo_last_edit());
        assert_eq!(w.buildings.len(), init_bldgs);
        assert!(w.undo_last_edit());
        assert_eq!(w.buildings.len(), init_bldgs + 1);

        // Clear dynamic edits
        assert!(w.clear_dynamic_edits());
        assert_eq!(w.dynamic_entity_count(), 0);
    }

    #[test]
    fn cursor_gizmo_emits_only_when_active() {
        let mut w = sample_world();
        let base_count = w.collect_instances().len();
        w.set_editor_cursor(Some(EditorCursor {
            x: 1.5,
            z: -2.0,
            kind: EntityKind::Prop,
            asset_id: "p_lantern".into(),
            yaw_deg: 45.0,
            scale: 1.1,
            valid: true,
            reason: None,
        }));
        let with_cursor = w.collect_instances();
        // Adds ground bracket ("plot_frame") + ghost preview ("p_lantern")
        assert_eq!(with_cursor.len(), base_count + 2);
        assert_eq!(with_cursor[with_cursor.len() - 2].mesh_id, "plot_frame");
        assert_eq!(with_cursor[with_cursor.len() - 1].mesh_id, "p_lantern");

        let mini: serde_json::Value = serde_json::from_str(&w.minimap_snapshot_json()).expect("valid minimap json");
        assert_eq!(mini["cursor"]["x"], 1.5);
        assert_eq!(mini["cursor"]["z"], -2.0);

        w.clear_editor_cursor();
        assert_eq!(w.collect_instances().len(), base_count);
    }

    #[test]
    fn atlas_persistence_and_json_export_import_roundtrip() {
        let mut w = sample_world();
        // Edit fullTown
        w.place_entity(EntityKind::Prop, "p_willow", 2.0, 2.0, 0.0, 2.0);
        assert_eq!(w.dynamic_entity_count(), 1);

        // Switch to starterFarm -> fresh starter layout
        assert!(w.switch_atlas_map("starterFarm"));
        assert_eq!(w.active_preset, "starterFarm");
        assert_eq!(w.dynamic_entity_count(), 0);
        assert!(w.atlas_saved_keys().contains(&"fullTown".to_string()));

        // Edit starterFarm & switch back to fullTown -> fullTown edit preserved!
        w.place_entity(EntityKind::Building, "b_stall", 1.5, 1.0, 30.0, 1.9);
        assert!(w.switch_atlas_map("fullTown"));
        assert_eq!(w.dynamic_entity_count(), 1);
        assert!(w.props.iter().any(|p| p.asset == "p_willow" && p.is_dynamic));

        // Switch back to starterFarm -> starterFarm edit preserved too!
        assert!(w.switch_atlas_map("starterFarm"));
        assert!(w.buildings.iter().any(|b| b.asset == "b_stall" && b.is_dynamic));

        // Export JSON, wipe via preset, then Import JSON back and verify restoration!
        let exported = w.export_scene_json();
        assert!(w.apply_map_preset("fullTown"));
        assert!(!w.buildings.iter().any(|b| b.asset == "b_stall" && b.is_dynamic));

        let imported_count = w.import_scene_json(&exported).expect("import valid json");
        assert!(imported_count >= 5);
        assert_eq!(w.active_preset, "starterFarm");
        assert!(w.buildings.iter().any(|b| b.asset == "b_stall" && b.is_dynamic));

        // Invalid JSON fails cleanly without mutating state
        assert!(w.import_scene_json("{not valid").is_err());
        assert!(w.import_scene_json("{}").is_err());
    }

    #[test]
    fn presets_export_and_minimap_snapshot_are_valid_json() {
        let mut w = sample_world();
        assert!(w.apply_map_preset("starterFarm"));
        assert_eq!(w.active_preset, "starterFarm");
        assert!(w.buildings.iter().any(|b| b.id == "runtimes"));
        assert!(!w.buildings.iter().any(|b| b.id == "skills"));

        assert!(w.apply_map_preset("busyFactory"));
        assert_eq!(w.active_preset, "busyFactory");
        assert!(w.dynamic_entity_count() >= 4);

        w.pan_camera_to(2.5, -1.5);
        let mini: serde_json::Value = serde_json::from_str(&w.minimap_snapshot_json()).expect("valid minimap json");
        assert_eq!(mini["groundSize"], 16.0);
        assert!(mini["plots"].as_array().unwrap().len() == 2);
        assert!((mini["camera"]["x"].as_f64().unwrap() - 2.5).abs() < 0.1);

        let exported: serde_json::Value = serde_json::from_str(&w.export_scene_json()).expect("valid export json");
        assert_eq!(exported["preset"], "busyFactory");
        assert!(exported["props"].as_array().unwrap().len() >= 5);
    }

    #[test]
    fn roof_cutaway_and_puppet_anim_state_follow_plot_stage() {
        let mut w = sample_world();
        w.mesh_bones.insert(
            "b_workshop".into(),
            vec![
                BoneDesc {
                    name: "root".into(),
                    parent: -1,
                    pivot: [0.0, 0.0, 0.0],
                },
                BoneDesc {
                    name: "waterwheel".into(),
                    parent: 0,
                    pivot: [-0.54, 0.40, 0.14],
                },
                BoneDesc {
                    name: "lantern_swing".into(),
                    parent: 0,
                    pivot: [0.0, 0.80, 0.45],
                },
                BoneDesc {
                    name: "roof_lid".into(),
                    parent: 0,
                    pivot: [0.0, 0.78, -0.42],
                },
            ],
        );
        assert!(!w.roof_cutaway_open());
        assert!(w.toggle_roof_cutaway());
        assert!(w.roof_cutaway_open());
        for _ in 0..80 {
            w.step(1.0 / 60.0);
        }
        assert!(w.roof_cutaway_spring.pos > 0.95);

        // Plot 0 stage -> Asking drives helper 0 (stationed at plot 0) into WaveAsk
        w.set_plot_stage(0, PlotStage::Asking);
        w.helpers[0].target_pos = w.helpers[0].pos;
        w.helpers[0].wait_timer = 10.0;
        w.step(1.0 / 60.0);
        assert_eq!(w.helpers[0].rig.state, PuppetAnimState::WaveAsk);

        // Workshop instance receives non-zero bone_base + animated bone_palette
        let instances = w.collect_instances();
        let ws = instances.iter().find(|i| i.mesh_id == "b_workshop").expect("workshop instance");
        assert!(ws.bone_base > 0);
        assert!(ws.bone_palette.is_some());
    }

    #[test]
    fn helper_climbs_over_bridge_arch_and_rabbit_emits_moving_lantern_pool() {
        let scene = SceneSpec {
            plots: vec![PlotSpec {
                index: 5,
                station: 5,
                pos: [-2.80, 0.0, -0.55],
                size: [1.22, 1.04],
                unlock_level: None,
            }],
            buildings: vec![BuildingSpec {
                id: "shop".into(),
                label: "小摊".into(),
                opens: "panel:shop".into(),
                asset: "b_stall".into(),
                pos: [2.25, 0.0, -0.45],
                scale: 1.68,
                yaw_deg: -24.0,
            }],
            props: vec![PropSpec {
                asset: "p_bridge_arch".into(),
                pos: [-0.85, 0.0, 0.55],
                scale: 1.06,
                yaw_deg: -4.0,
                is_lamp: false,
            }],
            helpers: vec![
                HelperSpec {
                    id: "designer".into(),
                    name: "Cat Designer".into(),
                    role: "设计师".into(),
                    asset: "h_cat".into(),
                    home_plot: 0,
                    default_spot: "shop".into(),
                },
                HelperSpec {
                    id: "orchestrator".into(),
                    name: "Rabbit Lead".into(),
                    role: "主助手".into(),
                    asset: "h_rabbit".into(),
                    home_plot: 0,
                    default_spot: "shop".into(),
                },
            ],
        };
        let mut w = DioramaWorld::from_scene(scene, 16.0);
        // Cat starts at Bridge #1 west entry and walks UP & OVER the arch crest toward shop!
        assert!(!w.helpers[0].path.is_empty(), "Cat should have an active bridge route");
        let base_insts = w.collect_instances().len();
        w.set_show_routes(true);
        assert!(w.collect_instances().len() > base_insts, "show_routes should emit 3D route markers");

        let mut max_y = 0.0f32;
        for _ in 0..160 {
            w.step(1.0 / 60.0);
            max_y = max_y.max(w.helpers[0].pos.y);
        }
        assert!(max_y > 0.50, "Cat must climb UP over Bridge #1 arch crest (~0.57m), only reached y={max_y}");

        // Rabbit emits a live moving handheld lantern pool in lamp_positions()
        let r_lamp = w.rabbit_lantern_pos().expect("rabbit lantern position");
        assert!(w.lamp_positions().first().copied() == Some(r_lamp));

        // Minimap snapshot exports navEdges + helperPaths cleanly
        let mini: serde_json::Value = serde_json::from_str(&w.minimap_snapshot_json()).expect("valid minimap json");
        assert!(!mini["navEdges"].as_array().unwrap().is_empty());
    }

    #[test]
    fn walking_helper_faces_true_north_back_and_south_front_headings() {
        let mut w = sample_world();
        // Walk strictly NORTH (dz < 0, away from camera) -> yaw converges toward PI (cos(yaw) < -0.5)
        w.helpers[0].pos = Vec3::new(0.0, 0.0, 2.0);
        w.helpers[0].yaw_rad = 0.0;
        w.helpers[0].yaw_vel = 0.0;
        w.helpers[0].path = vec![Vec3::new(0.0, 0.0, -4.0)];
        for _ in 0..45 {
            w.step(1.0 / 60.0);
        }
        let cos_north = w.helpers[0].yaw_rad.cos();
        assert!(
            cos_north < -0.5,
            "walking north must show puppet back (cos(yaw) < -0.5), got yaw={} cos={cos_north}",
            w.helpers[0].yaw_rad
        );

        // Now reverse and walk strictly SOUTH (dz > 0, toward camera) -> yaw converges toward 0 (cos(yaw) > 0.5)
        w.helpers[0].path = vec![Vec3::new(0.0, 0.0, 5.0)];
        for _ in 0..45 {
            w.step(1.0 / 60.0);
        }
        let cos_south = w.helpers[0].yaw_rad.cos();
        assert!(
            cos_south > 0.5,
            "walking south must show puppet front (cos(yaw) > 0.5), got yaw={} cos={cos_south}",
            w.helpers[0].yaw_rad
        );
    }

    #[test]
    fn phase_a_interact_plot_domain_sync_focus_and_dynamic_repath() {
        use crate::domain::{PlotTicketSync, YardSnapshotSync};

        let mut w = sample_world();
        // 1. Plot 0 starts Reviewing -> interact_plot harvests +1, plays HarvestChime, home helper celebrates
        assert_eq!(w.plots[0].stage, PlotStage::Reviewing);
        let outcome = w.interact_plot(0).expect("harvest reviewing plot");
        assert_eq!(outcome.harvest_delta, 1);
        assert_eq!(outcome.harvest_count, 1);
        assert_eq!(outcome.next_stage, PlotStage::Empty);
        assert_eq!(outcome.sound, SoundKind::HarvestChime);
        assert_eq!(w.helpers[0].rig.state, PuppetAnimState::Celebrate);

        // 2. Idempotent domain sync pushes plot 1 to Asking and updates title
        w.apply_domain_sync(YardSnapshotSync {
            plots: vec![PlotTicketSync {
                index: 1,
                stage: PlotStage::Asking,
                title: "#200 Sync Ticket".into(),
                locked: Some(false),
            }],
            helpers: vec![],
            time_of_day: Some(TimeOfDay::Dusk),
        });
        assert_eq!(w.plots[1].stage, PlotStage::Asking);
        assert_eq!(w.plots[1].title, "#200 Sync Ticket");
        assert_eq!(w.time_of_day, TimeOfDay::Dusk);

        // 3. Screen-space anchor projection includes urgent plot 1
        let anchors = w.project_screen_anchors(16.0 / 10.0);
        assert!(anchors.iter().any(|a| a.plot_index == Some(1) && a.urgent));

        // 4. Interior cutaway focus opens roof + flies camera, exit restores
        assert!(w.focus_building_interior("runtimes"));
        assert!(w.roof_cutaway_open());
        assert!(w.camera.is_focused());
        assert_eq!(w.focused_building.as_deref(), Some("runtimes"));
        assert!(w.exit_interior_focus());
        assert!(!w.roof_cutaway_open());
        assert!(!w.camera.is_focused());
        assert!(w.focused_building.is_none());

        // 5. Canal placement validation rejects houses in water with AlertSoft
        w.pending_sounds.clear();
        let blocked = w.try_place_entity(EntityKind::Building, "b_stall", -0.8, 0.5, 0.0, 1.9);
        assert!(blocked.is_err());
        assert_eq!(w.pending_sounds.last().copied(), Some(SoundKind::AlertSoft));

        // 6. Location-aware helper AI: helper far from home_plot plays Idle, not TendCrop
        w.plots[0].stage = PlotStage::Leafy;
        w.helpers[0].pos = Vec3::new(5.2, 0.0, 0.8);
        w.helpers[0].path.clear();
        w.helpers[0].celebrate_timer = 0.0;
        w.helpers[0].wait_timer = 5.0;
        w.helpers[0].rig.set_state(PuppetAnimState::Idle);
        w.step(1.0 / 60.0);
        assert_eq!(
            w.helpers[0].rig.state,
            PuppetAnimState::Idle,
            "helper far from home plot must stay Idle instead of hoeing air"
        );

        // 7. Removing a bridge clears stale helper bridge path and drops elevation to ground
        let bridge_hit = w
            .try_place_entity(EntityKind::Prop, "p_bridge_arch", -0.85, 0.55, 0.0, 1.0)
            .expect("place bridge over canal");
        w.helpers[0].pos = Vec3::new(-0.85, 0.54, 0.55);
        w.helpers[0].path = vec![Vec3::new(0.5, 0.0, 0.55)];
        assert!(w.remove_entity_at_or_selected(Some(&bridge_hit)));
        assert!(w.helpers[0].path.is_empty());
        assert!(w.helpers[0].pos.y.abs() < 1e-4);
    }
}

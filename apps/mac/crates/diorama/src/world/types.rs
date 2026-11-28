use serde::{Deserialize, Serialize};

use crate::math::{Mat4, Vec3};
use crate::rig::{MAX_BONES, PuppetAnimState, PuppetRig};
use crate::spring::FlapSpring;

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
pub(super) enum EditAction {
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
pub(super) struct AtlasSnapshot {
    pub plots: Vec<PlotState>,
    pub buildings: Vec<BuildingState>,
    pub props: Vec<PropState>,
    pub helpers: Vec<HelperState>,
    pub undo_stack: Vec<EditAction>,
    pub redo_stack: Vec<EditAction>,
}

pub(super) type PresetEntities = (Vec<PlotState>, Vec<BuildingState>, Vec<PropState>, Vec<HelperState>);

pub fn is_cutaway_building(asset: &str) -> bool {
    matches!(asset, "b_workshop" | "b_guild_hall" | "b_library")
}

pub fn building_display_info(asset: &str) -> (&'static str, &'static str) {
    match asset {
        "b_workshop" => ("水车工坊", "/runtimes"),
        "b_library" => ("藏书阁", "/settings/skills"),
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

use serde::{Deserialize, Serialize};

use crate::math::Vec3;
use crate::nav::NavEdgeSummary;
use crate::rig::{PuppetAnimState, PuppetRig};
use crate::spring::FlapSpring;

use super::DioramaWorld;
use super::types::{BuildingState, DioramaHit, HelperState, PlotStage, PlotState, PropState, TimeOfDay, building_display_info, helper_display_info};

impl DioramaWorld {
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
}

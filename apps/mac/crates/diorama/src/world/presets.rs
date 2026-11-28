use crate::math::Vec3;
use crate::spring::FlapSpring;

use super::DioramaWorld;
use super::domain_sync::build_scene_entities;
use super::types::{AtlasSnapshot, PlotStage, PresetEntities, PropState};

impl DioramaWorld {
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
}

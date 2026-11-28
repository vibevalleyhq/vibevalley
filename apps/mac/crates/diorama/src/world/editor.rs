use crate::foley::SoundKind;
use crate::math::Vec3;
use crate::nav::{PlacementStatus, surface_height_at, validate_placement};
use crate::pick::{raycast_ground as pick_raycast_ground, snap_coord};
use crate::rig::{PuppetAnimState, PuppetRig};
use crate::spring::FlapSpring;

use super::DioramaWorld;
use super::types::{
    BuildingState, DioramaHit, EditAction, EntityKind, HelperState, PlotStage, PropState, SelectedTransform, building_display_info, helper_display_info,
    prop_display_label,
};

impl DioramaWorld {
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

    pub(super) fn apply_entity_transform(&mut self, target: &DioramaHit, pos: Vec3, yaw_rad: f32, scale: f32) {
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
}

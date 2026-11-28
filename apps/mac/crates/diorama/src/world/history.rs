use crate::foley::SoundKind;

use super::DioramaWorld;
use super::types::{DioramaHit, EditAction, prop_display_label};

impl DioramaWorld {
    pub(super) fn push_undo(&mut self, action: EditAction) {
        self.undo_stack.push(action);
        self.redo_stack.clear();
    }

    pub(super) fn push_snapshot(&mut self) {
        let snap = EditAction::Snapshot {
            plots: self.plots.clone(),
            buildings: self.buildings.clone(),
            props: self.props.clone(),
            helpers: self.helpers.clone(),
            preset: self.active_preset.clone(),
        };
        self.push_undo(snap);
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
}

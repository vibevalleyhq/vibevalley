use std::collections::BTreeSet;

use crate::engine::whiteboard::codec::{WhiteboardEntry, merge_live_presences};
use crate::engine::whiteboard::geometry::{Camera, MAX_ZOOM, MIN_ZOOM};
use crate::engine::whiteboard::model::{BoardDoc, ElementId, Presence, PresenceViewport};
use crate::engine::whiteboard::ops::apply_remote_entries;

use super::WhiteboardController;
use super::types::{AnimatedPresencePose, AnimationStepResult, ControllerEffect};

const POSE_EPS: f64 = 0.4;
const ZOOM_EPS: f64 = 0.002;

impl WhiteboardController {
    pub fn cancel_follow(&mut self, effects: &mut Vec<ControllerEffect>) -> bool {
        self.camera_target = None;
        if self.follow_actor.take().is_some() {
            effects.push(ControllerEffect::FollowChanged(None));
            true
        } else {
            false
        }
    }

    pub fn displayed_pose(&self, p: &Presence) -> AnimatedPresencePose {
        self.presence_poses
            .get(&p.id)
            .copied()
            .unwrap_or_else(|| AnimatedPresencePose::from_presence(p))
    }

    pub fn compute_follow_camera(&self, p: &Presence) -> Camera {
        let vw = self.viewport_size.0.max(120.0);
        let vh = self.viewport_size.1.max(120.0);
        if let Some(vp) = p.viewport
            && let Some(rect) = vp.rect()
        {
            let mut cam = self.camera;
            let max_zoom = vp.zoom.filter(|z| z.is_finite() && *z > 0.0).map_or(2.0, |z| z.clamp(MIN_ZOOM, MAX_ZOOM));
            cam.fit_bounds(rect, vw, vh, 24.0, max_zoom);
            return cam;
        }
        if let Some(rect) = p.region_rect() {
            let mut cam = self.camera;
            let max_zoom = cam.zoom.clamp(MIN_ZOOM, MAX_ZOOM);
            if rect.w * max_zoom > (vw - 96.0).max(40.0) || rect.h * max_zoom > (vh - 96.0).max(40.0) {
                cam.fit_bounds(rect, vw, vh, 48.0, max_zoom);
            } else {
                let c = rect.center();
                cam.pan_x = vw * 0.5 - c.x * cam.zoom;
                cam.pan_y = vh * 0.5 - c.y * cam.zoom;
            }
            return cam;
        }
        let mut cam = self.camera;
        if let Some(vp) = p.viewport
            && let Some(z) = vp.zoom.filter(|z| z.is_finite() && *z > 0.0)
        {
            cam.zoom = z.clamp(MIN_ZOOM, MAX_ZOOM);
        }
        let focus = p.focus_point();
        cam.pan_x = vw * 0.5 - focus.x * cam.zoom;
        cam.pan_y = vh * 0.5 - focus.y * cam.zoom;
        cam
    }

    pub fn sync_presence_targets(&mut self, instant: bool) {
        let active_ids: BTreeSet<&str> = self.doc.presences.iter().map(|p| p.id.as_str()).collect();
        self.presence_poses.retain(|id, _| active_ids.contains(id.as_str()));
        for p in &self.doc.presences {
            let target = AnimatedPresencePose::from_presence(p);
            if instant {
                self.presence_poses.insert(p.id.clone(), target);
            } else {
                self.presence_poses.entry(p.id.clone()).or_insert(target);
            }
        }
    }

    pub fn needs_animation(&self) -> bool {
        if self.camera_target.is_some() || !self.element_appear.is_empty() {
            return true;
        }
        for p in &self.doc.presences {
            if let Some(pose) = self.presence_poses.get(&p.id)
                && !pose_close(*pose, AnimatedPresencePose::from_presence(p))
            {
                return true;
            }
        }
        false
    }

    pub fn step_animations(&mut self, dt_secs: f64, instant: bool) -> AnimationStepResult {
        let dt = dt_secs.clamp(0.001, 0.1);
        let alpha_cursor = if instant { 1.0 } else { (1.0 - (-dt / 0.065).exp()).clamp(0.12, 1.0) };
        let alpha_cam = if instant { 1.0 } else { (1.0 - (-dt / 0.10).exp()).clamp(0.08, 1.0) };

        let mut presence_moved = false;
        if instant {
            if !self.element_appear.is_empty() {
                self.element_appear.clear();
                presence_moved = true;
            }
        } else if !self.element_appear.is_empty() {
            let step = (dt / 0.34) as f32;
            for prog in self.element_appear.values_mut() {
                *prog = (*prog + step).min(1.0);
            }
            self.element_appear.retain(|_, prog| *prog < 0.999);
            presence_moved = true;
        }

        for p in &self.doc.presences {
            let target = AnimatedPresencePose::from_presence(p);
            let entry = self.presence_poses.entry(p.id.clone()).or_insert(target);
            if !pose_close(*entry, target) {
                let next = if instant { target } else { lerp_pose(*entry, target, alpha_cursor) };
                let settled = pose_close(next, target);
                *entry = if settled { target } else { next };
                presence_moved = true;
            }
        }

        let mut camera_moved = false;
        if let Some(target_cam) = self.camera_target {
            if instant || camera_close(self.camera, target_cam) {
                if !camera_close(self.camera, target_cam) {
                    camera_moved = true;
                }
                self.camera = target_cam;
                self.camera_target = None;
            } else {
                let next = lerp_camera(self.camera, target_cam, alpha_cam);
                if camera_close(next, target_cam) {
                    self.camera = target_cam;
                    self.camera_target = None;
                } else {
                    self.camera = next;
                }
                camera_moved = true;
            }
        }

        AnimationStepResult {
            presence_moved,
            camera_moved,
            still_animating: self.needs_animation(),
        }
    }

    pub(super) fn sync_follow_camera(&mut self, effects: &mut Vec<ControllerEffect>) {
        let Some(actor) = self.follow_actor.clone() else {
            return;
        };
        let found = self.doc.presences.iter().find(|p| p.id == actor || p.name == actor).cloned();
        match found {
            Some(p) => {
                let target = self.compute_follow_camera(&p);
                if camera_close(self.camera, target) {
                    self.camera_target = None;
                } else if self.smooth_animations {
                    self.camera_target = Some(target);
                } else {
                    self.camera = target;
                    self.camera_target = None;
                    effects.push(ControllerEffect::ViewportChanged { zoom: self.camera.zoom });
                }
            }
            None => {
                self.follow_actor = None;
                self.camera_target = None;
                effects.push(ControllerEffect::FollowChanged(None));
            }
        }
    }

    pub fn apply_live_presences(&mut self, store_presences: &[Presence], live: Vec<Presence>) -> Vec<ControllerEffect> {
        self.doc.presences = store_presences.to_vec();
        merge_live_presences(&mut self.doc, live);
        self.sync_presence_targets(!self.smooth_animations);
        let mut effects = Vec::new();
        self.sync_follow_camera(&mut effects);
        effects
    }

    pub fn set_viewport_size(&mut self, w: f64, h: f64) {
        self.viewport_size = (w.max(120.0), h.max(120.0));
        if !self.user_moved_camera
            && !self.doc.elements.is_empty()
            && let Some(bounds) = self.doc.content_bounds()
        {
            self.camera.fit_bounds(bounds, self.viewport_size.0, self.viewport_size.1, 68.0, 1.0);
        } else if let Some(actor) = self.follow_actor.as_deref()
            && let Some(p) = self.doc.presences.iter().find(|p| p.id == actor || p.name == actor).cloned()
        {
            let target = self.compute_follow_camera(&p);
            if self.smooth_animations {
                self.camera_target = Some(target);
            } else {
                self.camera = target;
                self.camera_target = None;
            }
        }
    }

    pub fn apply_remote_snapshot(&mut self, next_doc: BoardDoc) -> Vec<ControllerEffect> {
        // Keep active local tool, camera, and selection intact while updating remote elements.
        self.doc = next_doc;
        let existing: BTreeSet<ElementId> = self.doc.elements.iter().map(|e| e.id.clone()).collect();
        self.selection.retain(|id| existing.contains(id));
        self.rebuild_index();
        self.sync_presence_targets(!self.smooth_animations);

        let mut effects = Vec::new();
        if !self.user_moved_camera
            && !self.doc.elements.is_empty()
            && let Some(bounds) = self.doc.content_bounds()
        {
            self.camera.fit_bounds(bounds, self.viewport_size.0, self.viewport_size.1, 68.0, 1.0);
            effects.push(ControllerEffect::ViewportChanged { zoom: self.camera.zoom });
        }
        self.sync_follow_camera(&mut effects);
        effects
    }

    pub fn apply_remote_delta(&mut self, updated: &[WhiteboardEntry], deleted: &[String], seq: i64) -> Vec<ControllerEffect> {
        let prev_ids: BTreeSet<ElementId> = self.doc.elements.iter().map(|e| e.id.clone()).collect();
        let removed = apply_remote_entries(&mut self.doc, updated, deleted, seq);
        if !removed.is_empty() {
            let rem_set: BTreeSet<ElementId> = removed.into_iter().collect();
            self.selection.retain(|id| !rem_set.contains(id));
            self.element_appear.retain(|id, _| !rem_set.contains(id));
        }
        if self.smooth_animations {
            for el in &self.doc.elements {
                if !prev_ids.contains(&el.id) {
                    self.element_appear.insert(el.id.clone(), 0.24);
                }
            }
        }
        self.rebuild_index();
        self.sync_presence_targets(!self.smooth_animations);
        let mut effects = Vec::new();
        if !self.user_moved_camera
            && self.follow_actor.is_none()
            && !self.doc.elements.is_empty()
            && let Some(bounds) = self.doc.content_bounds()
        {
            let mut fitted = self.camera;
            fitted.fit_bounds(bounds, self.viewport_size.0, self.viewport_size.1, 68.0, 1.0);
            if !camera_close(self.camera, fitted) {
                self.camera = fitted;
                effects.push(ControllerEffect::ViewportChanged { zoom: self.camera.zoom });
            }
        }
        self.sync_follow_camera(&mut effects);
        effects
    }
}

fn lerp_f64(a: f64, b: f64, alpha: f64) -> f64 {
    a + (b - a) * alpha
}

fn opt_f64_close(a: Option<f64>, b: Option<f64>, eps: f64) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => (x - y).abs() <= eps,
        _ => false,
    }
}

fn lerp_opt_f64(a: Option<f64>, b: Option<f64>, alpha: f64) -> Option<f64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(lerp_f64(x, y, alpha)),
        (_, target) => target,
    }
}

fn viewport_close(a: Option<PresenceViewport>, b: Option<PresenceViewport>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(va), Some(vb)) => {
            (va.x - vb.x).abs() <= POSE_EPS
                && (va.y - vb.y).abs() <= POSE_EPS
                && (va.w - vb.w).abs() <= POSE_EPS
                && (va.h - vb.h).abs() <= POSE_EPS
                && opt_f64_close(va.zoom, vb.zoom, ZOOM_EPS)
        }
        _ => false,
    }
}

fn lerp_viewport(a: Option<PresenceViewport>, b: Option<PresenceViewport>, alpha: f64) -> Option<PresenceViewport> {
    match (a, b) {
        (Some(va), Some(vb)) => Some(PresenceViewport {
            x: lerp_f64(va.x, vb.x, alpha),
            y: lerp_f64(va.y, vb.y, alpha),
            w: lerp_f64(va.w, vb.w, alpha),
            h: lerp_f64(va.h, vb.h, alpha),
            zoom: lerp_opt_f64(va.zoom, vb.zoom, alpha),
        }),
        (_, target) => target,
    }
}

fn pose_close(a: AnimatedPresencePose, b: AnimatedPresencePose) -> bool {
    (a.x - b.x).abs() <= POSE_EPS
        && (a.y - b.y).abs() <= POSE_EPS
        && opt_f64_close(a.w, b.w, POSE_EPS)
        && opt_f64_close(a.h, b.h, POSE_EPS)
        && viewport_close(a.viewport, b.viewport)
}

fn lerp_pose(a: AnimatedPresencePose, b: AnimatedPresencePose, alpha: f64) -> AnimatedPresencePose {
    AnimatedPresencePose {
        x: lerp_f64(a.x, b.x, alpha),
        y: lerp_f64(a.y, b.y, alpha),
        w: lerp_opt_f64(a.w, b.w, alpha),
        h: lerp_opt_f64(a.h, b.h, alpha),
        viewport: lerp_viewport(a.viewport, b.viewport, alpha),
    }
}

pub(super) fn camera_close(a: Camera, b: Camera) -> bool {
    (a.pan_x - b.pan_x).abs() <= 0.5 && (a.pan_y - b.pan_y).abs() <= 0.5 && (a.zoom - b.zoom).abs() <= ZOOM_EPS
}

fn lerp_camera(a: Camera, b: Camera, alpha: f64) -> Camera {
    Camera {
        pan_x: lerp_f64(a.pan_x, b.pan_x, alpha),
        pan_y: lerp_f64(a.pan_y, b.pan_y, alpha),
        zoom: lerp_f64(a.zoom, b.zoom, alpha).clamp(MIN_ZOOM, MAX_ZOOM),
    }
}

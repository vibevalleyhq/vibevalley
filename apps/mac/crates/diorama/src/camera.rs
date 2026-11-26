use crate::math::{Mat4, Ray, Vec3};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CameraPreset {
    Overview,
    CloseUp,
    Postcard,
}

#[derive(Clone, Copy, Debug)]
struct CameraPose {
    target: Vec3,
    distance: f32,
    pitch_deg: f32,
    yaw_deg: f32,
    fov_deg: f32,
}

impl CameraPreset {
    fn pose(self) -> CameraPose {
        match self {
            CameraPreset::Overview => CameraPose {
                target: Vec3::new(0.0, 0.45, 0.20),
                distance: 18.2,
                pitch_deg: 37.0,
                yaw_deg: -11.0,
                fov_deg: 28.0,
            },
            CameraPreset::CloseUp => CameraPose {
                target: Vec3::new(0.25, 0.55, 0.10),
                distance: 13.4,
                pitch_deg: 34.0,
                yaw_deg: 14.0,
                fov_deg: 29.0,
            },
            CameraPreset::Postcard => CameraPose {
                target: Vec3::new(-0.10, 0.55, 0.05),
                distance: 19.4,
                pitch_deg: 30.0,
                yaw_deg: 21.0,
                fov_deg: 28.5,
            },
        }
    }
}

#[derive(Clone, Debug)]
pub struct CameraRig {
    pub preset: CameraPreset,
    cur: CameraPose,
    from: CameraPose,
    to: CameraPose,
    blend_t: f32,
    blend_duration: f32,
    focus_active: bool,
    pub pan_offset: Vec3,
    pub zoom_scale: f32,
    target_pan: Vec3,
    target_zoom: f32,
}

impl Default for CameraRig {
    fn default() -> Self {
        let p = CameraPreset::Overview.pose();
        Self {
            preset: CameraPreset::Overview,
            cur: p,
            from: p,
            to: p,
            blend_t: 1.0,
            blend_duration: 0.65,
            focus_active: false,
            pan_offset: Vec3::ZERO,
            zoom_scale: 1.0,
            target_pan: Vec3::ZERO,
            target_zoom: 1.0,
        }
    }
}

impl CameraRig {
    pub fn set_preset(&mut self, preset: CameraPreset, snap: bool) {
        self.preset = preset;
        self.focus_active = false;
        self.from = self.cur;
        self.to = preset.pose();
        self.blend_duration = 0.65;
        if snap {
            self.cur = self.to;
            self.blend_t = 1.0;
        } else {
            self.blend_t = 0.0;
        }
    }

    /// Smoothly flies the camera into a close macro focus on a world point (e.g., cutaway interior!).
    pub fn focus_target(&mut self, world_pos: Vec3, distance: f32, pitch_deg: f32, yaw_deg: f32) {
        // Bake any active pan_offset into the starting pose so the flight has zero jump!
        let cur_target = self.cur.target.add(self.pan_offset);
        let cur_dist = self.cur.distance * self.zoom_scale;
        self.from = CameraPose {
            target: cur_target,
            distance: cur_dist,
            pitch_deg: self.cur.pitch_deg,
            yaw_deg: self.cur.yaw_deg,
            fov_deg: self.cur.fov_deg,
        };
        self.cur = self.from;
        self.to = CameraPose {
            target: world_pos,
            distance: distance.clamp(5.2, 16.0),
            pitch_deg: pitch_deg.clamp(22.0, 58.0),
            yaw_deg,
            fov_deg: 28.0,
        };
        self.pan_offset = Vec3::ZERO;
        self.target_pan = Vec3::ZERO;
        self.zoom_scale = 1.0;
        self.target_zoom = 1.0;
        self.blend_duration = 0.55;
        self.blend_t = 0.0;
        self.focus_active = true;
    }

    /// Smoothly exits interior/entity focus and flies back to the active preset framing.
    pub fn clear_focus(&mut self) {
        if !self.focus_active {
            return;
        }
        let cur_target = self.cur.target.add(self.pan_offset);
        let cur_dist = self.cur.distance * self.zoom_scale;
        self.from = CameraPose {
            target: cur_target,
            distance: cur_dist,
            pitch_deg: self.cur.pitch_deg,
            yaw_deg: self.cur.yaw_deg,
            fov_deg: self.cur.fov_deg,
        };
        self.cur = self.from;
        self.to = self.preset.pose();
        self.pan_offset = Vec3::ZERO;
        self.target_pan = Vec3::ZERO;
        self.zoom_scale = 1.0;
        self.target_zoom = 1.0;
        self.blend_duration = 0.55;
        self.blend_t = 0.0;
        self.focus_active = false;
    }

    pub fn is_focused(&self) -> bool {
        self.focus_active
    }

    pub fn pan(&mut self, dx_screen: f32, dy_screen: f32) {
        let yaw = self.cur.yaw_deg.to_radians();
        let (sy, cy) = yaw.sin_cos();
        let scale = 0.015 * self.zoom_scale;
        let wx = (-dx_screen * cy - dy_screen * sy) * scale;
        let wz = (-dy_screen * cy + dx_screen * sy) * scale;
        self.target_pan.x = (self.target_pan.x + wx).clamp(-5.5, 5.5);
        self.target_pan.z = (self.target_pan.z + wz).clamp(-5.5, 5.5);
        // Immediate partial response + smooth inertia catch-up
        self.pan_offset = self.pan_offset.lerp(self.target_pan, 0.55);
    }

    /// Sets pan offset directly (used by minimap click-to-pan so target stays synced with inertia).
    pub fn set_pan_offset(&mut self, offset: Vec3) {
        let clamped = Vec3::new(offset.x.clamp(-5.5, 5.5), 0.0, offset.z.clamp(-5.5, 5.5));
        self.pan_offset = clamped;
        self.target_pan = clamped;
    }

    pub fn zoom(&mut self, delta: f32) {
        self.target_zoom = (self.target_zoom * (1.0 - delta * 0.08)).clamp(0.34, 1.55);
        self.zoom_scale += (self.target_zoom - self.zoom_scale) * 0.45;
    }

    /// Zooms smoothly toward the ground world point under normalized screen coordinates `(nx, ny)`.
    pub fn zoom_at(&mut self, delta: f32, nx: f32, ny: f32, aspect: f32) {
        let ground_hit = |rig: &CameraRig| -> Option<(f32, f32)> {
            let ray = rig.pick_ray(nx.clamp(0.0, 1.0), ny.clamp(0.0, 1.0), aspect.max(0.01));
            if ray.dir.y.abs() < 1e-4 {
                return None;
            }
            let t = -ray.origin.y / ray.dir.y;
            if t <= 0.0 || !t.is_finite() {
                return None;
            }
            Some((ray.origin.x + ray.dir.x * t, ray.origin.z + ray.dir.z * t))
        };

        let before = ground_hit(self);
        let prev_target_zoom = self.target_zoom;
        let next_zoom = (prev_target_zoom * (1.0 - delta * 0.08)).clamp(0.34, 1.55);
        if (next_zoom - prev_target_zoom).abs() < 1e-4 {
            return;
        }
        self.target_zoom = next_zoom;
        // Shift target_pan proportionally toward cursor world hit when zooming in
        if let Some((hx, hz)) = before {
            let cur_target = self.cur.target.add(self.target_pan);
            let ratio = 1.0 - (next_zoom / prev_target_zoom);
            self.target_pan.x = (self.target_pan.x + (hx - cur_target.x) * ratio * 0.65).clamp(-5.5, 5.5);
            self.target_pan.z = (self.target_pan.z + (hz - cur_target.z) * ratio * 0.65).clamp(-5.5, 5.5);
        }
        self.zoom_scale += (self.target_zoom - self.zoom_scale) * 0.45;
        self.pan_offset = self.pan_offset.lerp(self.target_pan, 0.45);
    }

    /// Gently nudges target zoom (e.g. pulling closer when toggling cutaway view from overview).
    pub fn set_target_zoom(&mut self, zoom: f32) {
        self.target_zoom = zoom.clamp(0.34, 1.55);
    }

    pub fn reset_offsets(&mut self) {
        self.pan_offset = Vec3::ZERO;
        self.target_pan = Vec3::ZERO;
        self.zoom_scale = 1.0;
        self.target_zoom = 1.0;
        if self.focus_active {
            self.clear_focus();
        }
    }

    pub fn settle(&mut self) {
        self.cur = self.to;
        self.blend_t = 1.0;
        self.pan_offset = self.target_pan;
        self.zoom_scale = self.target_zoom;
    }

    pub fn is_moving(&self) -> bool {
        self.blend_t < 1.0 || self.target_pan.sub(self.pan_offset).len_sq() > 1e-6 || (self.target_zoom - self.zoom_scale).abs() > 1e-4
    }

    pub fn update(&mut self, dt: f32) -> bool {
        if !self.is_moving() {
            return false;
        }
        if self.blend_t < 1.0 {
            let dur = self.blend_duration.max(0.1);
            self.blend_t = (self.blend_t + dt / dur).min(1.0);
            let e = self.blend_t * self.blend_t * (3.0 - 2.0 * self.blend_t);
            self.cur = CameraPose {
                target: self.from.target.lerp(self.to.target, e),
                distance: self.from.distance + (self.to.distance - self.from.distance) * e,
                pitch_deg: self.from.pitch_deg + (self.to.pitch_deg - self.from.pitch_deg) * e,
                yaw_deg: self.from.yaw_deg + (self.to.yaw_deg - self.from.yaw_deg) * e,
                fov_deg: self.from.fov_deg + (self.to.fov_deg - self.from.fov_deg) * e,
            };
        }
        let k = (1.0 - (-dt * 14.0).exp()).clamp(0.0, 1.0);
        self.pan_offset = self.pan_offset.lerp(self.target_pan, k);
        self.zoom_scale += (self.target_zoom - self.zoom_scale) * k;
        true
    }

    pub fn view_params(&self, aspect: f32) -> CameraMatrices {
        let target = self.cur.target.add(self.pan_offset);
        let dist = self.cur.distance * self.zoom_scale;
        let pitch = self.cur.pitch_deg.to_radians();
        let yaw = self.cur.yaw_deg.to_radians();
        let cp = pitch.cos();
        let sp = pitch.sin();
        let sy = yaw.sin();
        let cy = yaw.cos();
        let offset = Vec3::new(sy * cp * dist, sp * dist, cy * cp * dist);
        let eye = target.add(offset);

        let view = Mat4::look_at(eye, target, Vec3::new(0.0, 1.0, 0.0));
        let fov = self.cur.fov_deg.to_radians();
        let near = 1.0f32;
        let far = 80.0f32;
        let proj = Mat4::perspective_metal(fov, aspect, near, far);
        let view_proj = proj.mul(view);

        // Compute focus view depth of target point
        let tv = view.transform_point(target);
        let focus_depth = (-tv.z).max(1.5);

        CameraMatrices {
            eye,
            target,
            yaw_rad: yaw,
            fov_rad: fov,
            aspect,
            near,
            far,
            focus_depth,
            view,
            proj,
            view_proj,
        }
    }

    /// Generates world-space ray from normalized pixel coords nx, ny in [0, 1] top-left origin.
    pub fn pick_ray(&self, nx: f32, ny: f32, aspect: f32) -> Ray {
        let cam = self.view_params(aspect);
        let fwd = cam.target.sub(cam.eye).normalize();
        let right = fwd.cross(Vec3::new(0.0, 1.0, 0.0)).normalize();
        let up = right.cross(fwd).normalize();

        let ndc_x = nx * 2.0 - 1.0;
        let ndc_y = 1.0 - ny * 2.0;
        let tan_half = (cam.fov_rad * 0.5).tan();
        let dir = fwd.add(right.scale(ndc_x * aspect * tan_half)).add(up.scale(ndc_y * tan_half)).normalize();
        Ray { origin: cam.eye, dir }
    }
}

#[derive(Clone, Debug)]
pub struct CameraMatrices {
    pub eye: Vec3,
    pub target: Vec3,
    pub yaw_rad: f32,
    pub fov_rad: f32,
    pub aspect: f32,
    pub near: f32,
    pub far: f32,
    pub focus_depth: f32,
    pub view: Mat4,
    pub proj: Mat4,
    pub view_proj: Mat4,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focus_target_flies_smoothly_and_clear_focus_restores_preset() {
        let mut cam = CameraRig::default();
        let start_dist = cam.view_params(1.6).eye.sub(cam.view_params(1.6).target).len();
        cam.focus_target(Vec3::new(5.45, 0.85, 0.95), 7.2, 43.0, -24.0);
        assert!(cam.is_focused());
        for _ in 0..45 {
            cam.update(1.0 / 60.0);
        }
        let focused = cam.view_params(1.6);
        assert!((focused.target.x - 5.45).abs() < 0.05);
        assert!(focused.eye.sub(focused.target).len() < 8.0);

        cam.clear_focus();
        assert!(!cam.is_focused());
        for _ in 0..45 {
            cam.update(1.0 / 60.0);
        }
        let restored = cam.view_params(1.6);
        assert!((restored.eye.sub(restored.target).len() - start_dist).abs() < 0.25);
    }

    #[test]
    fn zoom_at_moves_pan_toward_offcenter_cursor_and_allows_close_macro() {
        let mut cam = CameraRig::default();
        for _ in 0..8 {
            cam.zoom_at(2.0, 0.82, 0.25, 1.6);
            cam.update(1.0 / 60.0);
        }
        for _ in 0..40 {
            cam.update(1.0 / 60.0);
        }
        assert!(cam.zoom_scale < 0.55, "expected close zoom < 0.55, got {}", cam.zoom_scale);
        assert!(cam.pan_offset.x > 0.2, "zooming right side should pull pan +X, got {}", cam.pan_offset.x);
    }
}

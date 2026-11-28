use crate::asset::{AssetBundle, LightPreset};
use crate::math::Vec3;
use crate::nav::{is_in_canal, surface_height_at};
use crate::rig::PuppetAnimState;

use super::DioramaWorld;
use super::types::PropState;

impl DioramaWorld {
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

        let mut new_paths: Vec<(usize, Vec<Vec3>)> = Vec::new();
        for (idx, h) in self.helpers.iter_mut().enumerate() {
            h.spring.step(dt);
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
                h.pos.y = surface_height_at(&self.props, h.pos.x, h.pos.z);
                if step_d > 1e-4 {
                    let slope = ((h.pos.y - prev_y) / step_d).atan().clamp(-0.14, 0.14);
                    h.slope_pitch += (-slope - h.slope_pitch) * (dt * 10.0).min(1.0);
                }
                h.walk_phase += dt * 11.0;
                h.rig.set_facing_dir(dx);
                h.rig.set_state(PuppetAnimState::Walk);
                h.rig.step(dt, speed);

                if dist > 0.01 {
                    let mut desired_yaw = dx.atan2(dz);
                    let edge_on = (1.0 - desired_yaw.cos().abs() / 0.22).clamp(0.0, 1.0);
                    if edge_on > 0.0 {
                        let nudge = 0.20 * edge_on;
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
                if h.celebrate_timer > 0.0 {
                    h.rig.set_state(PuppetAnimState::Celebrate);
                } else {
                    h.rig.set_state(station_state);
                }
                h.rig.step(dt, 0.0);

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
    pub(super) fn boat_live_transform(&self, pr: &PropState, boat_idx: usize) -> (Vec3, f32, f32, f32) {
        let ph = boat_idx as f32 * 1.9 + pr.pos.x * 0.6 + pr.pos.z * 0.4;
        let bob_y = (self.elapsed * 1.7 + ph).sin() * 0.024;
        let roll = (self.elapsed * 1.3 + ph).sin() * 0.032;
        let pitch = (self.elapsed * 1.55 + ph * 0.8).cos() * 0.020;
        let mut pos = Vec3::new(pr.pos.x, pr.pos.y + bob_y, pr.pos.z);

        if !pr.is_dynamic {
            let drift = (self.elapsed * 0.18 + ph).sin();
            match boat_idx {
                0 => {
                    pos.x += drift * 0.10;
                    pos.z += drift * 0.62;
                }
                2 => {
                    let (sy, cy) = pr.yaw_rad.sin_cos();
                    pos.x += cy * drift * 0.45;
                    pos.z -= sy * drift * 0.45;
                }
                3 => {
                    pos.z += drift * 0.65;
                }
                _ => {}
            }
        }
        (pos, pr.yaw_rad, pitch, roll)
    }

    pub fn lamp_positions(&self) -> Vec<Vec3> {
        let mut out: Vec<Vec3> = Vec::with_capacity(16);
        if let Some(rabbit_lamp) = self.rabbit_lantern_pos() {
            out.push(rabbit_lamp);
        }
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
}

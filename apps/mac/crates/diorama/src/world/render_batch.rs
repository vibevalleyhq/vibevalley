use crate::asset::{AssetBundle, BoneDesc};
use crate::math::{Mat4, Vec3};
use crate::nav::surface_height_at;
use crate::rig::{MAX_BONES, MachineRig, identity_palette};

use super::DioramaWorld;
use super::types::{DioramaHit, EntityKind, PlotStage, RenderInstance, TimeOfDay};

impl DioramaWorld {
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

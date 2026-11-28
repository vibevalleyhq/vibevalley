use std::time::Instant;

use crate::math::{Mat4, Vec3};

use super::buffers::{DrawIndexedIndirectArgs, FrameChannels, FrameUniforms, InstanceData, MeshBatch, fnv1a_u64, make_frame_bg, push_batch};
use super::renderer::MetalRenderer;
use super::types::{DofMode, FrameStats, RenderQuality, RenderSceneInput};

struct PreparedBatches {
    static_hash: u64,
    static_batch_cnt: u32,
    dynamic_batch_cnt: u32,
    scene_batch_cnt: u32,
    static_indirect_off: u64,
    dynamic_indirect_off: u64,
    scene_indirect_off: u64,
}

fn extract_frustum_planes(view_proj: &Mat4) -> [[f32; 4]; 6] {
    let m = &view_proj.0;
    let r0 = [m[0][0], m[1][0], m[2][0], m[3][0]];
    let r1 = [m[0][1], m[1][1], m[2][1], m[3][1]];
    let r2 = [m[0][2], m[1][2], m[2][2], m[3][2]];
    let r3 = [m[0][3], m[1][3], m[2][3], m[3][3]];
    let norm = |p: [f32; 4]| {
        let len = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt().max(1e-6);
        [p[0] / len, p[1] / len, p[2] / len, p[3] / len]
    };
    let add = |a: [f32; 4], b: [f32; 4]| [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
    let sub = |a: [f32; 4], b: [f32; 4]| [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
    [
        norm(add(r3, r0)),
        norm(sub(r3, r0)),
        norm(add(r3, r1)),
        norm(sub(r3, r1)),
        norm(r2),
        norm(sub(r3, r2)),
    ]
}

fn build_frame_uniforms(input: &RenderSceneInput, h: u32, shadow_size: u32, quality: RenderQuality, channels: FrameChannels) -> (FrameUniforms, Mat4) {
    let cam = &input.cam;
    let light = &input.light;

    let cam_fwd = cam.target.sub(cam.eye).normalize();
    let cam_right = cam_fwd.cross(Vec3::new(0.0, 1.0, 0.0)).normalize();
    let cam_up = cam_right.cross(cam_fwd).normalize();

    let az = light.azimuth_deg.to_radians();
    let el = light.elevation_deg.to_radians();
    let ldir = Vec3::new(az.sin() * el.cos(), el.sin(), az.cos() * el.cos()).normalize();

    let extent = 10.8f32;
    let light_view = Mat4::look_at(ldir.scale(28.0), Vec3::ZERO, Vec3::new(0.0, 1.0, 0.0));
    let light_proj = Mat4::ortho_metal(-extent, extent, -extent, extent, 2.0, 62.0);
    let mut light_view_proj = light_proj.mul(light_view);
    let origin_ndc = light_view_proj.transform_point(Vec3::ZERO);
    let half_res = (shadow_size as f32) * 0.5;
    let snap_x = ((origin_ndc.x * half_res).round() - origin_ndc.x * half_res) / half_res;
    let snap_y = ((origin_ndc.y * half_res).round() - origin_ndc.y * half_res) / half_res;
    light_view_proj.0[3][0] += snap_x;
    light_view_proj.0[3][1] += snap_y;

    let sky_luma = 0.2126 * light.sky_color[0] + 0.7152 * light.sky_color[1] + 0.0722 * light.sky_color[2];
    let key_luma = (0.2126 * light.key_color[0] + 0.7152 * light.key_color[1] + 0.0722 * light.key_color[2]) * light.key_intensity;
    let day_factor = ((sky_luma - 0.16) / 0.62 * 0.65 + (key_luma - 0.22) / 1.25 * 0.35).clamp(0.0, 1.0);
    let wrap = 0.28 + (1.0 - day_factor) * 0.12;
    let gobo_strength = 0.15 * (0.40 + 0.60 * day_factor);
    let bloom_strength = 0.20 + (1.0 - day_factor) * 0.62;
    let slab_half = input.slab_half;

    let close_focus = ((12.0 - cam.focus_depth) / 6.0).clamp(0.0, 1.0);
    let res_scale = h as f32 / 900.0;
    let ts = &input.tilt_shift;
    let (eff_half_band, eff_ramp, eff_max_blur) = match input.dof_mode {
        DofMode::Miniature => (
            ts.half_band + close_focus * 0.15,
            ts.ramp,
            ts.max_blur_px * (1.0 - close_focus * 0.52) * res_scale,
        ),
        DofMode::Crisp => (0.38 + close_focus * 0.10, 0.38, ts.max_blur_px * 0.42 * (1.0 - close_focus * 0.52) * res_scale),
        DofMode::Off => (1.0, 0.5, 0.0),
    };
    let interactive_f = if quality == RenderQuality::Interactive { 1.0 } else { 0.0 };
    let uniforms = FrameUniforms {
        view_proj: cam.view_proj.0,
        light_view_proj: light_view_proj.0,
        cam_pos_aspect: [cam.eye.x, cam.eye.y, cam.eye.z, cam.aspect],
        cam_target_slab_half: [cam.target.x, cam.target.y, cam.target.z, slab_half],
        cam_right_gobo: [cam_right.x, cam_right.y, cam_right.z, gobo_strength],
        cam_up_day_factor: [cam_up.x, cam_up.y, cam_up.z, day_factor],
        cam_fwd_bloom_str: [cam_fwd.x, cam_fwd.y, cam_fwd.z, bloom_strength],
        proj_params: [cam.near, cam.far, (cam.fov_rad * 0.5).tan(), cam.focus_depth],
        key_dir_intensity: [ldir.x, ldir.y, ldir.z, light.key_intensity],
        key_color_wrap: [light.key_color[0], light.key_color[1], light.key_color[2], wrap],
        sky_color_hemi: [light.sky_color[0], light.sky_color[1], light.sky_color[2], light.hemi_intensity],
        ground_color_exp: [light.ground_color[0], light.ground_color[1], light.ground_color[2], light.exposure],
        shadow_leak_str: [light.shadow_leak[0], light.shadow_leak[1], light.shadow_leak[2], light.shadow_strength],
        table_bg_lamp_count: [light.table_bg[0], light.table_bg[1], light.table_bg[2], input.lamp_count as f32],
        fog_color_lamp_int: [light.fog_color[0], light.fog_color[1], light.fog_color[2], light.lamp_intensity],
        lamp_color_time: [light.lamp_color[0], light.lamp_color[1], light.lamp_color[2], input.elapsed],
        tilt_a: [ts.focus_screen_y, eff_half_band, eff_ramp, ts.depth_weight],
        tilt_b: [eff_max_blur, ts.ao_radius, ts.ao_intensity, ts.vignette],
        lamp_pools: input.lamp_pools,
        light_grid_bounds: input.light_grid_bounds,
        light_grid: input.light_grid,
        quality_pad: [interactive_f, f32::from(matches!(channels, FrameChannels::Bgra)), 0.0, 0.0],
    };
    (uniforms, light_view_proj)
}

impl MetalRenderer {
    fn upload_bones_and_batches(
        &mut self,
        input: &RenderSceneInput,
        light_view_proj: &Mat4,
        shadow_size: u32,
        shadow_fmt: wgpu::TextureFormat,
        quality: RenderQuality,
    ) -> PreparedBatches {
        let mut rebuild_frame_bg = false;
        self.scratch_bone_upload.clear();
        if input.bone_mats.len() < 16 {
            self.scratch_bone_upload.extend_from_slice(&[Mat4::IDENTITY.0; 16]);
        } else {
            self.scratch_bone_upload.extend_from_slice(&input.bone_mats);
        }
        if self.scratch_bone_upload.len() > self.bone_buf_capacity {
            let new_cap = (self.scratch_bone_upload.len() * 2).max(16 * 32);
            self.bone_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("bone_palettes"),
                size: (new_cap * std::mem::size_of::<[[f32; 4]; 4]>()) as u64,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.bone_buf_capacity = new_cap;
            rebuild_frame_bg = true;
        }
        self.queue.write_buffer(&self.bone_buf, 0, bytemuck::cast_slice(&self.scratch_bone_upload));

        let frustum_planes = extract_frustum_planes(&input.cam.view_proj);
        self.scratch_sort_keys.clear();
        let skip_ground_shadows = quality == RenderQuality::Interactive;
        let mut culled_instances = 0u32;
        for (idx, inst) in input.instances.iter().enumerate() {
            let Some(span) = self.meshes.get(&inst.mesh_id) else {
                continue;
            };
            if span.index_count == 0 {
                continue;
            }
            let never_casts = matches!(
                inst.mesh_id.as_str(),
                "fx_petal" | "fx_firefly" | "fx_splash" | "route_dot" | "cursor_ring" | "cursor_arrow"
            ) || (skip_ground_shadows && matches!(inst.mesh_id.as_str(), "ground" | "ground_slab" | "p_mountain_ridge"));
            let cat = if never_casts {
                2u8
            } else if inst.bone_palette.is_some() || inst.bone_base > 0 || matches!(inst.mesh_id.as_str(), "s_ask" | "s_review" | "s_bug" | "p_boat") {
                1u8
            } else {
                0u8
            };

            let always_visible = matches!(inst.mesh_id.as_str(), "ground" | "ground_slab" | "p_mountain_ridge");
            let scene_visible = if always_visible {
                true
            } else {
                let m = &inst.model.0;
                let sx = (m[0][0] * m[0][0] + m[0][1] * m[0][1] + m[0][2] * m[0][2]).sqrt();
                let sy = (m[1][0] * m[1][0] + m[1][1] * m[1][1] + m[1][2] * m[1][2]).sqrt();
                let sz = (m[2][0] * m[2][0] + m[2][1] * m[2][1] + m[2][2] * m[2][2]).sqrt();
                let max_s = sx.max(sy).max(sz);
                let cx = m[3][0];
                let cy = m[3][1] + span.obb_hy * max_s;
                let cz = m[3][2];
                let rad = span.obb_radius * max_s * 1.35 + 0.25;
                let mut vis = true;
                for p in &frustum_planes {
                    if p[0] * cx + p[1] * cy + p[2] * cz + p[3] < -rad {
                        vis = false;
                        break;
                    }
                }
                vis
            };
            if !scene_visible {
                culled_instances += 1;
                if cat == 2 {
                    continue;
                }
            }
            self.scratch_sort_keys.push((cat, span.mesh_key, !scene_visible, idx));
        }
        self.scratch_sort_keys.sort_by_key(|&(cat, mkey, hidden, idx)| (cat, mkey, hidden, idx));

        self.scratch_instances.clear();
        self.scratch_static_shadow_batches.clear();
        self.scratch_dynamic_shadow_batches.clear();
        self.scratch_scene_batches.clear();

        let mut static_hash: u64 = 0xcbf2_9ce4_8422_2325;
        fnv1a_u64(&mut static_hash, shadow_size as u64);
        fnv1a_u64(&mut static_hash, if shadow_fmt == wgpu::TextureFormat::Depth16Unorm { 16 } else { 32 });
        for col in &light_view_proj.0 {
            for &v in col {
                fnv1a_u64(&mut static_hash, v.to_bits() as u64);
            }
        }
        let mut static_count = 0u64;

        for &(cat, _mkey, hidden, src_idx) in &self.scratch_sort_keys {
            let inst = &input.instances[src_idx];
            let span = self.meshes[&inst.mesh_id];
            let inst_idx = self.scratch_instances.len() as u32;
            self.scratch_instances.push(InstanceData {
                model: inst.model.0,
                params: [span.atlas_index as f32, inst.highlight, inst.bone_base as f32, 0.0],
            });
            if !hidden {
                push_batch(&mut self.scratch_scene_batches, span, inst_idx);
            }
            if cat == 0 {
                push_batch(&mut self.scratch_static_shadow_batches, span, inst_idx);
                static_count += 1;
                fnv1a_u64(&mut static_hash, span.mesh_key as u64);
                let m = &inst.model.0;
                for &v in &m[3][0..3] {
                    fnv1a_u64(&mut static_hash, (v * 1000.0).round() as i64 as u64);
                }
                for &v in &m[0][0..3] {
                    fnv1a_u64(&mut static_hash, (v * 1000.0).round() as i64 as u64);
                }
                let sx = (m[0][0] * m[0][0] + m[0][1] * m[0][1] + m[0][2] * m[0][2]).sqrt().max(1e-4);
                let upright_bucket = ((m[1][1] / sx) * 16.0).round() as i64 as u64;
                fnv1a_u64(&mut static_hash, upright_bucket);
            } else if cat == 1 {
                push_batch(&mut self.scratch_dynamic_shadow_batches, span, inst_idx);
            }
        }
        fnv1a_u64(&mut static_hash, static_count);

        if self.scratch_instances.len() > self.instance_buf_capacity {
            let new_cap = (self.scratch_instances.len() * 2).max(256);
            self.instance_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("instance_storage"),
                size: (new_cap * std::mem::size_of::<InstanceData>()) as u64,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.instance_buf_capacity = new_cap;
            rebuild_frame_bg = true;
        }
        if rebuild_frame_bg {
            self.frame_bg = make_frame_bg(&self.device, &self.frame_bgl, &self.frame_buf, &self.bone_buf, &self.instance_buf);
        }
        if !self.scratch_instances.is_empty() {
            self.queue.write_buffer(&self.instance_buf, 0, bytemuck::cast_slice(&self.scratch_instances));
        }

        let static_batch_cnt = self.scratch_static_shadow_batches.len() as u32;
        let dynamic_batch_cnt = self.scratch_dynamic_shadow_batches.len() as u32;
        let scene_batch_cnt = self.scratch_scene_batches.len() as u32;
        self.last_scene_batches = scene_batch_cnt;
        self.last_culled_instances = culled_instances;

        let indirect_stride = std::mem::size_of::<DrawIndexedIndirectArgs>() as u64;
        let static_indirect_off = 0u64;
        let dynamic_indirect_off = (static_batch_cnt as u64) * indirect_stride;
        let scene_indirect_off = ((static_batch_cnt + dynamic_batch_cnt) as u64) * indirect_stride;

        if self.use_multi_draw_indirect {
            self.scratch_indirect_args.clear();
            let push_args = |dst: &mut Vec<DrawIndexedIndirectArgs>, batches: &[MeshBatch]| {
                for b in batches {
                    dst.push(DrawIndexedIndirectArgs {
                        index_count: b.index_count,
                        instance_count: b.inst_end - b.inst_start,
                        first_index: b.index_offset,
                        base_vertex: b.base_vertex,
                        first_instance: b.inst_start,
                    });
                }
            };
            push_args(&mut self.scratch_indirect_args, &self.scratch_static_shadow_batches);
            push_args(&mut self.scratch_indirect_args, &self.scratch_dynamic_shadow_batches);
            push_args(&mut self.scratch_indirect_args, &self.scratch_scene_batches);
            if self.scratch_indirect_args.len() > self.indirect_buf_capacity {
                let new_cap = (self.scratch_indirect_args.len() * 2).max(256);
                self.indirect_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("indirect_draw_args"),
                    size: (new_cap * std::mem::size_of::<DrawIndexedIndirectArgs>()) as u64,
                    usage: wgpu::BufferUsages::INDIRECT | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
                self.indirect_buf_capacity = new_cap;
            }
            if !self.scratch_indirect_args.is_empty() {
                self.queue
                    .write_buffer(&self.indirect_buf, 0, bytemuck::cast_slice(&self.scratch_indirect_args));
            }
        }

        PreparedBatches {
            static_hash,
            static_batch_cnt,
            dynamic_batch_cnt,
            scene_batch_cnt,
            static_indirect_off,
            dynamic_indirect_off,
            scene_indirect_off,
        }
    }

    pub(super) fn render_pixels(
        &mut self,
        input: &RenderSceneInput,
        width: u32,
        height: u32,
        quality: RenderQuality,
        mut reuse_buf: Vec<u8>,
        channels: FrameChannels,
    ) -> Result<(FrameStats, Vec<u8>), String> {
        let w = width.max(16);
        let h = height.max(16);
        let t_gpu_start = Instant::now();
        self.ensure_shadow_targets(quality);
        self.ensure_targets(w, h);

        let shadow_size = self.shadow_targets.as_ref().unwrap().size;
        let shadow_fmt = self.shadow_targets.as_ref().unwrap().format;

        let (frame_u, light_view_proj) = build_frame_uniforms(input, h, shadow_size, quality, channels);
        self.queue.write_buffer(&self.frame_buf, 0, bytemuck::bytes_of(&frame_u));

        let batches = self.upload_bones_and_batches(input, &light_view_proj, shadow_size, shadow_fmt, quality);

        let shadow_pso = if shadow_fmt == wgpu::TextureFormat::Depth16Unorm {
            &self.shadow_pso_d16
        } else {
            &self.shadow_pso_d32
        };

        let st = self.shadow_targets.as_mut().unwrap();
        let static_shadow_cached = st.has_valid_static && st.static_hash == batches.static_hash;
        let targets = self.targets.as_ref().unwrap();
        let mut draw_calls = 0u32;

        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("papercraft_5pass_encoder"),
        });

        // Pass 1: Static Cached + Dynamic Instanced Directional Shadow Map
        if !static_shadow_cached {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("pass1a_shadow_static"),
                color_attachments: &[],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &st.static_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            rpass.set_pipeline(shadow_pso);
            rpass.set_bind_group(0, &self.frame_bg, &[]);
            if !self.z_only_shadows {
                rpass.set_bind_group(1, &self.shadow_tex_bg, &[]);
            }
            rpass.set_vertex_buffer(0, self.vertex_buf.slice(..));
            rpass.set_index_buffer(self.index_buf.slice(..), wgpu::IndexFormat::Uint16);
            if self.use_multi_draw_indirect && batches.static_batch_cnt > 0 {
                rpass.multi_draw_indexed_indirect(&self.indirect_buf, batches.static_indirect_off, batches.static_batch_cnt);
                draw_calls += 1;
            } else {
                for b in &self.scratch_static_shadow_batches {
                    rpass.draw_indexed(b.index_offset..(b.index_offset + b.index_count), b.base_vertex, b.inst_start..b.inst_end);
                    draw_calls += 1;
                }
            }
            st.static_hash = batches.static_hash;
            st.has_valid_static = true;
        }

        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &st.static_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::DepthOnly,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &st.final_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::DepthOnly,
            },
            wgpu::Extent3d {
                width: st.size,
                height: st.size,
                depth_or_array_layers: 1,
            },
        );

        if batches.dynamic_batch_cnt > 0 {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("pass1b_shadow_dynamic"),
                color_attachments: &[],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &st.final_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            rpass.set_pipeline(shadow_pso);
            rpass.set_bind_group(0, &self.frame_bg, &[]);
            if !self.z_only_shadows {
                rpass.set_bind_group(1, &self.shadow_tex_bg, &[]);
            }
            rpass.set_vertex_buffer(0, self.vertex_buf.slice(..));
            rpass.set_index_buffer(self.index_buf.slice(..), wgpu::IndexFormat::Uint16);
            if self.use_multi_draw_indirect {
                rpass.multi_draw_indexed_indirect(&self.indirect_buf, batches.dynamic_indirect_off, batches.dynamic_batch_cnt);
                draw_calls += 1;
            } else {
                for b in &self.scratch_dynamic_shadow_batches {
                    rpass.draw_indexed(b.index_offset..(b.index_offset + b.index_count), b.base_vertex, b.inst_start..b.inst_end);
                    draw_calls += 1;
                }
            }
        }

        // Pass 2: Memoryless 4x MSAA MRT Scene FIRST + Early-Z Backdrop
        {
            let light = &input.light;
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("pass2_scene_msaa4_mrt"),
                color_attachments: &[
                    Some(wgpu::RenderPassColorAttachment {
                        view: &targets.scene_color_msaa_view,
                        depth_slice: None,
                        resolve_target: Some(&targets.scene_color_view),
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color {
                                r: light.table_bg[0] as f64,
                                g: light.table_bg[1] as f64,
                                b: light.table_bg[2] as f64,
                                a: 0.0,
                            }),
                            store: wgpu::StoreOp::Discard,
                        },
                    }),
                    Some(wgpu::RenderPassColorAttachment {
                        view: &targets.scene_normal_msaa_view,
                        depth_slice: None,
                        resolve_target: Some(&targets.scene_normal_view),
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color {
                                r: 0.5,
                                g: 0.5,
                                b: 0.0,
                                a: 1.0,
                            }),
                            store: wgpu::StoreOp::Discard,
                        },
                    }),
                    Some(wgpu::RenderPassColorAttachment {
                        view: &targets.scene_linz_msaa_view,
                        depth_slice: None,
                        resolve_target: Some(&targets.scene_linz_view),
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color {
                                r: 999.0,
                                g: 0.0,
                                b: 0.0,
                                a: 1.0,
                            }),
                            store: wgpu::StoreOp::Discard,
                        },
                    }),
                ],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &targets.scene_depth_msaa_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Discard,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });

            rpass.set_pipeline(&self.scene_pso);
            rpass.set_bind_group(0, &self.frame_bg, &[]);
            rpass.set_bind_group(1, &st.scene_tex_bg, &[]);
            rpass.set_vertex_buffer(0, self.vertex_buf.slice(..));
            rpass.set_index_buffer(self.index_buf.slice(..), wgpu::IndexFormat::Uint16);
            if self.use_multi_draw_indirect && batches.scene_batch_cnt > 0 {
                rpass.multi_draw_indexed_indirect(&self.indirect_buf, batches.scene_indirect_off, batches.scene_batch_cnt);
                draw_calls += 1;
            } else {
                for b in &self.scratch_scene_batches {
                    rpass.draw_indexed(b.index_offset..(b.index_offset + b.index_count), b.base_vertex, b.inst_start..b.inst_end);
                    draw_calls += 1;
                }
            }

            rpass.set_pipeline(&self.backdrop_pso);
            rpass.set_bind_group(0, &self.frame_bg, &[]);
            rpass.draw(0..3, 0..1);
            draw_calls += 1;
        }

        // Pass 3: 1/4-Res Emissive-Masked Separable Gaussian Bloom
        draw_calls += self.encode_quad_pass(
            &mut encoder,
            "pass3a_bloom_extract",
            &targets.bloom_a_view,
            wgpu::Color::BLACK,
            &self.bloom_extract_pso,
            &targets.bloom_extract_bg,
        );
        let bloom_iters = if quality == RenderQuality::Interactive { 1 } else { 2 };
        for _ in 0..bloom_iters {
            draw_calls += self.encode_quad_pass(
                &mut encoder,
                "pass3b_bloom_h",
                &targets.bloom_b_view,
                wgpu::Color::BLACK,
                &self.bloom_blur_h_pso,
                &targets.bloom_h_bg,
            );
            draw_calls += self.encode_quad_pass(
                &mut encoder,
                "pass3c_bloom_v",
                &targets.bloom_a_view,
                wgpu::Color::BLACK,
                &self.bloom_blur_v_pso,
                &targets.bloom_v_bg,
            );
        }

        // Pass 4: Half-Res Depth Contact AO + Hybrid Tilt-Shift CoC
        draw_calls += self.encode_quad_pass(
            &mut encoder,
            "pass4_ao_coc",
            &targets.ao_coc_view,
            wgpu::Color::WHITE,
            &self.ao_pso,
            &targets.ao_bg,
        );

        // Pass 5: 36-Tap Golden-Angle Bokeh + Additive Bloom + ACES Filmic -> RGBA8
        draw_calls += self.encode_quad_pass(
            &mut encoder,
            "pass5_composite",
            &targets.final_rgba_view,
            wgpu::Color::BLACK,
            &self.composite_pso,
            &targets.composite_bg,
        );

        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &targets.final_rgba,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &targets.readback_buf,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(targets.padded_bpr),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );

        self.queue.submit(Some(encoder.finish()));

        let slice = targets.readback_buf.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |res| {
            let _ = tx.send(res);
        });
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        rx.recv()
            .map_err(|e| format!("readback recv: {e}"))?
            .map_err(|e| format!("readback map: {e:?}"))?;

        let gpu_ms = t_gpu_start.elapsed().as_secs_f32() * 1000.0;
        let t_copy = Instant::now();
        let mapped = slice.get_mapped_range();
        let unpadded_bpr = (w * 4) as usize;
        let padded_bpr = targets.padded_bpr as usize;
        let total_len = unpadded_bpr * h as usize;
        reuse_buf.resize(total_len, 0);
        if padded_bpr == unpadded_bpr {
            reuse_buf.copy_from_slice(&mapped[..total_len]);
        } else {
            for y in 0..h as usize {
                let src_off = y * padded_bpr;
                let dst_off = y * unpadded_bpr;
                reuse_buf[dst_off..dst_off + unpadded_bpr].copy_from_slice(&mapped[src_off..src_off + unpadded_bpr]);
            }
        }
        drop(mapped);
        targets.readback_buf.unmap();
        let readback_ms = t_copy.elapsed().as_secs_f32() * 1000.0;

        Ok((
            FrameStats {
                width: w,
                height: h,
                gpu_ms,
                readback_ms,
                draw_calls,
                static_shadow_cached,
            },
            reuse_buf,
        ))
    }

    fn encode_quad_pass(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        label: &str,
        target_view: &wgpu::TextureView,
        clear_color: wgpu::Color,
        pipeline: &wgpu::RenderPipeline,
        tex_bg: &wgpu::BindGroup,
    ) -> u32 {
        let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some(label),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(clear_color),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        rpass.set_pipeline(pipeline);
        rpass.set_bind_group(0, &self.frame_bg, &[]);
        rpass.set_bind_group(1, tex_bg, &[]);
        rpass.draw(0..3, 0..1);
        1
    }
}

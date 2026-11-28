use super::buffers::{SHADOW_SIZE_INTERACTIVE, SHADOW_SIZE_ULTRA};
use super::renderer::MetalRenderer;
use super::textures::{create_msaa_transient_target, create_render_target};
use super::types::RenderQuality;

pub(super) struct ShadowTargets {
    pub size: u32,
    pub format: wgpu::TextureFormat,
    pub static_tex: wgpu::Texture,
    pub static_view: wgpu::TextureView,
    pub final_tex: wgpu::Texture,
    pub final_view: wgpu::TextureView,
    pub scene_tex_bg: wgpu::BindGroup,
    pub static_hash: u64,
    pub has_valid_static: bool,
}

pub(super) struct Targets {
    pub w: u32,
    pub h: u32,
    pub padded_bpr: u32,
    pub scene_color_msaa_view: wgpu::TextureView,
    pub scene_color_view: wgpu::TextureView,
    pub scene_normal_msaa_view: wgpu::TextureView,
    pub scene_normal_view: wgpu::TextureView,
    pub scene_linz_msaa_view: wgpu::TextureView,
    pub scene_linz_view: wgpu::TextureView,
    pub scene_depth_msaa_view: wgpu::TextureView,
    pub bloom_a_view: wgpu::TextureView,
    pub bloom_b_view: wgpu::TextureView,
    pub ao_coc_view: wgpu::TextureView,
    pub final_rgba: wgpu::Texture,
    pub final_rgba_view: wgpu::TextureView,
    pub readback_buf: wgpu::Buffer,
    pub bloom_extract_bg: wgpu::BindGroup,
    pub bloom_h_bg: wgpu::BindGroup,
    pub bloom_v_bg: wgpu::BindGroup,
    pub ao_bg: wgpu::BindGroup,
    pub composite_bg: wgpu::BindGroup,
}

impl MetalRenderer {
    pub(super) fn ensure_shadow_targets(&mut self, quality: RenderQuality) {
        let (size, format) = match quality {
            RenderQuality::Ultra => (SHADOW_SIZE_ULTRA, wgpu::TextureFormat::Depth32Float),
            RenderQuality::Interactive => (SHADOW_SIZE_INTERACTIVE, wgpu::TextureFormat::Depth16Unorm),
        };
        let rebuild = match &self.shadow_targets {
            Some(st) => st.size != size || st.format != format,
            None => true,
        };
        if !rebuild {
            return;
        }
        if self.shadow_targets.is_some() {
            self.shadow_targets = None;
            let _ = self.device.poll(wgpu::PollType::Poll);
        }
        let extra = wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST;
        let (static_tex, static_view) = create_render_target(&self.device, "shadow_static_depth", size, size, format, extra);
        let (final_tex, final_view) = create_render_target(&self.device, "shadow_final_depth", size, size, format, extra);
        let scene_tex_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("scene_tex_bg"),
            layout: &self.scene_tex_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&self.atlas_views[0]),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&self.atlas_views[1]),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&self.atlas_views[2]),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&self.card_fibre_view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(&self.page_fibre_view),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::TextureView(&self.cut_edge_view),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: wgpu::BindingResource::TextureView(&final_view),
                },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::TextureView(&self.blue_noise_view),
                },
                wgpu::BindGroupEntry {
                    binding: 8,
                    resource: wgpu::BindingResource::Sampler(&self.linear_clamp_smp),
                },
                wgpu::BindGroupEntry {
                    binding: 9,
                    resource: wgpu::BindingResource::Sampler(&self.linear_repeat_smp),
                },
                wgpu::BindGroupEntry {
                    binding: 10,
                    resource: wgpu::BindingResource::Sampler(&self.shadow_cmp_smp),
                },
                wgpu::BindGroupEntry {
                    binding: 11,
                    resource: wgpu::BindingResource::TextureView(&self.materials_view),
                },
            ],
        });
        self.shadow_targets = Some(ShadowTargets {
            size,
            format,
            static_tex,
            static_view,
            final_tex,
            final_view,
            scene_tex_bg,
            static_hash: 0,
            has_valid_static: false,
        });
    }

    pub(super) fn ensure_targets(&mut self, w: u32, h: u32) {
        let rebuild = match &self.targets {
            Some(t) => t.w != w || t.h != h,
            None => true,
        };
        if !rebuild {
            return;
        }
        if self.targets.is_some() {
            self.targets = None;
            let _ = self.device.poll(wgpu::PollType::Poll);
        }
        let hw = (w / 2).max(1);
        let hh = (h / 2).max(1);
        let qw = (w / 4).max(1);
        let qh = (h / 4).max(1);
        let unpadded_bpr = w * 4;
        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let padded_bpr = unpadded_bpr.div_ceil(align) * align;

        let (_sc_msaa, scene_color_msaa_view) =
            create_msaa_transient_target(&self.device, "scene_color_msaa4", w, h, wgpu::TextureFormat::Rgba16Float, self.transient_msaa);
        let (_sc_tex, scene_color_view) = create_render_target(
            &self.device,
            "scene_color",
            w,
            h,
            wgpu::TextureFormat::Rgba16Float,
            wgpu::TextureUsages::empty(),
        );
        let (_sn_msaa, scene_normal_msaa_view) =
            create_msaa_transient_target(&self.device, "scene_normal_msaa4", w, h, wgpu::TextureFormat::Rg8Unorm, self.transient_msaa);
        let (_sn_tex, scene_normal_view) =
            create_render_target(&self.device, "scene_normal", w, h, wgpu::TextureFormat::Rg8Unorm, wgpu::TextureUsages::empty());
        let (_sz_msaa, scene_linz_msaa_view) =
            create_msaa_transient_target(&self.device, "scene_linz_msaa4", w, h, wgpu::TextureFormat::R16Float, self.transient_msaa);
        let (_sz_tex, scene_linz_view) = create_render_target(&self.device, "scene_linz", w, h, wgpu::TextureFormat::R16Float, wgpu::TextureUsages::empty());
        let (_sd_msaa, scene_depth_msaa_view) =
            create_msaa_transient_target(&self.device, "scene_depth_msaa4", w, h, wgpu::TextureFormat::Depth32Float, self.transient_msaa);
        let (_ba_tex, bloom_a_view) = create_render_target(&self.device, "bloom_a", qw, qh, self.bloom_format, wgpu::TextureUsages::empty());
        let (_bb_tex, bloom_b_view) = create_render_target(&self.device, "bloom_b", qw, qh, self.bloom_format, wgpu::TextureUsages::empty());
        let (_ao_tex, ao_coc_view) = create_render_target(&self.device, "ao_coc", hw, hh, wgpu::TextureFormat::Rg16Float, wgpu::TextureUsages::empty());
        let (final_rgba, final_rgba_view) =
            create_render_target(&self.device, "final_rgba", w, h, wgpu::TextureFormat::Rgba8Unorm, wgpu::TextureUsages::COPY_SRC);
        let readback_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback_buf"),
            size: (padded_bpr * h) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        let bloom_extract_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("bloom_extract_bg"),
            layout: &self.post_tex1_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&scene_color_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.linear_clamp_smp),
                },
            ],
        });
        let bloom_h_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("bloom_h_bg"),
            layout: &self.post_tex1_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&bloom_a_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.linear_clamp_smp),
                },
            ],
        });
        let bloom_v_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("bloom_v_bg"),
            layout: &self.post_tex1_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&bloom_b_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.linear_clamp_smp),
                },
            ],
        });
        let ao_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ao_bg"),
            layout: &self.ao_tex_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&scene_linz_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&scene_normal_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&self.blue_noise_view),
                },
            ],
        });
        let composite_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("composite_bg"),
            layout: &self.composite_tex_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&scene_color_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&ao_coc_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&bloom_a_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&self.blue_noise_view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::Sampler(&self.linear_clamp_smp),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::TextureView(&scene_normal_view),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: wgpu::BindingResource::TextureView(&scene_linz_view),
                },
            ],
        });

        self.targets = Some(Targets {
            w,
            h,
            padded_bpr,
            scene_color_msaa_view,
            scene_color_view,
            scene_normal_msaa_view,
            scene_normal_view,
            scene_linz_msaa_view,
            scene_linz_view,
            scene_depth_msaa_view,
            bloom_a_view,
            bloom_b_view,
            ao_coc_view,
            final_rgba,
            final_rgba_view,
            readback_buf,
            bloom_extract_bg,
            bloom_h_bg,
            bloom_v_bg,
            ao_bg,
            composite_bg,
        });
    }
}

use std::collections::HashMap;
use std::sync::Arc;

use crate::asset::{AssetBundle, Vertex};
use crate::math::Mat4;
use crate::world::DioramaWorld;

use super::buffers::{DrawIndexedIndirectArgs, FrameChannels, FrameUniforms, InstanceData, MeshBatch, MeshSpan};
use super::pipelines::create_pipelines;
use super::targets::{ShadowTargets, Targets};
use super::textures::upload_bundle_textures;
use super::types::{FrameOutput, FrameStats, RenderQuality, RenderSceneInput, prepare_scene_input};

/// Cross-platform 5-Pass Papercraft 3D Renderer backed by `wgpu` + WGSL
/// (runs natively on Metal/macOS/iOS, Vulkan/Linux/Android, DX12/Windows, and WebGPU).
pub type WgpuRenderer = MetalRenderer;

pub struct MetalRenderer {
    pub(super) device: wgpu::Device,
    pub(super) queue: wgpu::Queue,
    pub(super) vertex_buf: wgpu::Buffer,
    pub(super) index_buf: wgpu::Buffer,
    pub(super) frame_buf: wgpu::Buffer,
    pub(super) bone_buf: wgpu::Buffer,
    pub(super) bone_buf_capacity: usize,
    pub(super) instance_buf: wgpu::Buffer,
    pub(super) instance_buf_capacity: usize,
    pub(super) indirect_buf: wgpu::Buffer,
    pub(super) indirect_buf_capacity: usize,
    pub(super) meshes: HashMap<String, MeshSpan>,
    pub(super) bloom_format: wgpu::TextureFormat,
    pub(super) z_only_shadows: bool,
    pub(super) bc_textures_active: u32,
    pub(super) use_multi_draw_indirect: bool,
    pub(super) transient_msaa: bool,
    pub(super) last_scene_batches: u32,
    pub(super) last_culled_instances: u32,

    pub(super) frame_bgl: wgpu::BindGroupLayout,
    pub(super) scene_tex_bgl: wgpu::BindGroupLayout,
    pub(super) post_tex1_bgl: wgpu::BindGroupLayout,
    pub(super) ao_tex_bgl: wgpu::BindGroupLayout,
    pub(super) composite_tex_bgl: wgpu::BindGroupLayout,

    pub(super) frame_bg: wgpu::BindGroup,
    pub(super) shadow_tex_bg: wgpu::BindGroup,

    pub(super) shadow_pso_d32: wgpu::RenderPipeline,
    pub(super) shadow_pso_d16: wgpu::RenderPipeline,
    pub(super) backdrop_pso: wgpu::RenderPipeline,
    pub(super) scene_pso: wgpu::RenderPipeline,
    pub(super) bloom_extract_pso: wgpu::RenderPipeline,
    pub(super) bloom_blur_h_pso: wgpu::RenderPipeline,
    pub(super) bloom_blur_v_pso: wgpu::RenderPipeline,
    pub(super) ao_pso: wgpu::RenderPipeline,
    pub(super) composite_pso: wgpu::RenderPipeline,

    pub(super) atlas_views: Vec<wgpu::TextureView>,
    pub(super) card_fibre_view: wgpu::TextureView,
    pub(super) page_fibre_view: wgpu::TextureView,
    pub(super) cut_edge_view: wgpu::TextureView,
    pub(super) blue_noise_view: wgpu::TextureView,
    pub(super) materials_view: wgpu::TextureView,
    pub(super) linear_clamp_smp: wgpu::Sampler,
    pub(super) linear_repeat_smp: wgpu::Sampler,
    pub(super) shadow_cmp_smp: wgpu::Sampler,

    pub(super) scratch_sort_keys: Vec<(u8, u32, bool, usize)>,
    pub(super) scratch_instances: Vec<InstanceData>,
    pub(super) scratch_static_shadow_batches: Vec<MeshBatch>,
    pub(super) scratch_dynamic_shadow_batches: Vec<MeshBatch>,
    pub(super) scratch_scene_batches: Vec<MeshBatch>,
    pub(super) scratch_indirect_args: Vec<DrawIndexedIndirectArgs>,
    pub(super) scratch_bone_upload: Vec<[[f32; 4]; 4]>,

    pub(super) shadow_targets: Option<ShadowTargets>,
    pub(super) targets: Option<Targets>,
}

impl MetalRenderer {
    pub fn bc_textures_active(&self) -> u32 {
        self.bc_textures_active
    }

    pub fn z_only_shadows_active(&self) -> bool {
        self.z_only_shadows
    }

    pub fn multi_draw_indirect_active(&self) -> bool {
        self.use_multi_draw_indirect
    }

    pub fn last_scene_batches(&self) -> u32 {
        self.last_scene_batches
    }

    pub fn last_culled_instances(&self) -> u32 {
        self.last_culled_instances
    }

    pub fn msaa_mode_label(&self) -> &'static str {
        if self.transient_msaa { "4x_memoryless" } else { "4x" }
    }

    pub async fn new(bundle: &AssetBundle) -> Result<Self, String> {
        assert_eq!(std::mem::size_of::<Vertex>(), 24);
        assert_eq!(std::mem::size_of::<InstanceData>(), 80);

        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await
            .map_err(|e| format!("wgpu adapter unavailable: {e}"))?;

        let transient_msaa = adapter.get_info().transient_saves_memory;
        let adapter_features = adapter.features();
        let has_rg11b10_render = adapter_features.contains(wgpu::Features::RG11B10UFLOAT_RENDERABLE);
        let has_bc = adapter_features.contains(wgpu::Features::TEXTURE_COMPRESSION_BC);
        let use_multi_draw_indirect = adapter_features.contains(wgpu::Features::INDIRECT_FIRST_INSTANCE);
        let mut required_features = wgpu::Features::empty();
        if has_rg11b10_render {
            required_features |= wgpu::Features::RG11B10UFLOAT_RENDERABLE;
        }
        if has_bc {
            required_features |= wgpu::Features::TEXTURE_COMPRESSION_BC;
        }
        if use_multi_draw_indirect {
            required_features |= wgpu::Features::INDIRECT_FIRST_INSTANCE;
        }
        let bloom_format = if has_rg11b10_render {
            wgpu::TextureFormat::Rg11b10Ufloat
        } else {
            wgpu::TextureFormat::Rgba16Float
        };

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("vibevalley_diorama_device"),
                required_features,
                required_limits: wgpu::Limits::default(),
                experimental_features: Default::default(),
                memory_hints: wgpu::MemoryHints::MemoryUsage,
                trace: Default::default(),
            })
            .await
            .map_err(|e| format!("wgpu device creation failed: {e}"))?;

        let v_bytes = bytemuck::cast_slice::<Vertex, u8>(&bundle.vertices);
        let mut padded_indices;
        let i_slice: &[u16] = if bundle.indices.len().is_multiple_of(2) {
            &bundle.indices
        } else {
            padded_indices = Vec::with_capacity(bundle.indices.len() + 1);
            padded_indices.extend_from_slice(&bundle.indices);
            padded_indices.push(0);
            &padded_indices
        };
        let i_bytes = bytemuck::cast_slice::<u16, u8>(i_slice);
        let vertex_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("vertex_buf"),
            size: v_bytes.len().max(24) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        if !v_bytes.is_empty() {
            queue.write_buffer(&vertex_buf, 0, v_bytes);
        }

        let index_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("index_buf"),
            size: i_bytes.len().max(4) as u64,
            usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        if !i_bytes.is_empty() {
            queue.write_buffer(&index_buf, 0, i_bytes);
        }

        let frame_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("frame_uniforms"),
            size: std::mem::size_of::<FrameUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let bone_buf_capacity = 16 * 32;
        let bone_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("bone_palettes"),
            size: (bone_buf_capacity * std::mem::size_of::<[[f32; 4]; 4]>()) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let init_bones = vec![Mat4::IDENTITY.0; bone_buf_capacity];
        queue.write_buffer(&bone_buf, 0, bytemuck::cast_slice(&init_bones));

        let instance_buf_capacity = 256usize;
        let instance_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("instance_storage"),
            size: (instance_buf_capacity * std::mem::size_of::<InstanceData>()) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let indirect_buf_capacity = 256usize;
        let indirect_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("indirect_draw_args"),
            size: (indirect_buf_capacity * std::mem::size_of::<DrawIndexedIndirectArgs>()) as u64,
            usage: wgpu::BufferUsages::INDIRECT | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let mut mesh_names: Vec<&String> = bundle.manifest.meshes.keys().collect();
        mesh_names.sort();
        let mut meshes = HashMap::with_capacity(mesh_names.len());
        let mut atlas_used = vec![false; bundle.atlases.len()];
        let mut has_alpha_shadow_cards = false;
        for (key_idx, name) in mesh_names.into_iter().enumerate() {
            let m = &bundle.manifest.meshes[name];
            let [hx, hy, hz] = m.obb_half;
            let obb_radius = (hx * hx + hy * hy + hz * hz).sqrt();
            meshes.insert(
                name.clone(),
                MeshSpan {
                    mesh_key: key_idx as u32,
                    vertex_offset: m.vertex_offset as i32,
                    index_offset: m.index_offset,
                    index_count: m.index_count,
                    atlas_index: m.atlas_index,
                    obb_hy: hy,
                    obb_radius,
                },
            );
            let v_start = m.vertex_offset as usize;
            let v_end = (v_start + m.vertex_count as usize).min(bundle.vertices.len());
            for v in &bundle.vertices[v_start..v_end] {
                let flag = v.mat_flag();
                if flag == 1 || flag == 5 {
                    has_alpha_shadow_cards = true;
                }
                if m.atlas_index < atlas_used.len() && !atlas_used[m.atlas_index] {
                    let needs_atlas = if m.atlas_index < 2 { flag == 1 || flag == 5 } else { flag == 0 };
                    if needs_atlas {
                        atlas_used[m.atlas_index] = true;
                    }
                }
            }
        }
        let z_only_shadows = !has_alpha_shadow_cards;

        let tex = upload_bundle_textures(&device, &queue, bundle, &atlas_used, has_bc)?;
        let pipes = create_pipelines(
            &device,
            &frame_buf,
            &bone_buf,
            &instance_buf,
            &tex.atlas_views,
            &tex.linear_clamp_smp,
            bloom_format,
            z_only_shadows,
        );

        Ok(Self {
            device,
            queue,
            vertex_buf,
            index_buf,
            frame_buf,
            bone_buf,
            bone_buf_capacity,
            instance_buf,
            instance_buf_capacity,
            indirect_buf,
            indirect_buf_capacity,
            meshes,
            bloom_format,
            z_only_shadows,
            bc_textures_active: tex.bc_textures_active,
            use_multi_draw_indirect,
            transient_msaa,
            last_scene_batches: 0,
            last_culled_instances: 0,
            frame_bgl: pipes.frame_bgl,
            scene_tex_bgl: pipes.scene_tex_bgl,
            post_tex1_bgl: pipes.post_tex1_bgl,
            ao_tex_bgl: pipes.ao_tex_bgl,
            composite_tex_bgl: pipes.composite_tex_bgl,
            frame_bg: pipes.frame_bg,
            shadow_tex_bg: pipes.shadow_tex_bg,
            shadow_pso_d32: pipes.shadow_pso_d32,
            shadow_pso_d16: pipes.shadow_pso_d16,
            backdrop_pso: pipes.backdrop_pso,
            scene_pso: pipes.scene_pso,
            bloom_extract_pso: pipes.bloom_extract_pso,
            bloom_blur_h_pso: pipes.bloom_blur_h_pso,
            bloom_blur_v_pso: pipes.bloom_blur_v_pso,
            ao_pso: pipes.ao_pso,
            composite_pso: pipes.composite_pso,
            atlas_views: tex.atlas_views,
            card_fibre_view: tex.card_fibre_view,
            page_fibre_view: tex.page_fibre_view,
            cut_edge_view: tex.cut_edge_view,
            blue_noise_view: tex.blue_noise_view,
            materials_view: tex.materials_view,
            linear_clamp_smp: tex.linear_clamp_smp,
            linear_repeat_smp: tex.linear_repeat_smp,
            shadow_cmp_smp: tex.shadow_cmp_smp,
            scratch_sort_keys: Vec::with_capacity(256),
            scratch_instances: Vec::with_capacity(256),
            scratch_static_shadow_batches: Vec::with_capacity(64),
            scratch_dynamic_shadow_batches: Vec::with_capacity(32),
            scratch_scene_batches: Vec::with_capacity(64),
            scratch_indirect_args: Vec::with_capacity(160),
            scratch_bone_upload: Vec::with_capacity(16 * 32),
            shadow_targets: None,
            targets: None,
        })
    }

    pub fn render_frame(&mut self, world: &DioramaWorld, bundle: &AssetBundle, width: u32, height: u32) -> Result<FrameOutput, String> {
        self.render_frame_with_quality(world, bundle, width, height, RenderQuality::Ultra)
    }

    pub fn render_frame_with_quality(
        &mut self,
        world: &DioramaWorld,
        bundle: &AssetBundle,
        width: u32,
        height: u32,
        quality: RenderQuality,
    ) -> Result<FrameOutput, String> {
        let w = width.max(16);
        let h = height.max(16);
        let aspect = w as f32 / h as f32;
        let input = prepare_scene_input(world, bundle, aspect);
        self.render_scene_input(&input, w, h, quality)
    }

    pub fn render_scene_input(&mut self, input: &RenderSceneInput, width: u32, height: u32, quality: RenderQuality) -> Result<FrameOutput, String> {
        let (stats, pixels) = self.render_scene_input_with_buf(input, width, height, quality, Vec::new())?;
        Ok(FrameOutput {
            width: stats.width,
            height: stats.height,
            rgba: Arc::from(pixels),
            gpu_ms: stats.gpu_ms,
            readback_ms: stats.readback_ms,
            draw_calls: stats.draw_calls,
            static_shadow_cached: stats.static_shadow_cached,
        })
    }

    pub fn render_scene_input_with_buf(
        &mut self,
        input: &RenderSceneInput,
        width: u32,
        height: u32,
        quality: RenderQuality,
        reuse_buf: Vec<u8>,
    ) -> Result<(FrameStats, Vec<u8>), String> {
        self.render_pixels(input, width, height, quality, reuse_buf, FrameChannels::Rgba)
    }

    pub fn render_bgra_with_buf(
        &mut self,
        input: &RenderSceneInput,
        width: u32,
        height: u32,
        quality: RenderQuality,
        reuse_buf: Vec<u8>,
    ) -> Result<(FrameStats, Vec<u8>), String> {
        self.render_pixels(input, width, height, quality, reuse_buf, FrameChannels::Bgra)
    }
}

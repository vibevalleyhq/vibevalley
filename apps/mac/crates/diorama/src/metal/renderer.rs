use super::types::{DofMode, FrameOutput, FrameStats, RenderQuality, RenderSceneInput, prepare_scene_input};
use crate::asset::{AssetBundle, CompressedTexture, TextureImage, Vertex};
use crate::math::{Mat4, Vec3};
use crate::world::DioramaWorld;
use bytemuck::{Pod, Zeroable};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

const SHADER_SOURCE: &str = include_str!("shaders.wgsl");
const SHADOW_SIZE_ULTRA: u32 = 2048;
const SHADOW_SIZE_INTERACTIVE: u32 = 1024;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct FrameUniforms {
    view_proj: [[f32; 4]; 4],
    light_view_proj: [[f32; 4]; 4],
    cam_pos_aspect: [f32; 4],
    cam_target_slab_half: [f32; 4],
    cam_right_gobo: [f32; 4],
    cam_up_day_factor: [f32; 4],
    cam_fwd_bloom_str: [f32; 4],
    proj_params: [f32; 4],
    key_dir_intensity: [f32; 4],
    key_color_wrap: [f32; 4],
    sky_color_hemi: [f32; 4],
    ground_color_exp: [f32; 4],
    shadow_leak_str: [f32; 4],
    table_bg_lamp_count: [f32; 4],
    fog_color_lamp_int: [f32; 4],
    lamp_color_time: [f32; 4],
    tilt_a: [f32; 4],
    tilt_b: [f32; 4],
    lamp_pools: [[f32; 4]; 32],
    light_grid_bounds: [f32; 4],
    light_grid: [[u32; 4]; 16],
    quality_pad: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct DrawIndexedIndirectArgs {
    index_count: u32,
    instance_count: u32,
    first_index: u32,
    base_vertex: i32,
    first_instance: u32,
}

const _: () = assert!(std::mem::size_of::<DrawIndexedIndirectArgs>() == 20);

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct InstanceData {
    model: [[f32; 4]; 4],
    params: [f32; 4], // [atlas_index, highlight, bone_base, 0.0]
}

#[derive(Clone, Copy)]
enum FrameChannels {
    Rgba,
    Bgra,
}

#[derive(Clone, Copy)]
struct MeshSpan {
    mesh_key: u32,
    vertex_offset: i32,
    index_offset: u32,
    index_count: u32,
    atlas_index: usize,
    obb_hy: f32,
    obb_radius: f32,
}

#[derive(Clone, Copy)]
struct MeshBatch {
    base_vertex: i32,
    index_offset: u32,
    index_count: u32,
    inst_start: u32,
    inst_end: u32,
}

struct ShadowTargets {
    size: u32,
    format: wgpu::TextureFormat,
    static_tex: wgpu::Texture,
    static_view: wgpu::TextureView,
    final_tex: wgpu::Texture,
    final_view: wgpu::TextureView,
    scene_tex_bg: wgpu::BindGroup,
    static_hash: u64,
    has_valid_static: bool,
}

struct Targets {
    w: u32,
    h: u32,
    padded_bpr: u32,
    scene_color_msaa_view: wgpu::TextureView,
    scene_color_view: wgpu::TextureView,
    scene_normal_msaa_view: wgpu::TextureView,
    scene_normal_view: wgpu::TextureView,
    scene_linz_msaa_view: wgpu::TextureView,
    scene_linz_view: wgpu::TextureView,
    scene_depth_msaa_view: wgpu::TextureView,
    bloom_a_view: wgpu::TextureView,
    bloom_b_view: wgpu::TextureView,
    ao_coc_view: wgpu::TextureView,
    final_rgba: wgpu::Texture,
    final_rgba_view: wgpu::TextureView,
    readback_buf: wgpu::Buffer,
    bloom_extract_bg: wgpu::BindGroup,
    bloom_h_bg: wgpu::BindGroup,
    bloom_v_bg: wgpu::BindGroup,
    ao_bg: wgpu::BindGroup,
    composite_bg: wgpu::BindGroup,
}

/// Cross-platform 5-Pass Papercraft 3D Renderer backed by `wgpu` + WGSL
/// (runs natively on Metal/macOS/iOS, Vulkan/Linux/Android, DX12/Windows, and WebGPU).
pub type WgpuRenderer = MetalRenderer;

pub struct MetalRenderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    vertex_buf: wgpu::Buffer,
    index_buf: wgpu::Buffer,
    frame_buf: wgpu::Buffer,
    bone_buf: wgpu::Buffer,
    bone_buf_capacity: usize,
    instance_buf: wgpu::Buffer,
    instance_buf_capacity: usize,
    indirect_buf: wgpu::Buffer,
    indirect_buf_capacity: usize,
    meshes: HashMap<String, MeshSpan>,
    bloom_format: wgpu::TextureFormat,
    z_only_shadows: bool,
    bc_textures_active: u32,
    use_multi_draw_indirect: bool,
    transient_msaa: bool,
    last_scene_batches: u32,
    last_culled_instances: u32,

    frame_bgl: wgpu::BindGroupLayout,
    scene_tex_bgl: wgpu::BindGroupLayout,
    post_tex1_bgl: wgpu::BindGroupLayout,
    ao_tex_bgl: wgpu::BindGroupLayout,
    composite_tex_bgl: wgpu::BindGroupLayout,

    frame_bg: wgpu::BindGroup,
    shadow_tex_bg: wgpu::BindGroup,

    shadow_pso_d32: wgpu::RenderPipeline,
    shadow_pso_d16: wgpu::RenderPipeline,
    backdrop_pso: wgpu::RenderPipeline,
    scene_pso: wgpu::RenderPipeline,
    bloom_extract_pso: wgpu::RenderPipeline,
    bloom_blur_h_pso: wgpu::RenderPipeline,
    bloom_blur_v_pso: wgpu::RenderPipeline,
    ao_pso: wgpu::RenderPipeline,
    composite_pso: wgpu::RenderPipeline,

    atlas_views: Vec<wgpu::TextureView>,
    card_fibre_view: wgpu::TextureView,
    page_fibre_view: wgpu::TextureView,
    cut_edge_view: wgpu::TextureView,
    blue_noise_view: wgpu::TextureView,
    materials_view: wgpu::TextureView,
    linear_clamp_smp: wgpu::Sampler,
    linear_repeat_smp: wgpu::Sampler,
    shadow_cmp_smp: wgpu::Sampler,

    // Reusable per-frame scratch buffers (zero heap allocation in steady state)
    scratch_sort_keys: Vec<(u8, u32, bool, usize)>,
    scratch_instances: Vec<InstanceData>,
    scratch_static_shadow_batches: Vec<MeshBatch>,
    scratch_dynamic_shadow_batches: Vec<MeshBatch>,
    scratch_scene_batches: Vec<MeshBatch>,
    scratch_indirect_args: Vec<DrawIndexedIndirectArgs>,
    scratch_bone_upload: Vec<[[f32; 4]; 4]>,

    shadow_targets: Option<ShadowTargets>,
    targets: Option<Targets>,
}

fn upload_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    tex: &TextureImage,
    format: wgpu::TextureFormat,
) -> (wgpu::Texture, wgpu::TextureView) {
    let size = wgpu::Extent3d {
        width: tex.width,
        height: tex.height,
        depth_or_array_layers: 1,
    };
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &tex.rgba,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(tex.width * 4),
            rows_per_image: Some(tex.height),
        },
        size,
    );
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

fn create_render_target(
    device: &wgpu::Device,
    label: &str,
    w: u32,
    h: u32,
    format: wgpu::TextureFormat,
    extra_usage: wgpu::TextureUsages,
) -> (wgpu::Texture, wgpu::TextureView) {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | extra_usage,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

fn create_msaa_transient_target(
    device: &wgpu::Device,
    label: &str,
    w: u32,
    h: u32,
    format: wgpu::TextureFormat,
    use_transient: bool,
) -> (wgpu::Texture, wgpu::TextureView) {
    let usage = if use_transient {
        wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TRANSIENT
    } else {
        wgpu::TextureUsages::RENDER_ATTACHMENT
    };
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 4,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

fn upload_rgba_mipmapped(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    tex: &TextureImage,
    format: wgpu::TextureFormat,
) -> (wgpu::Texture, wgpu::TextureView) {
    let is_srgb = matches!(format, wgpu::TextureFormat::Rgba8UnormSrgb);
    let max_dim = tex.width.max(tex.height).max(1);
    let mip_count = (32 - max_dim.leading_zeros()).max(1);
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: tex.width,
            height: tex.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: mip_count,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });

    let mut cur_w = tex.width;
    let mut cur_h = tex.height;
    let mut cur_rgba = tex.rgba.clone();
    for mip in 0..mip_count {
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: mip,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &cur_rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(cur_w * 4),
                rows_per_image: Some(cur_h),
            },
            wgpu::Extent3d {
                width: cur_w,
                height: cur_h,
                depth_or_array_layers: 1,
            },
        );
        if mip + 1 == mip_count {
            break;
        }
        let nw = (cur_w / 2).max(1);
        let nh = (cur_h / 2).max(1);
        let mut next = vec![0u8; (nw * nh * 4) as usize];
        let srgb_to_lin = |v: u8| (v as f32 / 255.0).powf(2.2);
        let lin_to_srgb = |v: f32| (v.clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0).round() as u8;
        for y in 0..nh {
            for x in 0..nw {
                let x0 = (x * 2).min(cur_w - 1);
                let x1 = (x * 2 + 1).min(cur_w - 1);
                let y0 = (y * 2).min(cur_h - 1);
                let y1 = (y * 2 + 1).min(cur_h - 1);
                let coords = [(x0, y0), (x1, y0), (x0, y1), (x1, y1)];
                let dst = ((y * nw + x) * 4) as usize;
                if is_srgb {
                    let mut sum = [0.0f32; 4];
                    for (sx, sy) in coords {
                        let s = ((sy * cur_w + sx) * 4) as usize;
                        sum[0] += srgb_to_lin(cur_rgba[s]);
                        sum[1] += srgb_to_lin(cur_rgba[s + 1]);
                        sum[2] += srgb_to_lin(cur_rgba[s + 2]);
                        sum[3] += cur_rgba[s + 3] as f32;
                    }
                    next[dst] = lin_to_srgb(sum[0] * 0.25);
                    next[dst + 1] = lin_to_srgb(sum[1] * 0.25);
                    next[dst + 2] = lin_to_srgb(sum[2] * 0.25);
                    next[dst + 3] = (sum[3] * 0.25).round() as u8;
                } else {
                    let mut sum = [0u32; 4];
                    for (sx, sy) in coords {
                        let s = ((sy * cur_w + sx) * 4) as usize;
                        sum[0] += cur_rgba[s] as u32;
                        sum[1] += cur_rgba[s + 1] as u32;
                        sum[2] += cur_rgba[s + 2] as u32;
                        sum[3] += cur_rgba[s + 3] as u32;
                    }
                    for c in 0..4 {
                        next[dst + c] = ((sum[c] + 2) / 4) as u8;
                    }
                }
            }
        }
        cur_w = nw;
        cur_h = nh;
        cur_rgba = next;
    }

    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

fn upload_compressed_texture(device: &wgpu::Device, queue: &wgpu::Queue, label: &str, ct: &CompressedTexture) -> Option<(wgpu::Texture, wgpu::TextureView)> {
    let (format, block_bytes) = match ct.format {
        1 => (wgpu::TextureFormat::Bc1RgbaUnormSrgb, 8u32),
        2 => (wgpu::TextureFormat::Bc1RgbaUnorm, 8u32),
        3 => (wgpu::TextureFormat::Bc3RgbaUnormSrgb, 16u32),
        4 => (wgpu::TextureFormat::Bc3RgbaUnorm, 16u32),
        _ => return None,
    };
    if ct.width < 4 || ct.height < 4 || !ct.width.is_multiple_of(4) || !ct.height.is_multiple_of(4) || ct.mip_count == 0 {
        return None;
    }
    // Validate body byte length covers every mip before creating texture
    let mut total_needed = 0usize;
    for m in 0..ct.mip_count {
        let mw = (ct.width >> m).max(1);
        let mh = (ct.height >> m).max(1);
        let bw = mw.div_ceil(4);
        let bh = mh.div_ceil(4);
        total_needed += (bw * bh * block_bytes) as usize;
    }
    if ct.data.len() < total_needed {
        return None;
    }

    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: ct.width,
            height: ct.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: ct.mip_count as u32,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });

    let mut offset = 0usize;
    for m in 0..ct.mip_count {
        let mw = (ct.width >> m).max(1);
        let mh = (ct.height >> m).max(1);
        let bw = mw.div_ceil(4);
        let bh = mh.div_ceil(4);
        let bpr = bw * block_bytes;
        let mip_bytes = (bpr * bh) as usize;
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: m as u32,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &ct.data[offset..offset + mip_bytes],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bpr),
                rows_per_image: Some(bh),
            },
            wgpu::Extent3d {
                width: bw * 4,
                height: bh * 4,
                depth_or_array_layers: 1,
            },
        );
        offset += mip_bytes;
    }

    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    Some((texture, view))
}

fn vertex_layout() -> wgpu::VertexBufferLayout<'static> {
    const ATTRS: [wgpu::VertexAttribute; 4] = [
        wgpu::VertexAttribute {
            offset: 0,
            shader_location: 0,
            format: wgpu::VertexFormat::Float32x3,
        },
        wgpu::VertexAttribute {
            offset: 12,
            shader_location: 1,
            format: wgpu::VertexFormat::Float16x2,
        },
        wgpu::VertexAttribute {
            offset: 16,
            shader_location: 2,
            format: wgpu::VertexFormat::Unorm8x4,
        },
        wgpu::VertexAttribute {
            offset: 20,
            shader_location: 3,
            format: wgpu::VertexFormat::Uint32,
        },
    ];
    wgpu::VertexBufferLayout {
        array_stride: std::mem::size_of::<Vertex>() as wgpu::BufferAddress,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &ATTRS,
    }
}

fn make_frame_bg(
    device: &wgpu::Device,
    bgl: &wgpu::BindGroupLayout,
    frame_buf: &wgpu::Buffer,
    bone_buf: &wgpu::Buffer,
    instance_buf: &wgpu::Buffer,
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("frame_bg"),
        layout: bgl,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: frame_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: bone_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: instance_buf.as_entire_binding(),
            },
        ],
    })
}

fn fnv1a_u64(hash: &mut u64, val: u64) {
    *hash ^= val;
    *hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
}

fn push_batch(batches: &mut Vec<MeshBatch>, span: MeshSpan, inst_idx: u32) {
    if let Some(last) = batches.last_mut()
        && last.base_vertex == span.vertex_offset
        && last.index_offset == span.index_offset
        && last.index_count == span.index_count
        && last.inst_end == inst_idx
    {
        last.inst_end = inst_idx + 1;
        return;
    }
    batches.push(MeshBatch {
        base_vertex: span.vertex_offset,
        index_offset: span.index_offset,
        index_count: span.index_count,
        inst_start: inst_idx,
        inst_end: inst_idx + 1,
    });
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

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("papercraft_wgsl"),
            source: wgpu::ShaderSource::Wgsl(SHADER_SOURCE.into()),
        });

        // Static geometry buffers (24B compact VVM2 vertices + u16 local indices, 4B-aligned upload)
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

        // Samplers (4x Anisotropic trilinear + hardware PCF comparison sampler)
        let linear_clamp_smp = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("linear_clamp_aniso4"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            anisotropy_clamp: 4,
            ..Default::default()
        });
        let linear_repeat_smp = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("linear_repeat_aniso4"),
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            address_mode_w: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            anisotropy_clamp: 4,
            ..Default::default()
        });
        let shadow_cmp_smp = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("shadow_cmp_pcf"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            compare: Some(wgpu::CompareFunction::LessEqual),
            ..Default::default()
        });

        // Textures: dead atlases -> 1x1 fallback; hardware BC1/BC3 mip pyramids when supported,
        // lazily decoding PNG fallback via `bundle.load_rgba_fallback` ONLY if BC is unsupported!
        let dummy_1x1 = TextureImage {
            width: 1,
            height: 1,
            rgba: vec![0, 0, 0, 0],
        };
        let mut bc_textures_active = 0u32;
        let mut upload_bc_or_fallback = |label: &str,
                                         bc_opt: Option<&CompressedTexture>,
                                         rgba_tex: &TextureImage,
                                         fallback_rel: &str,
                                         fallback_fmt: wgpu::TextureFormat|
         -> Result<wgpu::TextureView, String> {
            if has_bc
                && let Some(ct) = bc_opt
                && let Some((_t, v)) = upload_compressed_texture(&device, &queue, &format!("{label}_bc"), ct)
            {
                bc_textures_active += 1;
                return Ok(v);
            }
            if !rgba_tex.rgba.is_empty() {
                Ok(upload_rgba_mipmapped(&device, &queue, label, rgba_tex, fallback_fmt).1)
            } else {
                let lazy_tex = bundle.load_rgba_fallback(fallback_rel)?;
                Ok(upload_rgba_mipmapped(&device, &queue, label, &lazy_tex, fallback_fmt).1)
            }
        };

        let mut atlas_views = Vec::with_capacity(bundle.atlases.len());
        for (i, a) in bundle.atlases.iter().enumerate() {
            if i == 2 {
                let rel = bundle.manifest.atlases.get(2).map(|d| d.file.as_str()).unwrap_or("print/yard_ground.png");
                let view = upload_bc_or_fallback("atlas_2_ground", bundle.ground_bc.as_ref(), a, rel, wgpu::TextureFormat::Rgba8UnormSrgb)?;
                atlas_views.push(view);
                continue;
            }
            let src = if atlas_used.get(i).copied().unwrap_or(false) && !a.rgba.is_empty() {
                a
            } else {
                &dummy_1x1
            };
            let (_tex, view) = if src.width > 1 || src.height > 1 {
                upload_rgba_mipmapped(&device, &queue, &format!("atlas_{i}"), src, wgpu::TextureFormat::Rgba8UnormSrgb)
            } else {
                upload_texture(&device, &queue, &format!("atlas_{i}"), src, wgpu::TextureFormat::Rgba8UnormSrgb)
            };
            atlas_views.push(view);
        }

        let card_fibre_view = upload_bc_or_fallback(
            "card_fibre",
            bundle.card_fibre_bc.as_ref(),
            &bundle.card_fibre,
            "stock/card_fibre.png",
            wgpu::TextureFormat::Rgba8Unorm,
        )?;
        let page_fibre_view = upload_bc_or_fallback(
            "page_fibre",
            bundle.page_fibre_bc.as_ref(),
            &bundle.page_fibre,
            "stock/page_fibre.png",
            wgpu::TextureFormat::Rgba8Unorm,
        )?;
        let cut_edge_view = upload_bc_or_fallback(
            "cut_edge",
            bundle.cut_edge_bc.as_ref(),
            &bundle.cut_edge,
            "stock/cut_edge.png",
            wgpu::TextureFormat::Rgba8UnormSrgb,
        )?;

        let (_bn_tex, blue_noise_view) = upload_texture(&device, &queue, "blue_noise", &bundle.blue_noise, wgpu::TextureFormat::Rgba8Unorm);
        let neutral_mat_1x1 = TextureImage {
            width: 1,
            height: 1,
            rgba: vec![188, 188, 188, 255],
        };
        let materials_view = if has_bc {
            if let Some(ct) = bundle.materials_bc.as_ref() {
                if let Some((_t, v)) = upload_compressed_texture(&device, &queue, "materials_bc", ct) {
                    bc_textures_active += 1;
                    v
                } else {
                    upload_texture(&device, &queue, "materials_fallback_1x1", &neutral_mat_1x1, wgpu::TextureFormat::Rgba8UnormSrgb).1
                }
            } else {
                upload_texture(&device, &queue, "materials_fallback_1x1", &neutral_mat_1x1, wgpu::TextureFormat::Rgba8UnormSrgb).1
            }
        } else {
            upload_texture(&device, &queue, "materials_fallback_1x1", &neutral_mat_1x1, wgpu::TextureFormat::Rgba8UnormSrgb).1
        };

        // Bind Group Layouts (Group 0 = frame + bones + instances, Group 1 = pass textures)
        let frame_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("frame_bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let tex2d_entry = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let depth_entry = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Depth,
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let smp_entry = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        };
        let cmp_smp_entry = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison),
            count: None,
        };

        let shadow_tex_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("shadow_tex_bgl"),
            entries: &[tex2d_entry(0), tex2d_entry(1), smp_entry(2)],
        });
        let scene_tex_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("scene_tex_bgl"),
            entries: &[
                tex2d_entry(0),
                tex2d_entry(1),
                tex2d_entry(2),
                tex2d_entry(3),
                tex2d_entry(4),
                tex2d_entry(5),
                depth_entry(6),
                tex2d_entry(7),
                smp_entry(8),
                smp_entry(9),
                cmp_smp_entry(10),
                tex2d_entry(11),
            ],
        });
        let post_tex1_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("post_tex1_bgl"),
            entries: &[tex2d_entry(0), smp_entry(1)],
        });
        let ao_tex_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("ao_tex_bgl"),
            entries: &[tex2d_entry(0), tex2d_entry(1), tex2d_entry(2)],
        });
        let composite_tex_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("composite_tex_bgl"),
            entries: &[
                tex2d_entry(0),
                tex2d_entry(1),
                tex2d_entry(2),
                tex2d_entry(3),
                smp_entry(4),
                tex2d_entry(5),
                tex2d_entry(6),
            ],
        });

        let frame_bg = make_frame_bg(&device, &frame_bgl, &frame_buf, &bone_buf, &instance_buf);
        let shadow_tex_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("shadow_tex_bg"),
            layout: &shadow_tex_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&atlas_views[0]),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&atlas_views[1]),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&linear_clamp_smp),
                },
            ],
        });

        // Pipeline Layouts & Pipelines
        let depth_rw_for = |format: wgpu::TextureFormat| {
            Some(wgpu::DepthStencilState {
                format,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::LessEqual),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            })
        };
        // Reverse-order Early-Z backdrop: drawn AFTER scene at z=1.0 with Equal compare!
        let depth_earlyz_backdrop = Some(wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth32Float,
            depth_write_enabled: Some(false),
            depth_compare: Some(wgpu::CompareFunction::Equal),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        });

        let shadow_pl = if z_only_shadows {
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("shadow_zonly_pl"),
                bind_group_layouts: &[Some(&frame_bgl)],
                immediate_size: 0,
            })
        } else {
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("shadow_alpha_pl"),
                bind_group_layouts: &[Some(&frame_bgl), Some(&shadow_tex_bgl)],
                immediate_size: 0,
            })
        };
        let make_shadow_pso = |label: &str, depth_fmt: wgpu::TextureFormat| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&shadow_pl),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some(if z_only_shadows { "shadow_zonly_vs" } else { "shadow_vs" }),
                    compilation_options: Default::default(),
                    buffers: &[vertex_layout()],
                },
                fragment: if z_only_shadows {
                    None
                } else {
                    Some(wgpu::FragmentState {
                        module: &shader,
                        entry_point: Some("shadow_fs"),
                        compilation_options: Default::default(),
                        targets: &[],
                    })
                },
                primitive: wgpu::PrimitiveState {
                    cull_mode: None,
                    ..Default::default()
                },
                depth_stencil: depth_rw_for(depth_fmt),
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let shadow_pso_d32 = make_shadow_pso("shadow_pso_d32", wgpu::TextureFormat::Depth32Float);
        let shadow_pso_d16 = make_shadow_pso("shadow_pso_d16", wgpu::TextureFormat::Depth16Unorm);

        let msaa4_state = wgpu::MultisampleState {
            count: 4,
            mask: !0,
            alpha_to_coverage_enabled: false,
        };
        let scene_mrt_targets = [
            Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba16Float,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            }),
            Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rg8Unorm,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            }),
            Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::R16Float,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            }),
        ];

        let backdrop_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("backdrop_pl"),
            bind_group_layouts: &[Some(&frame_bgl)],
            immediate_size: 0,
        });
        let backdrop_pso = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("backdrop_pso"),
            layout: Some(&backdrop_pl),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("backdrop_vs"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("backdrop_fs"),
                compilation_options: Default::default(),
                targets: &scene_mrt_targets,
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: depth_earlyz_backdrop,
            multisample: msaa4_state,
            multiview_mask: None,
            cache: None,
        });

        let scene_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("scene_pl"),
            bind_group_layouts: &[Some(&frame_bgl), Some(&scene_tex_bgl)],
            immediate_size: 0,
        });
        let scene_pso = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("scene_pso"),
            layout: Some(&scene_pl),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("scene_vs"),
                compilation_options: Default::default(),
                buffers: &[vertex_layout()],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("scene_fs"),
                compilation_options: Default::default(),
                targets: &scene_mrt_targets,
            }),
            primitive: wgpu::PrimitiveState {
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: depth_rw_for(wgpu::TextureFormat::Depth32Float),
            multisample: msaa4_state,
            multiview_mask: None,
            cache: None,
        });

        let post_tex1_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("post_tex1_pl"),
            bind_group_layouts: &[Some(&frame_bgl), Some(&post_tex1_bgl)],
            immediate_size: 0,
        });
        let make_quad_pso = |label: &str, pl: &wgpu::PipelineLayout, fs: &str, fmt: wgpu::TextureFormat| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(pl),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("quad_vs"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(fs),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: fmt,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            })
        };

        let bloom_extract_pso = make_quad_pso("bloom_extract_pso", &post_tex1_pl, "bloom_extract_fs", bloom_format);
        let bloom_blur_h_pso = make_quad_pso("bloom_blur_h_pso", &post_tex1_pl, "bloom_blur_h_fs", bloom_format);
        let bloom_blur_v_pso = make_quad_pso("bloom_blur_v_pso", &post_tex1_pl, "bloom_blur_v_fs", bloom_format);

        let ao_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("ao_pl"),
            bind_group_layouts: &[Some(&frame_bgl), Some(&ao_tex_bgl)],
            immediate_size: 0,
        });
        let ao_pso = make_quad_pso("ao_pso", &ao_pl, "ao_coc_fs", wgpu::TextureFormat::Rg16Float);

        let composite_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("composite_pl"),
            bind_group_layouts: &[Some(&frame_bgl), Some(&composite_tex_bgl)],
            immediate_size: 0,
        });
        let composite_pso = make_quad_pso("composite_pso", &composite_pl, "composite_fs", wgpu::TextureFormat::Rgba8Unorm);

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
            bc_textures_active,
            use_multi_draw_indirect,
            transient_msaa,
            last_scene_batches: 0,
            last_culled_instances: 0,
            frame_bgl,
            scene_tex_bgl,
            post_tex1_bgl,
            ao_tex_bgl,
            composite_tex_bgl,
            frame_bg,
            shadow_tex_bg,
            shadow_pso_d32,
            shadow_pso_d16,
            backdrop_pso,
            scene_pso,
            bloom_extract_pso,
            bloom_blur_h_pso,
            bloom_blur_v_pso,
            ao_pso,
            composite_pso,
            atlas_views,
            card_fibre_view,
            page_fibre_view,
            cut_edge_view,
            blue_noise_view,
            materials_view,
            linear_clamp_smp,
            linear_repeat_smp,
            shadow_cmp_smp,
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

    fn ensure_shadow_targets(&mut self, quality: RenderQuality) {
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

    fn ensure_targets(&mut self, w: u32, h: u32) {
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

    fn render_pixels(
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

        // Adaptive macro/interior DoF + resolution-proportional bokeh + DofMode optics
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
        let frame_u = FrameUniforms {
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
        self.queue.write_buffer(&self.frame_buf, 0, bytemuck::bytes_of(&frame_u));

        // Upload flat GPU bone palette storage buffer using reusable scratch buffer
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

        // Extract 6 normalized Gribb-Hartmann frustum planes from cam.view_proj (Metal z in [0, 1])
        let frustum_planes = {
            let m = &cam.view_proj.0;
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
                norm(add(r3, r0)), // Left
                norm(sub(r3, r0)), // Right
                norm(add(r3, r1)), // Bottom
                norm(sub(r3, r1)), // Top
                norm(r2),          // Near
                norm(sub(r3, r2)), // Far
            ]
        };

        // Group instances by (shadow_category, mesh_key, !scene_visible) for contiguous GPU instancing,
        // frustum culling of Pass 2 scene geometry, and unculled Pass 1 static/dynamic shadow caching!
        // category 0 = static shadow caster, 1 = dynamic shadow caster, 2 = non-shadow-caster
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
                    continue; // Off-screen and non-shadow-casting: skip completely
                }
            }
            self.scratch_sort_keys.push((cat, span.mesh_key, !scene_visible, idx));
        }
        self.scratch_sort_keys.sort_by_key(|&(cat, mkey, hidden, idx)| (cat, mkey, hidden, idx));

        // Pack 80B InstanceData storage buffer, build instanced MeshBatches, and hash static casters
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
                // Hash world translation & X basis (1mm precision) + upright cos(hinge) bucket so
                // gentle <=0.035 rad breeze flutter preserves static shadow cache hits while popup
                // fold-up, editor drag/rotate/scale, and time-of-day changes invalidate immediately.
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

        // Pack all Multi-Draw Indexed Indirect argument ranges into one GPU indirect buffer
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

        let shadow_pso = if shadow_fmt == wgpu::TextureFormat::Depth16Unorm {
            &self.shadow_pso_d16
        } else {
            &self.shadow_pso_d32
        };

        let st = self.shadow_targets.as_mut().unwrap();
        let static_shadow_cached = st.has_valid_static && st.static_hash == static_hash;
        let targets = self.targets.as_ref().unwrap();
        let mut draw_calls = 0u32;

        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("papercraft_5pass_encoder"),
        });

        // ---------------------------------------------------------------------
        // Pass 1: Static Cached + Dynamic Instanced Directional Shadow Map
        // ---------------------------------------------------------------------
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
            if self.use_multi_draw_indirect && static_batch_cnt > 0 {
                rpass.multi_draw_indexed_indirect(&self.indirect_buf, static_indirect_off, static_batch_cnt);
                draw_calls += 1;
            } else {
                for b in &self.scratch_static_shadow_batches {
                    rpass.draw_indexed(b.index_offset..(b.index_offset + b.index_count), b.base_vertex, b.inst_start..b.inst_end);
                    draw_calls += 1;
                }
            }
            st.static_hash = static_hash;
            st.has_valid_static = true;
        }

        // Copy cached static depth -> active shadow texture, then composite dynamic casters
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

        if dynamic_batch_cnt > 0 {
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
                rpass.multi_draw_indexed_indirect(&self.indirect_buf, dynamic_indirect_off, dynamic_batch_cnt);
                draw_calls += 1;
            } else {
                for b in &self.scratch_dynamic_shadow_batches {
                    rpass.draw_indexed(b.index_offset..(b.index_offset + b.index_count), b.base_vertex, b.inst_start..b.inst_end);
                    draw_calls += 1;
                }
            }
        }

        // ---------------------------------------------------------------------
        // Pass 2: Memoryless 4x MSAA MRT Scene FIRST + Early-Z Backdrop
        //         (Resolves 1x HDR color + 1x Rg8Unorm normals + 1x R16Float linZ;
        //          4x MSAA color/normal/linZ/depth all discarded in TBDR tile SRAM!)
        // ---------------------------------------------------------------------
        {
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

            // 2a: Skinned 3D cardstock diorama geometry (single Multi-Draw Indexed Indirect command!)
            rpass.set_pipeline(&self.scene_pso);
            rpass.set_bind_group(0, &self.frame_bg, &[]);
            rpass.set_bind_group(1, &st.scene_tex_bg, &[]);
            rpass.set_vertex_buffer(0, self.vertex_buf.slice(..));
            rpass.set_index_buffer(self.index_buf.slice(..), wgpu::IndexFormat::Uint16);
            if self.use_multi_draw_indirect && scene_batch_cnt > 0 {
                rpass.multi_draw_indexed_indirect(&self.indirect_buf, scene_indirect_off, scene_batch_cnt);
                draw_calls += 1;
            } else {
                for b in &self.scratch_scene_batches {
                    rpass.draw_indexed(b.index_offset..(b.index_offset + b.index_count), b.base_vertex, b.inst_start..b.inst_end);
                    draw_calls += 1;
                }
            }

            // 2b: Procedural walnut studio desk & horizon backdrop (z=1.0, Equal compare -> Early-Z skips ~80%!)
            rpass.set_pipeline(&self.backdrop_pso);
            rpass.set_bind_group(0, &self.frame_bg, &[]);
            rpass.draw(0..3, 0..1);
            draw_calls += 1;
        }

        // ---------------------------------------------------------------------
        // Pass 3: 1/4-Res Emissive-Masked Separable Gaussian Bloom (Rg11b10Ufloat)
        // ---------------------------------------------------------------------
        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("pass3a_bloom_extract"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &targets.bloom_a_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            rpass.set_pipeline(&self.bloom_extract_pso);
            rpass.set_bind_group(0, &self.frame_bg, &[]);
            rpass.set_bind_group(1, &targets.bloom_extract_bg, &[]);
            rpass.draw(0..3, 0..1);
            draw_calls += 1;
        }
        let bloom_iters = if quality == RenderQuality::Interactive { 1 } else { 2 };
        for _ in 0..bloom_iters {
            {
                let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("pass3b_bloom_h"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &targets.bloom_b_view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
                rpass.set_pipeline(&self.bloom_blur_h_pso);
                rpass.set_bind_group(0, &self.frame_bg, &[]);
                rpass.set_bind_group(1, &targets.bloom_h_bg, &[]);
                rpass.draw(0..3, 0..1);
                draw_calls += 1;
            }
            {
                let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("pass3c_bloom_v"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &targets.bloom_a_view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
                rpass.set_pipeline(&self.bloom_blur_v_pso);
                rpass.set_bind_group(0, &self.frame_bg, &[]);
                rpass.set_bind_group(1, &targets.bloom_v_bg, &[]);
                rpass.draw(0..3, 0..1);
                draw_calls += 1;
            }
        }

        // ---------------------------------------------------------------------
        // Pass 4: Half-Res Depth Contact AO + Hybrid Tilt-Shift CoC (Rg16Float)
        // ---------------------------------------------------------------------
        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("pass4_ao_coc"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &targets.ao_coc_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::WHITE),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            rpass.set_pipeline(&self.ao_pso);
            rpass.set_bind_group(0, &self.frame_bg, &[]);
            rpass.set_bind_group(1, &targets.ao_bg, &[]);
            rpass.draw(0..3, 0..1);
            draw_calls += 1;
        }

        // ---------------------------------------------------------------------
        // Pass 5: 36-Tap Golden-Angle Bokeh + Additive Bloom + ACES Filmic -> RGBA8
        // ---------------------------------------------------------------------
        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("pass5_composite"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &targets.final_rgba_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            rpass.set_pipeline(&self.composite_pso);
            rpass.set_bind_group(0, &self.frame_bg, &[]);
            rpass.set_bind_group(1, &targets.composite_bg, &[]);
            rpass.draw(0..3, 0..1);
            draw_calls += 1;
        }

        // Copy final RGBA8 render target into CPU-mappable readback buffer
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

        // Wait for GPU completion & read back tightly packed RGBA8 pixels
        let t_read = Instant::now();
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
        let _ = t_read;

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
}

use bytemuck::{Pod, Zeroable};

use crate::asset::Vertex;

pub(super) const SHADOW_SIZE_ULTRA: u32 = 2048;
pub(super) const SHADOW_SIZE_INTERACTIVE: u32 = 1024;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub(super) struct FrameUniforms {
    pub view_proj: [[f32; 4]; 4],
    pub light_view_proj: [[f32; 4]; 4],
    pub cam_pos_aspect: [f32; 4],
    pub cam_target_slab_half: [f32; 4],
    pub cam_right_gobo: [f32; 4],
    pub cam_up_day_factor: [f32; 4],
    pub cam_fwd_bloom_str: [f32; 4],
    pub proj_params: [f32; 4],
    pub key_dir_intensity: [f32; 4],
    pub key_color_wrap: [f32; 4],
    pub sky_color_hemi: [f32; 4],
    pub ground_color_exp: [f32; 4],
    pub shadow_leak_str: [f32; 4],
    pub table_bg_lamp_count: [f32; 4],
    pub fog_color_lamp_int: [f32; 4],
    pub lamp_color_time: [f32; 4],
    pub tilt_a: [f32; 4],
    pub tilt_b: [f32; 4],
    pub lamp_pools: [[f32; 4]; 32],
    pub light_grid_bounds: [f32; 4],
    pub light_grid: [[u32; 4]; 16],
    pub quality_pad: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub(super) struct DrawIndexedIndirectArgs {
    pub index_count: u32,
    pub instance_count: u32,
    pub first_index: u32,
    pub base_vertex: i32,
    pub first_instance: u32,
}

const _: () = assert!(std::mem::size_of::<DrawIndexedIndirectArgs>() == 20);

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub(super) struct InstanceData {
    pub model: [[f32; 4]; 4],
    pub params: [f32; 4],
}

#[derive(Clone, Copy)]
pub(super) enum FrameChannels {
    Rgba,
    Bgra,
}

#[derive(Clone, Copy)]
pub(super) struct MeshSpan {
    pub mesh_key: u32,
    pub vertex_offset: i32,
    pub index_offset: u32,
    pub index_count: u32,
    pub atlas_index: usize,
    pub obb_hy: f32,
    pub obb_radius: f32,
}

#[derive(Clone, Copy)]
pub(super) struct MeshBatch {
    pub base_vertex: i32,
    pub index_offset: u32,
    pub index_count: u32,
    pub inst_start: u32,
    pub inst_end: u32,
}

pub(super) fn vertex_layout() -> wgpu::VertexBufferLayout<'static> {
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

pub(super) fn make_frame_bg(
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

pub(super) fn fnv1a_u64(hash: &mut u64, val: u64) {
    *hash ^= val;
    *hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
}

pub(super) fn push_batch(batches: &mut Vec<MeshBatch>, span: MeshSpan, inst_idx: u32) {
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

use super::buffers::{make_frame_bg, vertex_layout};

const SHADER_SOURCE: &str = include_str!("shaders.wgsl");

pub(super) struct PipelineBundle {
    pub frame_bgl: wgpu::BindGroupLayout,
    pub scene_tex_bgl: wgpu::BindGroupLayout,
    pub post_tex1_bgl: wgpu::BindGroupLayout,
    pub ao_tex_bgl: wgpu::BindGroupLayout,
    pub composite_tex_bgl: wgpu::BindGroupLayout,

    pub frame_bg: wgpu::BindGroup,
    pub shadow_tex_bg: wgpu::BindGroup,

    pub shadow_pso_d32: wgpu::RenderPipeline,
    pub shadow_pso_d16: wgpu::RenderPipeline,
    pub backdrop_pso: wgpu::RenderPipeline,
    pub scene_pso: wgpu::RenderPipeline,
    pub bloom_extract_pso: wgpu::RenderPipeline,
    pub bloom_blur_h_pso: wgpu::RenderPipeline,
    pub bloom_blur_v_pso: wgpu::RenderPipeline,
    pub ao_pso: wgpu::RenderPipeline,
    pub composite_pso: wgpu::RenderPipeline,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn create_pipelines(
    device: &wgpu::Device,
    frame_buf: &wgpu::Buffer,
    bone_buf: &wgpu::Buffer,
    instance_buf: &wgpu::Buffer,
    atlas_views: &[wgpu::TextureView],
    linear_clamp_smp: &wgpu::Sampler,
    bloom_format: wgpu::TextureFormat,
    z_only_shadows: bool,
) -> PipelineBundle {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("papercraft_wgsl"),
        source: wgpu::ShaderSource::Wgsl(SHADER_SOURCE.into()),
    });

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

    let frame_bg = make_frame_bg(device, &frame_bgl, frame_buf, bone_buf, instance_buf);
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
                resource: wgpu::BindingResource::Sampler(linear_clamp_smp),
            },
        ],
    });

    let depth_rw_for = |format: wgpu::TextureFormat| {
        Some(wgpu::DepthStencilState {
            format,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::LessEqual),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        })
    };
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

    PipelineBundle {
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
    }
}

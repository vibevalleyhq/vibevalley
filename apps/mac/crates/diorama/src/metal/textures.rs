use crate::asset::{AssetBundle, CompressedTexture, TextureImage};

pub(super) struct UploadedTextures {
    pub atlas_views: Vec<wgpu::TextureView>,
    pub card_fibre_view: wgpu::TextureView,
    pub page_fibre_view: wgpu::TextureView,
    pub cut_edge_view: wgpu::TextureView,
    pub blue_noise_view: wgpu::TextureView,
    pub materials_view: wgpu::TextureView,
    pub linear_clamp_smp: wgpu::Sampler,
    pub linear_repeat_smp: wgpu::Sampler,
    pub shadow_cmp_smp: wgpu::Sampler,
    pub bc_textures_active: u32,
}

pub(super) fn upload_texture(
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

pub(super) fn create_render_target(
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

pub(super) fn create_msaa_transient_target(
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

pub(super) fn upload_rgba_mipmapped(
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

pub(super) fn upload_compressed_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
    ct: &CompressedTexture,
) -> Option<(wgpu::Texture, wgpu::TextureView)> {
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

pub(super) fn upload_bundle_textures(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    bundle: &AssetBundle,
    atlas_used: &[bool],
    has_bc: bool,
) -> Result<UploadedTextures, String> {
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
            && let Some((_t, v)) = upload_compressed_texture(device, queue, &format!("{label}_bc"), ct)
        {
            bc_textures_active += 1;
            return Ok(v);
        }
        if !rgba_tex.rgba.is_empty() {
            Ok(upload_rgba_mipmapped(device, queue, label, rgba_tex, fallback_fmt).1)
        } else {
            let lazy_tex = bundle.load_rgba_fallback(fallback_rel)?;
            Ok(upload_rgba_mipmapped(device, queue, label, &lazy_tex, fallback_fmt).1)
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
            upload_rgba_mipmapped(device, queue, &format!("atlas_{i}"), src, wgpu::TextureFormat::Rgba8UnormSrgb)
        } else {
            upload_texture(device, queue, &format!("atlas_{i}"), src, wgpu::TextureFormat::Rgba8UnormSrgb)
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

    let (_bn_tex, blue_noise_view) = upload_texture(device, queue, "blue_noise", &bundle.blue_noise, wgpu::TextureFormat::Rgba8Unorm);
    let neutral_mat_1x1 = TextureImage {
        width: 1,
        height: 1,
        rgba: vec![188, 188, 188, 255],
    };
    let materials_view = if has_bc {
        if let Some(ct) = bundle.materials_bc.as_ref() {
            if let Some((_t, v)) = upload_compressed_texture(device, queue, "materials_bc", ct) {
                bc_textures_active += 1;
                v
            } else {
                upload_texture(device, queue, "materials_fallback_1x1", &neutral_mat_1x1, wgpu::TextureFormat::Rgba8UnormSrgb).1
            }
        } else {
            upload_texture(device, queue, "materials_fallback_1x1", &neutral_mat_1x1, wgpu::TextureFormat::Rgba8UnormSrgb).1
        }
    } else {
        upload_texture(device, queue, "materials_fallback_1x1", &neutral_mat_1x1, wgpu::TextureFormat::Rgba8UnormSrgb).1
    };

    Ok(UploadedTextures {
        atlas_views,
        card_fibre_view,
        page_fibre_view,
        cut_edge_view,
        blue_noise_view,
        materials_view,
        linear_clamp_smp,
        linear_repeat_smp,
        shadow_cmp_smp,
        bc_textures_active,
    })
}

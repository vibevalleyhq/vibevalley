use crate::foley::FoleySpec;
use bytemuck::{Pod, Zeroable};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Compact 24-byte GPU vertex matching `VVM2` binary format.
///
/// - `pos` (`@0`, `Float32x3`): local-space position
/// - `uv_f16` (`@12`, `Float16x2`): IEEE binary16 UV coordinates
/// - `ao_tint` (`@16`, `Unorm8x4`): baked AO / tint RGBA8
/// - `oct_norm_meta` (`@20`, `Uint32`):
///   - bits `0..7`: `oct_x` (`i8`, octahedral-encoded normal X)
///   - bits `8..15`: `oct_y` (`i8`, octahedral-encoded normal Y)
///   - bits `16..23`: `mat_flag` (`u8`, material flag `0..7`)
///   - bits `24..31`: `bone_id` (`u8`, rigid-joint bone index `0..15`)
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct Vertex {
    pub pos: [f32; 3],
    pub uv_f16: [u16; 2],
    pub ao_tint: [u8; 4],
    pub oct_norm_meta: u32,
}

const _: () = assert!(std::mem::size_of::<Vertex>() == 24);

impl Vertex {
    #[inline]
    pub fn mat_flag(self) -> u8 {
        ((self.oct_norm_meta >> 16) & 0xFF) as u8
    }

    #[inline]
    pub fn bone_id(self) -> u8 {
        ((self.oct_norm_meta >> 24) & 0xFF) as u8
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: u32,
    pub source_sha256: String,
    pub ground_size: f32,
    pub ground_thickness: f32,
    pub card_thickness: f32,
    pub atlases: Vec<AtlasDesc>,
    pub meshes: BTreeMap<String, MeshSlice>,
    pub scene: SceneSpec,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtlasDesc {
    pub index: usize,
    pub file: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoneDesc {
    pub name: String,
    pub parent: i8,
    pub pivot: [f32; 3],
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshSlice {
    pub atlas_index: usize,
    pub vertex_offset: u32,
    pub vertex_count: u32,
    pub index_offset: u32,
    pub index_count: u32,
    pub obb_half: [f32; 3],
    pub uv_rect: [f32; 4],
    pub cross: bool,
    pub is_lamp: bool,
    #[serde(default)]
    pub bones: Vec<BoneDesc>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSpec {
    pub plots: Vec<PlotSpec>,
    pub buildings: Vec<BuildingSpec>,
    pub props: Vec<PropSpec>,
    pub helpers: Vec<HelperSpec>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotSpec {
    pub index: usize,
    pub station: i32,
    pub pos: [f32; 3],
    pub size: [f32; 2],
    pub unlock_level: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildingSpec {
    pub id: String,
    pub label: String,
    pub opens: String,
    pub asset: String,
    pub pos: [f32; 3],
    pub scale: f32,
    pub yaw_deg: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropSpec {
    pub asset: String,
    pub pos: [f32; 3],
    pub scale: f32,
    pub yaw_deg: f32,
    #[serde(default)]
    pub is_lamp: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperSpec {
    pub id: String,
    pub name: String,
    pub role: String,
    pub asset: String,
    pub home_plot: usize,
    pub default_spot: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LightsFile {
    pub presets: BTreeMap<String, LightPreset>,
    pub tilt_shift: TiltShiftSpec,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LightPreset {
    pub azimuth_deg: f32,
    pub elevation_deg: f32,
    pub key_color: [f32; 3],
    pub key_intensity: f32,
    pub sky_color: [f32; 3],
    pub ground_color: [f32; 3],
    pub hemi_intensity: f32,
    pub shadow_leak: [f32; 3],
    pub shadow_strength: f32,
    pub table_bg: [f32; 3],
    pub fog_color: [f32; 3],
    pub lamp_intensity: f32,
    pub lamp_color: [f32; 3],
    pub exposure: f32,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TiltShiftSpec {
    pub focus_screen_y: f32,
    pub half_band: f32,
    pub ramp: f32,
    pub max_blur_px: f32,
    pub depth_weight: f32,
    pub ao_radius: f32,
    pub ao_intensity: f32,
    pub vignette: f32,
}

pub struct TextureImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Hardware block-compressed (`VVTX` BC1/BC3) mipmap pyramid loaded from offline-baked `.vvtex` files.
///
/// Format codes:
/// - `1` = `Bc1RgbaUnormSrgb` (8B / 4x4 block)
/// - `2` = `Bc1RgbaUnorm` (8B / 4x4 block)
/// - `3` = `Bc3RgbaUnormSrgb` (16B / 4x4 block)
/// - `4` = `Bc3RgbaUnorm` (16B / 4x4 block)
#[derive(Clone, Debug)]
pub struct CompressedTexture {
    pub width: u32,
    pub height: u32,
    pub format: u8,
    pub mip_count: u8,
    pub data: Vec<u8>,
}

pub struct AssetBundle {
    pub manifest: Manifest,
    pub lights: LightsFile,
    pub foley: FoleySpec,
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u16>,
    pub atlases: Vec<TextureImage>,
    pub card_fibre: TextureImage,
    pub page_fibre: TextureImage,
    pub cut_edge: TextureImage,
    pub blue_noise: TextureImage,
    pub ground_bc: Option<CompressedTexture>,
    pub card_fibre_bc: Option<CompressedTexture>,
    pub page_fibre_bc: Option<CompressedTexture>,
    pub cut_edge_bc: Option<CompressedTexture>,
    pub materials_bc: Option<CompressedTexture>,
    pub dist_dir: Option<PathBuf>,
}

fn load_rgba(path: &Path) -> Result<TextureImage, String> {
    let img = image::open(path).map_err(|e| format!("open {}: {e}", path.display()))?.to_rgba8();
    Ok(TextureImage {
        width: img.width(),
        height: img.height(),
        rgba: img.into_raw(),
    })
}

fn parse_vvtex(bytes: &[u8]) -> Result<CompressedTexture, String> {
    if bytes.len() < 16 || &bytes[0..4] != b"VVTX" {
        return Err("invalid VVTX magic or truncated header".into());
    }
    let width = u16::from_le_bytes([bytes[4], bytes[5]]) as u32;
    let height = u16::from_le_bytes([bytes[6], bytes[7]]) as u32;
    let format = bytes[8];
    let mip_count = bytes[9];
    let data_bytes = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]) as usize;
    if bytes.len() < 16 + data_bytes {
        return Err("truncated VVTX body".into());
    }
    Ok(CompressedTexture {
        width,
        height,
        format,
        mip_count,
        data: bytes[16..16 + data_bytes].to_vec(),
    })
}

fn load_vvtex_optional(path: &Path) -> Result<Option<CompressedTexture>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    parse_vvtex(&bytes).map(Some)
}

impl AssetBundle {
    pub fn load(dist_dir: &Path) -> Result<Self, String> {
        let manifest_text = std::fs::read_to_string(dist_dir.join("manifest.json")).map_err(|e| format!("read manifest.json: {e}"))?;
        let manifest: Manifest = serde_json::from_str(&manifest_text).map_err(|e| format!("parse manifest: {e}"))?;

        let lights_text = std::fs::read_to_string(dist_dir.join("lights.json")).map_err(|e| format!("read lights.json: {e}"))?;
        let lights: LightsFile = serde_json::from_str(&lights_text).map_err(|e| format!("parse lights.json: {e}"))?;

        let foley_text = std::fs::read_to_string(dist_dir.join("foley.json")).map_err(|e| format!("read foley.json: {e}"))?;
        let foley: FoleySpec = serde_json::from_str(&foley_text).map_err(|e| format!("parse foley.json: {e}"))?;

        let bin = std::fs::read(dist_dir.join("meshes.bin")).map_err(|e| format!("read meshes.bin: {e}"))?;
        if bin.len() < 12 || &bin[0..4] != b"VVM2" {
            return Err("invalid meshes.bin magic (expected VVM2)".into());
        }
        let v_count = u32::from_le_bytes(bin[4..8].try_into().unwrap()) as usize;
        let i_count = u32::from_le_bytes(bin[8..12].try_into().unwrap()) as usize;
        let v_bytes = v_count * std::mem::size_of::<Vertex>();
        let i_bytes = i_count * std::mem::size_of::<u16>();
        if bin.len() < 12 + v_bytes + i_bytes {
            return Err("truncated VVM2 meshes.bin".into());
        }
        let vertices: Vec<Vertex> = bytemuck::cast_slice(&bin[12..12 + v_bytes]).to_vec();
        let indices: Vec<u16> = bytemuck::cast_slice(&bin[12 + v_bytes..12 + v_bytes + i_bytes]).to_vec();

        let ground_bc = load_vvtex_optional(&dist_dir.join("print/yard_ground.vvtex"))?;
        let card_fibre_bc = load_vvtex_optional(&dist_dir.join("stock/card_fibre.vvtex"))?;
        let page_fibre_bc = load_vvtex_optional(&dist_dir.join("stock/page_fibre.vvtex"))?;
        let cut_edge_bc = load_vvtex_optional(&dist_dir.join("stock/cut_edge.vvtex"))?;
        let materials_bc = load_vvtex_optional(&dist_dir.join("print/materials.vvtex"))?;

        // Skip redundant PNG decoding when offline-baked .vvtex BC pyramids exist on disk
        // (~6.25 MB startup RGBA decode eliminated; PNGs remain lazily loadable via `load_rgba_fallback`)
        let mut atlases = Vec::with_capacity(manifest.atlases.len());
        for a in &manifest.atlases {
            if a.file.ends_with("yard_ground.png")
                && let Some(bc) = &ground_bc
            {
                atlases.push(TextureImage {
                    width: bc.width,
                    height: bc.height,
                    rgba: Vec::new(),
                });
            } else {
                atlases.push(load_rgba(&dist_dir.join(&a.file))?);
            }
        }
        let card_fibre = if let Some(bc) = &card_fibre_bc {
            TextureImage {
                width: bc.width,
                height: bc.height,
                rgba: Vec::new(),
            }
        } else {
            load_rgba(&dist_dir.join("stock/card_fibre.png"))?
        };
        let page_fibre = if let Some(bc) = &page_fibre_bc {
            TextureImage {
                width: bc.width,
                height: bc.height,
                rgba: Vec::new(),
            }
        } else {
            load_rgba(&dist_dir.join("stock/page_fibre.png"))?
        };
        let cut_edge = if let Some(bc) = &cut_edge_bc {
            TextureImage {
                width: bc.width,
                height: bc.height,
                rgba: Vec::new(),
            }
        } else {
            load_rgba(&dist_dir.join("stock/cut_edge.png"))?
        };
        let blue_noise = load_rgba(&dist_dir.join("stock/blue_noise.png"))?;

        Ok(Self {
            manifest,
            lights,
            foley,
            vertices,
            indices,
            atlases,
            card_fibre,
            page_fibre,
            cut_edge,
            blue_noise,
            ground_bc,
            card_fibre_bc,
            page_fibre_bc,
            cut_edge_bc,
            materials_bc,
            dist_dir: Some(dist_dir.to_path_buf()),
        })
    }

    /// Lazily decodes a fallback PNG relative to `dist_dir` (e.g. `"print/yard_ground.png"` or
    /// `"stock/card_fibre.png"`) only when a GPU adapter lacks `TEXTURE_COMPRESSION_BC`.
    pub fn load_rgba_fallback(&self, rel_path: &str) -> Result<TextureImage, String> {
        let dir = self
            .dist_dir
            .as_ref()
            .ok_or_else(|| "asset bundle has no dist_dir for lazy RGBA fallback".to_string())?;
        load_rgba(&dir.join(rel_path))
    }

    /// Returns a lightweight metadata-only clone (`manifest`, `lights`, `foley`, texture sizes)
    /// with empty `vertices`, `indices`, RGBA pixel buffers, and compressed BC textures so CPU RAM
    /// can be reclaimed immediately once GPU buffers & textures have been uploaded.
    pub fn metadata_only(&self) -> Self {
        let strip_tex = |t: &TextureImage| TextureImage {
            width: t.width,
            height: t.height,
            rgba: Vec::new(),
        };
        Self {
            manifest: self.manifest.clone(),
            lights: self.lights.clone(),
            foley: self.foley.clone(),
            vertices: Vec::new(),
            indices: Vec::new(),
            atlases: self.atlases.iter().map(strip_tex).collect(),
            card_fibre: strip_tex(&self.card_fibre),
            page_fibre: strip_tex(&self.page_fibre),
            cut_edge: strip_tex(&self.cut_edge),
            blue_noise: strip_tex(&self.blue_noise),
            ground_bc: None,
            card_fibre_bc: None,
            page_fibre_bc: None,
            cut_edge_bc: None,
            materials_bc: None,
            dist_dir: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_only_strips_heavy_buffers_and_preserves_manifest() {
        assert_eq!(std::mem::size_of::<Vertex>(), 24);
        let mut raw_vvtex = Vec::new();
        raw_vvtex.extend_from_slice(b"VVTX");
        raw_vvtex.extend_from_slice(&4u16.to_le_bytes());
        raw_vvtex.extend_from_slice(&4u16.to_le_bytes());
        raw_vvtex.push(1u8); // Bc1RgbaUnormSrgb
        raw_vvtex.push(1u8); // 1 mip
        raw_vvtex.extend_from_slice(&0u16.to_le_bytes());
        raw_vvtex.extend_from_slice(&8u32.to_le_bytes());
        raw_vvtex.extend_from_slice(&[0xAAu8; 8]);
        let parsed_bc = parse_vvtex(&raw_vvtex).expect("parse valid VVTX");
        assert_eq!(parsed_bc.width, 4);
        assert_eq!(parsed_bc.height, 4);
        assert_eq!(parsed_bc.format, 1);
        assert_eq!(parsed_bc.mip_count, 1);
        assert_eq!(parsed_bc.data.len(), 8);

        let empty_scene = SceneSpec {
            plots: vec![],
            buildings: vec![],
            props: vec![],
            helpers: vec![],
        };
        let v = Vertex {
            pos: [0.0; 3],
            uv_f16: [0, 0],
            ao_tint: [255; 4],
            oct_norm_meta: (3u32 << 16) | (2u32 << 24),
        };
        assert_eq!(v.mat_flag(), 3);
        assert_eq!(v.bone_id(), 2);

        let bundle = AssetBundle {
            manifest: Manifest {
                version: 1,
                source_sha256: "abc".into(),
                ground_size: 16.0,
                ground_thickness: 0.4,
                card_thickness: 0.02,
                atlases: vec![AtlasDesc {
                    index: 0,
                    file: "atlas_0.png".into(),
                    width: 1024,
                    height: 1024,
                }],
                meshes: BTreeMap::new(),
                scene: empty_scene,
            },
            lights: LightsFile {
                presets: BTreeMap::new(),
                tilt_shift: TiltShiftSpec {
                    focus_screen_y: 0.5,
                    half_band: 0.14,
                    ramp: 0.28,
                    max_blur_px: 10.0,
                    depth_weight: 0.5,
                    ao_radius: 0.25,
                    ao_intensity: 0.35,
                    vignette: 0.2,
                },
            },
            foley: FoleySpec::default(),
            vertices: vec![v],
            indices: vec![0, 0, 0],
            atlases: vec![TextureImage {
                width: 1024,
                height: 1024,
                rgba: vec![255u8; 64],
            }],
            card_fibre: TextureImage {
                width: 256,
                height: 256,
                rgba: vec![1u8; 32],
            },
            page_fibre: TextureImage {
                width: 256,
                height: 256,
                rgba: vec![2u8; 32],
            },
            cut_edge: TextureImage {
                width: 64,
                height: 64,
                rgba: vec![3u8; 16],
            },
            blue_noise: TextureImage {
                width: 128,
                height: 128,
                rgba: vec![4u8; 16],
            },
            ground_bc: Some(parsed_bc.clone()),
            card_fibre_bc: Some(parsed_bc.clone()),
            page_fibre_bc: Some(parsed_bc.clone()),
            cut_edge_bc: Some(parsed_bc.clone()),
            materials_bc: Some(parsed_bc),
            dist_dir: Some(PathBuf::from("dist/diorama")),
        };

        let meta = bundle.metadata_only();
        assert_eq!(meta.manifest.source_sha256, "abc");
        assert!(meta.vertices.is_empty());
        assert!(meta.indices.is_empty());
        assert_eq!(meta.atlases.len(), 1);
        assert_eq!(meta.atlases[0].width, 1024);
        assert!(meta.atlases[0].rgba.is_empty());
        assert!(meta.card_fibre.rgba.is_empty());
        assert!(meta.page_fibre.rgba.is_empty());
        assert!(meta.cut_edge.rgba.is_empty());
        assert!(meta.blue_noise.rgba.is_empty());
        assert!(meta.ground_bc.is_none());
        assert!(meta.card_fibre_bc.is_none());
        assert!(meta.page_fibre_bc.is_none());
        assert!(meta.cut_edge_bc.is_none());
        assert!(meta.materials_bc.is_none());
        assert!(meta.dist_dir.is_none());
        assert!(meta.load_rgba_fallback("stock/card_fibre.png").is_err());
    }
}

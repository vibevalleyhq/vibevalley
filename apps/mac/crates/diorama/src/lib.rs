pub mod asset;
pub mod camera;
pub mod domain;
pub mod foley;
pub mod math;
pub mod metal;
pub mod nav;
pub mod pick;
pub mod rig;
pub mod spring;
pub mod world;

pub use asset::{AssetBundle, BoneDesc, CompressedTexture};
pub use camera::CameraPreset;
pub use domain::{HelperTaskSync, PlayerIntent, PlotActionOutcome, PlotTicketSync, ScreenAnchor, YardSnapshotSync};
pub use foley::{SoundKind, synthesize_wav};
pub use metal::{DofMode, FrameOutput, FrameStats, MetalRenderer, RenderQuality, RenderSceneInput, WgpuRenderer, prepare_scene_input};
pub use nav::{LandZone, NavGraph, PlacementStatus, is_in_canal, surface_height_at, validate_placement};
pub use rig::{BonePalette, MAX_BONES, MachineRig, PuppetAnimState, PuppetRig, SkeletonPose};
pub use world::{DioramaHit, DioramaWorld, PlotStage, TimeOfDay};

/// Converts packed 8-bit `RGBA` pixels into `BGRA` in-place on `dst` (compiled at opt-level >= 2).
pub fn rgba_to_bgra(src: &[u8], dst: &mut Vec<u8>) {
    let byte_len = src.len() & !3;
    dst.resize(byte_len, 0);
    for (s, d) in src[..byte_len].as_chunks::<4>().0.iter().zip(dst.as_chunks_mut::<4>().0.iter_mut()) {
        d[0] = s[2];
        d[1] = s[1];
        d[2] = s[0];
        d[3] = s[3];
    }
}

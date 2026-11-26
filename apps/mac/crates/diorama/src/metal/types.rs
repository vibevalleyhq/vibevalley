use crate::asset::{AssetBundle, LightPreset, TiltShiftSpec};
use crate::camera::CameraMatrices;
use crate::world::{DioramaWorld, RenderInstance};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenderQuality {
    Ultra,
    Interactive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum DofMode {
    Crisp,
    #[default]
    Miniature,
    Off,
}

#[derive(Clone, Debug)]
pub struct RenderSceneInput {
    pub cam: CameraMatrices,
    pub light: LightPreset,
    pub tilt_shift: TiltShiftSpec,
    pub dof_mode: DofMode,
    pub slab_half: f32,
    pub elapsed: f32,
    pub lamp_pools: [[f32; 4]; 32],
    pub lamp_count: usize,
    pub light_grid_bounds: [f32; 4],
    pub light_grid: [[u32; 4]; 16],
    pub instances: Vec<RenderInstance>,
    pub bone_mats: Vec<[[f32; 4]; 4]>,
}

/// Captures a self-contained, thread-safe snapshot of the current scene state for off-thread rendering.
pub fn prepare_scene_input(world: &DioramaWorld, bundle: &AssetBundle, aspect: f32) -> RenderSceneInput {
    let cam = world.camera.view_params(aspect);
    let light = world.blended_light(bundle);
    let slab_half = (bundle.manifest.ground_size * 0.5).max(6.0);

    let mut lamp_pools = [[0.0f32; 4]; 32];
    let mut lamp_count = 0usize;
    if let Some(lp) = world.rabbit_lantern_pos() {
        lamp_pools[lamp_count] = [lp.x, lp.y, lp.z, 2.45];
        lamp_count += 1;
    }
    for prop in &world.props {
        if prop.is_lamp && lamp_count < 32 {
            lamp_pools[lamp_count] = [prop.pos.x, prop.pos.y + 0.62, prop.pos.z, 3.25];
            lamp_count += 1;
        }
    }
    for prop in &world.props {
        if prop.asset.contains("bridge") && lamp_count < 32 {
            let (sy, cy) = prop.yaw_rad.sin_cos();
            for sgn in [-0.56f32, 0.0f32, 0.56f32] {
                if lamp_count < 32 {
                    lamp_pools[lamp_count] = [prop.pos.x + cy * sgn * prop.scale, prop.pos.y + 0.64, prop.pos.z - sy * sgn * prop.scale, 2.45];
                    lamp_count += 1;
                }
            }
        }
    }
    for prop in &world.props {
        if prop.asset == "p_boat" && lamp_count < 32 {
            let (sy, cy) = prop.yaw_rad.sin_cos();
            lamp_pools[lamp_count] = [
                prop.pos.x + cy * 0.62 * prop.scale,
                prop.pos.y + 0.36,
                prop.pos.z - sy * 0.62 * prop.scale,
                2.05,
            ];
            lamp_count += 1;
        }
    }
    for bldg in &world.buildings {
        if lamp_count < 32 {
            lamp_pools[lamp_count] = [bldg.pos.x, bldg.pos.y + 0.85, bldg.pos.z + 0.35, -3.15];
            lamp_count += 1;
        }
    }

    // Bin active lamps into a world-space 8x8 bitmask tiled light grid (covering diorama + desk spill)
    let grid_half = (slab_half + 4.0).max(12.0);
    let min_x = -grid_half;
    let min_z = -grid_half;
    let inv_span = 1.0 / (2.0 * grid_half);
    let light_grid_bounds = [min_x, min_z, inv_span, inv_span];
    let mut light_grid = [[0u32; 4]; 16];
    for (i, lp) in lamp_pools.iter().enumerate().take(lamp_count) {
        let r_bin = (lp[3].abs() * 2.35).max(3.6);
        let gx0 = (((lp[0] - r_bin - min_x) * inv_span * 8.0).floor() as i32).clamp(0, 7);
        let gx1 = (((lp[0] + r_bin - min_x) * inv_span * 8.0).floor() as i32).clamp(0, 7);
        let gz0 = (((lp[2] - r_bin - min_z) * inv_span * 8.0).floor() as i32).clamp(0, 7);
        let gz1 = (((lp[2] + r_bin - min_z) * inv_span * 8.0).floor() as i32).clamp(0, 7);
        let bit = 1u32 << i;
        for gz in gz0..=gz1 {
            for gx in gx0..=gx1 {
                let cell = (gz * 8 + gx) as usize;
                light_grid[cell >> 2][cell & 3] |= bit;
            }
        }
    }

    let (instances, bone_mats) = world.collect_render_batch(bundle);

    RenderSceneInput {
        cam,
        light,
        tilt_shift: bundle.lights.tilt_shift,
        dof_mode: DofMode::Miniature,
        slab_half,
        elapsed: world.elapsed,
        lamp_pools,
        lamp_count,
        light_grid_bounds,
        light_grid,
        instances,
        bone_mats,
    }
}

#[derive(Clone, Copy, Debug)]
pub struct FrameStats {
    pub width: u32,
    pub height: u32,
    pub gpu_ms: f32,
    pub readback_ms: f32,
    pub draw_calls: u32,
    pub static_shadow_cached: bool,
}

pub struct FrameOutput {
    pub width: u32,
    pub height: u32,
    /// Straight RGBA8 pixels top-to-bottom (`width * height * 4` bytes).
    pub rgba: Arc<[u8]>,
    pub gpu_ms: f32,
    pub readback_ms: f32,
    pub draw_calls: u32,
    pub static_shadow_cached: bool,
}

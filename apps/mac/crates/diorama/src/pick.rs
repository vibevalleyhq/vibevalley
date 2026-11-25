use crate::asset::AssetBundle;
use crate::math::{Vec3, ray_box_hit};
use crate::world::{DioramaHit, DioramaWorld, prop_display_label};

/// Grid snap increment (world meters) for diorama map editor placement.
pub const EDITOR_GRID_STEP: f32 = 0.5;

/// Snap a single world coordinate to the editor grid.
#[inline]
pub fn snap_coord(v: f32) -> f32 {
    (v / EDITOR_GRID_STEP).round() * EDITOR_GRID_STEP
}

/// Raycasts from normalized device coordinates (`ndc_x`, `ndc_y` in `[-1.0, 1.0]`,
/// bottom-left origin) onto the `y = 0` diorama ground board and returns a snapped `(x, z)`
/// grid position when the ray hits within the board perimeter.
pub fn raycast_ground(world: &DioramaWorld, ndc_x: f32, ndc_y: f32, aspect: f32) -> Option<(f32, f32)> {
    let nx = (ndc_x + 1.0) * 0.5;
    let ny = (1.0 - ndc_y) * 0.5;
    raycast_ground_uv(world, nx, ny, aspect)
}

/// Same as [`raycast_ground`], accepting normalized viewport coordinates `nx`, `ny` in `[0.0, 1.0]`
/// (top-left origin).
pub fn raycast_ground_uv(world: &DioramaWorld, nx: f32, ny: f32, aspect: f32) -> Option<(f32, f32)> {
    let ray = world.camera.pick_ray(nx, ny, aspect.max(0.01));
    if ray.dir.y.abs() < 1e-5 {
        return None;
    }
    let t = -ray.origin.y / ray.dir.y;
    if t <= 0.0 || !t.is_finite() {
        return None;
    }
    let hit_x = ray.origin.x + ray.dir.x * t;
    let hit_z = ray.origin.z + ray.dir.z * t;
    let half_board = (world.ground_size * 0.5).max(1.0);
    if hit_x.abs() > half_board + 0.25 || hit_z.abs() > half_board + 0.25 {
        return None;
    }
    let margin = (half_board - 0.5).max(1.0);
    let sx = snap_coord(hit_x).clamp(-margin, margin);
    let sz = snap_coord(hit_z).clamp(-margin, margin);
    Some((sx, sz))
}

/// Exact 3D ray-OBB picking across standees, plots, buildings, props, and ground board.
/// `nx`, `ny` are normalized screen coordinates in [0.0, 1.0] (top-left origin).
pub fn pick(world: &DioramaWorld, bundle: &AssetBundle, nx: f32, ny: f32, aspect: f32) -> DioramaHit {
    let ray = world.camera.pick_ray(nx, ny, aspect);
    let mut best_t = f32::MAX;
    let mut best = DioramaHit::Ground;

    // 1. Agent paper standees
    for h in &world.helpers {
        let half = bundle.manifest.meshes.get(&h.asset).map(|m| m.obb_half).unwrap_or([0.45, 0.5, 0.15]);
        let s = h.scale;
        let center = Vec3::new(h.pos.x, h.pos.y + half[1] * s, h.pos.z);
        let ext = Vec3::new((half[0] * s).max(0.32), half[1] * s, (half[2] * s).max(0.28));
        if let Some(t) = ray_box_hit(ray, center, ext, h.yaw_rad)
            && t < best_t
        {
            best_t = t;
            best = DioramaHit::Helper {
                id: h.id.clone(),
                name: h.name.clone(),
                role: h.role.clone(),
                anim_state: h.rig.state,
            };
        }
    }

    // 2. Plots (soil bed + standing crop volume)
    for p in &world.plots {
        let ext = Vec3::new(p.size[0] * 0.52, 0.55, p.size[1] * 0.52);
        let center = Vec3::new(p.pos.x, ext.y, p.pos.z);
        if let Some(t) = ray_box_hit(ray, center, ext, 0.0)
            && t < best_t
        {
            best_t = t;
            best = DioramaHit::Plot {
                index: p.index,
                stage: p.stage,
                title: p.title.clone(),
            };
        }
    }

    // 3. Courtyard buildings
    for b in &world.buildings {
        let half = bundle.manifest.meshes.get(&b.asset).map(|m| m.obb_half).unwrap_or([0.55, 0.5, 0.18]);
        let center = Vec3::new(b.pos.x, half[1] * b.scale, b.pos.z);
        let ext = Vec3::new((half[0] * b.scale).max(0.35), (half[1] * b.scale).max(0.35), (half[2] * b.scale).max(0.38));
        if let Some(t) = ray_box_hit(ray, center, ext, b.yaw_rad)
            && t < best_t
        {
            best_t = t;
            best = DioramaHit::Building {
                id: b.id.clone(),
                label: b.label.clone(),
                opens: b.opens.clone(),
            };
        }
    }

    // 4. Props (trees, bushes, lanterns, and dynamic editor props)
    for pr in &world.props {
        let half = bundle.manifest.meshes.get(&pr.asset).map(|m| m.obb_half).unwrap_or([0.35, 0.5, 0.16]);
        let center = Vec3::new(pr.pos.x, pr.pos.y + half[1] * pr.scale, pr.pos.z);
        let ext = Vec3::new((half[0] * pr.scale).max(0.28), (half[1] * pr.scale).max(0.30), (half[2] * pr.scale).max(0.28));
        if let Some(t) = ray_box_hit(ray, center, ext, pr.yaw_rad)
            && t < best_t
        {
            best_t = t;
            best = DioramaHit::Prop {
                id: pr.id.clone(),
                asset: pr.asset.clone(),
                label: prop_display_label(&pr.asset).into(),
                is_lamp: pr.is_lamp,
            };
        }
    }

    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asset::SceneSpec;

    #[test]
    fn raycast_ground_center_hits_snapped_origin() {
        let world = DioramaWorld::from_scene(
            SceneSpec {
                plots: vec![],
                buildings: vec![],
                props: vec![],
                helpers: vec![],
            },
            16.0,
        );
        let hit = raycast_ground(&world, 0.0, 0.0, 16.0 / 10.0);
        let (x, z) = hit.expect("center ray should hit ground plane");
        assert!((x - snap_coord(x)).abs() < 1e-5);
        assert!((z - snap_coord(z)).abs() < 1e-5);
        assert!(x.abs() <= 1.0 && z.abs() <= 1.5, "got ({x}, {z})");
    }

    #[test]
    fn raycast_ground_sky_or_far_miss_returns_none() {
        let world = DioramaWorld::from_scene(
            SceneSpec {
                plots: vec![],
                buildings: vec![],
                props: vec![],
                helpers: vec![],
            },
            16.0,
        );
        // Far off top corner at extreme angle should miss board perimeter
        let hit = raycast_ground(&world, 3.0, 3.0, 1.5);
        assert!(hit.is_none());
    }
}

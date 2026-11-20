use std::sync::LazyLock;

use serde::Deserialize;

use super::level::{Point, pt};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CameraSpec {
    yaw_degrees: f32,
    pitch_degrees: f32,
    layout_pitch_degrees: f32,
    pixels_per_unit: f32,
    zoom: f32,
    island_zoom: f32,
    island_layout_pitch_degrees: f32,
    screen_origin: [f32; 2],
    layout_origin: [f32; 2],
}

struct Camera {
    spec: CameraSpec,
    yaw_sin: f32,
    yaw_cos: f32,
    pitch_sin: f32,
    pitch_cos: f32,
}

static CAMERA: LazyLock<Camera> = LazyLock::new(|| {
    let spec: CameraSpec = serde_json::from_str(include_str!("../../../../assets/village-camera.json")).expect("village camera");
    let (yaw_sin, yaw_cos) = spec.yaw_degrees.to_radians().sin_cos();
    let (pitch_sin, pitch_cos) = spec.pitch_degrees.to_radians().sin_cos();
    Camera {
        spec,
        yaw_sin,
        yaw_cos,
        pitch_sin,
        pitch_cos,
    }
});

pub fn yaw() -> f32 {
    CAMERA.spec.yaw_degrees.to_radians()
}

pub fn pitch() -> f32 {
    CAMERA.spec.pitch_degrees.to_radians()
}

pub fn zoom() -> f32 {
    CAMERA.spec.zoom
}

pub fn island_zoom() -> f32 {
    CAMERA.spec.island_zoom
}

pub fn island_offset(delta: Point) -> Point {
    project_offset(delta, CAMERA.spec.island_layout_pitch_degrees, island_zoom())
}

// Authored layout Y is already foreshortened by the original front camera.
pub fn project_offset(delta: Point, layout_pitch_degrees: f32, zoom: f32) -> Point {
    let depth = delta.y / layout_pitch_degrees.to_radians().sin();
    pt(
        zoom * (CAMERA.yaw_cos * delta.x - CAMERA.yaw_sin * depth),
        zoom * CAMERA.pitch_sin * (CAMERA.yaw_sin * delta.x + CAMERA.yaw_cos * depth),
    )
}

pub fn unproject_offset(delta: Point, layout_pitch_degrees: f32, zoom: f32) -> Point {
    let horizontal = delta.x / zoom;
    let depth = delta.y / (zoom * CAMERA.pitch_sin);
    pt(
        CAMERA.yaw_cos * horizontal + CAMERA.yaw_sin * depth,
        (-CAMERA.yaw_sin * horizontal + CAMERA.yaw_cos * depth) * layout_pitch_degrees.to_radians().sin(),
    )
}

pub fn ground(layout: Point) -> Point {
    let spec = &CAMERA.spec;
    let delta = pt(layout.x - spec.layout_origin[0], layout.y - spec.layout_origin[1]);
    let offset = project_offset(delta, spec.layout_pitch_degrees, spec.zoom);
    pt(spec.screen_origin[0] + offset.x, spec.screen_origin[1] + offset.y)
}

pub fn raised(layout: Point, height: f32) -> Point {
    let p = ground(layout);
    pt(p.x, p.y - height * CAMERA.spec.pixels_per_unit * CAMERA.spec.zoom * CAMERA.pitch_cos)
}

pub fn unproject(screen: Point) -> Point {
    let spec = &CAMERA.spec;
    let delta = pt(screen.x - spec.screen_origin[0], screen.y - spec.screen_origin[1]);
    let offset = unproject_offset(delta, spec.layout_pitch_degrees, spec.zoom);
    pt(spec.layout_origin[0] + offset.x, spec.layout_origin[1] + offset.y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_oblique_view_preserves_the_layout_hit_and_vertical_height() {
        for p in [pt(0., 0.), pt(384., 256.), pt(290., 90.), pt(150., 172.)] {
            let screen = ground(p);
            let hit = unproject(screen);
            assert!((hit.x - p.x).abs() < 0.001 && (hit.y - p.y).abs() < 0.001);
            let roof = raised(p, 2.);
            assert_eq!(roof.x, screen.x);
            assert!(roof.y < screen.y - 15.);
        }
        let corner = ground(pt(120., 120.));
        let east = ground(pt(145., 120.));
        let south = ground(pt(120., 145.));
        assert!(east.x > corner.x && east.y > corner.y);
        assert!(south.x < corner.x && south.y > corner.y);
    }
}

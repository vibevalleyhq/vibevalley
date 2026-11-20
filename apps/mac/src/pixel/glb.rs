//! Lightweight glTF 2.0 (`.glb`) loader and CPU rasterizer for 3D voxel helpers,
//! props, machines, pets, and managers. Supports named multi-clip animations,
//! visibility-switched expressions/tools (via zero scale), emissive materials,
//! 3-point warm lighting, and subtle silhouette outlining for crisp small sprites.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use image::{Rgba, RgbaImage};

#[derive(Clone, Copy, Debug, Default)]
struct Vec3(f32, f32, f32);

impl Vec3 {
    fn sub(self, o: Self) -> Self {
        Self(self.0 - o.0, self.1 - o.1, self.2 - o.2)
    }
    fn scale(self, s: f32) -> Self {
        Self(self.0 * s, self.1 * s, self.2 * s)
    }
    fn dot(self, o: Self) -> f32 {
        self.0 * o.0 + self.1 * o.1 + self.2 * o.2
    }
    fn cross(self, o: Self) -> Self {
        Self(self.1 * o.2 - self.2 * o.1, self.2 * o.0 - self.0 * o.2, self.0 * o.1 - self.1 * o.0)
    }
    fn norm(self) -> Self {
        let len = self.dot(self).sqrt();
        if len > 1e-6 { self.scale(1.0 / len) } else { Self(0.0, 1.0, 0.0) }
    }
    fn lerp(self, o: Self, t: f32) -> Self {
        Self(self.0 + (o.0 - self.0) * t, self.1 + (o.1 - self.1) * t, self.2 + (o.2 - self.2) * t)
    }
    fn max_abs(self) -> f32 {
        self.0.abs().max(self.1.abs()).max(self.2.abs())
    }
}

#[derive(Clone, Copy, Debug)]
struct Quat(f32, f32, f32, f32);

impl Quat {
    fn slerp(self, mut b: Self, t: f32) -> Self {
        let mut dot = self.0 * b.0 + self.1 * b.1 + self.2 * b.2 + self.3 * b.3;
        if dot < 0.0 {
            b = Self(-b.0, -b.1, -b.2, -b.3);
            dot = -dot;
        }
        if dot > 0.9995 {
            let x = self.0 + (b.0 - self.0) * t;
            let y = self.1 + (b.1 - self.1) * t;
            let z = self.2 + (b.2 - self.2) * t;
            let w = self.3 + (b.3 - self.3) * t;
            let inv = (x * x + y * y + z * z + w * w).sqrt().recip();
            return Self(x * inv, y * inv, z * inv, w * inv);
        }
        let theta = dot.clamp(-1.0, 1.0).acos();
        let sin_t = theta.sin();
        let w0 = ((1.0 - t) * theta).sin() / sin_t;
        let w1 = (t * theta).sin() / sin_t;
        Self(self.0 * w0 + b.0 * w1, self.1 * w0 + b.1 * w1, self.2 * w0 + b.2 * w1, self.3 * w0 + b.3 * w1)
    }
}

/// Column-major 4x4 matrix.
#[derive(Clone, Copy, Debug)]
struct Mat4([f32; 16]);

impl Mat4 {
    const IDENTITY: Self = Self([
        1.0, 0.0, 0.0, 0.0, //
        0.0, 1.0, 0.0, 0.0, //
        0.0, 0.0, 1.0, 0.0, //
        0.0, 0.0, 0.0, 1.0,
    ]);

    fn from_trs(t: Vec3, q: Quat, s: Vec3) -> Self {
        let (x, y, z, w) = (q.0, q.1, q.2, q.3);
        let (xx, yy, zz) = (x * x, y * y, z * z);
        let (xy, xz, yz) = (x * y, x * z, y * z);
        let (wx, wy, wz) = (w * x, w * y, w * z);
        Self([
            (1.0 - 2.0 * (yy + zz)) * s.0,
            (2.0 * (xy + wz)) * s.0,
            (2.0 * (xz - wy)) * s.0,
            0.0,
            (2.0 * (xy - wz)) * s.1,
            (1.0 - 2.0 * (xx + zz)) * s.1,
            (2.0 * (yz + wx)) * s.1,
            0.0,
            (2.0 * (xz + wy)) * s.2,
            (2.0 * (yz - wx)) * s.2,
            (1.0 - 2.0 * (xx + yy)) * s.2,
            0.0,
            t.0,
            t.1,
            t.2,
            1.0,
        ])
    }

    fn mul(self, rhs: Self) -> Self {
        let a = self.0;
        let b = rhs.0;
        let mut out = [0.0; 16];
        for col in 0..4 {
            for row in 0..4 {
                out[col * 4 + row] = a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
            }
        }
        Self(out)
    }

    fn transform_point(self, p: Vec3) -> Vec3 {
        let m = self.0;
        Vec3(
            m[0] * p.0 + m[4] * p.1 + m[8] * p.2 + m[12],
            m[1] * p.0 + m[5] * p.1 + m[9] * p.2 + m[13],
            m[2] * p.0 + m[6] * p.1 + m[10] * p.2 + m[14],
        )
    }

    fn transform_dir(self, d: Vec3) -> Vec3 {
        let m = self.0;
        Vec3(
            m[0] * d.0 + m[4] * d.1 + m[8] * d.2,
            m[1] * d.0 + m[5] * d.1 + m[9] * d.2,
            m[2] * d.0 + m[6] * d.1 + m[10] * d.2,
        )
    }
}

struct Primitive {
    positions: Vec<Vec3>,
    normals: Vec<Vec3>,
    indices: Vec<u32>,
    color: [f32; 3],
    emissive: [f32; 3],
}

struct Node {
    parent: Option<usize>,
    translation: Vec3,
    rotation: Quat,
    scale: Vec3,
    mesh: Option<usize>,
}

enum TrackValues {
    Translation(Vec<Vec3>),
    Rotation(Vec<Quat>),
    Scale(Vec<Vec3>),
}

struct Channel {
    node: usize,
    times: Vec<f32>,
    step: bool,
    values: TrackValues,
}

struct Animation {
    start: f32,
    channels: Vec<Channel>,
    duration: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct Camera {
    /// Horizontal orbit angle in radians (`0` faces the front of the character).
    pub yaw: f32,
    /// Elevation angle in radians above the ground plane.
    pub pitch: f32,
    /// Vertical span of the orthographic viewport in world units.
    pub ortho_scale: f32,
    /// World-space target point (`[x, y, z]`, Y-up).
    pub target: [f32; 3],
}

impl Camera {
    fn axes(self) -> (Vec3, Vec3, Vec3) {
        let view = Vec3(self.yaw.sin() * self.pitch.cos(), self.pitch.sin(), self.yaw.cos() * self.pitch.cos());
        let right = Vec3(self.yaw.cos(), 0.0, -self.yaw.sin());
        (right, view.cross(right), view)
    }
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            yaw: -0.62,
            pitch: 0.40,
            ortho_scale: 2.95,
            target: [0.0, 1.12, 0.0],
        }
    }
}

pub struct GlbModel {
    nodes: Vec<Node>,
    meshes: Vec<Vec<Primitive>>,
    animations: HashMap<String, Animation>,
    default_anim: Option<String>,
}

impl GlbModel {
    pub fn load(path: &Path) -> Result<Self, String> {
        let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        Self::from_bytes(&bytes)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        let glb = gltf::Glb::from_slice(bytes).map_err(|e| format!("invalid glb: {e}"))?;
        let root = gltf::json::Root::from_slice(&glb.json).map_err(|e| format!("invalid gltf json: {e}"))?;
        let doc = gltf::Document::from_json(root).map_err(|e| format!("invalid gltf doc: {e}"))?;
        let bin = glb.bin.as_deref().unwrap_or(&[]);

        let mut meshes = Vec::with_capacity(doc.meshes().len());
        for mesh in doc.meshes() {
            let mut prims = Vec::new();
            for prim in mesh.primitives() {
                let reader = prim.reader(|_| Some(bin));
                let Some(positions) = reader.read_positions() else {
                    continue;
                };
                let positions: Vec<Vec3> = positions.map(|p| Vec3(p[0], p[1], p[2])).collect();
                let normals: Vec<Vec3> = reader
                    .read_normals()
                    .map(|iter| iter.map(|n| Vec3(n[0], n[1], n[2]).norm()).collect())
                    .unwrap_or_else(|| vec![Vec3(0.0, 1.0, 0.0); positions.len()]);
                let indices: Vec<u32> = reader
                    .read_indices()
                    .map(|idx| idx.into_u32().collect())
                    .unwrap_or_else(|| (0..positions.len() as u32).collect());
                let mat = prim.material();
                let base = mat.pbr_metallic_roughness().base_color_factor();
                let emissive = mat.emissive_factor();
                prims.push(Primitive {
                    positions,
                    normals,
                    indices,
                    color: [base[0], base[1], base[2]],
                    emissive,
                });
            }
            meshes.push(prims);
        }

        let node_count = doc.nodes().len();
        let mut parents = vec![None; node_count];
        for node in doc.nodes() {
            for child in node.children() {
                parents[child.index()] = Some(node.index());
            }
        }
        let mut nodes = Vec::with_capacity(node_count);
        for node in doc.nodes() {
            let (t, r, s) = node.transform().decomposed();
            nodes.push(Node {
                parent: parents[node.index()],
                translation: Vec3(t[0], t[1], t[2]),
                rotation: Quat(r[0], r[1], r[2], r[3]),
                scale: Vec3(s[0], s[1], s[2]),
                mesh: node.mesh().map(|m| m.index()),
            });
        }

        let mut animations = HashMap::new();
        let mut default_anim = None;
        for (idx, anim) in doc.animations().enumerate() {
            let mut channels = Vec::new();
            let mut start = f32::INFINITY;
            let mut end = 0.0_f32;
            for ch in anim.channels() {
                let reader = ch.reader(|_| Some(bin));
                let Some(times) = reader.read_inputs() else {
                    continue;
                };
                let times: Vec<f32> = times.collect();
                if let (Some(&first), Some(&last)) = (times.first(), times.last()) {
                    start = start.min(first);
                    end = end.max(last);
                }
                let Some(outputs) = reader.read_outputs() else {
                    continue;
                };
                let values = match outputs {
                    gltf::animation::util::ReadOutputs::Translations(it) => TrackValues::Translation(it.map(|v| Vec3(v[0], v[1], v[2])).collect()),
                    gltf::animation::util::ReadOutputs::Rotations(it) => TrackValues::Rotation(it.into_f32().map(|v| Quat(v[0], v[1], v[2], v[3])).collect()),
                    gltf::animation::util::ReadOutputs::Scales(it) => TrackValues::Scale(it.map(|v| Vec3(v[0], v[1], v[2])).collect()),
                    gltf::animation::util::ReadOutputs::MorphTargetWeights(_) => continue,
                };
                channels.push(Channel {
                    node: ch.target().node().index(),
                    times,
                    step: ch.sampler().interpolation() == gltf::animation::Interpolation::Step,
                    values,
                });
            }
            let name = anim.name().map(str::to_string).unwrap_or_else(|| format!("anim_{idx}"));
            if default_anim.is_none() || name == "walk" {
                default_anim = Some(name.clone());
            }
            let start = start.min(end);
            animations.insert(
                name,
                Animation {
                    channels,
                    start,
                    duration: end - start,
                },
            );
        }

        Ok(Self {
            nodes,
            meshes,
            animations,
            default_anim,
        })
    }

    fn duration(&self, name: Option<&str>) -> f32 {
        name.or(self.default_anim.as_deref())
            .and_then(|clip| self.animations.get(clip))
            .map_or(0.0, |clip| clip.duration)
    }

    pub fn has_animation(&self, name: &str) -> bool {
        self.animations.contains_key(name)
    }

    fn world_matrices(&self, anim_name: Option<&str>, time_s: f32) -> (Vec<Mat4>, Vec<bool>) {
        let mut t: Vec<Vec3> = self.nodes.iter().map(|n| n.translation).collect();
        let mut r: Vec<Quat> = self.nodes.iter().map(|n| n.rotation).collect();
        let mut s: Vec<Vec3> = self.nodes.iter().map(|n| n.scale).collect();

        let anim = anim_name
            .and_then(|n| self.animations.get(n))
            .or_else(|| self.default_anim.as_deref().and_then(|n| self.animations.get(n)));
        if let Some(anim) = anim {
            let sample_t = if anim.duration > 1e-4 {
                anim.start + time_s.rem_euclid(anim.duration)
            } else {
                anim.start
            };
            for ch in &anim.channels {
                let Some((i0, i1, alpha)) = keyframe_pair(&ch.times, sample_t) else {
                    continue;
                };
                let alpha = if ch.step { 0.0 } else { alpha };
                match &ch.values {
                    TrackValues::Translation(vs) if i1 < vs.len() => t[ch.node] = vs[i0].lerp(vs[i1], alpha),
                    TrackValues::Rotation(vs) if i1 < vs.len() => r[ch.node] = vs[i0].slerp(vs[i1], alpha),
                    TrackValues::Scale(vs) if i1 < vs.len() => s[ch.node] = vs[i0].lerp(vs[i1], alpha),
                    _ => {}
                }
            }
        }

        let local_vis: Vec<bool> = s.iter().map(|v| v.max_abs() > 1e-3).collect();
        let local: Vec<Mat4> = (0..self.nodes.len()).map(|i| Mat4::from_trs(t[i], r[i], s[i])).collect();
        let mut world = vec![None; self.nodes.len()];
        let mut visible = vec![None; self.nodes.len()];
        for i in 0..self.nodes.len() {
            resolve_world(i, &self.nodes, &local, &local_vis, &mut world, &mut visible);
        }
        (
            world.into_iter().map(|m| m.unwrap_or(Mat4::IDENTITY)).collect(),
            visible.into_iter().map(|v| v.unwrap_or(true)).collect(),
        )
    }

    /// Renders a named animation clip (or default) using 2x supersampling and optional warm silhouette outline.
    pub fn render_anim(&self, width: u32, height: u32, camera: Camera, anim: Option<&str>, time_s: f32, outline: bool) -> RgbaImage {
        let w = (width.max(1) * 2) as usize;
        let h = (height.max(1) * 2) as usize;
        let mut color_buf = vec![[0u8; 4]; w * h];
        let mut depth_buf = vec![f32::NEG_INFINITY; w * h];

        let target = Vec3(camera.target[0], camera.target[1], camera.target[2]);
        let (right, up, view_dir) = camera.axes();

        let scale_px = (h as f32) / camera.ortho_scale.max(0.1);
        let half_w = w as f32 * 0.5;
        let half_h = h as f32 * 0.5;
        let proj = OrthoProj {
            target,
            right,
            up,
            view_dir,
            scale_px,
            half_w,
            half_h,
        };

        // Warm 3-point outdoor studio lighting (sun key + cool sky fill + warm ground bounce).
        let key_light = Vec3(-0.46, 0.78, 0.42).norm();
        let fill_light = Vec3(0.60, 0.34, -0.46).norm();
        let (world, visible) = self.world_matrices(anim, time_s);

        for (node_idx, node) in self.nodes.iter().enumerate() {
            if !visible[node_idx] {
                continue;
            }
            let Some(mesh_idx) = node.mesh else {
                continue;
            };
            let mat = world[node_idx];
            for prim in &self.meshes[mesh_idx] {
                let emissive = prim.emissive;
                for &[t0, t1, t2] in prim.indices.as_chunks::<3>().0 {
                    let (i0, i1, i2) = (t0 as usize, t1 as usize, t2 as usize);
                    let p0 = mat.transform_point(prim.positions[i0]);
                    let p1 = mat.transform_point(prim.positions[i1]);
                    let p2 = mat.transform_point(prim.positions[i2]);

                    let s0 = proj.project(p0);
                    let s1 = proj.project(p1);
                    let s2 = proj.project(p2);

                    let area = edge(s0, s1, s2);
                    if area.abs() < 1e-4 {
                        continue;
                    }
                    let face_n = p1.sub(p0).cross(p2.sub(p0)).norm();
                    let n0 = mat.transform_dir(prim.normals[i0]).norm();
                    let n1 = mat.transform_dir(prim.normals[i1]).norm();
                    let n2 = mat.transform_dir(prim.normals[i2]).norm();
                    if face_n.dot(view_dir) < 0.0 && n0.dot(view_dir) < 0.0 && n1.dot(view_dir) < 0.0 && n2.dot(view_dir) < 0.0 {
                        continue;
                    }

                    let min_x = s0.0.min(s1.0).min(s2.0).floor().max(0.0) as usize;
                    let max_x = s0.0.max(s1.0).max(s2.0).ceil().min((w - 1) as f32) as usize;
                    let min_y = s0.1.min(s1.1).min(s2.1).floor().max(0.0) as usize;
                    let max_y = s0.1.max(s1.1).max(s2.1).ceil().min((h - 1) as f32) as usize;
                    let inv_area = 1.0 / area;

                    for py in min_y..=max_y {
                        for px in min_x..=max_x {
                            let pt = Vec3(px as f32 + 0.5, py as f32 + 0.5, 0.0);
                            let w0 = edge(s1, s2, pt) * inv_area;
                            let w1 = edge(s2, s0, pt) * inv_area;
                            let w2 = edge(s0, s1, pt) * inv_area;
                            if w0 >= -1e-4 && w1 >= -1e-4 && w2 >= -1e-4 {
                                let z = w0 * s0.2 + w1 * s1.2 + w2 * s2.2;
                                let idx = py * w + px;
                                if z > depth_buf[idx] {
                                    depth_buf[idx] = z;
                                    let n = Vec3(
                                        n0.0 * w0 + n1.0 * w1 + n2.0 * w2,
                                        n0.1 * w0 + n1.1 * w1 + n2.1 * w2,
                                        n0.2 * w0 + n1.2 * w1 + n2.2 * w2,
                                    )
                                    .norm();
                                    let key = n.dot(key_light).max(0.0);
                                    let fill = n.dot(fill_light).max(0.0);
                                    let light = 0.35 + 0.65 * key + 0.18 * fill;
                                    let band = (light * 6.0).round() / 6.0;
                                    let lr = band * 1.05;
                                    let lg = band;
                                    let lb = band * 0.94 + 0.035 * fill;
                                    color_buf[idx] = [
                                        linear_to_srgb_u8(prim.color[0] * lr + emissive[0]),
                                        linear_to_srgb_u8(prim.color[1] * lg + emissive[1]),
                                        linear_to_srgb_u8(prim.color[2] * lb + emissive[2]),
                                        255,
                                    ];
                                }
                            }
                        }
                    }
                }
            }
        }

        let mut out = RgbaImage::new(width.max(1), height.max(1));
        for y in 0..out.height() as usize {
            for x in 0..out.width() as usize {
                let samples = [
                    color_buf[(y * 2) * w + (x * 2)],
                    color_buf[(y * 2) * w + (x * 2 + 1)],
                    color_buf[(y * 2 + 1) * w + (x * 2)],
                    color_buf[(y * 2 + 1) * w + (x * 2 + 1)],
                ];
                let opaque = samples.iter().filter(|sample| sample[3] == 255).count();
                let px = if opaque >= 2 {
                    // Keep a source material at the pixel boundary instead of blending neighbouring colours.
                    Rgba(
                        *samples
                            .iter()
                            .filter(|sample| sample[3] == 255)
                            .max_by_key(|sample| samples.iter().filter(|other| *other == *sample).count())
                            .unwrap(),
                    )
                } else {
                    Rgba([0; 4])
                };
                out.put_pixel(x as u32, y as u32, px);
            }
        }
        if outline {
            // Ink the unlit outer edge inside the silhouette; the opposite edge keeps its lit material.
            for y in 0..out.height() {
                for x in 0..out.width() {
                    if out[(x, y)][3] != 0 && (x + 1 == out.width() || y + 1 == out.height() || out[(x + 1, y)][3] == 0 || out[(x, y + 1)][3] == 0) {
                        let color = out.get_pixel_mut(x, y);
                        for component in &mut color.0[..3] {
                            *component = (*component as f32 * 0.73).round() as u8;
                        }
                    }
                }
            }
        }
        out
    }
}

struct OrthoProj {
    target: Vec3,
    right: Vec3,
    up: Vec3,
    view_dir: Vec3,
    scale_px: f32,
    half_w: f32,
    half_h: f32,
}

impl OrthoProj {
    fn project(&self, p: Vec3) -> Vec3 {
        let rel = p.sub(self.target);
        Vec3(
            self.half_w + rel.dot(self.right) * self.scale_px,
            self.half_h - rel.dot(self.up) * self.scale_px,
            rel.dot(self.view_dir),
        )
    }
}

fn edge(a: Vec3, b: Vec3, c: Vec3) -> f32 {
    (c.0 - a.0) * (b.1 - a.1) - (c.1 - a.1) * (b.0 - a.0)
}

fn keyframe_pair(times: &[f32], t: f32) -> Option<(usize, usize, f32)> {
    if times.is_empty() {
        return None;
    }
    if times.len() == 1 || t <= times[0] {
        return Some((0, 0, 0.0));
    }
    let last = times.len() - 1;
    if t >= times[last] {
        return Some((last, last, 0.0));
    }
    let idx = times.partition_point(|&kt| kt <= t).saturating_sub(1);
    let next = (idx + 1).min(last);
    let span = times[next] - times[idx];
    let alpha = if span > 1e-6 { (t - times[idx]) / span } else { 0.0 };
    Some((idx, next, alpha))
}

fn resolve_world(i: usize, nodes: &[Node], local: &[Mat4], local_vis: &[bool], cache: &mut [Option<Mat4>], vis_cache: &mut [Option<bool>]) -> (Mat4, bool) {
    if let (Some(m), Some(v)) = (cache[i], vis_cache[i]) {
        return (m, v);
    }
    let (m, v) = match nodes[i].parent {
        Some(p) => {
            let (pm, pv) = resolve_world(p, nodes, local, local_vis, cache, vis_cache);
            (pm.mul(local[i]), pv && local_vis[i])
        }
        None => (local[i], local_vis[i]),
    };
    cache[i] = Some(m);
    vis_cache[i] = Some(v);
    (m, v)
}

fn linear_to_srgb_u8(v: f32) -> u8 {
    let c = v.clamp(0.0, 1.0);
    let s = if c <= 0.0031308 { c * 12.92 } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 };
    (s * 255.0).round() as u8
}

#[derive(Clone, Copy)]
struct Silhouette {
    left: f32,
    right: f32,
    bottom: f32,
    top: f32,
    ground_front: f32,
}

impl Silhouette {
    fn anchor(self, camera: Camera, plot: bool) -> (f32, f32) {
        if !plot {
            return (0.0, self.bottom);
        }
        // LDtk registers the middle of the southern field edge, even when the angled near corner extends past it.
        let (right, up, _) = camera.axes();
        (right.2 * self.ground_front, up.2 * self.ground_front)
    }
}

impl GlbModel {
    // One envelope for the whole clip keeps the worker's feet and apparent scale stable.
    fn silhouette(&self, spec: &SpriteSpec) -> Silhouette {
        let (right, up, _) = spec.camera.axes();
        let mut bounds = Silhouette {
            left: f32::INFINITY,
            right: f32::NEG_INFINITY,
            bottom: f32::INFINITY,
            top: f32::NEG_INFINITY,
            ground_front: 0.0,
        };
        let duration = self.duration(spec.anim.as_deref());
        let samples = if duration > 0.0 { HELPER_FRAMES } else { 1 };
        for frame in 0..samples {
            let (world, visible) = self.world_matrices(spec.anim.as_deref(), duration * frame as f32 / samples as f32);
            for (index, node) in self.nodes.iter().enumerate() {
                let Some(mesh) = node.mesh.filter(|_| visible[index]) else { continue };
                for primitive in &self.meshes[mesh] {
                    for p in &primitive.positions {
                        let p = world[index].transform_point(*p);
                        if p.1 <= 0.02 {
                            bounds.ground_front = bounds.ground_front.max(p.2);
                        }
                        let x = p.dot(right);
                        let y = p.dot(up);
                        bounds.left = bounds.left.min(x);
                        bounds.right = bounds.right.max(x);
                        bounds.bottom = bounds.bottom.min(y);
                        bounds.top = bounds.top.max(y);
                    }
                }
            }
        }
        bounds
    }
}

#[derive(Clone, Copy)]
pub struct SpriteCanvas {
    pub width: u32,
    pub height: u32,
    pub foot_x: f32,
    pub foot_y: f32,
    pub density: f32,
    pub pixels_per_unit: Option<f32>,
}

impl SpriteCanvas {
    fn include(mut self, bounds: Silhouette, scale: f32, anchor: (f32, f32), flip: bool) -> Self {
        let (ax, ay) = anchor;
        let (left, right) = if flip {
            (-bounds.right + ax, -bounds.left + ax)
        } else {
            (bounds.left - ax, bounds.right - ax)
        };
        let extra_left = (1.0 - left * scale - self.foot_x).ceil().max(0.0);
        let extra_right = (right * scale + 1.0 - (self.width as f32 - self.foot_x)).ceil().max(0.0);
        let extra_top = ((bounds.top - ay) * scale + 2.0 - self.foot_y).ceil().max(0.0);
        let extra_bottom = ((ay - bounds.bottom) * scale + 0.5 - (self.height as f32 - self.foot_y)).ceil().max(0.0);
        self.width += (extra_left + extra_right) as u32;
        self.height += (extra_top + extra_bottom) as u32;
        self.foot_x += extra_left;
        self.foot_y += extra_top;
        self.pixels_per_unit = Some(scale);
        self
    }

    fn frame(self, mut camera: Camera, bounds: Silhouette, plot: bool) -> Camera {
        let w = self.width as f32;
        let h = self.height as f32;
        let foot = self.foot_y.clamp(1.0, h);
        let scale = if let Some(scale) = self.pixels_per_unit {
            scale
        } else {
            ((self.foot_x - 1.0) / (-bounds.left).max(0.01))
                .min((w - self.foot_x - 1.0) / bounds.right.max(0.01))
                .min((foot - 2.0) / (bounds.top - bounds.bottom).max(0.01))
                .max(0.1)
        };
        let (right, up, _) = camera.axes();
        let (ax, ay) = bounds.anchor(camera, plot);
        let x = ax + (w * 0.5 - self.foot_x) / scale;
        let y = ay + (foot - 0.5 - h * 0.5) / scale;
        camera.target = [right.0 * x + up.0 * y, right.1 * x + up.1 * y, right.2 * x + up.2 * y];
        camera.ortho_scale = h / scale;
        camera
    }
}

#[derive(Hash, PartialEq, Eq)]
struct ClipView {
    model: String,
    clip: Option<String>,
    yaw: u32,
    pitch: u32,
}

/// On-demand cache of `.glb` models under `<assets>/models/`.
pub struct ModelLibrary {
    dir: PathBuf,
    models: HashMap<String, Option<Arc<GlbModel>>>,
    silhouettes: HashMap<ClipView, Silhouette>,
}

impl ModelLibrary {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            models: HashMap::new(),
            silhouettes: HashMap::new(),
        }
    }

    /// Loads `<dir>/<name>.glb` on first request; caches misses so missing files are not retried every frame.
    pub fn get(&mut self, name: &str) -> Option<Arc<GlbModel>> {
        if let Some(cached) = self.models.get(name) {
            return cached.clone();
        }
        let path = self.dir.join(format!("{name}.glb"));
        let loaded = path.exists().then(|| GlbModel::load(&path).ok().map(Arc::new)).flatten();
        self.models.insert(name.to_string(), loaded.clone());
        loaded
    }

    fn bounds(&mut self, model: &GlbModel, spec: &SpriteSpec) -> Silhouette {
        let key = ClipView {
            model: spec.model.clone(),
            clip: spec.anim.clone(),
            yaw: spec.camera.yaw.to_bits(),
            pitch: spec.camera.pitch.to_bits(),
        };
        *self.silhouettes.entry(key).or_insert_with(|| model.silhouette(spec))
    }

    pub fn model_canvas(&mut self, name: &str, canvas: SpriteCanvas, standing_height: Option<f32>) -> Option<SpriteCanvas> {
        let spec = resolve_sprite(name)?;
        let model = self.get(&spec.model)?;
        if spec.model.starts_with("plot-") {
            let bounds = self.bounds(&model, &spec);
            let zoom = if name.starts_with("island/") {
                super::projection::island_zoom()
            } else {
                super::projection::zoom()
            };
            let scale = 18.0 * canvas.density * zoom;
            return Some(canvas.include(bounds, scale, bounds.anchor(spec.camera, true), false));
        }
        let standing_height = standing_height?;
        let clip = spec.anim.as_deref()?;
        if !model.has_animation(clip) {
            return None;
        }
        let standing = resolve_sprite(&format!("{}-down", spec.model))?;
        let body = self.bounds(&model, &standing);
        let scale = (standing_height - 3.0) / (body.top - body.bottom);
        let bounds = self.bounds(&model, &spec);
        Some(canvas.include(bounds, scale, (0.0, bounds.bottom), clip == "tinker"))
    }

    pub fn render_sprite(&mut self, name: &str, mut canvas: SpriteCanvas) -> Option<RgbaImage> {
        let spec = resolve_sprite(name)?;
        let model = self.get(&spec.model)?;
        if let Some(clip) = spec.anim.as_deref()
            && !model.has_animation(clip)
        {
            return None;
        }
        // The near hand carries the tool. Mirror that view about the atlas foot to face right.
        let face_right = spec.anim.as_deref() == Some("tinker");
        if face_right {
            canvas.foot_x = canvas.width as f32 - canvas.foot_x;
        }
        let camera = if name.ends_with("-face") {
            spec.camera
        } else {
            let bounds = self.bounds(&model, &spec);
            canvas.frame(spec.camera, bounds, spec.model.starts_with("plot-"))
        };
        let mut sprite = model.render_anim(
            canvas.width,
            canvas.height,
            camera,
            spec.anim.as_deref(),
            spec.phase * model.duration(spec.anim.as_deref()),
            spec.outline,
        );
        if face_right {
            image::imageops::flip_horizontal_in_place(&mut sprite);
        }
        Some(sprite)
    }
}

struct SpriteSpec {
    model: String,
    camera: Camera,
    anim: Option<String>,
    phase: f32,
    outline: bool,
}

const HELPER_SPECIES: [&str; 7] = ["fox", "cat", "bear", "rabbit", "owl", "hedgehog", "raccoon"];
const HELPER_OUTFITS: [&str; 4] = ["farmer", "gardener", "rain", "winter"];
const PET_SPECIES: [&str; 3] = ["dog", "bluecat", "ragdoll"];
const MANAGER_LOOKS: [&str; 5] = ["auntie", "foreman", "gardener", "grandpa", "robot"];

pub const HELPER_FRAMES: u8 = 8;

fn helper(name: &str) -> Option<(&str, &str, &str, Option<u8>)> {
    let mut parts = name.splitn(3, '-');
    let (species, outfit, pose) = (parts.next()?, parts.next()?, parts.next()?);
    if !HELPER_SPECIES.contains(&species) || !HELPER_OUTFITS.contains(&outfit) {
        return None;
    }
    let (pose, frame) = match pose.split_once('@') {
        Some((pose, n)) => (pose, Some(n.parse::<u8>().ok().filter(|n| *n < HELPER_FRAMES)?)),
        None => (pose, None),
    };
    Some((species, outfit, pose, frame))
}

pub fn helper_standing(name: &str) -> Option<String> {
    let (species, outfit, _, _) = helper(name)?;
    Some(format!("{species}-{outfit}-down"))
}

/// Animated models and island plots use the logical dimensions of their painted counterparts.
pub fn painted_sprite(name: &str, moving_png: bool) -> Cow<'_, str> {
    if let Some(plot) = name.strip_prefix("island/plot-") {
        return Cow::Owned(format!("plot-{plot}"));
    }
    let Some((species, outfit, pose, Some(frame))) = helper(name) else {
        return name.into();
    };
    let painted = match pose {
        "walk-down" | "walk-side" | "walk-up" => {
            let dir = pose.strip_prefix("walk-").unwrap();
            let suffix = if moving_png { ["-1", "", "-2", ""][(frame / 2) as usize] } else { "" };
            return Cow::Owned(format!("{species}-{outfit}-{dir}{suffix}"));
        }
        "hammer" => {
            if moving_png && frame >= 4 {
                "hammer-2"
            } else {
                "hammer-1"
            }
        }
        "tinker" => {
            if moving_png && frame >= 4 {
                "tinker-2"
            } else {
                "tinker-1"
            }
        }
        "hoe" => "work",
        "ask" => "worry",
        "down" | "side" | "up" | "read" | "cheer" | "worry" | "sit" => pose,
        _ => return name.into(),
    };
    Cow::Owned(format!("{species}-{outfit}-{painted}"))
}

fn resolve_sprite(name: &str) -> Option<SpriteSpec> {
    if let Some((species, outfit, pose, frame)) = helper(name) {
        let (clip, yaw, pitch, phase) = match pose {
            "down" => ("idle", -0.61, 0.41, 0.0),
            "down-1" | "walk-down" => ("walk", -0.61, 0.41, 0.25),
            "down-2" => ("walk", -0.61, 0.41, 0.75),
            "side" => ("idle", -1.35, 0.30, 0.0),
            "side-1" | "walk-side" => ("walk", -1.35, 0.30, 0.25),
            "side-2" => ("walk", -1.35, 0.30, 0.75),
            "up" => ("idle", 2.62, 0.43, 0.0),
            "up-1" | "walk-up" => ("walk", 2.62, 0.43, 0.25),
            "up-2" => ("walk", 2.62, 0.43, 0.75),
            "hammer-1" | "hammer" => ("hammer", -0.12, 0.32, 0.25),
            "hammer-2" => ("hammer", -0.12, 0.32, 0.625),
            "tinker-1" | "tinker" => ("tinker", 0.64, 0.37, 0.25),
            "tinker-2" => ("tinker", 0.64, 0.37, 0.625),
            "hoe" | "work" => ("hoe", -0.52, 0.38, 0.625),
            "ask" => ("ask", 0.56, 0.35, 0.375),
            "read" => ("read", -0.57, 0.56, 0.25),
            "sit" => ("sit", -0.55, 0.36, 0.25),
            "cheer" => ("cheer", -0.54, 0.35, 0.375),
            "worry" => ("worry", -0.54, 0.35, 0.375),
            _ => return None,
        };
        return Some(SpriteSpec {
            model: format!("{species}-{outfit}"),
            camera: Camera {
                yaw,
                pitch,
                ..Camera::default()
            },
            anim: Some(clip.into()),
            phase: frame.map_or(phase, |n| n as f32 / HELPER_FRAMES as f32),
            outline: true,
        });
    }

    // 2. Orchestrator managers: manager[-<look>][-(listen|talk|face)]
    if name == "manager" || name.starts_with("manager-") {
        let rest = name.strip_prefix("manager-").unwrap_or("");
        let (look, state) = if let Some(first) = rest.split('-').next()
            && MANAGER_LOOKS.contains(&first)
        {
            (first, rest.strip_prefix(first).unwrap_or("").trim_start_matches('-'))
        } else {
            ("farmer", rest)
        };
        if state == "face" {
            return Some(SpriteSpec {
                model: format!("manager-{look}"),
                camera: Camera {
                    yaw: -0.24,
                    pitch: 0.22,
                    ortho_scale: 1.32,
                    target: [0.0, 1.88, 0.0],
                },
                anim: Some("idle".into()),
                phase: 0.0,
                outline: true,
            });
        }
        let (anim, yaw, phase) = match state {
            "talk" => ("talk", -0.28, 0.30),
            "listen" => ("listen", 0.26, 0.30),
            _ => ("idle", -0.24, 0.0),
        };
        return Some(SpriteSpec {
            model: format!("manager-{look}"),
            camera: Camera {
                yaw,
                pitch: 0.36,
                ..Camera::default()
            },
            anim: Some(anim.into()),
            phase,
            outline: true,
        });
    }

    // 3. Pets: <dog|bluecat|ragdoll>-<pose>
    if let Some((pet, pose)) = name.split_once('-')
        && PET_SPECIES.contains(&pet)
    {
        let (anim, yaw, phase) = match pose {
            "walk-1" | "run-1" => ("walk", 1.18, 0.22),
            "walk-2" | "run-2" => ("walk", 1.18, 0.72),
            "sleep" | "lie" => ("sleep", -0.72, 0.25),
            "belly" => ("belly", -0.60, 0.25),
            "bark" => ("bark", -0.34, 0.35),
            "jump" => ("jump", -0.34, 0.35),
            _ => ("awake", -0.50, 0.20),
        };
        return Some(SpriteSpec {
            model: format!("pet-{pet}"),
            camera: Camera {
                yaw,
                pitch: 0.40,
                ..Camera::default()
            },
            anim: Some(anim.into()),
            phase,
            outline: true,
        });
    }

    // 4. Yard props
    if name == "mailbox" || name.starts_with("prop-") {
        let model = if name == "mailbox" { "prop-mailbox" } else { name };
        let yaw = match model {
            "prop-crates" => -0.52,
            "prop-mailbox" => -0.48,
            "prop-table" => -0.45,
            _ => -0.35,
        };
        return Some(SpriteSpec {
            model: model.to_string(),
            camera: Camera {
                yaw,
                pitch: 0.40,
                ..Camera::default()
            },
            anim: None,
            phase: 0.0,
            outline: true,
        });
    }

    // 5. Farm machines
    if name.starts_with("machine-") {
        return Some(SpriteSpec {
            model: name.to_string(),
            camera: Camera {
                yaw: -0.58,
                pitch: 0.40,
                ..Camera::default()
            },
            anim: None,
            phase: 0.15,
            outline: true,
        });
    }

    let plot = name.strip_prefix("island/").unwrap_or(name);
    if plot.starts_with("plot-") {
        return Some(SpriteSpec {
            model: plot.to_owned(),
            camera: Camera {
                yaw: super::projection::yaw(),
                pitch: super::projection::pitch(),
                ..Camera::default()
            },
            anim: None,
            phase: 0.0,
            outline: false,
        });
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(size: u32) -> SpriteCanvas {
        SpriteCanvas {
            width: size,
            height: size,
            foot_x: size as f32 * 0.5,
            foot_y: size as f32 - 1.0,
            density: 2.0,
            pixels_per_unit: None,
        }
    }

    #[test]
    fn regression_helpers_fit_the_atlas_canvas_and_keep_their_footing() {
        let atlas = crate::pixel::atlas::Atlas::load(&crate::pixel::assets_dir().join("pixel"), 2.0).unwrap();
        for (species, pose) in [("rabbit", "down"), ("fox", "side"), ("fox", "hammer-1"), ("raccoon", "read")] {
            let name = format!("{species}-farmer-{pose}");
            let info = atlas.get(&name).unwrap();
            let image = atlas.image(&name).unwrap();
            assert!(image.pixels().all(|p| matches!(p[3], 0 | 255)), "{name} softens the pixel silhouette");
            assert!((0..image.width()).all(|x| image[(x, 0)][3] < 160), "{name} cuts the top of the silhouette");
            assert!(
                (0..image.height()).all(|y| image[(0, y)][3] < 180 && image[(image.width() - 1, y)][3] < 180),
                "{name} cuts a side"
            );
            let lowest = image.enumerate_pixels().filter(|(_, _, p)| p[3] > 200).map(|(_, y, _)| y).max().unwrap();
            assert!((lowest as f32 - info.ay * atlas.density).abs() <= 3.0, "{name} misses its foot anchor");
        }
        let standing = atlas.visible_box("fox-farmer-down@0", 100.0, 80.0, false).unwrap();
        for pose in ["fox-farmer-hoe@5", "fox-farmer-hammer@2", "fox-farmer-read@2"] {
            let active = atlas.visible_box(pose, 100.0, 80.0, false).unwrap();
            assert!(active.y1 - active.y0 >= 0.75 * (standing.y1 - standing.y0), "{pose} shrank to fit its tool");
            assert!((active.y1 - standing.y1).abs() < 2.0);
        }
        let side = resolve_sprite("fox-farmer-walk-side@2").unwrap();
        assert!(side.camera.axes().0.dot(Vec3(0.0, 0.0, 1.0)) > 0.9, "the unflipped walker must face right");
        for pose in ["walk-side", "hammer", "read"] {
            let phases: Vec<_> = (0..HELPER_FRAMES)
                .map(|frame| atlas.image(&format!("fox-farmer-{pose}@{frame}")).unwrap())
                .collect();
            assert!(phases.iter().all(|image| image.dimensions() == phases[0].dimensions()));
            assert!(
                phases.windows(2).filter(|pair| pair[0].as_raw() != pair[1].as_raw()).count() >= 4,
                "{pose} is frozen at farm size"
            );
        }
    }

    #[test]
    fn regression_island_and_yard_soil_use_their_ground_plane() {
        let yard = resolve_sprite("plot-empty").unwrap();
        let island = resolve_sprite("island/plot-empty").unwrap();
        assert_eq!(yard.model, island.model);
        assert_eq!(yard.camera.yaw, super::super::projection::yaw());
        assert_eq!(island.camera.yaw, yard.camera.yaw);
        assert_eq!(yard.camera.pitch, super::super::projection::pitch());
        assert_eq!(island.camera.pitch, yard.camera.pitch);
        let atlas = crate::pixel::atlas::Atlas::load(&crate::pixel::assets_dir().join("pixel"), 2.0).unwrap();
        for name in ["plot-empty", "island/plot-empty"] {
            let ink = atlas.visible_box(name, 0.0, 0.0, false).unwrap();
            assert!(ink.y1 > 1.0, "{name} must extend below the middle of its front edge");
            assert!(ink.y0 < -10.0 && ink.x0 < -6.0 && ink.x1 > 12.0);
        }
        assert_ne!(
            atlas.image("island/plot-empty").unwrap().dimensions(),
            atlas.image("plot-empty").unwrap().dimensions()
        );
    }

    #[test]
    fn fox_glb_loads_animates_and_renders() {
        let path = crate::pixel::assets_dir().join("models/fox-farmer.glb");
        let model = GlbModel::load(&path).expect("load fox-farmer.glb");
        assert!(model.duration(Some("walk")) > 0.5, "expected walk animation");

        let f0 = model.render_anim(240, 240, Camera::default(), Some("walk"), 0.0, false);
        let f1 = model.render_anim(240, 240, Camera::default(), Some("walk"), 0.35, false);
        let opaque = f0.pixels().filter(|p| p.0[3] > 200).count();
        assert!(opaque > 5_000, "rendered silhouette too small: {opaque}");
        assert_ne!(f0.as_raw(), f1.as_raw(), "animation should move the character");
    }

    #[test]
    fn cat_glb_loads_animates_and_renders() {
        let path = crate::pixel::assets_dir().join("models/cat-farmer.glb");
        let model = GlbModel::load(&path).expect("load cat-farmer.glb");
        assert!(model.duration(Some("walk")) > 0.5, "expected walk animation");

        let f0 = model.render_anim(240, 240, Camera::default(), Some("walk"), 0.0, false);
        let f1 = model.render_anim(240, 240, Camera::default(), Some("walk"), 0.35, false);
        assert!(f0.pixels().filter(|p| p.0[3] > 200).count() > 5_000);
        assert_ne!(f0.as_raw(), f1.as_raw());
    }

    #[test]
    fn helper_poses_and_expressions_render_distinctly() {
        let mut lib = ModelLibrary::new(crate::pixel::assets_dir().join("models"));
        let fox = lib.get("fox-farmer").expect("fox-farmer.glb");
        for clip in ["idle", "walk", "hammer", "tinker", "read", "sit", "cheer", "worry"] {
            assert!(fox.has_animation(clip), "missing clip {clip}");
        }
        let poses = [
            "fox-farmer-down",
            "fox-farmer-hammer-1",
            "fox-farmer-tinker-1",
            "fox-farmer-read",
            "fox-farmer-sit",
            "fox-farmer-cheer",
            "fox-farmer-worry",
        ];
        let rendered: Vec<RgbaImage> = poses
            .iter()
            .map(|p| lib.render_sprite(p, square(160)).unwrap_or_else(|| panic!("missing {p}")))
            .collect();
        for img in &rendered {
            assert!(img.pixels().filter(|p| p.0[3] > 200).count() > 2_000);
        }
        assert_ne!(rendered[0].as_raw(), rendered[1].as_raw(), "hammer should differ from idle");
        assert_ne!(rendered[5].as_raw(), rendered[6].as_raw(), "cheer should differ from worry");

        if let Ok(out_dir) = std::env::var("POSE_PREVIEW_OUT") {
            let dir = PathBuf::from(out_dir);
            std::fs::create_dir_all(&dir).unwrap();
            let tile = 220u32;
            let mut sheet = RgbaImage::from_pixel(tile * poses.len() as u32, tile, Rgba([243, 237, 224, 255]));
            for (i, p) in poses.iter().enumerate() {
                let img = lib.render_sprite(p, square(tile)).unwrap();
                for y in 0..tile {
                    for x in 0..tile {
                        let s = img.get_pixel(x, y).0;
                        let a = s[3] as f32 / 255.0;
                        let d = sheet.get_pixel(i as u32 * tile + x, y).0;
                        sheet.put_pixel(
                            i as u32 * tile + x,
                            y,
                            Rgba([
                                (s[0] as f32 * a + d[0] as f32 * (1.0 - a)).round() as u8,
                                (s[1] as f32 * a + d[1] as f32 * (1.0 - a)).round() as u8,
                                (s[2] as f32 * a + d[2] as f32 * (1.0 - a)).round() as u8,
                                255,
                            ]),
                        );
                    }
                }
            }
            sheet.save(dir.join("fox-poses-expressions.png")).unwrap();
        }
    }
}

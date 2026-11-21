use image::RgbaImage;

#[derive(Clone, Copy)]
pub struct Grade {
    pub exposure: f32,
    pub saturation: f32,
    pub lift: f32,
    pub vignette: f32,
    pub shadows: [f32; 3],
    pub highlights: [f32; 3],
}

impl Grade {
    pub fn mix(self, rhs: Self, t: f32) -> Self {
        let mix = |a, b| a + (b - a) * t;
        Self {
            exposure: mix(self.exposure, rhs.exposure),
            saturation: mix(self.saturation, rhs.saturation),
            lift: mix(self.lift, rhs.lift),
            vignette: mix(self.vignette, rhs.vignette),
            shadows: std::array::from_fn(|i| mix(self.shadows[i], rhs.shadows[i])),
            highlights: std::array::from_fn(|i| mix(self.highlights[i], rhs.highlights[i])),
        }
    }
}

#[derive(Clone)]
pub struct PointLight {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub radius: f32,
    pub color: [f32; 3],
    pub intensity: f32,
}

#[derive(Clone)]
pub struct Lighting {
    pub ambient: [f32; 3],
    pub sun: [f32; 3],
    pub dir: [f32; 3],
    pub clouds: f32,
    pub mist: f32,
    pub grade: Grade,
    pub time: f32,
    pub lamps: Vec<PointLight>,
}

fn smooth(lo: f32, hi: f32, x: f32) -> f32 {
    let k = ((x - lo) / (hi - lo)).clamp(0., 1.);
    k * k * (3. - 2. * k)
}

// Chromium's software WebGL backend evaluates sine with an odd degree-five
// interpolant at 0, π/6, π/3 and π/2. The cloud hash amplifies a one-ULP
// difference into a different cloud. Keep each operation at shader precision.
fn cloud_hash(x: f32, y: f32) -> f32 {
    const A: f32 = ((36_288.0 - 20_736.0 * 1.7320508075688772_f64) / 5.0) as f32;
    const B: f32 = (288.0 * 1.7320508075688772_f64 - 540.0) as f32;
    const C: f32 = ((47.0 - 9.0 * 1.7320508075688772_f64) / 5.0) as f32;
    let turn = 0.25 - (x * 127.1 + y * 311.7) * std::f32::consts::FRAC_1_PI * 0.5;
    let z = 0.25 - (turn - turn.round_ties_even()).abs();
    let z2 = z * z;
    let hashed = ((A * z2 + B) * z2 + C) * z * 43_758.547;
    hashed - hashed.floor()
}

struct Noise {
    start: [f32; 2],
    freq: [f32; 2],
    stride: usize,
    grid: Vec<f32>,
}
impl Noise {
    fn new(w: usize, h: usize, freq: [f32; 2], offset: [f32; 2]) -> Self {
        let start = offset.map(|v| v - v.floor());
        let stride = (w as f32 * freq[0] + start[0]).ceil() as usize + 2;
        let rows = (h as f32 * freq[1] + start[1]).ceil() as usize + 2;
        let mut grid = Vec::with_capacity(rows * stride);
        for y in 0..rows {
            for x in 0..stride {
                grid.push(cloud_hash(x as f32 + offset[0].floor(), y as f32 + offset[1].floor()));
            }
        }
        Self { start, freq, stride, grid }
    }
    fn sample(&self, x: f32, y: f32) -> f32 {
        let x = x * self.freq[0] + self.start[0];
        let y = y * self.freq[1] + self.start[1];
        let index = (y as usize) * self.stride + x as usize;
        let fx = x.fract();
        let fy = y.fract();
        let fx = fx * fx * (3. - 2. * fx);
        let fy = fy * fy * (3. - 2. * fy);
        let a = self.grid[index];
        let b = self.grid[index + self.stride];
        let top = a + (self.grid[index + 1] - a) * fx;
        let bottom = b + (self.grid[index + self.stride + 1] - b) * fx;
        top + (bottom - top) * fy
    }
}

impl Lighting {
    pub(crate) fn shade(&self, color: &mut RgbaImage, normals: &RgbaImage, density: usize) {
        let (w, h) = (normals.width() as usize, normals.height() as usize);
        let t = self.time;
        let clouds = (self.clouds > 0.).then(|| {
            (
                Noise::new(w, h, [0.011; 2], [t * 0.018, t * 0.007]),
                Noise::new(w, h, [0.027; 2], [-t * 0.01, 0.]),
            )
        });
        let mist = (self.mist > 0.).then(|| {
            (
                Noise::new(w, h, [0.022, 0.045], [t * 0.35, 0.]),
                Noise::new(w, h, [0.07; 2], [-t * 0.2, -t * 0.05]),
            )
        });
        let unit: Vec<[f32; 3]> = normals
            .pixels()
            .map(|p| {
                let [x, y, z] = [p[0], p[1], p[2]].map(|v| v as f32 / 127.5 - 1.);
                let inv = 1. / (x * x + y * y + z * z).sqrt();
                [x * inv, y * inv, z * inv]
            })
            .collect();
        let mut lit = vec![[0f32; 3]; w * h];
        for lamp in self.lamps.iter().filter(|l| l.radius > 0. && l.intensity > 0.01).take(32) {
            let min_x = (lamp.x - lamp.radius).max(0.) as usize;
            let max_x = ((lamp.x + lamp.radius).ceil() as usize).min(w);
            let min_y = (lamp.y - lamp.radius).max(0.) as usize;
            let max_y = ((lamp.y + lamp.radius).ceil() as usize).min(h);
            for y in min_y..max_y {
                for x in min_x..max_x {
                    let dx = lamp.x - x as f32;
                    let dy = lamp.y - y as f32;
                    let d2 = dx * dx + dy * dy;
                    let reach = 1. - d2.sqrt() / lamp.radius;
                    if reach <= 0. {
                        continue;
                    }
                    let i = y * w + x;
                    let n = unit[i];
                    let dot = (n[0] * dx + n[1] * dy + n[2] * lamp.z).max(0.) / (d2 + lamp.z * lamp.z).sqrt().max(f32::EPSILON);
                    let k = lamp.intensity * reach * reach * dot;
                    for (out, c) in lit[i].iter_mut().zip(lamp.color) {
                        *out += k * c;
                    }
                }
            }
        }
        let g = self.grade;
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                let (px, py) = (x as f32, y as f32);
                let n = unit[i];
                let mut sun_dot = (n[0] * self.dir[0] + n[1] * self.dir[1] + n[2] * self.dir[2]).max(0.);
                if let Some((a, b)) = &clouds {
                    sun_dot *= 1. - self.clouds * smooth(0.42, 0.68, 0.7 * a.sample(px, py) + 0.3 * b.sample(px, py));
                }
                let haze = mist
                    .as_ref()
                    .map_or(0., |(a, b)| (0.65 * a.sample(px, py) + 0.35 * b.sample(px, py)) * self.mist * 1.4);
                let brightest = lit[i].iter().copied().fold(1.1f32, f32::max);
                let illumination: [f32; 3] =
                    std::array::from_fn(|c| (self.ambient[c] + self.sun[c] * sun_dot + lit[i][c] * (1.1 / brightest)) * (1. - haze) * g.exposure / 255.);
                let vx = (px + 0.5) / w as f32 - 0.5;
                let vy = ((py + 0.5) / h as f32 - 0.5) * 0.8;
                let vignette = 1. - g.vignette * smooth(0.3, 0.75, (vx * vx + vy * vy).sqrt());
                for sy in 0..density {
                    let start = ((y * density + sy) * w * density + x * density) * 4;
                    for p in color.as_mut()[start..start + density * 4].as_chunks_mut::<4>().0 {
                        let rgb: [f32; 3] = std::array::from_fn(|c| p[c] as f32 * illumination[c] + [0.9, 0.92, 0.94][c] * haze * g.exposure);
                        let l = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
                        let dark = 1. - smooth(0., 0.6, l);
                        let bright = smooth(0.4, 1., l);
                        for c in 0..3 {
                            let graded = l + (rgb[c] - l) * g.saturation + g.shadows[c] * dark + g.highlights[c] * bright;
                            p[c] = ((g.lift + graded * (1. - g.lift)) * vignette * 255.).round() as u8;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    // Color-pass, normal-pass and final RGB read from the Web farm's noon
    // WebGL framebuffer at a2c1851ab, before HUD and foreground rendering.
    #[test]
    fn noon_light_matches_the_reference_filter() {
        let pixels = [
            (230, 139, [222, 161, 85], [128, 127, 255], [242, 171, 78]),
            (48, 46, [234, 193, 93], [131, 151, 253], [237, 192, 78]),
            (340, 191, [134, 127, 63], [134, 132, 255], [130, 125, 61]),
            (95, 210, [67, 85, 56], [136, 126, 255], [77, 103, 74]),
            (180, 200, [227, 165, 89], [128, 129, 255], [230, 164, 78]),
            (90, 40, [157, 125, 84], [128, 116, 254], [172, 135, 86]),
            (0, 0, [164, 165, 63], [125, 130, 255], [154, 155, 49]),
        ];
        let rgba = |v: [u8; 3]| Rgba([v[0], v[1], v[2], 255]);
        let mut color = RgbaImage::new(384, 256);
        let mut normal = RgbaImage::from_pixel(384, 256, rgba([128, 128, 255]));
        for (x, y, c, n, _) in pixels {
            color.put_pixel(x, y, rgba(c));
            normal.put_pixel(x, y, rgba(n));
        }
        let light = Lighting {
            ambient: [0.62, 0.64, 0.68],
            dir: [0., -0.4472136, 0.8944272],
            sun: [0.39503866, 0.37923712, 0.33973327],
            grade: Grade {
                exposure: 1.06,
                saturation: 1.18,
                lift: 0.04,
                vignette: 0.16,
                shadows: [0.02, 0.06, 0.1],
                highlights: [0.05, 0.035, -0.01],
            },
            clouds: 0.22,
            mist: 0.,
            time: 0.4499,
            lamps: vec![],
        };
        light.shade(&mut color, &normal, 1);
        for (x, y, _, _, expected) in pixels {
            let got = color.get_pixel(x, y);
            assert!(
                expected.iter().zip(got.0).all(|(a, b)| u8::abs_diff(*a, b) <= 2),
                "{x},{y}: expected {expected:?}, got {got:?}"
            );
        }
    }
}

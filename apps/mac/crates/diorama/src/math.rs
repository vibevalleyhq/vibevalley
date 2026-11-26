#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

impl Vec2 {
    pub const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub const ZERO: Self = Self { x: 0.0, y: 0.0, z: 0.0 };
    pub const fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }
    #[allow(clippy::should_implement_trait)]
    pub fn add(self, o: Self) -> Self {
        Self::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
    #[allow(clippy::should_implement_trait)]
    pub fn sub(self, o: Self) -> Self {
        Self::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
    pub fn scale(self, s: f32) -> Self {
        Self::new(self.x * s, self.y * s, self.z * s)
    }
    pub fn lerp(self, o: Self, t: f32) -> Self {
        self.add(o.sub(self).scale(t))
    }
    pub fn dot(self, o: Self) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
    pub fn cross(self, o: Self) -> Self {
        Self::new(self.y * o.z - self.z * o.y, self.z * o.x - self.x * o.z, self.x * o.y - self.y * o.x)
    }
    pub fn len_sq(self) -> f32 {
        self.dot(self)
    }
    pub fn len(self) -> f32 {
        self.len_sq().sqrt()
    }
    pub fn normalize(self) -> Self {
        let l = self.len();
        if l < 1e-6 { Self::ZERO } else { self.scale(1.0 / l) }
    }
    pub fn to_array(self) -> [f32; 3] {
        [self.x, self.y, self.z]
    }
}

/// Column-major 4x4 matrix suitable directly for Metal (`float4x4`).
#[derive(Clone, Copy, Debug)]
pub struct Mat4(pub [[f32; 4]; 4]);

impl Mat4 {
    pub const IDENTITY: Self = Self([[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]);

    #[allow(clippy::should_implement_trait)]
    pub fn mul(self, rhs: Self) -> Self {
        let a = &self.0;
        let b = &rhs.0;
        let mut out = [[0.0f32; 4]; 4];
        for c in 0..4 {
            for r in 0..4 {
                out[c][r] = a[0][r] * b[c][0] + a[1][r] * b[c][1] + a[2][r] * b[c][2] + a[3][r] * b[c][3];
            }
        }
        Self(out)
    }

    pub fn translation(t: Vec3) -> Self {
        let mut m = Self::IDENTITY;
        m.0[3] = [t.x, t.y, t.z, 1.0];
        m
    }

    pub fn scale_xyz(s: Vec3) -> Self {
        Self([[s.x, 0.0, 0.0, 0.0], [0.0, s.y, 0.0, 0.0], [0.0, 0.0, s.z, 0.0], [0.0, 0.0, 0.0, 1.0]])
    }

    pub fn rotation_x(rad: f32) -> Self {
        let (s, c) = rad.sin_cos();
        Self([[1.0, 0.0, 0.0, 0.0], [0.0, c, s, 0.0], [0.0, -s, c, 0.0], [0.0, 0.0, 0.0, 1.0]])
    }

    pub fn rotation_y(rad: f32) -> Self {
        let (s, c) = rad.sin_cos();
        Self([[c, 0.0, -s, 0.0], [0.0, 1.0, 0.0, 0.0], [s, 0.0, c, 0.0], [0.0, 0.0, 0.0, 1.0]])
    }

    pub fn rotation_z(rad: f32) -> Self {
        let (s, c) = rad.sin_cos();
        Self([[c, s, 0.0, 0.0], [-s, c, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]])
    }

    pub fn look_at(eye: Vec3, target: Vec3, up: Vec3) -> Self {
        let f = target.sub(eye).normalize();
        let s = f.cross(up).normalize();
        let u = s.cross(f);
        Self([
            [s.x, u.x, -f.x, 0.0],
            [s.y, u.y, -f.y, 0.0],
            [s.z, u.z, -f.z, 0.0],
            [-s.dot(eye), -u.dot(eye), f.dot(eye), 1.0],
        ])
    }

    /// Right-handed perspective matrix with Metal Z depth in [0, 1].
    pub fn perspective_metal(fovy_rad: f32, aspect: f32, near: f32, far: f32) -> Self {
        let f = 1.0 / (fovy_rad * 0.5).tan();
        let nf = 1.0 / (near - far);
        Self([
            [f / aspect.max(0.01), 0.0, 0.0, 0.0],
            [0.0, f, 0.0, 0.0],
            [0.0, 0.0, far * nf, -1.0],
            [0.0, 0.0, (far * near) * nf, 0.0],
        ])
    }

    /// Right-handed orthographic projection with Metal Z depth in [0, 1].
    pub fn ortho_metal(left: f32, right: f32, bottom: f32, top: f32, near: f32, far: f32) -> Self {
        let rml = 1.0 / (right - left);
        let tmb = 1.0 / (top - bottom);
        let fmn = 1.0 / (far - near);
        Self([
            [2.0 * rml, 0.0, 0.0, 0.0],
            [0.0, 2.0 * tmb, 0.0, 0.0],
            [0.0, 0.0, -fmn, 0.0],
            [-(right + left) * rml, -(top + bottom) * tmb, -near * fmn, 1.0],
        ])
    }

    pub fn transform_point(self, p: Vec3) -> Vec3 {
        let c = self.0;
        let x = c[0][0] * p.x + c[1][0] * p.y + c[2][0] * p.z + c[3][0];
        let y = c[0][1] * p.x + c[1][1] * p.y + c[2][1] * p.z + c[3][1];
        let z = c[0][2] * p.x + c[1][2] * p.y + c[2][2] * p.z + c[3][2];
        let w = c[0][3] * p.x + c[1][3] * p.y + c[2][3] * p.z + c[3][3];
        if w.abs() > 1e-6 { Vec3::new(x / w, y / w, z / w) } else { Vec3::new(x, y, z) }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Ray {
    pub origin: Vec3,
    pub dir: Vec3,
}

/// Ray vs ground-aligned / Y-rotated AABB intersection.
pub fn ray_box_hit(ray: Ray, center: Vec3, half_extents: Vec3, yaw_rad: f32) -> Option<f32> {
    // Rotate ray into local frame (-yaw around Y)
    let rel = ray.origin.sub(center);
    let (s, c) = (-yaw_rad).sin_cos();
    let ro = Vec3::new(rel.x * c + rel.z * s, rel.y, -rel.x * s + rel.z * c);
    let rd = Vec3::new(ray.dir.x * c + ray.dir.z * s, ray.dir.y, -ray.dir.x * s + ray.dir.z * c);

    let mut tmin = 0.0f32;
    let mut tmax = 250.0f32;
    for axis in 0..3 {
        let (o, d, h) = match axis {
            0 => (ro.x, rd.x, half_extents.x),
            1 => (ro.y, rd.y, half_extents.y),
            _ => (ro.z, rd.z, half_extents.z),
        };
        if d.abs() < 1e-6 {
            if o < -h || o > h {
                return None;
            }
        } else {
            let inv = 1.0 / d;
            let mut t1 = (-h - o) * inv;
            let mut t2 = (h - o) * inv;
            if t1 > t2 {
                std::mem::swap(&mut t1, &mut t2);
            }
            tmin = tmin.max(t1);
            tmax = tmax.min(t2);
            if tmin > tmax {
                return None;
            }
        }
    }
    Some(tmin)
}

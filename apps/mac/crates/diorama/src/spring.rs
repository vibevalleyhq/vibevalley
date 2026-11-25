/// Underdamped pop-up book hinge spring modeled after physical cardstock creases.
/// Value `0.0` = lying flat on the page (-90° around local X);
/// Value `1.0` = standing crisp and upright (0°); values > 1.0 are overshoot!
#[derive(Clone, Debug)]
pub struct FlapSpring {
    pub pos: f32,
    pub vel: f32,
    pub target: f32,
    pub delay: f32,
    pub stiffness: f32,
    pub damping: f32,
    pub sway_phase: f32,
    pub sway_amp: f32,
}

impl FlapSpring {
    pub fn new(initial: f32, sway_phase: f32, sway_amp: f32) -> Self {
        Self {
            pos: initial,
            vel: 0.0,
            target: initial,
            delay: 0.0,
            stiffness: 185.0,
            damping: 16.5,
            sway_phase,
            sway_amp,
        }
    }

    pub fn set_target(&mut self, target: f32, delay: f32) {
        self.target = target;
        self.delay = delay.max(0.0);
    }

    pub fn impulse(&mut self, kick: f32) {
        self.vel += kick;
    }

    pub fn fold_down_and_rise(&mut self, delay: f32) {
        self.pos = 0.0;
        self.vel = 0.0;
        self.target = 1.0;
        self.delay = delay.max(0.0);
    }

    pub fn is_moving(&self) -> bool {
        self.delay > 0.0 || (self.target - self.pos).abs() > 0.002 || self.vel.abs() > 0.004
    }

    pub fn step(&mut self, dt: f32) {
        let dt = dt.min(0.05);
        if self.delay > 0.0 {
            self.delay = (self.delay - dt).max(0.0);
            return;
        }
        // Semi-implicit Euler in substeps for rock-solid spring stability
        let sub = 2;
        let h = dt / sub as f32;
        for _ in 0..sub {
            let accel = (self.target - self.pos) * self.stiffness - self.vel * self.damping;
            self.vel += accel * h;
            self.pos += self.vel * h;
            if self.pos < 0.0 {
                self.pos = 0.0;
                if self.vel < 0.0 {
                    self.vel = -self.vel * 0.18;
                }
            }
        }
        if (self.target - self.pos).abs() < 0.0008 && self.vel.abs() < 0.002 {
            self.pos = self.target;
            self.vel = 0.0;
        }
    }

    /// Returns hinge X rotation (radians) around bottom edge `y = 0`.
    /// When `pos = 0`, rotated `-90 deg` (flat forward on ground).
    /// When `pos = 1`, `0 rad` + gentle breeze flutter when upright.
    pub fn hinge_angle(&self, elapsed: f32) -> f32 {
        let fold = (1.0 - self.pos) * -std::f32::consts::FRAC_PI_2;
        let breeze = if self.sway_amp > 0.0 && self.pos > 0.8 {
            ((elapsed * 2.1 + self.sway_phase).sin() * 0.7 + (elapsed * 3.8 + self.sway_phase * 1.7).sin() * 0.3)
                * self.sway_amp
                * ((self.pos - 0.8) / 0.2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        fold + breeze
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spring_rises_with_gentle_overshoot_and_settles() {
        let mut s = FlapSpring::new(0.0, 0.0, 0.0);
        s.set_target(1.0, 0.0);
        let mut peak = 0.0f32;
        for _ in 0..180 {
            s.step(1.0 / 60.0);
            peak = peak.max(s.pos);
        }
        assert!(peak > 1.02, "expected overshoot > 1.02, got {peak}");
        assert!((s.pos - 1.0).abs() < 0.01);
        assert!(!s.is_moving());
    }
}

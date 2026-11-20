//! The day clock, the sky's light and the whole-pixel framing: VibeValley's
//! `@vibevalley/engine` `clock.ts`, `pixi/sky.ts` (the flat-light part) and
//! `framing.ts`.

pub type Rgb = [f32; 3];

/// A day is 600 s and starts at 0.42, as the farm's `clock`.
pub struct DayClock {
    pub tod: f32,
    pub speed: f32,
    pub paused: bool,
    pub day_seconds: f32,
}

impl Default for DayClock {
    fn default() -> Self {
        DayClock {
            tod: 0.42,
            speed: 1.0,
            paused: false,
            day_seconds: 600.0,
        }
    }
}

fn wrap(t: f32) -> f32 {
    t.rem_euclid(1.0)
}

impl DayClock {
    pub fn advance(&mut self, seconds: f32) {
        if !self.paused && seconds > 0.0 {
            self.tod = wrap(self.tod + seconds * self.speed / self.day_seconds);
        }
    }
    pub fn set_time_of_day(&mut self, tod: f32) {
        self.tod = wrap(tod);
    }
    /// 0 pauses; anything else runs that many times faster than real time.
    pub fn set_speed(&mut self, speed: f32) {
        if speed <= 0.0 {
            self.paused = true;
        } else {
            self.paused = false;
            self.speed = speed;
        }
    }
}

fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let k = ((x - a) / (b - a)).clamp(0.0, 1.0);
    k * k * (3.0 - 2.0 * k)
}

/// 1 at full day, 0 at night. Sunrise around 06:00, sunset around 19:00.
pub fn sun_of(tod: f32) -> f32 {
    smooth(0.22, 0.3, tod) * (1.0 - smooth(0.76, 0.84, tod))
}

/// Peaks at sunrise and sunset.
pub fn dusk_of(tod: f32) -> f32 {
    let at = |c: f32| (1.0 - (tod - c).abs() / 0.06).max(0.0);
    at(0.26).max(at(0.8))
}

/// "HH:MM", the minutes in fives.
pub fn clock_text(tod: f32) -> String {
    let minutes = (wrap(tod) * 24.0 * 60.0).floor() as u32;
    let (h, m) = (minutes / 60, minutes % 60);
    format!("{h:02}:{:02}", m - m % 5)
}

pub struct Sky {
    pub clouds: f32,
    pub mist: f32,
    pub grade: vibevalley_pixel::Grade,
    pub ambient: Rgb,
    pub sun_dir: [f32; 3],
    pub sun: Rgb,
    pub night: f32,
}

const DAY_AMBIENT: Rgb = [0.62, 0.64, 0.68];
const DUSK_AMBIENT: Rgb = [0.66, 0.5, 0.46];
const NIGHT_AMBIENT: Rgb = [0.26, 0.32, 0.52];
const SUN: Rgb = [1.0, 0.96, 0.86];
const LOW_SUN: Rgb = [1.0, 0.62, 0.34];
const MOON: Rgb = [0.55, 0.68, 1.0];
const MOONLIGHT: f32 = 0.3;

fn normal(v: [f32; 3]) -> [f32; 3] {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if len == 0.0 { v } else { [v[0] / len, v[1] / len, v[2] / len] }
}
fn mix(a: Rgb, b: Rgb, k: f32) -> Rgb {
    [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}
fn scale(a: Rgb, k: f32) -> Rgb {
    [a[0] * k, a[1] * k, a[2] * k]
}

const DAY_GRADE: vibevalley_pixel::Grade = vibevalley_pixel::Grade {
    exposure: 1.06,
    saturation: 1.18,
    lift: 0.04,
    shadows: [0.02, 0.06, 0.1],
    highlights: [0.05, 0.035, -0.01],
    vignette: 0.16,
};
const DUSK_GRADE: vibevalley_pixel::Grade = vibevalley_pixel::Grade {
    exposure: 1.06,
    saturation: 1.22,
    lift: 0.05,
    shadows: [0.14, 0.05, 0.02],
    highlights: [0.1, 0.04, -0.05],
    vignette: 0.22,
};
const NIGHT_GRADE: vibevalley_pixel::Grade = vibevalley_pixel::Grade {
    exposure: 1.08,
    saturation: 1.2,
    lift: 0.045,
    shadows: [0.01, 0.05, 0.14],
    highlights: [0.03, 0.05, 0.06],
    vignette: 0.3,
};

pub fn sky_at(tod: f32) -> Sky {
    let day = sun_of(tod);
    let dusk = dusk_of(tod);
    let crossed = ((tod - 0.25) / 0.5).clamp(0.0, 1.0);
    let pi = std::f32::consts::PI;
    let sun_dir = normal([-(pi * crossed).cos(), -0.5, 0.2 + 0.8 * (pi * crossed).sin()]);
    let day_ambient = mix(DAY_AMBIENT, DUSK_AMBIENT, dusk);
    let avg = (day_ambient[0] + day_ambient[1] + day_ambient[2]) / 3.0;
    let gain = (1.0 - avg) / sun_dir[2].max(0.3);
    let sun_color = scale(mix(SUN, LOW_SUN, dusk), gain);
    let moon_dir = normal([0.35, -0.55, 0.75]);
    Sky {
        clouds: 0.22 * day,
        mist: 0.3 * (1. - (tod - 0.29).abs() / 0.07).max(0.),
        grade: NIGHT_GRADE.mix(DAY_GRADE.mix(DUSK_GRADE, dusk), day),
        ambient: mix(NIGHT_AMBIENT, day_ambient, day),
        sun_dir: normal(mix(moon_dir, sun_dir, day)),
        sun: mix(scale(MOON, MOONLIGHT), sun_color, day),
        night: 1.0 - day,
    }
}

/// How bright flat ground comes out under a sky: the ambient and the sun straight on.
pub fn flat_light(sky: &Sky) -> Rgb {
    [
        sky.ambient[0] + sky.sun[0] * sky.sun_dir[2],
        sky.ambient[1] + sky.sun[1] * sky.sun_dir[2],
        sky.ambient[2] + sky.sun[2] * sky.sun_dir[2],
    ]
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Framing {
    /// View pixels per art pixel.
    pub scale: f32,
    /// The whole picture in view pixels; may stick out past the view.
    pub bx: Rect,
    /// The part of `bx` inside the view.
    pub shown: Rect,
}

/// The farm's cut: at most 5% off each side, 8% off the top and bottom.
pub const FARM_CUT: (f32, f32) = (0.05, 0.08);

fn round_away(v: f32) -> f32 {
    v.signum() * v.abs().round()
}

pub fn fit_framing(view: (f32, f32), picture: (f32, f32)) -> Framing {
    let fits = (view.0 / picture.0).min(view.1 / picture.1);
    let scale = if fits >= 1.0 { (fits * 2.0).floor() / 2.0 } else { fits.max(0.1) };
    let (w, h) = (picture.0 * scale, picture.1 * scale);
    let bx = Rect {
        x: ((view.0 - w) / 2.0).round(),
        y: ((view.1 - h) / 2.0).round(),
        w,
        h,
    };
    Framing { scale, bx, shown: bx }
}

/// Fills `view` edge-to-edge while keeping crop within `cut` (fraction off each side);
/// beyond that aspect ratio, clamps the scale so landmarks stay visible.
pub fn frame_cover(view: (f32, f32), picture: (f32, f32), cut: (f32, f32)) -> Framing {
    let pw = picture.0.max(1.0);
    let ph = picture.1.max(1.0);
    let cover = (view.0 / pw).max(view.1 / ph);
    let max_x = view.0 / (pw * (1.0 - 2.0 * cut.0).max(0.1));
    let max_y = view.1 / (ph * (1.0 - 2.0 * cut.1).max(0.1));
    let scale = cover.min(max_x).min(max_y).max(0.1);
    let raw_w = pw * scale;
    let raw_h = ph * scale;
    let w = if raw_w >= view.0 - 0.5 { raw_w.ceil().max(view.0) } else { raw_w.round() };
    let h = if raw_h >= view.1 - 0.5 { raw_h.ceil().max(view.1) } else { raw_h.round() };
    let bx = Rect {
        x: round_away((view.0 - w) / 2.0),
        y: round_away((view.1 - h) / 2.0),
        w,
        h,
    };
    let (x0, y0) = (bx.x.max(0.0), bx.y.max(0.0));
    let (x1, y1) = (view.0.min(bx.x + w), view.1.min(bx.y + h));
    Framing {
        scale,
        bx,
        shown: Rect {
            x: x0,
            y: y0,
            w: (x1 - x0).max(0.0),
            h: (y1 - y0).max(0.0),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_covers_standard_panes_and_clamps_extreme_cuts() {
        // 16:10 and 16:9 panes stay within FARM_CUT and fill edge-to-edge with no margins.
        for view in [(1280.0, 820.0), (1278.0, 848.0), (1440.0, 900.0), (1600.0, 900.0)] {
            let f = frame_cover(view, (384.0, 256.0), FARM_CUT);
            assert_eq!(
                f.shown,
                Rect {
                    x: 0.0,
                    y: 0.0,
                    w: view.0,
                    h: view.1
                },
                "{view:?}: {f:?}"
            );
            assert!((f.bx.w - view.0) / 2.0 <= f.bx.w * FARM_CUT.0 + 1.0);
            assert!((f.bx.h - view.1) / 2.0 <= f.bx.h * FARM_CUT.1 + 1.0);
        }
        // Narrow portrait pane clamps horizontal crop to 5% per side instead of chopping buildings.
        let narrow = frame_cover((568.0, 720.0), (384.0, 256.0), FARM_CUT);
        assert!((narrow.bx.w - 568.0) / 2.0 <= narrow.bx.w * FARM_CUT.0 + 1.0);
        assert!(narrow.bx.y > 0.0);
    }

    #[test]
    fn day_and_night() {
        assert!(sky_at(0.5).night < 0.01);
        assert!(sky_at(0.0).night > 0.99);
        assert_eq!(clock_text(0.5), "12:00");
        let mut c = DayClock::default();
        c.set_speed(60.0);
        c.advance(10.0);
        assert!((c.tod - 0.42).abs() < 1e-5);
    }
}

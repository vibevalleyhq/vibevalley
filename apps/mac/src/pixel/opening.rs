//! The opening: VibeValley's `public/opening.html` — the scene of the hour
//! (morning 5–10, day 10–18, night), the brand, a loading bar with the
//! running sprite whose mood follows the phase, and the phase's words.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use image::RgbaImage;
use parking_lot::Mutex;

use super::draw::{DrawList, HudOp, Op, rgba};
use super::nav::frame_at;

/// What the app is doing while the opening shows (`Opening["phase"]`, the words VibeValley's zh strings say).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Starting,
    Connecting,
    Reading,
    Loading,
    Ready,
    Failed,
}

impl Phase {
    pub fn words(self) -> &'static str {
        match self {
            Phase::Starting => "正在叫醒农场…",
            Phase::Connecting => "正在接通农场…",
            Phase::Reading => "正在读农场的账…",
            Phase::Loading => "正在摆好院子…",
            Phase::Ready => "到了",
            Phase::Failed => "农场没能开起来",
        }
    }
}

pub struct OpeningScene {
    scene: Option<Arc<RgbaImage>>,
    frames: Vec<Arc<RgbaImage>>,
    pub which: &'static str,
    pub phase: Phase,
    pub progress: f32,
    shown: f32,
    t: f32,
    fade: Arc<RgbaImage>,
    /// Shown as a pane (not over the starting app): the bar runs on its own.
    pub demo: bool,
}

/// The scene picture's size in this scene's pixels (a quarter of the 1672×941 painting).
const W: f32 = 418.0;
const H: f32 = 235.25;

pub fn scene_of_hour(hour: u32) -> &'static str {
    match hour {
        5..=9 => "morning",
        10..=17 => "day",
        _ => "night",
    }
}

fn local_hour() -> u32 {
    let out = std::process::Command::new("date").arg("+%H").output().ok();
    out.and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok()).unwrap_or(12)
}

#[derive(Clone)]
struct OpeningArt {
    scene: Option<Arc<RgbaImage>>,
    frames: Vec<Arc<RgbaImage>>,
    fade: Arc<RgbaImage>,
}

fn opening_art_cache() -> &'static Mutex<HashMap<(PathBuf, &'static str), OpeningArt>> {
    static CACHE: OnceLock<Mutex<HashMap<(PathBuf, &'static str), OpeningArt>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

impl OpeningScene {
    /// Blocking on cold miss: decodes the pictures and caches them process-wide.
    pub fn load(which: Option<&'static str>) -> OpeningScene {
        let which = which.unwrap_or_else(|| scene_of_hour(local_hour()));
        let dir = super::assets_dir().join("brand");
        let key = (dir.clone(), which);
        if let Some(art) = opening_art_cache().lock().get(&key).cloned() {
            return OpeningScene {
                fade: art.fade,
                scene: art.scene,
                frames: art.frames,
                which,
                phase: Phase::Starting,
                progress: 0.0,
                shown: 0.0,
                t: 0.0,
                demo: false,
            };
        }
        let scene = super::atlas::decode(&dir.join(format!("opening-{which}.webp"))).map(Arc::new);
        // The sprite sheet holds five moods side by side; the bar shows a 80×96 window of each, centred.
        let frames: Vec<Arc<RgbaImage>> = super::atlas::decode(&dir.join("opening-sprite.webp"))
            .map(|sheet| {
                let fw = sheet.width() / 5;
                let fh = (fw as f32 * 96.0 / 80.0) as u32;
                let top = sheet.height().saturating_sub(fh) / 2;
                (0..5)
                    .map(|i| Arc::new(image::imageops::crop_imm(&sheet, i * fw, top, fw, fh.min(sheet.height())).to_image()))
                    .collect()
            })
            .unwrap_or_default();
        // opening.html's `linear-gradient(180deg, transparent 40%, #15141344 65%, #151413dd)`, from 40% down.
        let fade = Arc::new(RgbaImage::from_fn(1, 96, |_, y| {
            let k = y as f32 / 95.0;
            let a = if k < 0.4167 {
                k / 0.4167 * 0x44 as f32
            } else {
                0x44 as f32 + (k - 0.4167) / 0.5833 * (0xdd - 0x44) as f32
            };
            image::Rgba([0x15, 0x14, 0x13, a as u8])
        }));
        opening_art_cache().lock().insert(
            key,
            OpeningArt {
                scene: scene.clone(),
                frames: frames.clone(),
                fade: fade.clone(),
            },
        );
        OpeningScene {
            fade,
            scene,
            frames,
            which,
            phase: Phase::Starting,
            progress: 0.0,
            shown: 0.0,
            t: 0.0,
            demo: false,
        }
    }

    pub fn tick(&mut self, dt: f32) {
        self.t += dt.min(0.1);
        if self.demo {
            self.progress = (self.t * 12.0) % 120.0;
            self.phase = match self.progress as u32 {
                0..10 => Phase::Starting,
                10..30 => Phase::Connecting,
                30..50 => Phase::Reading,
                50..100 => Phase::Loading,
                _ => Phase::Ready,
            };
        }
        let target = if self.phase == Phase::Ready { 100.0 } else { self.progress.min(100.0) };
        self.shown += (target - self.shown) * (dt * 6.0).min(1.0);
    }

    fn mood(&self) -> usize {
        match self.phase {
            Phase::Failed => 4,
            Phase::Ready => 3,
            _ if self.shown >= 70.0 => 2,
            _ if self.shown > 0.5 => 1,
            _ => 0,
        }
    }

    pub fn draw(&self) -> DrawList {
        let mut list = DrawList::new(W, H, rgba(0x151413, 1.0));
        if let Some(scene) = &self.scene {
            list.ops.push(Op::Image {
                key: format!("opening-{}", self.which),
                image: scene.clone(),
                x: 0.0,
                y: 0.0,
                w: W,
                h: H,
                alpha: 1.0,
            });
        }
        // The fade to the ground colour under the words.
        list.ops.push(Op::Image {
            key: "opening-fade".into(),
            image: self.fade.clone(),
            x: 0.0,
            y: H * 0.4,
            w: W,
            h: H * 0.6,
            alpha: 1.0,
        });
        // HUD in view pixels around the picture's bottom centre; the element centres the picture.
        let cream = rgba(0xf7e8c4, 1.0);
        let shadow = rgba(0x2f1f13, 1.0);
        list.hud_center = true;
        let bar_w = 400.0;
        list.hud.push(HudOp::Text {
            x: -bar_w / 2.0 + 3.0 + 70.0,
            y: -190.0 + 3.0,
            text: "VibeValley".into(),
            size: 48.0,
            color: shadow,
        });
        list.hud.push(HudOp::Text {
            x: -bar_w / 2.0 + 70.0,
            y: -190.0,
            text: "VibeValley".into(),
            size: 48.0,
            color: cream,
        });
        let (bx, by) = (-bar_w / 2.0, -90.0);
        list.hud.push(HudOp::Rect {
            x: bx - 2.0,
            y: by - 2.0,
            w: bar_w + 4.0,
            h: 24.0,
            color: rgba(0xeedcb2, 1.0),
            border: None,
        });
        list.hud.push(HudOp::Rect {
            x: bx,
            y: by,
            w: bar_w,
            h: 20.0,
            color: rgba(0x292f20, 1.0),
            border: Some(shadow),
        });
        let fill = (bar_w - 6.0) * self.shown / 100.0;
        list.hud.push(HudOp::Rect {
            x: bx + 3.0,
            y: by + 3.0,
            w: fill,
            h: 14.0,
            color: rgba(0xa4c66c, 1.0),
            border: None,
        });
        let mut x = bx + 3.0 + 8.0;
        while x < bx + 3.0 + fill {
            list.hud.push(HudOp::Rect {
                x,
                y: by + 3.0,
                w: 2.0,
                h: 14.0,
                color: rgba(0x86ad50, 1.0),
                border: None,
            });
            x += 10.0;
        }
        if let Some(frame) = self.frames.get(self.mood()) {
            let hop = match self.mood() {
                0 => frame_at(self.t, 2, 1.4) as f32 * 2.0,
                1 => -(frame_at(self.t, 2, 4.0) as f32) * 3.0,
                2 => -(frame_at(self.t, 2, 5.7) as f32) * 3.0,
                _ => 0.0,
            };
            let sx = (bx + 3.0 + fill).clamp(bx + 32.0, bx + bar_w - 32.0);
            list.hud_images.push((
                format!("opening-mood-{}", self.mood()),
                frame.clone(),
                sx - 40.0,
                by - 96.0 - 10.0 + 20.0 + hop,
                80.0,
                96.0,
            ));
        }
        let words = self.phase.words();
        let width = words.chars().count() as f32 * 12.0;
        list.hud.push(HudOp::Text {
            x: -width / 2.0,
            y: by + 34.0,
            text: words.into(),
            size: 12.0,
            color: cream,
        });
        list
    }

    pub fn debug_state(&self) -> serde_json::Value {
        serde_json::json!({
            "scene": self.which, "phase": format!("{:?}", self.phase), "progress": self.progress, "shown": self.shown,
            "mood": self.mood(), "pictures": self.scene.is_some(), "frames": self.frames.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scene_follows_the_hour() {
        assert_eq!(scene_of_hour(6), "morning");
        assert_eq!(scene_of_hour(12), "day");
        assert_eq!(scene_of_hour(22), "night");
        assert_eq!(scene_of_hour(3), "night");
    }
}

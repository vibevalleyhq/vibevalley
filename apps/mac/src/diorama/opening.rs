//! Papertrails launch splash screen rendered directly via GPUI over
//! `assets/brand/opening-{morning,day,night}.webp`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Instant;

use gpui::{
    Context, FocusHandle, Focusable, InteractiveElement as _, IntoElement, ObjectFit, ParentElement as _, Render, RenderImage, Styled as _, StyledImage as _,
    Window, div, img, px, relative,
};
use parking_lot::Mutex;
use smallvec::SmallVec;

/// Boot phases displayed while the embedded server and workbench initialize.
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

pub fn scene_of_hour(hour: u32) -> &'static str {
    match hour {
        5..=9 => "morning",
        10..=17 => "day",
        _ => "night",
    }
}

fn local_hour() -> u32 {
    u32::try_from(jiff::ZonedDateTime::now().hour()).unwrap_or(12)
}

pub fn opening_image_path(assets_dir: &Path, which: &str) -> PathBuf {
    assets_dir.join("brand").join(format!("opening-{which}.webp"))
}

struct OpeningArt {
    image: Option<Arc<RenderImage>>,
}

type OpeningArtCache = HashMap<(PathBuf, &'static str), Weak<OpeningArt>>;

fn opening_art_cache() -> &'static Mutex<OpeningArtCache> {
    static CACHE: OnceLock<Mutex<OpeningArtCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn prune_dead_art_cache() {
    opening_art_cache().lock().retain(|_, weak| weak.strong_count() > 0);
}

fn decode_render_image(path: &Path) -> Option<Arc<RenderImage>> {
    let mut rgba = image::open(path).ok()?.into_rgba8();
    for px in rgba.pixels_mut() {
        px.0.swap(0, 2);
    }
    Some(Arc::new(RenderImage::new(SmallVec::from_elem(image::Frame::new(rgba), 1))))
}

fn load_opening_art(which: &'static str) -> Arc<OpeningArt> {
    let dir = crate::assets::assets_dir();
    let key = (dir.clone(), which);
    if let Some(art) = opening_art_cache().lock().get(&key).and_then(Weak::upgrade) {
        return art;
    }
    let image = decode_render_image(&opening_image_path(&dir, which));
    let art = Arc::new(OpeningArt { image });
    opening_art_cache().lock().insert(key, Arc::downgrade(&art));
    art
}

pub struct OpeningView {
    art: Option<Arc<OpeningArt>>,
    pub phase: Phase,
    pub progress: f32,
    shown: f32,
    last_tick: Instant,
    focus: FocusHandle,
}

impl Drop for OpeningView {
    fn drop(&mut self) {
        // Release our strong handle before pruning so the weak cache frees decoded splash buffers immediately.
        drop(self.art.take());
        prune_dead_art_cache();
    }
}

impl Focusable for OpeningView {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus.clone()
    }
}

impl OpeningView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let which = scene_of_hour(local_hour());
        let task = cx.background_executor().spawn(async move { load_opening_art(which) });
        cx.spawn(async move |this, cx| {
            let art = task.await;
            let _ = this.update(cx, |view, cx| {
                view.art = Some(art);
                cx.notify();
            });
        })
        .detach();
        Self {
            art: None,
            phase: Phase::Starting,
            progress: 12.0,
            shown: 0.0,
            last_tick: Instant::now(),
            focus: cx.focus_handle(),
        }
    }

    pub fn set_phase(&mut self, phase: Phase, progress: f32) {
        self.phase = phase;
        self.progress = progress.clamp(0.0, 100.0);
    }

    fn step(&mut self) -> bool {
        let now = Instant::now();
        let dt = now.duration_since(self.last_tick).as_secs_f32().clamp(0.0, 0.1);
        self.last_tick = now;
        let target = if self.phase == Phase::Ready { 100.0 } else { self.progress.clamp(0.0, 100.0) };
        let delta = target - self.shown;
        if delta.abs() < 0.25 {
            self.shown = target;
            false
        } else {
            self.shown += delta * (dt * 8.0).min(1.0);
            true
        }
    }
}

impl Render for OpeningView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let allow_animation = cx
            .try_global::<crate::theme::Ui>()
            .is_none_or(|ui| ui.settings.effective_motion() != crate::theme::MotionChoice::Off);
        if allow_animation && self.step() && window.is_window_active() {
            window.request_animation_frame();
        } else if !allow_animation {
            self.shown = if self.phase == Phase::Ready { 100.0 } else { self.progress.clamp(0.0, 100.0) };
        }

        let backdrop = self
            .art
            .as_ref()
            .and_then(|a| a.image.clone())
            .map(|image| img(image).size_full().object_fit(ObjectFit::Cover));

        let fill_color = if self.phase == Phase::Failed {
            gpui::rgb(0xc84a3a)
        } else {
            gpui::rgb(0x74a046)
        };
        let fill_ratio = (self.shown / 100.0).clamp(0.0, 1.0);

        div()
            .id("opening-splash")
            .relative()
            .size_full()
            .overflow_hidden()
            .bg(gpui::rgb(0x211b15))
            .children(backdrop)
            // Soft bottom walnut veil so Papertrails cream typography stays legible on morning, day, and night artwork.
            .child(div().absolute().left_0().right_0().bottom_0().h(px(260.0)).bg(gpui::rgba(0x1f1711b8)))
            .child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom(px(56.0))
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(14.0))
                    .child(
                        div()
                            .text_size(px(34.0))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(gpui::rgb(0xfbf7ee))
                            .child("VibeValley"),
                    )
                    .child(
                        div()
                            .w(px(320.0))
                            .h(px(10.0))
                            .p(px(2.0))
                            .rounded_full()
                            .bg(gpui::rgba(0x2f1f13cc))
                            .border_1()
                            .border_color(gpui::rgba(0xf7e8c466))
                            .child(div().h_full().w(relative(fill_ratio)).rounded_full().bg(fill_color)),
                    )
                    .child(div().text_size(px(12.5)).text_color(gpui::rgb(0xf7e8c4)).child(self.phase.words())),
            )
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
        assert!(local_hour() < 24);
    }

    #[test]
    fn opening_art_cache_shares_while_open_and_evicts_on_close() {
        let dir = crate::assets::assets_dir();
        for variant in ["morning", "day", "night"] {
            assert!(
                opening_image_path(&dir, variant).is_file(),
                "expected Papertrails opening artwork for {variant}"
            );
        }
        let first = load_opening_art("day");
        assert!(first.image.is_some(), "opening-day.webp should decode into RenderImage");
        let weak = Arc::downgrade(&first);
        {
            let second = load_opening_art("day");
            assert!(Arc::ptr_eq(&first, &second));
        }
        assert!(weak.upgrade().is_some(), "art remains live while splash handle is held");
        drop(first);
        prune_dead_art_cache();
        assert!(weak.upgrade().is_none(), "opening splash buffers must be freed once overlay closes");
        assert!(
            !opening_art_cache().lock().contains_key(&(dir, "day")),
            "dead weak cache entry should be pruned on drop"
        );
    }
}

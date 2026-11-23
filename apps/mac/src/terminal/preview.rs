use std::path::{Path, PathBuf};
use std::time::Duration;

use gpui::{
    AnyElement, InteractiveElement as _, IntoElement as _, ObjectFit, ParentElement as _, Pixels, Point, Styled as _, StyledImage as _, div, img, point, px,
};
use vibevalley_terminal::LinkSpan;

use super::element::{self, Geometry};
use crate::theme::Palette;

pub(crate) const PREVIEW_W: f32 = 280.0;
pub(crate) const PREVIEW_H: f32 = 224.0;
pub(crate) const HOVER_DEBOUNCE: Duration = Duration::from_millis(150);

/// Caps probed files so giant or corrupt inputs never stall GPUI's image decoder.
pub(crate) const MAX_PREVIEW_BYTES: u64 = 25 * 1024 * 1024;

const POPOVER_MARGIN: f32 = 8.0;
const POPOVER_GAP: f32 = 8.0;
const POPOVER_FLIP_CLEARANCE: f32 = 12.0;

// Kept aligned with `IMAGE_EXTENSIONS` in `crates/files/src/load.rs`.
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "tif", "tiff", "heic", "heif", "avif", "svg",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreviewMeta {
    pub path: PathBuf,
    pub filename: String,
    pub size_bytes: u64,
    pub dimensions: Option<(u32, u32)>,
}

pub(crate) type ImagePreview = PreviewMeta;

pub(crate) fn is_previewable_image(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| IMAGE_EXTENSIONS.iter().any(|candidate| ext.eq_ignore_ascii_case(candidate)))
}

fn is_svg(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("svg"))
}

/// Runs on a background thread; reads only file metadata and raster headers,
/// never decoding pixel buffers.
pub(crate) fn probe_image_meta(path: &Path) -> Option<PreviewMeta> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let size_bytes = metadata.len();
    if size_bytes == 0 || size_bytes > MAX_PREVIEW_BYTES {
        return None;
    }
    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())?;
    let dimensions = if is_svg(path) { None } else { image::image_dimensions(path).ok() };
    Some(PreviewMeta {
        path: path.to_path_buf(),
        filename,
        size_bytes,
        dimensions,
    })
}

pub(crate) fn format_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * 1024;
    if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= 10 * KB {
        format!("{} KB", (bytes + KB / 2) / KB)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{bytes} B")
    }
}

pub(crate) fn format_meta_line(dimensions: Option<(u32, u32)>, size_bytes: u64) -> String {
    let size = format_bytes(size_bytes);
    match dimensions {
        Some((w, h)) => format!("{w} × {h} · {size}"),
        None => size,
    }
}

pub(crate) fn compute_popover_position(geometry: &Geometry, span: LinkSpan, card_w: f32, card_h: f32) -> Point<Pixels> {
    let cell_w = f32::from(geometry.cell_width);
    let line_h = f32::from(geometry.line_height);
    let viewport_w = geometry.size.cols as f32 * cell_w + element::PADDING * 2.0;
    let viewport_h = geometry.size.rows as f32 * line_h + element::PADDING * 2.0;

    let start_col = span.start_col.min(geometry.size.cols);
    let end_col = span.end_col.min(geometry.size.cols).max(start_col);
    let row = span.row.min(geometry.size.rows.saturating_sub(1));

    let span_left = element::PADDING + start_col as f32 * cell_w;
    let span_right = element::PADDING + end_col as f32 * cell_w;
    let center_x = (span_left + span_right) * 0.5;

    let max_x = (viewport_w - card_w - POPOVER_MARGIN).max(POPOVER_MARGIN);
    let x = (center_x - card_w * 0.5).clamp(POPOVER_MARGIN, max_x);

    let row_top = element::PADDING + row as f32 * line_h;
    let row_bottom = row_top + line_h;

    let max_y = (viewport_h - card_h - POPOVER_MARGIN).max(POPOVER_MARGIN);
    let raw_y = if row_top < card_h + POPOVER_FLIP_CLEARANCE {
        row_bottom + POPOVER_GAP
    } else {
        row_top - card_h - POPOVER_GAP
    };
    let y = raw_y.clamp(POPOVER_MARGIN, max_y);

    point(px(x), px(y))
}

pub(crate) fn render_popover(meta: &PreviewMeta, geometry: &Geometry, span: LinkSpan, colors: &Palette) -> AnyElement {
    let pos = compute_popover_position(geometry, span, PREVIEW_W, PREVIEW_H);
    let meta_line = format_meta_line(meta.dimensions, meta.size_bytes);

    div()
        .id("terminal-image-preview")
        .absolute()
        .left(pos.x)
        .top(pos.y)
        .w(px(PREVIEW_W))
        .h(px(PREVIEW_H))
        .p(px(7.0))
        .flex()
        .flex_col()
        .gap(px(6.0))
        .bg(colors.elevated)
        .border_1()
        .border_color(colors.border)
        .rounded(px(8.0))
        .shadow_lg()
        .child(
            div()
                .w(px(264.0))
                .h(px(172.0))
                .rounded(px(6.0))
                .bg(colors.surface)
                .flex()
                .items_center()
                .justify_center()
                .overflow_hidden()
                .child(img(meta.path.clone()).max_w(px(256.0)).max_h(px(164.0)).object_fit(ObjectFit::Contain)),
        )
        .child(
            div()
                .w_full()
                .flex_1()
                .min_h_0()
                .px(px(2.0))
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .text_xs()
                        .text_color(colors.text)
                        .child(meta.filename.clone()),
                )
                .child(div().flex_shrink_0().whitespace_nowrap().text_xs().text_color(colors.muted).child(meta_line)),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};

    use vibevalley_terminal::TermSize;

    use super::*;

    fn sample_geometry(cols: u16, rows: u16) -> Geometry {
        Geometry {
            origin: point(px(element::PADDING), px(element::PADDING)),
            cell_width: px(8.0),
            line_height: px(16.0),
            size: TermSize {
                cols,
                rows,
                cell_width_px: 8,
                cell_height_px: 16,
            },
        }
    }

    #[test]
    fn is_previewable_image_matches_supported_extensions_case_insensitively() {
        for path in [
            "photo.png",
            "assets/hero.PNG",
            "dir/shot.jpg",
            "dir/shot.JPEG",
            "banner.webp",
            "anim.Gif",
            "bitmap.bmp",
            "favicon.ico",
            "app.icns",
            "scan.tif",
            "scan.TIFF",
            "camera.heic",
            "camera.heif",
            "modern.avif",
            "icons/logo.svg",
            "icons/LOGO.SVG",
        ] {
            assert!(is_previewable_image(Path::new(path)), "expected image: {path}");
        }
        for path in ["src/main.rs", "README.md", "Cargo.toml", "Makefile", ".png", "dir/noext", "archive.tar.gz", ""] {
            assert!(!is_previewable_image(Path::new(path)), "expected non-image: {path}");
        }
    }

    #[test]
    fn formats_bytes_and_meta_lines() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1023), "1023 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(142 * 1024), "142 KB");
        assert_eq!(format_bytes(1024 * 1024), "1.0 MB");
        assert_eq!(format_bytes(2 * 1024 * 1024 + 512 * 1024), "2.5 MB");

        assert_eq!(format_meta_line(Some((1280, 720)), 142 * 1024), "1280 × 720 · 142 KB");
        assert_eq!(format_meta_line(None, 4096), "4.0 KB");
    }

    #[test]
    fn compute_popover_position_handles_above_flip_clamping_and_narrow_viewports() {
        let g = sample_geometry(100, 40);
        let viewport_w = 100.0 * 8.0 + element::PADDING * 2.0;

        let above = compute_popover_position(
            &g,
            LinkSpan {
                row: 20,
                start_col: 30,
                end_col: 50,
            },
            PREVIEW_W,
            PREVIEW_H,
        );
        let expected_row_top = element::PADDING + 20.0 * 16.0;
        let expected_center_x = element::PADDING + 40.0 * 8.0;
        assert_eq!(above.x, px(expected_center_x - PREVIEW_W * 0.5));
        assert_eq!(above.y, px(expected_row_top - PREVIEW_H - POPOVER_GAP));

        let below = compute_popover_position(
            &g,
            LinkSpan {
                row: 2,
                start_col: 30,
                end_col: 50,
            },
            PREVIEW_W,
            PREVIEW_H,
        );
        let top_row_bottom = element::PADDING + 3.0 * 16.0;
        assert_eq!(below.y, px(top_row_bottom + POPOVER_GAP));

        let left_clamped = compute_popover_position(
            &g,
            LinkSpan {
                row: 20,
                start_col: 0,
                end_col: 6,
            },
            PREVIEW_W,
            PREVIEW_H,
        );
        assert_eq!(left_clamped.x, px(POPOVER_MARGIN));

        let right_clamped = compute_popover_position(
            &g,
            LinkSpan {
                row: 20,
                start_col: 92,
                end_col: 100,
            },
            PREVIEW_W,
            PREVIEW_H,
        );
        assert_eq!(right_clamped.x, px(viewport_w - PREVIEW_W - POPOVER_MARGIN));

        let short = sample_geometry(100, 15);
        let short_viewport_h = 15.0 * 16.0 + element::PADDING * 2.0;
        let bottom_clamped = compute_popover_position(
            &short,
            LinkSpan {
                row: 12,
                start_col: 30,
                end_col: 50,
            },
            PREVIEW_W,
            PREVIEW_H,
        );
        assert_eq!(bottom_clamped.y, px(short_viewport_h - PREVIEW_H - POPOVER_MARGIN));

        let tiny = sample_geometry(20, 8);
        let clamped_tiny = compute_popover_position(
            &tiny,
            LinkSpan {
                row: 4,
                start_col: 2,
                end_col: 10,
            },
            PREVIEW_W,
            PREVIEW_H,
        );
        assert_eq!(clamped_tiny, point(px(POPOVER_MARGIN), px(POPOVER_MARGIN)));
    }

    #[test]
    fn probe_image_meta_reads_png_dimensions_and_rejects_invalid_targets() {
        let dir = tempfile::tempdir().unwrap();

        let png_path = dir.path().join("sample.png");
        let img_buf = image::RgbaImage::new(32, 16);
        img_buf.save(&png_path).unwrap();
        let expected_len = fs::metadata(&png_path).unwrap().len();
        let meta = probe_image_meta(&png_path).expect("valid png metadata");
        assert_eq!(
            meta,
            PreviewMeta {
                path: png_path,
                filename: "sample.png".into(),
                size_bytes: expected_len,
                dimensions: Some((32, 16)),
            }
        );

        let svg_path = dir.path().join("icon.svg");
        fs::write(&svg_path, b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>").unwrap();
        let svg_meta = probe_image_meta(&svg_path).expect("valid svg metadata");
        assert_eq!(svg_meta.dimensions, None);
        assert_eq!(svg_meta.filename, "icon.svg");
        assert!(svg_meta.size_bytes > 0);

        assert_eq!(probe_image_meta(&dir.path().join("missing.png")), None);

        let empty_path = dir.path().join("empty.png");
        File::create(&empty_path).unwrap();
        assert_eq!(probe_image_meta(&empty_path), None);

        let dir_as_png = dir.path().join("folder.png");
        fs::create_dir(&dir_as_png).unwrap();
        assert_eq!(probe_image_meta(&dir_as_png), None);

        let oversized_path = dir.path().join("huge.png");
        let oversized = File::create(&oversized_path).unwrap();
        oversized.set_len(MAX_PREVIEW_BYTES + 1).unwrap();
        assert_eq!(probe_image_meta(&oversized_path), None);
    }
}

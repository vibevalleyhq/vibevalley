use std::sync::OnceLock;

use unicode_width::UnicodeWidthStr;

pub(super) fn bytes() -> Option<&'static [u8]> {
    static FONT: OnceLock<Option<Vec<u8>>> = OnceLock::new();
    FONT.get_or_init(|| std::fs::read(super::assets_dir().join("fonts/fusion-pixel-12px-proportional-zh_hans.otf")).ok())
        .as_deref()
}

pub(super) fn width(text: &str, size: f32) -> f32 {
    static FACE: OnceLock<Option<rustybuzz::Face<'static>>> = OnceLock::new();
    let Some(face) = FACE.get_or_init(|| rustybuzz::Face::from_slice(bytes()?, 0)) else {
        return text.width() as f32 * size * 0.5;
    };
    let mut buffer = rustybuzz::UnicodeBuffer::new();
    buffer.push_str(text);
    buffer.guess_segment_properties();
    let line = rustybuzz::shape(face, &[], buffer);
    let advance: i32 = line.glyph_positions().iter().map(|pos| pos.x_advance).sum();
    advance as f32 * size / face.units_per_em() as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn regression_farm_pins_measure_the_proportional_font() {
        assert_eq!(width("parity", 12.), 32.);
        assert_eq!(width("Lv.5 开垦", 12.), 50.);
        assert_eq!(width("Lv.12 开垦", 12.), 56.);
    }
}

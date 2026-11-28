//! Pure-Rust key and mouse protocol encoders for `alacritty_terminal`.

use std::fmt::Write as _;

use alacritty_terminal::term::TermMode;

use crate::{Key, KeyInput, Mods, MouseButton, MouseInput, MouseKind, Point, TermSize};

pub(crate) struct Input {
    pressed: Vec<MouseButton>,
    last_cell: Option<Point>,
    pub option_as_alt: bool,
}

impl Input {
    pub(crate) fn new() -> Self {
        Self {
            pressed: Vec::new(),
            last_cell: None,
            option_as_alt: true,
        }
    }

    pub(crate) fn encode_key(&mut self, mode: TermMode, input: &KeyInput) -> Vec<u8> {
        let kitty_disambiguate = mode.contains(TermMode::DISAMBIGUATE_ESC_CODES);
        let kitty_all = mode.contains(TermMode::REPORT_ALL_KEYS_AS_ESC);
        if (kitty_disambiguate || kitty_all)
            && let Some(bytes) = encode_kitty_key(mode, input, self.option_as_alt)
        {
            return bytes;
        }
        encode_legacy_key(mode, input, self.option_as_alt)
    }

    /// Encodes a mouse event for the program, or nothing when it did not ask
    /// for mouse reporting.
    pub(crate) fn encode_mouse(&mut self, mode: TermMode, size: TermSize, input: MouseInput) -> Vec<u8> {
        let mut out = Vec::new();
        let any_tracking = mode.intersects(TermMode::MOUSE_MODE);

        let (btn_code, is_release, is_motion, repeat) = match input.kind {
            MouseKind::Press(b) => {
                if !self.pressed.contains(&b) {
                    self.pressed.push(b);
                }
                self.last_cell = Some(input.at);
                (button_code(b), false, false, 1u32)
            }
            MouseKind::Release(b) => {
                self.pressed.retain(|p| *p != b);
                self.last_cell = Some(input.at);
                (button_code(b), true, false, 1u32)
            }
            MouseKind::Move => {
                let report_motion = if mode.contains(TermMode::MOUSE_MOTION) {
                    true
                } else if mode.contains(TermMode::MOUSE_DRAG) {
                    !self.pressed.is_empty()
                } else {
                    false
                };
                if !any_tracking || !report_motion {
                    return out;
                }
                if self.last_cell == Some(input.at) {
                    return out;
                }
                self.last_cell = Some(input.at);
                let base = self.pressed.first().copied().map_or(3u8, button_code);
                (base, false, true, 1u32)
            }
            MouseKind::Wheel { lines } => {
                if lines == 0 {
                    return out;
                }
                let code = if lines > 0 { 64u8 } else { 65u8 };
                (code, false, false, lines.unsigned_abs().min(64))
            }
        };

        if !any_tracking {
            return out;
        }

        let col = input.at.col.min(size.cols.saturating_sub(1));
        let row = input.at.row.min(size.rows.saturating_sub(1));
        let mod_bits = (u8::from(input.mods.shift) << 2) | (u8::from(input.mods.alt) << 3) | (u8::from(input.mods.ctrl) << 4);
        let motion_bit = if is_motion { 32u8 } else { 0u8 };

        if mode.contains(TermMode::SGR_MOUSE) {
            let cb = btn_code | mod_bits | motion_bit;
            let suffix = if is_release { 'm' } else { 'M' };
            let mut seq = String::with_capacity(16);
            let _ = write!(seq, "\x1b[<{cb};{};{}{suffix}", u32::from(col) + 1, u32::from(row) + 1);
            for _ in 0..repeat {
                out.extend_from_slice(seq.as_bytes());
            }
        } else {
            let base = if is_release { 3u8 } else { btn_code };
            let cb = base | mod_bits | motion_bit;
            let x = u32::from(col) + 1;
            let y = u32::from(row) + 1;
            if mode.contains(TermMode::UTF8_MOUSE) {
                let mut seq = String::with_capacity(9);
                seq.push_str("\x1b[M");
                seq.push(char::from_u32(u32::from(cb) + 32).unwrap_or(' '));
                seq.push(char::from_u32(x.min(2015) + 32).unwrap_or(' '));
                seq.push(char::from_u32(y.min(2015) + 32).unwrap_or(' '));
                for _ in 0..repeat {
                    out.extend_from_slice(seq.as_bytes());
                }
            } else if x <= 223 && y <= 223 {
                let seq = [
                    0x1b,
                    b'[',
                    b'M',
                    cb.saturating_add(32),
                    (x as u8).saturating_add(32),
                    (y as u8).saturating_add(32),
                ];
                for _ in 0..repeat {
                    out.extend_from_slice(&seq);
                }
            }
        }

        out
    }
}

fn button_code(b: MouseButton) -> u8 {
    match b {
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
    }
}

/// The encoder wants printable text only: no C0 controls and none of the
/// private-use codepoints macOS reports for function keys.
fn printable(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| !c.is_control() && !('\u{F700}'..='\u{F8FF}').contains(&c))
}

fn xterm_mod_param(m: Mods, option_as_alt: bool) -> u8 {
    let alt = m.alt && option_as_alt;
    let bits = u8::from(m.shift) | (u8::from(alt) << 1) | (u8::from(m.ctrl) << 2);
    if bits == 0 { 0 } else { bits + 1 }
}

fn kitty_mod_bits(m: Mods, option_as_alt: bool) -> u8 {
    let alt = m.alt && option_as_alt;
    u8::from(m.shift) | (u8::from(alt) << 1) | (u8::from(m.ctrl) << 2) | (u8::from(m.cmd) << 3)
}

fn unshifted_char(c: char) -> char {
    match c {
        'A'..='Z' => c.to_ascii_lowercase(),
        ')' => '0',
        '!' => '1',
        '@' => '2',
        '#' => '3',
        '$' => '4',
        '%' => '5',
        '^' => '6',
        '&' => '7',
        '*' => '8',
        '(' => '9',
        '_' => '-',
        '+' => '=',
        '{' => '[',
        '}' => ']',
        '|' => '\\',
        ':' => ';',
        '"' => '\'',
        '<' => ',',
        '>' => '.',
        '?' => '/',
        '~' => '`',
        other => other,
    }
}

fn format_csi_u(codepoint: u32, mod_bits: u8) -> Vec<u8> {
    if mod_bits == 0 {
        format!("\x1b[{codepoint}u").into_bytes()
    } else {
        format!("\x1b[{codepoint};{}u", mod_bits + 1).into_bytes()
    }
}

fn encode_kitty_key(mode: TermMode, input: &KeyInput, option_as_alt: bool) -> Option<Vec<u8>> {
    let all_as_esc = mode.contains(TermMode::REPORT_ALL_KEYS_AS_ESC);
    let mod_bits = kitty_mod_bits(input.mods, option_as_alt);
    let non_shift_mod = input.mods.ctrl || (input.mods.alt && option_as_alt) || input.mods.cmd;

    match &input.key {
        Key::Escape => Some(format_csi_u(27, mod_bits)),
        Key::Enter if all_as_esc || mod_bits != 0 => Some(format_csi_u(13, mod_bits)),
        Key::Tab if all_as_esc || mod_bits != 0 => Some(format_csi_u(9, mod_bits)),
        Key::Backspace if all_as_esc || mod_bits != 0 => Some(format_csi_u(127, mod_bits)),
        Key::Char(s) if all_as_esc || non_shift_mod => {
            let c = s.chars().next()?;
            let cp = u32::from(unshifted_char(c));
            Some(format_csi_u(cp, mod_bits))
        }
        _ => None,
    }
}

fn encode_csi_cursor(letter: char, app_cursor: bool, mod_param: u8) -> Vec<u8> {
    if mod_param != 0 {
        format!("\x1b[1;{mod_param}{letter}").into_bytes()
    } else if app_cursor {
        format!("\x1bO{letter}").into_bytes()
    } else {
        format!("\x1b[{letter}").into_bytes()
    }
}

fn encode_csi_tilde(code: u8, mod_param: u8) -> Vec<u8> {
    if mod_param != 0 {
        format!("\x1b[{code};{mod_param}~").into_bytes()
    } else {
        format!("\x1b[{code}~").into_bytes()
    }
}

fn encode_function_key(n: u8, mod_param: u8) -> Vec<u8> {
    match n {
        1..=4 => {
            let letter = match n {
                1 => 'P',
                2 => 'Q',
                3 => 'R',
                4 => 'S',
                _ => unreachable!(),
            };
            if mod_param != 0 {
                format!("\x1b[1;{mod_param}{letter}").into_bytes()
            } else {
                format!("\x1bO{letter}").into_bytes()
            }
        }
        5 => encode_csi_tilde(15, mod_param),
        6 => encode_csi_tilde(17, mod_param),
        7 => encode_csi_tilde(18, mod_param),
        8 => encode_csi_tilde(19, mod_param),
        9 => encode_csi_tilde(20, mod_param),
        10 => encode_csi_tilde(21, mod_param),
        11 => encode_csi_tilde(23, mod_param),
        12 => encode_csi_tilde(24, mod_param),
        13 => encode_csi_tilde(25, mod_param),
        14 => encode_csi_tilde(26, mod_param),
        15 => encode_csi_tilde(28, mod_param),
        16 => encode_csi_tilde(29, mod_param),
        17 => encode_csi_tilde(31, mod_param),
        18 => encode_csi_tilde(32, mod_param),
        19 => encode_csi_tilde(33, mod_param),
        20 => encode_csi_tilde(34, mod_param),
        _ => Vec::new(),
    }
}

fn ctrl_byte(c: char) -> Option<u8> {
    let lower = c.to_ascii_lowercase();
    match lower {
        'a'..='z' => Some((lower as u8) - b'a' + 1),
        ' ' | '@' | '2' => Some(0x00),
        '[' | '3' => Some(0x1b),
        '\\' | '4' => Some(0x1c),
        ']' | '5' => Some(0x1d),
        '^' | '6' | '~' => Some(0x1e),
        '_' | '7' | '/' | '-' => Some(0x1f),
        '?' | '8' => Some(0x7f),
        _ => None,
    }
}

fn encode_legacy_key(mode: TermMode, input: &KeyInput, option_as_alt: bool) -> Vec<u8> {
    let m = input.mods;
    let app_cursor = mode.contains(TermMode::APP_CURSOR);
    // Named keys always honor Alt regardless of option_as_alt (e.g. Alt+Left).
    let named_mod = xterm_mod_param(m, true);

    match &input.key {
        Key::Enter => {
            if m.alt && option_as_alt {
                b"\x1b\r".to_vec()
            } else {
                b"\r".to_vec()
            }
        }
        Key::Tab => {
            if m.shift {
                b"\x1b[Z".to_vec()
            } else if m.alt && option_as_alt {
                b"\x1b\t".to_vec()
            } else {
                b"\t".to_vec()
            }
        }
        Key::Backspace => {
            let base = if m.ctrl { 0x08u8 } else { 0x7fu8 };
            if m.alt && option_as_alt { vec![0x1b, base] } else { vec![base] }
        }
        Key::Escape => {
            if m.alt && option_as_alt {
                b"\x1b\x1b".to_vec()
            } else {
                b"\x1b".to_vec()
            }
        }
        Key::Insert => encode_csi_tilde(2, named_mod),
        Key::Delete => encode_csi_tilde(3, named_mod),
        Key::PageUp => encode_csi_tilde(5, named_mod),
        Key::PageDown => encode_csi_tilde(6, named_mod),
        Key::Up => encode_csi_cursor('A', app_cursor, named_mod),
        Key::Down => encode_csi_cursor('B', app_cursor, named_mod),
        Key::Right => encode_csi_cursor('C', app_cursor, named_mod),
        Key::Left => encode_csi_cursor('D', app_cursor, named_mod),
        Key::Home => encode_csi_cursor('H', app_cursor, named_mod),
        Key::End => encode_csi_cursor('F', app_cursor, named_mod),
        Key::F(n) => encode_function_key(*n, named_mod),
        Key::Char(s) => encode_char_key(s, input.text.as_deref(), m, option_as_alt),
    }
}

fn encode_char_key(s: &str, platform_text: Option<&str>, m: Mods, option_as_alt: bool) -> Vec<u8> {
    let first = s.chars().next();
    if m.ctrl {
        if let Some(byte) = first.and_then(ctrl_byte) {
            return if m.alt && option_as_alt { vec![0x1b, byte] } else { vec![byte] };
        }
        return Vec::new();
    }
    if m.cmd {
        return Vec::new();
    }

    let typed = if m.shift && s.chars().count() == 1 && first.is_some_and(|c| c.is_ascii_lowercase()) {
        first.unwrap().to_ascii_uppercase().to_string()
    } else {
        s.to_string()
    };

    if m.alt && option_as_alt {
        let mut out = Vec::with_capacity(1 + typed.len());
        out.push(0x1b);
        out.extend_from_slice(typed.as_bytes());
        return out;
    }

    let text = platform_text.filter(|t| printable(t)).unwrap_or(typed.as_str());
    if printable(text) { text.as_bytes().to_vec() } else { Vec::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_legacy_arrows_ctrl_alt_and_function_keys() {
        let mut input = Input::new();
        let none = Mods::default();
        let ctrl = Mods { ctrl: true, ..none };
        let alt = Mods { alt: true, ..none };
        let shift = Mods { shift: true, ..none };

        assert_eq!(
            input.encode_key(
                TermMode::NONE,
                &KeyInput {
                    key: Key::Up,
                    mods: none,
                    text: None
                }
            ),
            b"\x1b[A"
        );
        assert_eq!(
            input.encode_key(
                TermMode::APP_CURSOR,
                &KeyInput {
                    key: Key::Up,
                    mods: none,
                    text: None
                }
            ),
            b"\x1bOA"
        );
        assert_eq!(
            input.encode_key(
                TermMode::APP_CURSOR,
                &KeyInput {
                    key: Key::Home,
                    mods: none,
                    text: None
                }
            ),
            b"\x1bOH"
        );
        assert_eq!(
            input.encode_key(
                TermMode::NONE,
                &KeyInput {
                    key: Key::Right,
                    mods: ctrl,
                    text: None
                }
            ),
            b"\x1b[1;5C"
        );
        assert_eq!(
            input.encode_key(
                TermMode::NONE,
                &KeyInput {
                    key: Key::Char("c".into()),
                    mods: ctrl,
                    text: None
                }
            ),
            b"\x03"
        );
        assert_eq!(
            input.encode_key(
                TermMode::NONE,
                &KeyInput {
                    key: Key::Char("b".into()),
                    mods: alt,
                    text: Some("∫".into())
                }
            ),
            b"\x1bb"
        );
        assert_eq!(
            input.encode_key(
                TermMode::NONE,
                &KeyInput {
                    key: Key::Tab,
                    mods: shift,
                    text: None
                }
            ),
            b"\x1b[Z"
        );
        assert_eq!(
            input.encode_key(
                TermMode::NONE,
                &KeyInput {
                    key: Key::F(5),
                    mods: none,
                    text: None
                }
            ),
            b"\x1b[15~"
        );

        input.option_as_alt = false;
        assert_eq!(
            input.encode_key(
                TermMode::NONE,
                &KeyInput {
                    key: Key::Char("b".into()),
                    mods: alt,
                    text: Some("∫".into())
                }
            ),
            "∫".as_bytes()
        );
    }

    #[test]
    fn encodes_kitty_disambiguate_sequences() {
        let mut input = Input::new();
        let mode = TermMode::DISAMBIGUATE_ESC_CODES;
        assert_eq!(
            input.encode_key(
                mode,
                &KeyInput {
                    key: Key::Escape,
                    mods: Mods::default(),
                    text: None
                }
            ),
            b"\x1b[27u"
        );
        assert_eq!(
            input.encode_key(
                mode,
                &KeyInput {
                    key: Key::Char("c".into()),
                    mods: Mods { ctrl: true, ..Mods::default() },
                    text: None,
                }
            ),
            b"\x1b[99;5u"
        );
    }

    #[test]
    fn encodes_sgr_and_x10_mouse_events() {
        let mut input = Input::new();
        let size = TermSize {
            cols: 40,
            rows: 10,
            cell_width_px: 8,
            cell_height_px: 16,
        };
        let mode = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        let at = Point { row: 2, col: 3 };
        let mods = Mods::default();
        assert_eq!(
            input.encode_mouse(
                mode,
                size,
                MouseInput {
                    kind: MouseKind::Press(MouseButton::Left),
                    at,
                    mods
                }
            ),
            b"\x1b[<0;4;3M"
        );
        assert_eq!(
            input.encode_mouse(
                mode,
                size,
                MouseInput {
                    kind: MouseKind::Release(MouseButton::Left),
                    at,
                    mods
                }
            ),
            b"\x1b[<0;4;3m"
        );
        assert_eq!(
            input.encode_mouse(
                mode,
                size,
                MouseInput {
                    kind: MouseKind::Wheel { lines: 1 },
                    at,
                    mods
                }
            ),
            b"\x1b[<64;4;3M"
        );
        assert!(
            input
                .encode_mouse(
                    TermMode::NONE,
                    size,
                    MouseInput {
                        kind: MouseKind::Press(MouseButton::Left),
                        at,
                        mods
                    }
                )
                .is_empty()
        );
    }
}

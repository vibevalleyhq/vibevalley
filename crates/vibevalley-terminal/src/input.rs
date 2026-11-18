//! Maps the crate's input types onto libghostty-vt's key and mouse encoders.

use libghostty_vt::{Error, Terminal, key, mouse};

use crate::{Key, KeyInput, Mods, MouseButton, MouseInput, MouseKind, TermSize};

pub(crate) struct Input {
    key_encoder: key::Encoder<'static>,
    key_event: key::Event<'static>,
    mouse_encoder: mouse::Encoder<'static>,
    mouse_event: mouse::Event<'static>,
    pressed: Vec<MouseButton>,
    pub option_as_alt: bool,
}

fn mods(m: Mods) -> key::Mods {
    let mut out = key::Mods::empty();
    out.set(key::Mods::SHIFT, m.shift);
    out.set(key::Mods::CTRL, m.ctrl);
    out.set(key::Mods::ALT, m.alt);
    out.set(key::Mods::SUPER, m.cmd);
    out
}

/// Physical key (US layout) and unshifted codepoint for a printable char.
fn char_key(c: char) -> (key::Key, char) {
    use key::Key as K;
    let lower = c.to_ascii_lowercase();
    let by_offset = |base: K, offset: u8| K::try_from(base as i32 + i32::from(offset)).ok();
    match lower {
        'a'..='z' => (by_offset(K::A, lower as u8 - b'a').unwrap_or(K::Unidentified), lower),
        '0'..='9' => (by_offset(K::Digit0, lower as u8 - b'0').unwrap_or(K::Unidentified), lower),
        ' ' => (K::Space, ' '),
        ')' => (K::Digit0, '0'),
        '!' => (K::Digit1, '1'),
        '@' => (K::Digit2, '2'),
        '#' => (K::Digit3, '3'),
        '$' => (K::Digit4, '4'),
        '%' => (K::Digit5, '5'),
        '^' => (K::Digit6, '6'),
        '&' => (K::Digit7, '7'),
        '*' => (K::Digit8, '8'),
        '(' => (K::Digit9, '9'),
        '-' | '_' => (K::Minus, '-'),
        '=' | '+' => (K::Equal, '='),
        '[' | '{' => (K::BracketLeft, '['),
        ']' | '}' => (K::BracketRight, ']'),
        '\\' | '|' => (K::Backslash, '\\'),
        ';' | ':' => (K::Semicolon, ';'),
        '\'' | '"' => (K::Quote, '\''),
        ',' | '<' => (K::Comma, ','),
        '.' | '>' => (K::Period, '.'),
        '/' | '?' => (K::Slash, '/'),
        '`' | '~' => (K::Backquote, '`'),
        _ => (K::Unidentified, c),
    }
}

fn named_key(k: &Key) -> key::Key {
    use key::Key as K;
    match k {
        Key::Char(_) => K::Unidentified,
        Key::Enter => K::Enter,
        Key::Tab => K::Tab,
        Key::Backspace => K::Backspace,
        Key::Escape => K::Escape,
        Key::Delete => K::Delete,
        Key::Insert => K::Insert,
        Key::Up => K::ArrowUp,
        Key::Down => K::ArrowDown,
        Key::Left => K::ArrowLeft,
        Key::Right => K::ArrowRight,
        Key::Home => K::Home,
        Key::End => K::End,
        Key::PageUp => K::PageUp,
        Key::PageDown => K::PageDown,
        Key::F(n @ 1..=25) => K::try_from(K::F1 as i32 + i32::from(*n) - 1).unwrap_or(K::Unidentified),
        Key::F(_) => K::Unidentified,
    }
}

/// The encoder wants printable text only: no C0 controls and none of the
/// private-use codepoints macOS reports for function keys.
fn printable(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| !c.is_control() && !('\u{F700}'..='\u{F8FF}').contains(&c))
}

impl Input {
    pub(crate) fn new() -> Result<Self, Error> {
        Ok(Self {
            key_encoder: key::Encoder::new()?,
            key_event: key::Event::new()?,
            mouse_encoder: mouse::Encoder::new()?,
            mouse_event: mouse::Event::new()?,
            pressed: Vec::new(),
            option_as_alt: true,
        })
    }

    pub(crate) fn encode_key(&mut self, term: &Terminal<'static, 'static>, input: &KeyInput) -> Vec<u8> {
        let m = input.mods;
        let (key, unshifted, typed) = match &input.key {
            Key::Char(s) => {
                let c = s.chars().next().unwrap_or('\0');
                let (key, unshifted) = char_key(c);
                let typed = if m.shift && s.chars().count() == 1 && c.is_ascii_lowercase() {
                    c.to_ascii_uppercase().to_string()
                } else {
                    s.clone()
                };
                (key, unshifted, Some(typed))
            }
            other => (named_key(other), '\0', None),
        };

        // With option-as-alt the platform's composed character (e.g. "∫" for
        // option+b) must not reach the program; Alt applies to the plain key.
        let platform_text = if m.alt && self.option_as_alt && typed.is_some() {
            None
        } else {
            input.text.clone()
        };
        let text = platform_text.or(if m.ctrl || m.cmd { None } else { typed }).filter(|t| printable(t));

        let mut consumed = key::Mods::empty();
        if m.shift
            && let Some(text) = &text
            && !text.starts_with(unshifted)
        {
            consumed |= key::Mods::SHIFT;
        }

        self.key_event
            .set_action(key::Action::Press)
            .set_key(key)
            .set_mods(mods(m))
            .set_consumed_mods(consumed)
            .set_composing(false)
            .set_unshifted_codepoint(unshifted)
            .set_utf8(text.as_deref());

        let mut out = Vec::with_capacity(16);
        let encoded = self
            .key_encoder
            .set_options_from_terminal(term)
            .set_macos_option_as_alt(if self.option_as_alt {
                key::OptionAsAlt::True
            } else {
                key::OptionAsAlt::False
            })
            .encode_to_vec(&self.key_event, &mut out);
        if (encoded.is_err() || out.is_empty())
            && !m.ctrl
            && !m.cmd
            && let Some(text) = text
        {
            out = text.into_bytes();
        }
        out
    }

    /// Encodes a mouse event for the program, or nothing when it did not ask
    /// for mouse reporting.
    pub(crate) fn encode_mouse(&mut self, term: &Terminal<'static, 'static>, size: TermSize, input: MouseInput) -> Vec<u8> {
        let button = |b: MouseButton| match b {
            MouseButton::Left => mouse::Button::Left,
            MouseButton::Middle => mouse::Button::Middle,
            MouseButton::Right => mouse::Button::Right,
        };
        let (action, btn, repeat) = match input.kind {
            MouseKind::Press(b) => {
                if !self.pressed.contains(&b) {
                    self.pressed.push(b);
                }
                (mouse::Action::Press, Some(button(b)), 1)
            }
            MouseKind::Release(b) => {
                self.pressed.retain(|p| *p != b);
                (mouse::Action::Release, Some(button(b)), 1)
            }
            MouseKind::Move => (mouse::Action::Motion, self.pressed.first().copied().map(button), 1),
            MouseKind::Wheel { lines } => (
                mouse::Action::Press,
                Some(if lines > 0 { mouse::Button::Four } else { mouse::Button::Five }),
                lines.unsigned_abs().min(64),
            ),
        };

        let mut out = Vec::new();
        if !term.is_mouse_tracking().unwrap_or(false) {
            return out;
        }

        let cell_w = u32::from(size.cell_width_px.max(1));
        let cell_h = u32::from(size.cell_height_px.max(1));
        let any_pressed = match input.kind {
            MouseKind::Release(_) => !self.pressed.is_empty(),
            MouseKind::Press(_) => true,
            _ => !self.pressed.is_empty(),
        };
        self.mouse_encoder.set_options_from_terminal(term);
        if self
            .mouse_encoder
            .set_size(mouse::EncoderSize {
                screen_width: u32::from(size.cols) * cell_w,
                screen_height: u32::from(size.rows) * cell_h,
                cell_width: cell_w,
                cell_height: cell_h,
                padding_top: 0,
                padding_bottom: 0,
                padding_right: 0,
                padding_left: 0,
            })
            .is_err()
        {
            return out;
        }
        self.mouse_encoder.set_any_button_pressed(any_pressed).set_track_last_cell(true);

        self.mouse_event
            .set_action(action)
            .set_button(btn)
            .set_mods(mods(input.mods))
            .set_position(mouse::Position {
                x: (f32::from(input.at.col) + 0.5) * cell_w as f32,
                y: (f32::from(input.at.row) + 0.5) * cell_h as f32,
            });
        for _ in 0..repeat {
            let _ = self.mouse_encoder.encode_to_vec(&self.mouse_event, &mut out);
        }
        out
    }
}

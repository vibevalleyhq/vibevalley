//! GPUI keystroke -> `vibevalley_terminal::KeyInput`.
//!
//! Printable keys without Ctrl/Cmd (and without Option-as-meta) are *not*
//! mapped: they are left to the platform text system so an input method can
//! compose them, and arrive as committed text instead.

use gpui_kit::Keystroke;
use vibevalley_terminal::{Key, KeyInput, Mods};

fn named(key: &str) -> Option<Key> {
    Some(match key {
        "enter" => Key::Enter,
        "tab" => Key::Tab,
        "backspace" => Key::Backspace,
        "escape" => Key::Escape,
        "delete" => Key::Delete,
        "insert" => Key::Insert,
        "up" => Key::Up,
        "down" => Key::Down,
        "left" => Key::Left,
        "right" => Key::Right,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        _ => {
            let n: u8 = key.strip_prefix('f')?.parse().ok()?;
            (1..=35).contains(&n).then_some(Key::F(n))?
        }
    })
}

fn ctrl(c: &str) -> KeyInput {
    KeyInput {
        key: Key::Char(c.into()),
        mods: Mods { ctrl: true, ..Mods::default() },
        text: None,
    }
}

pub fn map_keystroke(ks: &Keystroke, option_as_meta: bool) -> Option<KeyInput> {
    let m = ks.modifiers;
    if m.platform {
        // The macOS line-editing conventions every terminal app honors.
        return match ks.key.as_str() {
            "left" => Some(ctrl("a")),
            "right" => Some(ctrl("e")),
            "backspace" => Some(ctrl("u")),
            _ => None,
        };
    }
    let mods = Mods {
        shift: m.shift,
        ctrl: m.control,
        alt: m.alt,
        cmd: false,
    };
    if let Some(key) = named(&ks.key) {
        return Some(KeyInput { key, mods, text: None });
    }
    let key = if ks.key == "space" { " " } else { ks.key.as_str() };
    if key.chars().count() != 1 {
        return None;
    }
    if m.control {
        return Some(KeyInput {
            key: Key::Char(key.into()),
            mods,
            text: None,
        });
    }
    if m.alt && option_as_meta {
        return Some(KeyInput {
            key: Key::Char(key.into()),
            mods,
            text: None,
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ks(s: &'static str) -> Keystroke {
        Keystroke::parse(s).unwrap()
    }

    #[test]
    fn plain_and_shifted_characters_go_to_the_input_method() {
        assert_eq!(map_keystroke(&ks("a"), true), None);
        assert_eq!(map_keystroke(&ks("shift-a"), true), None);
        assert_eq!(map_keystroke(&ks("space"), true), None);
    }

    #[test]
    fn control_and_meta_characters_are_sent_as_keys() {
        let c = map_keystroke(&ks("ctrl-c"), true).unwrap();
        assert_eq!(c.key, Key::Char("c".into()));
        assert!(c.mods.ctrl && !c.mods.alt);
        assert_eq!(map_keystroke(&ks("ctrl-space"), true).unwrap().key, Key::Char(" ".into()));
        assert!(map_keystroke(&ks("alt-b"), true).unwrap().mods.alt);
        assert_eq!(map_keystroke(&ks("alt-b"), false), None, "Option composes characters when not meta");
    }

    #[test]
    fn named_keys_keep_their_modifiers() {
        assert_eq!(map_keystroke(&ks("enter"), true).unwrap().key, Key::Enter);
        let k = map_keystroke(&ks("shift-tab"), true).unwrap();
        assert_eq!((k.key, k.mods.shift), (Key::Tab, true));
        assert_eq!(map_keystroke(&ks("f5"), true).unwrap().key, Key::F(5));
        assert!(map_keystroke(&ks("alt-left"), false).unwrap().mods.alt);
        assert_eq!(map_keystroke(&ks("pageup"), true).unwrap().key, Key::PageUp);
    }

    #[test]
    fn command_keys_belong_to_the_app_except_line_editing() {
        assert_eq!(map_keystroke(&ks("cmd-p"), true), None);
        assert_eq!(map_keystroke(&ks("cmd-left"), true), Some(ctrl("a")));
        assert_eq!(map_keystroke(&ks("cmd-backspace"), true), Some(ctrl("u")));
    }
}

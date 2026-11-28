use std::collections::HashSet;

use gpui::{App, KeyUpEvent, Keystroke, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PlatformInput, Window, point, px};
use vibevalley_protocol::{VdpDispatchKeyParams, VdpDispatchMouseParams, VdpError, VdpInputResult, VdpMouseButton, VdpMouseEventKind, VdpTypeTextParams};

fn dispatch_single_key(key: Keystroke, window: &mut Window, cx: &mut App) -> bool {
    window.draw(cx).clear(cx);
    let handled = window.dispatch_keystroke(key.clone(), cx);
    window.dispatch_event(PlatformInput::KeyUp(KeyUpEvent { keystroke: key }), cx);
    handled
}

/// Parses a GPUI keystroke while interning unique specs so repeated VDP calls do not leak memory.
fn parse_keystroke(token: &str) -> Result<Keystroke, VdpError> {
    static INTERNED: std::sync::OnceLock<parking_lot::Mutex<HashSet<&'static str>>> = std::sync::OnceLock::new();
    let table = INTERNED.get_or_init(|| parking_lot::Mutex::new(HashSet::new()));
    let static_str: &'static str = {
        let mut guard = table.lock();
        if let Some(&existing) = guard.get(token) {
            existing
        } else {
            let leaked: &'static str = Box::leak(token.to_string().into_boxed_str());
            guard.insert(leaked);
            leaked
        }
    };
    Keystroke::parse(static_str).map_err(|e| VdpError::invalid_params(format!("invalid keystroke {token:?}: {e}")))
}

/// Dispatches whitespace-separated keystroke specs (e.g. `"cmd-1 cmd-shift-p"`).
pub(crate) fn dispatch_keys(params: &VdpDispatchKeyParams, window: &mut Window, cx: &mut App) -> Result<VdpInputResult, VdpError> {
    let tokens: Vec<&str> = params.keys.split_whitespace().collect();
    if tokens.is_empty() {
        return Err(VdpError::invalid_params("Input.dispatchKey requires at least one key"));
    }
    let mut any_handled = false;
    for token in tokens {
        let keystroke = parse_keystroke(token)?;
        if dispatch_single_key(keystroke, window, cx) {
            any_handled = true;
        }
    }
    Ok(VdpInputResult { handled: any_handled })
}

/// Types UTF-8 characters through the window's normal keystroke dispatch path.
pub(crate) fn dispatch_text(params: &VdpTypeTextParams, window: &mut Window, cx: &mut App) -> VdpInputResult {
    let mut any_handled = false;
    for ch in params.text.chars() {
        let key = ch.to_string();
        let handled = dispatch_single_key(
            Keystroke {
                modifiers: Modifiers::default(),
                key: key.clone(),
                key_char: Some(key),
            },
            window,
            cx,
        );
        any_handled |= handled;
    }
    VdpInputResult { handled: any_handled }
}

/// Dispatches a mouse event (`down`, `up`, `move`, `click`, `drag`) in window coordinates.
pub(crate) fn dispatch_mouse(params: &VdpDispatchMouseParams, window: &mut Window, cx: &mut App) -> Result<VdpInputResult, VdpError> {
    if !params.x.is_finite() || !params.y.is_finite() {
        return Err(VdpError::invalid_params("mouse coordinates must be finite"));
    }
    let button = match params.button.unwrap_or_default() {
        VdpMouseButton::Left => MouseButton::Left,
        VdpMouseButton::Right => MouseButton::Right,
        VdpMouseButton::Middle => MouseButton::Middle,
    };
    let modifiers = Modifiers::default();
    let start = point(px(params.x), px(params.y));

    let mk_down = |position| {
        PlatformInput::MouseDown(MouseDownEvent {
            button,
            position,
            modifiers,
            click_count: 1,
            first_mouse: false,
        })
    };
    let mk_up = |position| {
        PlatformInput::MouseUp(MouseUpEvent {
            button,
            position,
            modifiers,
            click_count: 1,
        })
    };
    let mk_move = |position, pressed| {
        PlatformInput::MouseMove(MouseMoveEvent {
            position,
            modifiers,
            pressed_button: pressed,
        })
    };

    let events = match params.kind {
        VdpMouseEventKind::Down => vec![mk_down(start)],
        VdpMouseEventKind::Up => vec![mk_up(start)],
        VdpMouseEventKind::Move => vec![mk_move(start, None)],
        VdpMouseEventKind::Click => vec![mk_down(start), mk_up(start)],
        VdpMouseEventKind::Drag => {
            if let (Some(ex), Some(ey)) = (params.end_x, params.end_y) {
                if !ex.is_finite() || !ey.is_finite() {
                    return Err(VdpError::invalid_params("drag end coordinates must be finite"));
                }
                let end = point(px(ex), px(ey));
                vec![mk_down(start), mk_move(end, Some(button)), mk_up(end)]
            } else {
                vec![mk_move(start, Some(button))]
            }
        }
    };

    for event in events {
        window.draw(cx).clear(cx);
        window.dispatch_event(event, cx);
    }
    Ok(VdpInputResult { handled: true })
}

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde_json::json;

use super::*;

#[test]
fn socket_and_apps_dir_paths_resolve_overrides() {
    assert_eq!(socket_path(Path::new("/tmp/vv-home")), PathBuf::from("/tmp/vv-home/applet.sock"));
    assert_eq!(
        apps_dir_from(Some(OsStr::new("/tmp/custom-apps")), Some(OsStr::new("/Users/tester"))),
        PathBuf::from("/tmp/custom-apps")
    );
    assert_eq!(
        apps_dir_from(Some(OsStr::new("")), Some(OsStr::new("/Users/tester"))),
        PathBuf::from("/Users/tester/Applications/VibeValley Apps")
    );
    assert_eq!(
        apps_dir_from(None, Some(OsStr::new("/Users/tester"))),
        PathBuf::from("/Users/tester/Applications/VibeValley Apps")
    );
    assert_eq!(apps_dir_from(None, None), PathBuf::from("/Applications/VibeValley Apps"));
}

#[test]
fn shim_to_host_wire_protocol_roundtrips_with_exact_camel_case_fields() {
    let mods = Modifiers {
        control: true,
        alt: false,
        shift: true,
        platform: true,
        function: false,
    };
    let cases = vec![
        (
            ShimToHost::Attach {
                note_id: "note-1".into(),
                width: 960.0,
                height: 640.0,
                scale: 2.0,
                display_id: Some(69733248),
            },
            json!({
                "type": "attach",
                "noteId": "note-1",
                "width": 960.0,
                "height": 640.0,
                "scale": 2.0,
                "displayId": 69733248,
            }),
        ),
        (
            ShimToHost::Resize {
                width: 800.0,
                height: 500.0,
                scale: 1.0,
            },
            json!({ "type": "resize", "width": 800.0, "height": 500.0, "scale": 1.0 }),
        ),
        (
            ShimToHost::MouseDown {
                x: 10.5,
                y: 22.0,
                button: MouseButtonKind::Left,
                click_count: 2,
                modifiers: mods,
            },
            json!({
                "type": "mouseDown",
                "x": 10.5,
                "y": 22.0,
                "button": "left",
                "clickCount": 2,
                "modifiers": { "control": true, "alt": false, "shift": true, "platform": true, "function": false },
            }),
        ),
        (
            ShimToHost::MouseUp {
                x: 10.5,
                y: 22.0,
                button: MouseButtonKind::Right,
                click_count: 1,
                modifiers: Modifiers::default(),
            },
            json!({
                "type": "mouseUp",
                "x": 10.5,
                "y": 22.0,
                "button": "right",
                "clickCount": 1,
                "modifiers": { "control": false, "alt": false, "shift": false, "platform": false, "function": false },
            }),
        ),
        (
            ShimToHost::MouseMove {
                x: 42.0,
                y: 84.0,
                pressed_button: Some(MouseButtonKind::Middle),
                modifiers: Modifiers::default(),
            },
            json!({
                "type": "mouseMove",
                "x": 42.0,
                "y": 84.0,
                "pressedButton": "middle",
                "modifiers": { "control": false, "alt": false, "shift": false, "platform": false, "function": false },
            }),
        ),
        (
            ShimToHost::MouseExit {
                x: -1.0,
                y: 5.0,
                modifiers: Modifiers::default(),
            },
            json!({
                "type": "mouseExit",
                "x": -1.0,
                "y": 5.0,
                "modifiers": { "control": false, "alt": false, "shift": false, "platform": false, "function": false },
            }),
        ),
        (
            ShimToHost::Scroll {
                x: 120.0,
                y: 240.0,
                delta_x: -3.5,
                delta_y: 12.0,
                precise: true,
                phase: ScrollPhaseKind::Moved,
                modifiers: mods,
            },
            json!({
                "type": "scroll",
                "x": 120.0,
                "y": 240.0,
                "deltaX": -3.5,
                "deltaY": 12.0,
                "precise": true,
                "phase": "moved",
                "modifiers": { "control": true, "alt": false, "shift": true, "platform": true, "function": false },
            }),
        ),
        (
            ShimToHost::KeyDown {
                key: "s".into(),
                key_char: Some("s".into()),
                is_held: true,
                modifiers: mods,
            },
            json!({
                "type": "keyDown",
                "key": "s",
                "keyChar": "s",
                "isHeld": true,
                "modifiers": { "control": true, "alt": false, "shift": true, "platform": true, "function": false },
            }),
        ),
        (
            ShimToHost::KeyUp {
                key: "s".into(),
                key_char: None,
                modifiers: Modifiers::default(),
            },
            json!({
                "type": "keyUp",
                "key": "s",
                "keyChar": null,
                "modifiers": { "control": false, "alt": false, "shift": false, "platform": false, "function": false },
            }),
        ),
        (
            ShimToHost::ModifiersChanged { modifiers: mods },
            json!({
                "type": "modifiersChanged",
                "modifiers": { "control": true, "alt": false, "shift": true, "platform": true, "function": false },
            }),
        ),
        (ShimToHost::Focus { focused: true }, json!({ "type": "focus", "focused": true })),
        (ShimToHost::OpenInHost, json!({ "type": "openInHost" })),
        (ShimToHost::Detach, json!({ "type": "detach" })),
    ];

    for (msg, expected_json) in cases {
        let encoded = serde_json::to_value(&msg).unwrap();
        assert_eq!(encoded, expected_json);
        let decoded: ShimToHost = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded, msg);
    }
}

#[test]
fn host_to_shim_wire_protocol_roundtrips_with_exact_camel_case_fields() {
    let cases = vec![
        (
            HostToShim::ReadyLayer {
                context_id: 4242,
                title: "Spec".into(),
                note_type: "doc".into(),
            },
            json!({ "type": "readyLayer", "contextId": 4242, "title": "Spec", "noteType": "doc" }),
        ),
        (
            HostToShim::ReadyWebview {
                html: "<html></html>".into(),
                title: "Proto".into(),
                note_type: "canvas".into(),
            },
            json!({ "type": "readyWebview", "html": "<html></html>", "title": "Proto", "noteType": "canvas" }),
        ),
        (
            HostToShim::UpdateWebview {
                html: "<html>v2</html>".into(),
                title: "Proto v2".into(),
            },
            json!({ "type": "updateWebview", "html": "<html>v2</html>", "title": "Proto v2" }),
        ),
        (
            HostToShim::SetTitle { title: "Renamed".into() },
            json!({ "type": "setTitle", "title": "Renamed" }),
        ),
        (
            HostToShim::SetAlwaysOnTop { enabled: true },
            json!({ "type": "setAlwaysOnTop", "enabled": true }),
        ),
        (
            HostToShim::Error { message: "not found".into() },
            json!({ "type": "error", "message": "not found" }),
        ),
        (HostToShim::Closing, json!({ "type": "closing" })),
    ];

    for (msg, expected_json) in cases {
        let encoded = serde_json::to_value(&msg).unwrap();
        assert_eq!(encoded, expected_json);
        let decoded: HostToShim = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded, msg);
    }
}

#[test]
fn applet_info_and_install_request_roundtrip() {
    let req = AppletInstallRequest {
        note_id: "note-123".into(),
        note_type: "base".into(),
        app_name: "My Base".into(),
        always_on_top: true,
    };
    let req_json = serde_json::to_value(&req).unwrap();
    assert_eq!(
        req_json,
        json!({ "noteId": "note-123", "noteType": "base", "appName": "My Base", "alwaysOnTop": true })
    );
    assert_eq!(serde_json::from_value::<AppletInstallRequest>(req_json).unwrap(), req);

    let info = AppletInfo {
        note_id: "note-123".into(),
        note_type: "canvas".into(),
        app_name: "My Board".into(),
        bundle_id: "dev.vibevalley.applet.note-123".into(),
        bundle_path: "/tmp/My Board.app".into(),
        always_on_top: true,
        installed: true,
    };
    let info_json = serde_json::to_value(&info).unwrap();
    assert_eq!(serde_json::from_value::<AppletInfo>(info_json).unwrap(), info);
}

use vibevalley_diorama::TimeOfDay;

use super::bridge::{DIORAMA_SLICES, attach_diorama_bridge, pump_diorama_slices};
use super::hud::{HudPalette, hud_cutaway_label_key, hud_tod_label_key, phone_overlay_size, resolve_dark};
use crate::diorama::phone::Phone;

#[test]
fn resolve_dark_uses_ui_global_then_window_appearance_fallback() {
    let light_ui = crate::theme::Ui::new(crate::theme::Settings::default(), false);
    let dark_ui = crate::theme::Ui::new(crate::theme::Settings::default(), true);
    assert!(!resolve_dark(Some(&light_ui), gpui::WindowAppearance::Dark));
    assert!(resolve_dark(Some(&dark_ui), gpui::WindowAppearance::Light));
    assert!(!resolve_dark(None, gpui::WindowAppearance::Light));
    assert!(resolve_dark(None, gpui::WindowAppearance::Dark));
    assert!(resolve_dark(None, gpui::WindowAppearance::VibrantDark));
}

#[test]
fn hud_palette_adapts_to_ui_theme_and_night_diorama() {
    for daytime in [TimeOfDay::Dawn, TimeOfDay::Noon, TimeOfDay::Dusk] {
        let light = HudPalette::for_scene(false, daytime);
        assert!(!light.dark, "daytime light mode ({daytime:?}) should use light HUD palette");
        assert!(light.surface.l > 0.9, "light HUD surface should stay warm paper");
        assert!(light.surface.a < 1.0 && light.surface.a > 0.8);
        assert!(light.ink.l < 0.25, "light HUD ink should be dark for legibility");
        assert!(light.divider.a > 0.1);
        assert_ne!(light.anchor_dot("vermilion"), light.anchor_dot("ochre"));
        assert_ne!(light.anchor_dot("ochre"), light.anchor_dot("water"));
    }

    let dark_night = HudPalette::for_scene(true, TimeOfDay::Night);
    assert!(dark_night.dark);
    assert!(dark_night.surface.l < 0.2, "dark HUD surface should stay deep warm charcoal");
    assert!(dark_night.surface.a < 1.0 && dark_night.surface.a > 0.8);
    assert!(dark_night.ink.l > 0.85, "dark HUD ink should be light cream");
    assert!(dark_night.active_fg.l < 0.2, "dark active pill label should keep high contrast on leaf accent");
    assert!(dark_night.badge_dot.l > 0.5, "dark notification dot should remain crisp and bright");

    for tod in [TimeOfDay::Dawn, TimeOfDay::Noon, TimeOfDay::Dusk, TimeOfDay::Night] {
        let dark = HudPalette::for_scene(true, tod);
        assert_eq!(dark, dark_night, "dark theme must use dark HUD palette at {tod:?}");
    }

    assert_eq!(HudPalette::for_scene(false, TimeOfDay::Night), dark_night);
}

#[test]
fn hud_i18n_keys_resolve_in_zh_and_en() {
    let keys = [
        hud_tod_label_key(TimeOfDay::Dawn),
        hud_tod_label_key(TimeOfDay::Noon),
        hud_tod_label_key(TimeOfDay::Dusk),
        hud_tod_label_key(TimeOfDay::Night),
        hud_cutaway_label_key(false),
        hud_cutaway_label_key(true),
        "web.farm.hud.resetCamera",
        "web.farm.menu.repos",
        "web.farm.hud.phone",
        "web.farm.hud.enter",
        "web.farm.hud.backToYard",
    ];

    for key in keys {
        let zh = vibevalley_i18n::t_in("zh", key, &[]);
        let en = vibevalley_i18n::t_in("en", key, &[]);
        assert!(!zh.is_empty() && zh != key, "zh missing translation for {key}: {zh:?}");
        assert!(!en.is_empty() && en != key, "en missing translation for {key}: {en:?}");
        assert_ne!(zh, en, "zh and en translations should differ for {key}");
    }

    assert_eq!(vibevalley_i18n::t_in("zh", hud_cutaway_label_key(false), &[]), "掀顶");
    assert_eq!(vibevalley_i18n::t_in("zh", hud_cutaway_label_key(true), &[]), "合顶");
    assert_eq!(vibevalley_i18n::t_in("en", hud_cutaway_label_key(false), &[]), "Lift roof");
    assert_eq!(vibevalley_i18n::t_in("en", hud_cutaway_label_key(true), &[]), "Close roof");
}

#[test]
fn regression_folded_phone_fits_3x2_icon_grid_and_unfolded_fits_handset_plus_chat() {
    let mut phone = Phone::default();
    phone.open = true;
    let (fw, fh) = phone_overlay_size((1376.0, 900.0), &phone);
    assert_eq!((fw, fh), (296.0, 330.0));

    phone.unfolded = true;
    let (uw, uh) = phone_overlay_size((1376.0, 900.0), &phone);
    assert_eq!((uw, uh), (642.0, 474.0));

    phone.large = true;
    let (lw, lh) = phone_overlay_size((1376.0, 900.0), &phone);
    assert_eq!((lw, lh), (882.0, 714.0));

    phone.unfolded = false;
    phone.large = false;
    phone.game = true;
    let (gw, gh) = phone_overlay_size((1376.0, 900.0), &phone);
    assert_eq!((gw, gh), (388.0, 530.0));

    phone.unfolded = true;
    phone.game = false;
    let (nw, nh) = phone_overlay_size((500.0, 600.0), &phone);
    assert_eq!((nw, nh), (472.0, 474.0));
}

#[test]
fn regression_dropping_diorama_bridge_and_task_releases_all_slice_watches() {
    use std::collections::BTreeSet;
    use std::sync::Arc;
    use std::time::Duration;

    use parking_lot::Mutex;
    use tokio::sync::Notify;
    use vibevalley_server::gateway::bridge::Bridge;
    use vibevalley_server::gateway::bridge::fake::{FakeServer, empty_bundle};

    let fake = Arc::new(FakeServer::from_bundle(empty_bundle(1)));
    let bridge = Bridge::new(fake.clone(), 2);

    for visit in 0..3 {
        let (client, rx) = attach_diorama_bridge(&bridge, "farm");
        assert_eq!(Arc::strong_count(&client), 1, "visit {visit}: no extra strong Arc");

        let weak_client = Arc::downgrade(&client);
        let seen_topics = Arc::new(Mutex::new(BTreeSet::new()));
        let notify = Arc::new(Notify::new());

        let task_topics = seen_topics.clone();
        let task_notify = notify.clone();
        let task_ack = weak_client.clone();
        let pump_handle = vibevalley_kit::rt::current_or_global_handle().spawn(async move {
            pump_diorama_slices(rx, task_ack, move |topic, _data| {
                task_topics.lock().insert(topic.to_string());
                task_notify.notify_waiters();
                true
            })
            .await;
        });

        vibevalley_kit::rt::block_on(async {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let notified = notify.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable();
                    if seen_topics.lock().len() == DIORAMA_SLICES.len() {
                        return;
                    }
                    notified.await;
                }
            })
            .await
        })
        .expect("all 5 diorama slices should deliver initial frames");

        vibevalley_kit::rt::block_on(async {
            let _ = tokio::time::timeout(Duration::from_secs(1), async {
                while Arc::strong_count(&client) != 1 {
                    tokio::task::yield_now().await;
                }
            })
            .await;
        });
        assert_eq!(Arc::strong_count(&client), 1, "pump task must hold Weak<Client> only");
        let snapshot = bridge.clients_snapshot();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].watches.len(), DIORAMA_SLICES.len());
        for slice in DIORAMA_SLICES {
            assert_eq!(fake.slice_watchers(*slice), 1, "expected active watcher for {slice:?}");
        }

        if visit % 2 == 0 {
            drop(client);
            assert_eq!(weak_client.strong_count(), 0);
            assert!(weak_client.upgrade().is_none());
            vibevalley_kit::rt::block_on(async {
                tokio::time::timeout(Duration::from_secs(3), pump_handle)
                    .await
                    .expect("slice pump task should exit once SliceOutlet drops")
                    .expect("slice pump task should not panic");
            });
        } else {
            pump_handle.abort();
            vibevalley_kit::rt::block_on(async {
                let _ = tokio::time::timeout(Duration::from_secs(1), pump_handle).await;
            });
            drop(client);
            assert_eq!(weak_client.strong_count(), 0);
            assert!(weak_client.upgrade().is_none());
        }

        assert!(bridge.clients_snapshot().is_empty(), "visit {visit}: bridge client leaked");
        vibevalley_kit::rt::block_on(async {
            tokio::time::timeout(Duration::from_secs(3), async {
                let mut yields = 0usize;
                while DIORAMA_SLICES.iter().any(|slice| fake.slice_watchers(*slice) != 0) {
                    if yields < 64 {
                        yields += 1;
                        tokio::task::yield_now().await;
                    } else {
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                }
            })
            .await
            .expect("all 5 FakeServer slice watchers should drop to 0");
        });
    }
}

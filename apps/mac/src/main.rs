mod audio;
mod command_line;
mod debug;
mod diff;
mod host;
mod hosted;
mod island;
mod live_voice;
mod panes;
mod pixel;
mod qr;
mod serving;
mod shell;
mod speech_audio;
mod terminal;
mod theme;
mod tray;
mod update;
mod viewer;

use gpui::{App, AppContext as _, Bounds, Focusable as _, TitlebarOptions, WindowBounds, WindowOptions, point, px, size};

pub fn ensure_main_window(cx: &mut App) {
    if !cx.windows().is_empty() {
        return;
    }
    let bounds = Bounds::centered(None, size(px(1280.0), px(820.0)), cx);
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        titlebar: Some(TitlebarOptions {
            title: Some("VibeValley".into()),
            appears_transparent: true,
            traffic_light_position: Some(point(px(12.0), px(11.0))),
        }),
        ..Default::default()
    };
    let mut built = None;
    let window = cx
        .open_window(options, |window, cx| {
            let shell = cx.new(|cx| shell::Shell::new(window, cx));
            window.focus(&shell.read(cx).focus_handle(cx), cx);
            built = Some(shell.clone());
            shell
        })
        .expect("failed to open window");
    let shell = built.expect("open_window ran its build closure");
    host::set_app_icon();
    debug::start(shell, window, cx);
}

fn main() {
    update::enter_bundle();
    vibevalley_i18n::set_locale(vibevalley_server::home::saved_locale(&hosted::server_home()));
    let app = gpui_platform::application();
    app.on_reopen(|cx| {
        ensure_main_window(cx);
        cx.activate(true);
    });
    app.run(|cx| {
        host::set_app_icon();
        tray::install(cx);
        theme::Ui::apply(theme::Settings::default(), cx);
        shell::bind_keys(cx);
        hosted::BridgeHub::install(cx);
        update::install(cx);
        if !pixel::element::load_font(cx) {
            eprintln!("pixel font not found under the repo's assets/");
        }
        ensure_main_window(cx);
        cx.activate(true);
        cx.on_app_quit(|_| {
            serving::shutdown();
            async {}
        })
        .detach();
    });
}

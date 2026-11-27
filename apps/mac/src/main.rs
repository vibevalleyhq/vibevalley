mod applet;
mod assets;
mod audio;
mod capture;
mod command_line;
mod debug;
mod diff;
mod diorama;
mod host;
mod hosted;
mod icon;
mod island;
mod live_voice;
mod log;
mod markdown_pane;
mod panes;
mod qr;
mod serving;
mod shell;
mod speech_audio;
mod terminal;
mod theme;
mod tray;
mod update;
mod viewer;
mod voice_asr;

use gpui::{App, AppContext as _, Bounds, Focusable as _, TitlebarOptions, WindowBounds, WindowOptions, point, px, size};

pub fn ensure_main_window(cx: &mut App) {
    if cx.windows().into_iter().any(|w| w.downcast::<shell::Shell>().is_some()) {
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
        app_owns_titlebar_drag: true,
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

fn has_background_flag() -> bool {
    has_background_flag_in(std::env::args().skip(1))
}

fn has_background_flag_in<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|arg| arg.as_ref() == "--background")
}

fn main() {
    log::init();
    debug::configure_from_env_and_args();
    host::disable_default_font_smoothing();
    update::enter_bundle();
    vibevalley_i18n::set_locale(vibevalley_server::home::saved_locale(&hosted::server_home()));
    let background = has_background_flag();
    let app = gpui_platform::application();
    app.on_reopen(|cx| {
        ensure_main_window(cx);
        cx.activate(true);
    });
    app.run(move |cx| {
        if !background {
            host::set_app_icon();
        }
        tray::install(cx);
        theme::Ui::apply(theme::Settings::default(), cx);
        shell::bind_keys(cx);
        hosted::BridgeHub::install(cx);
        applet::AppletHost::install(cx);
        update::install(cx);
        if !background {
            ensure_main_window(cx);
            cx.activate(true);
        }
        cx.on_app_quit(|cx| {
            debug::shutdown(cx);
            applet::AppletHost::shutdown(cx);
            let running = serving::RunningServer::take_for_shutdown(cx);
            let background = cx.background_executor().clone();
            async move {
                if let Some(running) = running {
                    background.spawn(async move { running.shutdown() }).await;
                }
            }
        })
        .detach();
    });
}

#[cfg(test)]
mod tests {
    use super::has_background_flag_in;

    #[test]
    fn background_flag_parser_detects_exact_flag() {
        assert!(has_background_flag_in(["--background"]));
        assert!(has_background_flag_in(["--foo", "--background"]));
        assert!(!has_background_flag_in(["--background=true", "--other"]));
        assert!(!has_background_flag_in(Vec::<String>::new()));
    }
}

mod debug;
mod diff;
mod host;
mod hosted;
mod panes;
mod pixel;
mod serving;
mod shell;
mod terminal;
mod theme;
mod update;
mod viewer;

use gpui_kit::{AppContext as _, Bounds, TitlebarOptions, WindowBounds, WindowOptions, point, px, size};

fn main() {
    update::enter_bundle();
    serving::install_tls();
    gpui_kit::application().run(|cx| {
        gpui_kit::init(cx);
        host::set_app_icon();
        theme::Ui::apply(theme::Settings::default(), cx);
        shell::bind_keys(cx);
        hosted::BridgeHub::install(cx);
        update::install(cx);
        if !pixel::element::load_font(cx) {
            eprintln!("pixel font not found under the repo's assets/");
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
        let (window, shell) = gpui_kit::open_window(options, cx, |window, cx| {
            let shell = cx.new(|cx| shell::Shell::new(window, cx));
            window.focus(&gpui_kit::Focusable::focus_handle(shell.read(cx), cx), cx);
            shell
        })
        .expect("failed to open window");
        host::set_app_icon();
        cx.activate(true);
        if let Some(window) = window.downcast::<gpui_kit::base::Root>() {
            debug::start(shell, window, cx);
        }
        cx.on_window_closed(|cx, _| cx.quit()).detach();
    });
}

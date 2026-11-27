//! Unix domain socket host (`$VIBEVALLEY_HOME/applet.sock`) driving standalone note windows.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use gpui::{
    AnyWindowHandle, App, AppContext as _, Bounds, Context, DisplayId, Entity, FocusHandle, Focusable, InteractiveElement as _, IntoElement, KeyDownEvent,
    KeyUpEvent, Keystroke, ModifiersChangedEvent, MouseDownEvent, MouseExitEvent, MouseMoveEvent, MouseUpEvent, ParentElement as _, PlatformInput, Render,
    ScrollDelta, ScrollEvent, ScrollSource, Styled as _, Subscription, Window, WindowBounds, WindowOptions, div, point, px, size,
};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use vibevalley_protocol::{HostOp, Note};
use vibevalley_server::gateway::bridge::{BizCode, CallerContext, Envelope, Server, refusal};

use crate::hosted::{BridgeHub, HostedEvent, HostedView};
use crate::theme::Ui;

use super::installer;
use super::remote_layer::RemoteLayer;
use super::{AppletInfo, AppletInstallRequest, AppletOpenResult, AppletRemoveResult, HostToShim, ShimToHost, socket_path};

const ACTIVE_FRAME_INTERVAL: Duration = Duration::from_millis(16);
const IDLE_FRAME_INTERVAL: Duration = Duration::from_millis(200);
const ACTIVE_INPUT_WINDOW_MS: u64 = 500;

enum HostCommand {
    Connected { conn_id: u64, out_tx: mpsc::UnboundedSender<HostToShim> },
    Message { conn_id: u64, msg: ShimToHost },
    Disconnected { conn_id: u64 },
}

struct AppletWindowView {
    view: Entity<HostedView>,
    focus: FocusHandle,
    _sub: Subscription,
}

impl Focusable for AppletWindowView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for AppletWindowView {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().id("applet-window").size_full().child(self.view.clone())
    }
}

struct NativeSession {
    window: AnyWindowHandle,
    focus: FocusHandle,
    remote: Rc<RefCell<Option<RemoteLayer>>>,
    last_input_ms: Arc<AtomicU64>,
    epoch: Instant,
    closed: Arc<AtomicBool>,
}

enum SessionKind {
    Native(NativeSession),
}

struct AppletConnection {
    note_id: Option<String>,
    out_tx: mpsc::UnboundedSender<HostToShim>,
    kind: Option<SessionKind>,
    attach_cancel: Option<CancellationToken>,
}

#[derive(Default)]
struct ActiveSessions {
    conns: HashMap<u64, AppletConnection>,
}

struct HostInner {
    sock_path: PathBuf,
    cancel: CancellationToken,
    sessions: RefCell<ActiveSessions>,
}

#[derive(Clone)]
pub struct AppletHost {
    inner: Rc<HostInner>,
}

impl gpui::Global for AppletHost {}

impl Drop for HostInner {
    fn drop(&mut self) {
        self.cancel.cancel();
        let _ = std::fs::remove_file(&self.sock_path);
    }
}

impl AppletHost {
    pub fn install(cx: &mut App) {
        let home = crate::hosted::server_home();
        let sock_path = socket_path(&home);
        if let Some(parent) = sock_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if sock_path.exists() {
            // Avoid hijacking a live VibeValley instance sharing the same home.
            if std::os::unix::net::UnixStream::connect(&sock_path).is_ok() {
                tracing::warn!(target: "vibevalley::applet", path = %sock_path.display(), "applet socket already active; skipping listener bind");
                return;
            }
            let _ = std::fs::remove_file(&sock_path);
        }

        let rt = vibevalley_rt::current_or_global_handle();
        let listener = {
            let _guard = rt.enter();
            match UnixListener::bind(&sock_path) {
                Ok(listener) => listener,
                Err(err) => {
                    tracing::warn!(target: "vibevalley::applet", path = %sock_path.display(), %err, "failed to bind applet socket");
                    return;
                }
            }
        };

        let cancel = CancellationToken::new();
        let inner = Rc::new(HostInner {
            sock_path,
            cancel: cancel.clone(),
            sessions: RefCell::new(ActiveSessions::default()),
        });
        let host = Self { inner: inner.clone() };
        cx.set_global(host.clone());

        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<HostCommand>();
        rt.spawn(accept_loop(listener, cmd_tx, cancel));
        cx.spawn(async move |cx| {
            while let Some(cmd) = cmd_rx.recv().await {
                cx.update(|cx| handle_command(&inner, cmd, cx));
            }
        })
        .detach();
    }

    pub fn shutdown(cx: &mut App) {
        if !cx.has_global::<Self>() {
            return;
        }
        let host = cx.global::<Self>().clone();
        host.inner.cancel.cancel();
        let conns: Vec<AppletConnection> = {
            let mut guard = host.inner.sessions.borrow_mut();
            guard.conns.drain().map(|(_, c)| c).collect()
        };
        for conn in conns {
            close_connection(conn, cx);
        }
        let _ = std::fs::remove_file(&host.inner.sock_path);
    }

    pub(crate) fn list() -> Result<Vec<AppletInfo>, String> {
        installer::list_installed()
    }

    pub(crate) fn install_applet(req: AppletInstallRequest) -> Result<AppletInfo, String> {
        installer::install(&req)
    }

    pub(crate) fn uninstall_applet(note_id: &str) -> Result<AppletRemoveResult, String> {
        installer::uninstall(note_id)
    }

    pub(crate) fn open_applet(note_id: &str) -> Result<AppletOpenResult, String> {
        installer::open_installed(note_id)
    }
}

async fn accept_loop(listener: UnixListener, cmd_tx: mpsc::UnboundedSender<HostCommand>, cancel: CancellationToken) {
    let mut next_conn_id = 1u64;
    loop {
        let accepted = tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            res = listener.accept() => res,
        };
        let Ok((stream, _)) = accepted else {
            break;
        };
        let conn_id = next_conn_id;
        next_conn_id += 1;
        tokio::spawn(run_connection(conn_id, stream, cmd_tx.clone(), cancel.clone()));
    }
}

async fn run_connection(conn_id: u64, stream: UnixStream, cmd_tx: mpsc::UnboundedSender<HostCommand>, cancel: CancellationToken) {
    let (read_half, mut write_half) = tokio::io::split(stream);
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<HostToShim>();
    if cmd_tx
        .send(HostCommand::Connected {
            conn_id,
            out_tx: out_tx.clone(),
        })
        .is_err()
    {
        return;
    }

    let write_cancel = cancel.clone();
    let writer = tokio::spawn(async move {
        loop {
            let msg = tokio::select! {
                biased;
                _ = write_cancel.cancelled() => break,
                maybe = out_rx.recv() => match maybe {
                    Some(msg) => msg,
                    None => break,
                },
            };
            let Ok(line) = serde_json::to_string(&msg) else {
                continue;
            };
            if write_half.write_all(line.as_bytes()).await.is_err() || write_half.write_all(b"\n").await.is_err() || write_half.flush().await.is_err() {
                break;
            }
        }
    });

    let mut lines = BufReader::new(read_half).lines();
    loop {
        let line = tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            res = lines.next_line() => match res {
                Ok(Some(line)) => line,
                Ok(None) | Err(_) => break,
            },
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<ShimToHost>(trimmed) {
            Ok(msg) => {
                if cmd_tx.send(HostCommand::Message { conn_id, msg }).is_err() {
                    break;
                }
            }
            Err(err) => {
                let _ = out_tx.send(HostToShim::Error {
                    message: format!("invalid shim message: {err}"),
                });
            }
        }
    }

    let _ = cmd_tx.send(HostCommand::Disconnected { conn_id });
    drop(out_tx);
    let _ = writer.await;
}

fn close_connection(mut conn: AppletConnection, cx: &mut App) {
    if let Some(cancel) = conn.attach_cancel.take() {
        cancel.cancel();
    }
    let _ = conn.out_tx.send(HostToShim::Closing);
    if let Some(SessionKind::Native(native)) = conn.kind.take() {
        native.closed.store(true, Ordering::Release);
        if let Some(mut remote) = native.remote.borrow_mut().take() {
            remote.teardown();
        }
        let _ = cx.update_window(native.window, |_, window, _| {
            window.remove_window();
        });
    }
}

fn handle_command(inner: &Rc<HostInner>, cmd: HostCommand, cx: &mut App) {
    match cmd {
        HostCommand::Connected { conn_id, out_tx } => {
            inner.sessions.borrow_mut().conns.insert(
                conn_id,
                AppletConnection {
                    note_id: None,
                    out_tx,
                    kind: None,
                    attach_cancel: None,
                },
            );
        }
        HostCommand::Disconnected { conn_id } => {
            if let Some(conn) = inner.sessions.borrow_mut().conns.remove(&conn_id) {
                close_connection(conn, cx);
            }
        }
        HostCommand::Message { conn_id, msg } => handle_shim_message(inner, conn_id, msg, cx),
    }
}

fn handle_shim_message(inner: &Rc<HostInner>, conn_id: u64, msg: ShimToHost, cx: &mut App) {
    match msg {
        ShimToHost::Attach {
            note_id,
            width,
            height,
            scale,
            display_id,
        } => {
            // Reset any existing session on this socket before attaching the new one.
            let old = {
                let mut guard = inner.sessions.borrow_mut();
                let Some(existing) = guard.conns.get_mut(&conn_id) else {
                    return;
                };
                if let Some(cancel) = existing.attach_cancel.take() {
                    cancel.cancel();
                }
                let cancel = CancellationToken::new();
                existing.attach_cancel = Some(cancel.clone());
                existing.note_id = Some(note_id.clone());
                let prev_kind = existing.kind.take();
                let out_tx = existing.out_tx.clone();
                (prev_kind, out_tx, cancel)
            };
            let (prev_kind, out_tx, attach_cancel) = old;
            if let Some(kind) = prev_kind {
                close_connection(
                    AppletConnection {
                        note_id: None,
                        out_tx: out_tx.clone(),
                        kind: Some(kind),
                        attach_cancel: None,
                    },
                    cx,
                );
            }
            let Some(server) = cx.try_global::<BridgeHub>().map(|h| h.0.server().clone()) else {
                let _ = out_tx.send(HostToShim::Error {
                    message: "VibeValley server bridge is unavailable".to_string(),
                });
                return;
            };
            let rt = vibevalley_rt::current_or_global_handle();
            let (tx, rx) = tokio::sync::oneshot::channel();
            let server_bg = server.clone();
            let note_id_bg = note_id.clone();
            let cancel_bg = attach_cancel.clone();
            rt.spawn(async move {
                let res = prepare_attach(&server_bg, &note_id_bg, &cancel_bg).await;
                let _ = tx.send(res);
            });
            let inner = inner.clone();
            cx.spawn(async move |cx| {
                let Ok(prepared) = rx.await else {
                    return;
                };
                if attach_cancel.is_cancelled() {
                    return;
                }
                match prepared {
                    Err(message) => {
                        let _ = out_tx.send(HostToShim::Error { message });
                    }
                    Ok(note) => {
                        cx.update(|cx| {
                            attach_native(&inner, conn_id, &note, width, height, scale, display_id, out_tx.clone(), cx);
                        });
                    }
                }
            })
            .detach();
        }
        ShimToHost::Resize { width, height, scale } => {
            let native_info = {
                let guard = inner.sessions.borrow();
                guard.conns.get(&conn_id).and_then(|c| match &c.kind {
                    Some(SessionKind::Native(n)) => Some((n.window, n.remote.clone(), n.last_input_ms.clone(), n.epoch)),
                    _ => None,
                })
            };
            if let Some((window_handle, remote, last_input_ms, epoch)) = native_info {
                bump_input(&last_input_ms, epoch);
                let _ = cx.update_window(window_handle, |_, window, _| {
                    window.resize(size(px(width.max(1.0) as f32), px(height.max(1.0) as f32)));
                    window.refresh();
                });
                let remote_guard = remote.borrow();
                if let Some(layer) = remote_guard.as_ref() {
                    layer.resize(width, height, scale);
                    layer.schedule_display();
                }
            }
        }
        ShimToHost::MouseDown {
            x,
            y,
            button,
            click_count,
            modifiers,
        } => {
            dispatch_input(
                inner,
                conn_id,
                PlatformInput::MouseDown(MouseDownEvent {
                    button: button.into(),
                    position: point(px(x as f32), px(y as f32)),
                    modifiers: modifiers.into(),
                    click_count,
                    first_mouse: false,
                }),
                cx,
            );
        }
        ShimToHost::MouseUp {
            x,
            y,
            button,
            click_count,
            modifiers,
        } => {
            dispatch_input(
                inner,
                conn_id,
                PlatformInput::MouseUp(MouseUpEvent {
                    button: button.into(),
                    position: point(px(x as f32), px(y as f32)),
                    modifiers: modifiers.into(),
                    click_count,
                }),
                cx,
            );
        }
        ShimToHost::MouseMove {
            x,
            y,
            pressed_button,
            modifiers,
        } => {
            dispatch_input(
                inner,
                conn_id,
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: point(px(x as f32), px(y as f32)),
                    pressed_button: pressed_button.map(Into::into),
                    modifiers: modifiers.into(),
                }),
                cx,
            );
        }
        ShimToHost::MouseExit { x, y, modifiers } => {
            dispatch_input(
                inner,
                conn_id,
                PlatformInput::MouseExited(MouseExitEvent {
                    position: point(px(x as f32), px(y as f32)),
                    pressed_button: None,
                    modifiers: modifiers.into(),
                }),
                cx,
            );
        }
        ShimToHost::Scroll {
            x,
            y,
            delta_x,
            delta_y,
            precise,
            phase,
            modifiers,
        } => {
            let delta = if precise {
                ScrollDelta::Pixels(point(px(delta_x as f32), px(delta_y as f32)))
            } else {
                ScrollDelta::Lines(point(delta_x as f32, delta_y as f32))
            };
            dispatch_input(
                inner,
                conn_id,
                PlatformInput::Scroll(ScrollEvent {
                    position: point(px(x as f32), px(y as f32)),
                    delta,
                    modifiers: modifiers.into(),
                    touch_phase: phase.into(),
                    source: ScrollSource::Pointer,
                }),
                cx,
            );
        }
        ShimToHost::KeyDown {
            key,
            key_char,
            is_held,
            modifiers,
        } => {
            dispatch_input(
                inner,
                conn_id,
                PlatformInput::KeyDown(KeyDownEvent {
                    keystroke: Keystroke {
                        modifiers: modifiers.into(),
                        key,
                        key_char,
                    },
                    is_held,
                    prefer_character_input: false,
                }),
                cx,
            );
        }
        ShimToHost::KeyUp { key, key_char, modifiers } => {
            dispatch_input(
                inner,
                conn_id,
                PlatformInput::KeyUp(KeyUpEvent {
                    keystroke: Keystroke {
                        modifiers: modifiers.into(),
                        key,
                        key_char,
                    },
                }),
                cx,
            );
        }
        ShimToHost::ModifiersChanged { modifiers } => {
            dispatch_input(
                inner,
                conn_id,
                PlatformInput::ModifiersChanged(ModifiersChangedEvent {
                    modifiers: modifiers.into(),
                    capslock: Default::default(),
                }),
                cx,
            );
        }
        ShimToHost::Focus { focused } => {
            let native_info = {
                let guard = inner.sessions.borrow();
                guard.conns.get(&conn_id).and_then(|c| match &c.kind {
                    Some(SessionKind::Native(n)) => Some((n.window, n.focus.clone(), n.remote.clone(), n.last_input_ms.clone(), n.epoch)),
                    _ => None,
                })
            };
            if focused && let Some((window_handle, focus, remote, last_input_ms, epoch)) = native_info {
                bump_input(&last_input_ms, epoch);
                let _ = cx.update_window(window_handle, |_, window, cx| {
                    window.focus(&focus, cx);
                    window.refresh();
                });
                if let Some(layer) = remote.borrow().as_ref() {
                    layer.schedule_display();
                }
            }
        }
        ShimToHost::OpenInHost => {
            let note_id = inner.sessions.borrow().conns.get(&conn_id).and_then(|c| c.note_id.clone());
            if let Some(id) = note_id {
                open_note_in_host(&id, cx);
            }
        }
        ShimToHost::Detach => {
            if let Some(conn) = inner.sessions.borrow_mut().conns.remove(&conn_id) {
                close_connection(conn, cx);
            }
        }
    }
}

fn bump_input(last_input_ms: &AtomicU64, epoch: Instant) {
    last_input_ms.store(epoch.elapsed().as_millis() as u64, Ordering::Relaxed);
}

fn dispatch_input(inner: &Rc<HostInner>, conn_id: u64, input: PlatformInput, cx: &mut App) {
    let native_info = {
        let guard = inner.sessions.borrow();
        guard.conns.get(&conn_id).and_then(|c| match &c.kind {
            Some(SessionKind::Native(n)) => Some((n.window, n.remote.clone(), n.last_input_ms.clone(), n.epoch)),
            _ => None,
        })
    };
    let Some((window_handle, remote, last_input_ms, epoch)) = native_info else {
        return;
    };
    bump_input(&last_input_ms, epoch);
    let _ = cx.update_window(window_handle, |_, window, cx| {
        let _ = window.dispatch_event(input, cx);
        window.refresh();
    });
    if let Some(layer) = remote.borrow().as_ref() {
        layer.schedule_display();
    }
}

async fn fetch_note(server: &Arc<dyn Server>, note_id: &str) -> Result<Note, String> {
    let env = Arc::clone(server)
        .call_with_async(CallerContext::local(), "note.get".into(), json!({ "id": note_id }))
        .await;
    if env.biz_code != 0 {
        return Err(env.message);
    }
    let data = env.data.ok_or_else(|| "note.get returned empty payload".to_string())?;
    serde_json::from_value(data).map_err(|e| format!("decode note.get: {e}"))
}

/// Runs all server RPCs and SQLite-backed loads inside the Tokio runtime context.
async fn prepare_attach(server: &Arc<dyn Server>, note_id: &str, cancel: &CancellationToken) -> Result<Note, String> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("attach cancelled".to_string()),
        res = fetch_note(server, note_id) => res,
    }
}

fn resolve_display_id(display_id: Option<u32>, cx: &App) -> Option<DisplayId> {
    let raw = display_id?;
    let target = DisplayId::from(u64::from(raw));
    cx.displays().into_iter().find(|d| d.id() == target).map(|d| d.id())
}

#[allow(clippy::too_many_arguments)]
fn attach_native(
    inner: &Rc<HostInner>,
    conn_id: u64,
    note: &Note,
    width: f64,
    height: f64,
    scale: f64,
    display_id: Option<u32>,
    out_tx: mpsc::UnboundedSender<HostToShim>,
    cx: &mut App,
) {
    let w = width.max(1.0) as f32;
    let h = height.max(1.0) as f32;
    let bounds = Bounds::new(point(px(0.0), px(0.0)), size(px(w), px(h)));
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        titlebar: None,
        focus: false,
        show: false,
        is_movable: false,
        is_resizable: true,
        is_minimizable: false,
        display_id: resolve_display_id(display_id, cx),
        ..Default::default()
    };

    let dark = cx.try_global::<Ui>().is_some_and(|ui| ui.colors.dark);
    let route = format!("/standalone/note/{}", note.id);
    let mut params: Map<String, Value> = Map::new();
    params.insert("route".into(), json!(route));
    params.insert("applet".into(), json!(true));
    let mut focus_out: Option<FocusHandle> = None;

    let open_result = cx.open_window(options, |window, cx| {
        cx.new(|cx| {
            let view = cx.new(|cx| HostedView::new("vv", params, dark, window, cx));
            let sub = cx.subscribe_in(&view, window, |_, _, event: &HostedEvent, _, cx| {
                if let HostedEvent::HostCall { op, reply } = event {
                    handle_standalone_host_call(op.clone(), reply.clone(), cx);
                }
            });
            let focus = view.read(cx).focus_handle(cx);
            focus_out = Some(focus.clone());
            window.focus(&focus, cx);
            AppletWindowView { view, focus, _sub: sub }
        })
    });

    let window_handle = match open_result {
        Ok(handle) => handle,
        Err(err) => {
            let _ = out_tx.send(HostToShim::Error {
                message: format!("failed to open note window: {err}"),
            });
            return;
        }
    };
    let any_window: AnyWindowHandle = window_handle.into();
    let Some(focus) = focus_out else {
        let _ = any_window.update(cx, |_, window, _| window.remove_window());
        return;
    };

    let remote_res = any_window.update(cx, |_, window, _| RemoteLayer::attach(window, width, height, scale));
    let remote = match remote_res {
        Ok(Ok(layer)) => layer,
        Ok(Err(message)) => {
            let _ = any_window.update(cx, |_, window, _| window.remove_window());
            let _ = out_tx.send(HostToShim::Error { message });
            return;
        }
        Err(err) => {
            let _ = out_tx.send(HostToShim::Error {
                message: format!("failed to attach remote layer: {err}"),
            });
            return;
        }
    };

    let context_id = remote.context_id();
    let remote_slot = Rc::new(RefCell::new(Some(remote)));
    let epoch = Instant::now();
    let last_input_ms = Arc::new(AtomicU64::new(0));
    let closed = Arc::new(AtomicBool::new(false));

    let installed = {
        let mut guard = inner.sessions.borrow_mut();
        if let Some(conn) = guard.conns.get_mut(&conn_id) {
            conn.attach_cancel = None;
            conn.kind = Some(SessionKind::Native(NativeSession {
                window: any_window,
                focus,
                remote: remote_slot.clone(),
                last_input_ms: last_input_ms.clone(),
                epoch,
                closed: closed.clone(),
            }));
            true
        } else {
            false
        }
    };
    if !installed {
        closed.store(true, Ordering::Release);
        if let Some(mut layer) = remote_slot.borrow_mut().take() {
            layer.teardown();
        }
        let _ = any_window.update(cx, |_, window, _| window.remove_window());
        return;
    }

    let _ = out_tx.send(HostToShim::ReadyLayer {
        context_id,
        title: note.title.clone(),
        note_type: note.note_type.as_str().to_string(),
    });

    // Initial render + adaptive timer: 60Hz during active input, ~5Hz idle for live CRDT edits.
    let _ = any_window.update(cx, |_, window, _| window.refresh());
    if let Some(layer) = remote_slot.borrow().as_ref() {
        layer.schedule_display();
    }

    cx.spawn(async move |cx| {
        loop {
            let elapsed_since_input = epoch.elapsed().as_millis() as u64 - last_input_ms.load(Ordering::Relaxed);
            let interval = if elapsed_since_input < ACTIVE_INPUT_WINDOW_MS {
                ACTIVE_FRAME_INTERVAL
            } else {
                IDLE_FRAME_INTERVAL
            };
            cx.background_executor().timer(interval).await;
            if closed.load(Ordering::Acquire) {
                break;
            }
            let refreshed = cx
                .update_window(any_window, |_, window, _| {
                    window.refresh();
                })
                .is_ok();
            if !refreshed {
                break;
            }
            // Trigger `displayLayer:` strictly outside `cx.update_window` so `AppCell` is not borrowed.
            if let Some(layer) = remote_slot.borrow().as_ref() {
                layer.schedule_display();
            } else {
                break;
            }
        }
    })
    .detach();
}

fn handle_standalone_host_call(op: HostOp, reply: crate::host_types::Replier, cx: &mut App) {
    if let Some(env) = crate::host::handle_stateless_op(&op) {
        reply.send(env);
        return;
    }
    let env = match op {
        HostOp::Info => Envelope::ok(json!({
            "name": "desktop",
            "version": crate::env::bundle_version(),
            "titleBar": { "top": 0, "left": 0 },
            "terminal": false,
            "theme": Ui::get(cx).settings.theme.as_str(),
            "motion": Ui::get(cx).settings.effective_motion().as_str(),
            "capabilities": ["openUrl", "openFile", "assetsDir", "playAudio", "readFile", "saveFile"],
        })),
        HostOp::OpenUrl(req) => match url::Url::parse(&req.url) {
            Ok(parsed) if matches!(parsed.scheme(), "http" | "https" | "mailto") => {
                cx.open_url(&req.url);
                Envelope::void()
            }
            _ => refusal(BizCode::InvalidInput, "openUrl allows only http, https, and mailto URLs"),
        },
        HostOp::OpenFile(req) if req.path.starts_with('/') => {
            let path = PathBuf::from(req.path);
            if path.exists() {
                let _ = crate::host::open(&path);
                Envelope::void()
            } else {
                refusal(BizCode::InvalidInput, "openFile takes the absolute path of an existing file")
            }
        }
        HostOp::AssetsDir => {
            let dir = crate::assets::assets_dir();
            if dir.is_dir() {
                Envelope::ok(json!({ "path": dir }))
            } else {
                refusal(BizCode::NotFound, "the assets directory is not installed")
            }
        }
        HostOp::PlayAudio(req) => {
            crate::audio::dispatch(reply, move || crate::audio::play(Path::new(&req.path), req.position.unwrap_or(0.0)));
            return;
        }
        HostOp::PlaySound(req) => {
            let name = req.name;
            crate::audio::dispatch(reply, move || crate::audio::play_sound(name));
            return;
        }
        HostOp::StopAudio => {
            crate::audio::dispatch(reply, || {
                crate::audio::stop();
                Ok(())
            });
            return;
        }
        HostOp::ReadFile(req) => {
            let path = crate::host::percent_decode(req.path.strip_prefix("file://").unwrap_or(&req.path));
            if !path.starts_with('/') {
                refusal(BizCode::InvalidInput, "readFile takes an absolute path or a file: URL")
            } else {
                match crate::host::read_file(Path::new(&path)) {
                    Ok(val) => Envelope::ok(val),
                    Err(e) => refusal(BizCode::InvalidInput, e),
                }
            }
        }
        _ => refusal(BizCode::Refused, "host capability is unavailable inside standalone applet window"),
    };
    reply.send(env);
}

type OpenNoteFn = Arc<dyn Fn(&str, &mut App) + Send + Sync>;

struct OpenNoteHandler(OpenNoteFn);

impl gpui::Global for OpenNoteHandler {}

pub fn set_open_note_handler(cx: &mut App, handler: impl Fn(&str, &mut App) + Send + Sync + 'static) {
    cx.set_global(OpenNoteHandler(Arc::new(handler)));
}

fn open_note_in_host(note_id: &str, cx: &mut App) {
    if let Some(handler) = cx.try_global::<OpenNoteHandler>().map(|h| h.0.clone()) {
        handler(note_id, cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_socket_ndjson_roundtrip_and_invalid_json_reports_error() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("applet.sock");
        vibevalley_rt::block_on(async move {
            let listener = UnixListener::bind(&sock).unwrap();
            let cancel = CancellationToken::new();
            let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel();
            let accept = tokio::spawn(accept_loop(listener, cmd_tx, cancel.clone()));

            let stream = UnixStream::connect(&sock).await.unwrap();
            let (r, mut w) = tokio::io::split(stream);
            let mut lines = BufReader::new(r).lines();

            // Send invalid JSON line -> expect HostToShim::Error back on the socket.
            w.write_all(b"{\"type\":\"bogus\"}\n").await.unwrap();
            w.flush().await.unwrap();
            let err_line = lines.next_line().await.unwrap().unwrap();
            let err_msg: HostToShim = serde_json::from_str(&err_line).unwrap();
            assert!(matches!(err_msg, HostToShim::Error { .. }));

            // Send valid ShimToHost::OpenInHost and Detach -> verify cmd_rx receives them in order.
            w.write_all(b"{\"type\":\"openInHost\"}\n{\"type\":\"detach\"}\n").await.unwrap();
            w.flush().await.unwrap();

            let mut received = Vec::new();
            for _ in 0..4 {
                let Ok(cmd) = tokio::time::timeout(Duration::from_secs(2), cmd_rx.recv()).await else {
                    break;
                };
                if let Some(cmd) = cmd {
                    received.push(cmd);
                }
            }
            assert!(matches!(received.first(), Some(HostCommand::Connected { .. })));
            assert!(matches!(
                received.get(1),
                Some(HostCommand::Message {
                    msg: ShimToHost::OpenInHost,
                    ..
                })
            ));
            assert!(matches!(received.get(2), Some(HostCommand::Message { msg: ShimToHost::Detach, .. })));

            drop(w);
            cancel.cancel();
            let _ = accept.await;
        });
    }
}

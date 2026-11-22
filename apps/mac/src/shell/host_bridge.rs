use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::OnceLock;

use gpui::{AppContext as _, Context, Entity, PathPromptOptions, Subscription, Window};
use serde_json::{Value, json};
use vibevalley_workspace::PaneKind;

use crate::hosted::{Action, HostedEvent, HostedView};
use crate::theme::{MotionChoice, ThemeChoice, Ui};

use super::panes::percent_decode;
use super::{Shell, update_menus};

impl Shell {
    pub fn on_action(&mut self, action: Action, window: &mut Window, cx: &mut Context<Self>) {
        let active = self.ws.active_id();
        match action {
            Action::GlobalRail { rail_width } => {
                self.global_rail_width = rail_width.clamp(56.0, 80.0);
                cx.notify();
            }
            Action::GlobalRoute { path } => {
                self.native_workspace = path == "/workspace";
                if self.native_workspace {
                    self.with_workspace_project(window, cx, |_, _, _, _| {});
                }
                if !path.starts_with("/farm") && path != "/tree" && path != "/map" {
                    self.native_pixel = None;
                }
                if self.last_route.as_deref() != Some(path.as_str()) {
                    self.last_route = Some(path);
                    self.save_settings(cx);
                }
                cx.notify();
            }
            Action::OpenRoute { path } => self.navigate_workbench(&path, cx),
            Action::Applied { .. }
            | Action::Ready
            | Action::DismissFarmForm
            | Action::FarmHandset { .. }
            | Action::FarmCall { .. }
            | Action::SilenceFarmPhone => {}
            Action::Probe { results } => {
                eprintln!("bridge probe: {results}");
                self.probe = Some(results);
            }
            Action::Call { op, .. } => eprintln!("host call {op} reached the shell without a reply handle"),
            Action::OpenTerminal { cwd, title, command } => {
                self.open_terminal_at(cwd, title, command, window, cx, |_| {});
            }
            Action::ActivateProject { id } => {
                if let Some(project) = self.ws.project(id) {
                    self.with_project_at(project.root().to_owned(), window, cx, |s, result, window, cx| {
                        if let Ok(id) = result {
                            s.activate_project(id, window, cx);
                        }
                    });
                }
            }
            Action::ActivatePath { path } => self.activate_path(path, window, cx, |_, _, _| {}),
            Action::ActivateTab { path, tab_id } => self.activate_path(path, window, cx, move |s, window, cx| {
                if let Some(p) = s.ws.active_mut() {
                    p.layout.activate(tab_id);
                }
                s.layout_changed(window, cx);
            }),
            Action::CloseTabAt { path, tab_id } => self.activate_path(path, window, cx, move |s, window, cx| s.close_tab(tab_id, window, cx)),
            Action::NewTerminalAt { path } => {
                self.open_terminal_at(path, None, None, window, cx, |_| {});
            }
            Action::NewChatAt { path, runtime } => {
                self.open_chat_at(path, runtime, window, cx);
            }
            Action::OpenFileAdjacent { path, line } => {
                self.open_file_adjacent(path, line, window, cx);
            }
            Action::OpenDiffAdjacent { path, staged } => {
                self.open_diff_adjacent(path, staged, window, cx);
            }
            Action::UpdateChatTab {
                tab_id,
                session_id,
                runtime,
                title,
                status,
                attention,
            } => {
                self.update_chat_tab(tab_id, session_id, runtime, title, status, attention, cx);
            }
            Action::AddProject => self.add_project(window, cx),
            Action::CloseProject { id } => self.close_project(id, cx),
            Action::ShowPanel { panel } => {
                self.panel = panel;
                self.inspector_open = true;
                self.push_sidebar(cx);
                cx.notify();
            }
            Action::ExpandDir { path } => {
                if let Some(id) = active
                    && let Some(pv) = self.projects.get_mut(&id)
                {
                    pv.tree.expanded.insert(path);
                    self.load_dirs(id, cx);
                }
            }
            Action::CollapseDir { path } => {
                if let Some(pv) = active.and_then(|id| self.projects.get_mut(&id)) {
                    pv.tree.expanded.remove(&path);
                }
                self.push_sidebar(cx);
            }
            Action::OpenFile { path } => self.open_file(path, None, window, cx),
            Action::OpenFarm { repo } => {
                let props = if repo.is_empty() { json!({}) } else { json!({ "repo": repo }) };
                self.show_pixel("farm", props, window, cx)
            }
            Action::OpenRepoMap => self.show_pixel("map", json!({}), window, cx),
            Action::OpenTree => self.show_pixel("tree", json!({}), window, cx),
            Action::RevealInTerminal { path } => {
                let dir = if path.is_dir() {
                    path
                } else {
                    path.parent().map(Path::to_path_buf).unwrap_or(path)
                };
                self.open_terminal_at(dir, None, None, window, cx, |_| {});
            }
            Action::OpenDiff { path, staged } => {
                let spec = if staged {
                    vibevalley_workspace::DiffSpec::Staged
                } else {
                    vibevalley_workspace::DiffSpec::Unstaged
                };
                self.open_pane(PaneKind::Diff { spec, path, repo: None }, window, cx);
            }
            Action::OpenCommit { id } => self.open_pane(
                PaneKind::Diff {
                    spec: vibevalley_workspace::DiffSpec::Commit { id },
                    path: None,
                    repo: None,
                },
                window,
                cx,
            ),
            Action::Stage { paths } => self.git_op(move |r| r.stage(&paths), cx),
            Action::Unstage { paths } => self.git_op(move |r| r.unstage(&paths), cx),
            Action::Discard { paths } => self.git_op(move |r| r.discard(&paths), cx),
            Action::Commit { message } => self.git_op(move |r| r.commit(&message).map(|_| ()), cx),
            Action::Checkout { branch } => self.git_op(move |r| r.checkout(&branch), cx),
            Action::AddWorktree { branch } => self.add_worktree(branch, window, cx),
            Action::RemoveWorktree { path, force } => self.remove_worktree(path, force, window, cx),
            Action::RefreshGit => {
                if let Some(id) = active {
                    self.refresh_git(id, cx);
                }
            }
            Action::PaletteQuery { query } => {
                if let Some(p) = &mut self.palette {
                    p.query = query;
                }
                self.refresh_palette(cx);
            }
            Action::PaletteSelect { id } => self.palette_select(&id, window, cx),
            Action::PaletteClose => self.close_palette(window, cx),
            Action::Search { query, regex, case_sensitive } => {
                if let Some(p) = &mut self.palette {
                    p.query = query;
                }
                self.run_search(regex, case_sensitive, cx);
            }
            Action::OpenHit { path, line } => self.open_file(path, Some(line), window, cx),
        }
    }

    /// A pixel scene's ask: a VibeValley page (the hosted `vv` view, given
    /// the route) or a terminal.
    pub fn on_pixel_event(&mut self, event: crate::pixel::view::PixelEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            crate::pixel::view::PixelEvent::Sound(name) => self.workbench.read(cx).play_farm_sound(name, cx),
            crate::pixel::view::PixelEvent::HostCall { op, payload, reply } => self.host_call(&op, payload, reply, window, cx),
            crate::pixel::view::PixelEvent::Route(route) => self.open_pane(
                PaneKind::Hosted {
                    module: "vv".into(),
                    props: json!({ "route": route }),
                },
                window,
                cx,
            ),
            crate::pixel::view::PixelEvent::Pixel { scene, props } => self.open_pane(PaneKind::Pixel { scene, props }, window, cx),
            crate::pixel::view::PixelEvent::Terminal { cwd, title } => {
                self.open_terminal_at(PathBuf::from(cwd), Some(title), None, window, cx, |_| {});
            }
        }
    }

    /// The `host.*` ops of the bridge: VibeValley's host capabilities
    /// (packages/protocol/src/host.ts) and VibeValley's terminal.
    pub fn host_call(&mut self, op: &str, payload: Value, reply: crate::hosted::Replier, window: &mut Window, cx: &mut Context<Self>) {
        use vibevalley_server::transport::bridge::{BizCode, Envelope, refusal};
        if op.starts_with("host.update") {
            return crate::update::host_call(op, reply, cx);
        }
        let text = |k: &str| payload[k].as_str().unwrap_or_default().to_string();
        let envelope = match op {
            "host.info" => {
                let settings = &Ui::get(cx).settings;
                static MONO_FONTS: OnceLock<Vec<String>> = OnceLock::new();
                let fonts = MONO_FONTS.get_or_init(|| {
                    let mut fonts: Vec<String> = window
                        .text_system()
                        .all_font_names()
                        .into_iter()
                        .filter(|name| {
                            let lower = name.to_lowercase();
                            lower.contains("nerd")
                                || lower.contains(" nf")
                                || lower.contains("-nf")
                                || lower.contains("mono")
                                || lower.contains("menlo")
                                || lower.contains("monaco")
                                || lower.contains("consolas")
                                || lower.contains("courier")
                                || lower.contains("fira code")
                                || lower.contains("sarasa")
                                || lower.contains("maple")
                        })
                        .collect();
                    fonts.sort();
                    fonts.dedup();
                    fonts
                });
                Envelope::ok(json!({
                    "name": "desktop",
                    "version": crate::update::version(),
                    "titleBar": { "top": 28, "left": 68 },
                    "terminal": true,
                    "monoFont": settings.mono_font,
                    "monoFonts": fonts,
                    "terminalFontSize": settings.terminal_font_size,
                    "uiFontSize": settings.ui_font_size,
                    "motion": settings.effective_motion().as_str(),
                    "capabilities": ["notify", "tray", "locale", "reveal", "theme", "motion", "font", "opening", "openTerminal", "openUrl", "openFile", "pixelDir", "playAudio", "readFile", "commandLine", "seekAudio", "pcm", "pickFile", "saveFile", "update", "mossVoice"],
                }))
            }
            "host.cliState" | "host.cliInstall" | "host.cliRemove" => {
                let op = op.to_string();
                Self::bg(
                    cx,
                    move || {
                        let cli = crate::command_line::CommandLine::current()?;
                        match op.as_str() {
                            "host.cliInstall" => cli.install(),
                            "host.cliRemove" => cli.remove(),
                            _ if cli.available() => Ok(cli.state()),
                            _ => Err("the CLI is not installed beside the app".into()),
                        }
                    },
                    move |_, result, _| {
                        reply.send(match result {
                            Ok(state) => Envelope::ok(json!(state)),
                            Err(error) => refusal(BizCode::Refused, error),
                        })
                    },
                );
                return;
            }
            "host.font" => {
                let was_ui = Ui::get(cx).settings.ui_font_size;
                let mut settings = Ui::get(cx).settings.clone();
                if let Some(family) = payload["monoFont"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    settings.mono_font = family.to_string();
                }
                if let Some(size) = payload["terminalFontSize"].as_f64() {
                    settings.terminal_font_size = (size as f32).clamp(9.0, 32.0);
                }
                if let Some(size) = payload["uiFontSize"].as_f64() {
                    settings.ui_font_size = (size as f32).clamp(10.0, 24.0);
                }
                let mono = settings.mono_font.clone();
                let term_size = settings.terminal_font_size;
                let ui_size = settings.ui_font_size;
                Ui::apply(settings, cx);
                if (ui_size - was_ui).abs() > 0.01 {
                    self.apply_ui_font_size(cx);
                }
                self.save_settings(cx);
                cx.notify();
                Envelope::ok(json!({
                    "monoFont": mono,
                    "terminalFontSize": term_size,
                    "uiFontSize": ui_size,
                }))
            }
            "host.notify" => {
                let (title, body) = (text("title"), text("body"));
                Self::bg(
                    cx,
                    move || crate::host::notify(&title, &body),
                    |_, r, _| {
                        if let Err(e) = r {
                            eprintln!("notify: {e}");
                        }
                    },
                );
                Envelope::void()
            }
            "host.tray" => match serde_json::from_value::<crate::tray::Summary>(payload.clone()) {
                Ok(summary) => {
                    crate::tray::update(&summary);
                    self.tray = Some(payload.clone());
                    Envelope::void()
                }
                Err(error) => refusal(BizCode::InvalidInput, error.to_string()),
            },
            "host.locale" => match payload.as_str() {
                Some(loc @ ("zh" | "en")) => {
                    vibevalley_i18n::set_locale(loc);
                    update_menus(cx);
                    crate::tray::refresh();
                    self.notify_locale(loc, cx);
                    self.locale = Some(loc.to_string());
                    Envelope::void()
                }
                _ => refusal(BizCode::InvalidInput, "locale is zh or en"),
            },
            "host.reveal" => match payload.as_str() {
                Some(path) if path.starts_with('/') => {
                    let path = PathBuf::from(path);
                    Self::bg(cx, move || crate::host::reveal(&path), |_, _, _| {});
                    Envelope::void()
                }
                _ => refusal(BizCode::InvalidInput, "reveal takes an absolute path"),
            },
            "host.theme" => {
                let choice = match payload.as_str() {
                    Some("light") => Some(ThemeChoice::Light),
                    Some("dark") => Some(ThemeChoice::Dark),
                    Some("system") => Some(ThemeChoice::System),
                    _ => None,
                };
                match choice {
                    Some(choice) => {
                        self.set_theme(choice, cx);
                        Envelope::void()
                    }
                    None => refusal(BizCode::InvalidInput, "theme is light, dark or system"),
                }
            }
            "host.motion" => match payload.as_str().and_then(MotionChoice::parse) {
                Some(choice) => {
                    self.set_motion(choice, cx);
                    Envelope::void()
                }
                None => refusal(BizCode::InvalidInput, "motion is off, on or system"),
            },
            "host.opening" => match serde_json::from_value::<crate::serving::Opening>(payload.clone()) {
                Ok(state) => {
                    if let Some(opening) = &self.launch {
                        opening.update(cx, |view, _| view.set_phase(state.phase.pixel(), state.progress.clamp(0.0, 100.0)));
                    }
                    self.opening = Some(payload.clone());
                    if state.phase == crate::serving::OpeningPhase::Ready {
                        self.finish_opening(true, cx);
                    }
                    cx.notify();
                    Envelope::void()
                }
                Err(error) => refusal(BizCode::InvalidInput, error.to_string()),
            },
            "host.openTerminal" => {
                let cwd = PathBuf::from(text("cwd"));
                let title = payload["title"].as_str().map(str::to_string);
                let command = payload["command"].as_str().map(str::to_string);
                self.open_terminal_at(cwd, title, command, window, cx, move |result| {
                    reply.send(match result {
                        Ok(id) => Envelope::ok(json!({ "terminalId": id })),
                        Err(reason) => refusal(BizCode::Refused, reason),
                    })
                });
                return;
            }
            "host.openUrl" => {
                let url = text("url");
                if url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:") {
                    cx.open_url(&url);
                    Envelope::void()
                } else {
                    refusal(BizCode::InvalidInput, "only http(s) and mailto URLs open")
                }
            }
            "host.openFile" if payload.get("worktree").is_some() => {
                let relative = text("path");
                let Some((root, file)) = crate::host::worktree_file(Path::new(&text("worktree")), Path::new(&relative)) else {
                    return reply.send(refusal(
                        BizCode::Refused,
                        vibevalley_i18n::t("desktop.files.missingInWorktree", &[("path", relative.into())]),
                    ));
                };
                self.with_project_at(root, window, cx, move |s, id, window, cx| {
                    reply.send(match id {
                        Ok(id) => {
                            s.activate_project(id, window, cx);
                            s.open_file(file, None, window, cx);
                            Envelope::void()
                        }
                        Err(why) => refusal(BizCode::Refused, why),
                    });
                });
                return;
            }
            // Opens a file in the system's default app (a PDF, a picture).
            "host.openFile" => match payload["path"].as_str() {
                Some(path) if path.starts_with('/') => {
                    let path = PathBuf::from(path);
                    Self::bg(
                        cx,
                        move || {
                            if !path.exists() {
                                return Err(false);
                            }
                            if let Err(e) = crate::host::open(&path) {
                                eprintln!("open: {e}");
                            }
                            Ok(())
                        },
                        move |_, result, _| {
                            reply.send(match result {
                                Ok(()) => Envelope::void(),
                                Err(_) => refusal(BizCode::InvalidInput, "openFile takes the absolute path of an existing file"),
                            });
                        },
                    );
                    return;
                }
                _ => refusal(BizCode::InvalidInput, "openFile takes the absolute path of an existing file"),
            },
            "host.pickFile" => {
                let chosen = cx.prompt_for_paths(PathPromptOptions {
                    files: true,
                    directories: false,
                    multiple: false,
                    prompt: None,
                });
                cx.spawn(async move |_, cx| {
                    let result = match chosen.await {
                        Ok(Ok(Some(paths))) => match paths.into_iter().next() {
                            Some(path) => cx.background_spawn(async move { crate::host::file_info(&path) }).await.map(Some),
                            None => Ok(None),
                        },
                        Ok(Ok(None)) => Ok(None),
                        Ok(Err(error)) => Err(error.to_string()),
                        Err(error) => Err(error.to_string()),
                    };
                    reply.send(match result {
                        Ok(file) => Envelope::ok(json!(file)),
                        Err(error) => refusal(BizCode::Refused, error),
                    });
                })
                .detach();
                return;
            }
            "host.saveFile" => {
                let source = PathBuf::from(text("path"));
                if !source.is_absolute() {
                    reply.send(refusal(BizCode::InvalidInput, "saveFile requires an absolute path to a regular file"));
                    return;
                }
                let requested_name = payload["name"]
                    .as_str()
                    .filter(|n| !n.is_empty() && !n.contains('/') && !n.contains('\\'))
                    .map(str::to_string);
                cx.spawn(async move |_, cx| {
                    let probe = source.clone();
                    let is_file = cx.background_spawn(async move { probe.is_file() }).await;
                    if !is_file {
                        reply.send(refusal(BizCode::InvalidInput, "saveFile requires an absolute path to a regular file"));
                        return;
                    }
                    let directory = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
                    let chosen = cx.update(|cx| {
                        let name = requested_name.as_deref().or_else(|| source.file_name().and_then(|s| s.to_str()));
                        cx.prompt_for_new_path(&directory, name)
                    });
                    let result = match chosen.await {
                        Ok(Ok(Some(target))) => cx.background_spawn(async move { crate::host::copy_file(&source, &target).map(|_| true) }).await,
                        Ok(Ok(None)) => Ok(false),
                        Ok(Err(error)) => Err(error.to_string()),
                        Err(error) => Err(error.to_string()),
                    };
                    reply.send(match result {
                        Ok(saved) => Envelope::ok(json!({"saved": saved})),
                        Err(error) => refusal(BizCode::Refused, error),
                    });
                })
                .detach();
                return;
            }
            "host.speechState" => Envelope::ok(json!(crate::speech_audio::state(&text("id")))),
            "host.speechStart" => {
                let id = text("id");
                Self::bg(
                    cx,
                    move || crate::serving::speech().and_then(|speech| crate::speech_audio::start(speech, &id)),
                    move |_, result, _| {
                        reply.send(match result {
                            Ok(state) => Envelope::ok(json!(state)),
                            Err(error) => refusal(BizCode::Refused, error),
                        });
                    },
                );
                return;
            }
            "host.speechStop" => Envelope::ok(json!(crate::speech_audio::stop(Some(&text("id"))))),
            "host.voiceState" => Envelope::ok(json!(crate::live_voice::state(&text("id")))),
            "host.voiceStart" => {
                let id = text("id");
                Self::bg(
                    cx,
                    move || crate::serving::voice().and_then(|voice| crate::live_voice::start(voice, id)),
                    move |_, result, _| {
                        reply.send(match result {
                            Ok(state) => Envelope::ok(json!(state)),
                            Err(error) => refusal(BizCode::Refused, error),
                        });
                    },
                );
                return;
            }
            "host.voiceStop" => Envelope::ok(json!(crate::live_voice::stop(Some(&text("id"))))),
            "host.voiceMute" => match payload["muted"].as_bool() {
                Some(muted) => Envelope::ok(json!(crate::live_voice::mute(&text("id"), muted))),
                None => refusal(BizCode::InvalidInput, "voiceMute requires a boolean muted value"),
            },
            "host.playAudio" => {
                let seconds = payload["position"].as_f64().unwrap_or(0.0);
                let path = payload["path"].as_str().map(PathBuf::from);
                crate::audio::dispatch(reply, move || match path {
                    Some(path) => crate::audio::play(&path, seconds),
                    None => Err("playAudio requires a file path".into()),
                });
                return;
            }
            "host.playSound" => {
                #[derive(serde::Deserialize)]
                #[serde(deny_unknown_fields)]
                struct PlaySoundRequest {
                    name: crate::audio::SoundName,
                }
                match serde_json::from_value::<PlaySoundRequest>(payload.clone()) {
                    Ok(req) => {
                        crate::audio::dispatch(reply, move || crate::audio::play_sound(req.name));
                        return;
                    }
                    Err(e) => refusal(BizCode::InvalidInput, format!("playSound: {e}")),
                }
            }
            "host.seekAudio" => {
                let seconds = payload["position"].as_f64().unwrap_or(f64::NAN);
                crate::audio::dispatch(reply, move || crate::audio::seek(seconds));
                return;
            }
            "host.audioState" => {
                crate::audio::dispatch(reply, || Ok(crate::audio::state()));
                return;
            }
            "host.pcmStart" => {
                let format = serde_json::from_value::<crate::audio::PcmFormat>(payload.clone());
                crate::audio::dispatch(reply, move || crate::audio::start_pcm(format.map_err(|e| e.to_string())?));
                return;
            }
            "host.pcmAppend" => {
                let data = text("data");
                crate::audio::dispatch(reply, move || crate::audio::append_pcm(&data));
                return;
            }
            // A file the user dropped on a view: nsh gives views file: URLs
            // and no way to read them.
            "host.readFile" => {
                let path = payload["path"].as_str().unwrap_or_default();
                let path = path.strip_prefix("file://").unwrap_or(path);
                let path = percent_decode(path);
                if !path.starts_with('/') {
                    refusal(BizCode::InvalidInput, "readFile takes an absolute path or a file: URL")
                } else {
                    let path = PathBuf::from(path);
                    Self::bg(
                        cx,
                        move || crate::host::read_file(&path),
                        move |_, r, _| {
                            reply.send(match r {
                                Ok(v) => Envelope::ok(v),
                                Err(e) => refusal(BizCode::InvalidInput, e),
                            });
                        },
                    );
                    return;
                }
            }
            "host.stopAudio" => {
                crate::audio::dispatch(reply, || {
                    crate::audio::stop();
                    Ok(())
                });
                return;
            }
            // VibeValley's built pixel art: sprites.json and its PNGs.
            "host.pixelDir" => {
                Self::bg(
                    cx,
                    || {
                        let dir = crate::pixel::assets_dir().join("pixel");
                        dir.join("sprites.json").is_file().then_some(dir)
                    },
                    move |_, found, _| {
                        reply.send(match found {
                            Some(dir) => Envelope::ok(json!({ "path": dir })),
                            None => refusal(BizCode::NotFound, "the pixel art is not installed"),
                        });
                    },
                );
                return;
            }
            other => match crate::host::handle_stateless_op(other, &payload) {
                Some(env) => env,
                None => refusal(BizCode::RouteNotFound, format!("the host has no op {other}")),
            },
        };
        reply.send(envelope);
    }

    pub(super) fn subscribe_hosted(&mut self, view: &Entity<HostedView>, doc: Option<PathBuf>, window: &mut Window, cx: &mut Context<Self>) -> Subscription {
        // Overlap reading a markdown file with `HostedView` boot, then reuse the
        // loaded frame on `Ready` so the file is never read from disk twice.
        let cached_doc: Rc<RefCell<DocLoad>> = Rc::new(RefCell::new(if doc.is_some() { DocLoad::InFlight } else { DocLoad::None }));
        if let Some(path) = doc.clone() {
            self.push_doc_cached(view, path, cached_doc.clone(), cx);
        }
        let doc_cache = cached_doc;
        cx.subscribe_in(view, window, move |this, view, event: &HostedEvent, window, cx| match event {
            HostedEvent::Action(a) => this.on_action(a.clone(), window, cx),
            HostedEvent::HostCall { op, payload, reply } => this.host_call(op, payload.clone(), reply.clone(), window, cx),
            HostedEvent::Ready => {
                if let Some(path) = &doc {
                    let state = doc_cache.borrow().clone();
                    match state {
                        DocLoad::Loaded(frame) => view.update(cx, |v, cx| v.push("doc", frame, cx)),
                        DocLoad::InFlight => {}
                        DocLoad::None => {
                            *doc_cache.borrow_mut() = DocLoad::InFlight;
                            this.push_doc_cached(view, path.clone(), doc_cache.clone(), cx);
                        }
                    }
                }
            }
        })
    }

    fn push_doc_cached(&mut self, view: &Entity<HostedView>, path: PathBuf, cache: Rc<RefCell<DocLoad>>, cx: &mut Context<Self>) {
        let view = view.clone();
        Self::bg(
            cx,
            move || (std::fs::read_to_string(&path), path),
            move |_, (text, path), cx| {
                let frame = match text {
                    Ok(text) => json!({ "path": path, "markdown": text }),
                    Err(e) => json!({ "path": path, "error": e.to_string() }),
                };
                *cache.borrow_mut() = DocLoad::Loaded(frame.clone());
                view.update(cx, |v, cx| v.push("doc", frame, cx));
            },
        );
    }
}

#[derive(Clone)]
enum DocLoad {
    None,
    InFlight,
    Loaded(Value),
}

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
                self.sync_devtools_route(&path);
                if self.last_route.as_deref() != Some(path.as_str()) {
                    self.last_route = Some(path);
                    self.save_settings(cx);
                }
                self.publish_host_debug(cx);
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
                self.open_terminal_at(PathBuf::from(cwd), title, command, window, cx, |_| {});
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
            Action::ActivatePath { path } => self.activate_path(PathBuf::from(path), window, cx, |_, _, _| {}),
            Action::ActivateTab { path, tab_id } => self.activate_path(PathBuf::from(path), window, cx, move |s, window, cx| {
                if let Some(p) = s.ws.active_mut() {
                    p.layout.activate(tab_id);
                }
                s.layout_changed(window, cx);
            }),
            Action::CloseTabAt { path, tab_id } => self.activate_path(PathBuf::from(path), window, cx, move |s, window, cx| s.close_tab(tab_id, window, cx)),
            Action::NewTerminalAt { path } => {
                self.open_terminal_at(PathBuf::from(path), None, None, window, cx, |_| {});
            }
            Action::NewChatAt { path, runtime } => {
                self.open_chat_at(PathBuf::from(path), runtime, window, cx);
            }
            Action::OpenFileAdjacent { path, line } => {
                self.open_file_adjacent(PathBuf::from(path), line, window, cx);
            }
            Action::OpenDiffAdjacent { path, staged } => {
                self.open_diff_adjacent(path.map(PathBuf::from), staged, window, cx);
            }
            Action::BindChatSession { tab_id, session_id, runtime } => {
                self.bind_chat_session(tab_id, session_id, runtime, cx);
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
                    pv.tree.expanded.insert(PathBuf::from(path));
                    self.load_dirs(id, cx);
                }
            }
            Action::CollapseDir { path } => {
                let path = PathBuf::from(path);
                if let Some(pv) = active.and_then(|id| self.projects.get_mut(&id)) {
                    pv.tree.expanded.remove(&path);
                }
                self.push_sidebar(cx);
            }
            Action::OpenFile { path } => self.open_file(PathBuf::from(path), None, window, cx),
            Action::OpenFarm { repo } => {
                let props = if repo.is_empty() { json!({}) } else { json!({ "repo": repo }) };
                self.show_pixel("farm", props, window, cx)
            }
            Action::OpenRepoMap => self.show_pixel("map", json!({}), window, cx),
            Action::OpenTree => self.show_pixel("tree", json!({}), window, cx),
            Action::RevealInTerminal { path } => {
                let path = PathBuf::from(path);
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
                self.open_pane(
                    PaneKind::Diff {
                        spec,
                        path: path.map(PathBuf::from),
                        repo: None,
                    },
                    window,
                    cx,
                );
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
            Action::Stage { paths } => {
                let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
                self.git_op(move |r| r.stage(&paths), cx);
            }
            Action::Unstage { paths } => {
                let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
                self.git_op(move |r| r.unstage(&paths), cx);
            }
            Action::Discard { paths } => {
                let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
                self.git_op(move |r| r.discard(&paths), cx);
            }
            Action::Commit { message } => self.git_op(move |r| r.commit(&message).map(|_| ()), cx),
            Action::Checkout { branch } => self.git_op(move |r| r.checkout(&branch), cx),
            Action::AddWorktree { branch } => self.add_worktree(branch, window, cx),
            Action::RemoveWorktree { path, force } => self.remove_worktree(PathBuf::from(path), force, window, cx),
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
            Action::OpenHit { path, line } => self.open_file(PathBuf::from(path), Some(line), window, cx),
            Action::ToggleDevtools => self.toggle_devtools(window, cx),
            Action::DetachDevtools => self.detach_devtools(window, cx),
            Action::CloseDevtools => self.close_devtools(cx),
        }
    }

    /// A pixel scene's ask: a VibeValley page (the hosted `vv` view, given
    /// the route) or a terminal.
    pub fn on_pixel_event(&mut self, event: crate::pixel::view::PixelEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            crate::pixel::view::PixelEvent::Sound(name) => self.workbench.read(cx).play_farm_sound(name, cx),
            crate::pixel::view::PixelEvent::HostCall { op, reply } => self.host_call(op, reply, window, cx),
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
    /// (packages/protocol/src/host.ts) and VibeValley's terminal, decoded once into [`vibevalley_protocol::HostOp`].
    pub fn host_call(&mut self, op: vibevalley_protocol::HostOp, reply: crate::hosted::Replier, window: &mut Window, cx: &mut Context<Self>) {
        use vibevalley_protocol::{HostMotionChoice, HostOp, HostOpeningPhase, HostThemeChoice};
        use vibevalley_server::transport::bridge::{BizCode, Envelope, refusal};

        let envelope = match op {
            HostOp::UpdateState => return crate::update::host_call(crate::update::UpdateOp::State, reply, cx),
            HostOp::UpdateCheck => return crate::update::host_call(crate::update::UpdateOp::Check, reply, cx),
            HostOp::UpdateInstall => return crate::update::host_call(crate::update::UpdateOp::Install, reply, cx),
            HostOp::Info => {
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
            HostOp::CliState => return self.run_cli_op(CliOp::State, reply, cx),
            HostOp::CliInstall => return self.run_cli_op(CliOp::Install, reply, cx),
            HostOp::CliRemove => return self.run_cli_op(CliOp::Remove, reply, cx),
            HostOp::Font(req) => {
                let was_ui = Ui::get(cx).settings.ui_font_size;
                let mut settings = Ui::get(cx).settings.clone();
                if let Some(family) = req.mono_font.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    settings.mono_font = family.to_string();
                }
                if let Some(size) = req.terminal_font_size {
                    settings.terminal_font_size = (size as f32).clamp(9.0, 32.0);
                }
                if let Some(size) = req.ui_font_size {
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
            HostOp::Notify(req) => {
                Self::bg(
                    cx,
                    move || crate::host::notify(&req.title, &req.body),
                    |_, r, _| {
                        if let Err(e) = r {
                            eprintln!("notify: {e}");
                        }
                    },
                );
                Envelope::void()
            }
            HostOp::Tray(tray) => {
                let summary = crate::tray::Summary {
                    title: tray.title.clone(),
                    lines: tray.lines.clone(),
                };
                crate::tray::update(&summary);
                self.tray = Some(serde_json::to_value(&tray).unwrap_or(Value::Null));
                Envelope::void()
            }
            HostOp::Locale(locale) => {
                let loc = locale.as_str();
                vibevalley_i18n::set_locale(loc);
                update_menus(cx);
                crate::tray::refresh();
                self.notify_locale(loc, cx);
                self.locale = Some(loc.to_string());
                Envelope::void()
            }
            HostOp::Reveal(path) => {
                if path.starts_with('/') {
                    let path = PathBuf::from(path);
                    Self::bg(cx, move || crate::host::reveal(&path), |_, _, _| {});
                    Envelope::void()
                } else {
                    refusal(BizCode::InvalidInput, "reveal takes an absolute path")
                }
            }
            HostOp::Theme(choice) => {
                let theme = match choice {
                    HostThemeChoice::Light => ThemeChoice::Light,
                    HostThemeChoice::Dark => ThemeChoice::Dark,
                    HostThemeChoice::System => ThemeChoice::System,
                };
                self.set_theme(theme, cx);
                Envelope::void()
            }
            HostOp::Motion(choice) => {
                let motion = match choice {
                    HostMotionChoice::Off => MotionChoice::Off,
                    HostMotionChoice::On => MotionChoice::On,
                    HostMotionChoice::System => MotionChoice::System,
                };
                self.set_motion(motion, cx);
                Envelope::void()
            }
            HostOp::Opening(state) => {
                if let Some(opening) = &self.launch {
                    let phase = crate::serving::opening_pixel_phase(state.phase);
                    opening.update(cx, |view, _| view.set_phase(phase, (state.progress as f32).clamp(0.0, 100.0)));
                }
                self.opening = Some(serde_json::to_value(&state).unwrap_or(Value::Null));
                if state.phase == HostOpeningPhase::Ready {
                    self.finish_opening(true, cx);
                }
                cx.notify();
                Envelope::void()
            }
            HostOp::OpenTerminal(req) => {
                self.open_terminal_at(PathBuf::from(req.cwd), req.title, req.command, window, cx, move |result| {
                    reply.send(match result {
                        Ok(id) => Envelope::ok(json!({ "terminalId": id })),
                        Err(reason) => refusal(BizCode::Refused, reason),
                    })
                });
                return;
            }
            HostOp::OpenUrl(req) => {
                if req.url.starts_with("https://") || req.url.starts_with("http://") || req.url.starts_with("mailto:") {
                    cx.open_url(&req.url);
                    Envelope::void()
                } else {
                    refusal(BizCode::InvalidInput, "only http(s) and mailto URLs open")
                }
            }
            HostOp::OpenFile(req) => {
                if let Some(worktree) = req.worktree {
                    let Some((root, file)) = crate::host::worktree_file(Path::new(&worktree), Path::new(&req.path)) else {
                        return reply.send(refusal(
                            BizCode::Refused,
                            vibevalley_i18n::t("desktop.files.missingInWorktree", &[("path", req.path.into())]),
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
                if req.path.starts_with('/') {
                    let path = PathBuf::from(req.path);
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
                refusal(BizCode::InvalidInput, "openFile takes the absolute path of an existing file")
            }
            HostOp::PickFile => {
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
            HostOp::SaveFile(req) => {
                let source = PathBuf::from(req.path);
                if !source.is_absolute() {
                    reply.send(refusal(BizCode::InvalidInput, "saveFile requires an absolute path to a regular file"));
                    return;
                }
                let requested_name = req.name.filter(|n| !n.is_empty() && !n.contains('/') && !n.contains('\\'));
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
            HostOp::SpeechState(req) => Envelope::ok(json!(crate::speech_audio::state(req.id.as_deref().unwrap_or_default()))),
            HostOp::SpeechStart(req) => {
                let id = req.id.unwrap_or_default();
                let server = cx.try_global::<crate::hosted::BridgeHub>().map(|b| b.0.server().clone());
                Self::bg(
                    cx,
                    move || {
                        let speech = server
                            .and_then(|s| s.speech_streams())
                            .ok_or_else(|| "the speech service is not ready".to_string())?;
                        crate::speech_audio::start(speech, &id)
                    },
                    move |_, result, _| {
                        reply.send(match result {
                            Ok(state) => Envelope::ok(json!(state)),
                            Err(error) => refusal(BizCode::Refused, error),
                        });
                    },
                );
                return;
            }
            HostOp::SpeechStop(req) => Envelope::ok(json!(crate::speech_audio::stop(Some(req.id.as_deref().unwrap_or_default())))),
            HostOp::VoiceState(req) => Envelope::ok(json!(crate::live_voice::state(req.id.as_deref().unwrap_or_default()))),
            HostOp::VoiceStart(req) => {
                let id = req.id.unwrap_or_default();
                let server = cx.try_global::<crate::hosted::BridgeHub>().map(|b| b.0.server().clone());
                Self::bg(
                    cx,
                    move || {
                        let voice = server.and_then(|s| s.voice()).ok_or_else(|| "the voice service is not ready".to_string())?;
                        crate::live_voice::start(voice, id)
                    },
                    move |_, result, _| {
                        reply.send(match result {
                            Ok(state) => Envelope::ok(json!(state)),
                            Err(error) => refusal(BizCode::Refused, error),
                        });
                    },
                );
                return;
            }
            HostOp::VoiceStop(req) => Envelope::ok(json!(crate::live_voice::stop(Some(req.id.as_deref().unwrap_or_default())))),
            HostOp::VoiceMute(req) => Envelope::ok(json!(crate::live_voice::mute(req.id.as_deref().unwrap_or_default(), req.muted))),
            HostOp::PlayAudio(req) => {
                let seconds = req.position.unwrap_or(0.0);
                let path = PathBuf::from(req.path);
                crate::audio::dispatch(reply, move || crate::audio::play(&path, seconds));
                return;
            }
            HostOp::PlaySound(req) => {
                let name = crate::audio::SoundName::from(req.name);
                crate::audio::dispatch(reply, move || crate::audio::play_sound(name));
                return;
            }
            HostOp::SeekAudio(req) => {
                crate::audio::dispatch(reply, move || crate::audio::seek(req.position));
                return;
            }
            HostOp::AudioState => {
                crate::audio::dispatch(reply, || Ok(crate::audio::state()));
                return;
            }
            HostOp::PcmStart(req) => {
                let format = crate::audio::PcmFormat {
                    sample_rate: req.sample_rate,
                    channels: req.channels,
                };
                crate::audio::dispatch(reply, move || crate::audio::start_pcm(format));
                return;
            }
            HostOp::PcmAppend(req) => {
                crate::audio::dispatch(reply, move || crate::audio::append_pcm(&req.data));
                return;
            }
            // A file the user dropped on a view: nsh gives views file: URLs
            // and no way to read them.
            HostOp::ReadFile(req) => {
                let path = req.path.strip_prefix("file://").unwrap_or(&req.path);
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
            HostOp::StopAudio => {
                crate::audio::dispatch(reply, || {
                    crate::audio::stop();
                    Ok(())
                });
                return;
            }
            // VibeValley's built pixel art: sprites.json and its PNGs.
            HostOp::PixelDir => {
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
            stateless @ (HostOp::PixelManifest | HostOp::Sha256(_) | HostOp::RandomBytes(_) | HostOp::Qr(_)) => {
                crate::host::handle_stateless_op(&stateless).expect("stateless HostOp handled")
            }
        };
        reply.send(envelope);
    }

    fn run_cli_op(&self, cli_op: CliOp, reply: crate::hosted::Replier, cx: &mut Context<Self>) {
        use vibevalley_server::transport::bridge::{BizCode, Envelope, refusal};
        Self::bg(
            cx,
            move || {
                let cli = crate::command_line::CommandLine::current()?;
                match cli_op {
                    CliOp::Install => cli.install(),
                    CliOp::Remove => cli.remove(),
                    CliOp::State if cli.available() => Ok(cli.state()),
                    CliOp::State => Err("the CLI is not installed beside the app".into()),
                }
            },
            move |_, result, _| {
                reply.send(match result {
                    Ok(state) => Envelope::ok(json!(state)),
                    Err(error) => refusal(BizCode::Refused, error),
                })
            },
        );
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
            HostedEvent::HostCall { op, reply } => this.host_call(op.clone(), reply.clone(), window, cx),
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

#[derive(Clone, Copy)]
enum CliOp {
    State,
    Install,
    Remove,
}

#[derive(Clone)]
enum DocLoad {
    None,
    InFlight,
    Loaded(Value),
}

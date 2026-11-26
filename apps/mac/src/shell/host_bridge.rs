use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use gpui::{AppContext as _, Context, Entity, Focusable as _, PathPromptOptions, Subscription, Window};
use serde_json::{Value, json};
use vibevalley_workspace::PaneKind;

use crate::host::percent_decode;
use crate::hosted::{Action, HostedEvent, HostedView};
use crate::theme::{MotionChoice, ThemeChoice, Ui};

use super::{InspectorSlot, Shell, should_mount_inspector, update_menus};

impl Shell {
    pub fn on_action(&mut self, action: Action, window: &mut Window, cx: &mut Context<Self>) {
        let active = self.workspace.ws.active_id();
        match action {
            Action::GlobalRail { rail_width } => {
                let next = rail_width.clamp(56.0, 80.0);
                if (self.chrome.global_rail_width - next).abs() > 0.01 {
                    self.chrome.global_rail_width = next;
                    cx.notify();
                }
            }
            Action::GlobalModal { active } => {
                if self.chrome.modal_overlay != active {
                    self.chrome.modal_overlay = active;
                    if active {
                        window.focus(&self.chrome.workbench.read(cx).focus_handle(cx), cx);
                    }
                    cx.notify();
                }
            }
            Action::GlobalRoute { path } => {
                let next_native = path == "/workspace";
                let had_diorama = self.chrome.native_diorama.is_some();
                let route_changed = self.chrome.last_route.as_deref() != Some(path.as_str());
                let native_changed = self.chrome.native_workspace != next_native;
                self.chrome.native_workspace = next_native;
                if self.chrome.native_workspace {
                    self.with_workspace_project(window, cx, |_, _, _, _| {});
                }
                if !path.starts_with("/farm") {
                    self.chrome.native_diorama = None;
                }
                let diorama_changed = had_diorama != self.chrome.native_diorama.is_some();
                self.sync_devtools_route(&path);
                if route_changed {
                    self.chrome.last_route = Some(path);
                    self.save_settings(cx);
                }
                if route_changed || native_changed || diorama_changed {
                    self.publish_host_debug(cx);
                    cx.notify();
                }
            }
            Action::OpenRoute { path } => self.navigate_workbench(&path, cx),
            Action::Applied { .. }
            | Action::Ready
            | Action::DismissFarmForm
            | Action::FarmHandset { .. }
            | Action::FarmCall { .. }
            | Action::SilenceFarmPhone
            | Action::OpenTerminal { .. }
            | Action::ActivateProject { .. }
            | Action::RevealInTerminal { .. }
            | Action::OpenHit { .. }
            | Action::ToggleDevtools => {}
            Action::Probe { results } => {
                eprintln!("bridge probe: {results}");
                self.overlays.probe = Some(results);
            }
            Action::Call { op, .. } => eprintln!("host call {op} reached the shell without a reply handle"),
            Action::ActivatePath { path } => self.activate_path(PathBuf::from(path), window, cx, |_, _, _| {}),
            Action::ActivateTab { path, tab_id } => self.activate_path(PathBuf::from(path), window, cx, move |s, window, cx| {
                if let Some(p) = s.workspace.ws.active_mut() {
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
                if self.chrome.panel != panel || !self.chrome.inspector_open {
                    self.chrome.panel = panel;
                    self.chrome.inspector_open = true;
                    self.sync_inspector(window, cx);
                    self.push_sidebar(cx);
                    cx.notify();
                }
            }
            Action::ExpandDir { path } => {
                let dir = PathBuf::from(path);
                if let Some(id) = active
                    && let Some(pv) = self.workspace.projects.get_mut(&id)
                    && (pv.tree.expanded.insert(dir.clone()) || !pv.tree.children.contains_key(&dir))
                {
                    self.load_dirs(id, cx);
                }
            }
            Action::CollapseDir { path } => {
                let path = PathBuf::from(path);
                if let Some(pv) = active.and_then(|id| self.workspace.projects.get_mut(&id))
                    && pv.tree.expanded.remove(&path)
                {
                    self.push_sidebar_topics(super::projects::SidebarTopics::FILES, cx);
                }
            }
            Action::OpenFile { path } => self.open_file(PathBuf::from(path), None, window, cx),
            Action::OpenFarm { repo } => {
                let props = if repo.is_empty() { json!({}) } else { json!({ "repo": repo }) };
                self.show_diorama("farm", props, window, cx)
            }
            Action::OpenRepoMap => self.navigate_workbench("/repos", cx),
            Action::OpenTree => self.navigate_workbench("/settings/memory", cx),
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
                let changed = self.overlays.palette.as_mut().is_some_and(|p| {
                    if p.query == query {
                        false
                    } else {
                        p.query = query;
                        true
                    }
                });
                if changed {
                    self.refresh_palette(cx);
                }
            }
            Action::PaletteSelect { id } => self.palette_select(&id, window, cx),
            Action::PaletteClose => self.close_palette(window, cx),
            Action::Search { query, regex, case_sensitive } => {
                if let Some(p) = &mut self.overlays.palette {
                    p.query = query;
                }
                self.run_search(regex, case_sensitive, cx);
            }
            Action::DetachDevtools => self.detach_devtools(window, cx),
            Action::CloseDevtools => self.close_devtools(cx),
        }
    }

    /// Handles events emitted by a [`crate::diorama::DioramaView`] (sound cues,
    /// bridge host calls, workbench routes, and worktree terminals).
    pub fn on_diorama_event(&mut self, event: crate::diorama::DioramaEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            crate::diorama::DioramaEvent::Sound(name) => self.chrome.workbench.read(cx).play_farm_sound(name, cx),
            crate::diorama::DioramaEvent::HostCall { op, reply } => self.host_call(op, reply, window, cx),
            crate::diorama::DioramaEvent::Route(route) => self.open_pane(
                PaneKind::Hosted {
                    module: "vv".into(),
                    props: json!({ "route": route }),
                },
                window,
                cx,
            ),
            crate::diorama::DioramaEvent::Terminal { cwd, title } => {
                self.open_terminal_at(PathBuf::from(cwd), Some(title), None, window, cx, |_| {});
            }
        }
    }

    /// The `host.*` ops of the bridge: VibeValley's host capabilities
    /// (packages/protocol/src/host.ts) and VibeValley's terminal, decoded once into [`vibevalley_protocol::HostOp`].
    pub fn host_call(&mut self, op: vibevalley_protocol::HostOp, reply: crate::hosted::Replier, window: &mut Window, cx: &mut Context<Self>) {
        use vibevalley_protocol::{HostMotionChoice, HostOp, HostOpeningPhase, HostThemeChoice};
        use vibevalley_server::gateway::bridge::{BizCode, Envelope, refusal};

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
                Envelope::ok(host_info_payload(settings, fonts))
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
                self.overlays.tray = Some(serde_json::to_value(&tray).unwrap_or(Value::Null));
                Envelope::void()
            }
            HostOp::Locale(locale) => {
                let loc = locale.as_str();
                vibevalley_i18n::set_locale(loc);
                update_menus(cx);
                crate::tray::refresh();
                self.notify_locale(loc, cx);
                self.overlays.locale = Some(loc.to_string());
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
                if let Some(opening) = &self.overlays.launch {
                    let phase = crate::serving::opening_phase(state.phase);
                    opening.update(cx, |view, _| view.set_phase(phase, (state.progress as f32).clamp(0.0, 100.0)));
                }
                self.overlays.opening = Some(serde_json::to_value(&state).unwrap_or(Value::Null));
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
                    let window_handle = window.window_handle();
                    let rel = req.path;
                    cx.spawn(async move |this, cx| {
                        let resolved = cx
                            .background_spawn(async move { crate::host::worktree_file(Path::new(&worktree), Path::new(&rel)).ok_or(rel) })
                            .await;
                        match resolved {
                            Ok((root, file)) => {
                                let updated = cx.update_window(window_handle, |_, window, cx| {
                                    if this
                                        .update(cx, |shell, cx| {
                                            shell.with_project_at(root, window, cx, move |s, id, window, cx| {
                                                reply.send(match id {
                                                    Ok(id) => {
                                                        s.activate_project(id, window, cx);
                                                        s.open_file(file, None, window, cx);
                                                        Envelope::void()
                                                    }
                                                    Err(why) => refusal(BizCode::Refused, why),
                                                });
                                            });
                                        })
                                        .is_err()
                                    {
                                        // Window/shell dropped before update ran; refusal already unreachable.
                                    }
                                });
                                let _ = updated;
                            }
                            Err(missing) => {
                                reply.send(refusal(
                                    BizCode::Refused,
                                    vibevalley_i18n::t("desktop.files.missingInWorktree", &[("path", missing.into())]),
                                ));
                            }
                        }
                    })
                    .detach();
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
                let name = req.name;
                crate::audio::dispatch(reply, move || crate::audio::play_sound(name));
                return;
            }
            HostOp::SeekAudio(_) | HostOp::AudioState | HostOp::PcmStart(_) | HostOp::PcmAppend(_) => {
                refusal(BizCode::Refused, "legacy audio bridge op is no longer supported")
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
            // VibeValley's processed Papertrails assets directory (`avatars/`, `engines/`, `brand/`, ...).
            HostOp::AssetsDir => {
                Self::bg(
                    cx,
                    || {
                        let dir = crate::assets::assets_dir();
                        dir.is_dir().then_some(dir)
                    },
                    move |_, found, _| {
                        reply.send(match found {
                            Some(dir) => Envelope::ok(json!({ "path": dir })),
                            None => refusal(BizCode::NotFound, "the assets directory is not installed"),
                        });
                    },
                );
                return;
            }
            HostOp::AppletList => {
                Self::bg(cx, crate::applet::AppletHost::list, move |_, result, _| {
                    reply.send(match result {
                        Ok(list) => Envelope::ok(json!(list)),
                        Err(error) => refusal(BizCode::Refused, error),
                    });
                });
                return;
            }
            HostOp::AppletInstall(request) => {
                Self::bg(
                    cx,
                    move || crate::applet::AppletHost::install_applet(request),
                    move |_, result, _| {
                        reply.send(match result {
                            Ok(info) => Envelope::ok(json!(info)),
                            Err(error) => refusal(BizCode::Refused, error),
                        });
                    },
                );
                return;
            }
            HostOp::AppletUninstall(req) => {
                Self::bg(
                    cx,
                    move || crate::applet::AppletHost::uninstall_applet(&req.artifact_id),
                    move |_, result, _| {
                        reply.send(match result {
                            Ok(res) => Envelope::ok(json!(res)),
                            Err(error) => refusal(BizCode::Refused, error),
                        });
                    },
                );
                return;
            }
            HostOp::AppletOpen(req) => {
                Self::bg(
                    cx,
                    move || crate::applet::AppletHost::open_applet(&req.artifact_id),
                    move |_, result, _| {
                        reply.send(match result {
                            Ok(res) => Envelope::ok(json!(res)),
                            Err(error) => refusal(BizCode::Refused, error),
                        });
                    },
                );
                return;
            }
            HostOp::CaptureWebView(req) => {
                crate::capture::capture_webview_for_reply(window, req.width, req.height, reply, cx);
                return;
            }
            HostOp::VdpDiscover(req) => {
                let extra: Vec<PathBuf> = req.extra_homes.unwrap_or_default().into_iter().map(PathBuf::from).collect();
                Self::bg(
                    cx,
                    move || vibevalley_protocol::home::discover_local_debug_endpoints(&extra),
                    move |_, endpoints, _| {
                        reply.send(Envelope::ok(json!(endpoints)));
                    },
                );
                return;
            }
            HostOp::VdpCall(req) => {
                vibevalley_runtime::rt::current_or_global_handle().spawn(async move {
                    let envelope = crate::debug::call_remote_vdp(req).await;
                    reply.send(envelope);
                });
                return;
            }
            stateless @ (HostOp::Sha256(_) | HostOp::RandomBytes(_) | HostOp::Qr(_)) => {
                crate::host::handle_stateless_op(&stateless).expect("stateless HostOp handled")
            }
        };
        reply.send(envelope);
    }

    fn run_cli_op(&self, cli_op: CliOp, reply: crate::hosted::Replier, cx: &mut Context<Self>) {
        use vibevalley_server::gateway::bridge::{BizCode, Envelope, refusal};
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

    pub(super) fn subscribe_hosted(&mut self, view: &Entity<HostedView>, window: &mut Window, cx: &mut Context<Self>) -> Subscription {
        cx.subscribe_in(view, window, move |this, view, event: &HostedEvent, window, cx| match event {
            HostedEvent::Action(a) => this.on_action(a.clone(), window, cx),
            HostedEvent::HostCall { op, reply } => this.host_call(op.clone(), reply.clone(), window, cx),
            HostedEvent::Ready => view.read(cx).push_update_state(crate::update::state(), cx),
        })
    }

    /// Lazily spawns the inspector QuickJS view only when the workspace inspector is visible
    /// at a wide enough viewport, and drops it immediately when closed.
    pub(super) fn sync_inspector(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.chrome.inspector_open {
            self.chrome.inspector = None;
            return;
        }
        if !should_mount_inspector(
            self.chrome.native_workspace,
            self.chrome.inspector_open,
            f32::from(window.viewport_size().width),
        ) {
            return;
        }
        if self.chrome.inspector.is_some() {
            return;
        }
        let dark = Ui::get(cx).colors.dark;
        let view = cx.new(|cx| HostedView::new("sidebar", serde_json::from_value(json!({"role":"inspector"})).unwrap(), dark, window, cx));
        let sub = cx.subscribe_in(&view, window, |this, _, event: &HostedEvent, window, cx| match event {
            HostedEvent::Action(action) => this.on_action(action.clone(), window, cx),
            HostedEvent::HostCall { op, reply } => this.host_call(op.clone(), reply.clone(), window, cx),
            HostedEvent::Ready => this.push_sidebar(cx),
        });
        self.chrome.inspector = Some(InspectorSlot { view, _sub: sub });
    }
}

fn host_info_payload(settings: &crate::theme::Settings, fonts: &[String]) -> Value {
    json!({
        "name": "desktop",
        "version": crate::update::version(),
        "titleBar": { "top": 28, "left": 68 },
        "terminal": true,
        "monoFont": settings.mono_font,
        "monoFonts": fonts,
        "terminalFontSize": settings.terminal_font_size,
        "uiFontSize": settings.ui_font_size,
        "theme": settings.theme.as_str(),
        "motion": settings.effective_motion().as_str(),
        "capabilities": ["notify", "tray", "locale", "reveal", "theme", "motion", "font", "opening", "openTerminal", "openUrl", "openFile", "assetsDir", "playAudio", "readFile", "commandLine", "pickFile", "saveFile", "update", "mossVoice", "applet", "captureWebView", "vdp"],
    })
}

#[derive(Clone, Copy)]
enum CliOp {
    State,
    Install,
    Remove,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{SETTINGS_KEY, Settings};

    #[test]
    fn host_info_reports_persisted_theme_choice() {
        let store = vibevalley_workspace::Store::open_in_memory().expect("open in-memory workspace store");
        for (choice, expected) in [(ThemeChoice::Light, "light"), (ThemeChoice::Dark, "dark"), (ThemeChoice::System, "system")] {
            let settings = Settings {
                theme: choice,
                ..Settings::default()
            };
            vibevalley_workspace::persist::save_setting(&store, SETTINGS_KEY, &settings).expect("persist settings");
            let reloaded: Settings = vibevalley_workspace::persist::load_setting(&store, SETTINGS_KEY);
            let info = host_info_payload(&reloaded, &["Menlo".into()]);
            assert_eq!(info["theme"], expected);
            let caps = info["capabilities"].as_array().expect("capabilities array");
            assert!(caps.iter().any(|c| c == "theme"));
            assert!(caps.iter().any(|c| c == "applet"));
            assert!(caps.iter().any(|c| c == "captureWebView"));
            assert!(!caps.iter().any(|c| c == "seekAudio" || c == "pcm"));
        }
    }
}

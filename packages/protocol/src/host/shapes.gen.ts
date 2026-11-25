// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.

import type { Locale } from "../common/shapes.gen";

export const HostPanelValues = ["files", "git"] as const;
export type HostPanel = (typeof HostPanelValues)[number];

export const HostRailRunningStateValues = ["working", "ready", "idle"] as const;
export type HostRailRunningState = (typeof HostRailRunningStateValues)[number];

export type HostRailWorktree = { path: string, branch?: string, main: boolean, };

export type HostRailTab = { id: number, title: string, active: boolean, kind: string, running?: boolean, runningState?: HostRailRunningState, runningAgent?: string, runningLabel?: string, attention?: boolean, };

export type HostRailProject = { id: number, name: string, path: string, initials: string, active: boolean, attention: boolean, terminals: number, shortcut?: string, branch?: string, mainRoot?: string, worktrees?: Array<HostRailWorktree>, tabs?: Array<HostRailTab>, };

export type HostRailFrame = { projects: Array<HostRailProject>, panel: HostPanel, inspectorOpen?: boolean, };

export type HostTreeItem = { id: string, label: string, tone: string, hidden?: boolean, loading?: boolean, disabled?: boolean, children?: Array<HostTreeItem>, };

export type HostFileTreeFrame = { root?: string, name?: string, items: Array<HostTreeItem>, expanded?: Array<string>, selected?: string, loading?: boolean, };

export type HostGitFileRow = { path: string, code: string, tone: string, };

export type HostGitBranch = { name: string, head: boolean, upstream?: string, };

export type HostGitWorktree = { path: string, branch?: string, main: boolean, locked: boolean, current: boolean, changed: number, conflicts: number, ahead: number, behind: number, summary?: string, };

export type HostGitCommit = { id: string, short: string, summary: string, author: string, time: number, };

export type HostGitPanelFrame = { repo: boolean, branch?: string, head?: string, upstream?: string, ahead?: number, behind?: number, staged?: Array<HostGitFileRow>, changes?: Array<HostGitFileRow>, conflicts?: Array<HostGitFileRow>, branches?: Array<HostGitBranch>, worktrees?: Array<HostGitWorktree>, log?: Array<HostGitCommit>, error?: string, busy: boolean, };

export const HostPaletteModeValues = ["commands", "files", "search"] as const;
export type HostPaletteMode = (typeof HostPaletteModeValues)[number];

export type HostPaletteCommand = { id: string, label: string, detail?: string, group: string, shortcut?: string, };

export type HostPaletteFileMatch = { id: string, label: string, detail: string, indices: Array<number>, };

export type HostPaletteSearchHit = { id: string, label: string, detail: string, ranges: Array<[number, number]>, };

export type HostPaletteItem = HostPaletteCommand | HostPaletteFileMatch | HostPaletteSearchHit;

export type HostPaletteFrame = { mode: HostPaletteMode, query: string, items: Array<HostPaletteItem>, loading: boolean, note?: string, };

/**
 * Told apart by `type`.
 */
export type HostAction = { "type": "dismiss_farm_form" } | { "type": "farm_handset", unfolded: boolean, large: boolean, game: boolean, active_call: boolean, } | { "type": "farm_call", id: string, answered: boolean, } | { "type": "silence_farm_phone" } | { "type": "global_route", path: string, } | { "type": "open_route", path: string, } | { "type": "global_rail", rail_width: number, } | { "type": "applied", topic: string, rev: number, } | { "type": "ready" } | { "type": "call", id: string, op: string, payload?: unknown, } | { "type": "probe", results: unknown, } | { "type": "openFarm", repo?: string, } | { "type": "openRepoMap" } | { "type": "openTree" } | { "type": "open_terminal", cwd: string, title?: string, command?: string, } | { "type": "activate_project", id: number, } | { "type": "activate_path", path: string, } | { "type": "activate_tab", path: string, tab_id: number, } | { "type": "close_tab_at", path: string, tab_id: number, } | { "type": "new_terminal_at", path: string, } | { "type": "new_chat_at", path: string, runtime?: string, } | { "type": "open_file_adjacent", path: string, line?: number, } | { "type": "open_diff_adjacent", path?: string, staged?: boolean, } | { "type": "bind_chat_session", tab_id: number, session_id: string, runtime?: string, } | { "type": "add_project" } | { "type": "close_project", id: number, } | { "type": "show_panel", panel: HostPanel, } | { "type": "expand_dir", path: string, } | { "type": "collapse_dir", path: string, } | { "type": "open_file", path: string, } | { "type": "reveal_in_terminal", path: string, } | { "type": "open_diff", path?: string, staged: boolean, } | { "type": "stage", paths: Array<string>, } | { "type": "unstage", paths: Array<string>, } | { "type": "discard", paths: Array<string>, } | { "type": "commit", message: string, } | { "type": "checkout", branch: string, } | { "type": "add_worktree", branch: string, } | { "type": "remove_worktree", path: string, force?: boolean, } | { "type": "open_commit", id: string, } | { "type": "refresh_git" } | { "type": "palette_query", query: string, } | { "type": "palette_select", id: string, } | { "type": "palette_close" } | { "type": "search", query: string, regex?: boolean, case_sensitive?: boolean, } | { "type": "open_hit", path: string, line: number, } | { "type": "toggle_devtools" } | { "type": "detach_devtools" } | { "type": "close_devtools" };

export const HostThemeChoiceValues = ["light", "dark", "system"] as const;
export type HostThemeChoice = (typeof HostThemeChoiceValues)[number];

export const HostMotionChoiceValues = ["off", "on", "system"] as const;
export type HostMotionChoice = (typeof HostMotionChoiceValues)[number];

export const HostOpeningPhaseValues = ["connecting", "reading", "loading", "ready", "waiting", "failed"] as const;
export type HostOpeningPhase = (typeof HostOpeningPhaseValues)[number];

/**
 * Active or configured Control Plane connection mode for the macOS desktop app.
 */
export const DesktopConnectionModeValues = ["embedded", "remote"] as const;
/**
 * Active or configured Control Plane connection mode for the macOS desktop app.
 */
export type DesktopConnectionMode = (typeof DesktopConnectionModeValues)[number];

/**
 * Where the desktop app's configured Control Plane connection came from.
 */
export const DesktopConnectionSourceValues = ["env", "file", "default"] as const;
/**
 * Where the desktop app's configured Control Plane connection came from.
 */
export type DesktopConnectionSource = (typeof DesktopConnectionSourceValues)[number];

/**
 * Safe UI-facing snapshot of active vs configured desktop Control Plane connection mode.
 */
export type DesktopConnectionSnapshot = { activeMode: DesktopConnectionMode, activeUrl?: string, activeLabel?: string, configuredMode: DesktopConnectionMode, configuredUrl?: string, configuredLabel?: string, tokenHint?: string, source: DesktopConnectionSource, restartRequired: boolean, };

/**
 * Request payload for `host.connectionSave`.
 */
export type ConnectionSaveRequest = { url: string, token?: string, pairCode?: string, deviceName?: string, label?: string, };

export const HostSoundNameValues = ["tap", "nope", "pick", "open", "close", "water", "spray", "weed", "harvest", "shovel", "plant", "ripe", "bug", "coin", "levelUp", "achievement", "arrive", "rustle", "splash", "thud", "woof", "yip", "pant", "meow", "mew", "purr", "voiceOn", "ring", "voiceOff"] as const;
export type HostSoundName = (typeof HostSoundNameValues)[number];

export type HostFontPayload = { monoFont?: string, terminalFontSize?: number, uiFontSize?: number, };

export type HostNotifyPayload = { title: string, body: string, };

export type HostTrayPayload = { title: string, lines: Array<string>, };

export type HostOpeningPayload = { phase: HostOpeningPhase, progress: number, };

export type HostOpenTerminalPayload = { cwd: string, title?: string, command?: string, };

export type HostOpenUrlPayload = { url: string, };

export type HostOpenFilePayload = { path: string, worktree?: string, };

export type HostSaveFilePayload = { path: string, name?: string, };

export type HostIdPayload = { id?: string, };

export type HostVoiceMutePayload = { id?: string, muted: boolean, };

export type HostPlayAudioPayload = { path: string, position?: number, };

export type HostPlaySoundPayload = { name: HostSoundName, };

export type HostSeekAudioPayload = { position: number, };

export type HostPcmStartPayload = { sampleRate: number, channels: number, };

export type HostPcmAppendPayload = { data: string, };

export type HostReadFilePayload = { path: string, };

export type HostSha256Payload = { text: string, };

export type HostRandomBytesPayload = { length: number, };

export type HostQrPayload = { text: string, border?: number, };

/**
 * Every `host.*` bridge call answered by the native shell, decoded once at the boundary.
 */
export type HostOp = { "op": "host.info" } | { "op": "host.updateState" } | { "op": "host.updateCheck" } | { "op": "host.updateInstall" } | { "op": "host.cliState" } | { "op": "host.cliInstall" } | { "op": "host.cliRemove" } | { "op": "host.font", "payload": HostFontPayload } | { "op": "host.notify", "payload": HostNotifyPayload } | { "op": "host.tray", "payload": HostTrayPayload } | { "op": "host.locale", "payload": Locale } | { "op": "host.reveal", "payload": string } | { "op": "host.theme", "payload": HostThemeChoice } | { "op": "host.motion", "payload": HostMotionChoice } | { "op": "host.opening", "payload": HostOpeningPayload } | { "op": "host.openTerminal", "payload": HostOpenTerminalPayload } | { "op": "host.openUrl", "payload": HostOpenUrlPayload } | { "op": "host.openFile", "payload": HostOpenFilePayload } | { "op": "host.pickFile" } | { "op": "host.saveFile", "payload": HostSaveFilePayload } | { "op": "host.speechState", "payload": HostIdPayload } | { "op": "host.speechStart", "payload": HostIdPayload } | { "op": "host.speechStop", "payload": HostIdPayload } | { "op": "host.voiceState", "payload": HostIdPayload } | { "op": "host.voiceStart", "payload": HostIdPayload } | { "op": "host.voiceStop", "payload": HostIdPayload } | { "op": "host.voiceMute", "payload": HostVoiceMutePayload } | { "op": "host.playAudio", "payload": HostPlayAudioPayload } | { "op": "host.playSound", "payload": HostPlaySoundPayload } | { "op": "host.seekAudio", "payload": HostSeekAudioPayload } | { "op": "host.audioState" } | { "op": "host.pcmStart", "payload": HostPcmStartPayload } | { "op": "host.pcmAppend", "payload": HostPcmAppendPayload } | { "op": "host.stopAudio" } | { "op": "host.readFile", "payload": HostReadFilePayload } | { "op": "host.pixelDir" } | { "op": "host.pixelManifest" } | { "op": "host.sha256", "payload": HostSha256Payload } | { "op": "host.randomBytes", "payload": HostRandomBytesPayload } | { "op": "host.qr", "payload": HostQrPayload };

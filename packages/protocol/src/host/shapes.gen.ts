// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.

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
export type HostAction = { "type": "dismiss_farm_form" } | { "type": "farm_handset", unfolded: boolean, large: boolean, game: boolean, active_call: boolean, } | { "type": "farm_call", id: string, answered: boolean, } | { "type": "silence_farm_phone" } | { "type": "global_route", path: string, } | { "type": "open_route", path: string, } | { "type": "global_rail", rail_width: number, } | { "type": "applied", topic: string, rev: number, } | { "type": "ready" } | { "type": "call", id: string, op: string, payload?: unknown, } | { "type": "probe", results: unknown, } | { "type": "openFarm", repo?: string, } | { "type": "openRepoMap" } | { "type": "openTree" } | { "type": "open_terminal", cwd: string, title?: string, command?: string, } | { "type": "activate_project", id: number, } | { "type": "activate_path", path: string, } | { "type": "activate_tab", path: string, tab_id: number, } | { "type": "close_tab_at", path: string, tab_id: number, } | { "type": "new_terminal_at", path: string, } | { "type": "new_chat_at", path: string, runtime?: string, } | { "type": "open_file_adjacent", path: string, line?: number, } | { "type": "open_diff_adjacent", path?: string, staged?: boolean, } | { "type": "bind_chat_session", tab_id: number, session_id: string, runtime?: string, } | { "type": "add_project" } | { "type": "close_project", id: number, } | { "type": "show_panel", panel: HostPanel, } | { "type": "expand_dir", path: string, } | { "type": "collapse_dir", path: string, } | { "type": "open_file", path: string, } | { "type": "reveal_in_terminal", path: string, } | { "type": "open_diff", path?: string, staged: boolean, } | { "type": "stage", paths: Array<string>, } | { "type": "unstage", paths: Array<string>, } | { "type": "discard", paths: Array<string>, } | { "type": "commit", message: string, } | { "type": "checkout", branch: string, } | { "type": "add_worktree", branch: string, } | { "type": "remove_worktree", path: string, force?: boolean, } | { "type": "open_commit", id: string, } | { "type": "refresh_git" } | { "type": "palette_query", query: string, } | { "type": "palette_select", id: string, } | { "type": "palette_close" } | { "type": "search", query: string, regex?: boolean, case_sensitive?: boolean, } | { "type": "open_hit", path: string, line: number, };

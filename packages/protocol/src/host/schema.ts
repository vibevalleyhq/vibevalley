import { z } from "zod";

import type { Codec } from "../codec";
import * as T from "./shapes.gen";

export const HostPanel = z.enum(T.HostPanelValues) satisfies Codec<T.HostPanel>;

export const HostRailRunningState = z.enum(T.HostRailRunningStateValues) satisfies Codec<T.HostRailRunningState>;

export const HostRailWorktree = z.object({
  path: z.string(),
  branch: z.exactOptional(z.string()),
  main: z.boolean(),
}) satisfies Codec<T.HostRailWorktree>;

export const HostRailTab = z.object({
  id: z.number(),
  title: z.string(),
  active: z.boolean(),
  kind: z.string(),
  running: z.exactOptional(z.boolean()),
  runningState: z.exactOptional(HostRailRunningState),
  runningAgent: z.exactOptional(z.string()),
  runningLabel: z.exactOptional(z.string()),
  attention: z.exactOptional(z.boolean()),
}) satisfies Codec<T.HostRailTab>;

export const HostRailProject = z.object({
  id: z.number(),
  name: z.string(),
  path: z.string(),
  initials: z.string(),
  active: z.boolean(),
  attention: z.boolean(),
  terminals: z.number(),
  shortcut: z.exactOptional(z.string()),
  branch: z.exactOptional(z.string()),
  mainRoot: z.exactOptional(z.string()),
  worktrees: z.exactOptional(z.array(HostRailWorktree)),
  tabs: z.exactOptional(z.array(HostRailTab)),
}) satisfies Codec<T.HostRailProject>;

export const HostRailFrame = z.object({
  projects: z.array(HostRailProject),
  panel: HostPanel,
  inspectorOpen: z.exactOptional(z.boolean()),
}) satisfies Codec<T.HostRailFrame>;

export const HostTreeItem: Codec<T.HostTreeItem> = z.object({
  id: z.string(),
  label: z.string(),
  tone: z.string(),
  hidden: z.exactOptional(z.boolean()),
  loading: z.exactOptional(z.boolean()),
  disabled: z.exactOptional(z.boolean()),
  get children() {
    return z.exactOptional(z.array(HostTreeItem));
  },
});

export const HostFileTreeFrame = z.object({
  root: z.exactOptional(z.string()),
  name: z.exactOptional(z.string()),
  items: z.array(HostTreeItem),
  expanded: z.exactOptional(z.array(z.string())),
  selected: z.exactOptional(z.string()),
  loading: z.exactOptional(z.boolean()),
}) satisfies Codec<T.HostFileTreeFrame>;

export const HostGitFileRow = z.object({
  path: z.string(),
  code: z.string(),
  tone: z.string(),
}) satisfies Codec<T.HostGitFileRow>;

export const HostGitBranch = z.object({
  name: z.string(),
  head: z.boolean(),
  upstream: z.exactOptional(z.string()),
}) satisfies Codec<T.HostGitBranch>;

export const HostGitWorktree = z.object({
  path: z.string(),
  branch: z.exactOptional(z.string()),
  main: z.boolean(),
  locked: z.boolean(),
  current: z.boolean(),
  changed: z.number(),
  conflicts: z.number(),
  ahead: z.number(),
  behind: z.number(),
  summary: z.exactOptional(z.string()),
}) satisfies Codec<T.HostGitWorktree>;

export const HostGitCommit = z.object({
  id: z.string(),
  short: z.string(),
  summary: z.string(),
  author: z.string(),
  time: z.number(),
}) satisfies Codec<T.HostGitCommit>;

export const HostGitPanelFrame = z.object({
  repo: z.boolean(),
  branch: z.exactOptional(z.string()),
  head: z.exactOptional(z.string()),
  upstream: z.exactOptional(z.string()),
  ahead: z.exactOptional(z.number()),
  behind: z.exactOptional(z.number()),
  staged: z.exactOptional(z.array(HostGitFileRow)),
  changes: z.exactOptional(z.array(HostGitFileRow)),
  conflicts: z.exactOptional(z.array(HostGitFileRow)),
  branches: z.exactOptional(z.array(HostGitBranch)),
  worktrees: z.exactOptional(z.array(HostGitWorktree)),
  log: z.exactOptional(z.array(HostGitCommit)),
  error: z.exactOptional(z.string()),
  busy: z.boolean(),
}) satisfies Codec<T.HostGitPanelFrame>;

export const HostPaletteMode = z.enum(T.HostPaletteModeValues) satisfies Codec<T.HostPaletteMode>;

export const HostPaletteCommand = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.exactOptional(z.string()),
  group: z.string(),
  shortcut: z.exactOptional(z.string()),
}) satisfies Codec<T.HostPaletteCommand>;

export const HostPaletteFileMatch = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string(),
  indices: z.array(z.number()),
}) satisfies Codec<T.HostPaletteFileMatch>;

export const HostPaletteSearchHit = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string(),
  ranges: z.array(z.tuple([z.number(), z.number()])),
}) satisfies Codec<T.HostPaletteSearchHit>;

export const HostPaletteItem = z.union([HostPaletteCommand, HostPaletteFileMatch, HostPaletteSearchHit]) satisfies Codec<T.HostPaletteItem>;

export const HostPaletteFrame = z.object({
  mode: HostPaletteMode,
  query: z.string(),
  items: z.array(HostPaletteItem),
  loading: z.boolean(),
  note: z.exactOptional(z.string()),
}) satisfies Codec<T.HostPaletteFrame>;

export const HostAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("dismiss_farm_form") }),
  z.object({ type: z.literal("farm_handset"), unfolded: z.boolean(), large: z.boolean(), game: z.boolean(), active_call: z.boolean() }),
  z.object({ type: z.literal("farm_call"), id: z.string(), answered: z.boolean() }),
  z.object({ type: z.literal("silence_farm_phone") }),
  z.object({ type: z.literal("global_route"), path: z.string() }),
  z.object({ type: z.literal("open_route"), path: z.string() }),
  z.object({ type: z.literal("global_rail"), rail_width: z.number() }),
  z.object({ type: z.literal("applied"), topic: z.string(), rev: z.number() }),
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("call"), id: z.string(), op: z.string(), payload: z.exactOptional(z.unknown()) }),
  z.object({ type: z.literal("probe"), results: z.unknown() }),
  z.object({ type: z.literal("openFarm"), repo: z.exactOptional(z.string()) }),
  z.object({ type: z.literal("openRepoMap") }),
  z.object({ type: z.literal("openTree") }),
  z.object({ type: z.literal("open_terminal"), cwd: z.string(), title: z.exactOptional(z.string()), command: z.exactOptional(z.string()) }),
  z.object({ type: z.literal("activate_project"), id: z.number() }),
  z.object({ type: z.literal("activate_path"), path: z.string() }),
  z.object({ type: z.literal("activate_tab"), path: z.string(), tab_id: z.number() }),
  z.object({ type: z.literal("close_tab_at"), path: z.string(), tab_id: z.number() }),
  z.object({ type: z.literal("new_terminal_at"), path: z.string() }),
  z.object({ type: z.literal("new_chat_at"), path: z.string(), runtime: z.exactOptional(z.string()) }),
  z.object({ type: z.literal("open_file_adjacent"), path: z.string(), line: z.exactOptional(z.number()) }),
  z.object({ type: z.literal("open_diff_adjacent"), path: z.exactOptional(z.string()), staged: z.exactOptional(z.boolean()) }),
  z.object({ type: z.literal("bind_chat_session"), tab_id: z.number(), session_id: z.string(), runtime: z.exactOptional(z.string()) }),
  z.object({ type: z.literal("add_project") }),
  z.object({ type: z.literal("close_project"), id: z.number() }),
  z.object({ type: z.literal("show_panel"), panel: HostPanel }),
  z.object({ type: z.literal("expand_dir"), path: z.string() }),
  z.object({ type: z.literal("collapse_dir"), path: z.string() }),
  z.object({ type: z.literal("open_file"), path: z.string() }),
  z.object({ type: z.literal("reveal_in_terminal"), path: z.string() }),
  z.object({ type: z.literal("open_diff"), path: z.exactOptional(z.string()), staged: z.boolean() }),
  z.object({ type: z.literal("stage"), paths: z.array(z.string()) }),
  z.object({ type: z.literal("unstage"), paths: z.array(z.string()) }),
  z.object({ type: z.literal("discard"), paths: z.array(z.string()) }),
  z.object({ type: z.literal("commit"), message: z.string() }),
  z.object({ type: z.literal("checkout"), branch: z.string() }),
  z.object({ type: z.literal("add_worktree"), branch: z.string() }),
  z.object({ type: z.literal("remove_worktree"), path: z.string(), force: z.exactOptional(z.boolean()) }),
  z.object({ type: z.literal("open_commit"), id: z.string() }),
  z.object({ type: z.literal("refresh_git") }),
  z.object({ type: z.literal("palette_query"), query: z.string() }),
  z.object({ type: z.literal("palette_select"), id: z.string() }),
  z.object({ type: z.literal("palette_close") }),
  z.object({ type: z.literal("search"), query: z.string(), regex: z.exactOptional(z.boolean()), case_sensitive: z.exactOptional(z.boolean()) }),
  z.object({ type: z.literal("open_hit"), path: z.string(), line: z.number() }),
]) satisfies Codec<T.HostAction>;

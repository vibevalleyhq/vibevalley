import type { TextStyle } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";

export const autoDirection: TextStyle = { writingDirection: "auto" };

export type GitRow = { path: string; code: string; tone: string };

export type GitWorktree = {
  path: string;
  branch?: string | null;
  main: boolean;
  locked: boolean;
  current?: boolean;
  changed?: number;
  conflicts?: number;
  ahead?: number;
  behind?: number;
  summary?: string | null;
};

export type GitFrame = {
  repo: boolean;
  error?: string | null;
  busy?: boolean;
  branch?: string | null;
  head?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  staged?: GitRow[];
  changes?: GitRow[];
  conflicts?: GitRow[];
  branches?: { name: string; head: boolean; upstream?: string | null }[];
  worktrees?: GitWorktree[];
  log?: { id: string; short: string; summary: string; author: string; time: number }[];
};

const gitRowSchema = z.object({ path: z.string(), code: z.string(), tone: z.string() });

const gitWorktreeSchema = z.object({
  path: z.string(),
  branch: z.exactOptional(z.string().nullable()),
  main: z.boolean(),
  locked: z.boolean(),
  current: z.exactOptional(z.boolean()),
  changed: z.exactOptional(z.number()),
  conflicts: z.exactOptional(z.number()),
  ahead: z.exactOptional(z.number()),
  behind: z.exactOptional(z.number()),
  summary: z.exactOptional(z.string().nullable()),
});

export const gitFrameSchema: z.ZodType<GitFrame> = z.object({
  repo: z.boolean(),
  error: z.exactOptional(z.string().nullable()),
  busy: z.exactOptional(z.boolean()),
  branch: z.exactOptional(z.string().nullable()),
  head: z.exactOptional(z.string().nullable()),
  upstream: z.exactOptional(z.string().nullable()),
  ahead: z.exactOptional(z.number()),
  behind: z.exactOptional(z.number()),
  staged: z.exactOptional(z.array(gitRowSchema)),
  changes: z.exactOptional(z.array(gitRowSchema)),
  conflicts: z.exactOptional(z.array(gitRowSchema)),
  branches: z.exactOptional(z.array(z.object({ name: z.string(), head: z.boolean(), upstream: z.exactOptional(z.string().nullable()) }))),
  worktrees: z.exactOptional(z.array(gitWorktreeSchema)),
  log: z.exactOptional(z.array(z.object({ id: z.string(), short: z.string(), summary: z.string(), author: z.string(), time: z.number() }))),
});

export type GitTab = "changes" | "branches" | "commits";

export interface GitWorktreeMeta {
  readonly badge: string | null;
  readonly running: boolean;
}

export interface WorktreesSectionCtx {
  readonly worktrees: () => readonly GitWorktree[];
  readonly worktreesCount: () => number;
  readonly isOpen: (key: string) => boolean;
  readonly toggleSection: (key: string) => void;
  readonly ensureOpen: (key: string) => void;
  readonly addingWt: () => boolean;
  readonly setAddingWt: (next: boolean) => void;
  readonly newBranch: () => string;
  readonly setNewBranch: (value: string) => void;
  readonly creatingWt: () => boolean;
  readonly canCreate: () => boolean;
  readonly submitNewWorktree: () => void;
  readonly worktreeMeta: (path: string) => GitWorktreeMeta;
  readonly pendingRemove: () => string | null;
  readonly setPendingRemove: (path: string | null) => void;
  readonly removingPath: () => string | null;
  readonly removeError: () => { path: string; text: string } | null;
  readonly removeNotice: () => string | null;
  readonly startRemove: (w: GitWorktree, force: boolean) => void;
}

export function formatCommitTime(epochSec: number): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const diff = nowSec - epochSec;
  if (diff >= 0 && diff < 60) return t("web.shell.git.justNow");
  if (diff >= 60 && diff < 3600) return t("web.shell.git.minutesAgo", { n: Math.floor(diff / 60) });
  if (diff >= 3600 && diff < 86400) return t("web.shell.git.hoursAgo", { n: Math.floor(diff / 3600) });
  if (diff >= 86400 && diff < 86400 * 7) return t("web.shell.git.daysAgo", { n: Math.floor(diff / 86400) });
  const d = new Date(epochSec * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  if (d.getFullYear() === new Date().getFullYear()) return `${mm}-${dd}`;
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function normWtPath(p: string | undefined): string {
  if (!p) return "";
  return p.replace(/\/+$/u, "") || "/";
}

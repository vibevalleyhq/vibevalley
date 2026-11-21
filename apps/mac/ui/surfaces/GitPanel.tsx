// Source control split into three focused views:
//   - "changes": commit box, conflicts, staged & unstaged file diffs
//   - "branches": current branch, local branches (click to checkout) & worktrees
//   - "commits": commit history log (click to open commit diff)
import { Clipboard, effect, Scroll, signal, Text, View } from "nsh";
import { Button, ContextMenu, Input, MenuItem, MenuSeparator } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { act, frame, hostApi } from "../bridge";
import { pressTransition } from "../motion";
import { radius, tok, type as ty } from "../tokens";
import {
  contextMenuItemStyle,
  contextMenuPopupStyle,
  Empty,
  focusRing,
  IconButton,
  PrimaryButton,
  SectionHead,
  statusTint,
  SurfaceIcon,
  TipBubble,
  toneColor,
} from "./shared";

export type GitRow = { path: string; code: string; tone: string };
export type GitWorktree = {
  path: string;
  branch: string | null;
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
  branches?: { name: string; head: boolean; upstream: string | null }[];
  worktrees?: GitWorktree[];
  log?: { id: string; short: string; summary: string; author: string; time: number }[];
};

export type GitTab = "changes" | "branches" | "commits";

function formatCommitTime(epochSec: number): string {
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

function FileRow(props: { row: GitRow; staged: boolean }) {
  const p = () => tok();
  const hovered = signal(false);
  const confirmingDiscard = signal(false);
  const name = () => props.row.path.split("/").pop() ?? props.row.path;
  const dir = () => props.row.path.slice(0, Math.max(0, props.row.path.length - name().length - 1));
  const showActions = () => hovered() || confirmingDiscard();
  return (
    <View
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      style={{
        height: 26,
        marginHorizontal: 6,
        paddingHorizontal: 6,
        borderRadius: radius.md,
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        backgroundColor: showActions() ? p().tile : "transparent",
        ...pressTransition(),
      }}
    >
      <Button
        onPress={() => {
          confirmingDiscard.set(false);
          act({ type: "open_diff", path: props.row.path, staged: props.staged });
        }}
        accessibilityLabel={`Open diff of ${props.row.path}`}
        tooltip={<TipBubble text={props.row.path} />}
        focusVisibleStyle={focusRing(p())}
        style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6, height: 26, borderRadius: radius.sm }}
      >
        <Text
          style={{
            fontSize: 13,
            lineHeight: 18,
            color: toneColor(p(), props.row.tone),
            numberOfLines: 1,
            flexShrink: 1,
          }}
        >
          {name()}
        </Text>
        {dir() ? (
          <Text
            style={{
              fontSize: 11,
              lineHeight: 16,
              color: p().muted,
              numberOfLines: 1,
              flex: 1,
              minWidth: 0,
              textOverflow: "ellipsis-start",
            }}
          >
            {dir()}
          </Text>
        ) : null}
      </Button>
      {confirmingDiscard() ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 }}>
          <Button
            onPress={() => {
              confirmingDiscard.set(false);
              act({ type: "discard", paths: [props.row.path] });
            }}
            activeStyle={{ opacity: 0.82 }}
            focusVisibleStyle={focusRing(p())}
            style={{ height: 20, paddingHorizontal: 6, borderRadius: radius.sm, backgroundColor: p().danger, justifyContent: "center", ...pressTransition() }}
          >
            <Text style={{ fontSize: 11, lineHeight: 14, fontWeight: "500", color: p().onPrimary }}>{t("web.shell.git.confirmDiscard")}</Text>
          </Button>
          <Button
            onPress={() => confirmingDiscard.set(false)}
            activeStyle={{ opacity: 0.82 }}
            focusVisibleStyle={focusRing(p())}
            hoverStyle={{ backgroundColor: p().border }}
            style={{ height: 20, paddingHorizontal: 6, borderRadius: radius.sm, backgroundColor: p().subtle, justifyContent: "center", ...pressTransition() }}
          >
            <Text style={{ fontSize: 11, lineHeight: 14, color: p().text }}>{t("web.shell.git.cancel")}</Text>
          </Button>
        </View>
      ) : hovered() ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 0 }}>
          {props.staged ? (
            <IconButton
              label={t("web.shell.git.unstagePath", { path: props.row.path })}
              icon="minus"
              onPress={() => act({ type: "unstage", paths: [props.row.path] })}
            />
          ) : (
            <>
              <IconButton
                label={t("web.shell.git.discardPath", { path: props.row.path })}
                icon="undo"
                hoverColor={p().danger}
                onPress={() => confirmingDiscard.set(true)}
              />
              <IconButton
                label={t("web.shell.git.stagePath", { path: props.row.path })}
                icon="plus"
                onPress={() => act({ type: "stage", paths: [props.row.path] })}
              />
            </>
          )}
        </View>
      ) : null}
      <Text
        style={{
          fontFamily: ty.mono.fontFamily,
          fontSize: 11,
          lineHeight: 16,
          fontWeight: "600",
          width: 16,
          textAlign: "center",
          flexShrink: 0,
          color: toneColor(p(), props.row.tone),
        }}
      >
        {props.row.code}
      </Text>
    </View>
  );
}

type StateWorktreeMeta = {
  state?: {
    sessions?: { id: string; name: string; worktree?: string; issue?: string; phase: { _tag: string } }[];
    issues?: { id: string; number: number; title: string }[];
  };
};

function normWtPath(p: string | undefined): string {
  if (!p) return "";
  return p.replace(/\/+$/u, "") || "/";
}

function WorktreeRow(props: {
  w: GitWorktree;
  badge?: string | null;
  running?: boolean;
  pendingRemove: () => string | null;
  setPendingRemove: (path: string | null) => void;
  removingPath: () => string | null;
  removeError: () => { path: string; text: string } | null;
  onConfirmRemove: (w: GitWorktree, force: boolean) => void;
}) {
  const p = () => tok();
  const w = () => props.w;
  const dirty = () => (w().changed ?? 0) > 0 || (w().conflicts ?? 0) > 0;
  const confirming = () => props.pendingRemove() === w().path;
  const isRemoving = () => props.removingPath() === w().path;
  const rowError = () => {
    const err = props.removeError();
    return err && err.path === w().path ? err.text : null;
  };
  const trigger = (
    <View
      style={{
        position: "relative",
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 4,
        backgroundColor: w().current === true ? p().subtle : "transparent",
        opacity: isRemoving() ? 0.6 : 1,
        borderBottomWidth: 1,
        borderBottomColor: p().border,
        ...pressTransition(),
      }}
      hoverStyle={{ backgroundColor: w().current === true ? p().subtle : p().tile }}
    >
      {w().current === true ? (
        <View
          style={{
            position: "absolute",
            left: 2,
            top: 6,
            bottom: 6,
            width: 2,
            borderRadius: 999,
            backgroundColor: p().primary,
            pointerEvents: "none",
          }}
        />
      ) : null}
      <Button
        disabled={isRemoving()}
        onPress={() => {
          props.setPendingRemove(null);
          act({ type: "activate_path", path: w().path });
        }}
        tooltip={<TipBubble text={w().path} />}
        focusVisibleStyle={focusRing(p())}
        style={{ gap: 4, borderRadius: radius.sm }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 20 }}>
          <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <SurfaceIcon name="git-branch" size={12} color={w().current === true ? p().ink : p().muted} />
            </View>
            <Text
              style={{
                fontFamily: ty.mono.fontFamily,
                fontSize: 12,
                lineHeight: 16,
                fontWeight: "500",
                color: p().ink,
                numberOfLines: 1,
                flexShrink: 1,
                minWidth: 0,
              }}
            >
              {w().branch ?? "(detached)"}
            </Text>
            {w().main ? (
              <View
                style={{
                  height: 16,
                  paddingHorizontal: 5,
                  borderRadius: radius.sm,
                  backgroundColor: w().current === true ? p().surface : p().tile,
                  borderWidth: 1,
                  borderColor: p().border,
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <Text style={{ fontSize: 11, lineHeight: 14, color: p().muted }}>{t("web.shell.git.mainLabel")}</Text>
              </View>
            ) : null}
            {w().locked ? <SurfaceIcon name="lock" size={11} color={p().faint} /> : null}
          </View>
          <View style={{ flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 5 }}>
            {isRemoving() ? (
              <Text style={{ fontSize: 11, lineHeight: 14, fontWeight: "500", color: p().muted }}>{t("web.shell.git.removing")}</Text>
            ) : (
              <>
                {(w().ahead ?? 0) > 0 ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 1 }}>
                    <SurfaceIcon name="arrow-up" size={9} color={p().ok} />
                    <Text style={{ fontFamily: ty.mono.fontFamily, fontSize: 11, lineHeight: 14, fontWeight: "500", color: p().ok }}>{w().ahead}</Text>
                  </View>
                ) : null}
                {(w().behind ?? 0) > 0 ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 1 }}>
                    <SurfaceIcon name="arrow-down" size={9} color={p().alert} />
                    <Text style={{ fontFamily: ty.mono.fontFamily, fontSize: 11, lineHeight: 14, fontWeight: "500", color: p().alert }}>{w().behind}</Text>
                  </View>
                ) : null}
                {(w().conflicts ?? 0) > 0 ? (
                  <View
                    style={{
                      height: 18,
                      paddingHorizontal: 6,
                      borderRadius: radius.sm,
                      backgroundColor: statusTint(p(), "danger").fill,
                      borderWidth: 1,
                      borderColor: statusTint(p(), "danger").ring,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text style={{ fontSize: 11, lineHeight: 14, fontWeight: "500", color: p().danger }}>
                      {t("web.shell.git.wtConflictsCount", { n: w().conflicts ?? 0 })}
                    </Text>
                  </View>
                ) : (w().changed ?? 0) > 0 ? (
                  <View
                    style={{
                      height: 18,
                      paddingHorizontal: 6,
                      borderRadius: radius.sm,
                      backgroundColor: statusTint(p(), "alert").fill,
                      borderWidth: 1,
                      borderColor: statusTint(p(), "alert").ring,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text style={{ fontSize: 11, lineHeight: 14, fontWeight: "500", color: p().alert }}>
                      {t("web.shell.git.wtChangedCount", { n: w().changed ?? 0 })}
                    </Text>
                  </View>
                ) : (
                  <View
                    style={{
                      height: 18,
                      paddingHorizontal: 6,
                      borderRadius: radius.sm,
                      backgroundColor: w().current === true ? p().surface : p().tile,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text style={{ fontSize: 11, lineHeight: 14, color: p().muted }}>{t("web.shell.git.wtClean")}</Text>
                  </View>
                )}
              </>
            )}
          </View>
        </View>
        {props.badge ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingLeft: 19 }}>
            <View
              style={{
                width: props.running === true ? 6 : 5,
                height: props.running === true ? 6 : 5,
                borderRadius: 999,
                backgroundColor: props.running === true ? p().ok : p().faint,
                flexShrink: 0,
              }}
            />
            <Text
              style={{
                fontSize: 11,
                lineHeight: 15,
                fontWeight: props.running === true ? "500" : "400",
                color: props.running === true ? p().ok : p().muted,
                numberOfLines: 1,
                flex: 1,
                minWidth: 0,
              }}
            >
              {props.badge}
            </Text>
          </View>
        ) : null}
        {w().summary ? <Text style={{ fontSize: 12, lineHeight: 16, color: p().text, numberOfLines: 1, paddingLeft: 19 }}>{w().summary}</Text> : null}
        <Text
          style={{
            fontFamily: ty.mono.fontFamily,
            fontSize: 11,
            lineHeight: 14,
            color: p().faint,
            numberOfLines: 1,
            textOverflow: "ellipsis-start",
            paddingLeft: 19,
          }}
        >
          {w().path}
        </Text>
      </Button>
      {confirming() && !isRemoving() ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 6, paddingTop: 4 }}>
          <Text style={{ fontSize: 11, lineHeight: 14, color: p().muted }}>
            {dirty() ? t("web.shell.git.wtDirtyPrompt") : t("web.shell.git.wtConfirmDeletePrompt")}
          </Text>
          <Button
            onPress={() => props.onConfirmRemove(w(), dirty())}
            activeStyle={{ opacity: 0.82 }}
            focusVisibleStyle={focusRing(p())}
            style={{
              height: 22,
              paddingHorizontal: 8,
              borderRadius: radius.sm,
              backgroundColor: p().danger,
              justifyContent: "center",
              ...pressTransition(),
            }}
          >
            <Text style={{ fontSize: 11, lineHeight: 14, fontWeight: "500", color: p().onPrimary }}>
              {dirty() ? t("web.shell.git.wtForceDelete") : t("web.shell.git.wtConfirmDelete")}
            </Text>
          </Button>
          <Button
            onPress={() => props.setPendingRemove(null)}
            activeStyle={{ opacity: 0.82 }}
            focusVisibleStyle={focusRing(p())}
            style={{
              height: 22,
              paddingHorizontal: 7,
              borderRadius: radius.sm,
              backgroundColor: p().tile,
              borderWidth: 1,
              borderColor: p().border,
              justifyContent: "center",
              ...pressTransition(),
            }}
            hoverStyle={{ backgroundColor: p().subtle }}
          >
            <Text style={{ fontSize: 11, lineHeight: 14, color: p().text }}>{t("web.shell.git.cancel")}</Text>
          </Button>
        </View>
      ) : null}
      {rowError() ? (
        <Text style={{ fontSize: 11, lineHeight: 15, color: p().danger, paddingLeft: 19, paddingTop: 2 }}>
          {t("web.shell.git.removeFailed", { why: rowError() ?? "" })}
        </Text>
      ) : null}
    </View>
  );
  const itemStyle = contextMenuItemStyle;
  return (
    <ContextMenu trigger={trigger} popupStyle={contextMenuPopupStyle(p())}>
      <MenuItem onSelect={() => act({ type: "new_terminal_at", path: w().path })} style={itemStyle} hoverStyle={{ backgroundColor: p().subtle }}>
        <Text style={{ fontSize: 12, color: p().ink }}>{t("web.shell.sidebar.newTerminalHere")}</Text>
      </MenuItem>
      <MenuItem onSelect={() => void hostApi.reveal(w().path)} style={itemStyle} hoverStyle={{ backgroundColor: p().subtle }}>
        <Text style={{ fontSize: 12, color: p().ink }}>{t("web.shell.sidebar.revealInFinder")}</Text>
      </MenuItem>
      <MenuItem onSelect={() => void Clipboard.writeText(w().path)} style={itemStyle} hoverStyle={{ backgroundColor: p().subtle }}>
        <Text style={{ fontSize: 12, color: p().ink }}>{t("web.shell.sidebar.copyPath")}</Text>
      </MenuItem>
      {!w().main ? (
        <>
          <MenuSeparator style={{ height: 1, marginVertical: 4, backgroundColor: p().border }} />
          <MenuItem onSelect={() => props.setPendingRemove(w().path)} style={itemStyle} hoverStyle={{ backgroundColor: p().subtle }}>
            <Text style={{ fontSize: 12, color: p().danger }}>{t("web.shell.git.wtRemoveMenu")}</Text>
          </MenuItem>
        </>
      ) : null}
    </ContextMenu>
  );
}

export function GitPanel(props: { frame: GitFrame | null; tab?: GitTab }) {
  const p = () => tok();
  const message = signal("");
  const localTab = signal<GitTab>("changes");
  const folded = signal<Record<string, boolean>>({});
  const pendingRemove = signal<string | null>(null);
  const removing = signal<{ path: string; label: string } | null>(null);
  const removeError = signal<{ path: string; text: string } | null>(null);
  const removeNotice = signal<string | null>(null);
  const addingWt = signal(false);
  const newBranch = signal("");
  const creatingWt = signal(false);
  const vvState = frame<StateWorktreeMeta>("state");
  const activeTab = () => props.tab ?? localTab();
  const f = () => props.frame;
  const isOpen = (key: string) => !folded()[key];
  const toggleSection = (key: string) => folded.update((prev) => ({ ...prev, [key]: !prev[key] }));
  const ensureOpen = (key: string) => {
    if (folded()[key]) folded.update((prev) => ({ ...prev, [key]: false }));
  };

  const worktreeMeta = (path: string): { badge: string | null; running: boolean } => {
    const target = normWtPath(path);
    const sessions = vvState()?.state?.sessions ?? [];
    const session = sessions.find((s) => s.phase._tag !== "closed" && normWtPath(s.worktree) === target);
    if (!session) return { badge: null, running: false };
    const issue = session.issue ? (vvState()?.state?.issues ?? []).find((i) => i.id === session.issue) : undefined;
    const running = session.phase._tag === "working";
    const parts = [issue ? `#${issue.number} ${issue.title}` : session.name, running ? t("web.shell.git.wtRunning") : ""].filter(Boolean);
    return { badge: parts.join(" · "), running };
  };
  const submitNewWorktree = () => {
    const branch = newBranch().trim();
    if (!branch || creatingWt()) return;
    creatingWt.set(true);
    act({ type: "add_worktree", branch });
    newBranch.set("");
    addingWt.set(false);
  };
  effect(() => {
    if (creatingWt() && f()?.busy !== true) {
      creatingWt.set(false);
    }
  });
  const startRemove = (w: GitWorktree, force: boolean) => {
    pendingRemove.set(null);
    removeError.set(null);
    removeNotice.set(null);
    removing.set({ path: w.path, label: w.branch ?? w.path.split("/").pop() ?? w.path });
    act({ type: "remove_worktree", path: w.path, force });
  };
  effect(() => {
    const cur = removing();
    const frameVal = f();
    if (!cur || !frameVal) return;
    const stillPresent = (frameVal.worktrees ?? []).some((w) => w.path === cur.path);
    if (!stillPresent) {
      removing.set(null);
      removeError.set(null);
      const notice = t("web.shell.git.removedWorktree", { label: cur.label });
      removeNotice.set(notice);
      const timer = setTimeout(() => {
        if (removeNotice() === notice) removeNotice.set(null);
      }, 3000);
      return () => clearTimeout(timer);
    }
    if (frameVal.busy !== true && frameVal.error) {
      removing.set(null);
      removeError.set({ path: cur.path, text: frameVal.error });
    }
  });
  const committing = signal(false);
  const commitNotice = signal<string | null>(null);
  const branchQuery = signal("");
  const switchingBranch = signal<string | null>(null);
  const commit = () => {
    const text = message().trim();
    if (!text || committing()) return;
    committing.set(true);
    commitNotice.set(null);
    act({ type: "commit", message: text });
  };
  effect(() => {
    const frameVal = f();
    if (!frameVal) return;
    if (committing() && frameVal.busy !== true) {
      committing.set(false);
      if (!frameVal.error && (frameVal.staged?.length ?? 0) === 0) {
        message.set("");
        const notice = t("web.shell.git.commitSuccess");
        commitNotice.set(notice);
        const timer = setTimeout(() => {
          if (commitNotice() === notice) commitNotice.set(null);
        }, 2500);
        return () => clearTimeout(timer);
      }
    }
  });
  effect(() => {
    const target = switchingBranch();
    const frameVal = f();
    if (!target || !frameVal) return;
    if (frameVal.branch === target || (frameVal.busy !== true && frameVal.error)) {
      switchingBranch.set(null);
    }
  });

  const changedCount = () => (f()?.staged?.length ?? 0) + (f()?.changes?.length ?? 0) + (f()?.conflicts?.length ?? 0);
  const branchLabel = () => f()?.branch ?? `detached ${f()?.head ?? ""}`;
  const filteredBranches = () => {
    const q = branchQuery().trim().toLowerCase();
    return (f()?.branches ?? []).filter((b) => !q || b.name.toLowerCase().includes(q));
  };

  const renderWorktreesSection = (sectionKey: string, title: string, borderTop: boolean, showNotice: boolean) => (
    <View>
      <SectionHead
        title={title}
        count={f()?.worktrees?.length ?? 0}
        collapsible
        expanded={isOpen(sectionKey)}
        onToggle={() => toggleSection(sectionKey)}
        borderTop={borderTop}
        borderBottom={isOpen(sectionKey) && (f()?.worktrees?.length ?? 0) > 0 && !addingWt()}
        right={
          <Button
            onPress={() => {
              const next = !addingWt();
              addingWt.set(next);
              if (next) ensureOpen(sectionKey);
            }}
            accessibilityLabel={t("web.shell.git.newWorktree")}
            activeStyle={{ opacity: 0.82 }}
            focusVisibleStyle={focusRing(p())}
            style={{
              height: 20,
              paddingHorizontal: 6,
              borderRadius: radius.md,
              flexDirection: "row",
              alignItems: "center",
              gap: 3,
              backgroundColor: p().tile,
              ...pressTransition(),
            }}
            hoverStyle={{ backgroundColor: p().subtle }}
          >
            <SurfaceIcon name="plus" size={10} color={p().text} />
            <Text style={{ fontSize: 11, lineHeight: 14, fontWeight: "500", color: p().text }}>
              {creatingWt() ? t("web.shell.git.creatingWorktree") : t("web.shell.git.createWorktreeBtn")}
            </Text>
          </Button>
        }
      />
      {isOpen(sectionKey) ? (
        <View>
          {addingWt() ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 12,
                paddingTop: 2,
                paddingBottom: 8,
                borderBottomWidth: 1,
                borderBottomColor: p().border,
              }}
            >
              <Input
                value={newBranch()}
                onChange={({ value }) => newBranch.set(value)}
                onSubmit={submitNewWorktree}
                placeholder={t("web.shell.git.newBranchPlaceholder")}
                style={{
                  flex: 1,
                  height: 26,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: p().border,
                  backgroundColor: p().surface,
                  color: p().ink,
                  paddingHorizontal: 8,
                  fontSize: 12,
                }}
              />
              <Button
                onPress={submitNewWorktree}
                disabled={!newBranch().trim() || creatingWt()}
                activeStyle={!newBranch().trim() || creatingWt() ? undefined : { opacity: 0.82 }}
                focusVisibleStyle={!newBranch().trim() || creatingWt() ? undefined : focusRing(p())}
                style={{
                  height: 26,
                  paddingHorizontal: 10,
                  borderRadius: radius.md,
                  backgroundColor: !newBranch().trim() || creatingWt() ? p().tile : p().primary,
                  borderWidth: 1,
                  borderColor: !newBranch().trim() || creatingWt() ? p().border : p().primary,
                  justifyContent: "center",
                  ...pressTransition(),
                }}
              >
                <Text style={{ fontSize: 11, lineHeight: 14, fontWeight: "500", color: !newBranch().trim() || creatingWt() ? p().muted : p().onPrimary }}>
                  {t("web.shell.git.createBtn")}
                </Text>
              </Button>
            </View>
          ) : null}
          {showNotice && removeNotice() ? (
            <View
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                backgroundColor: statusTint(p(), "ok").fill,
                borderBottomWidth: 1,
                borderBottomColor: p().border,
              }}
            >
              <Text style={{ fontSize: 11, lineHeight: 15, color: p().ok }}>{removeNotice()}</Text>
            </View>
          ) : null}
          <Each of={f()?.worktrees ?? []} key={(w) => w.path}>
            {(w) => {
              const meta = () => worktreeMeta(w().path);
              return (
                <WorktreeRow
                  w={w()}
                  badge={meta().badge}
                  running={meta().running}
                  pendingRemove={pendingRemove}
                  setPendingRemove={(path) => pendingRemove.set(path)}
                  removingPath={() => removing()?.path ?? null}
                  removeError={removeError}
                  onConfirmRemove={startRemove}
                />
              );
            }}
          </Each>
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      {f()?.repo !== true ? (
        <View style={{ flex: 1 }}>
          <SectionHead title={t("web.shell.git.title")} borderBottom />
          <Empty text={f()?.busy === true || !f() ? t("web.shell.git.loading") : (f()?.error ?? t("web.shell.git.notRepo"))} />
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <View
            style={{
              height: 30,
              flexDirection: "row",
              alignItems: "center",
              paddingLeft: 12,
              paddingRight: 8,
              gap: 6,
              borderBottomWidth: 1,
              borderBottomColor: p().border,
            }}
          >
            <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <SurfaceIcon name="git-branch" size={12} color={p().muted} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }} tooltip={<TipBubble text={branchLabel()} />}>
              <Text style={{ fontFamily: ty.mono.fontFamily, fontSize: 12, lineHeight: 16, fontWeight: "500", color: p().ink, numberOfLines: 1 }}>
                {branchLabel()}
              </Text>
            </View>
            {(f()?.ahead ?? 0) > 0 ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 1, flexShrink: 0 }}>
                <SurfaceIcon name="arrow-up" size={9} color={p().ok} />
                <Text style={{ fontFamily: ty.mono.fontFamily, fontSize: 11, lineHeight: 14, fontWeight: "500", color: p().ok }}>{f()?.ahead}</Text>
              </View>
            ) : null}
            {(f()?.behind ?? 0) > 0 ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 1, flexShrink: 0 }}>
                <SurfaceIcon name="arrow-down" size={9} color={p().alert} />
                <Text style={{ fontFamily: ty.mono.fontFamily, fontSize: 11, lineHeight: 14, fontWeight: "500", color: p().alert }}>{f()?.behind}</Text>
              </View>
            ) : null}
            <IconButton label={t("web.shell.git.refresh")} icon="refresh" onPress={() => act({ type: "refresh_git" })} />
          </View>

          {/* Sub-navigation when not driven by parent header */}
          {props.tab === undefined ? (
            <View
              style={{
                flexDirection: "row",
                paddingHorizontal: 10,
                paddingVertical: 6,
                gap: 4,
                borderBottomWidth: 1,
                borderBottomColor: p().border,
              }}
            >
              {(
                [
                  {
                    id: "changes",
                    label: changedCount() > 0 ? t("web.shell.git.tab.changesCount", { count: changedCount() }) : t("web.shell.git.tab.changes"),
                  },
                  { id: "branches", label: t("web.shell.git.tab.branches", { count: f()?.branches?.length ?? 0 }) },
                  { id: "commits", label: t("web.shell.git.tab.commits") },
                ] as const
              ).map((item) => {
                const cur = () => activeTab() === item.id;
                return (
                  <Button
                    onPress={() => localTab.set(item.id)}
                    activeStyle={{ opacity: 0.82 }}
                    focusVisibleStyle={focusRing(p())}
                    style={{
                      flex: 1,
                      height: 24,
                      borderRadius: radius.md,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: cur() ? p().subtle : "transparent",
                      ...pressTransition(),
                    }}
                    hoverStyle={{ backgroundColor: cur() ? p().subtle : p().tile }}
                  >
                    <Text style={{ fontSize: 11, lineHeight: 14, fontWeight: "500", color: cur() ? p().ink : p().muted }}>{item.label}</Text>
                  </Button>
                );
              })}
            </View>
          ) : null}

          <Scroll style={{ flex: 1 }}>
            {activeTab() === "changes" ? (
              <View>
                {removeNotice() ? (
                  <View
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      backgroundColor: statusTint(p(), "ok").fill,
                      borderBottomWidth: 1,
                      borderBottomColor: p().border,
                    }}
                  >
                    <Text style={{ fontSize: 11, lineHeight: 15, color: p().ok }}>{removeNotice()}</Text>
                  </View>
                ) : null}
                {(f()?.worktrees?.length ?? 0) > 1 ? renderWorktreesSection("changes-worktrees", t("web.shell.git.worktrees"), false, false) : null}
                <View style={{ paddingHorizontal: 12, paddingVertical: 10, gap: 8, borderBottomWidth: 1, borderBottomColor: p().border }}>
                  <Input
                    value={message()}
                    onChange={({ value }) => message.set(value)}
                    placeholder={t("web.shell.git.commitPlaceholder")}
                    multiline
                    style={{
                      minHeight: 54,
                      borderRadius: radius.md,
                      borderWidth: 1,
                      borderColor: p().border,
                      backgroundColor: p().surface,
                      color: p().ink,
                      paddingHorizontal: 9,
                      paddingVertical: 7,
                      fontSize: 12,
                      lineHeight: 17,
                    }}
                  />
                  <PrimaryButton
                    label={
                      committing()
                        ? t("web.shell.git.committing")
                        : (f()?.staged?.length ?? 0) > 0
                          ? t("web.shell.git.commitStaged", { count: f()?.staged?.length ?? 0 })
                          : t("web.shell.git.noStaged")
                    }
                    disabled={committing() || (f()?.staged?.length ?? 0) === 0 || !message().trim()}
                    onPress={commit}
                  />
                  {(f()?.staged?.length ?? 0) === 0 && (f()?.changes?.length ?? 0) > 0 ? (
                    <Button
                      onPress={() => act({ type: "stage", paths: (f()?.changes ?? []).map((r) => r.path) })}
                      activeStyle={{ opacity: 0.82 }}
                      focusVisibleStyle={focusRing(p())}
                      style={{
                        height: 26,
                        paddingHorizontal: 10,
                        borderRadius: radius.md,
                        flexDirection: "row",
                        gap: 5,
                        justifyContent: "center",
                        alignItems: "center",
                        backgroundColor: "transparent",
                        borderWidth: 1,
                        borderColor: p().border,
                        ...pressTransition(),
                      }}
                      hoverStyle={{ backgroundColor: p().tile }}
                    >
                      <SurfaceIcon name="plus" size={11} color={p().text} />
                      <Text style={{ fontSize: 12, lineHeight: 16, fontWeight: "500", color: p().text }}>
                        {t("web.shell.git.stageAllCount", { count: (f()?.changes?.length ?? 0).toLocaleString() })}
                      </Text>
                    </Button>
                  ) : null}
                  {commitNotice() ? <Text style={{ fontSize: 11, lineHeight: 15, color: p().ok }}>{commitNotice()}</Text> : null}
                  {f()?.error ? (
                    <View
                      style={{
                        paddingHorizontal: 8,
                        paddingVertical: 6,
                        borderRadius: radius.md,
                        backgroundColor: statusTint(p(), "danger").fill,
                        borderWidth: 1,
                        borderColor: statusTint(p(), "danger").ring,
                      }}
                    >
                      <Text style={{ fontSize: 11, lineHeight: 15, color: p().danger }}>{f()?.error}</Text>
                    </View>
                  ) : null}
                </View>

                {(f()?.conflicts?.length ?? 0) > 0 ? (
                  <View style={{ paddingBottom: 4 }}>
                    <SectionHead
                      title={t("web.shell.git.conflicts")}
                      count={f()?.conflicts?.length}
                      tone="danger"
                      collapsible
                      expanded={isOpen("conflicts")}
                      onToggle={() => toggleSection("conflicts")}
                    />
                    {isOpen("conflicts") ? (
                      <View style={{ gap: 1 }}>
                        <Each of={f()?.conflicts ?? []} key={(r) => r.path}>
                          {(row) => <FileRow row={row()} staged={false} />}
                        </Each>
                      </View>
                    ) : null}
                  </View>
                ) : null}

                <View style={{ paddingBottom: 4 }}>
                  <SectionHead
                    title={t("web.shell.git.staged")}
                    count={f()?.staged?.length ?? 0}
                    collapsible
                    expanded={isOpen("staged")}
                    onToggle={() => toggleSection("staged")}
                    borderTop={(f()?.conflicts?.length ?? 0) > 0}
                    right={
                      (f()?.staged?.length ?? 0) > 0 ? (
                        <IconButton
                          label={t("web.shell.git.unstageAll")}
                          icon="minus"
                          onPress={() => act({ type: "unstage", paths: (f()?.staged ?? []).map((r) => r.path) })}
                        />
                      ) : undefined
                    }
                  />
                  {isOpen("staged") ? (
                    (f()?.staged?.length ?? 0) > 0 ? (
                      <View style={{ gap: 1 }}>
                        <Each of={f()?.staged ?? []} key={(r) => r.path}>
                          {(row) => <FileRow row={row()} staged />}
                        </Each>
                      </View>
                    ) : (
                      <Empty text={t("web.shell.git.stagedEmpty")} compact />
                    )
                  ) : null}
                </View>

                <View style={{ paddingBottom: 4 }}>
                  <SectionHead
                    title={t("web.shell.git.changes")}
                    count={f()?.changes?.length ?? 0}
                    collapsible
                    expanded={isOpen("changes")}
                    onToggle={() => toggleSection("changes")}
                    borderTop
                    right={
                      (f()?.changes?.length ?? 0) > 0 ? (
                        <IconButton
                          label={t("web.shell.git.stageAll")}
                          icon="plus"
                          onPress={() => act({ type: "stage", paths: (f()?.changes ?? []).map((r) => r.path) })}
                        />
                      ) : undefined
                    }
                  />
                  {isOpen("changes") ? (
                    (f()?.changes?.length ?? 0) > 0 ? (
                      <View style={{ gap: 1 }}>
                        <Each of={f()?.changes ?? []} key={(r) => r.path}>
                          {(row) => <FileRow row={row()} staged={false} />}
                        </Each>
                      </View>
                    ) : (
                      <Empty text={t("web.shell.git.clean")} compact />
                    )
                  ) : null}
                </View>
              </View>
            ) : null}

            {activeTab() === "branches" ? (
              <View>
                <View style={{ paddingBottom: 4 }}>
                  <SectionHead
                    title={t("web.shell.git.branches")}
                    count={f()?.branches?.length ?? 0}
                    collapsible
                    expanded={isOpen("branches")}
                    onToggle={() => toggleSection("branches")}
                  />
                  {isOpen("branches") ? (
                    <View>
                      {(f()?.branches?.length ?? 0) > 6 ? (
                        <View style={{ paddingHorizontal: 12, paddingTop: 2, paddingBottom: 6 }}>
                          <Input
                            value={branchQuery()}
                            onChange={({ value }) => branchQuery.set(value)}
                            placeholder={t("web.shell.git.filterBranches")}
                            style={{
                              height: 26,
                              borderRadius: radius.md,
                              borderWidth: 1,
                              borderColor: p().border,
                              backgroundColor: p().surface,
                              color: p().ink,
                              paddingHorizontal: 8,
                              fontSize: 12,
                            }}
                          />
                        </View>
                      ) : null}
                      {(f()?.branches?.length ?? 0) > 0 ? (
                        filteredBranches().length > 0 ? (
                          <View style={{ gap: 1 }}>
                            <Each of={filteredBranches()} key={(b) => b.name}>
                              {(b) => (
                                <Button
                                  disabled={switchingBranch() !== null}
                                  onPress={() => {
                                    if (!b().head) {
                                      switchingBranch.set(b().name);
                                      act({ type: "checkout", branch: b().name });
                                    }
                                  }}
                                  accessibilityLabel={
                                    b().head ? t("web.shell.git.currentBranch", { name: b().name }) : t("web.shell.git.switchBranch", { name: b().name })
                                  }
                                  activeStyle={switchingBranch() !== null ? undefined : { opacity: 0.82 }}
                                  focusVisibleStyle={switchingBranch() !== null ? undefined : focusRing(p())}
                                  style={{
                                    position: "relative",
                                    height: 26,
                                    marginHorizontal: 6,
                                    paddingHorizontal: 6,
                                    borderRadius: radius.md,
                                    flexDirection: "row",
                                    alignItems: "center",
                                    gap: 6,
                                    backgroundColor: b().head ? p().subtle : "transparent",
                                    ...pressTransition(),
                                  }}
                                  hoverStyle={{ backgroundColor: b().head ? p().subtle : p().tile }}
                                >
                                  {b().head ? (
                                    <View
                                      style={{
                                        position: "absolute",
                                        left: 2,
                                        top: 5,
                                        bottom: 5,
                                        width: 2,
                                        borderRadius: 999,
                                        backgroundColor: p().primary,
                                        pointerEvents: "none",
                                      }}
                                    />
                                  ) : null}
                                  <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                                    <SurfaceIcon name={b().head ? "check" : "git-branch"} size={12} color={b().head ? p().ok : p().faint} />
                                  </View>
                                  <Text
                                    style={{
                                      fontFamily: ty.mono.fontFamily,
                                      fontSize: 12,
                                      lineHeight: 16,
                                      fontWeight: "500",
                                      color: b().head ? p().ink : p().text,
                                      numberOfLines: 1,
                                      flex: 1,
                                      minWidth: 0,
                                    }}
                                  >
                                    {b().name}
                                  </Text>
                                  {switchingBranch() === b().name ? (
                                    <Text style={{ fontSize: 11, lineHeight: 14, fontWeight: "500", color: p().alert, flexShrink: 0 }}>
                                      {t("web.shell.git.switching")}
                                    </Text>
                                  ) : b().upstream ? (
                                    <Text
                                      style={{
                                        fontFamily: ty.mono.fontFamily,
                                        fontSize: 11,
                                        lineHeight: 14,
                                        color: p().muted,
                                        numberOfLines: 1,
                                        maxWidth: "42%",
                                        flexShrink: 0,
                                        textOverflow: "ellipsis-start",
                                      }}
                                    >
                                      {b().upstream}
                                    </Text>
                                  ) : null}
                                </Button>
                              )}
                            </Each>
                          </View>
                        ) : (
                          <Empty text={t("web.shell.git.noMatchingBranches")} compact />
                        )
                      ) : (
                        <Empty text={t("web.shell.git.noBranches")} compact />
                      )}
                    </View>
                  ) : null}
                </View>

                {(f()?.worktrees?.length ?? 0) > 0 ? renderWorktreesSection("branches-worktrees", t("web.shell.git.worktrees"), true, true) : null}
              </View>
            ) : null}

            {activeTab() === "commits" ? (
              <View>
                <SectionHead
                  title={t("web.shell.git.commits")}
                  count={f()?.log?.length ?? 0}
                  collapsible
                  expanded={isOpen("commits")}
                  onToggle={() => toggleSection("commits")}
                  borderBottom={isOpen("commits") && (f()?.log?.length ?? 0) > 0}
                />
                {isOpen("commits") ? (
                  (f()?.log?.length ?? 0) > 0 ? (
                    <Each of={f()?.log ?? []} key={(c) => c.id}>
                      {(c) => (
                        <Button
                          onPress={() => act({ type: "open_commit", id: c().id })}
                          accessibilityLabel={`Commit ${c().short}: ${c().summary}`}
                          tooltip={<TipBubble text={`${c().short} · ${c().summary}`} />}
                          activeStyle={{ opacity: 0.82 }}
                          focusVisibleStyle={focusRing(p())}
                          style={{
                            paddingHorizontal: 12,
                            paddingVertical: 7,
                            gap: 3,
                            borderBottomWidth: 1,
                            borderBottomColor: p().border,
                            ...pressTransition(),
                          }}
                          hoverStyle={{ backgroundColor: p().tile }}
                        >
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                            <Text
                              style={{
                                fontSize: 13,
                                lineHeight: 18,
                                color: p().ink,
                                numberOfLines: 1,
                                flex: 1,
                                minWidth: 0,
                                writingDirection: "auto",
                              }}
                            >
                              {c().summary}
                            </Text>
                            <View
                              style={{
                                minWidth: 68,
                                height: 18,
                                paddingHorizontal: 6,
                                borderRadius: radius.sm,
                                backgroundColor: p().surface,
                                borderWidth: 1,
                                borderColor: p().border,
                                alignItems: "center",
                                justifyContent: "center",
                                flexShrink: 0,
                              }}
                            >
                              <Text
                                style={{
                                  fontFamily: ty.mono.fontFamily,
                                  fontSize: 11,
                                  lineHeight: 14,
                                  fontVariant: ["tabular-nums"],
                                  color: p().ok,
                                  numberOfLines: 1,
                                }}
                              >
                                {c().short}
                              </Text>
                            </View>
                          </View>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                            <Text style={{ fontSize: 11, lineHeight: 14, color: p().muted, numberOfLines: 1, flex: 1, minWidth: 0 }}>{c().author}</Text>
                            <Text style={{ fontSize: 11, lineHeight: 14, color: p().faint, flexShrink: 0, textAlign: "right" }}>
                              {formatCommitTime(c().time)}
                            </Text>
                          </View>
                        </Button>
                      )}
                    </Each>
                  ) : (
                    <Empty text={t("web.shell.git.noCommits")} compact />
                  )
                ) : null}
              </View>
            ) : null}
            <View style={{ height: 16 }} />
          </Scroll>
        </View>
      )}
    </View>
  );
}

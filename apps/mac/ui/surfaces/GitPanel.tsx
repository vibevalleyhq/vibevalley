// Source control split into three focused views:
//   - "changes": commit box, conflicts, staged & unstaged file diffs
//   - "branches": current branch, local branches (click to checkout) & worktrees
//   - "commits": commit history log (click to open commit diff)
import { Scroll, signal, Text, View } from "nsh";
import { Button, Input } from "nsh/base";

import { act } from "../bridge";
import { radius, tok, type as ty } from "../tokens";
import { Empty, IconButton, PrimaryButton, SectionHead, toneColor } from "./shared";

export type GitRow = { path: string; code: string; tone: string };
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
  worktrees?: { path: string; branch: string | null; main: boolean; locked: boolean }[];
  log?: { id: string; short: string; summary: string; author: string; time: number }[];
};

export type GitTab = "changes" | "branches" | "commits";

function FileRow(props: { row: GitRow; staged: boolean }) {
  const p = () => tok();
  const name = () => props.row.path.split("/").pop() ?? props.row.path;
  const dir = () => props.row.path.slice(0, Math.max(0, props.row.path.length - name().length - 1));
  return (
    <View class="group" style={{ height: 26, flexDirection: "row", alignItems: "center", paddingLeft: 12, paddingRight: 6, gap: 6 }}>
      <Button
        onPress={() => act({ type: "open_diff", path: props.row.path, staged: props.staged })}
        accessibilityLabel={`Open diff of ${props.row.path}`}
        style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, height: 26 }}
      >
        <Text style={{ ...ty.body, fontSize: 13, color: toneColor(p(), props.row.tone), numberOfLines: 1, flexShrink: 1 }}>{name()}</Text>
        <Text style={{ ...ty.label, color: p().muted, numberOfLines: 1, flex: 1, textOverflow: "ellipsis-start" }}>{dir()}</Text>
      </Button>
      {props.staged ? (
        <IconButton label={`Unstage ${props.row.path}`} glyph="−" onPress={() => act({ type: "unstage", paths: [props.row.path] })} />
      ) : (
        <>
          <IconButton label={`Discard ${props.row.path}`} glyph="↺" onPress={() => act({ type: "discard", paths: [props.row.path] })} />
          <IconButton label={`Stage ${props.row.path}`} glyph="+" onPress={() => act({ type: "stage", paths: [props.row.path] })} />
        </>
      )}
      <Text style={{ ...ty.mono, fontSize: 12, width: 14, color: toneColor(p(), props.row.tone) }}>{props.row.code}</Text>
    </View>
  );
}

export function GitPanel(props: { frame: GitFrame | null; tab?: GitTab }) {
  const p = () => tok();
  const message = signal("");
  const localTab = signal<GitTab>("changes");
  const activeTab = () => props.tab ?? localTab();
  const f = () => props.frame;
  const commit = () => {
    const text = message().trim();
    if (!text) return;
    act({ type: "commit", message: text });
    message.set("");
  };
  if (!f()?.repo) {
    return (
      <View style={{ flex: 1 }}>
        <SectionHead title="Source Control" />
        <Empty text={f()?.busy || !f() ? "正在读取 Git 状态…" : (f()?.error ?? "当前目录不是 Git 仓库。")} />
      </View>
    );
  }

  const changedCount = () => (f()?.staged?.length ?? 0) + (f()?.changes?.length ?? 0) + (f()?.conflicts?.length ?? 0);

  return (
    <View style={{ flex: 1 }}>
      {/* Top status bar: current branch + refresh */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 12,
          paddingVertical: 8,
          gap: 6,
          borderBottomWidth: 1,
          borderBottomColor: p().border,
        }}
      >
        <Text style={{ ...ty.mono, fontSize: 12, color: p().ink, flex: 1, numberOfLines: 1 }}>⑂ {f()?.branch ?? `detached ${f()?.head ?? ""}`}</Text>
        {f()?.ahead ? <Text style={{ ...ty.label, color: p().muted }}>↑{f()?.ahead}</Text> : null}
        {f()?.behind ? <Text style={{ ...ty.label, color: p().muted }}>↓{f()?.behind}</Text> : null}
        <IconButton label="刷新 Git" glyph="⟳" onPress={() => act({ type: "refresh_git" })} />
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
              { id: "changes", label: changedCount() > 0 ? `变更 (${changedCount()})` : "变更" },
              { id: "branches", label: `分支 (${f()?.branches?.length ?? 0})` },
              { id: "commits", label: "历史" },
            ] as const
          ).map((item) => {
            const cur = activeTab() === item.id;
            return (
              <Button
                onPress={() => localTab.set(item.id)}
                style={{
                  flex: 1,
                  height: 24,
                  borderRadius: radius.sm,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: cur ? p().subtle : "transparent",
                }}
              >
                <Text style={{ fontSize: 11.5, fontWeight: cur ? "600" : "400", color: cur ? p().ink : p().muted }}>{item.label}</Text>
              </Button>
            );
          })}
        </View>
      ) : null}

      <Scroll style={{ flex: 1 }}>
        {/* 1. DIFF / CHANGES VIEW */}
        {activeTab() === "changes" ? (
          <View>
            <View style={{ padding: 12, gap: 8 }}>
              <Input
                value={message()}
                onChange={({ value }) => message.set(value)}
                placeholder="输入提交信息 (Commit message)…"
                multiline
                style={{
                  minHeight: 56,
                  borderRadius: radius.sm,
                  borderWidth: 1,
                  borderColor: p().border,
                  backgroundColor: p().surface,
                  color: p().ink,
                  padding: 8,
                  fontSize: 13,
                }}
              />
              <PrimaryButton
                label={f()?.staged?.length ? `提交暂存变更 (${f()?.staged?.length})` : "暂无暂存文件"}
                disabled={!f()?.staged?.length || !message().trim()}
                onPress={commit}
              />
              {f()?.error ? <Text style={{ ...ty.label, color: p().danger }}>{f()?.error}</Text> : null}
            </View>
            {f()?.conflicts?.length ? (
              <View>
                <SectionHead title="冲突 (Conflicts)" count={f()?.conflicts?.length} />
                <Each of={f()?.conflicts ?? []} key={(r) => r.path}>
                  {(row) => <FileRow row={row()} staged={false} />}
                </Each>
              </View>
            ) : null}
            <SectionHead
              title="已暂存 (Staged)"
              count={f()?.staged?.length ?? 0}
              right={
                f()?.staged?.length ? (
                  <IconButton label="全部取消暂存" glyph="−" onPress={() => act({ type: "unstage", paths: (f()?.staged ?? []).map((r) => r.path) })} />
                ) : undefined
              }
            />
            {f()?.staged?.length ? (
              <Each of={f()?.staged ?? []} key={(r) => r.path}>
                {(row) => <FileRow row={row()} staged />}
              </Each>
            ) : (
              <Empty text="暂无已暂存的文件。" />
            )}
            <SectionHead
              title="工作区变更 (Changes)"
              count={f()?.changes?.length ?? 0}
              right={
                f()?.changes?.length ? (
                  <IconButton label="全部暂存" glyph="+" onPress={() => act({ type: "stage", paths: (f()?.changes ?? []).map((r) => r.path) })} />
                ) : undefined
              }
            />
            {f()?.changes?.length ? (
              <Each of={f()?.changes ?? []} key={(r) => r.path}>
                {(row) => <FileRow row={row()} staged={false} />}
              </Each>
            ) : (
              <Empty text="工作区干净，没有未提交改动。" />
            )}
          </View>
        ) : null}

        {/* 2. BRANCHES & WORKTREES VIEW */}
        {activeTab() === "branches" ? (
          <View>
            <SectionHead title="本地分支 (Branches)" count={f()?.branches?.length ?? 0} />
            {f()?.branches?.length ? (
              <Each of={f()?.branches ?? []} key={(b) => b.name}>
                {(b) => (
                  <Button
                    onPress={() => !b().head && act({ type: "checkout", branch: b().name })}
                    accessibilityLabel={b().head ? `${b().name}, 当前分支` : `切换到 ${b().name}`}
                    class="hover:bg-[#f0f0f0] dark:hover:bg-[#232326]"
                    style={{
                      height: 30,
                      flexDirection: "row",
                      alignItems: "center",
                      paddingHorizontal: 12,
                      gap: 8,
                      backgroundColor: b().head ? p().subtle : "transparent",
                    }}
                  >
                    <Text style={{ width: 10, fontSize: 10, color: p().ok }}>{b().head ? "●" : ""}</Text>
                    <Text
                      style={{
                        ...ty.mono,
                        fontSize: 12.5,
                        fontWeight: b().head ? "600" : "400",
                        color: b().head ? p().ink : p().text,
                        numberOfLines: 1,
                        flex: 1,
                      }}
                    >
                      {b().name}
                    </Text>
                    {b().upstream ? <Text style={{ fontSize: 11, color: p().muted }}>{b().upstream}</Text> : null}
                  </Button>
                )}
              </Each>
            ) : (
              <Empty text="未找到本地分支。" />
            )}
            {(f()?.worktrees?.length ?? 0) > 0 ? (
              <View>
                <SectionHead title="工作树 (Worktrees)" count={f()?.worktrees?.length} />
                <Each of={f()?.worktrees ?? []} key={(w) => w.path}>
                  {(w) => (
                    <Button
                      onPress={() => act({ type: "activate_path", path: w().path })}
                      class="hover:bg-[#f0f0f0] dark:hover:bg-[#232326]"
                      style={{ paddingHorizontal: 12, paddingVertical: 6, gap: 2 }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Text style={{ ...ty.mono, fontSize: 12, fontWeight: "600", color: p().ink, numberOfLines: 1, flex: 1 }}>
                          ⑂ {w().branch ?? "(detached)"}
                        </Text>
                        {w().main ? <Text style={{ fontSize: 11, color: p().muted }}>主工作树</Text> : null}
                      </View>
                      <Text style={{ ...ty.label, color: p().muted, numberOfLines: 1, textOverflow: "ellipsis-start" }}>{w().path}</Text>
                    </Button>
                  )}
                </Each>
              </View>
            ) : null}
          </View>
        ) : null}

        {/* 3. COMMIT HISTORY VIEW */}
        {activeTab() === "commits" ? (
          <View>
            <SectionHead title="提交记录 (Commit History)" count={f()?.log?.length ?? 0} />
            {f()?.log?.length ? (
              <Each of={f()?.log ?? []} key={(c) => c.id}>
                {(c) => (
                  <Button
                    onPress={() => act({ type: "open_commit", id: c().id })}
                    accessibilityLabel={`Commit ${c().short}: ${c().summary}`}
                    class="hover:bg-[#f0f0f0] dark:hover:bg-[#232326]"
                    style={{
                      minHeight: 42,
                      paddingHorizontal: 12,
                      paddingVertical: 6,
                      gap: 2,
                      borderBottomWidth: 1,
                      borderBottomColor: p().border,
                    }}
                  >
                    <Text style={{ ...ty.body, fontSize: 13, color: p().ink, numberOfLines: 1, writingDirection: "auto" }}>{c().summary}</Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text style={{ ...ty.mono, fontSize: 11, color: p().ok }}>{c().short}</Text>
                      <Text style={{ ...ty.label, color: p().muted, numberOfLines: 1, flex: 1 }}>
                        {c().author} · {new Date(c().time * 1000).toLocaleDateString()}
                      </Text>
                    </View>
                  </Button>
                )}
              </Each>
            ) : (
              <Empty text="暂无提交记录。" />
            )}
          </View>
        ) : null}
        <View style={{ height: 16 }} />
      </Scroll>
    </View>
  );
}

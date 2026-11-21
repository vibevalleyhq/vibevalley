import "../polyfill";
import { mount, Scroll, signal, Text, View } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type { SessionEvent } from "@vibevalley/protocol";

import { SCENARIO_NOW, scenarios } from "../fixtures/scenarios";
import { Root } from "../web/app/Root";
import { createSettled, useNow } from "../web/base/dom";
import { ago, shortMomentText } from "../web/base/format";
import { SubagentProgress } from "../web/features/session/SubagentProgress";
import { Trajectory } from "../web/features/session/Trajectory";
import { WorkLog } from "../web/features/session/WorkLog";
import { fixtureTransport } from "../web/infra/fixtures";
import { defineColumns, useTable } from "../web/infra/table";
import { setTransport } from "../web/infra/transport";
import { Button } from "../web/ui/Button";
import { Checkbox } from "../web/ui/Checkbox";
import { ChipsInput } from "../web/ui/Chips";
import { CodeBlock } from "../web/ui/code/CodeBlock";
import { ConfirmButton } from "../web/ui/ConfirmButton";
import { DataTable, tableCell } from "../web/ui/DataTable";
import { Dialog } from "../web/ui/Dialog";
import { AgentFace } from "../web/ui/domain/Face";
import { PoseSprite } from "../web/ui/domain/PoseSprite";
import { RuntimeBadge } from "../web/ui/domain/RuntimeBadge";
import { Field, TextInput } from "../web/ui/Field";
import { IconButton } from "../web/ui/IconButton";
import { KeyField } from "../web/ui/KeyField";
import { ListCard, ListRow, PageBody, Toggle } from "../web/ui/layout";
import { Markdown } from "../web/ui/Markdown";
import { MoreMenu } from "../web/ui/MoreMenu";
import { Segmented } from "../web/ui/Segmented";
import { Slider } from "../web/ui/Slider";
import { Tabs } from "../web/ui/Tabs";
import { Tag } from "../web/ui/Tag";
import { ToastHost } from "../web/ui/ToastHost";
import { toast } from "../web/ui/toasts";

setTransport(fixtureTransport(scenarios.typical));

const RowSchema = z.object({ id: z.string(), title: z.string(), score: z.number() });
type Row = z.infer<typeof RowSchema>;
const col = defineColumns(RowSchema);
const columns = [col("title", { value: (r) => r.title, hideable: false }), col("score", { value: (r) => r.score, compare: (a, b) => a - b })] as const;

const cells = {
  title: tableCell(
    columns[0],
    () => "标题",
    (v) => <Text class="text-sm text-ink">{v()}</Text>,
  ),
  score: tableCell(
    columns[1],
    () => "分值",
    (v) => <Text class="font-mono text-sm text-ink tabular-nums">{String(v())}</Text>,
  ),
};

const sampleLongCode = Array.from({ length: 20 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join("\n");

const finishedAndLiveSteps: SessionEvent[] = [
  { seq: 1, revision: 1, time: SCENARIO_NOW - 120_000, type: "run/start", run: "r1", text: "" },
  { seq: 2, revision: 1, time: SCENARIO_NOW - 119_000, type: "user/message", run: "r1", text: "检查登录过期处理" },
  {
    seq: 3,
    revision: 1,
    time: SCENARIO_NOW - 115_000,
    type: "tool/call",
    run: "r1",
    action: "read_file",
    tool: "read",
    input: "auth.ts",
    actionText: "auth.ts",
    text: "",
  },
  { seq: 4, revision: 1, time: SCENARIO_NOW - 114_000, type: "tool/result", run: "r1", call: 3, output: "ok", ok: true, text: "" },
  { seq: 5, revision: 1, time: SCENARIO_NOW - 100_000, type: "assistant/message", run: "r1", text: "完成登录检查。" },
  { seq: 6, revision: 1, time: SCENARIO_NOW - 99_000, type: "run/end", run: "r1", text: "" },
  { seq: 7, revision: 1, time: SCENARIO_NOW - 10_000, type: "run/start", run: "r2", text: "" },
  {
    seq: 8,
    revision: 1,
    time: SCENARIO_NOW - 9_000,
    type: "tool/call",
    run: "r2",
    action: "run_command",
    tool: "bash",
    input: "cargo test",
    actionText: "cargo test",
    text: "",
  },
];

const liveOnlySteps: SessionEvent[] = [
  { seq: 10, revision: 1, time: SCENARIO_NOW - 10_000, type: "run/start", run: "r-live", text: "" },
  { seq: 11, revision: 1, time: SCENARIO_NOW - 9_000, type: "user/message", run: "r-live", text: "运行单测" },
  {
    seq: 12,
    revision: 1,
    time: SCENARIO_NOW - 8_000,
    type: "tool/call",
    run: "r-live",
    action: "run_command",
    tool: "bash",
    input: "vp test run",
    actionText: "vp test run",
    text: "",
  },
];

const failedOnlySteps: SessionEvent[] = [
  { seq: 20, revision: 1, time: SCENARIO_NOW - 50_000, type: "run/start", run: "r-fail", text: "" },
  { seq: 21, revision: 1, time: SCENARIO_NOW - 45_000, type: "run/error", run: "r-fail", text: "模型钥匙未配置" },
];

function ComponentBench() {
  const clicks = signal(0);
  const confirmed = signal(0);
  const escConfirmed = signal(0);
  const checked = signal(false);
  const toggleOn = signal(false);
  const bareToggleOn = signal(true);
  const seg = signal<"a" | "b" | "c">("a");
  const tab = signal<"t1" | "t2">("t1");
  const chips = signal<readonly string[]>(["rust"]);
  const sliderVal = signal(40);
  const textVal = signal("initial");
  const keyVal = signal("sk-test-key");
  const removingKey = signal(false);
  const dialogOpen = signal(false);
  const pickedMenu = signal("none");
  const pose = signal<"idle" | "walk">("idle");
  const settledInput = signal("alpha");
  const settledVal = createSettled(settledInput, 250);
  const now = useNow(30_000);

  const table = useTable({
    rows: () => [
      { id: "r1", title: "第一行指标", score: 20 },
      { id: "r2", title: "第二行指标", score: 90 },
    ],
    columns,
    rowId: (r) => r.id,
    mode: "local",
  });
  const emptyTable = useTable({
    rows: () => [] as Row[],
    columns,
    rowId: (r) => r.id,
    mode: "local",
  });

  const subagentData = scenarios.typical.state.state.sessions.find((s) => s.subagents)?.subagents;

  return (
    <Scroll testID="component-bench" class="flex-1 bg-page" contentClass="gap-4 p-4">
      <View testID="comp-controls" class="gap-2 rounded-lg border border-line bg-side p-3">
        <View class="flex-row flex-wrap items-center gap-2">
          <Button testID="btn-plain" onPress={() => clicks.set(clicks() + 1)}>
            普通按钮
          </Button>
          <Button testID="btn-primary" tone="primary" onPress={() => clicks.set(clicks() + 1)}>
            主按钮
          </Button>
          <Button testID="btn-danger" tone="danger" onPress={() => clicks.set(clicks() + 1)}>
            危险按钮
          </Button>
          <Button testID="btn-disabled" disabled onPress={() => clicks.set(clicks() + 1)}>
            禁用按钮
          </Button>
          <IconButton testid="icon-btn" icon="add" label="加一" onClick={() => clicks.set(clicks() + 1)} />
          <Text testID="btn-count">{`clicks:${clicks()}`}</Text>
        </View>

        <View class="flex-row flex-wrap items-center gap-2">
          <ConfirmButton testid="confirm-btn" label="删除项" question="确定删除？" onConfirm={() => confirmed.set(confirmed() + 1)} />
          <Text testID="confirm-count">{`confirmed:${confirmed()}`}</Text>
          <ConfirmButton testid="confirm-esc" label="撤销测试" question="确认撤销？" onConfirm={() => escConfirmed.set(escConfirmed() + 1)} />
          <Text testID="confirm-esc-count">{`escConfirmed:${escConfirmed()}`}</Text>
        </View>

        <View class="flex-row flex-wrap items-center gap-3">
          <Checkbox testid="chk-toggle" label="启用缓存" checked={checked()} onChange={(v) => checked.set(v)} />
          <Checkbox testid="chk-disabled" label="只读开关" checked={false} disabled onChange={() => {}} />
          <Text testID="chk-state">{`checked:${String(checked())}`}</Text>
          <Segmented
            testid="seg-mode"
            label="视图模式"
            value={seg()}
            onChange={(v) => seg.set(v)}
            options={[
              { value: "a", label: "选项A", count: 3, countTone: "water" },
              { value: "b", label: "选项B", count: 0, countTone: "wheat" },
              { value: "c", label: "选项C", disabled: true },
            ]}
          />
          <Text testID="seg-state">{`seg:${seg()}`}</Text>
          <Toggle testid="comp-toggle-labeled" label="自动合并" checked={toggleOn()} onChange={(v) => toggleOn.set(v)} />
          <Toggle bare testid="comp-toggle-bare" ariaLabel="行开关" checked={bareToggleOn()} onChange={(v) => bareToggleOn.set(v)} />
          <Text testID="toggle-states">{`toggles:${String(toggleOn())}/${String(bareToggleOn())}`}</Text>
        </View>

        <View class="gap-1.5">
          <Tabs
            label="组件页签"
            value={tab()}
            onChange={(v) => tab.set(v)}
            items={[
              { value: "t1", label: "页签一" },
              { value: "t2", label: "页签二" },
            ]}
          />
          <Text testID="tab-state">{`tab:${tab()}`}</Text>
        </View>

        <View class="flex-row flex-wrap items-center gap-2">
          <Tag tone="ok" label="已就绪" />
          <Tag tone="bad" label="已失败" />
          <Tag tone="wait" label="等待确认" />
          <Tag tone="info" label="同步中" />
          <Tag tone="neutral" label="已归档" />
        </View>

        <PageBody width="prose" testid="comp-page-body">
          <ListCard title="行列表" testid="comp-list">
            <ListRow to="/row-a" item="row-a" active title="选中条目" line="左侧含主题色竖线标记" />
            <ListRow to="/row-b" item="row-b" title="普通条目" line="透明边框保持对齐" />
          </ListCard>
        </PageBody>

        <View class="gap-2">
          <Field label="名称输入" hint="用于验证受控输入">
            <TextInput testID="field-input" value={textVal()} onInput={(v) => textVal.set(v)} placeholder="输入名称" />
          </Field>
          <Text testID="field-state">{`field:${textVal()}`}</Text>
          <ChipsInput label="标签输入" value={chips()} onChange={(next) => chips.set(next)} placeholder="加标签" />
          <Text testID="chips-state">{`chips:${chips().join(",")}`}</Text>
          <View class="flex-row items-center gap-3">
            <View class="w-48">
              <Slider testid="slider-ctrl" label="并发度" min={0} max={100} step={10} value={sliderVal()} onChange={(v) => sliderVal.set(v)} />
            </View>
            <Button testID="slider-bump" onPress={() => sliderVal.set(Math.min(100, sliderVal() + 10))}>
              +10
            </Button>
            <Text testID="slider-state">{`slider:${sliderVal()}`}</Text>
          </View>
          <KeyField label="DeepSeek Key" status={{ source: "settings", hint: "…3f9a" }} removing={removingKey()} onRemove={(r) => removingKey.set(r)}>
            <TextInput testID="key-input" masked value={keyVal()} onInput={(v) => keyVal.set(v)} />
          </KeyField>
          <Text testID="key-removing">{`removing:${String(removingKey())}`}</Text>
        </View>
      </View>

      <View testID="comp-overlays" class="gap-2 rounded-lg border border-line bg-side p-3">
        <View class="flex-row flex-wrap items-center gap-2">
          <Button testID="open-dialog" onPress={() => dialogOpen.set(true)}>
            打开弹窗
          </Button>
          <MoreMenu
            testid="comp-more"
            label="更多操作"
            items={[
              { key: "rename", label: "重命名条", onSelect: () => pickedMenu.set("rename") },
              { key: "archive", label: "归档项", danger: true, onSelect: () => pickedMenu.set("archive") },
            ]}
          />
          <Text testID="menu-picked">{`menu:${pickedMenu()}`}</Text>
          <Button testID="fire-toast" onPress={() => toast("保存组件配置成功")}>
            弹出轻提示
          </Button>
        </View>
        <Dialog open={dialogOpen()} onClose={() => dialogOpen.set(false)} title="组件弹窗" testid="comp-dialog">
          <View class="gap-2">
            <Text>弹窗内部内容展示正常</Text>
            <Button testID="close-dialog" onPress={() => dialogOpen.set(false)}>
              关闭弹窗
            </Button>
          </View>
        </Dialog>
        <DataTable testid="comp-table" table={table} cells={cells} caption="指标表" selection />
        <DataTable testid="comp-table-empty" table={emptyTable} cells={cells} caption="空指标表" />
      </View>

      <View testID="comp-rich" class="gap-2 rounded-lg border border-line bg-side p-3">
        <View testID="md-section">
          <Markdown text={"# 组件 Markdown\n\n查看 #18 进度，@laozhou\n\n```ts\nexport const hello = 'world';\n```"} mentions />
        </View>
        <View testID="long-code-section">
          <CodeBlock language="ts" code={sampleLongCode} />
        </View>
      </View>

      <View testID="comp-clocks" class="gap-1 rounded-lg border border-line bg-side p-3">
        <Text testID="clock-ago">{`ago:${ago(SCENARIO_NOW, now())}`}</Text>
        <Text testID="clock-moment">{`moment:${shortMomentText(SCENARIO_NOW, now())}`}</Text>
        <View class="flex-row items-center gap-2">
          <Button testID="bump-settled" onPress={() => settledInput.set("beta")}>
            触发防抖
          </Button>
          <Text testID="settled-val">{`settled:${settledVal()}`}</Text>
        </View>
      </View>

      <View testID="comp-domain" class="gap-3 rounded-lg border border-line bg-side p-3">
        <View class="flex-row items-center gap-3">
          <View class="relative">
            <AgentFace agentId="laozhou" name="老周" runtime="claude" size={28} />
            <RuntimeBadge runtime="claude" size={14} />
          </View>
          <PoseSprite cast={{ species: "bear", outfit: "farmer" }} pose={pose()} height={32} />
          <Button testID="toggle-pose" onPress={() => pose.set(pose() === "idle" ? "walk" : "idle")}>
            {`pose:${pose()}`}
          </Button>
        </View>
        <View testID="domain-worklog-live">
          <WorkLog steps={liveOnlySteps} now={now()} working asked={t("web.session.log.heard")} />
        </View>
        <View testID="domain-worklog-failed">
          <WorkLog steps={failedOnlySteps} now={SCENARIO_NOW} />
        </View>
        <View testID="domain-worklog-empty">
          <WorkLog steps={[]} now={SCENARIO_NOW} />
        </View>
        <View testID="domain-trajectory">
          <Trajectory steps={finishedAndLiveSteps} now={SCENARIO_NOW} working />
        </View>
        {subagentData ? <SubagentProgress session="w1" progress={subagentData} now={SCENARIO_NOW} /> : null}
      </View>
    </Scroll>
  );
}

mount(() => (
  <Root>
    <ComponentBench />
    <ToastHost />
  </Root>
));

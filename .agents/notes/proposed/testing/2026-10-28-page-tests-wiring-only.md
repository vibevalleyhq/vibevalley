# Agent Note: 页面测试只测接线，判断下沉，元素按标记找

Status: proposed

## Problem

页面层（`apps/web/test`，Playwright 对着真的服务端）有 122 条测试、跑 1.8 分钟，是金字塔里最贵的一层，却做了不该它做的事：

- **按字找元素**：910 处选择器里 814 处写的是界面上的中文（`getByRole("button", { name: "去设置" })`、`toHaveText("没接通：…")`），只有 23 处用 `data-testid`。改一句文案、换一种语言，几十条测试一起红，红了也说明不了接线坏了。
- **判断放在最高层测**：设置的搜索（`ui/settings.tsx` 的 `matches`）、MOSS 线路的轮次合并和 QoS（`features/voice/mossLine.ts`）、发消息的去重（`features/channel/composing.ts`）、看板的筛选和排序，都是纯的判断，却只能经浏览器测，有的（`mossLine.ts`）根本测不到。
- **服务端的规则在页面里测**：`doc-commands.spec.ts` 不用 `page`；工单的几种待你状态、名字被拒、没钥匙打不通电话，各自的规则在服务端，却由五六条页面测试各渲染一遍。
- **「看起来」的测试**：每块一条截图测试（档案、图鉴、设置、项目……），只断言文案在、截一张图，不比对。

规范已经写进 [foundation.md](docs/subsystems/foundation.md) 和 AGENTS.md 的「测试」，lint `vibevalley/no-copy-selector` 已经在，还没迁的文件列在 `vite.config.ts` 的 `excludeFiles`。

## Proposal

一个 PR（`test/page-layer`），每步一个提交：

1. **抽纯函数、补 vitest**：`ui/settings.tsx` 的 `matches`；`mossLine.ts` 的轮次合并和 QoS 拆成不碰 WebSocket、AudioContext 的函数；`composing.ts` 核对已有用例；听写能不能用（`canDictate`）；看板的筛选。其余盘点里列的（图鉴筛选、编辑器合并块、树的时间、手机里的小游戏）只在迁到那个文件时、它确实是判断才抽。
2. **服务端补漏**：没钥匙时 `voice.session.create` 拒绝；没帮工不能开工；工单的几种待你状态由 `issue` 的规则测试覆盖。已有的不重复。
3. **加标记**：迁哪个文件就给它碰到的元素加 `data-testid`（kebab-case）和状态属性（`data-state`、`aria-pressed`、`aria-current`、`data-found`），列表项加 `data-key`；测试自己造的数据（项目名、频道名、消息）放进 fixture 常量。
4. **逐个迁文件**：按盘点的结论，KEEP 的换成标记、去掉文案断言；DOWN 的删掉页面那条（下层已经补上）；MERGE 的并进同类；DROP 的（截图、只断言文案的）删掉。迁完一个从 `excludeFiles` 里删掉。
5. **可访问性**：`@axe-core/playwright` 进 catalog，`apps/web/test/a11y.spec.ts` 每个工作台页面跑一次 axe，查角色、名字、对比度；按名字找元素省下的那部分保证由它接手。
6. 文案只剩两处兜着：`vpx scripts/i18n.ts check`（漏翻、没人用、占位）和 `english.spec.ts`（英文页面上没有中文）。

## Alternatives considered

- **只换选择器、不砍测试**：省不下时间，判断仍然只在最贵的一层测。
- **用 i18n 的键找元素**（`getByRole("button", { name: t("…") })`）：不怕改文案了，但测试仍然依赖界面上说什么，换了按钮的说法、合并两个按钮时一样要改测试；而且 lint 分不清哪些字来自词典。
- **截图比对**：像素皮还在频繁改，基线维护的成本高过它抓到的问题。

## Acceptance criteria

- `excludeFiles` 为空，`no-copy-selector` 对 `apps/web/test`、`apps/desktop/test` 全开。
- 页面测试 60 条上下，`vp run --filter @vibevalley/web e2e` 一分钟上下。
- `matches`、`mossLine` 的判断、`canDictate` 有 vitest；服务端补的几处有测试。
- `a11y.spec.ts` 每页一次 axe，过。
- `vp check`、`web:check`、`server:check`、`e2e`、`desktop:test` 全过。

## Risks

- 删掉的页面测试里藏着下层没覆盖的行为：每删一条先找到下层对应的测试，找不到就先补。
- `data-testid` 加多了变成噪音：只给测试要碰的元素加，能用角色和状态属性的不加。
- axe 第一次跑会报出一批现成的问题，要在这个 PR 里修掉或逐条说明为什么排除。

# 第八篇：AI Agent UI 开发与审查指南

本指南面向在 VibeValley 仓库编写或评审界面代码的 Agent，将工作台与原生壳的设计规矩收敛为可直接核对的施工与验收清单。

## 8.1 开发前核对：先查概念归属与现有原语

1. **先分清改动归属哪个渲染载体**：
   - 工作台页面（`apps/mac/ui/{app,features,farm}/`）：用 `nsh` Tailwind 令牌 class + `apps/mac/ui/design/` 原子。
   - 工作区外壳（`apps/mac/ui/workspace/` 与 `apps/mac/ui/design/surface.tsx`）：复用 `design/Button`、`design/Tip`，内联样式用 `apps/mac/ui/design/tokens.ts` 的 `tok()` + `apps/mac/ui/design/motion.ts`。
   - 官网站点（`apps/site/`）：用 Tailwind CSS v4 读 `apps/site/src/ui/global.css` 的 `@theme static`。
   - 原生 GPUI/像素/终端（`apps/mac/src/`）：用 Rust `theme.rs` 与 `pixel::draw::DrawList`。
2. **复用已有的共用原语**：新建跨模块帮手或状态原语前，先查 [primitives.md](docs/reference/primitives.md) 与 `apps/mac/ui/design/` 目录，禁止抄写第二份功能重叠的按钮、标签、弹窗、分栏或复选框。
3. **严守两套图标边界**：工作台按钮、导航与表单操作只能从 `apps/mac/ui/design/icons.ts` 取 `reicon` 图标；像素头像、农机标识与装饰图只能取 `assets/pixel/`；两者均严禁使用 emoji 替代，也不在页面局部用 `<Canvas>` 手绘新图标路径。

## 8.2 样式、色彩与布局纪律

1. **颜色与字号全部走令牌，写死 hex 必拒**：
   - 工作台只使用源自 `design/tokens.json` 并生成到 `apps/mac/ui/design/theme.json` 的颜色类名（`bg-page` / `bg-side` / `bg-rail` / `text-ink` / `text-muted` / `border-line` / `bg-accent` / `leaf` / `wheat` / `berry` / `water` 等）和 `apps/mac/ui/nsh.json` 定义的 `fontSize` / `radius` / `ease` / `shadow`。
   - 需要随主题自适应的半透明底色一律调用 `apps/mac/ui/design/tone.ts` 的 `mix(name, weight)`；状态标签与提醒优先使用语义类组合（`bg-ok-soft text-ok-ink`、`bg-warn-soft text-warn-ink`、`bg-bad-soft text-berry`、`bg-hover text-muted`），工作台 UI 禁止直接拿像素画布色（如 `bg-hat`、`text-bark-900`）或手写 `mix("wheat", 0.22)` 当浅/深双主题状态徽标。
   - 新增语义色用途必须同步写入 `design/tokens.json` 后执行 `vpx scripts/gen/tokens.ts` 重生成，不直接手改生成产物。
2. **遵循 `nsh` 写法规范（[vv-tailwind](.agents/skills/vv-tailwind/SKILL.md)）**：
   - 文字颜色与字号不会从父级 `<View>` 继承，所有字体样式直接挂在 `<Text>` 上。
   - `nsh` 模板统一写 `class`，禁用 `className` 与 `classList`（官网由 `vp check` 中 `vibevalley/style-attrs` 自动拦截）。
   - 多状态/变体样式表使用 `Record<Variant, string>` 映射每行写一档；调用方传入的 `class?: string` 仅补位置、外边距或弹性拉伸，需要覆盖组件内置背景/高度/圆角时显式给组件增开变体参数（`tone` / `size`）。
3. **单行防撑破、控件复用与圆角降档**：
   - 任何列表行、卡片标题或带徽标的水平行，弹性文字父容器必须带 `min-w-0 flex-1`，文字节点带 `truncate`；管理类列表页用 `<PageBody width="manage">`（`max-w-5xl`），文档/设置页用 `prose`（`max-w-3xl`）以免宽屏拉伸过长。
   - 控件一律优先复用共用原语：检索框用 `SearchField`，动作链接用 `ButtonLink`，数量徽标用 `CountPill`，行内报错/通知用 `Banner`，键帽提示用 `Kbd`，侧栏折叠组用 `SidebarSection`，空搜索用 `Empty` (`compact`)，开关与复选框用 `Toggle` / `Checkbox`，分段切换用 `Segmented`，禁止在业务页手搓第二份。
   - 外框 `rounded-lg` (`8px`) 内层嵌 `rounded-md` (`6px`) 或 `rounded-sm` (`4px`)，内层圆角始终小于等于外框减内边距；宿主工作区（`apps/mac/ui/workspace/`）统一取 `radius.sm`/`md`/`lg`/`tray` 令牌与 `apps/mac/ui/design/surface.tsx` 的 `focusRing(p())`。
4. **选中态与聚焦态零位移原则**：
   - 选中、聚焦或激活状态严禁改变元素外盒尺寸或挤动兄弟元素：禁止在选中态切换不同的 `borderWidth`（如 `border` 与 `border-2` 互切、`borderWidth: 1` 与 `0`/`2` 互切）、条件 `padding`、横排自适应宽度控件与侧栏行上的字重跳变（`font-normal` ↔ `font-medium`/`font-semibold`），以及向水平布局内插入流内占宽元素。
   - 需要更强描边、左竖条或聚焦条时，保持外框恒定 `border`（无框态配 `border-transparent`），并在容器内叠放 `pointer-events-none absolute inset-0`（或 GPUI `.absolute()`）的非占位指示层；横排选项卡/胶囊统一保持 `font-medium`（静态规则由 `scripts/audit/ui-tokens.ts` 的 `selection-layout-shift` 检查）。
5. **跨端视觉语法与按压反馈统一**：
   - 侧栏单选列表统一采用 `bg-selected` + 左侧 `2px` 竖条 `<ActiveBar />`（宿主侧栏用 `p().primary`）+ 恒定 `font-medium`（未读消息等语义徽标除外）。
   - 选中态边框统一用 `border-accent bg-selected`；`border-focus` 与 `outline-focus` 严格保留给键盘 `focus-visible` 与输入框 `focus-within`。
   - 按压反馈不改变几何尺寸（工作台用 `active:translate-y-px`，原生宿主外壳用 `opacity: 0.82`，禁止 `active:scale-*` 缩框）；提示气泡统一采用深墨水底色与 `14%` 反色边界（`Bubble`）。
6. **双主题四级表面抬升规则（Light / Dark Parity）**：
   - 背景严格遵守 `rail → side → page → elevated` 四级递增，确保深色模式下浮层始终比主底更亮而不出现「深色沉底倒挂」：
     - 所有携带 `shadow-float` 的弹窗（`Dialog`）、菜单（`MoreMenu`）、下拉列表（`Select`）、弹层（`Popover` / `DisplayMenu`）、浮动操作条以及在 `bg-side` 容器内抬起的控件（`Segmented` 滑块、看板卡片 `Board`）统一使用 `bg-elevated`。
     - 开关与滑块的圆钮（`ToggleSwitch`、`Slider`、`CatalogDetail`）在浅/深双主题下统一使用暖纸白 `bg-paper` 保持实体触感。
     - 工作区外壳（`apps/mac/ui/workspace/`）一律从 `apps/mac/ui/design/tokens.ts` 调用 `tok()`、`cardShadow()`、`tint()`，右键菜单复用 `apps/mac/ui/design/surface.tsx` 的 `contextMenuItemStyle` / `contextMenuPopupStyle`，禁止写死 `rgba(...)` 或亮/暗手工特例。

## 8.3 状态、并发与键盘可达性

1. **核心状态只读不折**：禁止在 TS 组件内部自行推算工单阶段文案、农田作物状态或帮工排队位置；缺字段时到 `crates/vibevalley-protocol/src/contract/` 补契约与 Rust `reduce` 后执行 `vp run protocol:ts` 重生成协议。
2. **显式状态机与幂等保护**：多步弹窗、提交锁与复杂视图选择必须抽离至独立纯函数模型文件（如 `closeFlow.ts`、`draftSubmit.ts`、`libraryView.ts`），销毁动作使用 `ConfirmButton`，发消息与建单使用 `createAct` / `newSendKey` 防重放，绝不引入硬编码睡眠等待。
3. **键盘一等可达与无障碍完备**：可点击 `<View>` 须附带 `role="button"`（或对应语义角色）、`accessibilityLabel` 与明确焦点环样式（`focus-visible:outline-2 focus-visible:outline-focus`）；新快捷键登记入 `apps/mac/ui/infra/base/shortcuts.ts` 以便 `ShortcutSheet` 自动收录，不与全局或 `Workspace` 热键冲突。
4. **多语言不漏键**：面向用户的全部文案必须录入 `crates/vibevalley-i18n/locales/{zh,en}/` 词典并以 `t("key")` 调用，同时在页面中核验中英文双语长度不会挤乱排版。

## 8.4 提交前强制自查清单

改完代码准备交付前依次确认并运行对应校验命令：

- [ ] **令牌与静态护栏检查**：运行 `vpx scripts/gen/tokens.ts --check` 与 `vpx scripts/audit/ui-tokens.ts` 确认零漂移与零违规（改动 `design/tokens.json` 后先跑 `vpx scripts/gen/tokens.ts`）。
- [ ] **页面级静态检查**：工作台修改执行 `vp run mac:check`；官网修改执行 `vp run site:check`；协议修改先跑 `vp run protocol:ts` 再验证。
- [ ] **词典漏翻与多余检查**：运行 `vpx scripts/gen/i18n.ts check` 确认无缺失或未用键（若改动词典则先运行 `vp run i18n:gen`）。
- [ ] **生成产物一致性检查**：运行 `vpx scripts/gen/primitives.ts --check`（若有导出原语增删先运行 `vpx scripts/gen/primitives.ts` 刷新）。
- [ ] **文档与术语核对**：涉及文档或规范更新时运行 `vpx scripts/docs/doc-links.ts`、`vpx scripts/docs/glossary.ts` 与 `vpx scripts/docs/stale-names.ts`。
- [ ] **双主题真实截图比对**：按 [vv-acceptance 的应用分册](.agents/skills/vv-acceptance/references/app.md)在真实启动的 `vibevalley-mac`（浅色 + 深色两套主题、典型与极端密级或窄窗 `< 768px`）采集修改前后截图并核验无截断、无重叠、无失真色块。

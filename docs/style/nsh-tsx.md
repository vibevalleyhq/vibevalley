# NSH TSX 编码与响应式规范

`apps/mac/ui` 与 `apps/mobile/src` 的页面运行在 `nsh`（`0.7.1`）的细粒度响应式模型上，不是 React 的虚拟 DOM 整树重渲染。违反本规范会导致子树反复卸载重挂、滚动位置跳动、输入框失焦、菜单鼠标移出即关闭或列表复用串态。本文只管 `nsh` TSX 的响应式语义；格式、命名与样式另见 [code.md](docs/style/code.md)、[naming.md](docs/style/naming.md) 与 [08-agent-ui-guide.md](docs/design/08-agent-ui-guide.md)。

## 核心心智模型

`nsh` 编译器把 TSX 转成 `nsh:rt` 的原语调用（`element`、`prop`、`bindProp`、`insert`、`cond`、`each`、`component`），运行时遵循三条机制：

1. **组件函数只在挂载时执行一次（且在 `untracked` 内）**：后续状态变化不会重新调用组件函数，只触发 `bindProp`、`insert`、`cond`、`each`、`computed` 与 `effect` 内部注册的依赖。
2. **组件 props 经 getter 延迟求值**：`<Row item={x()} />` 会编译为 `{ get item() { return x(); } }`。只要在 JSX、闭包、`computed` 或 `effect` 内按 `props.item` 读取，更新就能沿依赖图向下传递；在组件顶层解构或提前赋值给局部变量，会当场把值冻结在首帧。
3. **节点复用取决于 JS 对象身份**：`insert` 或 `bindProp` 里的表达式每次重新求值若调用了 `component(...)` 或创建新元素，前一颗子树会被整棵卸载并重挂，丢失原生 `<Scroll>` 偏移、`<Tree>` 内部状态、`<Input>` 焦点、`<WebView>` 文档以及组件局部 `signal`。

## 规则 1：动态 JSX 分支统一用 `<If>`

**要求**：凡是在 JSX 子节点、JSX 属性（`tooltip`、`right`、`else` 等）或渲染回调内按动态条件切换 JSX，应使用 `<If when={...} else={...}>`，不应使用裸三元运算符（`cond ? <A /> : <B />`）或逻辑短路（`cond && <A />`）。静态属性（如 `class` 字符串、`style` 对象、`disabled` 布尔值）可使用三元表达式。

**原因**：裸三元 `{panel() === "files" ? <FileTree frame={files()} /> : null}` 会编译为 `insert(parent, () => panel() === "files" ? component(FileTree, ...) : null)`。只要 `panel()` 读取的上游帧（如 `rail()`）刷新一次，即使结果仍是 `"files"`，`insert` 也会重新求值并新建 `<FileTree>` 实例，造成整棵树卸载重挂（`apps/mac/ui/workspace/Sidebar.tsx`、`apps/mac/ui/workspace/FileTree.tsx`）。`<If>` 编译为 `cond`，对条件真假做去重，分支未切换时不重挂子树。

**注意**：在 `nsh 0.6.0` 中，`<If else={cond ? <A /> : null}>` 存在**双层箭头陷阱**。编译器既会给动态 JSX 表达式包一层 `() => ...`，又会给 `<If>` 的 `else` 槽位再包一层 `() => ...`，产出 `cond(..., ..., () => () => cond ? <A /> : null)`。进入 `else` 分支后，内层 thunk 仍会在每次依赖变化时重挂 `<A />`（如 `apps/mac/ui/features/session/RunsPage.tsx` 的 `TrajectoryLog` 与头像）。多分支切换应嵌套 `<If>`，不在 `else` 内写裸三元：

```tsx
// 错误：nsh 0.6.0 编译出 () => () => cond ? component(...) : null，每次切片刷新都会重挂
<If when={entry.kind === "orchestrator"} else={entry.kind === "worker" ? <WorkerView /> : null}>
  <OrchestratorView />
</If>

// 正确：else 内嵌套 <If>，分支稳定时不重挂
<If
  when={props.entry.kind === "orchestrator"}
  else={
    <If when={props.entry.kind === "worker" ? props.entry : undefined}>
      {(w) => <WorkerView entry={w()} />}
    </If>
  }
>
  <OrchestratorView />
</If>
```

**规则补充**：

- `tooltip`、`right` 等 JSX 属性同样应使用 `<If>`：`tooltip={<If when={props.title}>{(title) => <Bubble text={title()} />}</If>}`，避免每次父级信号刷新重新构造 `<Bubble>`。
- 使用 `<If when={val()}>{(v) => ...}</If>` 的函数子节点时，不应在回调顶层写 `const x = v()` 提前解包；应在 JSX 或派生闭包内调用 `v()`，确保同分支内值更新仍能响应。

静态检查：`vibevalley/nsh-no-jsx-conditional`、`vibevalley/nsh-no-eager-accessor`。

## 规则 2：动态列表统一用 `<Each key>` 或 `<List keyExtractor>`

**要求**：渲染动态列表应使用 `<Each of={...} key={...}>` 或虚拟化 `<List each={...} keyExtractor={...}>`，不应在 JSX 中使用 `.map()` 或返回 JSX 数组的 IIFE。`<Each>` 应显式传入稳定的 `key`（如 `key={(item) => item.id}`），仅在按位原地编辑的定序列表上使用 `key="index"`。

**原因（缺 `key` 陷阱）**：`<Each>` 缺省时以元素本身为键——原始类型按值比较，对象类型按 JS 指针身份（`Key::Object(ptr)`）比较。服务端切片或桌面帧每次推送都会反序列化出全新的对象引用，缺 `key` 会让 `<Each>` 把每一行都判定为新项并整行卸载重挂，导致 `<HtmlFrame>` 重载 WebView、`<TextInput>` 失焦、行内菜单与折叠状态清空。

```tsx
// 错误：每次帧更新都是新对象引用，整列卸载重挂
<Each of={items()}>{(item) => <ItemRow item={item()} />}</Each>

// 正确：按稳定业务主键复用行实例
<Each of={items()} key={(item) => item.id}>{(item) => <ItemRow item={item()} />}</Each>
```

**`<List>` 复用单元格的局部状态隔离规则**：`<List>` 滚动或替换数据时复用已挂载的单元格组件，不会重新执行组件函数，只会更新 `props`。单元格内任何局部 `signal`（如悬停态 `hovered`、展开态 `open`、折叠态 `fold`、工具栏菜单态 `menu`）在复用后若不重置，会把上一条记录的状态串到下一条记录。单元格组件应通过 `createEffect` 或 `effect` 监听业务主键变化来重置局部 `signal`（见 `apps/mac/ui/features/channel/views/MessageList.tsx` 与 `apps/mac/ui/features/session/WorkLog.tsx`），或把状态外提到以主键索引的 `Set`/`Map` 中。

静态检查：`vibevalley/nsh-no-jsx-map`、`vibevalley/nsh-each-key`。

## 规则 3：不解构 `props`，不提前读取响应式值

**要求**：

1. 组件参数与组件顶层不应解构 `props`（禁用 `function Row({ item })` 与 `const { item } = props`）；需要拆分透传属性时，应使用 `"nsh"` 导出的 `split(props, [...])`。
2. 组件顶层与 `<If>` / `<Each>` 渲染回调顶层不应提前读取 `props.x`、`signal()` 或回调访问器 `item()` 并存入局部变量或用于顶层 `if` 早返回；只应在 JSX 表达式、闭包 `() => ...`、`computed` 或 `effect` 内读取。确实只需要挂载瞬间快照时（如编辑框初值），应显式包裹 `untracked(() => ...)`。
3. 向 `render prop` 传递会高频变化的局部状态时，应传递访问器 `() => T` 而非裸值 `T`。例如 `Frame` 的 `tools` 应签名为 `tools?: (hovered: () => boolean) => JSX.Element`（见 `apps/mac/ui/features/channel/views/MessageList.tsx`）；传裸布尔值 `props.tools?.(hovered())` 会在鼠标移出时重新执行 `tools` 回调，直接卸载正在打开的表情选择器与更多菜单。

```tsx
// 错误：顶层读取 props.conversationId，切换主助手后查询永远停在第一个 id
export function PendingApprovals(props: { conversationId: string }) {
  const id = props.conversationId;
  const query = useQuery(() => approvalsQuery(id));
  ...
}

// 正确：在响应式闭包内按需读取 props.conversationId
export function PendingApprovals(props: { conversationId: string }) {
  const query = useQuery(() => approvalsQuery(props.conversationId));
  ...
}
```

静态检查：`vibevalley/nsh-no-props-destructure`、`vibevalley/nsh-no-eager-accessor`。

## 规则 4：派生缓存、副作用定时器与滚动容器

1. **多处读取、索引表与 `effect` 依赖的派生应用 `computed()`**：在多个 JSX 节点读取、`O(N)` 扫描/建 `Map`（如文件树 `byId`、成员表 `memberMap`、命令详情 `detailFor`、worktree 元信息 `worktreeMetaMap`）或作为 `effect` / `<If>` 条件的布尔派生（如 `hasWorkingTab`、`hasItems`、`isRepo`），应使用 `computed(...)` 缓存结果，避免每次读取重复遍历或在布尔值未变时反复触发 `effect`。
2. **避免自取消的 `effect` 定时器**：若同一个 `effect` 既读取了某信号（如 `removing()`、`committing()`），又在分支里改写该信号并 `return () => clearTimeout(timer)`，改写会立即触发该 `effect` 重跑，先执行上一次的清理函数，把刚创建的 `setTimeout` 当场取消（导致成功提醒永远不自动消失）。短暂提示的自动清除应拆成只订阅提示信号本身的独立 `effect`（并在回调内用 `untracked` 校验），或使用 `apps/mac/ui/infra/base/timer.ts` 的 `useTimeout()`。
3. **组件内不应直接调用 `setInterval`**：应使用 `apps/mac/ui/infra/base/dom.tsx` 的共享时钟桶 `useNow(ms)` 或 `apps/mac/ui/infra/base/timer.ts` 的 `useInterval(fn, ms)`（静态检查：`vibevalley/no-component-interval`）。
4. **`<Tree>` 自带 `<Scroll>`，避免同轴嵌套 `<Scroll>`**：`nsh/base` 的 `<Tree>` 内部已包含纵向 `<Scroll>`，不应再把 `<Tree>` 包进外层纵向 `<Scroll>`；其余场景嵌套同轴 `<Scroll>` 时，内层应设置明确的最大高度（如 `max-h-40`）。

## 规则 5：高频输入、拖拽与持久化解耦

1. **受控输入与拖拽回调去重**：`<Input>` 的 `onSelectionChange` 应在更新信号前对比 `untracked(selection)`（`start` 与 `end` 未变直接返回）；`onChange` 与 `Splitter` 拖拽（`PanResponder` `onPanResponderMove`）应跳过与当前值相等的写入，防止重复信号触发整段视图或桥接回传（见 `apps/mac/ui/features/channel/views/Composer.tsx` 与 `apps/mac/ui/design/Splitter.tsx`）。
2. **频道草稿 `250 ms` 缓冲与按需刷盘**：高频键入不应每次按键都同步写入持久存储。频道输入框通过 `drafts.text(channel, text)` 在内存 `bufferedText` 缓冲 `DRAFT_DEBOUNCE_MS = 250` ms 后落盘，并在发送清空（`drafts.clear`）、其它字段更新（`put`）以及 `pagehide` / `beforeunload` 时通过 `flushDrafts()` 合并刷盘（见 `apps/mac/ui/features/channel/model/composing.ts`）。
3. **按键合并写盘（`createPersistentStorage` / `createCoalescedStorage`）**：Mac 端 `apps/mac/ui/infra/state/storage.ts` 的 `createPersistentStorage` 与移动端 `apps/mobile/src/infra/storage.ts` 的 `createCoalescedStorage` 用内存缓存保持同步/即时读取，异步持久化经 `queued` `Map` 按键合并后串行提交到底层 `Storage`，连续写或删除同一键只落最新状态，测试与退出点通过 `flush()` 显式等待落盘完成。
4. **`prefs` 相等性守卫与 `computed()` 窄选择隔离**：`apps/mac/ui/infra/state/prefs.ts` 的 `set` 与 `setWidth` 应在更新前用 `Object.is` / `===` 校验字段是否变化，相等时直接返回原对象以跳过存储写入；消费侧通过 `usePrefs(select)` 与 `usePaneWidth`（`apps/mac/ui/design/Splitter.tsx`）经 `computed()` 隔离单个字段订阅，保证调整侧栏宽度不会重跑 `theme` 等无关计算（静态检查：`vibevalley/nsh-no-direct-storage-in-event`）。
5. **`keymap.bind` 用 `computed` 布尔条件隔离**：全局快捷键绑定应放进 `effect()` 并由 `computed()` 产出的低频布尔条件（如 `menuOpen`、`isEmpty`、`swarmOpen`）守卫，不应在绑定条件或 `effect` 依赖里直接读取原始文本信号 `text()` / `draft()`，避免每次按键都卸载并重建键盘监听器（见 `apps/mac/ui/features/channel/views/Composer.tsx`；静态检查：`vibevalley/nsh-keymap-no-text-signal`）。

## 规则 6：乐观交互先行与失败可回滚

1. **发送即时清空输入并插入乐观占位**：用户提交消息时应立即清空输入草稿并在消息流插入本地占位，不得等待服务端 RPC 完成才清空输入框，覆盖以下四条消息通道：
   - **Workspace Chat**（`apps/mac/ui/workspace/ChatPane.tsx`）：立即清空 `draft` 与 `attachedFiles`，分配负局部序号 `seq = --localSeq` 记入 `inFlightOptimistic` 并通过 `mergeChatSteps` 插入 `user/message` 占位，新建会话期间将阶段置为 `"starting"`。
   - **Channel Chat**（`apps/mac/ui/features/channel/model/composing.ts`、`apps/mac/ui/features/channel/views/MessageList.tsx`）：`createComposer` 立即执行 `edit("", 0)` 与 `ways.sent?.()`，未确认发送经 `chatSay`（`defineIntent`）与 `pendingLines` 渲染 `"sending"` / `"failed"` 占位，待服务端带相同 `sendKey` 的消息到达 `followed` 后自动替换。
   - **FarmPhone**（`apps/mac/ui/farm/FarmPhone.tsx`）与 **Mobile**（`apps/mobile/src/features/ChannelsTab.tsx`）：同样遵循发送即时清空草稿、请求期间不阻塞连续输入体验的乐观交互约定。
2. **防慢启动初始空 `history` 擦除在途占位**：会话尚未就绪或慢启动时，服务端首次推送的 `history` 可能为空列表。`WorkspaceChatPane` 在处理 `history` 事件时应保留仍在 `inFlightOptimistic` 且尚未被 `incomingUserTexts` 回显的本地负 `seq` 占位，仅清理已落地或被回显替代的占位，防止消息闪失。
3. **失败恢复草稿但不覆盖新输入**：发送失败执行回滚（如 `ChatPane.tsx` 的 `rollbackOptimistic` 或 `FarmPhone.tsx` 的 `catch` 分支）删除失败占位并恢复原草稿时，应先校验当前输入仍为空（`untracked(draft) === ""` / `untracked(input) === ""`）且附件列表为空后再回填，严禁覆盖用户在等待期间重新键入的新内容。
4. **`sendKey` 幂等**：所有频道发送与失败重试（`composing.ts` 的 `chatSay`、`FarmPhone.tsx` 的 `pendingKey` 等）应生成并复用稳定的 `sendKey`（`newSendKey()`），失败重试沿用原 `sendKey`，确保网络超时重试不会产生重复消息。

## 静态检查清单

`scripts/audit/oxlint-plugin.ts` 提供以下规则并在 `vite.config.ts` 接入 `vp check`：

| 规则 | 拦截对象 | 推荐改法 |
|---|---|---|
| `vibevalley/nsh-no-jsx-conditional` | JSX 表达式或渲染回调中的裸三元 / `&&` / `\|\|` 产出 JSX | 改用 `<If when={...} else={...}>`（多分支嵌套 `<If>`） |
| `vibevalley/nsh-no-jsx-map` | 产出 JSX 的 `.map()` 或 JSX 内返回 JSX 的 IIFE | 改用 `<Each of={...} key={...}>` 或 `<List keyExtractor={...}>` |
| `vibevalley/nsh-each-key` | 缺少 `key` 属性的 `<Each>` | 补充稳定业务主键 `key={(x) => x.id}` 或 `key="index"` |
| `vibevalley/nsh-no-props-destructure` | 组件参数解构或顶层 `const { a } = props` | 直接读 `props.a`，拆分透传属性用 `split(props, [...])` |
| `vibevalley/nsh-no-props-spread` | 组件内 `{ ...props }` 对象展开或 `Object.assign(..., props)` | 用 `split(props, [...])` 拆分属性或在 JSX / 派生闭包里按字段读取 |
| `vibevalley/nsh-no-eager-accessor` | 组件或 `<If>`/`<Each>`/`<List>` 回调顶层提前读取 `props.x` / 访问器 / `use*()` 信号 | 放入 JSX、派生闭包 `() => ...`、`computed`、`effect` 或 `untracked` |
| `vibevalley/nsh-no-async-reactive` | `async` 组件函数或传给 `effect` / `computed` 的 `async` 回调 | 保持组件与响应回调同步，通过信号或事件驱动异步任务 |
| `vibevalley/nsh-no-jsx-inline-reactive` | 在 JSX 动态槽位或组件内嵌回调中内联创建 `signal` / `computed` / `effect` | 上提到组件顶层、`<If>`/`<Each>` 渲染回调顶层或模块 / hook |
| `vibevalley/nsh-no-react-isms` | 引入 `react`、`effect`/`computed` 传依赖数组、宿主上写 `onClick`/`onChangeText`/`htmlFor` 或非 `<Each>` 的 `key` | 改用 `nsh` 信号与原生属性（`onPress`、`onChange`、`<Each key>`） |
| `vibevalley/nsh-selection-change-guard` | `<Input>`/`<RichInlineField>` 的 `onSelectionChange` 未对比直接 `.set(...)` | 先用 `untracked` 读取并比较 `.start` / `.end` 相等后再写入 |
| `vibevalley/nsh-no-self-canceling-effect` | `effect` 同步读 `sig()` 又同步写 `sig.set(...)` 且返回 `clearTimeout` | 将状态写入移入定时或事件回调，避免自取消循环 |
| `vibevalley/nsh-no-view-text-class` | 在 `<View>` 上写不被 GPUI 继承的字号、字色、字重或截断类 | 将字体、字号与文本色类名移到内层 `<Text>` |
| `vibevalley/nsh-scroll-horizontal-flex-row` | `<Scroll horizontal>` 缺少 `flex-row` 类导致横向内容纵向堆叠或裁剪 | 为 `contentClass` 或 `class` 显式加上 `flex-row` |
| `vibevalley/no-component-interval` | 组件内直接调用 `setInterval` | 改用 `useNow(ms)` 或 `useInterval` |
| `vibevalley/nsh-no-direct-storage-in-event` | 输入或拖拽事件回调内直接同步写入 `localStorage` / `Storage` | 改用 `drafts.text` 缓冲、`createPersistentStorage` 合并或带相等性守卫的 `prefs` |
| `vibevalley/nsh-keymap-no-text-signal` | `keymap.bind` 所在的 `effect` 内直接读取原始文本信号（如 `text()`、`draft()`） | 抽成 `computed()` 布尔条件（如 `isEmpty`、`menuOpen`）作为 `effect` 守卫 |

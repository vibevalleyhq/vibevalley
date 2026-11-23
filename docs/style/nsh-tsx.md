# NSH TSX 编码与响应式规范

`apps/mac/ui` 与 `apps/mobile/src` 的页面运行在 `nsh`（`0.6.0`）的细粒度响应式模型上，不是 React 的虚拟 DOM 整树重渲染。违反本规范会导致子树反复卸载重挂、滚动位置跳动、输入框失焦、菜单鼠标移出即关闭或列表复用串态。本文只管 `nsh` TSX 的响应式语义；格式、命名与样式另见 [code.md](docs/style/code.md)、[naming.md](docs/style/naming.md) 与 [08-agent-ui-guide.md](docs/design/08-agent-ui-guide.md)。

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

## 静态检查清单

`scripts/audit/oxlint-plugin.ts` 提供以下规则并在 `vite.config.ts` 接入 `vp check`：

| 规则 | 拦截对象 | 推荐改法 |
|---|---|---|
| `vibevalley/nsh-no-jsx-conditional` | JSX 表达式或渲染回调中的裸三元 / `&&` / `\|\|` 产出 JSX | 改用 `<If when={...} else={...}>`（多分支嵌套 `<If>`） |
| `vibevalley/nsh-no-jsx-map` | 产出 JSX 的 `.map()` 或 JSX 内返回 JSX 的 IIFE | 改用 `<Each of={...} key={...}>` 或 `<List keyExtractor={...}>` |
| `vibevalley/nsh-each-key` | 缺少 `key` 属性的 `<Each>` | 补充稳定业务主键 `key={(x) => x.id}` 或 `key="index"` |
| `vibevalley/nsh-no-props-destructure` | 组件参数解构或顶层 `const { a } = props` | 直接读 `props.a`，拆分透传属性用 `split(props, [...])` |
| `vibevalley/nsh-no-eager-accessor` | 组件或 `<If>`/`<Each>` 回调顶层提前读取 `props.x` / 访问器 / 信号 | 放入 JSX、派生闭包 `() => ...`、`computed`、`effect` 或 `untracked` |
| `vibevalley/no-component-interval` | 组件内直接调用 `setInterval` | 改用 `useNow(ms)` 或 `useInterval` |

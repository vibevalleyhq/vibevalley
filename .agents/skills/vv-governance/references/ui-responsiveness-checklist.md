# UI 响应性与帧去重评审清单

在 VibeValley 里评审 Mac 工作台（`apps/mac/ui`）、桌面壳桥（`apps/mac/src/hosted`、`apps/mac/src/shell`）与 Mobile 客户端（`apps/mobile/src`）的界面改动或性能优化时，逐节核对以下检查项。每条写清**查什么**、**怎么判通过**和**对照文件**。

## 1. 零卡顿输入（`onChange` / `onSelectionChange` 去重、草稿防抖、存储合并写）

- [ ] **`onSelectionChange` 先比再写**：受控 `<Input>` 的 `onSelectionChange`（参考 `apps/mac/ui/features/channel/views/Composer.tsx`）必须用 `untracked(selection)` 比对 `start`/`end`，坐标未变时直接 `return`，禁止每次击键触发状态回环写。
- [ ] **`onChange` 不阻塞击键**：`onChange` 内只更新内存信号与轻量光标/快捷符号替换（`untracked(...)` 读取旧值），不得在击键热路径同步序列化大对象或扫全量消息列表。
- [ ] **草稿防抖 + 退出必刷盘**：文本草稿（`drafts.text` in `apps/mac/ui/features/channel/model/composing.ts`）把最新文本缓存在 `bufferedText` 中并以 `DRAFT_DEBOUNCE_MS` 防抖落盘；`draftOf()` 同步合入 `bufferedText` 保证读取最新；`reply`/`clear`/`pagehide`/`beforeunload` 必须先调 `flushDrafts()` 防止丢字。
- [ ] **持久化存储按 key 合并写**：`createPersistentStorage`（`apps/mac/ui/infra/state/storage.ts`）必须同步更新内存 `cache`，并对同一 `key` 的高频 `setItem`/`removeItem` 在 `queued` 里覆盖合并（`drain()` 在途时不堆叠重复写），且提供 `flush()` 供测试与关闭收尾等待。
- [ ] **禁止组件级定时轮询**：列表行/卡片禁止各自起 `setInterval`（由 `vibevalley/no-component-interval` 守住），共享按桶复用的时钟 `useNow`（`apps/mac/ui/infra/base/dom.tsx`）。
- [ ] **Mobile 列表与输入保持轻量化**：`apps/mobile/src/features/ChannelsTab.tsx` 保持 `<List>` 的 `keyExtractor`、`estimatedItemSize`、`maintainVisibleContentPosition` 和 `keyboardDismissMode="on-drag"`，不在 `onInput` 回调里触发列表全量重排或订阅重建。

## 2. 切断 `computed()` 扇出（`canSend`、细粒度 selector、`usePrefs` / `usePaneWidth`、`keymap.bind` 布尔隔离）

- [ ] **布尔化派生发送按钮态**：发送按钮的 `disabled` / 图标色调必须读取收敛后的 `canSend = computed(() => ...)`（见 `createComposer` in `apps/mac/ui/features/channel/model/composing.ts`、`apps/mac/ui/workspace/ChatPane.tsx`、`apps/mac/ui/farm/FarmPhone.tsx`），禁止直接在 JSX 里读原始 `text()` / `draft()`，确保打字期间 `canSend` 为 `true` 时不反复重算按钮子树。
- [ ] **细粒度 `computed()` selector 与无变化空操作**：
  - 偏好读取走 `usePrefs(select)`（`apps/mac/ui/infra/state/prefs.ts`），面板宽度走 `usePaneWidth`（`apps/mac/ui/design/Splitter.tsx`），切片实体按 id 走索引 selector（`useSession`、`useIssue`、`useThreadOwner` in `apps/mac/ui/infra/frame.ts`），不订阅无关切片或整张表。
  - 写入侧（`setWidth`、`set`）必须用 `Object.is` / 等值判断拦截未变化的更新，返回原引用以跳过存储写入与下游通知（回归用例见 `apps/mac/ui/app/perf.test.ts`）。
- [ ] **`keymap.bind` 布尔隔离**：放进 `effect()` 的动态 `keymap.bind(...)`（如 `Composer.tsx` 的 `menuOpen`、`isEmpty`、`replying()` 与 `ChatPane.tsx` 的 `swarmOpen`）只能依赖窄 `computed()` 布尔门控；静态绑定仅注册一次并在回调内判断焦点/条件（如 `Splitter.tsx` 的 `focused() && ...`），禁止随打字字符数或数组长度每次解绑重绑快捷键。
- [ ] **遵守 `nsh` 细粒度响应式**：动态分支用 `<If>`，列表用带稳定 `key` 的 `<Each>` / `<List>`，不解构 `props`、不在组件体提前求值访问器（由 `vite.config.ts` 中 `vibevalley/nsh-*` 规则检查）。

## 3. 乐观发送与失败回滚（`inFlightOptimistic`、`sendKey` 幂等）

- [ ] **先上屏再发请求，收尾精准去重**：工作区聊天发送（`apps/mac/ui/workspace/ChatPane.tsx`）先清空草稿与附件、分配负 `localSeq` 写入 `inFlightOptimistic` 并插入本地 `user/message` 占位；收到规范 `"history"` 或 `"event"` 回声时按文本/序号移除对应占位并归入规范步骤。
- [ ] **失败/缺会话完整回滚**：`ensureSession()` 失败、`sendWorkspaceMessage` 返回非 `ok` 或抛异常时，必须执行 `rollbackOptimistic()`：删除占位步骤、清理 `steeredSeqs` 与 `inFlightOptimistic`，且仅在用户尚未输入新草稿时恢复 `rawDraft` 与 `files`。
- [ ] **变异请求带幂等 `sendKey`**：所有消息、评论与语音发送（`channel.message.send`、`issue.comment.create`、`voice.hear`）在重试或异步发布场景下必须传唯一 `sendKey`（如 `newSendKey()` / `publicationKey(...)`；检查 Mobile `apps/mobile/src/features/ChannelsTab.tsx` 新增重试或乐观发送时同样带上 `sendKey`），避免网络抖动造成重复落库。

## 4. 原生壳帧去重（Rust `Outbox` 与 `Shell` action 门控）

- [ ] **Rust → TSX 帧内容去重**：`Outbox::envelope`（`apps/mac/src/hosted/bridge.rs`）按 topic 比对上一次发送的 `Value`（`entry.0 > 0 && entry.1 == data`），完全一致时返回 `None` 跳过序列化与桥接推送；仅在视图重载 `Outbox::reset()` 后从 `rev: 1` 重放。
- [ ] **TSX → Rust action 变化门控**：`apps/mac/src/shell/host_bridge.rs` 处理 `GlobalRail`、`GlobalRoute`、`ShowPanel`、`ExpandDir`、`CollapseDir`、`PaletteQuery` 等高频或重复 action 时，必须先对比当前状态，确实发生变化才触发 `cx.notify()`、`save_settings()`、`push_sidebar()` 或 `refresh_palette()`。
- [ ] **拖拽缩放防抖去重**：`Splitter`（`apps/mac/ui/design/Splitter.tsx`）在 `to(w)` 里取整限幅后必须比对 `untracked(() => props.width)` 与 `lastSent`，相同宽度不重复调用 `designHost.setPrefWidth`。

## 验证命令

改动涉及 Mac 工作台、Mobile 或共享包时，运行下列检查并附真实输出：

```bash
vp run mac:check
vp run mobile:check
vp check
```

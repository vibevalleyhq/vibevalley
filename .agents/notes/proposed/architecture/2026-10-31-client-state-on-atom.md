# Agent Note: 页面的中间层建在 Effect Atom 上

Status: proposed

## Problem

页面和服务端之间只有两层：一条 SSE 帧（`infra/frames.ts` → `infra/frame.ts` 的 Solid store）和 Solid Query 的 REST 读取。主人发出的每个动作没有归处，各处自己处理，盘点（main @ 99ff18c0）看到的是：

- **动作没有中间状态。** 约 115 处调用、73 种操作，各自管等待和失败；Solid 2 的 `action`、`createOptimistic`、`isPending` 一处没用。没有一个动作等帧确认：看板拖一张卡，卡先弹回原栏，REST 的历史重读回来再跳过去（`IssuesPage.tsx`、`Board.tsx`）；农场聊天的「发送中」15 秒后不管到没到都删掉，重连时消失又出现（`composing.ts`）；工作台的输入框根本没有「发送中」。
- **工单存了两份。** 看板和详情从 REST 的 `issue.history.list` 建，农场从帧读；帧里任何工单一变，整个 `["issues"]` 前缀失效，连 diff、时间线、轮次一起重读，一次拖动失效两次。帧本来就带着开着的和最近关的工单。
- **重试不安全。** 表情、置顶、归档是开关（重发一次就关回去）；`issue.create`、`thread.create`、`memory.create`、`issue.status.update` 没有请求的键；ProjectMap、农场的建议每按一次一把新键，ArtifactsPage 没有键；输入框的重试键是闭包，离开频道就丢。
- **失败说得乱。** 15 处失败用普通 toast，约 14 处吞掉，10 个各写一遍的「调用加 toast」包装；3 处 busy 没有 `finally`。
- **断线没人管。** 链接断了只在外框画一个灯，动作照发、照失败。

## Proposal

主人拍板：中间层建在 Effect 自带的 Atom（`effect/reactivity`，effect 4.0.5）上，只此一层。

### 分层

- **`state/atom.ts`**：Atom 到 Solid 2 的绑定。一个 `AtomRegistry`，在 `Root` 经 `RegistryContext` 给出（故事和测试各建一个）；`useAtom(atom)` 是 `registry.subscribe` 读成的信号（经 `createExternal`，卸载时退订，**不挂起**，所以等一个 atom 不会拦住帧）；`useAtomSet`、`useAtomMount`。帧是一个 atom（`framesAtom`），从 `infra/frames.ts` 喂（`framesSource`，测试换成自己的）；`frames.ts` 仍和框架无关，`frame.ts` 的 store、`useCore`、`useFrames` 不动，以后可以改从 atom 读。
- **`state/intent.ts`**：主人要的、还没在画面上看到的一件事。一种意图是 `{ send(input, key), confirmed(frame, intent), watch?, whileLost, timeoutMs }`（`defineIntent`）；意图按请求键存在 `Atom.family` 里，所以比发它的组件活得久；状态只有 `pending`、`failed`。
  - **结算只看画面**：帧的 `seq` 追上答复的 `seq`（`bySeq`），或这种意图自己的判断（一句话：频道里出现带同一个 `sendKey` 的那条，`watch` 期间一直跟着那个频道）；不在答复到时、不在计时器到时结算。答复丢了但改动已经在画面上，也算结算。
  - **超时只标失败**：发出后 `timeoutMs` 没有结算就 `failed`，留着；迟到的答复照算。重试用同一把键；也能放手（`drop`）。
  - **断线**：帧的 `link` 是 `lost` 时，带键的意图排队，连回来发一次；不能重复的拒绝（直接 `failed`，原因是「没连上」）。
  - 有意图在时，运行器订阅 `framesAtom`，所以发起它的页面关了，帧照样来。
  - 显示经各 feature 自己的纯函数叠上去，**只改主人改的那个字段**（看板只改卡在哪一栏），服务端的结论（排队、能不能派）照帧；页面仍不折事实。`sendOnce`：按钮再按一次是同一个意图，不是新键。
- **`ui/act.ts`**：没有叠加的一次动作：`busy` 在 `finally` 里放、失败用错误色的 toast 和 `reasonOf`。放在 `ui/` 而不是 `state/`：toast 在 `ui/`，`state` 在 `ui` 前面，import 不到。
- **lint `vibevalley/atom-door`**：`apps/web/src` 里只有 `state/` 能 import `effect/reactivity`（类型也算）。

### 服务端和契约

- `StateFrame.seq`：`Core.apply` 每次真改了状态加一；帧带着和它的状态同时读的 seq。`issue.create`、`issue.update`、`issue.status.update` 答 `AppliedIssue`（工单加 `seq`，处理函数在服务返回后读 `Core.seq()`）。`issue.comment.create` 答 `Applied`（只有 `seq`）。
- 请求键 `requestKey`：`issue.create`、`issue.status.update`、`channel.thread.create`、`memory.create`，网关里每个操作一份（`apps/server/src/http/requestKey.ts`）：同键并发的等第一个，只记成功、失败就忘（重试会真的再做），每个操作最近 500 把，在内存里，重启就没了。
- 开关改成显式的设值：`channel.reaction.set`、`channel.pin.set`、`channel.archive.set`（`on`），设成已经是的值什么也不变。

### 分阶段

1. **地基加两个原型（本次）**：上面的地基；原型 A，看板把卡从待办拖到进行中（`features/issue/moves.ts`：`issueMove` 意图、`movedCards` 叠加；卡在目标栏 `data-state="moving"`，失败 `failed` 带重试和放回）；看板和列表的开着的工单改从帧读，REST 历史只补走了的帮工和「更早的」（`features/issue/rows.ts`），历史只在某张工单多了帮工或帮工离开时重读，diff 跟着帧里的工单变；动作后不再整个失效。原型 B，工作台和农场输入框说一句话（`chatSay` 意图，键就是 `sendKey`），两边都画「发送中」和「没发出去」，ProjectMap、ArtifactsPage 的回复、农场的建议走同一条路（`sendOnce`）。
2. **铺开（已做）**：工单的每次挪动走 `issueMove`（关闭、重开、详情页和农场的按钮、对话框、备选开工），对帮工说的话走 `issueSay`（`issue.comment.create` 改答 `Applied`，只有 `seq`），交付方式走 `issueDeliver`；表情、置顶、归档、提醒级别、标已读和标未读各是意图（`features/channel/marks.ts`、`reading.ts`，标未读失败时放开「留着未读」）；其余动作走 `createAct`（皮里 `createPixelAct`；busy 是计数，断线时不发、说没连上），10 个包装和 15 处普通色的失败都没了，吞掉的错误说出来；会再发的建一把键用到成功（`createRequestKey`）；档案的启用和农场的样子没有按字段改的接口，发之前先读最新的那份、只改那一栏；搜索和置顶只显示最新一次的答复、失败显示失败（`state/latest.ts`）；状态流连回来时 REST 全部重读；`follow.ts` 只留 8 个闲着的频道、单条缓存跟着改；`farm/frames.ts` 不再每次读都给新对象。lint `vibevalley/act-door`（组件里直接调会改东西的接口）、`vibevalley/failure-tone`（带原因的 toast 不是错误色）。
3. **收口**：`frame.ts` 的 store 从 `framesAtom` 读；Solid Query 的读取看是否也收到 atom；`localStorage` 的 7 个键收进一个经 atom 的偏好；`draft.ts` 的草稿（回复存的整条消息、输入框的斜杠命令也走 `createAct`）；状态流的心跳（半开连接）；语音通话和听写自己的状态机看是否收进意图。

## Alternatives considered

- **Solid 2 的 `createOptimistic`、`action`**：乐观值跟着一次 transition 走，transition 完（答复回来）就撤掉，我们的真相在之后的帧里，撤早了正是现在的「弹回去再跳」；它也不比组件活得久，离开频道就没了，断线排队、按键重试都得另写。
- **不用 Atom，手写 `state/intent.ts`**：几百行的订阅、派生、生命周期和 Atom 里已经有的重复；主人选了 Atom 做唯一的中间层，以后的派生、偏好、可序列化的值都在同一套里。
- **原样用 `@effect/atom-solid`**：要 `solid-js` 1；它的读取会挂起，挂起的读取会拦住同页的帧（README「Pending reads never suspend」）。自己写的绑定只有订阅加信号，几十行。
- **Atom 的 `optimistic`、`optimisticFn`**：成功时刷新源 atom 来结算，而我们的源是 SSE 推来的帧，不能「刷新」；失败即回滚，不留下失败的那件给主人重试。

## Acceptance criteria

- 拖一张能开工的待办到进行中：服务端卡着时卡在进行中、`data-state="moving"`，期间别的帧照常到（新写的工单出现在看板上），从放下到打开工单页卡不回到待办；4xx 时 `failed`，重试的 `requestKey` 和第一次一样；放回后是帧里的卡（`test/issue-moves.spec.ts`）。
- 工作台说一句话：服务端卡着时有一行「发送中」，放开后只剩一条；没到服务端的一句在频道里显示失败，离开再回来重试，键相同、只一条；状态流断着时说的话排着，连回来只发一次（`test/chat-intent.spec.ts`）。农场：答复丢了的那句只出现一次、不再发；失败的重试是同一把键（`test/composer-intent.spec.ts`）。
- `state/intent.test.ts`：拒绝后失败并留着、重试同键；帧先到答复后到时只结算一次；答复先到等帧；超时失败、迟到的答复照算；断线排队、连回来发一次，另一种拒绝；`sendOnce`；放手。`features/issue/moves.test.ts`、`rows.test.ts`、`features/channel/composing.test.ts` 查叠加和行。
- 服务端：`core.test.ts` 的 seq；`http/requestKey.test.ts`；`flows/request.test.ts`（同键只做一次、答复的 seq 不超过之后第一帧且那帧有这个改动、设两次只变一次）。
- `vibevalley/atom-door` 在 `state/` 外报 `effect/reactivity` 的 import。
- 第二阶段：`state/latest.test.ts`（迟到的旧答复丢掉、失败是失败）、`infra/query.test.ts`（连回来重读）、`features/channel/marks.test.ts`、`features/issue/moves.test.ts`、`say.test.ts`；`test/chat-unread-rollback.spec.ts`（标未读被拒：读的位置回去、错误色）、`test/chat-search-order.spec.ts`（第一次的答复扣住、晚到也不显示）、`issue-moves.spec.ts` 的详情页挪动、`issue-page.spec.ts` 的话被拒后同一把键重试；`act-door`、`failure-tone` 的 RuleTester。

## Risks

- **Atom 标着 `@stability unstable`**：API 会变。只有 `state/atom.ts`、`state/intent.ts`、`state/testing.ts` import 它（lint 拦），变了只改这里。
- **闪烁**：叠加只在帧追上答复后撤，撤时显示帧里的真相；服务端把一张卡排回待办（满了）时，卡会从进行中回到待办，这是真的，不是闪。只改主人改的字段，不在页面猜服务端的结论。
- **帧必须一直来**：绑定不挂起；有意图时运行器自己订阅帧，发起的页面关了也一样。
- **请求键在内存里**：服务端重启后同一把键会再做一次；一次重启正好卡在丢答复和重试之间的机会很小，要持久化时再进库。
- **一句话的结算靠频道的跟随**：意图在时跟着那个频道（WebSocket）；跟不上就 20 秒后失败，重试同键不会多一条。
- **放手的那句**：农场和工作台里放手就丢了，回复和附件在发出时已经交给那句话；第二阶段看要不要放回输入框。

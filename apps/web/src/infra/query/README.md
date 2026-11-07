# Query

Query 管 REST 读取、缓存、失效与取消；不缓存 SSE 帧，不发写操作。纯状态机在 `query/cache.ts`，Solid 订阅在 `query/solid.tsx`，公共入口是 `infra/query.ts`。运行代码和依赖不使用 TanStack。公共边界见 [infra](apps/web/src/infra/README.md)。

## 定义与使用

定义与订阅分开：

```tsx
const settingsQuery = defineQuery({
  schema: S.SettingsStatus,
  key: () => ["settings"],
  fetch: (_: void, context) => api.setting.get(context),
  ...retryRead,
});

const query = useQuery(settingsQuery, { enabled: () => props.open });
```

生成的 `VibeValleyApi` 方法接受可选请求选项 `{ signal }`，无参数方法把它放在第一个参数，有输入的方法放在第二个参数；生成器是 `scripts/api-client.ts`。Query 把 signal 交给传输，同时用代次阻止不理会取消的读取回写。取消不表示服务端已经停止执行。

定义把 key、输入、结果 Schema、fetch 和缓存策略绑定在一起。Schema 必填，优先复用 protocol 的 Codec；fetch 返回 unknown，缓存和 data 类型取 Schema 的 Type。响应先解码再提交成功缓存，转换、异步解码与传输共用 signal 和代次；解码失败保留旧成功记录，不重试，也不在错误中保留可能含密钥的 actual 值或 issues。`setData` 校验 Type 侧，不重复执行 wire 转换。调用定义返回只读描述，不发请求。`useQuery` 持有订阅。定义时校验策略，执行时不反复创建 Query client。

Key 只允许字符串、有限数字、布尔和 null 组成的只读元组；用保留类型与边界的编码，不用 `join()`。复杂过滤条件由领域查询定义归一化为这些段，不允许隐式序列化函数、Date、undefined 或任意对象。前缀失效按元组段匹配，不按字符串前缀匹配。

同一 client 内同一 key 必须来自同一个查询定义；冲突直接报开发错误，不由最后一个订阅者覆盖 fetch 或策略。调用方应提供不可变输入；描述持有输入，不替任意对象做深拷贝。key 应覆盖所有影响返回值的参数。服务端、身份和空间由 client 作用域隔离，不把密钥放进 key。档案与语音设置校验使用每个输入版本的随机 token 和 gcTime 0，不序列化可能含凭据的输入作为 key。

## 读取接口

| 接口 | 含义 |
|---|---|
| `query.snapshot()` | 一份带判别字段的完整快照，供穷尽分支 |
| `query.data()` | 当前 key 最近一次成功的数据，没有则 undefined |
| `query.error()` | 当前 key 最近一次查询失败；取消不伪装成业务错误 |
| `query.status()` | `idle / pending / success / error` |
| `query.fetching()` | 当前是否在请求或等待一次已安排的重试 |
| `query.stale()` | 已过有效期或被显式失效 |
| `query.previous()` | 显式启用 `keepPrevious` 后，前一个 key 的只读数据及其 key |
| `query.refetch()` | 强制读取，合并已有请求；返回完成时的完整快照，失败在 status/error 中，不把失败冒充数据或留下无人处理的 rejection |

`snapshot` 的缓存记录是 `{ value, updatedAt }` 或不存在，不用 `value === undefined` 判断是否成功，允许结果类型本身包含 undefined。

- 没有数据且未启用：idle；首次读取：pending。
- 首次读取失败：error，没有缓存记录。
- 成功后后台刷新：保留 success 与数据，fetching 为 true。
- 后台刷新失败：error，保留同 key 的缓存记录，并暴露错误。
- disabled 只停止自动读取和轮询，不删除已经收到的数据；手动 refetch 是明确读取请求。
- 切 key 默认不显示前一个结果。`keepPrevious` 只保留在订阅者的 `previous()`，不写入新 key，不冒充当前 key 成功。跨对象的编辑与保存不能使用 previous 数据。

成功提交时使用结果 Schema 的 `toEquivalence` 比较同 key 的领域值；相同结果保留缓存引用，`data()` 另有 memo，不因 fetching 或更新时间改变就重建列表子树。这只在读取完成或 setData 边界运行，不在渲染时深比较，也不替调用方原地修改输入兜底。网络错误由 API 层的 `ApiConnectionError` 标记，包装成人话后仍能被有限重试识别。

`stale()` 是响应式的：已订阅的过期时刻由可测试的时钟触发；不靠下次无关渲染碰巧发现过期。过期只改变状态，不自动不停刷新。

## Client 接口与默认值

`QueryProvider` 拥有一个 client，可接收显式创建的 `createQueryClient()`；`useQueryClient()` 读取它。Provider 卸载会 dispose，包括传入的实例，故一个 client 只交给一个 Provider 管生命周期。非组件调用者自行 dispose；每个故事画框有独立 client。

| 接口 | 语义 |
|---|---|
| `client.fetch(descriptor)` | 新鲜则读缓存，否则去重获取；返回结果，失败拒绝 |
| `client.refetch(descriptor)` | 同订阅者 refetch，返回成功或失败快照；显式读取租约保证 disabled 时也能读取 |
| `client.prefetch(descriptor)` | 同 fetch 的准备读取，不创建页面订阅；失败必须被调用方处理 |
| `client.read(descriptor)` | 只看已有快照，不发请求 |
| `client.setData(descriptor, update)` | updater 读取旧缓存记录，返回 `{ value }` 写入已确认的 REST 结果，返回 undefined 表示不写；`{ value: undefined }` 仍是有效结果 |
| `client.invalidate({ key })` | 精确失效；活跃且 enabled 的读取刷新，无订阅的只标旧 |
| `client.invalidate({ prefix })` | 按 key 段失效一组 |
| `client.invalidate()` | 当前作用域全部失效 |
| `client.fetching()`、`subscribeActivity()` | 给启动遮罩读请求活动，不暴露内部缓存容器 |
| `client.clear()`、`dispose()` | 清缓存并使旧响应失效；dispose 还永久关闭实例 |

`invalidate` 返回本批活跃刷新尝试的结果汇总。失败保留在各查询中，不制造无人处理的 rejection，也不把局部失败描述成全部成功。`setData` 不能存业务乐观覆盖层；已有调用处要区分服务端确认结果与仍待确认的编辑。

默认：staleTime 为 0，无订阅 gcTime 为 5 分钟，retry 为 0，不按窗口焦点刷新，不轮询。支持 Infinity 的 staleTime 和 gcTime 为 0。轮询由订阅者显式请求，多个订阅共享最短有效间隔，最后一个离开就停；每次请求结束再安排下次，不重叠。

重试按查询定义指定次数及可重试错误分类；现有默认一次重试的读请求在迁移时逐项显式承接。权限、解码、取消错误不重试。重试和轮询都有可取消的等待，不轮询 mutation，也不根据 HTTP 动词推断接口是否只读。

## 并发与清理

每个 entry 持有请求代次、失效代次和一次共享请求。跨 await 的提交检查在同一个同步临界段完成：

1. 发起时捕获两种代次。
2. 返回时请求代次不符则丢弃，不改变数据、错误或 fetching。
3. 请求期间被 invalidate：旧回答不能满足这次刷新；结束后合并为一次新请求。连续失效不无限创建并发请求。
4. `setData`、clear、dispose 会推进请求代次，使旧回答不能覆盖已确认的新数据。
5. 某个订阅者离开不取消其他订阅者或显式 fetch/prefetch 仍在等待的请求。最后一个需求释放后取消等待、尝试 abort，并阻止晚到结果写入。
6. GC 只回收无订阅、无显式读取租约的 entry；再次订阅取消回收。轮询和重试不使无人使用的缓存永生。

缓存不接管 SSE。lost → open 后由现有连接适配调用 invalidate，期间多次重连合并刷新。普通帧到达是否失效哪些 key，仍由拥有该读取的 feature 决定。

## 接入边界

| 使用处 | 职责 |
|---|---|
| `infra/query.ts`、各处 `useQuery` | enabled、staleTime、动态参数、每查询重试、轮询 |
| `infra/agents.ts`、仓库、语音、工单历史 | 当前 key 与显式 previous 分开，不能混用对象身份 |
| `infra/settings.ts`、档案、农机、LAN、PKM | 已确认结果的 setData 与旧请求竞态 |
| `features/session/events.ts` | 非组件读取、独立请求 key、gcTime 为 0；不能因缓存吞掉新轨迹 |
| `infra/opening.ts` | 活动订阅有清理；最长等待超时后不能遗留订阅 |
| `app/Root.tsx`、`stories.tsx` | client 的根作用域和测试隔离 |
| `infra/query.test.ts`、各处失效调用 | 重连和精确/前缀失效 |

## 测试

`cache.test.ts` 用受控 Promise 和假时钟测试：同 key 一次请求、key 切换、乱序返回、请求中失效、setData 对旧请求、共享取消、GC、轮询结束、重试上限、clear 后晚到结果、两个 client 隔离。必须测已有数据时刷新失败和结果为 undefined。

`schema.test.ts` 验证转换后的类型、坏 JSON 不入缓存、敏感输入不进错误、解码中失效/中断，以及 refetch 的失败快照与 fetch 的拒绝语义。

`test/stories.spec.ts` 的查询故事验证动态 enabled/key、共享需求、画框隔离、解码失败、旧值身份和 Solid 开发版诊断。页面的设置、工单、农机与启动流程使用同一 client；重连在 `infra/query.test.ts` 验证。`waitForReads` 接 AbortSignal，启动等待超时或根卸载都会释放活动订阅。

# Router

入口为 `infra/router.ts`。无样式路由运行时在本目录，应用路由表在 `app/App.tsx`；不引入 loader 或请求缓存。Query、Form、Table 的共同边界见 [infra](apps/web/src/infra/README.md)。

## 路由表与布局

```tsx
const detail = route("/demo/:id");

const routes: readonly RouteDefinition[] = [
  {
    layout: Layout,
    children: [
      { path: detail, component: Detail },
      { path: "/other", component: Other },
    ],
  },
];

function Layout() {
  return <section><Outlet /></section>;
}

function Detail() {
  const params = useParams(detail);
  return <p>{params().id}</p>;
}

<Router>
  <Routes routes={routes} fallback={NotFound} invalid={InvalidAddress} />
</Router>
```

`RouteDefinition` 是 layout 分组或页面叶子的判别联合。路由表在 Routes 创建时读取一次，期间不动态修改。使用普通数据定义，不把 JSX 当作路由配置对象、不给伪组件加类型断言，也不提前运行页面组件来搜集声明。社区的对象路由表与 Outlet 已足够表达嵌套布局。

所有路径从应用根开始。支持静态段、`:param` 非空单段参数、末尾 `*`，不支持正则或可选段。静态优先于参数，参数优先于 splat；同优先级且重叠的定义报错，不靠声明顺序覆盖。未匹配和非法百分号编码分别交给 fallback 与 invalid，运行错误不冒充地址不存在。

`route()` 同时提供匹配和类型化 build；没有额外 Codec 时，参数是 path 推导的字符串记录：

```ts
const farm = route("/farm/:repo");
farm.build({ repo: "my repo" }); // /farm/my%20repo
```

命名参数按段解码一次，构造时按段编码；空参数及 `.`、`..` 拒绝构造，不能经浏览器归一化跳到其他页面。`useParams(farm)` 的属性由 path 推导，不接受调用方任意填写的参数类型。

需要领域类型时，参数 codec 的输入侧对应路径字段，输出侧决定 build 输入与 `useParams` 输出：

```ts
const detail = route("/items/:id", {
  params: z.object({ id: z.codec(z.string(), z.number().positive(), { decode: Number, encode: String }) }),
});
detail.build({ id: 4 }); // /items/4
```

路径结构匹配后才解码参数。`resolve(pathname, search)` 区分 missing、invalid 和 matched；高优先级模式匹配但 Codec 拒绝时进入 invalid，不落到较宽的 splat。build 经同一 Codec 编码并检查路径段；非法领域值不能生成链接。Router 只用同步 codec（`z.safeDecode`、`z.safeEncode`），异步的当作不匹配，不在匹配中发请求。

splat 的 `rest` 保留编码后的剩余路径，由拥有子路径的 feature 解码；build 也接收已经编码的 remainder。这样 `/pkm/a%2Fb/100%25` 不会在 Router 和 feature 中解码两遍。非法编码仍在进入任何页面前拒绝。

尾斜杠不统一去掉：`/farm` 选上次仓库，`/farm/` 是无仓库农场。`/issues/*` 可以匹配 `/issues` 和 `/issues/`，两者 rest 都为空。

## 生命周期

匹配结果是一条稳定的定义链，Outlet 每层按 RouteDefinition 身份挂载：

- 共同 layout 在子路由变化时保留。
- 同页面的参数或 search 变化更新 accessor，不重建页面；页面内部可以选择收起列表、打开详情。
- 页面离开时释放其 owner。农场按 repo 用显式 Keyed 重建场景，不给所有页面参数变化隐式加 key。
- `useParams` 初次必须在相符的路径上调用。离开分支仍在结算的读取回到本实例的初始参数，避免 Solid 分支退出期间抛错；卸载时清理该实例。
- 路由 meta 是应用定义的只读字符串/布尔字段。Shell 通过 `useMatches()` 读取 place、skin，不再自己拆 URL 判断页面布局。

Router 只持有 History 和它的响应式快照。根卸载后释放 popstate、hashchange 与锚点订阅；故事使用 memoryHistory，不更改故事查看器的 URL。Root 不另外创建第二个路由上下文。

## 公共接口

| 接口 | 行为 |
|---|---|
| `Router` | 默认使用浏览器 History，或接受显式 history |
| `Routes`、`Outlet` | 匹配静态表、挂载和保留布局 |
| `route(path, { params?, search? })` | 校验模式、参数 Codec、match/resolve、类型化 build |
| `useRouter()` | path accessor、location accessor、navigate、history 的 back/forward |
| `useLocation()` | pathname、search、hash、站内 href 的 accessor |
| `useParams(route)` | 当前描述的类型化参数 accessor |
| `useMatches()` | 当前布局链与叶子的 meta |
| `useSearch()` | 每次读取新的 URLSearchParams 副本，修改副本不导航 |
| `useSearchParams()` | `[read, update]`；更新时读最新 History，保留未涉及的字段和 hash |
| `search(fields)`、`searchParam(codec)` | 定义 search 的 Schema 字段，单值参数使用恰好一个字符串的 Codec |
| `useSearchValues(definition)` | 解码 accessor 与函数式更新；从最新 History 读取和合并 |
| `Link`、`NavLink` | 站内链接、匹配时的 aria-current；不带样式 |
| `Navigate` | replace 重定向 |
| `memoryHistory(initial)` | 隔离的历史栈，用于故事和测试 |

原始 search update 支持字符串、多个同名值与 undefined（删除）。有领域约束的页面使用 Schema 定义：

```ts
const filters = search({
  page: searchParam(z.codec(z.string(), z.number().positive(), { decode: Number, encode: String })).optional(),
  tags: z.array(z.string()).optional(),
});
const list = route("/items", { search: filters });
const [values, update] = useSearchValues(filters);
update((current) => ({ ...current, page: 2 }), { replace: true });
```

URL 的每个字段先收集为字符串数组；`searchParam` 要求恰好一项，重复单值参数不是默默取第一个。数组字段保留一项或多项；undefined 和空数组编码为删除字段。未声明字段不参与业务解码，更新时保留；非法百分号编码拒绝。

`useSearchValues` 只在声明相同 search 定义的有效路由内读取；离开分支时短暂保留初始快照，invalid 页面仍由 Routes 决定。更新先解码最新 History，再经同一 Schema 编码，只改本定义的字段并保留 hash。同一事件中连续更新不读尚未 flush 的旧信号。工单的 repo/agent 筛选已用此入口，不再经过原子或无校验的单字段 helper。

Link 先调用调用方 onClick；已 preventDefault、非左键、修饰键、download、非 `_self` 的 target、外链不拦截。NavLink 默认匹配当前路径及子路径，`end` 限精确匹配；应用可显式指定 aria-current 表达别名页面。

navigate 只接受同源 HTTP(S) 地址；拒绝外链和可执行 scheme，外链继续走浏览器/宿主既有策略。同址 push 不增加条目，replace 替换当前条目。hash 变更同步 location；导航 settled 后定位存在的锚点。没有通用 scroll restoration 或参数变化时抢焦点。

## 与数据层的边界

页面自行读取 Query 和 SSE。Router 不缓存加载结果，不等待全页查询才显示布局，不把请求失败改成地址不存在。写操作仍由 intent / Act 执行。

## 验证

- `matching.test.ts`：参数与类型推导、编码、尾斜杠、静态优先级、歧义和模式拒绝。
- `schema.test.ts`：参数与 search 的输入输出类型、转换、双向编码、重复单值拒绝、非法值与未知字段保留。
- `history.test.ts`：前进后退、replace、连续 search 合并、监听清理、外链拒绝、实例隔离。
- `test/router.spec.ts`：真实服务端上的共同 Shell、工单页面实例与筛选保留、非法站内地址、农场键盘和布局。
- `stories/router.stories.tsx`、`test/stories.spec.ts`：真实组件的参数更新、布局保留、卸载、事件取消、原生下载、新标签页和两主题 axe。

直接请求非法编码地址可能在服务端静态路由处被拒绝；Router 的 invalid 页面测试走已加载应用的站内导航，不将它描述成服务端错误页。

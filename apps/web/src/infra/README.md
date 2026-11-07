# 页面基础设施

Query、Router、Form、Table 的无样式实现和接口约定放在本目录。四块都已有真实消费者，查询不依赖 TanStack；视觉组件在 `ui/`，业务定义与写操作仍归 feature。

| 模块 | 契约 | 负责 | 不负责 |
|---|---|---|---|
| Query | [query/README.md](apps/web/src/infra/query/README.md) | REST 读取、去重、缓存、失效、刷新 | SSE 核心状态、写操作、乐观意图 |
| Router | [router/README.md](apps/web/src/infra/router/README.md) | URL、匹配、历史、嵌套布局 | 请求缓存、业务权限、数据加载 |
| Form | [form/README.md](apps/web/src/infra/form/README.md) | Effect Schema 解码、字段状态、校验和提交生命周期 | 服务端业务判断、持久化草稿、自动生成界面 |
| Table | [table/README.md](apps/web/src/infra/table/README.md) | 行列模型、排序、分页和选择 | 请求、URL、虚拟滚动、业务动作 |

## 共同接口约定

- `createX` 创建可测试的实例，显式 `dispose()`；`useX` 在 Solid owner 中创建并清理实例，或读取 Provider。不在每次响应式重算中创建实例。
- 动态输入使用 accessor，响应式结果也使用 accessor，例如 `query.data()`、`form.dirty()`。不通过 Proxy 让普通属性暗中订阅。
- 非响应式命令使用普通方法，例如 `form.reset()`、`router.navigate()`。实例和命令的引用在其生命周期内稳定。
- 创建实例不读取全局路由、缓存或登录状态。实例经 Provider 注入；测试、故事、每个应用根各自持有实例，卸载时释放订阅、计时器和控制器。
- 输入快照不能被调用方原地修改；实现不依靠每次渲染全量深比较来补救。大列表通过稳定行 ID 和字段订阅限制更新范围。
- 数据契约使用 Effect Schema：Query 从结果 Schema 推导并解码外部响应；Router 用 Codec 读写参数与 search；Form 区分 Encoded 输入和 Type 输出；Table 从领域行 Schema 推导列，不重复解码已验证的行。内部生命周期与受控状态保留 TypeScript 判别联合。
- 失败是可读的状态，不自动变成空列表、成功或 toast。基础设施不负责对主人的文案，文案通过词典和上层组件提供。
- Promise 接现有浏览器/API 边界；Query、Form 的异步解码由对应实例的取消与代次管理，Router 使用同步 Codec。没有第二套后台 runtime、服务注册或插件系统。

## 目录与依赖

第一版四块的无样式实现都放在 `infra/{query,router,form,table}/`，通过 `infra/<模块>.ts` 暴露小接口。不提前拆成四个 workspace 包，不建立互相重导出的全局 barrel。

```text
infra/query/   缓存实例、查询定义、Solid 订阅
infra/router/  History 适配、匹配、Provider、无样式路由组件
infra/form/    Form 实例、Effect Schema 解码、字段绑定
infra/table/   行列模型、受控状态、Solid 订阅
```

`infra` 不向上 import `state`、`ui`、`features` 或农场。可复用的纯算法只在需要跨模块共享时移到 `base`，不为每个函数另造一层。

- Effect Atom 仍只在 `state/`；这次不放开 `atom-door`，也不把业务共享状态搬进 `infra`。
- Query client 是应用根拥有的请求缓存资源，不是新增的模块级 UI store。现有意图、偏好与 SSE 帧继续由原有模块持有。
- Router 中的 `Link`、`Outlet` 和 Form 字段模型不带视觉样式。导航外观、原生 form/field 组件、错误提示、输入框和 `DataTable` 在 `ui/`，农场可另接像素外观。
- 基础设施不知道业务 API。查询定义、表单 Schema、列定义和写操作适配放在拥有它们的 feature；确实跨 feature 的现有读取入口可以由 `infra` 提供，但不得倒着依赖 feature。
- 四块不互相拥有状态。Router 的搜索参数通过上层适配传给 Table；Query 的结果通过 accessor 传给 Table；Form 的提交回调由上层接现有动作入口。

## 不变量

| 数据 | 唯一所有者 |
|---|---|
| 服务端折好的核心状态 | SSE 帧 |
| REST 查询的最近结果 | 当前应用作用域的 Query client |
| URL 与历史记录 | Router |
| 当前表单尚未提交的输入 | Form 实例；跨卸载草稿由 feature 持有 |
| 写操作的授权、重试 key、等待帧确认 | 现有 intent / 动作层 |
| 表格排序、分页、选择 | Table 或调用方，创建时二选一 |

请求缓存不持久化到磁盘；表单、表格不默认写 localStorage；切服务端、授权身份或空间时释放旧作用域。没有所谓通用的「页面总 store」。

## 验证

类型与状态机在各目录的测试里验证；浏览器测试覆盖真实保存、迟到收据、URL 无效分支、查询解码失败、稳定行身份和旧页禁用。各模块文档列出消费者与测试入口。农场布局和启动屏属于 Router 的接入证据，不替代另外三块的验收。

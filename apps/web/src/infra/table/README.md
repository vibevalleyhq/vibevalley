# Table

Table 管行列、排序、分页、选择，不发请求、不读写 URL。纯模型在 `table/model.ts`，`infra/table.ts` 的 `useTable` 绑定 Solid owner，视觉在 `ui/DataTable.tsx`。公共边界见 [infra](apps/web/src/infra/README.md)。

## 列与显示

`defineColumns(schema)` 从领域行 Schema 推导类型，返回列构造器：`column(id, { value, compare?, hideable? })`。ID 保留字面量类型，value 的返回类型传给 compare。没有 compare 的列没有排序按钮，不默认按枚举字符串发明业务顺序。列默认可隐藏，主列可指定 `hideable: false`。

同一个 Table 的列必须使用同一个 Schema 对象。Schema 在这里提供行契约与类型来源；Query 已解码的行不在排序、选择或渲染时再解码。农机模型复用 protocol 的 `S.ModelEntry`，不另写平行 DTO。

核心列没有 JSX。`ui/DataTable` 的 `tableCell(column, header, render)` 把同一列的值类型传给渲染器；header、值和原行使用 accessor。cells 按列 ID 配齐，不能把数量列接到只接受字符串的渲染器。

真实消费者是 [RuntimeCards 的 ModelsCard](apps/web/src/features/runtime/RuntimeCards.tsx)：模型 ID 是行身份，名字与努力程度可排序，努力程度列可收起。原记录由 feature 提供；请求失败或运行工具不报告模型时，外层保留原有错误与未报告说明，不把失败交给 Table 变成空列表。

## 模型接口

| 接口 | 含义 |
|---|---|
| `table/model.ts` 的 `createTable(options)` / `infra/table.ts` 的 `useTable(options)` | 显式 dispose / Solid owner 管理 |
| `rows()` | 当前页 `{ id, original }` |
| `allColumns`、`columns()` | 全部定义 / 当前可见列 |
| `sorting()`、`setSort()` | `{ column, direction: "asc" / "desc" }` 或 undefined |
| `page()`、`setPage()` | 从 0 开始的 index、正整数 size |
| `total()`、`hasNext()`、`stale()` | 已知或未知总量、下一页、数据身份是否落后 |
| `selection()`、`toggleRow()`、`togglePage()` | 稳定 ID 的集合；全选只针对本页 |
| `pageSelection()` | 本页全选与半选 |
| `visibility()`、`setVisible(id, show)` | ReadonlyMap；缺失项默认显示 |
| `reconcile()`、`dispose()` | 根据新输入调整越界页和显式成员集合 / 释放订阅 |

`rowId` 必填，使用业务 ID，不使用数组下标。重复行 ID、重复列 ID、非法页码和非有限比较结果会报错。输入数组视为不可变；新数组或排序变化重算有序行，同一输入上的读取与选择不重复排序。

## 状态只有一个所有者

sort、page、selection、visibility 各自接收一个 `Owned<T>`，创建时二选一：

- `{ initial }`：Table 拥有后续状态。
- `{ value: accessor, onChange }`：调用方拥有状态，Table 只请求改变，不保存镜像。

类型禁止混用或缺少受控回调。排序不擅自改页码；需要排序后回第一页时，feature 在自己的状态转换中一起改变。Router 同步、筛选和跨页面偏好仍由调用方负责。

## Local 与 Remote

`mode: "local"` 接完整的、已由 feature 筛选的 rows。先稳定排序，再分页，相等项保留输入次序。页码越界时，非受控页夹到有效范围；受控页只请求修正，同一未被接受的修正不反复发送。`useTable` 在输入变化后自动 reconcile，独立实例由调用方在改变输入后调用。

`mode: "remote"` 接当前页，不再本地排序或切片。调用方还应提供：

- `scope()`：当前数据范围的身份。
- `loaded()`：随结果保存的 `{ page, sort, scope }`，没有结果则 undefined。
- `total()`：`{ kind: "known", rows }`，或 `{ kind: "unknown", hasNext }`。

请求页、排序或范围与 loaded 不符时，stale 为 true。旧行可显示，但模型拒绝选择，UI 显示旧结果提示并使 tbody inert。未知总量不推算总页数。取消、乱序、缓存归 Query；组合例子在 [DataTable 故事](apps/web/src/ui/DataTable.stories.tsx)，只用 `query.previous()` 显式提供旧页及原身份。

## 选择与边界

翻页、排序和过滤不清除已选 ID。可选 `allIds()` 是完整成员集合，用于删除确实不存在的 ID；不能把过滤后的 rows 当成完整集合。查询范围变化时，由调用方显式重置 selection。选择不等于授权，批量动作仍由 feature 向服务端提交并接受逐项拒绝。

`DataTable` 使用原生 table、caption、th scope、aria-sort 和全选/半选框。小屏横向滚动，单元格保留原有链接和按钮；不模拟 ARIA grid。样式使用工作台令牌，不进模型。

不提供过滤 DSL、所有搜索结果全选、跨页自动抓取、列拖拽/缩放/固定、分组、树表格、单元格编辑或虚拟滚动。模型测试覆盖千行输入且视图只画当前页；故事和浏览器测试覆盖两种主题、390px、axe、选择身份和远端旧页。

# Form

Form 用 Effect Schema 解码输入，管理编辑版本、校验和提交生命周期。纯实例 `createForm` 在 `form/form.ts`；`infra/form.ts` 导出 `useForm` 和收据类型；视觉绑定在 `ui/Form.tsx`。公共边界见 [infra](apps/web/src/infra/README.md)。

## Schema 与输入

`FormOptions<T, E, R>` 接收 `Schema.Codec<T, E>`：输入与默认值是编码侧 E，`onSubmit` 只收到解码后的 T。解码和编码依赖均为 never，不隐式提供服务或模型 runtime。支持异步解码，不接受任意 class、Map 或控件对象作为输入。

输入是 JSON 值、可选字段、记录和数组。JSON null 与不存在的可选键有不同含义；显式 undefined 是否合法由 Schema 决定。删除 optionalKey 时替换其父记录并省略该键，不把 undefined 当作通用删除指令。

字段路径是只读元组，由 E 推导值类型，最多八段。`__proto__`、`constructor`、`prototype` 和负数下标会拒绝；不读取继承属性。缺失的父记录或数组应先整体设置。数组只支持已有元素和整体替换，不提供动态 field-array 控制器。

[技能输入](apps/web/src/features/runtime/skill-form.ts) 用 trim 和 Schema filter 校验名字，正文只校验、不裁剪。数字文本可用非空字符串检查再接 `FiniteFromString`；单独的数字转换允许空串变成 0，不能代替非空检查。解码出的 trim、默认值和转换不反写正在编辑的输入。领域值转回输入由 feature 显式 encode 或映射。

## 实例与字段

| 接口 | 含义 |
|---|---|
| `createForm(options)` / `useForm(options)` | 显式 dispose 的实例 / 绑定 Solid owner 的实例 |
| `values()`、`revision()`、`snapshot()` | 冻结的输入、递增编辑版本和完整快照 |
| `dirty()` | 输入与显式 baseline 的结构比较，区分缺失键、undefined 和 null |
| `validating()`、`submitting()` | 校验任务 / 整次提交尝试是否在进行 |
| `issues()`、`messages()`、`submitError()` | 安全的 Schema 错误、提交后的摘要、单独的提交错误 |
| `field(path)` | 稳定 ID、value/setValue、touched、dirty、issues/messages、blur |
| `setValue(path, value)` | 替换输入并推进 revision；不原地改 values |
| `validate()` | 完整解码，返回 valid/invalid/outdated/unavailable/disposed |
| `submit()` | 校验成功后调用 onSubmit；忙时返回 busy，组合输入期间返回 composing |
| `reset(input, { ifRevision })` | 显式替换输入与 baseline；可省略整个条件，条件不符返回 false |
| `composition(active)`、`dispose()` | 控制组合输入；中断校验并释放订阅 |

字段收起不删除输入；跨页面草稿归 feature，不写 localStorage。数组替换推进 revision，旧校验不能再把错误贴到新元素上。

## 校验和错误

完整解码使用 `Schema.decodeUnknownEffect(schema, { errors: "all" })`。每次校验捕获 revision 与代次；编辑、重验、reset、dispose 中断旧任务并丢弃晚到结果。校验中编辑的提交返回 outdated，不自动提交新快照。

失焦触发完整校验，只显示 touched 字段的错误；提交后显示摘要，后续编辑合并为一次微任务重验。跨字段约束不拆开跑。缺陷与 Schema 失败分开：前者显示校验不可用，不伪造字段错误。

`SchemaIssue` 映射为 `{ path, code, params, branches? }`，不保留原始 actual 值或解析异常文案。Union 保留 Schema 返回的候选分支；类型预筛选排除的分支不会补造。messages 回调负责词典文案，默认 UI 给安全兜底；不从 Schema 生成 label、布局或整个表单。

## 提交收据

`onSubmit(value, { revision, attemptId })` 返回：

- `accepted` 与 receipt：动作层确认接收，不表示业务已经完成。
- `rejected` 与 message，可附结构化 issues：明确未接受。
- `unknown` 与 message：可能送达、没有确认。未捕获异常也归 unknown，错误原文不进 Form。

Form 不导入 API、intent、Act 或 toast，不自动重试、reset、清草稿，也不取消已发送写操作。校验和等待收据期间只允许一个 submit，但仍可继续编辑。

`createAct().attempt()` 保留断线检查、busy 和错误提示，并返回上述收据。断线、明确的客户端拒绝属于 rejected；网络中断和服务端故障属于 unknown。`run()` 仍为原有调用方返回值或 undefined，不能用它推断 void 写操作成功。

feature 收到确认后调用 `reset(savedInput, { ifRevision: attempt.revision })`。有 SSE 确认要求的动作应等对应帧。技能创建另保留服务端给的 ID；列表刷新期间又有编辑时，不跳走、不创建第二条。密钥表单只有同版本成功收据才清空输入，未知送达时保留输入并提示先核对结果。

## UI 与测试

`ui/Form` 绑定原生 submit 和 composition；`FormField`、`formControl` 关联 label、aria-invalid 与错误描述。无效提交聚焦第一个已挂载错误字段，否则聚焦摘要；卸载后不再调度聚焦。样式和词典属于 UI，像素皮可另接外观。

普通消费者是 [SkillsPage](apps/web/src/features/runtime/SkillsPage.tsx)，敏感消费者是 [DeepseekForm](apps/web/src/features/setting/DeepseekForm.tsx)。其余表单不因此自动迁移。实例的类型、异步、收据和错误测试在 `form.test.ts`；浏览器的主题、窄屏、axe、迟到确认和真实保存测试在 `test/stories.spec.ts`、`test/primitives.spec.ts`、`test/settings.spec.ts`。

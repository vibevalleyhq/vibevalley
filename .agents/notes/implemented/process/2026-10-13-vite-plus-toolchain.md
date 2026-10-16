# Agent Note: 格式、lint、测试和页面构建都交给 Vite+

Status: implemented

> 已被取代：TypeScript 退出以后（[形状的源头是 Go](../architecture/2026-10-15-go-owns-the-shapes.md)），Vite+、`vite.config.ts` 和它的提交钩子都删了；Go 用 `gofmt`，Dart 用 `dart format`。下面是当时的决策。

## Problem

每个包自己跑 `oxlint src`，只有默认规则，没有类型信息，测试目录不查；三个包的边界（core 不引 React、ai 和 agent-core 不引 `node:*`）各写一份 `.oxlintrc.json`。格式全靠人照着周围写，规矩写在 AGENTS.md 里，机器不管，改动里常夹着顺手的换行。测试用 `node:test` 加 tsx，一个包一个进程，`pnpm -r test` 一个个跑；`web/test` 没有 test 脚本，从来没跑过。

## Decision

根目录装 `vite-plus`（版本在 `pnpm-workspace.yaml` 的 catalog 里定死），配置只有根目录一份 `vite.config.ts`；用法见 [development.md](../../../../docs/development.md)「检查和测试」。

- **格式**：oxfmt，单引号、不写分号、一行 160 字。Markdown 不格式化（中文段落的换行是人定的），`sprites.json` 是生成的，也不管。接入时整个仓库格式化一次，单独一个提交。
- **lint**：oxlint，开 `typescript`、`unicorn`、`oxc`、`import` 插件，页面加 `react`；`correctness` 是错误，`suspicious` 是警告；`typeAware` 打开（`no-floating-promises` 之类要类型的规则）。和 Effect 的写法冲突的规则关掉（`_tag`、生成器里只在部分分支 return），关掉的每条在配置旁边写了为什么。包的边界写成 `lint.overrides`：Vite+ 不读嵌套的 lint 配置。
- **测试**：vitest，从 `vite-plus/test` 引 `test`，断言照旧用 `node:assert/strict`。根配置把每个包的 `test/` 列成一个 project，`pnpm test` 一次跑完；超时 30 秒，服务端的测试要开真的 git 仓库。
- **类型检查不交出去**：仍是每个包的 `tsc`（`pnpm typecheck`），`pnpm check` 把 `vp check` 和它连在一起。`packages/engine` 的 core 部分要用另一份 tsconfig 查一遍（不带 DOM），test 目录有自己的 tsconfig；`lint.options.typeCheck` 只按就近的 tsconfig 查，替不了。
- **提交钩子**：`.vite-hooks/pre-commit` 跑 `vp staged`，对暂存的文件做 `vp check --fix`；`pnpm install` 的 `prepare` 装上它。
- **页面**：`web` 的 `vite` 指向 Vite+ 的核心（根 `package.json` 的 `pnpm.overrides`），`vp build` 构建。服务端和桌面客户端照旧用 esbuild 打包，它们不是 Vite 应用。

## Alternatives considered

**只加强 oxlint，不引 Vite+。** 根目录放一份 `.oxlintrc.json` 也能统一规则、开类型信息。但格式和测试还是两套东西，各自配、各自升；Vite+ 一个依赖带来版本对齐好的 oxlint、oxfmt、vitest 和页面的构建，配置在一个文件。

**不格式化，只 lint。** 不产生大的 diff，但格式继续靠人和评审；agent 写的代码换行风格不一，每次都要人看。一次性的大 diff 用单独的提交隔开，`git blame` 可以用 `--ignore-rev` 跳过。

**printWidth 120 或 200。** 120 改动最多（290 个文件），代码里本来就有大量 120 到 200 字的行；200 改动最少，但长到要横着滚。160 在中间。

**断言也换成 `expect`。** 一千多处断言要改，换来的只是写法；`node:assert/strict` 在 vitest 里照样用。新写的测试也照旧用它，一个仓库一种断言。

**`@effect/vitest` 的 `it.effect`。** 测试里大量 `Effect.runPromise` 可以省掉，但要逐个改写测试；以后改到哪个测试再换。

**类型检查交给 `vp check`。** 少一步，但查不了 engine 的两份 tsconfig 和测试目录各自的 tsconfig，见上。

## Consequences

- `pnpm check`、`pnpm fmt`、`pnpm test` 是改完代码的三步；单个测试用 `vp test <文件> -t <名字>`，不再是 `node --test`。
- `web/test` 第一次被跑到。
- React Compiler 的几条规则（`purity`、`set-state-in-effect`、`refs`）是警告不是错误：都是真问题，但改了会变行为，改到那个组件时再修。
- 打开规则时修掉的真问题：按数字排的星期没给比较函数、`String()` 一个 `Request`、合并失败的错误没带上原因。
- 每次升级 Vite+ 都是一次连带升级 oxlint、oxfmt、vitest 的改动：改 catalog 和 override 两处版本号。

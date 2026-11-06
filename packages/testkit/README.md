# packages/testkit

`@vibevalley/testkit`：测试共用的，只放在 devDependencies 里。

- `golden.ts`：黄金数据（`testdata/*.jsonl.gz`）按文件读、逐条比（`checkCases`、`jsonDiff`），`VIBEVALLEY_GOLDEN=update` 时把规则现在的答案写回（`vp run golden:update`）。服务端按模块找文件的那一层在 `apps/server/src/testing/golden.ts`。
- `until.ts`：在真实时间上等一个条件（`waitFor`、`until`、`whenTrue`、`within`、`gate`、`nextTurn`），不靠睡一段时间。等核心状态的 `whenState` 在服务端的 `testing/layers.ts`。
- `source.ts`：源码的导入边、导出、调用与状态读取分析；同一文件要查多项时用 `analyzeSource(path, source)`，一次解析和遍历得到可复用的分析对象，不全局缓存路径。
- `pyramid.ts`、`budgets.ts`：测试金字塔（[地基](docs/subsystems/foundation.md)）。一个测试文件的层看它的 import 一路碰不碰得到库、子进程、网络，跟着 `@vibevalley/*` 的 import 进包里；`budgets` 是 vitest 的报告，服务端和 `packages/ai`、`packages/agent` 都用。

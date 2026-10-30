# Agent Note: 检查照「更对的写法」开，不照现在的写法

Status: proposed

## Problem

lint、编译器和格式化的配置一直是「现在的代码能过」的样子：一条规则报得多，或者和现在的习惯冲突，就不开。这样配置只是把现状记下来，拦不住现状里本来就错的那一类：

- 条件里的真假值：`[]`、`{}` 永远是真，`0` 和 `""` 是假；#194 渲染出空附件框的 bug 就是把 `[]` 当成「有附件」。
- 转型：健康的棘轮只数总数，一处新的 `as` 在别处少一处时就混进来了。
- `x || d` 把数字 0 和布尔 false 当成没有。
- 正则不带 `u` 时按 UTF-16 码元匹配：这里到处是中文和 emoji，一个 emoji 会被拆成两半。
- `sort()` 和 `reverse()` 改原数组：帧和核心状态是共享的，就地排序会改到别人手里的那份。
- 循环里一个个 `await`：有的是有意按顺序，有的只是没想过并行，读的人分不出来。
- 警告只在 CI（`vp check --deny-warnings`）失败，提交钩子不拦。
- import 没有顺序，几处 `import { t }` 插在文件开头注释上面。

## Proposal

一个 PR，每一步一个提交。判断一条规则只问它拦的东西是不是错的；报得多只决定怎么改，不决定开不开。改法优先让代码自己对（换写法、换类型），确实要例外的就地用 `oxlint-disable-next-line <规则> -- <理由>` 写明为什么，`reportUnusedDisableDirectives` 已经会报失效的。

1. **地基**
   - 提交钩子 `vp check --fix --deny-warnings`，和 CI 一样。
   - lint：`import/no-duplicates`、`typescript/no-unnecessary-type-arguments`、`typescript/no-unnecessary-type-conversion`、`typescript/no-unnecessary-type-parameters`、`oxc/no-accumulating-spread`、`unicorn/prefer-set-has`、`unicorn/prefer-array-find`。
   - tsconfig：`noUncheckedSideEffectImports`、`allowUnusedLabels: false`、`allowUnreachableCode: false`、`erasableSyntaxOnly`（构造函数的参数属性改成字段）。
2. **真假值和空值**：`typescript/strict-boolean-expressions`，允许字符串（`""` 是约定的「没有」，[没有值](docs/style/code.md#没有值)），不允许数字、可空的值和对象；`typescript/prefer-nullish-coalescing`，`ignorePrimitives: { string: true }`。
3. **转型**：`typescript/no-unsafe-type-assertion`。能换成检查过的读法（Schema、类型守卫、`satisfies`）的换掉，剩下库的类型缺口就地写理由。
4. **正则和数组**：`eslint/require-unicode-regexp`（加 `u` 会让少数转义的意思变，逐条核，不整批替换）、`unicorn/no-array-sort`、`unicorn/no-array-reverse`（`toSorted`、`toReversed`）。
5. **循环里的 await**：`eslint/no-await-in-loop`。能并行的改成并行，有意按顺序的写明为什么。
6. **格式化**：开头注释挪到 import 上面，`scripts/i18n.ts` 加 import 的地方跟着改；oxfmt 开 `sortImports`（五组：Node、包、`@vibevalley/*`、本 app 的 `@/`、同目录）和 `sortTailwindcss`（`apps/web/src/style.css`、`cx`）。这一步的提交号进 `.git-blame-ignore-revs`。

做完把仍然成立的写进 [流程](docs/subsystems/process.md)「为什么这样」和 [代码风格](docs/style/code.md)，这篇改成 `implemented/` 或删掉。

## Alternatives considered

**整类开 `suspicious`、`perf`、`pedantic`**：分别报 1690、129、11048 处，里面有不少规则在正确的代码上报（下面几条）。按条挑，每条说得出它拦的错。

**`typescript/prefer-readonly-parameter-types`（5588 处）**：库的类型多半不是只读的，它在正确的代码上大量报，不开。

**`noPropertyAccessFromIndexSignature`**：`noUncheckedIndexedAccess` 已经让读出来的值带上 `undefined`，它只多要一种写法，不多拦一个错，不开。

**`unicorn/require-post-message-target-origin`**：报的都是 Worker、MessagePort 和 React Native 的桥，它们的 `postMessage` 没有目标来源这个参数，全是误报，不开。

**`strict-boolean-expressions` 连字符串也不许**：我们约定必有的字段用 `""` 表示没有，`if (problem)` 的意思就是「有问题」；不许它就要处处写 `!== ""`，和约定说的是同一件事，不更对。

**只靠健康棘轮管转型**：棘轮只看总数，不看每一处有没有理由；规则让每一处转型都当场说明。棘轮的 `cast` 读数留着，作为全仓库的读数。

## Acceptance criteria

- `vp check --deny-warnings`、`server:check`、`web:check`、`scripts:test`、`docs:verify`、`health:verify`、页面 e2e、桌面测试、手机壳测试都过。
- 上面每条规则和开关在配置里开着，每处例外有就地的理由。
- 提交钩子在只有警告时失败。
- 格式化那一步的提交在 `.git-blame-ignore-revs` 里。

## Risks

- 改动很大：每一步一个提交，各自能单独看；第 6 步只挪行，进 blame 忽略。
- `u` 标志改变 `\-`、`\w` 一类转义和字符类的意思：逐条核，有测试的跑测试。
- 改成并行的 `await` 可能改了副作用的先后：只在步骤之间互不依赖时并行，有疑问的保持顺序并写明。
- `toSorted` 要 ES2023：服务端 Node 24、页面和桌面的 Electron 都有；手机壳的 WebView 要确认版本。

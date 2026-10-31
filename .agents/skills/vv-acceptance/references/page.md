# 验收页面

[验收](.agents/skills/vv-acceptance/SKILL.md)的一份分册：对着沙箱里的服务端，把要看的页面截成 PNG，拿眼睛看。`apps/web` 的 Playwright 测试点的是真的页面，但只断言接线和状态、不留给人看的图。不开 vite dev，截图由 `apps/web/scripts/screens.ts` 用 Playwright 画。

## 什么时候用

- 改了 `apps/web/src/features`、`apps/web/src/farm`、`apps/web/src/tree`、`apps/web/src/ui`、`apps/web/src/app` 的画面。
- 改了 `apps/web/public` 的贴图、字体、指针。
- 改了形状，想看服务端的新字段在页面上画出来。

不用它：只改了 `apps/web/src/base` 或 feature 里的请求、测试已经覆盖的；只改了测试。

## 准备

1. `vp run web:check`（类型、构建出 `apps/web/dist`，沙箱提供的就是它）。

## 步骤

1. 在仓库根目录造一张工单，截工单页：

   ```bash
   vpx scripts/verify-server.ts -- sh -c '
     "$VIBEVALLEY_VERIFY_CLI" issue create --json "{\"title\":\"截图验收\"}" &&
     VIBEVALLEY_PAGES=/issues vpx apps/web/scripts/screens.ts
   '
   ```

   `command.stdout.log` 列出截好的图，在 `apps/web/.screens/<页面>-<宽>x<高>.png`；页面里有脚本错误时命令失败，错误在 `command.stderr.log`。改别的页面时，在同一个子命令里造它要的数据，再换 `VIBEVALLEY_PAGES`；新农场没有上一轮的数据。

2. 按需要设：
   - `VIBEVALLEY_PAGES=/,/issues,/chat`：要截的路径，逗号分开；`/` 是农场（首页已经标成看过）。不设时是农场和工作台的每个地方。
   - `VIBEVALLEY_SCREEN=390x844`：手机大小；默认 1440×900。
   - 带 id 的详情页（`/issues/<id>`、`/agents/<id>`）用子命令里刚造出来的 id。
3. 打开截图，对照改动检查内容、用语、溢出和重叠。空状态只能证明空状态，不能代替列表、卡片和详情的验收。
4. 要点开、拖动、输入以后的样子，在 `apps/web/test` 里写一个 Playwright 测试（它对着同样隔离的服务端），用 `page.screenshot` 留图。
5. 改了代码，重新 `vp run --filter @vibevalley/web build`，再跑同一条命令。

## 证据

- `command.stdout.log` 里的截图路径。
- 和改动有关的截图，以及截图里对应的变化。
- 改了布局时，附一张 390×844 的截图。

## 出错时

- **页面是空的**：确认 `apps/web/dist` 是这次构建的；看 `command.stderr.log` 里的页面错误和 `server.stdout.log`。
- **农场的画布是空的**：截图前要等图加载完，`screens.ts` 在 `/` 上等画布出现再等 3 秒；还空就看页面错误。

## 收拾

`apps/web/.screens/` 不进 git，不必删。

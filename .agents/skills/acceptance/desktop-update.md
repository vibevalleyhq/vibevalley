# 验收桌面版的自己更新

[验收](.agents/skills/acceptance/SKILL.md)的一份分册：在真的打包上走一遍更新。`desktop:test` 跑的是仓库里的应用，它不更新自己（可执行文件是 Electron 自己的）；只有打包的 `.app` 会查、下、换。`apps/desktop/scripts/update-check.ts` 打出 0.0.1 和 0.0.2 两个包，把 0.0.1 放进一个临时的「应用程序」，在本机放一份 0.0.2 的发布当更新源，再跑这个装好的应用。

## 什么时候用

- 改了 `apps/desktop/src/update.ts`、`releases.ts`，或 `main.ts` 里退出和更新的先后。
- 改了 `apps/desktop/scripts/package.ts`（打包、`release.json`、服务端的依赖）。
- 改了 `.github/workflows/release.yml` 之前，确认它跑的打包在本机是好的。

不用它：只改了「关于」里更新那一行的样子（`desktop:test` 看得到）；只改了 `releases.ts` 里测试已经覆盖的规则。

## 准备

1. macOS，装好 Xcode 的命令行工具（岛要 `swift build`）。
2. `vp run web:check` 过了。打包自己会构建页面和壳。

## 步骤

1. 在仓库根目录跑：

   ```bash
   vp run --filter @vibevalley/desktop update-check
   ```

   要十分钟上下：打两个包，每个都构建页面、岛，用 `pnpm deploy` 装服务端的依赖。
2. 它依次做三件事，每次都用临时的家目录和 Electron 的 user-data，不碰 `~/.vibevalley`，主人的应用开着也没事：
   - 更新源的 SHA-512 是错的：「关于」的更新那一行是 `failed`，装好的应用还是 0.0.1。
   - 真的更新源：下好（`ready`）；退出以后，换上来的是 0.0.2。
   - 再打开：版本是 0.0.2，「已是最新」（`idle`）。
3. 最后打印一个 JSON 和 `passed` 或 `FAILED`，退出码跟着。

## 证据

- 最后的 JSON：`wrongHash.state` 是 `failed`、`afterWrongHash` 是 `0.0.1`；`update.state` 是 `ready`、`afterUpdate` 是 `0.0.2`；`reopened` 的 `version` 是 `0.0.2`、`state` 是 `idle`。
- `update-check: passed` 那一行。

## 出错时

- **服务端起不来**（`waitForURL` 超时，窗口停在加载条上，地址里有 `problem=`）：读 JSON 里 `work` 目录下 `run-*/home/logs/desktop-server.log`。依赖对不上多半是打包的服务端没有照锁文件装。
- **`update` 不是 `ready`**：`text` 是「关于」那一行的原话；`manual` 是应用放的地方不能写（看 `work` 目录的权限），`failed` 后面是原因。
- **`afterUpdate` 还是 0.0.1**：换的脚本是 Electron 的 user-data 里 updates 下的 swap.sh；旧的应用留在同一处的 previous.app。

## 收拾

- 打的包在 `apps/desktop/dist`（`.gitignore` 里），下次打包会覆盖。
- JSON 里的 `work` 目录（系统的临时目录下）可以删掉。

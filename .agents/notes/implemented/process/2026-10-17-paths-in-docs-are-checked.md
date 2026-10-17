# Agent Note: 文档里写的路径也查

Status: implemented

## Problem

`bun run docs:verify` 只查 Markdown 链接。文档里大量路径写在反引号里（`server/internal/core/core.go`、`farm/plot_detail.dart`），挪文件、改名时没人提醒：一轮检查下来，当前文档里写着 `core/site.go`、`farm/harvest.dart` 这样早就不在的文件，还有 `FactTurn`、`CoreState.Foreman`、`lan_devices` 这类旧名字。

## Decision

- `scripts/doc-links.ts` 也查当前文档（`docs/`、各 README、`AGENTS.md`，不含 `.agents/`）里反引号中的源文件路径：带一层以上目录、扩展名是源码或数据（`go`、`dart`、`ts`、`tsx`、`astro`、`sql`、`json`、`yaml`、`sh`、`py`、`gz`）的，要能在仓库里找到。可以从仓库根写，也可以从包里写（`internal/core/core.go`），也可以相对文档所在目录。
- 家目录里的文件（`manager/manager.jsonl`、`config.json`）没有目录或扩展名不在表里，不查。
- Note 是历史，写的是当时的文件，不查。
- 名字（类型、函数）不查：误报太多；改名时顺手 grep 文档。

## Alternatives considered

**连名字一起查。** 试过：反引号里的驼峰词在代码里找不到就报。会报出不少例子和别处的叫法（`QUOTA_LOW`、`XMembers`），要维护一张白名单，没选。

## Consequences

- 挪文件、改名的改动里，文档里的旧路径会让 `docs:verify` 失败。
- 新建还没 `git add` 的文件也算在仓库里（`git ls-files --others`）。

## Verification

- 在文档里写一个不存在的路径，`bun scripts/doc-links.ts` 报出文件和行号；改回去通过。

# Agent Note: 档案的模板：一份 agent 的配方，主人挑着装

Status: proposed

## Problem

档案（`Agent`）的起点写死在代码里：

- **第一次开机整批灌进去**：九个帮工写在 `apps/server/src/agent/seeds.json` 的 `agents`，没有 `config.json` 时全装上；这台机器上没装的农机也照样装，一上来就是几份派不出去的档案。
- **删了回不来，改了拿不到**：种子只用一次；后来种子改好了，老农场拿不到，删掉的也没处再装。
- **默认管家是一段代码**：`orchestratorProfile()` 在 `agent.ts` 里拼出来，名字和职责在词表里。
- **内容跟着发版**：人设、职责、适合的活是写给模型和主人读的内容，现在和服务端的代码一起改、一起审。

## Proposal

**模板是一份 agent 的配方，档案是装好的那一份。** 管家和帮工都是 agent，都能从模板装；角色只是模板里的一个字段。

### 1. 一个模板一个文件夹：JSON 加 Markdown

```
apps/server/src/agent/templates/<id>/   内置的目录，随包发
  agent.json                            配置
  agent.en.json                         可选：英文，只覆盖给人看的字（name、duty、tags）
  persona.md                            可选：人设
  persona.en.md                         可选：英文的人设
$VIBEVALLEY_HOME/agent-templates/<id>/  主人从本地文件夹加进来的，原样拷一份，结构同上
```

`agent.json` 的字段是档案里能分享的那部分：`id`、`version`（整数，改了就加一）、`role`、`name`、`duty`、`tags`、`runtime`（推荐的农机）、`model`、`effort`、`personaMode`、`worktree`、`look`。管家的模板不写 `runtime`（固定是 `vibevalley`），写了别的不收；角色的规则和档案共用一处（`roleProblem`）。不放的：环境变量的值（可能是钥匙）、`workdir`（跟着机器）、`enabled`、MCP 服务器（在本机跑命令）、技能。英文缺的取中文，所以只给一种语言的模板也能用。

读法是一个函数：读文件夹、按 Schema 校验 `agent.json`，读成 `AgentTemplate`（带着从哪来：内置的还是加进来的）；读不通的不进目录，说清是哪个文件哪一栏。

### 2. 装

- **装一份**（`agent.template.install { id }`）：照模板建一份档案，id 是模板的 id，占了就 `<id>-2`、`<id>-3`；档案记着来源 `from: { template, version }`。同一个模板能装好几份。装之前页面给主人看整份配方（人设在内）。
- **更新**（`agent.template.update { agent }`）：模板的版本比档案记的新时，页面提示「有更新」；点了才用模板的新版盖掉档案里从模板来的那些栏，环境变量、默认项目、启用不动。不自动更新。
- **加一个模板**（`agent.template.add { path }`）：本机的一个文件夹，读得通就拷进 `agent-templates/`，进目录，不装；只在本机（`can` 没有 `remote`）。**删**（`agent.template.delete { id }`）只删加进来的，内置的删不了；装好的档案不受影响。
- **目录**（`agent.template.list`）：内置的和加进来的，每个带着已经装了几份。

### 3. 第一次开机和默认管家

- **默认管家来自内置的 `orchestrator` 模板**：开机时没有默认管家就从这份模板装上；`orchestratorProfile()` 去掉。默认管家删不了、改不成帮工，规则不变。
- **第一次开机只装默认管家**，帮工由主人在档案页从目录里挑；目录里推荐农机这台机器上能跑的。配置里的 `agent.starters`（`VIBEVALLEY_AGENT_STARTERS`，逗号隔开）列出第一次开机顺带装的内置模板：测试、沙箱和想要一套固定起点的人用它，默认空。
- `seeds.json` 不再有 `agents`；九个帮工挪成九个模板文件夹。

### 4. 页面

- 档案页的帮工那组末尾多一张「从模板装」，打开模板目录（`/agents/templates`）：每个模板一张卡，名字、角色、职责、推荐的农机（这台机器上有没有），点开看整份人设，「装上」以后打开装好的档案；上面能填一个本机文件夹「加进来」。一份帮工都还没有时，帮工那组直接引到这里。
- 档案页（帮工的和管家的）写着来自哪个模板；有更新时多一个「照模板更新」，先说会盖掉哪些栏。

## Alternatives considered

- **只把种子挪成文件，开机照旧全装**：内容不跟代码了，但主人还是没得选，删了的照样回不来。
- **frontmatter 的 `AGENT.md`**（照 Agent Skills）：一个文件、好分享；可配置和人设混在一处，配置的字段也要另写一套 YAML 的校验。主人定了 JSON 加 Markdown。
- **模板随包带技能**：现在的九个都不带技能；技能有自己的库，带进来要定重名、更新和删的规矩，先不做。
- **从 git 地址装**：要处理网络、版本和来源可不可信；先做本地文件夹，git 是下一步。
- **装好的档案跟着模板自动更新**：主人改过的人设会被悄悄盖掉；只提示、点了才盖。
- **管家和帮工两套模板**：角色本来就是档案的一个字段，两套格式只会各长各的；照角色校验就够了。

## Acceptance criteria

- 新农场第一次开机只有默认管家；档案页能从目录装一个帮工，装好的能派活。
- 同一个模板装两次得到两份档案；模板改了版本，档案页提示更新，点了才变。
- 本机一个模板文件夹能加进目录、装上、删掉；读不通的说清哪一栏。
- 一个管家模板装上就是一个新的管家，有它的私聊。
- `seeds.json` 里没有 `agents`，代码里没有拼档案内容的函数。

## Risks

- 测试和沙箱都靠种子的帮工（`lab`、`docs`、`night`……）：它们用 `agent.starters` 装上，和真的装是同一条路。
- 打包的应用要带上 `templates/` 文件夹：服务端从源码跑，文件夹在 `apps/server/src` 下，跟着走。

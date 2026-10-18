# Agent Note: 种子数据由服务端给，客户端不带副本

Status: proposed

## Problem

`shapegen` 把 `server/internal/protocol/seeds.json` 里客户端要的五样（`achievements`、`actionText`、`runtimePresets`、`runtimeFacts`、`fallbackPreset`）压成一行约 35KB 的 JSON 字符串，写进生成的 `app/lib/gen/vibevalley.dart`（`_seeds`），客户端开机解开、当顶层常量用。

- **连进来的设备会对不上。** 手机上的 App 和那台电脑上的服务端版本不一定一样，客户端带的是自己那一版的种子：农机的名字、能力、成就的门槛和服务端算的不一致（[连接到本机](docs/subsystems/gate.md)）。
- **违反「客户端问服务端」。** 成就的进度在 `rules/progress.dart` 里照 `achievements` 现算；农机能不能做什么照 `runtimeFacts` 判，和服务端各一份规则的输入（[客户端](docs/subsystems/app.md)）。
- **生成的文件难看难审。** 一行 35KB 的字符串，改一个成就整行都变。

## Proposal

**每样种子挂在服务端已经给客户端的那份东西上，客户端不再带副本，`_seeds` 和它解出的五个顶层常量删掉。**

| 种子 | 挂到哪 | 客户端怎么读 |
|---|---|---|
| `runtimePresets`、`fallbackPreset` | `runtime.list` 的每个 `RuntimeInfo` 带 `preset`（名字、介绍、长相）；没探测到的农机也在列表里 | 农具页、捏帮工的农机列表读目录；`presetOf` 从目录找 |
| `runtimeFacts` | `RuntimeInfo.facts`（已有 `refused`，并成一份） | `factsOf(info)` 只读 `info` |
| `achievements` | 帧的 `view` 带每个成就的定义和进度（服务端的账本本来就在算） | 成就页只显示；`rules/progress.dart` 删掉 |
| `actionText` | 帮工在做什么、干活过程的每一步，服务端在帧和事件里带好说法（照 `phaseText`、`whenText` 的做法，`FrameOf` 写） | `issue_view.dart`、`work_log.dart` 读字段 |

- 改形状照常跑 `shapegen`；`shapegen` 不再读 `seeds.json`，生成器里写 `_seeds` 的那段删掉。
- 客户端要等这些数据的地方都已经在等服务端（目录、帧），不新开开机前的等待。
- 不留兼容：旧客户端连新服务端读不到这几个顶层常量的事不存在，常量随这一版一起删。

## Alternatives considered

**`shapegen` 改成写一个 `app/assets/seeds.json`，客户端从资源读。** diff 好看了；但资源要异步读，二十来处要改成等它，客户端照样带副本，连进来的设备照样对不上。

**加一个 `GET /api/v1/seeds` 整份给客户端。** 一处改完；但种子成了一样单独的东西，客户端拿到以后还要自己拼（成就的进度、农机的名字），规则又回到 Dart 里。挂在各自的东西上，客户端拿到的就是要显示的。

## Acceptance criteria

- `app/lib/gen/vibevalley.dart` 里没有 `_seeds`；`grep -rn "achievements\|actionText\|runtimePresets\|runtimeFacts\|fallbackPreset" app/lib` 只剩读服务端字段的地方。
- 成就页、农具页、捏帮工的农机列表、地块详情的「正在…」、干活过程的每一步，显示和现在一样；`flutter test` 用 `MockClient` 喂服务端的形状覆盖这几页。
- 服务端的测试覆盖 `runtime.list` 带 `preset` 和 `facts`、帧带成就进度和说法。

## Risks

- 帧变大：成就定义每帧都带会浪费，放在只在变了才发的部分，或者只发进度、定义随 `runtime.list` 这类一次性的接口给。
- 改动跨服务端、协议和客户端二十来处，分两步落：先农机（`runtime.list`），再成就和说法。

# Agent Note: 客户端分层：两张皮在上，共用的在下

Status: implemented

## Problem

客户端有两张皮：工作台（`desk/`，配置页、看板、田头页）和农场（`farm/` 的面板、`village/` 的像素村）。两张皮画的是同一份数据，可共用的东西放在了其中一张里，于是互相 import：农场的聊天窗用 `desk/chat` 的状态、规则和控件，农场的面板用 `desk/shared` 的脸和干活记录；工作台的看板和地图用 `farm/bits` 的 `AgentFace`、`Ticking`，用 `farm/harvest` 的收获单，田头的头像用像素村 `village/world` 的 `lookOf`；外壳用 `desk/runtimes/layout` 的 `TextLink`；控件库 `ui/kit` 依赖 `app/theme.dart`；数据层 `data/` 依赖桌面外壳拿服务端地址；档案、农机这些服务端数据的 provider 定义在像素村里。改一张皮会碰到另一张，读代码也看不出一个东西是谁的。

## Decision

- **下面一层层往上**：
  - `gen/`：生成的形状和接口，不手改；
  - `data/`：服务端的状态流和其余读写（`providers.dart`、`remote.dart`），以及本机的偏好和界面状态（`prefs.dart`、`ui_state.dart`：选中的帮工、开着的面板、设置页）；
  - `rules/`：只读 `CoreState` 的纯函数，不做 I/O；
  - `ui/`：像素控件、主题、通用的 `Ticking`、`TextLink`，不懂业务；
  - `audio/`：`sfx`、`synth`、`farm_sounds`，谁都能用，不 import 皮；
  - `chat/`、`voice/`：田头和语音的状态、规则和控件；
  - `shared/`：几张皮都用的画面和效果（脸、外形、干活记录、收获单、`fx`、奖章）；
  - `game/`：客户端的动作和特效状态（收、浇水、面板之外的状态），不 import 皮。
- **`village/` 是像素渲染层，不是皮**：`farm/` 和 `title/` 都用它；它不 import `desk/`、`farm/`、`phone/`。
- **皮是 `desk/`、`farm/`、`phone/`、`title/`**：皮之间不互相 import；一张皮用的放皮里，两张以上用的放 `shared/`。
- **`app/` 只做组合**（`router.dart`、`main.dart`），`shell/` 是外壳（frame、桌面标题栏、连不上时的横幅）；下面的层不 import `app/`，`shell` 也不。
- **一样东西一个来源**：档案和农机从 `deskConfigProvider` 读（[客户端问服务端](2026-10-16-the-client-asks-the-server.md)）；一个 `apiProvider`；工地事件一个 `sideEventsProvider`。
- **服务端地址归数据层**：`data/providers.dart` 的 `embeddedServerAddress`，桌面外壳开起服务端以后写进去。

## Alternatives considered

**全部放进一个 `common/`。** 少几个目录。没选：田头是一整块功能（状态、规则、控件），和「几张脸、几个小控件」不是一回事；分开以后看目录就知道田头在哪。

**让一张皮拥有共用的，另一张依赖它。** 现在的样子就是这样，问题正是依赖成了双向的：谁先有就放谁那里，后来的那张又被反过来借。

**按功能拆成包（Dart 的 package）。** 编译器能挡住反向依赖。没选：现在一个应用一个包就够，目录约定加上 analyze 已经能看出来；真要挡，再拆。

## Consequences

- `desk/`、`farm/`、`phone/` 之间没有 import；`village` 只剩三处反过来依赖 `farm/friends`、`farm/quota`、`phone/phone`（下一步把它们搬进 `shared/`）。
- 「这个控件该放哪」有了答案：只一张皮用的放皮里，两张都用的放 `shared/`，和皮无关的放 `ui/`，本机状态放 `data/`，声音放 `audio/`。
- 顺带合掉了两份重复：两个 `AgentFace`、两套挑动物的规则（像素村的 `lookOf` 自己有一份物种表和哈希，和 `castOf` 对表情符号的 id 会挑出不同的动物）。

## Verification

- 2026-10-17 的整理：`shell/prefs.dart` → `data/prefs.dart`，`shell/sfx.dart`、`synth.dart`、`farm_sounds.dart` → `audio/`，`shell/title/title_state.dart` 和 `game/state.dart` 的面板/选中状态 → `data/ui_state.dart`，`shell/fx_layer.dart` → `shared/fx.dart`，`shell/achievements.dart` → `shared/medals.dart`，`app/desk.dart` 的 `Place`/`Desk` → `desk/places.dart`、`desk/desk_shell.dart`；`server_away` 不再 import `app/router`。
- `bun run flutter:check`：analyze 干净，284 个测试通过。
- 依赖：`grep` 各目录的 import，`desk`/`farm`/`phone` 之间没有互相引用；`chat`、`shared`、`ui`、`data`、`audio`、`game` 不 import 任何一张皮；下层不 import `app`。

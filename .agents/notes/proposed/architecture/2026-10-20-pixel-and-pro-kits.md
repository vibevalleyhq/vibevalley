# Agent Note: 两组组件：农场用像素组，工作台用专业组

Status: proposed

## Problem

工作台是 Linear 那一面：看板、聊天页、档案、设置，是主人真干活的地方，要的是一屏看得多、扫得快。它现在和农场一样是像素皮，像素皮在这里有三笔成本：

- **字只有两档**：Fusion Pixel 只在 12px 和 24px 清楚，没有 13、14、16，也没有字重（单字重，`ui/kit/README.md`）。层级只能靠框和颜色，所以每一页都是一层层 2px 的框和硬投影。
- **中文扫起来累**：12px 的像素中文能一行一行读，在看板、列表、聊天记录里扫就吃力。聊天页的字最多，最先让人觉得不对。
- **「读的换字」只是补丁**：长文改用阅读字（`KitText.read`，[客户端](docs/subsystems/app.md)）解决了读，没解决扫。

两张皮差的是结构，不只是参数：像素有窗框、斜面、2px 硬投影、单字重；专业要的是列表行、表格、菜单、悬停态、字重，像素那边用不上。一套接口只能取两边都有的那部分。

## 现状拆解

数字是 `app/lib` 在 `6882571` 上数的。

### 组件

`ui/kit` 是一组像素组件（`ui/kit/README.md` 开头就写「像素控件」），`ui/` 下另有几样：

| 东西 | 在哪 | 归哪 |
|---|---|---|
| `PxButton`、`PxCard`、`PxField`、`PxTextInput`、`PxTextArea`、`PxSegmented`、`PxPick`、`PxSwitchField`、`PxChipsInput`、`PxKeyValueEditor`、`PxDialog`、`PxModalLayer`、`PxScrollView`、`PxWindow`、`KitTappable`、`KitText`、`kitDrop`、`pxRing`、`DashedLine`、`FarmDialog`、`ToastViewport`、`PxMarkdown`、`PxReadText` | `ui/kit/*.dart` | 像素组 |
| `PixelCard` 一族、`PxFrame`、`pxInset`、`PixelMark`、`EarnedMedal` | `ui/pixel_card.dart`、`ui/pixels.dart`、`ui/glyphs.dart`、`ui/medals.dart` | 像素组 |
| `Palette`、字体名（`pixelFont`、`readFont`、`monoFont`） | `ui/theme.dart` | 两组共用 |
| `SpriteIcon`、`ActionGlyph`、`PhaseGlyph`、`ManagerFace`、`AnimalFace` | `ui/kit/icons.dart`、`ui/pixels.dart` | 两组共用：像素贴图和头像是身份（规矩：图标用像素贴图） |
| `parseMarkdown`、`parseInline`、`Md*`、`withMentions`、`plainText` | `ui/kit/markdown.dart` | 两组共用：解析不画东西 |
| `toasts`、`ToastManager`、`ToastType`、`ago`、`numberText`、`*Label`、`Ticking`、`quotaOf` | `ui/kit/toast.dart`、`labels.dart`、`ticking.dart`、`energy.dart` | 两组共用：数据和说法 |

### 谁用

| 目录 | 文件 | 皮 | 现在用像素组的次数（`KitText` / `PxButton` / `PxField` / `PxCard` / `PxWindow`） |
|---|---|---|---|
| `farm`、`village`、`title`、`phone` | 17 + … | 像素 | 95 / 24 / 3 / 0 / 1（farm） |
| `workbench` | 44 个，13970 行 | 专业 | 285 / 82 / 69 / 38 / 22 |
| `shared` | 20 个，5810 行 | 两张皮都用 | 109 / 34 / 0 / 1 / 2 |
| `chat` | 4 个，830 行 | 两张皮都用 | 18 / 1 / 0 / 0 / 1 |

### shared 和 chat 里，谁真的两张皮都用

| 文件 | 行 | 用它的 | 处理 |
|---|---|---|---|
| `shared/issue_view.dart` | 806 | `farm/plot_detail.dart`、`workbench/issues` | 拆：逻辑留下，两份视图 |
| `shared/composer.dart` | 313 | 农场田头、浇水、工作台聊天页、工单详情 | 拆：`ComposerDraft` 留下（本来就不画东西），两份视图 |
| `shared/chat_widgets.dart` | 472 | 两边的聊天 | 拆：`Naming`、时钟和说法留下；头像、`ChatText`、气泡件两份 |
| `shared/harvest.dart`、`shared/seed_bag.dart` | 343、375 | 农场面板、工作台的工单和地图 | 拆 |
| `chat/dispatch_note.dart`、`chat/turn_steps.dart` | 41、69 | 两边的聊天 | 两份视图 |
| `shared/work_log.dart`、`shared/trajectory.dart` | 595、814 | 工单详情、`turn_steps`、工作台的档案和管家页 | 跟着 `IssueView` 拆；`trajectory` 只在工作台，挪过去 |
| `shared/settings_form.dart` | 519 | 只有工作台（`settings`、`chat/dialogs`、`manager`、`voice`） | 挪进 `workbench`（`app.md` 说首页也用，已经不对） |
| `chat/channel_menu.dart`、`shared/friends.dart`、`shared/quota_pill.dart`、`shared/popover.dart`、`shared/connection_banner.dart`、`shared/farm_sounds.dart` | | 只有农场 | 挪进 `farm` |
| `chat/chat_state.dart`、`shared/chat_rules.dart`、`shared/swatches.dart`、`shared/tags.dart`、`shared/faces.dart`、`shared/manager_stop_button.dart`、`shared/dictation_button.dart` | | 两边 | 不画东西的留下；两个按钮跟着 `Composer` 两份 |

两张皮都用的视图一共七块；其余的不是只属于一张皮，就是本来不画东西。

## Proposal

**两组组件：`ui/pixel` 给农场，`ui/pro` 给工作台；两组共用的只有色板、字体名、贴图、头像和不画东西的那些。`shared` 和 `chat` 只放逻辑和状态，每张皮自己画自己的视图。**

### 目录

```
ui/              两组共用：theme.dart（Palette、字体名）、icons（SpriteIcon、头像）、
                 markdown 的解析、labels、toasts 的数据、ticking
ui/pixel/        像素组：今天的 ui/kit 和 pixel_card、pixels、glyphs、medals，名字照旧是 Px*；
                 KitText → PxText（Tappable 是行为，进共用层）
ui/pro/          专业组：新写，名字是 Pro*（ProText、ProButton、ProPanel、ProField、ProTextInput、
                 ProTextArea、ProSegmented、ProPick、ProSwitch、ProDialog、ProMarkdown、ProListRow、ProMenu……）
shared/、chat/   逻辑和状态：ComposerDraft、Naming、chat_state、规则和说法、IssueView 的状态和能做的事
farm/ village/ title/ phone/   用 ui/pixel 画
workbench/       用 ui/pro 画
```

### 两组各是什么样

| | `ui/pixel` | `ui/pro` |
|---|---|---|
| 字 | Fusion Pixel 12、24，单字重；长文用阅读字（苹方 14），对话里的长消息先折后读 | 苹方，12、13、14、16、20、24，w400、w500、w600；不分「说」和「读」 |
| 线 | 2px `bark500` 边、2px `cream300` 内线 | 1px 细线 |
| 投影 | 2px 硬投影 | 没有，浮层用 1px 软边 |
| 按钮 | 斜面，按下沉 2px | 平的，悬停和按下各深一档 |
| 面板 | `PxWindow` 窗框、`PxCard` 纸色卡片 | 平的面板和分隔线 |
| 只它有的 | 窗框、牌子、奖章、虚线、农场面板的框 | 列表行、表格、菜单、提示条、快捷键提示 |
| 色板、图标、头像 | 共用 | 共用 |

`ui/pro` 从工作台实际要的长出来，不照着 `ui/pixel` 一个对一个抄。

### 两张皮都用的那七块怎么拆

照 `Composer` 已经走通的样子：状态和规则一份，画面两份，画面只做展示。

- **`IssueView`**：现在的 `_status`、`_actions`、`judging`、`talking`、`reopening`、`crew` 是规则，挪成 `shared/issue_state.dart` 里的纯函数（输入 `Issue`、`Session`、`IssueTag`，输出「一句状态」「能做的事」）；`farm/plot_detail.dart` 和 `workbench/issues` 各画一份。农场那份照今天的样子，工作台那份按专业组重排，`IssueFrame` 就不要了。
- **`Composer`**：`ComposerDraft` 不动；`bar` 和 `inline` 两种外形去 `farm`，`panel` 和 `inline` 两种去 `workbench`。
- **聊天**：`Naming`、`readsLong`、时钟和说法留在 `shared`；气泡、`ChatText`、派活消息、每次干活两边各一份。
- **收成清单、播种袋**：同样，先抽出规则，再各画一份。

两份视图共用一份规则，规则有测试；视图只剩排版，走样了也只是排版走样。

### 怎么查

`scripts/app-imports.ts` 加三条：

- `farm`、`village`、`title`、`phone` 不能 import `ui/pro`；
- `workbench` 不能 import `ui/pixel`；
- `shared`、`chat`、`data`、`game` 两组都不能 import（只能用 `ui/` 共用的那层）。

迁移期间第二条带一张还没迁完的工作台文件清单，清单只减不加，空了就删。

### 顺序

1. **挪像素组**：`ui/kit` 和 `ui/` 下的像素件挪进 `ui/pixel`，共用的挪到 `ui/` 那层；`KitText` → `PxText`，`KitTappable` → `Tappable`（共用层）。纯挪动和改名，农场、工作台的样子都不变。加上第一、三条检查（`shared` 里现有的视图先列进清单）。
2. **专业组起步，验证两页**：`ui/pro` 先写聊天页和工单详情要的：`ProText`、`ProButton`、`ProPanel`、`ProTextInput`、`ProTextArea`、`ProMarkdown`。拆出 `IssueView` 的规则和 `Composer` 的两份视图，工作台的聊天页和工单详情改用专业组。截 1440×900 和 390×844 的前后对比，主人定下专业组的字号、线、按钮和面板，再往下做。
3. **工作台一页一页迁**：按 `workbench/` 的目录走（`chat`、`issues`、`agents`、`manager`、`runtimes`、`projects`、`map`、`settings`、`connectors`、`skills`、`voice`、`lan`、`catalog`、外框），每迁完一页从清单里划掉；专业组跟着页面要什么长什么。
4. **拆完 `shared`**：收成清单、播种袋、每次干活、派活消息；只属于一张皮的文件挪进那张皮的目录。`shared` 的清单清空。
5. **沉淀**：两组的分工写进[客户端](docs/subsystems/app.md)（顺手改掉「首页也用设置表单」）和 `docs/reference/farm-ui.md`；`ui/pixel/README.md` 由今天的 `ui/kit/README.md` 改来，`ui/pro/README.md` 新写；删掉本文。

每一步各自跑 `bun run flutter:check`，按 `verify-app` 截图。

### 进展

- **第 1 步做完了**（2026-10-20，`6a623e7`）：像素组在 `ui/pixel`，共用的在 `ui/`（`common.dart`）；`KitText` → `PxText`，`KitTappable`、`KitState` → `Tappable`、`TapState`（行为，不是样子，所以进共用层），`kitMotion`、`kitMoves`、`kitOpenLink`、`kitDrop`、`kitBare` 去掉 kit 前缀；`app-imports` 有了 `KITS` 和 `KIT_DEBT`（起步 54 个文件）。
- **第 2 步做了一半**：`ui/pro` 起来了（`ProText`、`ProButton`、`ProField`、`ProTextInput`、`ProTextArea`、`ProDialog`、`ProMarkdown`、`ProScope`）；Markdown 的排版挪到共用的 `MarkdownView`，两组只给一张 `MdLook`；听写和叫停管家的逻辑成了 `DictationControl`、`ManagerStopControl`，两组各画按钮；`ComposerDraft` 之上工作台有自己的 `WorkbenchComposer`。工作台的聊天页（`workbench/chat` 四个文件）已经是专业组，`KIT_DEBT` 剩 50。
- **第 2、3 步做完了**（2026-10-20）：工作台的七个地方（频道、工单、帮工和管家、农具、项目和地图、图鉴、设置）都是专业组画的，`workbench/` 里没有一个文件 import `ui/pixel`。专业组补齐了分段、下拉、开关、标签串、键值编辑、卡片、浮层、提示、宽弹窗（`maxWidth`）；外框和 `workbench/shared` 的布局件包在一个 `ProScope` 里。拆出来的规则：`shared/issue_state.dart`（工单详情，有测试）、`shared/work_log_rules.dart`、`shared/harvest_rules.dart`、`shared/seed_bag.dart`（播种袋的状态和动作）；工作台各有一份视图（`workbench/issues/issue_panel.dart`、`harvest_review.dart`、`workbench/shared/work_log.dart`、`workbench/map/seed_bag_view.dart`、`workbench/chat/turn_steps.dart`），农场的留在原处。只在工作台用的挪了过去：`trajectory.dart`、`settings_form.dart`；地图上的岛牌子挪进 `village/island_cards.dart`。`IssueFrame` 删了。`KIT_DEBT` 剩 18 个，都是农场那边的 `shared`、`chat` 视图（第 4 步）。

## Alternatives considered

**一套组件、两种外形（`KitSkin`）。** 本文取代了同一天提出的那一篇（「工作台换成专业皮：一套组件，两种外形」）。它让每个组件读上下文里的皮，`shared` 里的视图写一份就能两边用。放弃它，是因为两张皮差的是结构：像素的窗框、斜面、牌子和专业的列表行、表格、菜单对不上同一套接口，只能取交集，或者每个组件里写两个 build，等于两组组件挤在一个文件里；而且它要一次把 `KitText` 的 508 处改成从上下文取，农场也跟着动。两组组件让农场只挪目录，工作台一页一页迁。

**只把聊天页改成专业样子。** 改得最少；但从聊天页进工单、回看板，皮来回切。

**全客户端都换成专业组，农场也不要像素。** 一组最省事；但像素农场是产品本身（[概念](docs/concepts.md)「农场是皮」）。

**`shared` 的视图保留一份，里面按皮分支。** 不用拆；但 `shared` 就要同时 import 两组，皮的判断散在每个视图里，又回到一套组件两种外形。

**同时把 `Palette` 换成语义色。** 专业组能有自己的配色；但这是 1079 处的另一次迁移，和换组件没有先后关系，先留着当身份。

## Acceptance criteria

- 工作台每一页（`live_screens_test.dart` 的 `pages` 里非农场的那些）在 1440×900 和 390×844 下是专业组画的：苹方、有字重、1px 线、没有窗框和硬投影；图标、头像和色板还在。
- 农场、首页、手机、村子的截图和迁移前一样（同一个服务端、同一份数据，逐页对比）。
- `IssueView` 的规则只有一份（`shared/issue_state.dart`，有测试），农场和工作台各一份视图；`Composer` 同样。
- `app-imports` 的三条检查生效，迁移清单为空；`shared`、`chat` 不 import 任何一组。
- `bun run flutter:check` 过。

## Risks

- 两份视图会各自长：农场的工单详情和工作台的工单详情加功能要加两处。规则都在 `shared` 的纯函数里，加一种状态或一个动作先改规则和它的测试，两份视图只是把它画出来；规则的测试里列出所有动作（照「封闭的联合穷尽处理」）。
- 工作台的布局是照 12px 像素字排的（工作台、`shared`、`chat` 里写死 `12 *`、`* 12` 或 `1.625` 的有 32 处），迁一页就重排一页，不按原来的尺寸硬套。
- 迁移要几周：期间工作台是像素页和专业页混着的。按目录迁，一个目录内不混；清单让剩下多少一眼可见。
- 第 1 步的挪动和改名碰到几乎每个文件，和并行的工作冲突；它是纯机械的，一次做完、单独提交。

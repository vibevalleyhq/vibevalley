# Agent Note: 工作台换成专业皮：一套组件，两种外形

Status: proposed

## Problem

工作台是 Linear 那一面：看板、聊天页、档案、设置，是主人真干活的地方，要的是一屏看得多、扫得快。它现在和农场一样是像素皮，像素皮在这里有三笔成本：

- **字只有两档**：Fusion Pixel 只在 12px 和 24px 清楚，没有 13、14、16，也没有字重（单字重，`ui/kit/README.md`）。层级只能靠框和颜色，所以每一页都是一层层 2px 的框和硬投影。
- **中文扫起来累**：12px 的像素中文能一行一行读，在看板、列表、聊天记录里扫就吃力。聊天页的字最多，最先让人觉得不对。
- **「读的换字」只是补丁**：长文改用阅读字（`KitText.read`，[客户端](docs/subsystems/app.md)）解决了读，没解决扫；到了工作台，几乎每一处都是该用阅读字的地方。

只改聊天页不行：从聊天页点进工单、再回看板，皮来回切，比全像素更别扭；而且工作台各页共用 `ui/kit` 的组件，只改一页就要在那页另写一套。

## 现状拆解

数字是 `app/lib` 在 `1ef970f` 上数的（`ui/` 以外的引用）。

### 组件和它们在哪用

| 组件（`ui/kit`） | workbench | shared | chat | farm | 外形跟着皮变 |
|---|---|---|---|---|---|
| `KitText`（xs、sm、base、lg、xl、x2l、fine、mono、read） | 285 | 109 | 18 | 95 | 字体、字号、字重 |
| `Palette` | 446 | 287 | 28 | 251 | 不变（见下） |
| `PxButton`、`PxTone`、`PxSize` | 82 | 34 | 1 | 24 | 斜面和下沉 → 平的 |
| `KitTappable` | 39 | 24 | 8 | 20 | 焦点描边 |
| `PxField` | 69 | 0 | 0 | 3 | 标签的字 |
| `PxTextInput`、`PxTextArea` | 49 | 6 | 5 | 6 | 2px 框 → 1px |
| `PxCard` | 38 | 1 | 0 | 0 | 纸色卡片 → 平的面板 |
| `PxWindow`（当作面板用） | 22 | 2 | 1 | 1 | 像素窗框 → 平的面板 |
| `pxRing`、`pxLine`、`kitDrop` | 35 | 7 | 0 | 3 | 2px 内线、2px 边、硬投影 |
| `PxSegmented`、`PxPick`、`PxSwitchField` | 29 | 5 | 0 | 2 | 框和选中态 |
| `PxScrollView` | 14 | 0 | 0 | 0 | 「裁剪比自己大一圈」只为露出像素外框 |
| `showPxDialog`、`PxModalLayer`、`toasts` | 9 处弹窗、1、8 | | | | 框 |
| `PxMarkdown`、`PxReadText` | 2 | 8 | 1 | 1 | 正文和标题的字 |
| `SpriteIcon`、`Glyph`、`ManagerFace`、`AnimalFace` | 47 | 29 | 8 | 29 | 不变：像素贴图是身份 |

另外：页面里自己画的框和字也要跟着走：`Border.all(` 工作台 10、shared 15，`TextStyle(` 工作台 18、shared 18，`fontSize:` 工作台 15、shared 16；直接写 `pixelFont` 的有 7 个文件（`shared/connection_banner.dart`、`shared/settings_form.dart`、`chat/channel_menu.dart`、`workbench/chat/chat_page.dart`、`workbench/chat/message_list.dart`、`farm/farm_page.dart`、`farm/chat_window.dart`）；顶层写死的像素字样式 5 个（三个 `_grey`、`chatSmall`、`_body`）。

### 皮在哪定

- 主题只有一个：`app/app.dart` 的 `MaterialApp.router(theme: farmTheme())`。
- 工作台的页面在 `app/router.dart` 的 `Workbench` 这个 `ShellRoute` 下面；农场在它外面，一直挂着（`_KeepFarm`）。所以「工作台的外框下面就是专业皮」可以在一处定。
- 例外有三处：弹窗（`showPxDialog`、`showFarmDialog` 用 `showGeneralDialog`，开在根导航上，在 `Workbench` 外面）；提示（`ToastViewport` 在 `shell/app_frame.dart`，盖在两张皮上面）；`shared` 和 `chat` 两张皮都用（`IssueView` 已经有一个 `IssueFrame.farm` / `workbench` 参数，就是一个小号的皮开关）。

### 只属于像素的东西

`PxWindow` 的窗框、`ui/pixel_card.dart`（`PixelCard`、`Words`、`Bar`、`CardColors`，地图和村子里的牌子）、`ui/pixels.dart` 的 `PxFrame`、`pxInset`、`ui/glyphs.dart`、`ui/medals.dart`、`FarmDialog`、`DashedLine`。它们没有专业版：工作台用到它们（`PxWindow` 22 处）其实要的是「一块面板」。地图页（`workbench/map/map_page.dart`）画的是村子，`PixelCard` 在那里是画面的一部分，不算界面。

另有一处重名：`Glyph` 同时是 `ui/pixel_card.dart` 的一种牌子零件、`village/particles.dart` 的粒子和 `shared/chat_widgets.dart` 的贴图按钮图标。

## Proposal

**一套组件接口，两种外形；另有一层只有像素才有的东西。** 不做两套平行的组件库：`shared` 里的组件两张皮都用，两套库会让它们要么写两份，要么自己判断用哪套；每个组件写两遍会慢慢走样（`Composer` 统一前就是这样分叉的）。

### 目录和名字

```
ui/theme.dart   色板、字体名（pixelFont、readFont、monoFont）
ui/kit/         组件：一套接口，读上下文里的 KitSkin 决定外形
                KitText、KitButton、KitCard、KitPanel、KitField、KitTextInput、KitTextArea、
                KitSegmented、KitPick、KitSwitchField、KitDialog、KitModalLayer、KitMarkdown、
                toasts、KitTappable、SpriteIcon……
ui/pixel/       只有像素才有的东西：PxWindow、PixelCard 一族、PxFrame、pxInset、FarmDialog、
                DashedLine、glyphs、medals；kit 的 pixel 外形用它们，farm、village、title、phone 也直接用
```

- `ui/kit` 里的 `Px*` 改名 `Kit*`；`Px*` 只留给 `ui/pixel`，名字说明它在哪一层。
- 头像（`ManagerFace`、`AnimalFace`）和贴图（`SpriteIcon`）两张皮都用，留在 `ui`（头像从 `pixels.dart` 挪到 `ui/faces.dart`）。
- `Glyph` 三处改成三个名字：牌子零件 `CardGlyph`，粒子 `ParticleGlyph`，贴图按钮图标 `SpriteGlyph`。

### KitSkin：皮是什么

`KitSkin` 是一个 `ThemeExtension`，两份：`KitSkin.pixel`、`KitSkin.pro`。组件只经它取跟皮有关的东西：

| 取什么 | pixel | pro |
|---|---|---|
| 字体 | Fusion Pixel（只有 w400） | `readFont`（苹方），w400、w500、w600 |
| `xs` `sm` `base` `lg` `xl` `x2l` | 12 12 12 12 24 24 | 12 13 14 16 20 24 |
| `read` | 苹方 14、行高 1.7 | 同 `base`（本来就是读的字） |
| `mono` | Menlo，中文退到像素字 | Menlo，中文退到苹方 |
| `line`（控件边） | 2px `bark500` | 1px `bark300` |
| `ring`（内线） | 2px `cream300` | 无 |
| `drop`（投影） | 2px 硬投影 | 无，或 1px 软边 |
| 按钮 | 斜面，按下沉 2px | 平的，按下变深一档 |
| Markdown 标题 | `#` 24、其余 12，像素字 | 阅读字，`#` 20、`##` 16、其余 14，w600 |
| 长消息 | 先露 6 行像素字，「展开阅读」换字（`ChatText`） | 整条显示，不折 |

色板（`Palette`）两张皮共用，不另做语义色：它是农场的身份，1079 处直接引用，换成语义色是另一件事。

### 皮挂在哪

- `Workbench` 的 `ShellRoute` 外面包一层 `Theme(data: … KitSkin.pro)`；`app/app.dart` 的 `farmTheme()` 带 `KitSkin.pixel`。`shared`、`chat` 不选皮，跟着上下文。`IssueFrame` 只留布局上的区别，字和框交给皮。
- 弹窗：`showKitDialog` 在开之前取调用处的 `KitSkin`，包进弹出的路由（`InheritedTheme.capture` 那样），弹窗跟着点它的那一页。
- 提示：`ToastViewport` 按现在在不在农场（`_KeepFarm` 的 `onFarm`）选皮。
- 调试台（`debug`）有自己的深色样子，不动。

### 怎么查

- `scripts/app-imports.ts` 加一条：`workbench`、`shared`、`chat` 不能 import `ui/pixel`（地图页画村子经 `village`，不受影响）。
- 一条检查：`ui/` 以外不出现 `fontFamily:`、`pixelFont`、`fontSize:`（写死字号就是绕开了皮）；现有的在迁移里清掉，之后由 `flutter:check` 拦。
- 像素皮下不出现 `FontWeight` 大于 w400（Flutter 会合成假粗体）：`KitSkin.pixel` 的样式统一压回 w400。

### 顺序

1. **最小验证**：`KitSkin` 加上字号表、`line`、`ring`、`drop`；`KitText` 改成 `KitText.of(context)`；`PxCard`、`PxButton` 按皮出两个外形；`Workbench` 挂 `pro`。只迁移聊天页和工单详情两页，截前后对比（工作台 1440×900 和 390×844）。主人看过，定下 pro 的字号、线和按钮，再往下做。
2. **字**：ast-grep 把 `KitText.xs` 这类改成 `KitText.of(context).xs`，顶层的 5 个常量样式改成从上下文取，`const` 里引用了它们的由 analyzer 报出来逐个改；清掉页面里的 `pixelFont`、`fontSize:`。
3. **线和面板**：`pxLine`、`pxRing`、`kitDrop` 改从 `KitSkin` 取；工作台、`shared`、`chat` 里当面板用的 `PxWindow` 换成 `KitPanel`；页面里自己画的 `Border.all` 逐个归到 `line` 或 `KitPanel`。
4. **其余组件**：输入框、分段、下拉、开关、标签串、键值编辑、弹窗、浮层、提示、`PxScrollView`、`KitTappable` 的焦点、`Composer` 的 `panel` 和 `inline`、Markdown 的标题和 `ChatText` 的折叠，按上表出两个外形。
5. **挪目录和改名**：`ui/pixel` 建起来，`Px*` → `Kit*`，`Glyph` 拆名，加 `app-imports` 和字体的检查；重写 `ui/kit/README.md`。
6. **沉淀**：两张皮的分工写进[客户端](docs/subsystems/app.md)和 `docs/reference/farm-ui.md`，删掉本文。

每一步各自跑 `bun run flutter:check`，按 `verify-app` 截图。

## Alternatives considered

**两套平行的组件库（`components/pixel`、`components/ui`）。** 两种外形可以完全各写各的；但 `shared` 里的 `IssueView`、`Composer`、`ChatText` 两张皮都用，要么各写一份，要么自己判断用哪套，等于又抽一层接口；每个组件两份实现会慢慢走样，接口一样、行为不同，编译器查不出来。

**只把聊天页改成专业样子。** 改得最少；但从聊天页进工单、回看板，皮来回切；而且那一页要绕开 `ui/kit` 另写，又多一份。

**全客户端都换成专业皮，农场也不要像素。** 一套外形最省事；但像素农场是产品本身，不是装饰（[概念](docs/concepts.md)「农场是皮」）。

**在每个组件上加 `pixel: bool` 参数。** 不用上下文；但每个调用处都要传，`shared` 里的组件还得一路往下传，漏一处就是一块像素混在专业页里。

**同时把 `Palette` 换成语义色。** 专业皮能有自己的配色；但这是 1079 处的另一次迁移，和换字、换线没有先后关系，先留着当身份。

## Acceptance criteria

- 工作台每一页（`live_screens_test.dart` 的 `pages` 里非农场的那些）在 1440×900 和 390×844 下是专业皮：苹方、有字重、1px 线、没有像素窗框和硬投影；图标、头像和色板还在。
- 农场、首页、手机、村子的截图和迁移前一样（同一个服务端、同一份数据，逐页对比）。
- 同一个 `IssueView`、`Composer`、`ChatText` 在农场是像素、在工作台是专业；从工作台打开的弹窗是专业，提示在农场是像素、在工作台是专业。
- `bun run flutter:check` 过；`app-imports` 拦得住工作台 import `ui/pixel`；`ui/` 以外写 `fontFamily:`、`fontSize:` 会报错。

## Risks

- 改动面大：`KitText` 508 处、`PxButton` 141 处、`PxField` 72 处。靠 ast-grep 批量改，每一步单独提交，农场截图逐页对比兜底。
- 工作台的布局是照 12px 像素字排的（工作台、`shared`、`chat` 里写死 `12 *`、`* 12` 或 `1.625` 的有 32 处），换字以后会有溢出或空得太多的地方，第 1 步的两页先暴露这类问题。
- 两种外形都要测：组件测试默认是哪张皮要定（默认 pixel，工作台的测试挂 pro），不然一半外形没人看。
- 改名 `Px*` → `Kit*` 会碰到几乎每个页面文件，和并行的工作冲突；放在最后一步，一次做完。

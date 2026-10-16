# ui/kit

配置页和农场面板共用的像素控件。只要一行 `import 'package:vibevalley/ui/kit/kit.dart';` 就能全部拿到，`lib/app/theme.dart`（`Palette`、`pixelFont`、`monoFont`）和 `lib/ui/px.dart`（`PxFrame`、`pxInset`、管家和动物的脸）也一并导出了。

| 部件 | 说明 |
| --- | --- |
| `PxButton`、`PxButton.text`；`PxTone`、`PxSize` | 按下时下沉 2 px、阴影消失；用键盘聚焦时出现叶绿描边；`onPressed` 为 null 就是禁用 |
| `PxCard` | 纸色卡片，可以带 `title`、`aside` |
| `PxDialog`、`showPxDialog` | 配置页的对话框，作为弹出路由打开 |
| `FarmDialog`、`showFarmDialog`、`FarmDialogSize`、`FarmSection` | 农场面板的框：尺寸固定，内容在里面滚动 |
| `PxField` | 带标签、提示和错误的一栏 |
| `PxTextInput` | 受控的 `value`、`onChanged`；`suggestions` 是输入时给的候选 |
| `PxTextArea` | 多行输入 |
| `PxSegmented`、`SegmentOption` | 默认占满给它的宽度；和别的东西并排时传 `block: false` |
| `PxPick`、`PickOption` | 下拉选择，会占满给它的宽度，所以要给有界的宽度 |
| `PxSwitchField` | 带标签的开关 |
| `PxChipsInput` | 自由填写的一串标签 |
| `PxKeyValueEditor` | 一行一个 `KEY=value` |
| `PxMarkdown`、`withMentions`、`plainText`、`parseMarkdown`、`parseInline` | 自己写的 GFM 子集解析器；`@w3` 这样的名字画成小标签；链接通过 `onOpenLink` 或 `kitOpenLink` 打开 |
| `actionLabel`、`actionMeaning`、`phaseLabel`、`foremanLabel`、`outcomeLabel`、`runtimeLabel`、`ago` | 动作、阶段、管家状态、一轮的结果、农机的叫法，和「多久前」 |
| `SpriteIcon`、`ActionGlyph`、`PhaseGlyph`、`outcomeIcon`、`Marked` | 图标都是 `design/pixel` 生成的贴图，不用字符代替（像素字体里没有 ✓、✗、›） |
| `EnergyBottle`、`StaminaBar`、`quotaOf`、`Quota`、`QuotaLevel`、`windowLabel`、`bottleSprite`、`quotaLeft`、`quotaText`、`quotaLow` | 精力瓶和体力条（[game-ui.md](../../../../docs/game-ui.md#精力瓶)） |
| `toasts`、`ToastManager`、`ToastViewport`、`ToastType`、`noticeTitle` | 提示。奖章和成就上方那行字由 FX 层通过 `leading`、`kicker` 传进来 |
| `KitTappable`、`KitText`、`PxWindow`、`DashedLine`、`kitDrop`、`pxRing`、`FillWidth`、`PxScrollView`、`currentColor` | 写新零件时用到的基础件。`pxRing` 是那条 2 px 的 cream-300 内线，用作 `foregroundDecoration`，不占内容的位置；`PxScrollView` 的裁剪比自己大一圈，贴边的框能露出外框线和投影 |

像素皮肤的几条约定：

- 阴影都是 2 px 的硬投影（`kitDrop`），不模糊。
- 输入框、开关、分段按钮的框是 `pxRing` 那条内线，聚焦时不变；只有按钮的叶绿描边和输入框的边框颜色标出焦点。
- 只有一种字重，也不合成斜体，所以 Markdown 里的 `**` 和 `*` 显示出来就是普通字。

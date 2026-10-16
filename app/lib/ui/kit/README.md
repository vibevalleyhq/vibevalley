# ui/kit

这是网页共用的界面零件移植到 Flutter 后的样子，用的是像素皮肤（`web/src/index.css` 的 `:root[data-skin='pixel']`）。只要一行 `import 'package:vibevalley/ui/kit/kit.dart';` 就能全部拿到，`app/theme.dart`（`Palette`、`pixelFont`、`monoFont`）和 `ui/px.dart`（`PxFrame`、`pxInset`、脸）也一并导出了。

| 部件 | 网页上的对应 | 说明 |
| --- | --- | --- |
| `PxButton`、`PxButton.text`；`PxTone`、`PxSize` | `components/ui/button.tsx` 的 `Button`、`buttonClass` | 按下时下沉 2 px、阴影消失；用键盘聚焦时出现叶绿描边；`onPressed` 为 null 就是禁用 |
| `PxCard` | `components/ui/card.tsx` 的 `Card`（`.farm-card`） | 可以带 `title`、`aside` |
| `PxDialog`、`showPxDialog` | `components/ui/dialog.tsx` 的 `Dialog` | 网页上受控的 `open` 在这里换成了弹出路由 |
| `FarmDialog`、`showFarmDialog`、`FarmDialogSize`、`FarmSection` | `internal/farm/dialog.tsx` 的 `FarmDialog`、`Section` | 尺寸固定，内容在里面滚动 |
| `PxField` | `components/ui/field.tsx` 的 `Field` | |
| `PxTextInput` | `components/ui/input.tsx` 的 `TextInput`、`Input` | 受控的 `value`、`onChanged`；`suggestions` 对应 `<datalist>` |
| `PxTextArea` | `components/ui/textarea.tsx` 的 `TextArea`、`Textarea` | |
| `PxSegmented`、`SegmentOption` | `components/ui/segmented.tsx` 的 `Segmented` | 默认像块级元素一样占满给它的宽度；和别的东西并排时传 `block: false` |
| `PxPick`、`PickOption` | `components/ui/select.tsx` 的 `Pick` | 会占满给它的宽度，所以要给有界的宽度 |
| `PxSwitchField` | `components/ui/switch.tsx` 的 `SwitchField` | |
| `PxChipsInput` | `components/forms/chips-input.tsx` 的 `ChipsInput` | |
| `PxKeyValueEditor` | `components/forms/key-value-editor.tsx` 的 `KeyValueEditor` | |
| `PxMarkdown`、`withMentions`、`plainText`、`parseMarkdown`、`parseInline` | `ui/Markdown.tsx` 和 `.md` 样式 | 自己写的 GFM 子集解析器；链接通过 `onOpenLink` 或 `kitOpenLink` 打开 |
| `actionLabel`、`actionMeaning`、`phaseLabel`、`foremanLabel`、`outcomeLabel`、`runtimeLabel`、`ago` | `ui/labels.ts` | |
| `SpriteIcon`、`ActionGlyph`、`PhaseGlyph`、`outcomeIcon`、`Marked` | `internal/farm/glyphs.tsx`；`<img>` 加 object-contain | 图标都是 `assets/pixel` 的贴图（`design/pixel` 生成），没有线条图标，也不用字符代替：像素字体里没有 ✓、✗、›。`PhaseGlyph` 是帮工此刻的样子（在干什么、熟了、有虫、歇着），`outcomeIcon` 是一轮的结果（收获、虫、铲子），`Marked` 是前面带对勾、叉或警告的一行字；方向用 `button-next` 转 |
| `EnergyBottle`、`StaminaBar`、`quotaOf`、`Quota`、`QuotaLevel`、`levelOf`、`windowLabel`、`bottleSprite`、`quotaLeft`、`quotaText`、`quotaLow` | `ui/Energy.tsx`，以及 protocol 的 `quotaLeft`、`quotaText`、`QUOTA_LOW` | |
| `toasts`、`ToastManager`、`ToastViewport`、`ToastType`、`noticeTitle` | `ui/FxLayer.tsx` 里的 `toasts` 和它的 `ToastList` | 奖章和成就上方那行字由 FX 层通过 `leading`、`kicker` 传进来 |
| `KitTappable`、`KitText`、`PxWindow`、`DashedLine`、`kitDrop`、`pxRing`、`FillWidth`、`PxScrollView`、`currentColor` | 皮肤本身 | 写新零件时用到的基础件。`pxRing` 是那条 2 px 的 cream-300 内线，用作 `foregroundDecoration`，不占内容的位置；`PxScrollView` 的裁剪比自己大一圈，贴边的框能露出外框线和投影 |

像素皮肤有两处怪癖，这里照原样保留了：

- 类名里带 `shadow` 的元素，都会变成 2 px 的硬阴影。
- 类名里带 `ring-1`、`ring-2` 或 `shadow-[inset` 的元素，都会多一条 2 px 的 cream-300 内线（`pxRing`），而且盖过前一条的硬阴影。这条规则对焦点环同样生效，所以输入框、开关、分段按钮聚焦时看不出变化。只有按钮的 `outline` 和输入框的边框颜色会标出焦点。

另外，这套皮肤只有一种字重，也不合成斜体，所以 markdown 里的 `**` 和 `*` 显示出来就是普通字。

# ui/pro

工作台那张皮的组件：专业组（`ui/pixel` 是农场的像素组，两组的分工见 [客户端](docs/subsystems/app.md)）。一行 `import 'package:vibevalley/ui/pro/pro.dart';` 全部拿到，也带上两组共用的 `lib/ui/common.dart`。

| 部件 | 说明 |
| --- | --- |
| `ProColor`、`ProText`、`proLine`、`proRadius`、`proFloat` | 颜色取自农场的色板；字是苹方（12、13、14、16、20、24，有字重），`ProText.meta` 是名字旁边的灰字；线是 1 px；只有浮起来的（菜单、弹窗）有阴影 |
| `ProScope`、`proTheme` | 工作台的页面包在 `ProScope` 里：Material 自己的部件（提示条、选区、输入框）换成专业的样子，农场主题的 2 px 输入框边框去掉 |
| `ProButton`、`ProButton.text`、`ProButton.icon`；`ProTone`、`ProSize` | 参数和 `PxButton` 一样；`quiet` 是没有底色和边、悬停才显出来的按钮，图标按钮默认是它 |
| `ProPanel`、`ProFocusRing`、`ProCount`、`ProDot`、`ProTag` | 平的面板；键盘焦点的叶绿圈；未读数的小药丸；状态的圆点；消息和卡片前的小标签 |
| `ProField`、`ProTextInput`、`ProTextArea` | 参数和像素组的一样 |
| `ProDialog`、`showProDialog` | 弹窗开在根导航上，在 `ProScope` 外面，所以自己带上专业主题 |
| `ProMarkdown` | 和 `PxMarkdown` 用同一个解析和排版（`MarkdownView`），只换样子：正文 14，标题加粗，一行至多 48 字；工作台没有「说」和「读」之分 |

写新零件的约定：不写 `fontFamily`、不用像素组的东西；按钮、行、标签的圆角是 4–8 px；选中是 `ProColor.selected` 的底色，不加框。

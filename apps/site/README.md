# site

官网 vibevalley.dev：中文在 `/`，英文在 `/en/`，未找到的页面用 `/404.html`。Vite 与 Solid 2 在构建时生成完整 HTML；每个文档只有一个接管根，语言链接加载另一个文档。组件样式使用 StyleX（[vv-stylex](.agents/skills/vv-stylex/SKILL.md)），重置、令牌和接管前的规则由 `src/ui/global.css` 提供；动画使用 Motion DOM API。架构约定见[官网](docs/subsystems/site.md)。

`apps/site` 属于根 workspace，共用根 catalog、锁文件和检查。在根目录 `vp install`，再运行：

```bash
vp check                                              # 格式、lint、类型
vp run site:check                                     # 准备素材，测试静态页面生成
vp run site:build                                     # 生成到 apps/site/dist/client/
vp run --filter @vibevalley/site test:production        # 构建，验证正式页面
vp run --filter @vibevalley/site test:prerender         # 单根接管的独立回归页
vp run site:deploy                                    # 构建，再发到 Cloudflare
```

用静态服务器打开 `dist/client/` 验收；不需要线上 Node 服务。`dist/server/` 只供构建时生成 HTML，不能发布。

## 页面

`src/Document.tsx` 管文档、分享元信息、首屏资源与字体；`src/App.tsx` 选择首页或 404，`src/sections/Home.tsx` 拼出两种语言的首页。所有区块都在构建时写进 HTML，无脚本也能阅读。屏幕内外的节点随整个文档一起接管，不按可见性另建根。

`src/ui/global.css` 持有颜色、字体、硬阴影、动画和 `<html data-scene>` 的时辰规则；`tokens.stylex.ts` 引用这些变量，不另存一份值。共用组件在 `src/ui/ui.tsx`，动画的订阅与清理在 `src/animation/`。

## 素材

不另存原图：场景素材来自 `apps/web/public/`，截图来自 `docs/images/`，摆放的数据在 `src/base/scene.ts`。

- `scripts/images.ts` 读取 `scene.ts` 的 `SHOWN` 和时辰清单，用 Sharp 生成 WebP 与多尺寸截图；缺图、尺寸或清单就失败。
- 转换后的图写到 `public/gen/images/`，路径和尺寸由同一步写入 `src/base/images.generated.json`；不要手改生成清单。
- `scripts/prepare.ts` 把像素字体裁成页面实际用到的字，复制图标，并调用 `scripts/card.ts` 绘制分享图。输出都在 `public/gen/`，不进 git。
- 分享图每种语言一张，1200×630；字形转成 SVG 路径，不依赖构建机的字体。改了 `hero` 文案，构建会重新生成。

## 动画

- 云、炊烟和走路等循环动画使用 CSS；离屏区块标记 `data-off` 后暂停。
- 视差和滚动叙事由 Motion 的 `scroll()` 驱动。`Hero.tsx` 走完一天，`How.tsx` 按 `src/base/story.ts` 展示工作步骤。
- `src/animation/` 管进入、退出、图片展开、滚动、可见性和资源清理；组件管具体内容。截图对话框约束焦点，关闭后恢复焦点和滚动。
- 减少动画时跳过视差和进场，暂停 CSS 循环，内容仍完整。
- 首页时辰的句子要押韵：中文押 -ai 韵，英文两两押韵。改一句时一起检查其他句。
- 展示数字在 `src/base/facts.ts`，注明游戏代码中的出处；游戏变了跟着改。

## 测试

`test:production` 只访问正式构建的静态文件，覆盖三条路由的无脚本 HTML、初始 CSS、元信息、字体、接管前后的节点身份、截图对话框的焦点与退出、复制、时辰切换、离屏暂停、缩放后的滚动叙事和语言导航。普通动画桌面和减少动画手机各跑一遍，报告在 `.test/production/results.json`。

`test:prerender` 构建独立回归页，验证接管前的输入值、屏幕内外的 DOM、条件子树、监听清理与跨文档导航，报告在 `.test/prerender/results.json`。`test` 检查预渲染的错误、重定向和不完整响应不会写出部分 HTML。

## 文字

`src/i18n/zh.ts` 与 `en.ts` 形状相同，类型检查两者。新文案先加在 `zh.ts`，再补英文。

## 演讲稿

一场演讲一个 `talks/<场>/`：幻灯片是带样式和翻页的 `index.html` 与图片，旁边放提纲和会议模板。这里不发布；讲完后把页面和图挪进 `public/talks/<场>/`，构建原样拷贝，发布在 `/talks/<场>/`。署名用「海拉鲁编程客」，不写真名。

## 发布

`wrangler.jsonc` 只发布 `dist/client/` 的静态文件到 Cloudflare Worker，自定义域名也在配置中。先用域名所属账号 `vp dlx wrangler@4 login`，再 `vp run site:deploy`。服务端生成器不进入部署目录。

# site

官网 vibevalley.dev：一页静态网页，中文在 `/`，英文在 `/en/`。用 [Astro](https://astro.build) 生成，样式是 [Tailwind](https://tailwindcss.com)，会动的部分是 React island，动画用 [Motion](https://motion.dev)，Bun 管依赖。

```bash
cd site
bun install
bun run check     # 准备素材，再 astro check
bun run build     # 准备素材，再生成到 dist/
bun run deploy    # 构建，再发到 Cloudflare
```

不开 `astro dev`：改完跑 `check` 和 `build`，用静态服务器打开 `dist/` 看。

## 页面

`src/components/Home.astro` 拼出两种语言的首页，各段是 `src/components/*.tsx` 的 island：构建时渲染成 HTML，没有脚本也都在；顶栏和首页场景空闲时接管（`client:idle`），下面几段快滚到时才接管（`client:visible`）。共用的按钮、进场、跟着滚动动这些在 `src/components/ui.tsx`。

样式的主题（颜色、字体、硬阴影、动画）都在 `src/styles/global.css` 的 `@theme`；`morning:`、`day:`、`evening:`、`night:` 按 `<html data-scene>` 的时辰显隐。

## 素材

网页不另存一份游戏的图：场景照游戏的首页（`app/lib/title/`）画，图从 `app/assets/` 直接引用，摆放的数在 `src/lib/scene.ts`；截图在 `docs/images/`，用 `app/tool/screens/live_screens_test.dart` 拍。

- 大图在构建时转成 WebP（`src/lib/images.ts`），只压官网的副本。
- `src/lib/images.ts` 的清单要包含 `scene.ts` 的 `SHOWN`，缺了构建会报错。
- 别读导入的图的属性（连 `width` 也不行）：Astro 会把原图也发出去。尺寸从 `.clone` 上读。
- 像素字太大，`scripts/prepare.ts` 在构建前把它裁成用到的字，写进 `public/gen/`（不进 git）。
- 分享图（`og:image`）也由 `scripts/prepare.ts` 在构建前画，每种语言一张（`public/gen/card-<lang>.jpg`，1200×630）：傍晚的农场配首屏的名字、标语和那句介绍，画法在 `scripts/card.ts`。字是像素字的字形转成的路径，不靠系统装的字体；改了 `hero` 的字，图跟着变。

## 动画

- 一直在动的（云、炊烟、帮工走田埂）是 CSS 动画，只动 `transform`；滚出屏幕时停下（`data-off`）。
- 跟着滚动的用 Motion 的 `scroll()`，只动 `transform` 和 `opacity`。首页场景滚第一屏时走完一天（`Hero.tsx`），「怎么玩」是一段跟着滚动讲的故事（`How.tsx`，内容在 `src/lib/story.ts`）。
- 首页每个时辰的那句话（`i18n` 的 `hero.verses`）要押韵：中文押 -ai 韵，英文两两押韵；改一句，其他几句跟着看。
- 「能做什么」上的数字在 `src/lib/facts.ts`，每个注明它在游戏代码里的出处；游戏变了跟着改。
- 系统要求减少动画时，场景停在原处，视差和进场都没有。

## 文字

`src/i18n/zh.ts` 和 `en.ts` 形状一样（类型查）。加一段话先加在 `zh.ts`，再补 `en.ts`。

## 演讲稿

一场演讲一个目录，在 `talks/<场>/`：幻灯片是一个自己带样式和翻页的 `index.html` 加它的图，旁边是提纲和会议给的模板。这里不发布；讲完以后把 `index.html` 和图挪进 `public/talks/<场>/`，构建时原样拷过去，发布在 `/talks/<场>/`。稿子上的署名用「海拉鲁编程客」，不写真名。

## 发布

一个只有静态文件的 Cloudflare Worker（`wrangler.jsonc`），自定义域名写在配置里。先用握着这个域名的账号 `bunx wrangler login`，再 `bun run deploy`。

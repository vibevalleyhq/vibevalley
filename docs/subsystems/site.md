# 官网

vibevalley.dev 是仓库 `site/` 里的一页静态网页：Astro 构建时渲染成完整的 HTML，样式是 Tailwind，会动的部分是 React island，动画用 Motion；图和像素字全从 `app/assets`、`docs/images` 拿，不另存。中文在 `/`，英文在 `/en/`，放在 Cloudflare 一个只有静态文件的 Worker 上。卖点是一种日子：「写代码，如收菜」。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 页面、两种语言的文字、404 页、分享卡片 | 游戏里的首页场景和它的摆放（`app/lib/title/`，[客户端](docs/subsystems/app.md)、[农场的皮](docs/subsystems/farm.md)） |
| 构建时压缩图片、裁像素字、画分享卡片 | 图本身：生图、切图（`design/`），原图在 `app/assets` |
| 页面上农场数字的抄本（`facts.ts`） | 这些数的真值：农机、帮工的样子、地数、成就、小游戏、连接器（服务端 `protocol`、`app/lib/phone`） |
| 发布到 Cloudflare | 截图怎么拍（`app/tool/screens/live_screens_test.dart`，截图在 `docs/images/`，README 也用） |
| | 演讲稿（`site/talks/<场>/`，讲完挪进 `public/talks/` 原样发布，约定在 [site/README.md](site/README.md#演讲稿)） |

## 在哪

- **命令**：根目录 `bun run site:check`（`prepare.ts` 再 `astro check`）、`bun run site:build`（`prepare.ts` 再 `astro build` 到 `site/dist/`）、`bun run site:deploy`（构建再 `wrangler deploy`）。包约定和命令在 [site/README.md](site/README.md)。
- **配置**：`site/astro.config.mjs`（`site`、i18n 的 `zh`/`en` 且中文不带前缀、sitemap、Tailwind 的 Vite 插件、`assetsInlineLimit: 0` 让每张像素图是自己的文件）；`site/wrangler.jsonc`（Worker、自定义域名、`not_found_handling: 404-page`、关掉 workers.dev 和预览地址）；`site/public/_headers`（`/_astro/*` 一年 immutable 缓存）。
- **页面**：`src/pages/index.astro`、`en/index.astro` 都用 `src/components/Home.astro` 拼；`src/layouts/Base.astro` 是头（标题、描述、`og:image`、hreflang、预加载）；`src/pages/404.astro` 两种语言并排、`noindex`。
- **island**（`src/components/*.tsx`）：`Bar` 顶栏、`Hero` 首页场景、`Parade` 帮工上工、`Harvest` 金色的收菜横幅、`How` 跟着滚动的故事、`Features` 数字和卡片、`Devices` Mac 和手机、`Screens` 截图、`Start` 怎么开始；`Foot.astro` 不带脚本。共用的 `useScrollLinked`、`useOffScreen`、`useReveal`、`CountUp`、`STILL` 在 `ui.tsx`。
- **数据**：`src/lib/scene.ts`（首页场景的摆放，`SHOWN` 是页面用到的贴图）、`story.ts`（「怎么玩」的地方和时机）、`images.ts`（大图的压缩副本）、`assets.ts`（小像素图、走路的帮工、农机 logo）、`facts.ts`（农场数字和出处）、`links.ts`（仓库地址和构建命令）。
- **文字**：`src/i18n/zh.ts` 和 `en.ts`，`Copy = typeof zh`，`en: Copy` 让类型查两边对齐。
- **主题**：`src/styles/global.css` 的 `@theme`（颜色、字体、没有模糊的硬阴影、场景的动法）、按 `<html data-scene>` 的变体 `morning:`/`day:`/`evening:`/`night:`、`@utility panel`（游戏的面板）、`lit-sky`/`lit-ground`/`lit-smoke`/`lit-farmer`（照时辰调光）。
- **构建前**：`site/scripts/prepare.ts`、`card.ts`，产物在 `site/public/gen/`（`.gitignore`）。

## 模型和不变量

- **没有脚本时完整**：每个 island 构建时就渲染成 HTML。进场（`useReveal`）只藏脚本醒来时还在屏幕下面的部分，所以没有脚本、或屏幕上的部分都不会闪。「怎么玩」构建时就是故事本身停在第一步，按全高渲染，醒来时页面不变高、导航跳到下面的段落不被推走；没有脚本时 `<noscript>` 给长好的田、合回 main 的分支和四张卡片。
- **减少动画时完整**（`prefers-reduced-motion`，`ui.tsx` 的 `STILL`）：CSS 动画停在原处（`animation-play-state: paused`）；`useScrollLinked` 不挂（只有不动位置的淡入淡出带 `still: true` 照挂）；指针视差为零；进场和数字往上数都不做；「怎么玩」不走路，一步一步跳；时辰按钮直接跳不平滑滚。
- **只动 `transform` 和 `opacity`**：横穿场景的 CSS 动画只动 `translate`（距离用 `cqw`、`cqh`），不动 `left`、`top`；跟着滚动的全用 Motion 的 `scroll()`。都留在合成线程上。
- **出了屏幕就停**：`useOffScreen` 用 `IntersectionObserver` 给整段标 `data-off`，`global.css` 让它和里面的动画都停。
- **不另存游戏的图**：场景、图标、帮工的帧、地块、农机 logo 从 `app/assets/` import，截图从 `docs/images/` import，构建时复制成带 hash 的文件。图的地址在 `Home.astro` 里算好传给 island，island 的脚本里没有图的清单。
- **只压官网的副本**（`images.ts`，Astro 的图片服务 + sharp）：首页四张背景转 WebP（quality 82），场景贴图转 WebP（quality 90），尺寸不变；截图转 480、720、1080 和原宽的 WebP（quality 80），配 `srcset`；分享卡片是 JPEG。小像素图（`assets.ts`）原样发 PNG。`app/assets` 的原图不动。
- **导入了就要做副本**：`images.ts` 的 glob 只列页面用到的贴图，`SHOWN` 必须都在里面，缺了 `titleArt` 抛错、构建失败；导入了却没做副本的原图会留在构建里。不读导入的图的属性（连 `width` 也不行），读了 Astro 就把原图也发出去；尺寸从 `.clone` 读。
- **Tailwind 只认完整的类名**：按时辰变的类写成完整的字符串表（`Hero.tsx` 的 `AT`、`PRESSED`），不拼。
- **每个时辰的滤镜写成同样几项、同样顺序**，`lit-*` 的 `transition: filter 0.9s` 才能渐变。
- **农场数字是真数**：4 台农机、28 种帮工、6 块地、21 个成就、5 个小游戏、3 个聊天软件，`facts.ts` 每个注明出处；不放使用量这类没有来源的数。
- **诗句押韵**：`hero.verses` 每个时辰两句，中文五言押「菜」的 -ai 韵，英文两两押韵；`harvest.title` 接着押。改一句其余跟着看。写作规范（[writing.md](docs/style/writing.md)）不管宣传文案和诗句。
- **开场固定是清晨**：`Base.astro` 的 `<html data-scene="morning">`，每个访客都走一遍这一天，不按访客的钟点挑。

## 怎么走

**构建**：

1. `prepare.ts` 把 `src/**/*.{astro,ts,tsx,css}` 里出现的字加上全部可打印 ASCII，从 `app/assets/fonts/fusion-pixel-12px-proportional-zh_hans.otf`（5 MB）裁成 `public/gen/pixel.woff2`（十几 KB）；复制字体授权 `fusion-pixel-OFL.txt`、应用图标（`app/macos/.../AppIcon.appiconset` 的 32、64、256）；每种语言画一张 `card-<lang>.jpg`。
2. `card.ts` 画分享卡片：`app/assets/pixel/title-evening.jpg` 裁成 1200×630，左边一层渐暗，上面是 `hero` 的名字、别名、标语、介绍和 `vibevalley.dev`。字是像素字的字形经 opentype.js 转成的 SVG 路径，不靠系统字体（sharp 自己的文字走 fontconfig，认不到给它的字体文件）；字号是 12 的倍数，像素落在整像素上。
3. `astro check`（或 `astro build`）：三页生成到 `site/dist/`，站点地图里没有 404 页。

**一次访问**：

1. `Base.astro` 先预加载像素字和清晨的背景（`fetchpriority="high"`）。
2. `Home.astro` 里的一段内联脚本在 island 醒来前就给当前时辰的背景和管家的姿势填上 `src`；场景的云、炊烟、萤火虫、花草、蒲公英的种子、帮工走路都是 CSS，不等脚本就在、就动。
3. `Bar`、`Hero` 用 `client:idle` 接管；下面几段用 `client:visible`（`rootMargin: 400px`）快滚到时才接管。页面一动，`Hero` 再加载另外三个时辰的图；首页以下的图 `loading="lazy"`。

**首页**（`Hero.tsx`，两屏高）：

- 第一屏的滚动里场景钉在屏幕上走完一天：白天、傍晚、夜里的背景按 `COMES` 依次淡入叠在清晨上（往回滚褪掉），光和姿势在每段淡入的一半换（`TURNS`，0.22、0.5、0.78），每个时辰一句诗（`SAYS`），镜头慢慢推近，开场的字到 0.22 淡完。右下的时辰按钮把页面滚到那句话的位置（`POINTS`）。
- 第二屏整个场景滚走，各层分开，越远越慢。
- 视差靠各层的快慢，不切画：画还是一整张，走页面一半的速度；云更慢；底下的花草更快；最前面一层是游戏里给村子镶边的树枝和灌木，比页面还快；管家和狗跟画同一层；文字比页面快并淡出。近的层只越过远的层往上走，层边不露出后面。各层还跟着鼠标偏一点，带弹簧（`useSpring`，stiffness 50、damping 18），只认鼠标。

**下面几段**：`Parade` 帮工走过一排地（CSS），`Harvest` 是第二天清早的金色横幅「一觉醒过来，满园都是菜」，里面是「怎么玩」那件活的收成单；`How` 这一段停在屏幕上，镜头沿田横着走，帮工在四个地方各干一步（看工单、播种、敲锤子冒工具图标、收获冒金币和完成章），田下面画它的 git 分支（分出来、提交、合回 main，计数往上跳）；`Features` 数字一格一格往上数、卡片一张张进场；`Devices` 是 Mac 上的农场和两部手机（田头、工单），手机版要自己构建、院门只在信得过的网络里开，照实写；`Screens` 点开截图从原处放大，焦点到关闭按钮，Esc、关闭按钮、点外面都能关，关后焦点回原处；`Start` 先给一条警告，再是构建命令和复制按钮。

**发布**：主人在本机用握着域名的账号 `bunx wrangler login`，再 `bun run site:deploy`；Cloudflare 自己加解析和证书。乱写的地址给 `404.html` 和 404 状态，`_headers` 不对外。

## 和谁打交道

- **`app/assets`**：`title/` 的场景贴图和 `title/sprites.json`（`scene.ts` 读尺寸）、`pixel/` 的背景、图标、帮工的帧、地块和 `pixel/sprites.json`（`assets.ts` 读尺寸和站点）、`fonts/` 的像素字；`app/macos` 的应用图标。改了文件名，官网构建报错（`no picture`、`no sprite`）。
- **游戏的首页**（`app/lib/title/`）：官网的 `scene.ts` 和 `global.css` 的动法是同一套摆放的另一份，两边都照当初网页版首页的 CSS 搬来；改了一边，另一边跟着改。
- **`docs/images`**：截图，README 和官网共用，界面变了用 `live_screens_test.dart` 重拍。
- **游戏代码里的数**：`facts.ts` 抄 `protocol/shapes.go`（样子、连接器）、`MaxRunning`（`protocol/shapes.go`）、`protocol/seeds.json` 的成就、`app/lib/phone/screens.dart`（小游戏）、[agents-and-runtimes.md](docs/reference/agents-and-runtimes.md)（农机）；那边变了要手改这里。
- **Cloudflare**：DNS 和 Worker；没有按分支的预览地址。
- **GitHub**：`links.ts` 的仓库地址，仓库公开以前打不开。

## 为什么这样

- **放在仓库的 `site/`，不单独开仓库。** 单独的仓库发版方便，但要另存一份图和字，游戏改了画面官网不跟着变。
- **Astro 静态生成，不用 Flutter Web，也不做每次请求的 SSR。** Flutter Web 画面完全一样，但包大、首屏慢，字是画出来的，搜索引擎读不到。SSR（Astro 的 SSR 或 Next.js）给出的 HTML 和构建时一样，多出来的只有按请求变的东西（按 IP 挑时辰、实时 star 数），这一页用不上，代价是每次访问跑一次服务端；Next.js 还要经 OpenNext 才能上 Cloudflare。真有要按请求变的页，Astro 能单给那一页开。
- **会动的部分是 island，不是整页一个 React 应用。** 整页 React 没有脚本时什么也没有，首屏要等脚本；island 只让会动的部分带脚本。
- **样式用 Tailwind，不手写 CSS。** 手写的那版一千多行，类名和样式两处来回找；Tailwind 把游戏的主题收在 `@theme` 一处，组件上一眼看出样子。
- **一直在动的留给 CSS，跟着页面动的交给 Motion。** 云、炊烟、走路不靠脚本，没有脚本也动。放弃了原生脚本（几 KB）、GSAP、Lenis：主人要 React，Motion 现成有带弹簧的值、跟着滚动的值、从原处长出来的放大。代价是脚本约 130 KB（gzip，React 和 Motion 占大头），图仍是页面的大头。
- **跟着滚动的用 Motion 的 `scroll()`，不用 GSAP ScrollTrigger，也不自己写 `animation-timeline`。** 浏览器有滚动时间线时 Motion 把动画挂在原生的 scroll 或 view timeline 上，在合成线程里跟滚动同步，没有时用脚本跟（Firefox 现在走这条，主线程每帧有一点活）。ScrollTrigger 编排钉住的叙事顺手，但也是主线程每帧读滚动再挪元素，比合成器的滚动晚一帧，还多一套写法。自己写 `animation-timeline` 在不支持的浏览器要另写一份脚本。测过：改成 `translate` 和 `scroll()` 以后，静止时每秒排版从 60 次到约 0、重绘从约 650 次到约 3；整页滚动 11 秒重绘从 7516 次到 915 次。
- **视差靠各层快慢和游戏自己的前景，不把画按远近切层。** 切层要给四个时辰的画各切一遍：用颜色变化加动态规划找天际线，四张画有的切在山脊、有的跑到山谷的树上；切歪的地方一错开就把风车、灯塔撕成两半；被挡住的地方还要补画。
- **卖点先讲「写代码，如收菜」这种日子，功能放后面。** 地块就是分支、收菜就是合并，田下面画 git 分支比字说得清楚。手机上的农场画面还小，不拿来展示，只展示手机上的田头和工单。
- **压成 WebP，不压 AVIF。** AVIF 再小三成，但放大更糊、手机解码更慢；WebP 在这些图上看不出差别。测过：构建出的图从 8.5 MB 到 3.4 MB，一次访问下载从 4–5 MB 到 1.1–1.3 MB。
- **像素字构建前裁剪，不整个发。** 整个 5 MB，首屏太慢；裁完十几 KB。加了字要重新裁，所以 `check` 和 `build` 前自动跑。
- **分享卡片构建时画，字转成路径。** 改了 `hero` 的字图跟着变；不依赖构建机器装了什么字体。
- **Cloudflare 上一个只有静态文件的 Worker，不用 Pages 或 GitHub Pages。** Pages 的自定义域名要在面板里点，Cloudflare 也把新项目引向 Workers 的静态资源；Worker 的配置写进仓库，一条命令发布。GitHub Pages 在仓库公开以前用不了，域名的 DNS 也本来就在 Cloudflare。
- **不开 `astro dev` 当检查。** `check` 再 `build`；要看样子，用静态服务器打开 `site/dist/`。

## 怎么验证

官网没有单元测试。

- `bun run site:check`：`astro check` 没有错误（含两份字典的类型对齐）。
- `bun run site:build`：三页生成到 `site/dist/`；`SHOWN` 缺了导入、贴图改了名都在这里报错。
- 改了画面或动画，用无头 Chrome 在 1440 宽和 390 宽、开着和关着减少动画截图看：首页四个时辰和两屏的几个滚动位置、「怎么玩」的几个位置、截图放大后的焦点和 Esc；控制台没有报错和 hydration 报错。没有对应的验证 skill。
- 发布后看 `/`、`/en/`、一个乱写的地址给 404，`/_headers` 打不开，带 hash 的文件一年缓存，图是 WebP。

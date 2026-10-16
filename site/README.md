# site

官网 vibevalley.dev：一页静态网页，中文在 `/`，英文在 `/en/`，地址不对时给 404 页。用 [Astro](https://astro.build) 生成，样式是 [Tailwind](https://tailwindcss.com)，会动的部分是 React 组件（Astro 的 island），动画用 [Motion](https://motion.dev)。Bun 管依赖和命令。

```bash
cd site
bun install
bun run check     # 先准备素材（下面），再 astro check：类型和模板
bun run build     # 先准备素材，再生成到 dist/
bun run deploy    # 构建，再发到 Cloudflare（下面）
```

不开 `astro dev`：改完跑 `check` 和 `build`，要看样子就用随便一个静态服务器打开 `dist/`。

## 页面怎么拼

- `src/pages/` 是三页：`index.astro`（中文）、`en/index.astro`（英文）、`404.astro`。两种语言都由 `components/Home.astro` 拼成，从上到下：
  - 顶栏；
  - 首页的场景（两屏）；
  - 田埂（帮工上工）；
  - 「写代码，如收菜」的横幅（`Harvest.tsx`）；
  - 「怎么玩」的故事；
  - 「能做什么」；
  - 「在哪都能看农场」（`Devices.tsx`：一台 Mac 和两部手机）；
  - 截图；
  - 「开始种地」；
  - 页脚。
- 顶栏和各段是 React 组件（`components/*.tsx`），在 `Home.astro` 里作为 island 放进页面：构建时和别的部分一样渲染成 HTML，没有脚本也都在；浏览器里，顶栏和首页的场景马上接管，下面几段快滚到时（`client:visible`，提前 400px）才接管。图的地址由 `Home.astro` 算好传进去，island 的脚本里不带图的清单。页脚是静态的 `Foot.astro`。
- 各段共用的在 `components/ui.tsx`：游戏的按钮（`PixelLink`）、带标题的一段（`Section`）、滚到时进场（`useReveal`）。

## 样式

Tailwind v4，经 Vite 插件接进 Astro。游戏的主题都在 `src/styles/global.css` 的 `@theme`：奶油纸、树皮色、叶绿、麦黄这些颜色，像素字和正文字体，没有模糊的硬阴影（`shadow-hard`、`inset-shadow-lit`、`text-shadow-ink`），首页场景的动法（`animate-cloud`、`animate-puff`……）。另有几个自定的：

- `panel`：游戏的面板（奶油纸、树皮色边、内侧一圈亮边、硬阴影）；`pixelated`：像素画放大不糊。
- `morning:`、`day:`、`evening:`、`night:`：按 `<html data-scene>` 的时辰。每个时辰的背景、管家的姿势、萤火虫只在自己的时辰显出来。
- `lit-sky`、`lit-ground`、`lit-smoke`、`lit-farmer`：叠在背景上的云、花草、炊烟、管家照时辰的光调色。每个时辰的滤镜写成同样的几项、同样的顺序，换时辰时光是渐变过去的。

## 素材从哪来

网页不另存一份游戏的图：

- 首页的场景（清晨、白天、傍晚、夜里四张背景，云、炊烟、花草、蒲公英的种子、萤火虫、管家和狗）照游戏的首页画（`app/lib/shell/title/`），图从 `app/assets/title/` 和 `app/assets/pixel/title-*.jpg` 直接引用，摆放的数在 `src/lib/scene.ts`。
- 图标、帮工的帧、地块、农机的 logo 在 `app/assets/pixel/`（`src/lib/assets.ts`）；截图在 `docs/images/`。截图用 `app/tool/screens/live_screens_test.dart` 拍：电脑的 1440×900，手机的（`phone-chat.png`、`phone-tickets.png`）用 `VIBEVALLEY_SCREEN=390x844`。
- **大图在构建时压缩，只压官网的副本**（`src/lib/images.ts`，Astro 的图片服务，sharp）：
  - 首页的四张背景和场景贴图转成 WebP，尺寸不变，放大对比看不出差别，体积是原图的五分之一到一半；
  - 截图转成 WebP，出 480、720、1080 和原宽几种宽度，浏览器按屏幕挑；
  - 分享卡片还用原来的 JPEG。

  `app/assets` 和 `docs/images` 里的原图不动，游戏用的仍是高清原图。
  - 只导入页面用到的贴图（`images.ts` 里的清单要包含 `scene.ts` 的 `SHOWN`，缺了构建会报错）：Astro 会删掉做过副本的原图，导入了却没做副本的原图会留在 `dist/`。
  - 别读导入的图的属性（连 `width` 也不行）：Astro 会当成用到了原图，把原图也发出去。尺寸从 `.clone` 上读。
- 小图标、帮工的帧、地块只有几 KB，保持 PNG，像素不变形。
- 首页开场的清晨那张背景最大，`Base.astro` 的 head 里预加载它；后面三个时辰的等页面一动再加载，首页以下的图滚近了才加载。
- 像素字（Fusion Pixel，SIL OFL）太大（5 MB），`scripts/prepare.ts` 在 check 和 build 前把它裁成网页用到的字（扫一遍 `src/` 里的字），连同应用的图标和字体的授权写进 `public/gen/`（不进 git）。

## 怎么动

- **一直在动的**：云、炊烟、萤火虫、管家喘气、花草摇、种子飞、帮工沿田埂走，都是 CSS 动画（主题里的 `animate-*`），不靠脚本。横穿场景的只动 `translate`，不动 `left`、`top`，交给合成器做，每帧不重新排版、重绘；距离用场景的份数（`cqw`、`cqh`：场景和田埂都是 container）。整段滚出屏幕时，它的动画先停（`data-off`）。
- **跟着页面动的**：Motion 的 `scroll()` 管（`ui.tsx` 的 `useScrollLinked`），只动 `transform` 和 `opacity`。浏览器有滚动时间线时（Chrome、Safari 26），Motion 把动画挂在原生的 scroll 或 view timeline 上，在合成线程里跟滚动同步，主线程不干活；没有时（Firefox）Motion 用脚本跟。
  - 首页占两屏：第一屏的滚动里，场景钉在屏幕上，走完一天，从清晨到夜里（`Hero.tsx`）：
    - 白天、傍晚、夜里的背景按滚到的位置一层层叠上去，往回滚又褪掉。这是渐变不是移动，要求减少动画时也照样跟着滚动。
    - 光、管家的姿势、狗、萤火虫、提灯在每层背景淡入到一半时换。
    - 镜头同时慢慢推近，越近的层推得越多，四角的枝叶被推出画面。
    - 每个时辰一句话（`i18n` 的 `hero.verses`）：开场是名字、「写代码，如收菜。」和清晨那句，滚到白天、傍晚、夜里各换一句，夜里那句留到场景滚走。

    第二屏里，整个场景往上滚走。场景后面的金色横幅是第二天清早，满园都是菜。
  - 这几句是卖点，要押韵：中文都押「菜」的 -ai 韵，五言两句；英文两两押韵。改一句，其他几句跟着看一遍。
  - 场景滚走时，视差按远近分层，越远越慢：
    - 云最慢；
    - 农场的画连同炊烟、萤火虫、管家和狗，走页面一半的速度（管家和狗跟着画走，不在地上打滑）；
    - 底下的花草快些；
    - 最前面是游戏里给村子画面镶边的树枝和灌木（`fg-*`），比页面还快；
    - 名字和介绍往上走得比页面快，边走边淡出。

    近的层只会越过远的层往上走，所以层的边上不会露出后面。指针一动，各层反着错开，越近错得越多，带弹簧。
  - 田埂的地块和花草、截图跟着滚动左右或上下错开。
  - 「怎么玩」是一段跟着滚动讲的故事（`components/How.tsx`，地方、动作和时机都在 `lib/story.ts`）。往下滚时这一段停在屏幕上，镜头沿一条田横着走：天、远山、远处的农机慢，田正常，前景的草快。帮工走到四个地方，各干一步：
    - 在工单看板前看工单（说话、思考的气泡）；
    - 在播种机旁拿草叉播种；
    - 在蓝图桌前敲锤子，头上依次冒出读文件、搜索、改文件、跑测试、打勾，旁边的地长叶、开花；
    - 在麦子前举手欢呼，抛出金币、盖上「完成」章。

    每个地方一块地，是这件活走到这一步的样子。田下面是这件活的 git 分支：派活时从 main 分出 `vibevalley/w3-…`（帮工的分支就是这样起名的），干活时提交一个个冒出来，提交数、加减行数、测试数往上跳，收获时合回 main。再下面的说明跟着换到当前这一步。往回滚就倒着演。

    页面构建时就是这个故事本身（停在第一步、一样高），醒来时页面不变高，所以点导航跳到下面的段落不会被推走。要求减少动画时，帮工不走路，滚到哪一步就站在哪一步；没有脚本时，`<noscript>` 里是长好的一条田、合好的分支和四张卡片。
  - 金色横幅里的收成单和故事是同一件活（`lib/story.ts` 的 `JOB`：3 个提交、4 个文件、+142 −12、18 个测试），数字滚到时往上数（`ui.tsx` 的 `CountUp`）。
  - 「能做什么」上面一排农场的数字（4 台农机、28 种帮工……），也往上数。数字在 `lib/facts.ts`，每个都注明它在游戏代码里的出处；游戏里的变了，这里跟着改。
  - 各段的标题和卡片滚到时一格一格地进场。
- **点和悬停**：
  - 换时辰时，新时辰的背景先加载好，再淡入；旧的垫在下面，等新的进来了才撤，中间不会暗一下。
  - 指针碰到狗，它会抬头跳一下。
  - 卡片悬停时抬一点，图标晃一下。
  - 截图点开放大，图从原处长出来；Esc、关闭按钮或点外面都能关上。
  - 复制按钮的字会换成「复制好了」。
- **减少动画**：系统要求减少动画时，场景停在原处（云在天上，帮工站在田埂上），视差和进场都没有；「怎么玩」那条田直接是长好的样子。
- **时辰**：开场是清晨，滚完第一屏是夜里。右下角的「清晨 / 白天 / 傍晚 / 夜里」把页面滚到那个时辰的那句话。

## 文字

`src/i18n/zh.ts` 是中文，`en.ts` 是英文，形状一样（类型查）。加一段话先加在 `zh.ts`，再补 `en.ts`。

## 发布

网站放在 Cloudflare：一个只有静态文件、没有脚本的 Worker（`wrangler.jsonc`）。vibevalley.dev 的 DNS 在 Cloudflare，自定义域名写在配置里，第一次发布时 Cloudflare 自己加解析和证书。

1. 先登录一次 wrangler，用握着这个域名的 Cloudflare 账号：`bunx wrangler login`。
2. 再跑 `bun run deploy`，或在仓库根目录跑 `bun run site:deploy`。它先构建，再上传 `dist/`。

`public/_headers` 让带 hash 的 `/_astro/*` 在浏览器里一直缓存；`public/robots.txt` 指向站点地图。

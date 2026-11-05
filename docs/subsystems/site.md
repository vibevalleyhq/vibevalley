# 官网

`vibevalley.dev` 是位于 `site/` 的双语（`/` 中文、`/en/` 英文）静态宣传网站，主题为「写代码，如收菜」。网站使用 Astro 静态预渲染 HTML，配 Tailwind CSS 与 React Islands + Motion，部署在 Cloudflare Workers 静态资源上。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 双语落地页、404 页、Open Graph 分享卡片生成与 Cloudflare 部署 | 游戏内首页（Title Screen）的运行时实现（[客户端](docs/subsystems/app.md)） |
| 构建前图片转 WebP、按页面实际用字裁剪 5MB 像素字体、绘制分享卡片 | 原始像素贴图的生成与切分（[工程流程](docs/subsystems/process.md#怎么走)） |
| 展示数据的静态抄本（`site/src/lib/facts.ts`）与出处校验 | 农场内农机、地块、成就与小游戏的真实定义（各自子系统） |

包命令与演讲稿归档约定见 [site/README.md](site/README.md)。

## 在哪

| 位置 | 职责 |
|---|---|
| `site/astro.config.mjs`、`wrangler.jsonc`、`public/_headers` | Astro 构建配置、Cloudflare 部署与响应头 |
| `site/scripts/prepare.ts` | 子集化像素字体到 `public/gen/pixel.woff2` 并复制图标 |
| `site/scripts/card.ts` | 用 `opentype.js` + `sharp` 生成 `card-zh.jpg` / `card-en.jpg` 分享卡片 |
| `site/src/pages/`、`layouts/`、`components/` | 双语页面与 React Islands（`Hero`、`Parade`、`Harvest`、`How`、`Features` 等） |
| `site/src/lib/`、`i18n/zh.ts`、`i18n/en.ts` | 场景数据、图片转换（`images.ts`）、展示数字（`facts.ts`）与类型对齐的双语词典 |

## 模型和不变量

- **无脚本与减少动画（`prefers-reduced-motion`）下内容完整**：
  - 所有 React Island 在构建时静态渲染为完整 HTML，`<noscript>` 提供静态兜底。
  - 开启减少动画时暂停 CSS 循环动画，跳过滚动视差与数字滚动。
- **动画仅驱动合成层属性，离屏自动暂停**：
  - 循环动画与滚动联动仅修改 `transform` 与 `opacity`。
  - `useOffScreen` 通过 `IntersectionObserver` 为离屏区块标记 `data-off`，暂停内部全部动画。
- **复用主应用素材，构建期压缩与字体子集化**：
  - 直接从 `apps/web/public/` 与 `docs/images/` 导入贴图与截图，不重复保存原图。
  - `images.ts` 将图片转为多尺寸 WebP 并校验 `SHOWN` 清单无遗漏；`prepare.ts` 将 5MB 像素字体裁剪为十余 KB 的 `.woff2`。
- **展示数字真实可溯源**：`facts.ts` 中的农机数、动物数、地块数、成就数、小游戏数与连接器数均注明源码出处。

## 怎么走

1. **检查与构建**：运行 `vp run site:check` 或 `vp run site:build`，执行 `prepare.ts` 生成字体子集与分享卡片，再构建到 `site/dist/`。
2. **发布**：运行 `vp run site:deploy`，通过 `wrangler deploy` 发布至 Cloudflare。

## 和谁打交道

- **主应用资源（`apps/web/public`、`docs/images`）**：构建时直接读取贴图、精灵清单、像素字体与截图；若被引用的贴图改名，`site:build` 立即报错。

## 为什么这样

- **同仓独立 `site/` + Astro Islands**：同仓可直接复用最新游戏贴图，避免双仓失步；Astro 静态 HTML 加局部 Islands 兼顾首屏速度、SEO 与滚动动画。
- **构建期用 SVG 路径合成分享卡片并裁剪字体**：`opentype.js` 转 SVG 路径不依赖构建机字体；按实际字符裁剪 `.woff2` 消除 5MB 字体阻塞。

## 怎么验证

- `vp run site:check`、`vp run site:build`：校验双语词典类型对齐、贴图清单完整与静态产物构建。

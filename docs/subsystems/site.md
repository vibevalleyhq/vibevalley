# 官网

`vibevalley.dev` 是 `apps/site/` 中的双语静态网站：`/` 中文、`/en/` 英文、`/404.html` 未找到页面。Vite 与 Solid 2 在构建时生成 HTML，每个文档只接管一次，Cloudflare 只发布静态文件。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 双语落地页、404、分享元信息、站点地图与 Cloudflare 发布 | 应用内的首页场景（[客户端](docs/subsystems/app.md)） |
| 构建时转换 WebP、裁剪像素字体、生成分享图 | 原始贴图的生成与切分（[工程流程](docs/subsystems/process.md#怎么走)） |
| 展示数字与其源码出处 | 农场内的业务与游戏规则（各自子系统） |

包命令、测试入口和演讲稿归档见 [apps/site/README.md](apps/site/README.md)。

## 在哪

| 位置 | 职责 |
|---|---|
| `apps/site/vite.config.ts` | Solid 的公开 SSR/start 入口、StyleX 编译与构建任务 |
| `apps/site/scripts/build.ts`、`prerender.ts` | 构建客户端和临时服务端，调用页面处理函数，写出 HTML 与站点地图 |
| `apps/site/src/Document.tsx`、`App.tsx`、`components/` | 文档、路由选择与页面区块 |
| `apps/site/src/animation/` | 滚动、可见性、进入退出、图片展开和订阅清理 |
| `apps/site/scripts/images.ts`、`prepare.ts`、`card.ts` | 转图、字体子集、图标和分享卡片 |
| `apps/site/src/lib/`、`i18n/` | 场景与叙事规则、展示数字、双语文案和生成的图片清单 |
| `apps/site/wrangler.jsonc`、`public/_headers` | 静态部署与响应头 |

## 模型和不变量

- **一个文档一个接管根**：首屏和下方区块同时接管；可见性只控制动画，不另建延迟接管根。语言切换走完整文档导航，没有客户端路由器。
- **无脚本内容完整**：页面、文案、图片地址、字体和提取的 CSS 在静态产物中。减少动画时暂停 CSS 循环，跳过视差和数字滚动。
- **构建失败不留下半套页面**：三个页面均成功返回 HTML 后，才写入发布目录；错误、重定向、非 HTML 和不完整文档都拒绝。
- **动画资源随组件释放**：监听、观察器、计时器与动画有对应清理；截图对话框约束焦点，退出后恢复原焦点与滚动。
- **只发布客户端目录**：`dist/server/` 用于构建时生成页面，部署只取 `dist/client/`，线上不运行 Node 渲染器。
- **素材有一个来源**：从 `apps/web/public/` 和 `docs/images/` 读取原图，构建 WebP 副本和多尺寸截图；生成清单不手改。
- **展示数字可溯源**：`facts.ts` 中的数字注明游戏代码的出处。

## 怎么走

1. `prepare.ts` 调图片转换、字体裁剪和分享图生成。
2. Vite 编译同一份 Solid 文档与页面，输出客户端资源和构建用的服务端处理函数。
3. `prerender.ts` 请求三条路由，验证全部响应，再写静态 HTML；`build.ts` 补站点地图。
4. `wrangler` 只发布客户端目录；不存在的地址返回 404 页面和 404 状态。

## 和谁打交道

- **主应用素材**：只读 `apps/web/public/` 的贴图、精灵清单和字体，以及 `docs/images/` 的截图。缺少输入就使构建失败。
- **根工具链**：官网与应用、库共用 workspace、catalog、锁文件和类型检查，不另装一套依赖。

## 为什么这样

- **静态生成加单根接管**：保留无脚本内容、SEO 和首屏 CSS，又让 Solid 2 在同一文档中一次性保留服务端节点。屏幕内外不拆接管根，避免后来的根退回客户端重建。
- **使用 Vite 插件的公开入口**：生成器只调用公开的请求处理函数，不改框架的接管全局量，不引入 SolidStart 或私有运行时。
- **构建时转图和裁字**：压缩官网副本而不改原图；分享图的字形转成路径，不依赖构建机字体。

## 怎么验证

`vp check` 查类型、lint 与格式；`site:check` 查素材与静态生成；`site:build` 生成发布产物。正式页面的浏览器测试覆盖无脚本内容与 CSS、节点保留、交互、动画与导航；独立回归页覆盖输入值和条件子树清理。命令与证据路径见[官网 README](apps/site/README.md#测试)。

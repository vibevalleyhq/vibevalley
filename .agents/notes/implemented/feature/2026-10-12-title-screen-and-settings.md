# Agent Note: 首页和设置：开始、继续、设置；钥匙存在 settings.json

Status: implemented

## Problem

打开 VibeValley 就直接落在农场里，像一个工具而不像一个游戏，也没有一个地方说清楚「要开始玩，先要什么」。管家要 DeepSeek 的 API Key，语音要 Agora 的 App ID 和 Certificate，以前只能写进 `apps/server/.env`（或桌面客户端的 `$VIBEVALLEY_HOME/.env`）再重启：装好桌面客户端的人不会知道要去改一个隐藏的文件。没钥匙时管家只在田头上说「起不来」，而且这个失败会被缓存住，补上钥匙也要重启才好。

## Decision

客户端先开首页（`app/lib/shell/title/`），三项：开始游戏、继续游戏、设置。后来改成首页只在这台设备第一次打开时出来，进过一次农场以后再打开直接进农场（`vibevalley.title.seen`），游戏菜单的「回到首页」能回去：天天用的人每次开应用都要先点一下「继续游戏」，点开一条通知也被首页挡着、要多点一次才看到那件事；首页留给第一次来的人认识这座农场。行为见 [framework.md](../../../../docs/framework.md)「首页」和 [server.md](../../../../docs/server.md)「设置」。

- **开始和继续的分别**：开始游戏 = 进农场并开工；继续游戏 = 回到农场原样，只在有农场可回时能点。不做「新游戏」清档：农场的数据是主人的田头、账本和帮工的分支，一个按钮清掉代价太大。
- **钥匙存在 `$VIBEVALLEY_HOME/settings.json`**，0600，由服务端读写；页面只看到每把钥匙从哪来和最后四个字。设置里的 > 环境变量 > pi 的配置：主人在游戏里最后填的那把最该算数，`.env` 照旧能用。
- **现取，不重启**：管家（经 agent-core 照 pi 新加的 `getApiKey`，Go 里是 `agentcore` 的 `GetApiKey`，每次请求前取）、用 VibeValley 自己的 agent 的帮工（每个会话开始时读文件）、语音（每次签令牌、请语音管家时取）都现取钥匙。管家起不来不再被缓存住，下一句话再试。
- **开始游戏先查钥匙**：管家没有任何 DeepSeek 钥匙时，开始游戏先打开设置，说明要填什么，而不是让主人进去以后在田头上看一句报错。
- **背景**照像素村的素材流程：`design/pixel/gen.sh title` 让 codex 参照村子的地图和管家画，左边三分之一留给菜单。后来主人说首页太静：加了早晨、白天、夜晚三张（拿黄昏那张当参照，构图不变，只换钟点），按真实钟点换；加了缓慢推移、萤火虫、菜单滑入。再后来让 codex 单独画了云、烟、蒲公英和前景草丛，叠在底图上动（不让它把整张图拆成几层：重画的几层对不齐，接缝会露）；底图四张构图一样，烟囱口在同一个像素，叠层用底图的像素坐标摆。底图原来画着一缕静止的炊烟，和动的叠在一起成了两缕：程序抠掉会把天空抹花，改让 codex 照原图各重画一张只去掉炊烟的，差异很小（整张图平均差不到 6），就用它们当底图。管家和狗也这样从底图里拿出来（`-empty`），画成单独的几帧叠回原位：这样宠物能换（狗、重点色布偶猫、蓝猫，农场门口的也一起换），人和宠物也能动。
- **进度条只在启动时**：首页一出来就该是菜单（主人说选开始游戏的地方不要进度条），所以加载挪到启动：客户端自己画启动画面（`app/lib/shell/title/startup.dart`），桌面版也是。进度按真实的步骤走（开始游戏要知道有没有钥匙、继续游戏要知道有没有农场）。当时浏览器里是启动画面，Electron 桌面版接在开门图起服务端那一段后面，那一段时长说不准，用爬升的进度；现在桌面版在画第一帧之前就把服务端拉起来（`app/lib/desktop/launcher.dart`），没有这一段了。

## Alternatives considered

**钥匙存在浏览器里，由页面带给服务端。** 页面每次都要带，桌面客户端和浏览器各一份，钥匙还会经过页面的 JS。服务端本来就是持有钥匙的一方，存在它的家目录里。

**写回 `.env`。** 那是给人手写的文件，程序改它要保留注释和顺序；另一个文件更干净，也能单独设权限。

**保存时改 `process.env`。** Effect 的 `ConfigProvider.fromEnv` 在第一次用时拷下环境，之后改 `process.env` 它看不到，各处读钥匙的时机也不同；显式的 `Settings` 服务让每个用钥匙的地方都清楚地现取。

**保存时调一次 DeepSeek、Agora 验证钥匙。** 要花一次请求，Agora 的 Certificate 也没有便宜的验证方式；现在只挡明显不对的格式，用时出错照旧会说明白。

## Consequences

- agent-core 多了 `getApiKey`（和 pi-agent-core 同名同义），agent 和压缩摘要也带上它；现在是 Go 的 `server/pkg/agentcore` 的 `AgentLoopConfig.GetApiKey` 和 `agent` 的 `AgentOptions.GetApiKey`。
- pi 的 `models.json` 里写成 `$DEEPSEEK_API_KEY` 或 `${DEEPSEEK_API_KEY}` 的钥匙现在也认作环境变量名（以前只认不带 `$` 的写法，会把变量名本身当成钥匙）。
- 首页挡在农场前面：截图、调试时要先点「继续游戏」或「开始游戏」（`app/tool/screens/` 的截图工具照「继续游戏」进农场）。后来首页只在这台设备第一次打开时出来，见上。

## Verification

- `server/internal/base/settings_test.go`：存进 `settings.json`、权限 0600、比环境变量优先、页面看不到钥匙本身、空字符串清掉后露出环境变量的、格式不对的不存。
- `server/pkg/agentcore/agentcore_test.go`：`GetApiKey` 每次请求前都问，中途换的钥匙下一次请求就用上。
- `server/pkg/agent/agent_test.go`：pi 钥匙的三种环境变量写法。
- 在临时家目录上起服务端：`GET /api/settings` 报出钥匙的来源和末四位，填错的 App ID 得到 409；当时的网页在 1440 和 390 宽下截图看过首页、设置、开始游戏后的农场。

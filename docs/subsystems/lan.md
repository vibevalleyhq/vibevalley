# 连接到本机

「连接到本机」（`lan.Service`）让手机、另一台 Mac 和这台电脑用同一个农场：服务端在主监听之外另开一个监听，只放主人在本机点过头的设备，每台一把钥匙。主人在工作台「设置」的「连接到本机」页（`/settings/lan`）开关它、添加和移除设备；另一台设备在同一页粘贴配对链接或扫码，用那台电脑的农场。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 「连接到本机」的监听：开、关、重启后保持主人留下的样子 | 主监听（只听 `127.0.0.1`，`base.Config.ServerAddress`，[设置和配置](docs/subsystems/setting.md)） |
| 配对：配对码、设备等主人点头、发钥匙 | 哪些接口给「连接到本机」：`api.go` 的 `//vibevalley:can remote` 定，「连接到本机」只照它放（[能力表](docs/reference/capabilities.md)） |
| 设备：存钥匙的 SHA-256、认钥匙、移除时断开它的连接 | 接口本身怎么答（`internal/handler`，「连接到本机」拿到的是同一个 `apiMux`） |
| 客户端选用哪个农场（`data/farm_choice.dart`） | 语音线路，另一个对外的监听（[语音](docs/subsystems/voice.md)「语音线路」） |
| | 帮工的 `/mcp`（[田头](docs/subsystems/channel.md)），「连接到本机」不放 |

## 在哪

- 服务端 `server/internal/lan/lan.go`：监听、配对、设备、中间件 `guard` 和放行表 `remoteRoutes`。`handler/http.go` 开机前把 `apiMux` 交给 `Lan.API`。
- 表：`lan`（一行，`open`）、`lan_device`（一台设备一行：名字、`key_hash`、`paired_at`、`last_seen`）；查询在 `pkg/db/queries/lan.sql`、`lan_device.sql`。
- 接口：`lan.*`（[capabilities.md](docs/reference/capabilities.md)）。`lan.status`、`lan.update`、`lan.startPairing`、`lan.stopPairing`、`lan.answerPairing`、`lan.deleteDevice` 只有 `owner`；`lan.pair`（`POST /api/v1/lan/pair`）和 `lan.me`（`GET /api/v1/lan/me`）也给 `remote`。形状是 `protocol` 的 `LanStatus`、`LanPairing`、`LanDevice`、`LanPaired`，拒绝是 `LanRefused`（403）。
- 配置：`lan.port`（默认 8790；0 是随便一个）。
- 客户端：`workbench/lan/lan_page.dart`（开关、二维码、点头、设备列表、用别的农场），`workbench/lan/scan_page.dart`（手机扫码，`mobile_scanner`），`data/farm_choice.dart`（`FarmChoice`、`RemoteFarm`、`PairLink`、`pairWith`），macOS 的启动在 `host/desktop.dart`。

## 模型和不变量

- **主监听不动**：服务端只听 `127.0.0.1`。「连接到本机」是第二个监听，在所有网卡上听 `lan.port`，默认关着；开关存在 `lan` 表，开机照它决定开不开。端口被占时状态里写「连接开不起来」，农场照常。
- **只放 `remote` 的**：放行表 `remoteRoutes` 开机时从 `protocol.Endpoints` 和 `protocol.Streams` 里 `Can` 含 `CallerRemote` 的条目建成，按方法和路径匹配；三条流 `/api/v1/state`、`/api/v1/events`、`/api/v1/live` 都放。只有「连接到本机」自己的六个管理接口没有 `remote`：一台设备进了「连接到本机」，也不能开关「连接到本机」、放别的设备进来。不在 `/api/v1/` 下的路径（包括 `/mcp`）答 404。
- **每个请求带钥匙**：`Authorization: Bearer <钥匙>`，只有 `POST /api/v1/lan/pair` 不要。认不出的钥匙答 401，认得但接口不放答 403，都带 `LanRefused` 的一句话。
- **钥匙**：32 字节随机数的 base64url，只在配对成功时给设备一次；数据库只存它的 SHA-256，比对用定长比较。`last_seen` 内存里每个请求都更新，最多一分钟写一次库。
- **配对码**：10 位，`base.Code(10)`，比对时去掉两头空白、转大写。同一时间只有一个配对码、只有一台设备在等；码 2 分钟有效，错 5 次作废；设备带对码来以后再等 2 分钟。主人答了（让进或不让）、过期、设备断开、主人换新码或关「连接到本机」，这个码都作废。
- **配对链接**：`vibevalley://pair?u=<「连接到本机」地址>&c=<码>`。「连接到本机」地址是这台电脑首选网卡（`en*`、`eth*`、`wlan*`、`wl*` 在前）的私有 IPv4 加实际端口；找不到这样的地址时不发码，状态里说「连上 Wi-Fi 或网线再试」。
- **设备名**：空白合成一个空格，最长 40 个字，空的叫「一台设备」；电脑名（`LanStatus.hostName`、`LanPaired.hostName`）是这台电脑的主机名，去掉 `.local`；设备上说「<电脑名> 的农场」。
- **移除当场生效**：`Forget` 删库里的行、取消这台设备正连着的每个请求的 context，状态流随之断开；关「连接到本机」关掉整个监听。经「连接到本机」的请求进来时登记到 `conns`，登记时再查一次设备还在不在，移除和进门同时发生时不会漏掉。
- **能干活，不能改配置**：配对过的设备能派活、带话、在田头说话、验收、收获、定时、看全部状态，也能看设置（钥匙只看到最后四个字）；改配置的只在本机：设置的保存（`setting.save`）、农机设置、帮工档案和技能书的增删改、连接器的账号（登录、验证、登出、绑频道），这些没有 `remote`，设备调了答 403。
- **明文**：「连接到本机」走 HTTP，同一个网络里的人能看到内容、抓到钥匙冒充那台设备，直到主人移除它。页面上提示只在信得过的网络里开。

## 怎么走

**配对**：

1. 主人打开「连接到本机」（`lan.update`），点「添加设备」（`lan.startPairing`）：「连接到本机」没开或找不到地址就拒绝；否则作废旧码、发新码，页面把 `LanPairing.link` 画成二维码。
2. 设备扫码（手机）或粘贴链接（Mac），`PairLink.parse` 只认 `vibevalley://pair`、`u` 是 `http` 地址、`c` 不空的。
3. 设备手上已经有这个农场的钥匙时（`pairWith` 的 `known`，电脑换了地址再扫一次的情形），先拿钥匙去问新地址的 `lan.me`，认就直接用，不用主人再点头。
4. 否则设备带码和自己的名字发 `lan.pair`，请求一直挂着。「连接到本机」关着、码过期、码不对、已有设备在等都当场拒绝。
5. 主人在本机看到「谁在等」（`LanPairing.asking`），点「让它进来」或「不让」（`lan.answerPairing`）。让进：新建设备行、发钥匙，回 `LanPaired`（设备 id、钥匙、电脑名 `hostName`）；不让、2 分钟没答、设备断开：拒绝，码作废。

**用别人的农场**（客户端）：

- 选哪个农场存在 shared_preferences 的 `vibevalley.farm`：`use` 是 `local` 或 `remote`，另存最近一个别的农场（地址、钥匙、电脑名 `hostName`、设备 id），切回本机时它留着，下次能直接切回去。
- 换农场时 `FarmConnection.scopeKey` 变，整个 `ProviderScope` 重建，所有 provider 在新农场上重新开始。
- macOS 版选了别的农场时，`startDesktop` 不拉起自己的服务端；`useLocalFarm` 切回本机时再拉起。已经在跑的本机农场切走以后照常跑。
- 连不上时 `pairWith` 说「两台设备要在同一个网络里，那台电脑要允许连接」。电脑换了地址，设备就连不上，主人在「连接到本机」里再添加一次设备让它扫，钥匙不变。
- 应用退出，农场就停了，用这个农场的设备也连不上。

## 和谁打交道

- **`handler`**：`apiMux` 同时挂在主监听和「连接到本机」上；「连接到本机」的中间件在它前面认设备、查放行表，把设备 id 放进 context（`lan.me` 从这里读）。
- **`protocol`**：`Endpoints`、`Streams` 和 `CallerRemote` 是放行表的唯一来源；`tool/shapegen` 从 `//vibevalley:can` 写出它们和能力表的「连接到本机」一列。
- **`base`**：`lan.port` 从 `base.Config` 来；配对码用 `base.Code`，设备 id 用 `base.NewID`。
- **客户端**：`VibeValleyServer` 带 `key` 时每个请求加 `Bearer`；macOS 外壳按 `FarmChoice` 决定起不起本机服务端（[客户端](docs/subsystems/app.md)）。

## 为什么这样

- **另开一个监听，不把主监听改成 `0.0.0.0` 加一个全局令牌。** 帮工没有权限确认，谁连上服务端谁就能让帮工在这台机器上执行命令。改主监听最省事，可是 `/mcp` 跟着出去，令牌漏了也没法只撤一台设备；单独的监听能把口子收窄到 `remote` 的接口，每台设备一把钥匙也能单独移除。
- **放行照 `//vibevalley:can remote`，不在「连接到本机」里另写一张表。** 加一个接口就要在 `api.go` 写清谁能调，生成的 `Endpoints` 同时喂「连接到本机」和能力表；`TestRemoteMayFollowsCan` 查两边一致。
- **连进来的设备不改配置。** 设备是主人自己的，可手机丢了、明文被旁人抓到钥匙时，能改的越少越好：农机设置能指定命令路径，等于让这台电脑跑任意命令；档案和技能书写进帮工的人设和环境；设置和连接器里是钥匙和账号。干活要的接口照放，配置回到这台电脑上改。
- **一次性配对码加主人点头，不把长期钥匙放进二维码。** 二维码会被截图、被旁边的人拍到；漏出去的码 2 分钟就过期、错 5 次作废，没有主人在本机点头也换不到钥匙。
- **地址变了不做发现。** 放弃了 Bonjour（mDNS）：iOS 要申请权限、要维护广播，家里路由器给的地址通常很久不变；也没在二维码里放多个候选地址。连不上就回那台电脑上重新扫，手上有钥匙的设备不用再点头。
- **明文 HTTP，不做自签证书。** 用二维码带证书指纹能防同一网络里的人偷听，第一版没做；代价写在页面上：只在家里、自己的热点这类网络里开。
- **不分只读和能指挥的设备。** 都是主人自己的设备。要分的话加在设备上，由「连接到本机」的中间件按接口拦。
- **客户端换农场就重建整个 `ProviderScope`。** 每个 provider 都连着一个服务端；逐个切换会有一半在旧农场上，整个重建最不容易错。

## 还没做的

现在没有提案。上面放弃的路（证书指纹、mDNS、只读设备）要做时另写 Note。

## 怎么验证

- `lan/lan_test.go`：`TestLanShutUntilOpened`（没开时连不上）、`TestLanPairedDeviceUsesTheWorkspace`（配对、带钥匙用接口、管理接口经「连接到本机」 403）、`TestLanOwnerRefuses`、`TestLanWrongCodesCallItOff`（错 5 次作废）、`TestLanCodeExpires`、`TestLanForgetEndsTheDevicesStreams`（移除断开状态流）、`TestLanRemembersAcrossRestarts`（开关和设备重启后还在）。
- `lan/lifecycle_test.go`：`TestConcurrentOpenMatchesPersistence`（并发开关后监听和库一致）、`TestTrackingRechecksForgottenDevice`（移除和进门同时发生）。
- `lan/remote_test.go` 的 `TestRemoteMayFollowsCan`：放行表和每个接口的 `can remote` 一致，流都放，不认识的路径不放。
- 客户端 `test/workbench/lan_test.dart`：`PairLink` 的解析、选择重启后还在、`pairWith`（带码换钥匙、旧钥匙在新地址上还认、钥匙被忘了就带码再要）、「连接到本机」页的打开和让设备进来再移除。

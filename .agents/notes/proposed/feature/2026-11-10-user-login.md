# Agent Note: 用户登录，设备各拿一把钥匙

Status: proposed

## Problem

服务端今天只听 `127.0.0.1`，「在这台机器上」就等于「是主人」：桌面版、命令行、本机浏览器都不用登录。手机和别的电脑只能经「连接到本机」进来：一个单独的监听，设备在主人那台机器上被点头批准后拿到一把钥匙（`lan_device`），且只能调接口上声明了 `remote` 的那部分。

要让一个服务端管多台机器（[一个服务端管多台机器](.agents/notes/proposed/architecture/2026-11-10-server-and-machines.md)），服务端就要能放在一台服务器上、从外面访问。那里没有人在屏幕前点头，「在这台机器上」也不再等于「是主人」。需要一个主人能从任何地方证明自己的办法。

主人定了（2026-11-10）：**一个服务端只有一个用户，用户有多台设备**，不做多用户；先做登录，再接着拆服务端。代码里这个人叫 user（主人定：不叫 owner）：今天代码里的 `ownerId`、`ActorKind` 的 `owner`、库里的 `'owner'` 说的是同一个人，一并改叫 user，一个人一个名字；界面上的「主人」由叫法的改动换掉（[概念表](.agents/notes/proposed/process/2026-11-10-vocabulary-of-concepts.md)），不在这里改。

## Proposal

**用户账号：一个，有名字和密码。** 用户定了（2026-11-10）：不再叫人「主人」，界面和提示词称呼他用账号的名字，名字能改（`user.update`，本机或登录来的设备都能改）；没设过名字时泛称「你」。新模块 `user`，表 `user_account`（`user` 是 Postgres 的保留字）至多一行：名字、密码的哈希（scrypt，加盐，`node:crypto`）、设下的时间。没有账号时，从外面来的请求一律拒绝，页面说在服务端那台机器上设密码。密码由本机设：`vibevalley user password`（命令行经本机的接口，本机即这个用户），或本机打开的页面；改密码要旧密码，或在本机上改。

**设备：一张表，两种来路。** `lan_device` 改名 `user_device`（用户的设备），加一列 `came`（`paired`：「连接到本机」点头配对来的；`login`：凭密码登录来的）。每台设备一把钥匙，库里只存钥匙的哈希；页面「设备」一页列出全部，能收回，收回后那台设备的下一个请求就被拒。「连接到本机」照旧，只是它签的钥匙记进这张表。

**登录。** `user.login`：密码和这台设备的名字 → 一把新钥匙，由门写进 HttpOnly 的 Cookie（页面），也在答复里给命令行和桌面壳用（`Authorization: Bearer`）。只有一个用户，名字又是能改的称呼，所以不拿名字登录。密码错了照「连接到本机」配对码的做法限次、锁一会儿。`user.logout` 收回当前这把钥匙。

**哪些请求要钥匙。**
- 从 loopback（`127.0.0.1`、`::1`）进来的照旧是这个用户：桌面版、本机的命令行、本机浏览器不用登录。帮工的命令行和 `/mcp` 另有会话令牌，不变。
- 从别处进来的只经一道门：「连接到本机」那个单独的监听（`lan/lan.ts`）。门口认设备钥匙，再带着设备号转给只听 loopback 的服务端；凭密码登录来的设备是用户本人，能调全部给用户的接口，配对来的设备照旧只能调 `remote` 那部分；`user.get`、`user.login` 不带钥匙也放行，设密码从门进来一律拒绝。
- `/mcp` 不对外：只认 loopback 和（第 4 步以后）机器转来的会话令牌。

**服务端照旧只听本机，对外只有那道门。** 用户定了（2026-11-10）：复用「连接到本机」的门，不让服务端自己按 `listen` 对外；服务端里不用分辨反向代理转来的请求，loopback 的信任不变。门要放到外网时前面要有 TLS（反向代理）：登录的钥匙由门写进 HttpOnly 的 Cookie，代理说是 `https`（`X-Forwarded-Proto`）时带 `Secure`。AGENTS.md 里讲这道门的那条改成：它也放登录来的设备，`/mcp` 永不过门。

**页面。** 从外面打开、没有钥匙时，先到登录页（名字、密码、这台设备叫什么）；设置里「设备」一页合并「连接到本机」的设备列表，标出每台是配对来的还是登录来的，能收回。

一步一个提交：

1. **改名。** 代码里的 owner 改叫 user：`ownerId` 改 `userId`（LSP 重命名），`ActorKind`、频道参与者、记忆的作者等取值里的 `owner` 改 `user`（ast-grep 限定文件，库里的取值和黄金数据跟着改），`stale-names` 拦着旧名字。行为不变。
2. **账号与钥匙（服务端）。** `user_account`、`user_device`（由 `lan_device` 改名）、scrypt；接口 `user.get`、`user.update`、`user.password.set`（本机才能调）、`user.login`、`user.logout`、`user.device.list`、`user.device.delete`；门口按钥匙的来路放行（配对的只放 `remote`，登录的放全部给用户的），登录时写 Cookie；`user.update` 改名字。
3. **页面。** 登录页、设备页合并、设密码。
4. **命令行。** `vibevalley auth login <服务端地址>`，照 `gh auth login`（用户定，2026-11-10）：命令行拿到确认码，用户在已登录的页面上同意，命令行取回钥匙存进家目录，之后的命令带着它。机器加入（服务端管多台机器的第 4 步）用同一套「出码、页面同意、发钥匙」。密码只在本机页面上设，命令行不另设。
5. **文档与规矩。** AGENTS.md、`lan.md`、`setting.md`、`architecture.md`。

## 进度

| 步 | 状态 | 做了什么 |
|---|---|---|
| 1 改名 | 完成 | 代码、表、取值、词典的键、黄金数据里指这个人的 owner 都改叫 user；界面上的「主人」「Owner」不动。别的东西的 owner 照旧：线程归哪个帮工（`threadOwnerOf`）、触发器归哪张工单（`Mailbox.ownerOf`）、块归哪篇稿子、Solid 的响应式 owner、oar 的会话键；EverOS 的 `sender_id` 仍是 `owner`，外面已存的记忆按它归档。`stale-names` 加了一条拦这个人的旧名字（改名前的代码在它查的目录里命中 882 处） |
| 2 账号与钥匙 | 完成 | 新模块 `user`（Platform 组，服务 `User`）：`user_account` 一行存名字和 scrypt 的密码哈希（`scrypt:N:r:p:盐:哈希`，读的时候按它记下的参数算），`lan_device` 改名 `user_device` 加 `came`、`paired_at` 改 `added_at`。接口 `user.get`、`user.update`、`user.password.set`（从门进来一律拒绝，至少 8 个字）、`user.login`（输错 5 次锁 60 秒）、`user.logout`、`user.device.list`、`user.device.delete`。门（`lan.ts`）的钥匙改由 `User.byKey` 认，配对的钥匙由 `User.pair` 签；不带钥匙放 `lan.pair`、`user.login`、`user.get`；登录来的设备放全部，除了设密码；每个转发的请求带 `x-vibevalley-outside`；登录和退出的答复由门整个读完，写或清 HttpOnly 的 Cookie。收回设备走 `User.revoked` 流，门照旧切断它的连接；退出的请求不登记在设备的连接里，否则会把自己切断。Cookie 改名 `vibevalley_device_key`，已配对的手机要重新配对。页面暂时照旧，第 3 步换掉 |
| 3 页面 | 完成 | 门外打开的页面先问 `user.get`（HttpOnly 的 Cookie 页面读不到），没钥匙的设过密码去 `/login`、没设去 `/pair`（`features/user/entry.ts`）。新 feature `user`：登录页、设置「设备」页里的「名字和密码」卡片（本机才有密码框；从设备上来的能退出）和「你的设备」列表（标着配对或登录、这台，能收回，收回这台就回登录或配对页）。没另开设置页：导航的图标一个意思一个，钥匙已给了「账号与钥匙」。去掉被取代的 `lan.device.delete`、`lan.device.previewDelete`、`lan.me.get`、`LanStatus.devices`，手机壳的 e2e 改用 `user.device.*`。`login.spec.ts` 在自己的服务端上走一遍（设了密码，别的文件没配对的设备就会去登录页） |
| 4 命令行 | 完成 | `user.approval.*`：`create`、`collect` 不要钥匙（门放行），`list`、`answer` 要用户的钥匙；请求在 `User` 的内存里，确认码是 `XXXX-XXXX`（没有元音和易混的字母），10 分钟过期、同时至多 5 个，取件凭证只存哈希，设备在取钥匙时才建。页面：`/approve?code=…` 和「设备」页里「等你同意的登录」；门外没钥匙的先去 `/login?next=…`，登录完回原处（`afterSignIn` 只认本站的路径）。命令行：`auth login [服务端]`（先问 `user.get` 的 `here`，本机的不用登录）、`auth status`、`auth logout`；`auth.json`（`0600`）由 `@vibevalley/home` 读写；生成的 `VibeValleyApi` 多了可选的 `key`，`askAt` 和事件流只把钥匙发给登录过的那个服务端。真机上走过：门外 `auth login`、本机同意、带钥匙跑 `issue list`、`auth logout` 后旧钥匙 401 |

## Alternatives considered

- **多用户、注册。** 主人定了只有一个用户；每个用户各自的工单、提及、收件箱、记忆要把一个用户的假设从各处拿掉，等真要团队时另起。账号表已经按「用户」建，那时不用推倒。
- **登录也靠本机点头（照「连接到本机」配对）。** 服务端在服务器上时没人在屏幕前点头；密码是用户不在现场时唯一能用的。
- **账号叫 user，代码里其余地方仍叫 owner。** 同一个人两个名字；改名是机械的，放在第一步。
- **外接身份（GitHub、OAuth）。** 要服务端能被回调、要配应用，一个人用太重；以后可作为另一种来路加进 `user_device.came`。
- **loopback 也要登录。** 桌面版、本机命令行今天开箱即用，本机的进程本来就能读家目录里的一切，要登录挡不住什么。

## Acceptance criteria

- 代码里不再有 `ownerId`、取值 `owner`，`stale-names` 拦着。
- 没有用户账号时，外来请求一律 401/403，本机照旧可用；本机设密码后，外来设备凭密码登录拿到钥匙，之后的请求带着钥匙才通过。
- 错的密码限次并锁一会儿；收回一台设备后它的下一个请求被拒。
- 配对来的设备仍只能调 `remote` 的接口，登录来的设备能调全部给主人的接口；`/mcp` 从外面一律拒绝。
- 「连接到本机」照旧能配对，配对的设备出现在同一张设备表里。
- 服务端测试覆盖每条来路；页面测试覆盖登录页和收回；`server:check`、`web:check` 通过。

## Risks

- **对外即是远程执行。** 用户的钥匙能派活，帮工能在机器上跑任何命令；密码泄露等于机器被控制。限次锁定、只存哈希、Cookie HttpOnly 与 Secure、要求 TLS，文档写清楚。
- **门是唯一的关。** 外来的请求都过门，门放过去的在服务端看来带着设备号；门以外再开对外的口子（比如第 4 步机器的链路），要同样只经门或有自己的钥匙。

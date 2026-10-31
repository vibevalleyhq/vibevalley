// Written by `vpx scripts/i18n.ts gen` from packages/i18n/locales: do not edit.

/** Each language's catalogs by namespace. */
export const catalogs = {
  zh: {
    desktop: {
      open: "打开 VibeValley",
      quit: "退出",
      cannotStart: "VibeValley 起不来",
      seeLog: "{reason}，日志在 {log}",
      noAddress: "服务端 {seconds} 秒内没有发布就绪地址",
      failed: "服务端启动失败：{why}",
      exited: "服务端退出了（{code}）",
      waiting: "{n} 等你",
      working: "{n} 在干",
      idle: "没在干",
      menu: {
        about: "关于 {app}",
        hide: "隐藏 {app}",
        hideOthers: "隐藏其他",
        unhide: "全部显示",
        quit: "退出 {app}",
        edit: "编辑",
        undo: "撤销",
        redo: "重做",
        cut: "剪切",
        copy: "拷贝",
        paste: "粘贴",
        selectAll: "全选",
        view: "显示",
        reload: "重新载入",
        devTools: "开发者工具",
        resetZoom: "实际大小",
        zoomIn: "放大",
        zoomOut: "缩小",
        fullScreen: "进入全屏幕",
        window: "窗口",
        minimize: "最小化",
        zoom: "缩放",
        front: "前置全部窗口",
        close: "关闭窗口",
      },
    },
    mobile: {
      cannotRead: "读不出保存的连接：{why}",
      unreachable: "连不上那台电脑：两台设备要在同一个网络里，那台电脑要允许连接",
      answered: "那台电脑答了 {status}",
      cannotSave: "保存配对失败：{why}",
      cannotRestore: "恢复保存的连接失败：{why}",
      cannotForget: "忘不掉保存的连接：{why}",
      callEnded: "通话已结束",
      noNotify: "没有通知的权限：到系统设置里打开",
      noCamera: "没有相机的权限：到系统设置里打开，或者粘贴链接",
      stopScan: "不扫了",
      title: "连进 VibeValley",
      intro: "在跑 VibeValley 的电脑上打开「设置」的「连接到本机」，点「添加设备」，扫它的二维码。配对要那台电脑上的主人点头。",
      scan: "扫二维码",
      paste: "或者粘贴配对链接",
      name: "这台手机叫",
      waiting: "等那台电脑上的主人点头……",
      ask: "请主人放行",
      cancel: "取消配对",
      agora: "声网：{what}失败（{code}）",
      agoraLost: "声网：连接失败（{reason}）",
      step: { mute: "静音", unmute: "取消静音", renew: "续期", initialize: "初始化", mic: "打开麦克风", volume: "读取音量", join: "加入频道" },
      noMic: "没有麦克风权限",
      android: "安卓手机",
      phone: "一台手机",
    },
    server: {
      lookIn: {
        issue: "列出工单，找它的编号",
        session: "列出帮工，找它的 id",
        project: "列出项目，找它的名字",
        runtime: "列出农机，找它的 id",
        agent: "列出档案，找它的 id",
        skill: "列出技能，找它的 id",
        template: "列出模板，找它的 id",
        cron: "列出定时任务，找它的 id",
        device: "看连着的设备，找它的 id",
        archive: "列出管家的旧账",
        channel: "列出频道，找它的 id",
        graph: "列出计划，找它的 id",
        memories: "列出它的记性，找那一条的 id",
        artifact: "列出产出，找它的 id",
      },
      projectRef: "项目 {id}",
      helperRef: "帮工 {id}",
      archiveRef: "旧账 {name}",
    },
    "server.agent": {
      template: {
        unreadable: "模板读不通：{file}（{why}）",
        noFile: "不是模板：没有 {file}",
        badId: "模板的 id「{id}」不行（{file}）：只能用小写字母、数字和 -，最多 32 个字",
        badVersion: "模板的 version 要是 1 以上的整数（{file}）",
        noRuntime: "帮工的模板要写推荐的农机（{file}）",
        noTemplate: "没有 {id} 这个模板",
        taken: "已经有叫 {id} 的模板了",
        builtIn: "{id} 是内置的模板，删不了",
        notFrom: "「{name}」不是从模板装的",
        gone: "「{name}」的模板 {template} 不在了",
        delete: "删掉模板「{name}」",
        deleteKept: "删掉模板「{name}」：从它装的 {installed} 份档案留着",
      },
      notSaved: "没存下来：{file} 写不进去（{why}）",
      orchestratorStays: "默认管家删不了：至少要有一个管家",
      defaultStaysOrchestrator: "默认管家只能是管家：至少要有一个管家",
      noAgent: "没有 {id} 这个档案",
      noSkill: "没有 {id} 这个技能",
      orchestratorRuntime: "管家只在 VibeValley 自己的 agent 上跑：农机要是 {runtime}",
      newAgentId: "新档案的 id 要留空；指定 id 请用保存",
      newSkillId: "新技能的 id 要留空；指定 id 请用保存",
      removeAgent: "删掉档案「{name}」（{id}，跑在 {runtime} 上）：已经派给它的工单不跟着改",
      removeSkill: "删掉技能「{name}」",
      modelFailed: "模型出错了",
      noDeepSeekKey: "没有 DeepSeek 的密钥：设 DEEPSEEK_API_KEY，或者写进 vibevalley.yaml 的 deepseek.api_key。",
      refused: { launchArgs: "VibeValley 跑在 server 进程里，没有命令行参数", serviceTier: "DeepSeek 没有服务档位" },
      unequip: "从 {holders} 的档案里摘掉它",
      quoted: "「{name}」",
      efforts: "{runtime} 只有 {efforts} 两档思考强度，没有「{asked}」",
      effortsAnd: "、",
    },
    "server.artifact": {
      noTitle: "产出要有个标题",
      longTitle: "标题太长了，最多 {max} 个字",
      badKind: "认不得 {kind} 这种产出，只认 {kinds}",
      empty: "产出是空的",
      tooBig: "一版最多 {mb} MB",
      notKept: "产出没存下来：{why}",
      missing: "没有 {id} 这个产出",
      noVersion: "「{title}」没有第 {version} 版，最新是第 {latest} 版",
      noFile: "「{title}」第 {version} 版的内容不见了",
      made: "做了「{title}」",
      versioned: "「{title}」出了第 {version} 版",
      withNote: "{said}：{note}",
      preview: { remove: "删掉「{title}」和它的 {n} 版", cards: "对话里的卡片还在，点开说已经删掉了", removeBlocks: "删掉「{title}」和它的 {n} 块" },
      untitled: "没起名的产出",
      noBatch: "这批改动没有 batchId",
      demoNotInserted: "演示的块没插进去：{status}",
      noWriter: "没有能写的帮工：先在档案里打开一个",
      demoRunning: "演示正在写，写完再点",
      notApplied: "这一块没写进去",
      op: {
        deleted: "这一块已经删掉了",
        noAttr: "没有属性 {name}",
        noBlock: "没有块 {id}",
        noId: "新块没有 id",
        taken: "块 {id} 已经有了",
        unknownType: "不认识的块类型 {type}",
        badKey: "不是有效的顺序键：{key}",
        missing: "没有这一块",
        noText: "这一块没有字",
        noRev: "没有第 {rev} 版",
        changed: "这一块刚被别人改过",
        underSelf: "不能挪到自己下面",
        splitAtEnd: "这一块刚被别人改过，从末尾拆开了",
        splitOutside: "拆分位置 {at} 不在字里（{length} 个字）",
        intoSelf: "不能并进自己",
      },
      demo: {
        "0": {
          heading: "背景 · 演示",
          paragraphs: {
            "0": "（演示）这一节是脚本写的，不是帮工真的想出来的。我们这里有好几个帮工，以前一篇文章只能一个人从头写到尾，别人只能等着。",
            "1": "现在产出按块存，每一块有自己的版本号。几个帮工各写各的一节，互不抢同一块，谁写的哪一块，左边的归属条一眼就能看出来。",
            "2": "这篇演示就是想让主人亲眼看一下：三个帮工同时动笔，字一段一段长出来，最后拼成一篇完整的文章。",
          },
        },
        "1": {
          heading: "做法 · 演示",
          paragraphs: {
            "0": "（演示）每个帮工先在自己那一节的末尾插一个空段落，然后每隔一秒左右把这一段整段换新，看起来就是一段话在慢慢长长。",
            "1": "所有改动都走和主人一样的 op 管线：插入是 insert_block，长字是 update_text，带着上一版的版本号，服务端按顺序一批一批收下。",
            "2": "如果主人在帮工正写着的那一段里改了字，帮工那一下就会冲突、写不进去；它不抢这一段，接着去写下一段。",
          },
        },
        "2": {
          heading: "下一步 · 演示",
          paragraphs: {
            "0": "（演示）等广播做好以后，页面不用再一秒问一次服务端，帮工写一下，主人这边马上就能看到。",
            "1": "再往后，帮工想改别人那一节的字，不直接改，而是挂一条建议，等主人点头；写完的一节在大纲里标成写完待看。",
            "2": "演示到这里就结束了。这篇产出留着也行，删掉也行，它不会影响任何工单和记性。",
          },
        },
      },
      badBlockType: "块的类型只能是 {types}",
      otherArtifact: "这批改动（{batch}）是另一个产出的",
      notBlocks: "「{title}」是一整页网页，不按块改：交新的一版",
      notHtml: "「{title}」是一起写的，不交新的一版：一块一块改（artifact_block_create、artifact_block_update）",
    },
    "server.base": {
      noFile: "{path}: 没有这个文件",
      notPort: "{path}: {name} 不是端口：{port}",
      prPoll: "github.pr_poll_seconds 必须大于 0",
      homeTaken: "家目录 {home} 正被另一个服务端使用；请连接现有的服务端，或先停掉它",
      homeUnlocked: "锁不住家目录 {home}",
      requestKeyLong: "requestKey 太长（最多 {max} 个字符）",
    },
    "server.channel": {
      name: { owner: "主人", orchestrator: "管家" },
      mention: { orchestrator: "@管家", owner: "@主人", everyone: "@所有人" },
      channelName: "频道名只能是字母、数字、汉字、- 和 _，最多 24 个字",
      channelTaken: "已经有叫 {name} 的频道了",
      hopLimit: "帮工之间已经来回 {limit} 次了，先停一停：等主人说一句再接着叫人。",
      notBack: "帮工还没接回来",
      breaker: "{name} 连续 {failed} 次一叫醒就失败了，先不再叫它；你直接给它带句话会再试。",
      dispatch: {
        step: "做计划 {graph} 的「{task}」",
        split: "拆计划 {graph}",
        draft: "看代码，起草这张工单",
        project: "项目",
        sent: "派 @{id}（{name}）去 {project}：{what}",
        redraft: "这张工单交给 @{id}（{name}）再起草一版",
        handedOn: "这张工单交给 @{id}（{name}）接着做，第 {nth} 次派活",
      },
      badTarget: "不认识这个地方：{target}（写 #<频道>，比如 #general；或 #<频道>:<消息号>）",
      noMessage: "频道里没有 {n} 这条消息",
      empty: "没说什么",
      sendKeyLong: "sendKey 太长",
      channelGone: "找不到这个频道",
      noHelper: "没有 {id} 这个帮工",
      noChannel: "没有 {id} 这个频道",
      notOrchestrator: "{id} 不是管家的档案：频道只能交给管家照看",
      noMessageId: "没有 {id} 这条消息",
      threadOnlyTitle: "串只能改标题",
      defaultStays: "默认频道不能归档、不能删：先把别的频道设成默认",
      deletesChannel: "删掉 {target}，连同它的 {threads} 个串和 {said} 条消息",
      inUse: "删不了：{why}。可以归档它",
      helpersThere: "还有帮工在这个频道里干活",
      cronsThere: "还有 {n} 个定时任务在这里",
      connectorsThere: "接着连接器",
      queuedThere: "还有 {n} 张工单排着队要在这里开工",
      issuesThere: "这里派过 {n} 张工单的活",
      noAttachment: "没有 {id} 这个附件：先上传，再带着它说话",
      messageGone: "这条消息已经删了",
      notYours: "只能改你自己说的话",
      badEmoji: "回应是一个表情或一个短词，不带空格",
      threadOnlyInChannel: "串只开在频道里的消息下面",
      emptyFile: "这个文件是空的",
      deletes: "删掉 {target} 的第 {number} 条（{name}：{text}），号留着",
      deletesDeliveries: "还没交出去的 {n} 份不再送",
      defaultIsChannel: "默认频道只能是一个频道，不能是私聊或串",
      noDirect: "{target}：你和对方之间没有私聊",
      noChannelNamed: "没有叫 #{name} 的频道。有：{tags}",
      absent: "{who} 不在场，没送到",
      fileTooBig: "文件太大了：至多 {mb} MB",
    },
    "server.cli": {
      flag: {
        prompt: "问一句就走，不进对话",
        runtime: "claude、codex、kimi、pi……；vibevalley 是自己的 agent",
        model: "模型",
        effort: "思考的力度",
        resume: "接着这个会话",
        cwd: "在哪个文件夹；不填是当前的",
        ownCwd: "自己的 agent 在哪个文件夹干活；不填是当前的",
        name: "自己的 agent 的名字（家目录 ~/.vibevalley/agent/<名字>）",
        ownModel: "模型；不填用配置里的",
        mcp: "MCP 配置文件；不填用家目录里的 mcp.json",
        server: "服务端的地址；不填用 VIBEVALLEY_SERVER，再没有是这台电脑上开着的那个（家目录的 server.json），都没有是 {fallback}",
        dryRun: "只说会做什么，不动手（会删、会合、会关、会让帮工走的命令）",
        json: "请求体：JSON 文本，- 读标准输入，@文件 读文件",
        watch: "一直看：每一帧一行 JSON",
      },
      command: {
        runtimeChat: "和一个农机直接聊，不经过 VibeValley：不记轨迹和花费",
        root: "不带命令是和 VibeValley 自己的 agent 聊；别的命令是调 VibeValley 的接口，答复是 JSON",
        state: "核心状态（GET {path}）",
        events: "副作用，一行一条（GET {path}）",
        issueWork: "备选的挪到待办，等它交回来，打出改动；经过的每个状态写到 stderr",
        group: "{group} 的接口",
      },
      next: {
        help: "看这条命令怎么写",
        whatItDoes: "看这条命令做什么",
        startServer: "先起服务端（vp run --filter @vibevalley/server start），或用 --server 指到在跑的那个",
      },
      and: "；",
      failure: {
        unreachable: "连不上 {base}：{why}",
        shape: "答复不合 Schema：{why}",
        stdin: "读不了标准输入：{why}",
        file: "读不了 {file}：{why}",
        notJson: "--json 不是 JSON：{why}",
        body: "--json 不合 {op} 的请求体：{why}",
        dryRun: "{op} 会改东西，但没有试跑：去掉 --dry-run 才会做",
        retry: "服务端要流重连，命令行不接着连",
        stream: "流读不下去：{why}",
        gone: "工单 #{n} 不在了：被删掉了",
        missingArgument: "缺 <{name}>：写在命令后面，或放进 --json",
      },
      chat: {
        error: "\n出错了：{why}",
        compacted: "（前面的对话压成了摘要，原文在 {archive}）",
        usage: "{aborted, select, true {（停下了，输入 {input}，缓存 {cached}，输出 {output}）} other {（输入 {input}，缓存 {cached}，输出 {output}）}}",
        hello: "{skills} 个技能，{tools} 个 MCP 工具。/reset 忘掉对话，/exit 退出，Ctrl+C 停下。",
        forgot: "忘掉了。",
        noRuntime: "没有 {id} 这个农机",
        unknownInstall: "{id} 看不出装没装",
        unusable: "{id} 用不了：{kind}",
        resumed: "（接着）",
        direct: "直接聊：不经过 VibeValley，不记轨迹和花费。Ctrl+C 停这一轮，空着时再按退出。",
        rejected: "没接住：{why}",
        notSent: "没送进去：{why}",
      },
    },
    "server.connector": {
      media: { image: "[图片]", file: "[文件]", audio: "[语音]", video: "[视频]", sticker: "[表情]", message: "[消息]", attachment: "[附件]" },
      namedFile: "[文件：{name}]",
      staleLogin: "微信说登录过期了",
      qqKeys: "要填 QQ 机器人的 AppID 和 AppSecret（在 q.qq.com 的机器人管理页里）。",
      unreadSecrets: "存着的登录信息读不出来，断开重新连一次",
      expired: "登录过期了，一小时后再试；也可以断开重新连。",
      paired: "配对好了：以后在这里说的话，就是你在默认频道里说的。",
      stopped: "收消息停了",
      switched: "换了账号",
      disconnected: "断开了",
      noConnector: "没有 {id} 这个连接",
      noChannel: "没有叫 {name} 的频道",
      line: { orchestrator: "管家", dispatch: "派活", thread: "在工单串里", head: "【{who}】", headWhat: "【{who} · {what}】" },
      feishu: {
        register: "飞书注册：{why}",
        registerTimeout: "飞书注册：超时了",
        noQr: "飞书现在不支持扫码建应用，请稍后再试。",
        noLink: "飞书没给二维码，请重试。",
        denied: "在飞书里拒绝了。",
        qrExpired: "二维码过期了。",
        incomplete: "飞书确认了，但没给齐登录信息，请重试。",
        tooLong: "等太久没扫，二维码过期了。",
        disconnected: "飞书长连接断了：{why}",
        send: "飞书发消息：{why}",
        noId: "飞书发消息：没有确认消息编号",
      },
      qq: {
        auth: "QQ 鉴权：{why}",
        authTimeout: "QQ 鉴权：超时了",
        badKeys: "AppID 或 AppSecret 不对",
        gateway: "QQ 网关：{why}",
        noGateway: "QQ 没给网关地址",
        gatewayError: "QQ 网关：连接出错",
        reconnect: "QQ 网关：QQ 让重新连接",
        invalid: "QQ 网关：QQ 说会话无效",
        closed: "QQ 网关：连接关了（{code}）",
        send: "QQ 发消息：{why}",
        unread: "QQ 发消息：读不出发送结果：{why}",
        noId: "QQ 发消息：没有确认消息编号 {why}",
      },
      weixin: {
        noQr: "拿不到登录二维码：{why}",
        qrExpiredTimes: "二维码过期了几次，请重新开始。",
        codeWrongTimes: "数字输错了几次，请重新开始。",
        taken: "这个微信已经连过了：先在微信里删掉它，或者换一个微信扫。",
        incomplete: "微信确认了，但没给齐登录信息，请重试。",
        tooLong: "等太久没扫，二维码过期了。",
      },
      digest: "你不在的时候有 {n} 条消息：\n{lines}\n\n完整的在默认频道里。",
    },
    "server.cron": {
      weekdays: { "0": "日", "1": "一", "2": "二", "3": "三", "4": "四", "5": "五", "6": "六" },
      when: {
        once: "{clock} 一次",
        hours: "每 {n} 小时",
        minutes: "每 {n} 分钟",
        daily: "每天 {time}",
        weekdays: "工作日 {time}",
        weekend: "周末 {time}",
        monthly: "每月 {day} 号 {time}",
        hourly: "每小时第 {minute} 分",
        cron: "cron {expr}",
        weekly: "每周{days} {time}",
      },
      next: { never: "不会再到点", pending: "等主人同意", done: "做过了", off: "关着" },
      expr: {
        fields: { "0": "分钟", "1": "小时", "2": "日", "3": "月", "4": "周几" },
        badField: "cron 的{name}写错了：{field}",
        fiveFields: "cron 要五段：分 时 日 月 周几，比如 0 9 * * 1-5",
        never: "这个 cron 永远不会到点：{expr}",
      },
      problem: {
        noName: "定时任务要有个名字",
        noText: "定时任务要写到点了做什么",
        zone: "不认识这个时区：{tz}",
        past: "一次性的时间要在以后",
        every: "间隔至少 {min} 分钟",
        time: "时间写成 HH:MM，比如 09:00：{time}",
        days: "每周的哪几天：0 到 6，0 是周日",
      },
      due: "{missed, select, true {⏰ 定时任务「{name}」到点了（服务端没开着时错过的，补一次）：{text}} other {⏰ 定时任务「{name}」到点了：{text}}}",
      noCron: "没有 {id} 号定时任务",
      noChannel: "没有 {name} 这个频道",
      noProfile: "没有叫 {name} 的档案",
      noProject: "#{channel} 没有默认项目：直接派给帮工的定时任务要写 project",
      removeWhen: "删掉定时任务「{name}」（{when}）：以后不再到点开工，它开过的工单留着",
    },
    "server.game": {
      badge: { ripe: "可收获", bugs: "有虫", retrying: "重试中", rest: "歇着", weeding: "除草中 {n}" },
      tier: { silver: "银牌{title}", gold: "金牌{title}" },
      reached: { starter: "新手任务做完了", secret: "发现一个彩蛋", gold: "升到金牌", silver: "升到银牌", unlocked: "解锁成就" },
    },
    "server.inbox": {
      orchestrator: "管家",
      conflictFiles: "{files} 个文件和主分支冲突",
      step: "{graph}：{step}",
      item: {
        review: { label: "等你看", title: "{who} 做完了", tray: "{who} 做完了，等你看" },
        ask: { label: "有问题问你", title: "{who} 有问题问你" },
        fix: { label: "活没做成", title: "{who} 没做成", tray: "{who} 没做成" },
        interrupted: { title: "{who} 停在了半路" },
        conflict: { label: "合不进去", title: "{who} 的活合进主分支会冲突", tray: "{who} 的活会冲突" },
        quiet: { label: "好久没动静", title: "{who} 好一阵没动静了", body: "可能在跑很久的命令，也可能卡住了：看看它的轨迹。", tray: "{who} 好一阵没动静" },
        "graph-draft": { label: "计划拆好了", title: "计划「{text}」拆好了", body: "看过再开工", tray: "计划「{text}」等你看" },
        "graph-ready": { label: "计划做完了", title: "计划「{text}」都做完了", body: "看看改动，合进主分支", tray: "计划「{text}」等你合进主分支" },
        "task-failed": { label: "计划卡住了", title: "计划卡住了：{text}", body: "重试、改工单，或者跳过", tray: "计划「{text}」没做成" },
        mention: { label: "找你", title: "{who} 叫你" },
        "cron-ask": { label: "定时任务等你同意", title: "管家想定一个定时任务", body: "「{text}」：同意了才开始", tray: "定时任务「{text}」等你同意" },
      },
    },
    "server.issue": {
      issueNumbered: "工单 #{n}",
      issueRef: "工单 {ref}",
      helperRef: "帮工 {id}",
      projectRef: "项目 {name}",
      helper: "帮工",
      notStarted: "这张工单还没开工",
      inGraph: "这是计划里的工单：在计划里改",
      started: "这张工单已经开工了",
      noTitle: "工单没有标题",
      notQueued: "工单 {id} 不在队里",
      orchestratorNotHelper: "管家不当帮工：派给一个帮工",
      disabled: "{name} 被停用了",
      cannotSend: "{name} 派不出去：{why}",
      noProject: "没说在哪个项目里做：项目是工作目录下的一个文件夹",
      notRecorded: "{name} 的工单没记下来：{why}",
      workKept: "{refused}；工单 #{n} 和它的改动留着，可以接着派这张工单",
      drafting: "{name} 正在起草：等它交回来再开工",
      pickHint: "挑好以后挪到待办时带上它：{command}，--json 带 status「todo」和 assignee（档案的 id）",
      noAssignee: "还没选派给哪个帮工",
      profileGone: "档案 {id} 不在了",
      sendFailed: "派不出去",
      queued: "{full}：排上队了，有空位就自动开工",
      queuedStarted: "排队的「{title}」开工了：{session}",
      queuedStuck: "排队的「{title}」开不了工：{why}；也没能退回待办，还在队里",
      queuedBack: "排队的「{title}」开不了工，留在待办里：{why}",
      graphRetry: "这是计划里的工单，跟着计划走：在计划里重试这一件，或者重开整个计划",
      neverStarted: "这张工单还没开过工：直接开工",
      stillOpen: "这张工单还开着：挪回待办就是再来一轮",
      stillWorking: "{name} 还在做这张工单：直接给它带话",
      senderGone: "派它的档案 {id} 不在了",
      cronNoIssue: "定时任务「{name}」写不了工单：{why}",
      cronNoStart: "定时任务「{name}」开不了工：{why}",
      closedReopen: "这张工单关上了：带一句话重开它",
      noProfileNamed: "没有叫 {key} 的档案",
      handOverOnTodo: "换人是挪到待办时的事：挪到待办，填上谁来接手",
      stopFirst: "#{n} 还在干这一轮：先叫停，等它停下再换人",
      noStatus: "没有这个状态：{to}",
      roundNeedsWords: "再干一轮要说一句：这一轮要它做什么",
      talkTitle: "和{name}私聊",
      closed: "这张工单关上了",
      cannotMoveProject: "工单 #{n} 还不能换项目：{why}",
      cannotDelete: "工单 #{n} 还不能删：{why}",
      noConflict: "{name} 和主分支没有冲突",
      orchestratorAnswers: "这是派给管家的工单：管家答完就关",
      graphAcceptance: "这是计划里的工单，跟着计划走：在计划里验收",
      nothingToAccept: "还没交回来，没有东西可验收",
      failNeedsFindings: "没过验收要说哪里不行：至少写一条意见",
      does: {
        toOrchestrator: "{n} 交给管家答",
        sendTo: "{n} 派给 {agent}",
        noRoom: "现在没空位（{full}）：排进待办，有空位就自动开工",
        startIn: "{n} 派 {agent} 去 {project} 开工",
        start: "{n} 派 {agent} 开工",
        unqueue: "{n} 不排了，挪回备选",
        leaves: "{helper} 收工，分支留着",
        takesOver: "{taker} 接手，在同一条分支上接着做",
        orchestratorRound: "{n} 再交给管家答一轮：{said}",
        round: "把这句话带给 {helper}，再干一轮：{said}",
        thisTime: "这一次要做的：{said}",
        revive: "{n} 挪回备选",
        completeNone: "{n} 关成已完成：没有改动要合",
        completeKept: "{n} 关成已完成：分支留着没合（{commits} 个提交）",
        helperLeaves: "{helper} 收工",
        commitFirst: "先替 {helper} 提交 {files} 个没提交的文件",
        check: "合之前跑项目的检查（.vibevalley/check，有的话）：没过就不合，工单留在等你看",
        pullRequest: "推分支、开 PR（{commits} 个提交）：PR 合了才关成已完成",
        cancel: "{n} 关成已取消",
        cancelLeaves: "{helper} 收工，分支上有提交就留着",
        drop: "{n} 关成已取消：还没派过",
        drafterLeaves: "在起草的 {name} 收工",
        reject: "#{n} 打回：{findings} 条意见交给 {helper} 再修一轮",
        resolve: "让 {helper} 把主分支合进它的分支、解决冲突，做完再交回来",
        resume: "让 {helper} 接着做：{words}",
        cure: "让 {helper} 接着修，再交回来",
        deleteIssue: "删掉工单 #{n}「{title}」",
        cleanWorktree: "清掉它的 worktree 和没有提交的分支；还有改动就不删",
        reopen: "{n} 重开：派同一个档案的新帮工接着做",
        reopenBy: "{n} 重开：派 {taker} 接着做",
        conflicts: "合进 {base} 会冲突（{files}）：不会合，标上冲突，工单留在等你看",
        merge: "合进 {base}（{commits} 个提交），关成已完成，{helper} 收工",
        mainBranch: "主分支",
      },
      brief: {
        reopenDefault: "接着把这张工单做完",
        handedOver: "这张工单换你接手了，之前是 {name}（{id}）在做",
        reopened: "这张工单重开了，上一次是 {name}（{id}）做的",
        how: "\n\n（{how}。）",
        original: "\n这张工单原来是：{brief}",
        answer: "\n上一次的结论：{conclusion}",
        closed: "\n它是怎么关的：{closed}",
        lastRun: "\n最后一轮{outcome}：{summary}",
        previous: "\n这条分支上已经有上次的提交，接着做。",
        end: "\n先看看项目现在的样子，再接着做。",
        failedHead: "验收没过，这几处要修：",
        failedEnd: "\n\n修好以后在结论里逐条说怎么修的。",
        resume: "上一轮停在了半路，接着把它做完。",
        cure: "接着修：{brief}。看一下报错，修好再跑一遍测试",
        cureHead: "接着修：",
        cureTail: "。看一下报错，修好再跑一遍测试",
        answerUnread: "接着修：上一轮交回的结论读不出来（{problem}）。接着查清楚，最后照这个格式交：",
      },
      move: {
        inGraph: "这是计划里的工单，跟着计划走：在计划里改",
        same: "它已经是这个状态了",
        byHelpers: "处理中和等你看是帮工干出来的：挪到待办，它就开工",
        drafting: "{name} 正在起草：等它交回来再开工",
        working: "还在干这一轮：等它交回来，或者挪到已取消",
        failed: "这一轮没做成：带句话再干一轮，或者关掉",
        reopen: "关上的工单挪回待办，就是带一句话重开",
        revive: "没开过工就取消的工单，挪回备选再说",
        cannot: "不能从{from}挪到{to}",
        sayWithText: "{label}：{command}，--json 带要说的 text",
        moveTo: "挪到{status}",
        roundWithText: "{say}：{command}，--json 带 status「{to}」和这一轮要它做什么的 text",
      },
      template: { commands: { test: "测试", lint: "代码检查", build: "构建" }, done: "{title}\n做到什么程度算完：{done}" },
      timeline: {
        opened: "开单",
        refine: "开始起草",
        told: "你带了话，接着做一轮",
        start: "开工",
        restart: "重开，接着做",
        graph: "照计划开工",
        cron: "{missed, select, true {定时开工（补跑）} other {定时开工}}",
        runtime: "农机自己接着做",
        refined: "起草好了",
        reported: "交回来了",
        said: "：{summary}",
        accepted: "验收通过",
        asked: "问你：{questions}",
        rejected: "打回：{lines}",
        rejectedSeparator: "；",
      },
      merge: { tellFailed: "\n给帮工带话失败：{why}", merged: "{name} 的活合进去了：{text}" },
      refinement: {
        noDrafter: "没有能派的帮工来起草",
        orchestrator: "这是派给管家的工单：管家自己会看",
        onlyBacklog: "只有备选里的工单能起草：先挪回备选",
        drafting: "{name} 正在起草：等它交回来",
        noProject: "没说在哪个项目里做：先选一个项目",
        unread: "{name} 交回来的草稿读不出来（{problem}），工单没动：再起草一次",
        unfinished: "{name} 没起草完（{summary}），工单没动：再起草一次",
        canceled: "「{title}」取消了：{why}",
        noBlock: "没找到草稿：要用一个 json 代码块给出",
        notObject: "要是一个对象",
        unreadable: "json 读不了：{why}",
        noTitle: "草稿没有标题",
        lines: "{field}：要是字符串或字符串的数组",
        text: "{field}：要是字符串",
        why: "为什么：",
        todo: "要做的：",
        notDoing: "不做的：",
        files: "可能涉及：",
      },
    },
    "server.lan": {
      aDevice: "一台设备",
      noDevice: "没有 {id} 这台设备",
      notUp: "VibeValley 还没起来",
      unpaired: "这台设备没配对，或者已经被主人移除了：回那台电脑上扫码配对",
      notRemote: "连进来的设备不能做这个：只能在跑着 VibeValley 的那台电脑上做",
      badGateway: "转不过去",
      cannotOpen: "连接开不起来：{why}",
      noAddress: "找不到这台电脑在局域网里的地址：连上 Wi-Fi 或网线再试",
      notOpen: "还没允许连接：先打开它",
      noneAsking: "没有设备在等你点头",
      closedThere: "那台电脑没允许连接：回那台电脑的「连接到本机」打开它",
      codeExpired: "配对码过期了：回那台电脑上换一个码",
      wrongCode: "配对码不对",
      anotherAsking: "另一台设备正在等主人点头：等一会儿再试",
      ownerLate: "主人没来得及点头，配对码过期了：回那台电脑上换一个码",
      denied: "主人没让这台设备进来",
      noCode: "没有在配对的码：什么都不会动",
      dropCode: "收起配对码 {code}",
      dropAsking: "正在等你点头的「{name}」连不进来",
      forget: "忘掉设备「{name}」：它的钥匙作废，要再连得重新配对",
      cut: "断开它连着的 {n} 条连接",
      local: "这里就是跑着 VibeValley 的本机，不是连进来的设备",
    },
    "server.memory": {
      source: { local: "本地", nowledge: "Nowledge Mem", everos: "EverOS" },
      noUrl: "没填地址",
      off: "没打开",
      unknownSource: "不认识这种来源",
      stopped: "记性来源已经停下",
      forgetThere: "{source} 里的记忆到它自己那里删",
      coverage: {
        failed: "读取失败、已取消或超时，未包含此来源",
        everosAcross: "不支持跨项目检索，请指定一个项目；本次未包含 EverOS",
        everosAgent: "此查询需要指定档案，本次未包含 EverOS",
        unconfirmed: "有命中的项目范围未经确认，已从本项目检索中排除",
        note: "{source}：{note}",
      },
      everosList: "EverOS 的记忆不在这里列出",
      everosForget: "EverOS 里的记忆到 EverOS 里删",
      nowledgeForget: "Nowledge Mem 里的记忆到 Nowledge Mem 里删",
      empty: "要记的话是空的",
      dbFailed: "没记下来：数据库写不进去",
      fileFailed: "没记下来：MEMORY.md 写不进去",
      noMemory: "{agent} 的记性里没有 {id}",
      forgetOrchestrator: "从管家的 MEMORY.md 删掉这一行：「{text}」",
      forget: "从 {agent} 的记性里忘掉：「{text}」",
      orchestratorRecall: "管家不靠想起：它每次带着整份记性",
    },
    "server.orchestrator": {
      label: "管家",
      noKey: "我还没有 DeepSeek 的钥匙，想不了事。到首页的「设置」里填上 DeepSeek 的 API Key（工作台左栏最下面的「设置」也能去），填好再跟我说一遍。",
      cannotStart: "我这边起不来：{why}",
      onlyDeepseek: "管家只接 DeepSeek 的模型：管家档案的模型设成 deepseek/<模型> 或直接写模型名，{configured} 用不了",
    },
    "server.project": {
      badName: "项目名用字母或数字开头，只含字母、数字、-、_、.，最多 64 个字符",
      badGithub: "请填 GitHub 仓库地址，例如 https://github.com/botiverse/raft-source",
      branchMoved: "分支在检查以后又变了，请重新检查再合",
      mainMoved: "主分支在检查期间又变了，请重新检查再合",
      mergedWorktreeLeft: "改动已合并，worktree {cwd} 和分支 {branch} 尚未清理：{why}",
      mergedBranchLeft: "改动已合并，分支 {branch} 尚未清理：{why}",
      noTokei: "统计代码要用 tokei，这台机器上没找到：装一个（brew install tokei，或 cargo install tokei）再点统计",
      noName: "无名",
      gh: { missing: "没装 gh", failed: "gh 检测失败", signedOut: "没登录 GitHub", noAccount: "无法确认 GitHub 登录账号" },
      notProjectName: "「{name}」不能当项目名：用一个简单的英文文件夹名，比如 clock-in",
      outside: "项目必须在工作目录里面，不能链接到外面",
      commit: { initial: "初始提交（VibeValley 建的项目）", initialShort: "初始提交", leftOver: "合并前把没提交的改动一并提交", merge: "合并 {branch}" },
      notChecked: "尚未检测项目，请刷新 GitHub 状态",
      check: {
        timedOut: "项目检查 .vibevalley/check 超时（{seconds}s）",
        failed: "项目检查 .vibevalley/check 没通过：{why}",
        exited: "项目检查 .vibevalley/check 没通过：exit status {code}",
      },
      mergeFailed: "合并进 {main} 没成功，{kept}：{why}",
      mergeStuck: "合并进 {main} 没成功，{kept}：{why}；退出合并也没成功（{abort}），{main} 停在合并到一半，要手动收拾",
      exists: "「{name}」已经存在，请换个项目名",
      cloneFailedGh: "下载失败：请确认 GitHub 登录、仓库权限和网络后重试",
      cloneFailed: "下载失败：请确认仓库公开、地址正确且网络可用；超过 3 分钟会停止，可重试",
      tokeiFailed: "tokei 没数完：{why}",
      tokeiUnread: "tokei 的输出读不懂：换个新一点的 tokei 试试",
      noBranchRead: "没能读取分支 {branch}：{why}",
      inProjectNoBranch: "它直接在项目里干活，没有要合并的分支",
      inProjectNothing: "它直接在项目里干活，没有分支可合",
      keptBoth: "{branch} 分支和 worktree 都留着",
      keptBranch: "{branch} 分支留着",
      merged: "{ahead} 个提交合进了 {project} 的 {main}",
      nothingNew: "这一单没有新的提交",
      nothingNewInPlan: "计划分支上没有新的提交",
      branchLeft: "；改动已合并，分支 {branch} 尚未清理：{why}",
      clear: {
        uncommitted: "{branch} 还有没提交的改动，worktree 留在 {cwd}",
        branchLeft: "{branch} 没清掉：{why}",
        unmerged: "{branch} 上有 {ahead} 个没合的提交，分支留着，worktree 清掉了",
        notWorktree: "不是 worktree，不能重置：{cwd}",
        worktreeLeft: "worktree {cwd} 没清掉：{why}",
        unconfirmed: "没能确认 {branch} 已清掉：{why}",
        unmergedKept: "{branch} 上有没合的提交，分支留着",
      },
      github: {
        unchecked: "尚未检测 GitHub",
        notGithub: "不是 GitHub 仓库",
        noPermission: "无法检测 GitHub 仓库权限",
        readOnly: "没有写权限",
        wrongBranch: "工单分支不匹配",
        pushFailed: "推送工单分支失败，请检查 origin 和登录后重试",
        listFailed: "查询已有 PR 失败；分支已推送，可重试",
        listUnread: "无法读取已有 PR",
        checked: ".vibevalley/check 通过。",
        noCheck: "这个项目没有 .vibevalley/check，没跑检查。",
        body: "工单 #{n}\n\n{conclusion}\n\n{check}",
        createFailed: "创建 PR 失败；分支已推送，可重试",
        urlUnread: "无法读取新建 PR 的地址；可重试查询",
        viewFailed: "查询 PR #{n} 失败",
        stateUnread: "无法读取 PR #{n} 状态",
        stateUnknown: "无法识别 PR #{n} 状态",
        worktreeLeft: "PR 已结束，清理 worktree 失败：{why}",
        branchLeft: "PR 已结束，清理本地分支失败：{why}",
      },
      mergeTree: "git merge-tree 出错（{code}）",
      moreLines: "… 还有 {n} 行没显示",
      conflict: "合进 {base} 有冲突",
    },
    "server.runtime": {
      date: "{month} 月 {day} 日 {time}",
      quotaGone: "{runtime} 的额度用完了（{window}）{resets}，到时候再派",
      resets: "，{when}重置",
      balanceGone: "{provider} 的余额用完了，充值以后再派",
      budget: "今天已经花了 {spent}，到了每日预算 {budget}（在「农机」页可以改）",
      quota: {
        none: "不报额度",
        signedOut: "没登录",
        unread: "读不到额度（{why}）",
        noBalance: "{provider} 读不到余额",
        some: "有额度",
        balance: "{provider} 余额 {balances}",
        balanceLow: "{provider} 余额 {balances}，不够用了",
        window: "{label} 剩 {left}%",
        windowSeparator: "，",
      },
      lessThanCent: "不到 ¥0.01",
      persona: "{refused}。把人设改成「写进工单开头」。",
      noModel: "{runtime} 的模型列表里没有 {model}",
      runtimeDefault: "{runtime} 默认用的 {model}",
      unknownRuntime: "不认识的农机：{runtime}",
      notInstalled: "这台机器上找不到这台农机",
      disabled: "这台农机在「农机」页里被停用了",
      noUsage: "这台农机 不报用量",
      cursor: "Cursor 要单独装它的 SDK（@cursor/sdk），VibeValley 还没接",
      oarUnknown: "oar 不认识这台农机",
      tools: "{n} 个工具",
      notSaved: "没存下 {id} 的设置：{why}",
      cannotDrive: "oar 驱动不了 {runtime}",
      cannotSend: "{name} 派不出去：{why}",
      defaultModel: "{runtime} 没有 {model} 这个模型，{name} 先用默认模型",
      piNoBalance: "{provider} 不报余额",
      piNoModel: "pi 没有设默认模型",
      piUnread: "没读到 DeepSeek 余额",
      effort: "{model} 没有 {effort} 这一档，可选：{levels}",
    },
    "server.session": {
      failure: {
        auth: "登录或密钥有问题",
        quota: "额度用完了",
        rate_limited: "请求太频繁，被限流了",
        billing: "余额不够了",
        model_unavailable: "这个模型用不了",
        input_too_large: "上下文太长，装不下了",
        invalid_request: "请求被服务商拒绝了",
        overloaded: "服务商太忙",
        provider: "服务商出错了",
        runtime_exited: "农机进程中途退出了",
        unknown: "出错了",
      },
      failureNext: { userAction: "要你先处理一下", now: "可以让它再试一次", later: "过一阵再试" },
      failureStatus: "（HTTP {status}）",
      failureReason: "：{reason}",
      failureThen: "。{next}",
      done: "做完了",
      unfinished: "没做完",
      answer: {
        lines: "{field}：要是字符串或字符串的数组",
        noBlock: "没找到结论：要用一个 json 代码块给出",
        notObject: "要是一个对象",
        unreadable: "json 读不了：{why}",
        empty: "结论是空的",
        noEvidence: "结论没有依据：evidence 至少一条",
      },
      noRoom: {
        farm: "已经有 {max} 个帮工在干活了",
        runtime: "{runtime} 上已经有 {on} 个帮工在干活，最多同时 {max} 个（在「农机」页可以改）",
        project: "项目 {project} 里已经有 {on} 个帮工在干活，最多同时 {max} 个：人多了容易改到同一个文件",
      },
      notTaken: {
        conflictOwner: "没合进去：合进 {base} 会冲突（{files}）。{name} 还在，分支和 worktree 都在。要它解决就用 tell 告诉它：{brief}",
        conflictNotice: "{name} 的分支合进 {base} 会冲突（{files}），先没合。可以让它自己把冲突解决掉",
        conflictShort: "合进 {base} 会冲突：{files}",
        checkFix: "{reason}\n请修好检查，再交回来。",
        owner: "没合进去：{why}。{name} 还在",
        notice: "{name} 的活没合进去：{why}",
        checkShort: "项目检查没通过",
      },
      log: {
        stopped: "VibeValley 停下了，这一轮中断了",
        image: "[图片]",
        exitedNotice: "{name} 的 {why}",
        staleRun: "上一轮停在了半路，太久了，没有接着做",
        stoppedByOwner: "主人叫停了",
        folded: "整理对话，{usage}",
        clipped: "… 省略 {n} 个字 …",
        quiet: "已经 {span}没动静了{last}。可能在跑很久的命令，也可能卡住了",
        quietLast: "（最后在：{label}）",
        restarted: "VibeValley 重启了，这一轮停在了半路",
        retry: "调用模型没成功，第 {attempt} 次重试",
        retryOf: "调用模型没成功，第 {attempt}/{of} 次重试",
        retryIn: "，{s} 秒后",
        retryWhy: "：{reason}",
        exited: "{runtime} 进程退出了",
        exitedCode: "{runtime} 进程退出了（退出码 {code}）",
      },
      usage: {
        parts: { instructions: "说明", env: "环境", skills: "技能", memory: "记性", tools: "工具" },
        cached: "缓存命中 {percent}%：读缓存 {read}，没命中 {missed}，输出 {output}",
        unread: "没报读了多少：输出 {output}",
        changed: "；开头变了：{parts}",
      },
      host: {
        stopped: "{label}已经停下",
        cannotStart: "起不来：{why}",
        notRecorded: "{label}的这一轮没能记下：{why}",
        startFailed: "{label}起不来：{why}",
        callerStart: "我这边起不来：{why}",
        failed: "{label}出错了：{why}",
        markNeedsWords: "写一句它应该怎样",
        noStep: "{label}轨迹里没有第 {on} 步",
        stepHint: "步数在页面上它的日志里，每一步前面的编号",
        notAsked: "第 {on} 步不是{label}收到的话",
        notInConversation: "第 {on} 步收到的话没进{label}的对话（那时{label}没起来？）",
      },
      life: {
        stoppedNeedsYou: "{name} 停下了：{why}",
        quietNotice: "{name} 已经 {span}没动静了{last}：点它的地看看过程，不对就叫停",
        notStopped: "农机没能停止，工作目录留着：{why}",
        notReturned: "上一次农机还没交回工作目录",
        agentGone: "{name} 的 agent 已经删掉了，叫不醒",
        cannotWake: "{name} 叫不醒：{why}",
        noHelper: "没有 {id} 这个帮工",
        helperRef: "帮工 {id}",
        stillClosing: "{name} 的农机没能停止：工作目录留着，不能再开一轮",
        noRoom: "{name} 先不接着干：{full}",
        notReceived: "{name} 没收到：{why}",
        inGraph: "{name} 在做计划 {graph} 里的活：做完会自动合进计划的分支，整个计划合进主分支时再进主分支",
        stillWorking: "{name} 还在干活：等这一轮做完，或者先叫停，再收",
        notBack: "{name} 没接回来：{why}",
        placeGone: "干活的目录不见了（{cwd}）",
        noRecord: "库里没有它的记录",
        restartedNotice: "VibeValley 重启过，{name} 那一轮停下了；给它带句话就能接着干",
        issueNotReturned: "这张工单的农机还没交回工作目录",
        noPlace: "{name} 没地方干活：{why}",
        cannotSend: "{name} 派不出去：{why}",
        notRecorded: "{name} 的工单没记下来：{why}",
        steered: "{name} 正在干，话已经插进去了",
        queued: "{name} 这一轮做完再看这句话",
        started: "{woke, select, true {{name} 醒了，开始新的一轮} other {{name} 开始新的一轮}}",
        notReset: "{name} 的工作目录没能重置：{why}",
        left: "{name} 收工了：{why}",
        stillHasHelper: "这张工单还有帮工，不能清掉工作目录",
        seconds: "{n} 秒",
        minutes: "{n} 分钟",
      },
      conflictBrief:
        "把 {base} 合进你的分支时有冲突（{files}）。请在你的分支上运行 git merge {base}，把冲突解决掉，跑一遍测试，再提交。结论里说清楚每个冲突是怎么取舍的。",
    },
    "server.setting": {
      deepseekKey: "DeepSeek 的 API Key 看着不对：一串不带空格的字，通常以 sk- 开头",
      agoraId: "Agora 的 App ID 是 32 位的十六进制，在声网控制台的项目里找",
      agoraCertificate: "Agora 的 App Certificate 是 32 位的十六进制，在声网控制台的项目里找",
      voiceKeySpace: "语音服务的 key 里不该有空格",
      dictationUrl: "听写的地址要是 http(s) 开头的完整地址，到 /v1 为止，比如本机的 http://127.0.0.1:8080/v1",
      dictationModel: "听写要填模型名，比如本机 speech-server 的 qwen3，或 OpenAI 的 gpt-4o-mini-transcribe",
      memory: {
        unknown: "不认识的记性来源：{kind}",
        twice: "同一种记性来源只能接一个：{kind}",
        noUrl: "要接上记性来源，先填它的地址",
        url: "记性来源的地址要是 http(s) 开头的完整地址，比如 Nowledge Mem 的 http://127.0.0.1:14242/mcp/",
        keySpace: "记性来源的 key 里不该有空格",
      },
      voice: {
        label: { silenceMs: "停顿多久算说完（毫秒）", interruptMs: "说多久能打断他（毫秒）", idleSeconds: "没人时多久离开（秒）" },
        range: "{label}要在 {min} 到 {max} 之间",
        region: "微软识别要填区域，比如 eastasia",
        model: "大模型要填模型名",
        url: "大模型的地址要是 http(s) 开头的完整地址，比如 https://api.openai.com/v1/chat/completions",
        voiceId: "音色不能空着：选一个或填 MiniMax 的音色 id",
        microsoft: "微软合成要填区域和音色名",
        persona: "管家的人设不能空着",
      },
      defaults: { failureMessage: "我这边卡了一下，你再说一遍？" },
      notSaved: "存不进 {file}：{why}",
    },
    "server.task": {
      graphState: {
        splitting: "在拆",
        draft: "等你看过再开工",
        running: "在做",
        paused: "暂停了",
        ready: "都做完了，等你合进主分支",
        done: "合进了主分支",
        abandoned: "放弃了",
      },
      graphTag: { splitting: "在拆", draft: "等你看", running: "在做", paused: "暂停了", ready: "等你合", done: "合进了", abandoned: "放弃了" },
      graphAction: { start: "开工", pause: "暂停", resume: "继续", abandon: "放弃", merge: "合进主分支" },
      taskState: { waiting: "等着", working: "在做", merged: "合进去了", failed: "没做成", skipped: "跳过了" },
      taskAction: { retry: "重试", skip: "跳过" },
      actor: { owner: "主人", orchestrator: "管家", session: "帮工", system: "VibeValley" },
      field: { title: "标题", brief: "工单", needs: "要等的", agent: "谁来做", check: "检查", scope: "该改的地方" },
      event: {
        splitting: "要拆一张计划{why}",
        paused: "暂停了{why}",
        resumed: "接着做了",
        ready: "都做完了，等主人合进主分支",
        merged: "合进了主分支",
        abandoned: "放弃了{why}",
        taskStarted: "{step}开工{by}",
        taskSentBack: "{step}退回去重做{by}{why}",
        taskFailed: "{step}没做成{why}",
        taskRetried: "{step}重试",
        taskRequeued: "{step}没有帮工在做了，重新排上",
        taskSkipped: "{step}跳过了，后面的照做",
        taskAdded: "加了一件{step}",
        taskRemoved: "删了一件「{title}」",
        step: "「{title}」",
        by: "（{session}）",
        why: "：{detail}",
        drafted: "拆好了，等主人看",
        draftedSteps: "拆好了，{steps} 件，等主人看",
        started: "开工了",
        startedOn: "开工了，分支 {branch}",
        taskMerged: "{step}合进了计划分支{why}",
        taskMergedCommits: "{step}合进了计划分支（{commits}）{why}",
        taskEdited: "改了{step}的{fields}",
      },
      problem: {
        empty: "计划里一件都没有",
        tooMany: "最多 {max} 件，这里有 {n} 件：把小的几件合并",
        badId: "「{id}」不能当一件的 id：用简短的英文，比如 api",
        duplicate: "一件的 id「{id}」重复了",
        noBrief: "「{id}」没有工单",
        noCheck: "验收的那一件「{id}」没有检查命令：验收就是这条命令",
        self: "「{id}」不能等自己",
        missing: "「{id}」要等的「{other}」不存在",
        circle: "这几件互相等，成了一个圈：{ids}",
      },
      parse: {
        object: "要一个对象",
        string: "{at} 要是字符串",
        array: "{at} 要是数组",
        stepObject: "{at} 要是对象",
        missing: "{at} 缺了",
        boolean: "{at} 要是布尔值",
        noBlock: "没找到计划：要用一个 json 代码块给出",
        unreadable: "json 读不了：{why}",
        shape: "计划的格式不对：{why}",
      },
      edit: {
        taskSettled: "「{title}」{state}，不能改了",
        graphSettled: "计划{state}，不能再加一件了",
        noStep: "计划里没有「{id}」这一件",
        cannotRemove: "「{title}」{state}，不能删了：可以跳过它",
        remove: "从计划「{graph}」删掉「{step}」这一件",
        stopWaiting: "{steps}不再等它",
      },
      noGraph: "没有 {id} 这个计划",
      notSaved: "计划「{title}」没能保存：{why}",
      notice: {
        notSplit: "计划「{title}」没拆成：{why}",
        splitStopped: "规划被叫停了",
        plannerFailed: "规划的帮工出错了：{summary}",
        noGraph: "没给出能用的计划：{problem}",
        drafted: "计划「{title}」拆好了，{steps} 件：在「计划」里看过再开工",
        noHelper: "没有能派的帮工",
        waits: "「{title}」先等着：{why}",
        taskFailed: "计划「{graph}」的「{task}」没做成：{why}",
        unknownFiles: "看不出它改了哪些文件：{why}",
        acceptancePassed: "验收 {check} 现在就通过了",
        checkFailed: "做完跑 {check} 没通过",
        noBranch: "计划还没有分支",
        stepNotSaved: "「{title}」这一件已合进计划分支，但完成状态没能保存：{why}",
        ready: "计划「{title}」都做完了：在「计划」里看看改动，合进主分支",
        stepStopped: "「{title}」被叫停了，计划先暂停；点继续接着做",
        plannerGone: "规划的帮工被请走了",
        helperGone: "帮工被请走了，这一件没做完",
        done: "做完了",
        restartedSplitting: "VibeValley 重启了，规划停在了半路：再说一遍要做什么",
        restarted: "VibeValley 重启过，计划先暂停了；点继续接着做",
        split: "{name} 把工单「{title}」拆成了 {n} 张子工单，开工了",
        splitBy: "{name} 拆的",
        splitNotSaved: "计划分支 {branch} 已创建，但拆好的工单没能保存：{why}",
        frozenTouched: "改了冻结的验收：{files}",
      },
      act: {
        noGoal: "没说要做什么",
        noProject: "没说在哪个项目里做：项目是工作目录下的一个文件夹",
        noSplitter: "没有能派的帮工来拆计划",
        notSent: "没派出去",
        plannerNotSent: "规划的帮工派不出去：{why}",
        splittingBy: "{name} 去看代码、拆计划了（{id}）。拆好了会放在「计划」里，你看过再开工。",
        startNotSaved: "计划分支 {branch} 已创建，但开工状态没能保存：{why}",
        started: "计划「{title}」开工了，分支 {branch}",
        pausedNote: "暂停了：正在做的几件做完，不再开新的",
        paused: "计划「{title}」暂停了：正在做的几件做完，不再开新的",
        resumed: "计划「{title}」接着做了",
        branchKeptNote: "；分支 {branch} 留着",
        abandonedNote: "放弃了{kept}",
        notMergedNote: "没合进去：{why}",
        notMerged: "没合进去：{why}。计划分支 {branch} 留着",
        mergeNotSaved: "计划分支已合进主分支，但完成状态没能保存：{why}",
        merged: "计划「{title}」合进去了：{text}",
        noStep: "计划里没有「{id}」这一件",
        graphIs: "计划{state}",
        notFailed: "「{title}」没有失败，不用重试",
        retried: "{name} 接着做「{title}」",
        requeued: "「{title}」重新排上了",
        working: "「{title}」正在做，先叫停",
        finished: "「{title}」已经做完了",
        skipped: "跳过了「{title}」，后面的几件照常开工",
        stepAct: "{action}「{title}」",
        edited: "改好了",
        notStarted: "计划「{title}」还没开工，没有分支",
        branchGone: "计划「{title}」的分支不在了：先确认它是不是被删掉了",
        stepsWrong: "拆出来的几件有问题，改好再拆：\n- {problems}",
        cannot: "计划「{title}」{state}，不能{action}",
        abandoned: "计划「{title}」放弃了",
        abandonedKept: "计划「{title}」放弃了，分支 {branch} 留着",
        conflict: "合进 {base} 会冲突（{files}）：{base} 在这期间变了",
      },
    },
    "server.tool": {
      labels: {
        project_list: "项目",
        channel_list: "频道",
        channel_create: "开频道",
        channel_update: "改频道",
        cron_create: "新建定时任务",
        cron_list: "看定时任务",
        cron_delete: "取消定时任务",
        issue_review: "验收",
        issue_diff_get: "看改动",
        session_list: "花名册",
        issue_get: "看进度",
        issue_comment_create: "带话",
        channel_message_list: "看对话",
        channel_message_send: "说话",
        channel_unread_list: "看没读的",
        session_stop: "叫停",
        issue_list: "找工单",
        issue_create: "记一张工单",
        issue_update: "改工单",
        issue_status_update: "挪工单",
        graph_split: "拆计划",
        graph_list: "看计划",
        graph_get: "看计划",
        graph_task_update: "改计划",
        graph_task_delete: "删计划的一件",
        graph_act: "计划",
        graph_task_act: "计划的一件",
        issue_split: "拆工单",
        remember: "记一条",
        rewrite_memory: "整理记性",
        search_archive: "翻旧账",
        memory_search: "翻记性",
        memory_create: "替帮工记",
        artifact_block_create: "往产出里加一块",
        artifact_block_update: "改产出的一块",
      },
      about: "{label}：{about}",
    },
    "server.voice": {
      misheard: "嗯？我没听清，你再说一遍？",
      unknownSuffix: "服务端还不会用",
      unknown: "{what}用的 {vendor} 服务端还不会用",
      part: { asr: "识别", llm: "大模型", tts: "合成" },
      noAsrKey: "微软识别还没有 key：在声音页的「识别」里填",
      noLine: "管家的语音线路没接通",
      noDeepseekKey: "用 DeepSeek 要先有 DeepSeek 的 key：在首页「设置」里填",
      noLlmKey: "自己的大模型还没有 key：在声音页的「想」里填",
      noTtsKey: "微软合成还没有 key：在声音页的「说」里填",
      unusable: "语音设置用不了：{why}",
      tunnel: {
        timedOut: "cloudflared 30 秒没给出地址",
        missing: "没有 cloudflared：先 brew install cloudflared，或者在配置里设 voice.line.url，用你自己的隧道",
        exited: "cloudflared 退出了，没给出地址",
      },
      noAgora: "还没有 Agora 的凭据：在首页的「设置」里填 App ID 和 App Certificate",
      lineDown: "语音线路开不起来：{why}",
      lineClosed: "语音线路已经关闭",
      lineNotOpen: "语音线路还没开",
      hungUp: "这通电话已经挂了",
      noToken: "签不出语音令牌：{why}",
      stopped: "语音服务已经停下",
      grantGone: "这通电话的语音凭据已经失效，请重新接通",
      connecting: "这通电话已经在接通",
      lineFailed: "管家的语音线路接不通：{why}",
      joinFailed: "请管家进频道失败：{why}",
      leaveFailed: "请管家离开失败：{why}",
      manyCalls: "有几通电话正在接通，请升级客户端后重试",
      noCall: "没有正在接通的电话",
      dictation: {
        unset: "听写还没配：在「听写」里填自己的地址和模型，或者换成 MOSS",
        format: "听写认不得 {format} 这种录音",
        empty: "录音是空的，或者不是 base64",
        tooLong: "录音太长了：一段不超过 25 MB",
        unreachable: "听写的地址连不上：{why}",
        cut: "听写的回答读到一半断了：{why}",
        status: "听写的地址回了 {status}：{detail}",
        shape: "听写的地址回的不是 OpenAI 的转写格式",
        noMossKey: "听写走 MOSS，还没填 MOSS 的 API Key：在「听写」里填上",
      },
      moss: {
        noKey: "还没填 MOSS Live 的 API Key",
        refused: "MOSS Live 不认这个 Key：{why}",
        unreachable: "连不上 MOSS Live：{why}",
        failed: "MOSS Live 没接通：{why}",
        silent: "MOSS Live 8 秒内没回应",
      },
    },
    shared: {
      action: {
        run_command: "跑命令",
        read_file: "读文件",
        edit_file: "改文件",
        search: "搜索",
        web: "查网页",
        mcp: "调 MCP 工具",
        wait: "等待",
        other: "用工具",
        thinking: "思考",
        speaking_text: "写汇报",
        none: "",
      },
      outcome: { completed: "做完了", failed: "没做成", interrupted: "停在半路" },
      status: { backlog: "备选", todo: "待办", in_progress: "处理中", in_review: "等你看", done: "已完成", canceled: "已取消" },
      priority: { urgent: "紧急", high: "高", medium: "普通", low: "低" },
      deliverable: { change: "改动，合进项目", branch: "改动，分支留着不合", answer: "结论，只查不改代码" },
      delivered: { merged: "合进了主分支", merged_into_parent: "合进了计划的分支", pull_request: "PR 合进去了", kept: "分支留着没合", none: "没有改动要合" },
      canceled: { dismissed: "取消了", lost: "干活的目录丢了" },
      doneWith: "已完成，{what}",
      canceledFor: "已取消，{why}",
      attention: {
        draft: "草稿",
        queued: "排队",
        working: "在做",
        asking: "等你回答",
        reviewing: "等你验收",
        stuck: "卡住了",
        done: "已完成",
        canceled: "已取消",
      },
      stuck: { conflict: "有冲突", failed: "没做成", interrupted: "停在半路", quiet: "没动静" },
      act: {
        start: "开工",
        answer: "回答",
        reject: "打回",
        complete: "完成",
        acknowledge: "知道了",
        resolve: "让它解决冲突",
        resume: "接着做",
        cure: "接着修",
        tell: "带话",
        stop: "叫停这一轮",
        close: "取消",
        reopen: "重开",
      },
      phase: {
        arriving: "刚派出去，正在开工",
        quiet: "{what}（已经 {span}没动静了）",
        done: "这一轮做完了，等你看{conflict}",
        failed: "这一轮没做成",
        resting: "歇着（上一轮{last}）{conflict}",
        unfinished: "没做完",
        conflict: "，合进 {base} 会冲突（{files}）",
        working: "在{action}",
        workingOn: "在{action}：{label}",
        retrying: "{what}（模型调用失败，在重试第 {attempt} 次）",
        retryingOf: "{what}（模型调用失败，在重试第 {attempt}/{of} 次）",
      },
      order: { invalid: "不是有效的顺序键", unordered: "顺序键 {a} 不在 {b} 前面" },
      greeting: "来啦！今天想种点什么？",
      serverAnswered: "服务端答 {status}",
      seconds: "{n} 秒",
      minutes: "{n} 分钟",
      join: { labeled: "{label}：{text}", aside: "{text}（{aside}）", sentence: "{text}。", and: "{a}，{b}", clauses: "{a}；{b}", separator: "、" },
    },
    web: { opening: { waking: "叫醒 VibeValley……", label: "叫醒 VibeValley", cannotStart: "VibeValley 起不来：{why}" } },
    "web.agent": {
      newName: "新的 {runtime}",
      noProfiles: "问不到服务端的档案：",
      noRuntimes: "读不到农机：{why}",
      loading: "读取配置…",
      noSuch: "没有这份档案。",
      backToAll: "回到全部档案",
      unnamedAgent: "无名 agent",
      unnamed: "无名帮工",
      all: "← 全部档案",
      isNew: "新的",
      unsaved: "没保存",
      saved: "已保存",
      discard: "放弃改动",
      talk: "私聊",
      saving: "保存中…",
      create: "捏好了，保存",
      save: "保存",
      backToProfile: "← 回到档案",
      trajectoriesHint:
        "它派出去的每个帮工，从接活起的每一步：收到的话、用的每个工具（点一行看输入和输出）、说的话。收工以后这些记录留 30 天，帮工本身一直列着。",
      trajectories: "轨迹",
      remove: "删除",
      removeWhich: "删掉 {name}？",
      fine: "配置没问题，可以派活。",
      problems: "派不出去的原因",
      cannot: "派不出去：",
      random: "随机一个",
      looksAs: "在农场里是",
      looksHint: "只是长相：同一台农机 可以是不同的动物。",
      wears: "穿什么",
      tab: { who: "身份", runtime: "能力", persona: "人设", skills: "技能", tools: "工具", env: "环境", memory: "记性" },
      tabs: "档案的",
      name: "名字",
      nameTip: "管家和字幕里都叫这个名字，说话时也可以直接点名。",
      nameTaken: "已经有同名的 agent 了",
      duty: "职责",
      dutyTip: "一句话。管家挑人时会读。",
      roleHint: "比如：写接口、改 server、跑 Go 测试",
      tags: "适合的活",
      tagsTip: "用户的话里出现这些词，管家选「自动」时就优先派它。回车添加。",
      tagsHint: "前端、测试、文档…",
      enabled: "启用",
      enabledHint: "停用后管家不会派它，名字点到也会拒绝。",
      workdir: "默认项目",
      workdirTip: "工作目录（VIBEVALLEY_WORK_ROOT）下的一个文件夹。管家派活没说项目时用它；留空时派活必须说在哪个项目。",
      workdirHint: "比如 clock-in",
      worktree: "每个帮工一个 git worktree",
      worktreeHint: "每个帮工在自己的分支上改，几个帮工不会互相覆盖；完成时合进项目。关掉就直接在项目里改，没有分支可合。",
      env: "环境变量",
      envHint: "叠加在 农机设置的环境变量之上。",
      machine: "农机",
      machineTip: "换农机会清掉模型和推理强度；长相（动物和衣服）不变。",
      readingMachines: "读取农机…",
      available: "可用",
      disabled: "已停用",
      checking: "检测中…",
      notHere: "这台机器上没有",
      model: "模型",
      noModels: "这台农机 现在报不出模型列表。",
      modelLevels: "{name}（{n} 档推理）",
      effort: "推理强度",
      effortDefault: "默认由农机决定。",
      defaultEffort: "默认",
      can: "{runtime} 能做什么",
      steer: "能在干活时接话（steer）",
      noSteer: "干活时不能插话，话会排到这一轮之后",
      inProcess: "· 跑在 server 进程里（Node SDK）",
      ownProcess: "· 作为单独的命令行进程运行",
      refuses: "不接受 ",
      colon: "：",
      persona: {
        append: { label: "追加到系统提示", detail: "保留 农机自带的工作方式，在后面加上人设。大多数情况选这个。" },
        replace: { label: "替换系统提示", detail: "整段换掉 农机自带的系统提示。只有你清楚自己在做什么时才用。" },
        prompt: { label: "写进工单开头", detail: "每张工单前面加上人设。所有农机 都能用，但会被长对话冲淡。" },
      },
      personaLabel: "人设",
      personaTip: "它是谁、怎么干活、什么不做。会按下面的方式交给农机。",
      personaHint: "你是一个谨慎的后端工程师。先读懂现有代码再动手……",
      personaMode: "交给农机 的方式",
      library: "技能库",
      libraryTip: "选中的技能跟人设一起交给帮工，每个技能一节。",
      manageLibrary: "管理技能库 →",
      ownSkills: "{runtime} 自己装的技能",
      ownSkillsTip: "农机自己报告的，在这台机器上已经能用，不用在这里勾。",
      mcp: "MCP 服务器",
      mcpHint: "派出帮工时交给农机（oar 的 SessionOptions.mcpServers）。",
      removeNamed: "删除 {name}",
      mcpKind: "MCP 的种类",
      mcpName: "MCP 名字",
      mcpTarget: "MCP 命令或地址",
      add: "添加",
      disallowed: "禁用的工具",
      disallowedHint: "这些工具这个 agent 不能用。下面农机报告的工具点一下就能加进来。",
      disallowedExample: "比如 WebSearch",
      ownMcp: "{runtime} 自己连的 MCP",
      ownMcpTip: "农机自己报告的，和上面加的叠在一起。",
      unreported: "这台农机 不报告这一项。",
      none: "没有。",
      role: { orchestrator: "管家", helper: "帮工" },
      templates: {
        title: "模板",
        intro:
          "每个模板是一份 agent 的配方：角色、职责、人设、推荐的农机和长相。装一份就多一份档案，同一个模板能装好几份；装好的随便改，模板出了新版本，档案页会提示更新。",
        open: "从模板装",
        openLine: "管家和帮工的配方，挑着装",
        folder: "模板文件夹",
        folderHint: "本机上一个模板文件夹的路径（里面有 agent.json）",
        add: "加进来",
        added: "模板「{name}」加进来了，还没装",
        onServer: "跑在 VibeValley 自己的 agent 上",
        runsOn: "写给 {runtime}，这台机器上有",
        notHere: "写给 {runtime}，这台机器上没有：装上以后在档案里换一台农机",
        noPersona: "没写人设。",
        installed: "装了 {n} 份",
        addedHere: " · 本机加进来的",
        look: "看看",
        fold: "收起",
        removeSure: "真的删掉模板",
        install: "装上",
        none: "还没有帮工：从模板装几个，或者自己捏一个。",
        from: "来自模板「{name}」第 {version} 版",
        update: "照模板更新到第 {version} 版",
        updateHint: "用模板的新版本盖掉职责、适合的活、人设和交给农机的方式；名字、长相、农机、模型和环境不动。",
        updated: "照模板更新好了",
      },
      orchestrator: {
        newName: "新的管家",
        intro:
          "管家常驻、带队、自己不干活：听你说要做什么，派帮工去做，盯着进度，转告结果。它跑在 VibeValley 自己的 agent 上，有自己的私聊、记性和轨迹；把频道交给它照看，在那个频道里说话就是它回答。",
        page: "它的记性和轨迹 →",
        nameTip: "频道里叫这个名字；别人用 @它的档案 id 叫它。",
        model: "模型",
        modelTip: "DeepSeek 的模型，留空用默认的。",
        modelHint: "deepseek-v4-flash",
        dutyTip: "一句话：它专管什么。",
        personaTip: "它是谁、怎么说话、专管什么，接在管家的提示后面。",
        personaHint: "你专管 clock-in 这个项目，先看测试再派活……",
        look: "长相",
      },
      list: {
        title: "档案",
        intro:
          "每份档案是一个 agent。管家常驻、带队、自己不干活，可以有好几个；帮工是配置好的农机：用哪台农机和模型、带什么人设和技能，在农场里是哪种小动物。管家派活时派的就是帮工。",
        orchestrators: "管家",
        helpers: "帮工",
        make: "捏一个新帮工",
        makeOrchestrator: "添一个管家",
        orchestratorLine: "不当帮工：派活、盯进度、转告结果。",
        ledger: "旧账",
        voice: "声音",
        disable: "停用",
        enable: "启用",
        toggle: "{act} {name}",
        here: "在场 {n}",
        tallyHint: "从这份档案派出去的帮工，干的活收进主分支的次数",
        hired: "雇过",
        merged: "合进",
      },
      runtimeDefault: "农机默认",
      runtimeDefaultModel: "农机默认（{model}）",
      noEffort: "这个模型没有推理强度可选。",
      noEffortModel: "{model}没有推理强度可选。",
    },
    "web.artifact": {
      place: { label: "产出", hint: "你和帮工、管家留下要看的东西：一起写的产出、交上来的网页，都在这里" },
      card: { version: "第 {version} 版", open: "打开「{title}」" },
      page: {
        by: "{name} 做的",
        updated: "{when}更新",
        versions: "版本",
        open: "在新标签页打开",
        delete: "删掉",
        deleteAsk: "删掉「{title}」？对话里的卡片还在。",
        deleted: "删掉了「{title}」",
        gone: "这个产出已经删掉了，或者没有这个产出。",
        frame: "「{title}」第 {version} 版",
        list: "全部产出",
        new: "新建",
        none: "还没有产出：写个标题新建一篇，或者让帮工交一份上来。",
        all: "全部产出",
        forIssue: "为 #{number} 做的",
        untitled: "没起名的产出",
        find: "按标题找",
        nothingFound: "没有标题对得上的",
        title: "标题",
        more: "更多",
        copyLink: "复制链接",
        copied: "链接复制好了",
      },
      talk: {
        atMessage: "在对话里",
        reply: "回复",
        replyHint: "写给做它的帮工：哪里要改",
        send: "回复",
        sent: "回复了",
        replyVersion: "回复这一版",
        sentVersion: "回复了第 {version} 版",
      },
      issue: { title: "产出" },
      blocks: {
        memoryItem: "记性",
        saving: "在存……",
        saved: "都存好了",
        blocks: "{n} 块",
        helpersWriting: "帮工在写",
        demo: "演示：几个帮工一起写",
        append: "在末尾写一段",
        owner: "主人",
        done: "做完了",
        notDone: "没做完",
        writing: "{who} 在写",
        wrote: "{who} 写的",
        issue: "工单 {id}",
        unknown: "这一块是「{type}」，这个版本的客户端还画不了，只能看不能改",
        block: "块 {id}",
        heading: "标题",
        notSaved: "没存上：{why}",
        changed: "这一块刚被别人改过",
        conflict: "{why}：你写的没存上，留在修订里了",
        image: "图片：{alt} {src}",
        start: "从这里开始写……",
      },
      body: { blocks: "一起写的", html: "网页" },
    },
    "web.base": {
      place: {
        chat: { label: "聊天", hint: "频道和串" },
        issues: { label: "工单", hint: "每张工单从写下到关上" },
        agents: { label: "档案", hint: "档案：管家和帮工" },
        runtimes: { label: "农机", hint: "机器上的编码 agent" },
        projects: { label: "项目", hint: "每个项目一座岛" },
        catalog: { label: "图鉴", hint: "素材：农场用的每张图、每个指针、每个声音，和工作台的界面零件" },
        settings: { label: "设置", hint: "通用、外观、模型、记性、技能、语音、连接" },
      },
      link: { connecting: "连接中", open: "已连上", lost: "断了，重连中" },
      rail: "工作台",
      farm: "回农场",
      working: "开工中 · {n} 个在干活",
      off: "没开工",
      chips: { drop: "去掉 {v}", valueOf: "{k} 的值", removeKey: "删除 {k}", remove: "删除", name: "变量名", value: "变量的值", valueHint: "值", add: "添加" },
      toasts: "提示",
      runtime: "运行工具：{name}",
      owner: "主",
      orchestrator: "管家",
      unreachable: "暂时连不上服务端，请等它恢复后重试。",
      form: {
        asking: "在问服务端……",
        unreachable: "问不到服务端：{why}",
        none: "还没有",
        unset: "还没设",
        removeOnSave: "保存后移除",
        removeKey: "移除 {label}",
        keepKey: "不移除 {label}",
        undo: "撤销",
        storedIn: "存在 {file}",
        keepEmpty: "不改就空着",
        save: "保存",
        reset: "恢复默认",
        never: "算了",
        remove: "删除",
        from: { settings: "存在设置里", config: "来自配置（vibevalley.yaml 或环境变量）" },
        inUse: "在用 {hint}（{from}）",
        fromOnly: "在用（{from}）",
        example: "比如：{value}",
      },
      time: {
        justNow: "刚刚",
        secondsAgo: "{s} 秒前",
        minutesAgo: "{m} 分钟前",
        hoursAgo: "{h} 小时前",
        daysAgo: "{d} 天前",
        monthsAgo: "{m} 个月前",
        yearsAgo: "{y} 年前",
        seconds: "{s} 秒",
        minutes: "{m} 分 {s} 秒",
        hours: "{h} 小时 {m} 分",
        round: { underMinute: "不到 1 分钟", minutes: "{m} 分钟", hours: "{h} 小时", days: "{d} 天" },
        tenths: "{s} 秒",
        today: "今天",
        yesterday: "昨天",
        clock: "{am, select, true {上午{hh}:{mm}} other {下午{hh}:{mm}}}",
        weekdays: { "0": "日", "1": "一", "2": "二", "3": "三", "4": "四", "5": "五", "6": "六" },
        monthDay: "{month}月{day}日",
        month: "{month}月",
        date: "{y} 年 {m} 月 {d} 日",
        day: "{m} 月 {d} 日 星期{weekday}",
      },
      money: { underCent: "不到 ¥0.01", about: "约 {yuan}", spent: "花了 {yuan}" },
      cast: {
        species: { bear: "熊", rabbit: "兔子", fox: "小狐狸", cat: "猫", owl: "猫头鹰", hedgehog: "刺猬", raccoon: "浣熊" },
        outfit: { farmer: "农夫", gardener: "园丁", rain: "雨衣", winter: "冬装" },
        pose: { idle: "待命", walk: "走过来", think: "琢磨", work: "干活", cheer: "做完", worry: "长虫了" },
      },
      reading: "在读……",
      write: "记下",
      secret: { hide: "藏起来", peek: "看一眼" },
      big: "{n} 万",
      file: { pdf: "PDF · 在新标签页里看", remove: "去掉 {name}" },
      lightbox: { label: "看图", prev: "上一张", next: "下一张", original: "打开原图", close: "关上" },
      shortcuts: {
        title: "快捷键",
        place: { everywhere: "到处", composer: "输入框", lists: "菜单和名单", pictures: "看图", farm: "农场", desktop: "桌面版（系统全局）" },
        say: {
          switcher: "跳到频道、串、私聊",
          sheet: "打开这张表",
          close: "关掉对话框、菜单、浮层",
          send: "发出去",
          newline: "换行",
          mention: "叫人",
          editLast: "改自己上一条（输入框空着时）",
          dropReply: "不回复那一条了",
          move: "上下挑",
          pick: "选中",
          flip: "上一张、下一张",
          tool: "拿起第几样农具",
          names: "按住写出院子里每样东西的名字",
          farmMenu: "放下农具，或打开菜单",
          debug: "调试台",
          voice: "跟管家说话（在设置里能换）",
          command: "命令：记工单、让管家记住、叫停、私聊",
        },
      },
      rich: {
        copy: "复制",
        copied: "复制了",
        more: "展开",
        less: "收起",
        lines: "{n} 行",
        diagram: "图",
        diagramFailed: "这张图画不出来：{why}",
        longMore: "展开全文",
        longLess: "收起",
        taskDone: "已完成",
        taskOpen: "没完成",
      },
      updateReady: "{next} 已下好，去「关于」重启",
      intent: { timedOut: "等了太久没回音，可以重试", offline: "没连上农场，这一下没发出去" },
    },
    "web.catalog": {
      ground: { check: "格子", grass: "草地", night: "夜里" },
      tab: { sprites: "图", cursors: "指针", sounds: "音效" },
      shelves: "图鉴的书架",
      find: "找素材",
      background: "底色",
      categories: "分类",
      all: "全部",
      count: "{n} 张，切自 design/pixel/raw。",
      pick: "点一张看大图：尺寸、落脚点、会动的帧，和它是从哪张原图切出来的、怎么重画。",
      findHint: "找：名字、类别、动物、衣服（熊、雨衣、lang-、icon-……）",
      noMatch: "没有对得上的。",
      moves: "动",
      copied: "复制了",
      copy: "复制",
      anchor: "落脚点",
      head: "头",
      zoom: "放大",
      marks: "落脚点和头",
      stop: "停",
      play: "播放",
      frames: "{n} 帧",
      fps: "每秒几帧",
      perSecond: "{n} 帧/秒",
      size: "尺寸",
      pixels: "{w} × {h} 像素",
      from: "来自",
      unrecorded: "没记下来（不再用的旧图）",
      redraw: "重画",
      recut: "重新切",
      cursorsIntro: "鼠标在农场里的样子：平时、指着能点的、拿着工具时。",
      cursorsFind: "找：指针的名字（glove、water、harvest……）",
      cursors: "指针 · {n}",
      cursorsNote:
        "红点是点下去落在哪。平时是手套，指着能点的伸出食指；拿着工具时是那件工具，能用的带闪光，用不上的带禁止标记。切自 design/pixel/raw/ui-cursors.png（design/pixel/process.py ui-cursors）。",
      noCursors: "这个版本没有带上指针的图（assets/cursors）。",
      soundsIntro: "农场里的每个声音，点一下就能听。",
      soundsFind: "找：声音的名字或分组（浇水、院子、coin……）",
      soundsRecipes: "音效都是现合成的，没有音频文件：配方在",
      soundsMusic: "。关了音效就听不到。背景音乐还没有，给 Suno 的提示词在",
      period: "。",
      playSound: "播放 {name}",
      shelf: {
        helpers: { label: "帮工", hint: "七种动物、四套衣服：站、走、干活、欢呼、发愁；在建筑前坐、读、敲、修" },
        orchestrator: { hint: "六种样子，各有说话、听和头像" },
        dog: { label: "狗", hint: "睡、醒、伸懒腰、摇尾巴、叫、跳、翻肚皮……" },
        plots: { label: "地块", hint: "从空地到熟了，长草、干了、枯了、锁着" },
        yard: { label: "院子", hint: "地图、道具、镜头前的草木、小动物" },
        map: { label: "地图", hint: "每个项目一座岛，罗盘、云、排队的种子袋、空位的木桩" },
        machines: { label: "农机", hint: "每台是一种 runtime" },
        icons: { label: "图标", hint: "面板、入口和提示用的" },
        acts: { label: "在做什么", hint: "帮工头上的小图标：读、改、跑命令、搜……" },
        medals: { label: "奖章与成就", hint: "奖章、成就图案、印章、金币" },
        logos: { hint: "农机上的 agent、聊天软件、网页和桌面的图标" },
        langs: { label: "语言", hint: "项目页上种了什么" },
        ui: { label: "界面", hint: "精力瓶、田头的按钮、日历的格子" },
        other: { label: "其他", hint: "没归上类的" },
      },
    },
    "web.channel": {
      tab: { chat: "聊天", issues: "工单", crons: "定时任务" },
      defaultProject: "默认项目 {project}",
      channels: "频道列表",
      defaultHint: "默认的频道：你、管家和帮工都在这儿",
      findHint: "在这个频道里找…",
      find: "在这个频道里找",
      findMessages: "找消息",
      settings: "频道设置",
      inChannel: "频道里的",
      empty: "{label} 还没人说话：跟管家说一件要做的事。",
      sendTo: "发送消息至 {label}",
      side: "频道和帮工",
      channelsTitle: "频道",
      directsTitle: "私聊",
      newChannel: "创建频道",
      helpers: "帮工",
      noHelpers: "没有在场的帮工",
      mood: { idle: "在歇着", listening: "在听", thinking: "在想", speaking: "在说" },
      orchestrator: "管家",
      nobodyOnIt: "现在没有帮工在干，串还留着",
      replies: "{n} 条回复",
      thread: "串",
      closeThread: "关上串",
      threadEmpty: "串里还没人说话。在这里说的话，它的帮工会看到。",
      sayInThread: "在串里说，{name}会看到",
      reply: "回复这个串",
      dialog: {
        projectExample: "比如 clock-in",
        cancel: "取消",
        name: "名称",
        nameHint: "字母、数字、汉字、- 和 _，不超过 24 个字",
        nameExample: "例如 clock-in",
        description: "描述（可不填）",
        descriptionHint: "这个频道是做什么的？",
        project: "默认项目（可不填）",
        projectHint: "在这个频道里派活、没说项目时，就在这个项目里干",
        projectNone: "空着就没有：派活时管家要问在哪个项目",
        settingsOf: "# {name} 的设置",
        save: "保存",
      },
      issues: { empty: "这个频道里还没有工单。在聊天里跟管家说一件要做的事，它会派帮工，工单就列在这里。", thread: "工单串" },
      crons: {
        empty: "还没有定时任务：跟管家说「每天九点跑一遍测试」。",
        next: "下次 {next}",
        direct: "直接派 {agent}",
        byOrchestrator: "管家定的",
        label: "定时任务「{name}」",
        on: "开着",
        off: "关着",
        remove: "删掉",
        removeWhich: "删掉定时任务「{name}」",
        sure: "确定删？",
        approveWhich: "同意定时任务「{name}」",
        approve: "同意",
        refuseWhich: "不要定时任务「{name}」",
        refuse: "不要",
      },
      messages: {
        label: "消息",
        containing: "含「{text}」的消息",
        start: "消息的开头",
        older: "更早的消息",
        notFound: "没有找到",
        thinking: "在想…",
        typing: "正在输入…",
        foldDispatch: "收起派活",
        unfoldDispatch: "展开派活",
        owner: "主人",
        dispatch: "派活",
        spent: "这一轮花了 {spent}",
        unread: "{n} 条新",
        edited: "（已编辑）",
        deleted: "这条消息已删除",
        replyGone: "原消息已删除",
        pinned: "已置顶",
        newMessages: "新消息",
        searching: "在找…",
        inThread: "在 {address}",
        file: "文件 · {size}",
        reactedBy: "{names} 回应了 {emoji}",
        linked: "跳到 {where} 的第 {number} 条",
        newBelow: "有 {n} 条新消息",
        toLatest: "回到最新",
        roundFor: "{what} · {took}",
        sentTo: "派 {who} 去做",
        sending: "发送中…",
        notSent: "没发出去",
        retrySend: "再发一次",
        dropSend: "不发了",
      },
      tools: {
        label: "这条消息能做的",
        react: "回应",
        reply: "回复",
        thread: "开一个串",
        pin: "置顶",
        unpin: "取消置顶",
        edit: "改",
        remove: "删掉",
        sure: "再点一次删掉",
        pick: "选一个回应",
        editHint: "回车存下 · Esc 不改了",
      },
      pins: { open: "置顶的消息", title: "置顶", none: "这里还没有置顶的消息" },
      members: { open: "成员", title: "成员", owner: "主人", none: "这里还没有帮工", looksAfter: "照看这里的管家" },
      composer: {
        notSent: "没发出去：{why}",
        who: "叫谁",
        mention: "@ 叫人",
        stop: "叫停管家",
        stopHint: "叫管家停下这一轮，派出去的帮工照常干活",
        send: "发送",
        sendHint: "回车发送 · Shift+回车换行",
        replying: "回复 {name}",
        cancelReply: "不回复了",
        attach: "附上文件",
        uploadFailed: "没传上去：{why}",
      },
      manage: {
        name: "名称",
        category: "分组（可不填）",
        categoryHint: "侧栏里按分组列频道",
        orchestrator: "照看的管家",
        orchestratorHint: "你在这个频道里说话、没 @ 别人时，是它回答",
        notify: "提醒",
        notifyAll: "全部",
        notifyMentions: "只在 @主人 时",
        notifyNone: "不提醒",
        notifyHint: "不提醒的不算未读、不进 Inbox、不转到微信",
        archive: "归档",
        unarchive: "取消归档",
        archiveHint: "归档的频道不在侧栏里，消息和地址都还在",
        remove: "删除频道",
        removeSure: "确定删除",
        removeWill: "删除以后：",
        archivedTitle: "已归档",
        muted: "不提醒",
        mentionsOnly: "只 @",
        drag: "拖到另一个频道上，排在它前面",
      },
      threadList: {
        title: "这个频道的串",
        none: "这个频道还没有串",
        archived: "已归档的串（{n}）",
        rename: "给「{title}」改名",
        archive: "归档「{title}」",
        unarchive: "取消归档「{title}」",
        notify: "串的提醒",
      },
      more: { label: "更多", copyLink: "复制链接", copied: "链接已复制", markUnread: "从这里标成未读", jump: "跳到这条" },
      switcher: {
        open: "跳到…",
        title: "跳到频道、串或私聊",
        hint: "输入名字；# 只找频道和串，@ 只找私聊",
        none: "没有找到",
        direct: "私聊",
        newDirect: "开一个私聊",
        keys: "{mac, select, true {⌘K} other {Ctrl K}}",
      },
      farmSearch: {
        open: "全部搜索",
        title: "全部搜索",
        hint: "找消息…",
        filters: "from:主人  in:#频道  has:file / image / link  before: / after:2026-10-01",
        none: "没有找到",
        searching: "在找…",
      },
      direct: { add: "开一个私聊", pick: "和谁私聊", none: "还没有档案", open: "和{name}私聊" },
      emoji: { open: "表情", groups: { frequent: "常用", faces: "表情", hands: "手势", things: "东西", nature: "自然", signs: "符号" }, more: "更多表情" },
      media: {
        pdf: "PDF · 在新标签页里看",
        drop: "松手就传到这里",
        uploadingFile: "{name} {percent}%",
        keep: "留着 {name}",
        takeOff: "去掉 {name}",
        preview: "链接预览",
      },
      names: {
        issueThread: "工单串",
        planThread: "计划 {id}",
        talkThread: "{who}的串",
        thread: "串",
        mention: { orchestrator: "@管家", owner: "@主人", everyone: "@所有人" },
        orchestratorNote: "派活、拆计划、问进度",
        everyone: "所有人",
        everyoneNote: "叫醒在场的每个帮工",
      },
      threadWidth: "串的宽窄（拖动，双击回默认）",
      commands: {
        issue: { name: "记一张工单", note: "/issue 标题：记进备选，在这个频道的项目里", needs: "/issue 后面写工单的标题" },
        remember: { name: "让管家记住", note: "/remember 一句话：记进照看这里的管家的记性", needs: "/remember 后面写要它记住的话" },
        stop: { name: "叫停管家", note: "照看这里的管家停下这一轮，派出去的帮工照常干活", needs: "" },
        dm: { name: "私聊", note: "/dm 名字：打开和这份档案的私聊", needs: "/dm 后面写档案的名字或 id" },
        done: { issue: "记下了 #{n}", remember: "记下了", stop: "叫停了" },
      },
    },
    "web.connector": {
      connectors: {
        section: { label: "连接器" },
        label: { weixin: "微信", feishu: "飞书" },
        how: { weixin: "扫码登录，私聊机器人", feishu: "扫码自动建机器人", qq: "填 QQ 机器人的 AppID" },
        notes: {
          weixin: {
            "0": "只认扫码的那个微信：别人给这个机器人发的话进不来。",
            "1": "帮工干完活，汇报马上发到微信上，不用等你先说话。微信偶尔不收时，汇报先攒着，隔一会儿再试（越隔越久，最多半小时），你下次说一句也会一起发过来（多了合成一条）。",
            "2": "用的是腾讯官方给机器人用的接口（和 OpenClaw 的微信插件一样）。",
          },
          feishu: {
            "0": "扫码后，飞书会替你建一个只属于你的机器人应用，不用去开放平台手动配。",
            "1": "建好后在飞书里找到这个机器人，私聊它发配对码：发了码的人就是主人，只有主人的话进得来。只收私聊，群里的不收。",
            "2": "飞书的机器人可以随时给你发消息，汇报不用等你先说话。",
          },
          qq: {
            "0": "QQ 没有扫码建机器人：先在 QQ 开放平台（q.qq.com）建一个机器人，打开「单聊」消息，把 AppID 和 AppSecret 填在这里。",
            "1": "用你自己的 QQ 加这个机器人，私聊它发配对码：发了码的人就是主人。只收私聊。",
            "2": "QQ 只让机器人在你说话后的一小段时间里回复。过了时间的汇报先攒着，隔一会儿再试，你下次说一句就一起发过来。",
          },
        },
        always: "帮工能在这台电脑上跑命令，所以只认主人；回复时引用某条汇报，你的话会进那件活的工单串。VibeValley 只往外连，不开端口。",
        state: {
          off: "没连接",
          waiting: "等你扫码",
          scanned: "已扫码，等手机确认",
          verify: "要输入手机上的数字",
          pairing: "等你发配对码",
          connected: "已连接",
          paused: "暂停中",
        },
        list: "连接器列表",
        intro: "在聊天软件里和管家说话：派活、问进度、收汇报。",
        know: "要知道的",
        disconnect: "断开",
        weixinIntro: "用手机微信扫一个码，就能在微信里和管家说话：派活、问进度，帮工的汇报和提问也会发到微信上。",
        feishuIntro: "用手机飞书扫一个码，飞书会替你建一个机器人；在飞书里和它说话，就是和管家说话。",
        scan: "{app}扫码登录",
        pairing: "机器人连上了。最后一步：用你自己的{app}，私聊这个机器人，发：",
        pairingNote: "发了这个码的人就是主人：以后只有这个人的话进得来。码只能用一次。",
        owner: "主人",
        channel: "接在",
        since: "连上的时间",
        lastInbound: "上次收到你的话",
        pending: "等着发给你的",
        pendingCount: "{n} 条：你下次说话时一起发",
        noPending: "没有",
        paused: "登录过期了，{clock} 后再试；也可以断开重新连。",
        whichChannel: "接在哪个频道",
        qqBefore: "在",
        qqPlatform: "QQ 开放平台",
        qqAfter: "建一个机器人，打开单聊消息，把它的 AppID 和 AppSecret 填在这里。",
        secretHint: "只存在这台电脑的数据库里，不会再显示。",
        secret: "机器人密钥",
        connectQq: "连接 QQ 机器人",
        scanWith: "用手机{app}扫这个码。",
        scanned: "扫好了，在手机上点确认。",
        digits: "输入手机上显示的数字：",
        gettingQr: "在拿二维码……",
        qr: "{app}登录二维码",
        phoneDigits: "手机上的数字",
        ok: "确定",
        cannotScan: "扫不了？在手机上打开这个链接：",
        newCode: "换一个码",
      },
    },
    "web.farm": {
      reading: "在读……",
      unread: "读不到。",
      never: "算了",
      notNow: "先不收",
      orchestrator: "管家",
      plotOf: "{name}的地",
      plot: {
        unread: "这块地的工单还没读到。",
        failed: "没办成",
        now: "现在怎样",
        yours: "要你做的",
        answerTo: "回答：{question}",
        rejectWhere: "哪里没过，一行一条",
        sayIt: "自己说……",
        reopenWhat: "这次要它做什么（不填就是接着做完）",
        tellWorking: "干着活也能收到这句话",
        tellIdle: "说一句，它接着做一轮",
        rejectLabel: "哪里没过",
        answer: "回答",
        reopen: "重开这张工单",
        tell: "给{who}带句话",
        onBoard: "在看板上看",
        progress: "做到哪了",
        progressMet: "做到哪了 · {met} / {of} 条做到了",
        noCriteria: "{answer, select, true {这张工单没写做完的标准：交回来时看结论判断。} other {这张工单没写做完的标准：交回来时看改动判断。}}",
        rejected: "上次打回 · {text}",
        conclusion: "结论",
        evidence: "依据 · {line}",
        next: "接着做 · {line}",
        made: "做出了什么",
        madeNothing: "做出了什么：还没有改动",
        madeFiles: "做出了什么（{n} 个文件）",
        changesUnread: "读不到改动。",
        moreFiles: "还有 {n} 个文件",
        story: "怎么走到这一步",
        steps: "帮工的每一步",
        runs: "每一轮",
        details: "详情",
        job: "要做的",
        who: "谁在做",
        crew: "地上的人",
        review: "验收",
        deliver: "交付",
        reviewed: "已验收 {clock}",
        weeded: "拔了的草",
        weed: "已拔 · {text}",
        model: "模型",
        branch: "分支",
        copyPath: "复制路径",
        opened: "开单",
        closed: "关单",
        history: "做过",
        took: "用时",
        thread: "看工单串",
        graph: "看计划",
        where: "第 {plot} 块地 · 第 {round} 轮",
        result: { met: "它说做到了", unmet: "它说没做到", unsure: "它说不确定" },
        ticked: "看过了",
        noRuns: "还没有干过。",
        runCount: "{n} 次",
        conflict: "合进 {base} 会冲突：{files}",
      },
      graph: {
        name: "种植计划",
        new: "新计划",
        intro:
          "一件很长的活：先派一个帮工读代码，把它拆成几步，每步交给一个帮工，有先后。拆好了你看过、改过再开工；每步做完合进计划自己的分支，全做完你再一次收进主分支。",
        goal: "要做什么",
        goalExample: "比如：给 clock-in 加按月查询打卡记录，带一个页面，要有测试",
        project: "在哪个项目",
        splitter: "谁来拆",
        byRule: "按规则挑",
        split: "拆计划",
        steps: "{done}/{of} 步",
        spent: "花了 {spent}",
        projectTag: "项目 {project}",
        running: "每步做完合进这条分支；收获时整条合进主分支",
        addStep: "加一步",
        review: "看改动，{merge}…",
        abandon: "{abandon}这个计划",
        abandonSure: "确定放弃？分支会留着",
        splitting: "帮工在读代码、拆计划。拆好了会出现在这里，你看过再开工。",
        no: "不了",
        readingChanges: "正在看计划分支改了什么…",
        unreadable: "看不了改动：",
        summary: "{branch} → {project} 的 {base}：{commits} 个提交，{files} 个文件，",
        behind: "；这期间 {base} 多了 {n} 个提交",
        commits: "提交",
        files: "文件",
        harvest: "确认收获，合进 {base}",
        noSteps: "计划里还没有一件。",
        first: "先做",
        batch: "第 {n} 批",
        acceptanceHint: "验收：写好时要不通过，最后一步让它通过",
        checkHint: "做完跑 {check}",
        edit: "改",
        remove: "删",
        story: "经过",
        stepId: "这一件的 id",
        stepIdHint: "这一件的 id，比如 docs",
        title: "标题",
        brief: "工单",
        briefHint: "工单：目标、改哪里、做到什么程度算完",
        whoHint: "谁来做：按规则挑",
        who: "谁来做",
        check: "检查命令",
        checkExample: "做完跑的检查，比如 pnpm test（可空）",
        waitFor: "等这些做完：",
        done: "改好了",
        add: "加上",
        storyOf: "「{title}」的经过",
        wholeStory: "看整个计划的经过",
        nothing: "还没有记下什么。",
        readingStory: "正在读…",
        beforeAfter: "改前改后",
        empty: "（空）",
        conflict: "合进 {base} 会冲突：{files}。先不收，等 {base} 上的改动处理好。",
        frozen: "验收，冻结了：{files}",
        waits: "等 {titles}",
        after: "接在 {titles} 后面",
        onPlot: "{name} · 第 {plot} 块地",
        onPlotDoing: "{name} · 第 {plot} 块地 · 在{doing}",
      },
      achievements: {
        tier: { "1": "铜", "2": "银", "3": "金" },
        category: { starter: "新手任务", harvest: "收成", craft: "手艺", thrift: "精打细算", team: "协作", secret: "彩蛋" },
        clearing: "开垦",
        clearAt: "Lv.{level} 开垦一块地",
        toLevel: "再 {left} 个 commit 升级 · 共 {total} 个",
        toNext: "到下一级的 commit",
        streak: "连胜 {n} · 收成金币 ×{multiplier}",
        coinsOnMerge: "收进主分支才给金币",
        title: "称号",
        pick: "挑一个",
        earnFirst: "拿到成就就有",
        titles: "挂在农场卡上的称号",
        worn: "挂着",
        none: "不挂称号",
        starterDone: "新手任务都做完了。",
        starter: "新手任务 {done}/{of}",
        perStarter: "每做完一个 +{coins} 金币",
        done: "做完了",
        tiers: "{tier}/{of} 档",
        toTier: "到{tier}档",
        secrets: "还有 {n} 个彩蛋",
        secretsLine: "碰上了才知道是什么。",
        day: "{month}月{day}日",
        earned: "{day}拿到",
        earnedTier: "{day}拿到{tier}牌",
      },
      sow: {
        notDrafted: "先没起草",
        homeless: "这座农场不是哪个项目的",
        toMap: "种地要先进一个项目的农场：回地图挑一座岛。",
        noProjects: "工作台里还没有项目：先在「项目」页开一个。",
        map: "去地图",
        makeProject: "去开一个项目",
        plantIn: "种在 {project}",
        rummaging: "在翻种子袋……",
        noSeeds: "种子袋没拿到：",
        retry: "重新拿种子袋",
        recent: "最近",
        kinds: "常见的活",
        own: "自己写",
        jobHint: "要做什么，做到什么程度算完",
        job: "工单",
        who: "谁来种",
        orchestratorPicks: "管家挑",
        how: "开始：管家把这句话交给帮工，在 {project} 里马上开工。草稿：帮工读过代码写成工单，你看过再开工。",
        draft: "草稿",
        start: "开始",
      },
      water: {
        drops: { "0": "改动小一点", "1": "先别动测试", "2": "做完跟我说一声", "3": "顺便补个测试" },
        working: "它正在干活，这句话会在下一步之前收到。",
        idle: "它现在没在干活，这句话会让它接着干一轮。",
        thread: "这句话记在它的工单串里，它回的话也在那儿。",
        job: "现在的活：{brief}",
        hint: "带句话……",
        water: "浇水",
        moved: "工单状态变了，先回到地块看看要你做的事。",
      },
      harvest: {
        reading: "正在看它改了什么…",
        project: "项目 {project}",
        counts: "{commits} 个提交 · {files} 个文件",
        none: "这一单没有改动。收获就是请它收工。",
        conflict: "合进 {base} 会冲突，先没法收",
        resolveHow: "让它在自己的分支上把 {base} 合进来、解决冲突、跑一遍测试再提交；做完再来收。",
        behind: "它干活这段时间，{base} 上多了 {n} 个提交；收获时会合在一起（多一个合并提交）。",
        uncommitted: "还有 {n} 个文件没提交，收获时会先帮它提交：",
        letGo: "请它收工",
        take: "确认收获，合进 {base}",
        resolve: "让它解决冲突",
        files: "改了的文件",
        empty: "仓库还空着。收获进主分支的活会放在这里。",
        graph: "种植计划",
        taken: "{ago}收的",
      },
      panel: {
        shop: "商店",
        warehouse: "仓库",
        graphs: "任务与成就",
        log: "农场日志",
        orchestrator: "管家和宠物",
        taskBoard: "种植计划",
        harvest: "收获{name}的地",
        sow: "播种 · 第 {plot} 块地",
        water: "给{name}浇水",
        menu: "菜单",
        pickLook: "挑一个你喜欢的管家，农场和对话里马上换上。",
        drawing: "还在画……",
        pets: "宠物",
        shopItems: {
          scarecrow: { name: "稻草人", note: "吓跑乌鸦，好看" },
          seeds: { name: "新种子包", note: "常用工单模板" },
          bunting: { name: "彩旗", note: "挂在篱笆上" },
          doghouse: { name: "狗窝", note: "给管家的狗" },
        },
        shopClosed: "商店还在装修，下一版开张。现在有 {coins} 金币，先攒着。",
      },
      menu: {
        chat: "田头（频道）",
        agents: "帮工名册",
        runtimes: "农具",
        skills: "技能书",
        connectors: "连接器",
        projects: "项目",
        catalog: "图鉴",
        resume: "继续",
        home: "回到首页",
        soundOn: "打开音效",
        soundOff: "关闭音效",
        elsewhere: "去别处",
        issues: "工单",
        yard: "院子里能点的",
      },
      log: { empty: "还没有事。开工以后，你和管家说的话、谁做完了什么，都记在这里。", you: "你", said: "说", answered: "答", spent: "这一轮花了 {spent}" },
      conflictTag: "冲突",
      binary: "二进制",
      chat: {
        actions: {
          open: "这条消息能做的",
          react: "回应",
          moreEmoji: "更多表情",
          reply: "回复",
          copyLink: "复制链接",
          copied: "链接已复制",
          edit: "改",
          remove: "删掉",
          sure: "再点一次删掉",
          editHint: "回车存下 · Esc 不改了",
          cancelReply: "不回复了",
        },
        edited: "（已编辑）",
        deleted: "这条消息已删除",
        suggestions: { "0": "让阿郑做字幕面板", "1": "让小吴跑测试", "2": "进度怎么样？", "3": "大家收工" },
        greeting:
          "这里是田头，你、管家和帮工都在这儿说话。跟我说一句要做的活，比如「让测试小吴跑一遍测试」。\n\n帮工来了以后，写 @w1 这样的名字就是直接叫它；每张工单下面挂着它的工单串。",
        phase: {
          off: "打字或者按麦克风，就开工",
          connecting: "正在接通管家…",
          listening: "管家在听",
          thinking: "管家在想…",
          speaking: "管家在说",
          error: "没接通，再试一次",
        },
        newIn: "{n} 处有新话",
        newInThread: "串里有新话",
        newInChannel: "{channel}有新话",
        label: "田头",
        restore: "还原对话窗口",
        enlarge: "放大对话窗口",
        fold: "收起对话",
        thread: "工单串",
        older: "更早的消息",
        threadEmpty: "串里还没人说话。在这里说的话，它的帮工会看到。",
        sending: "发送中",
        captions: "实时字幕",
        done: "说完了",
        speaking: "正在说",
        notSent: "没发出去：{why}",
        noVoice: "语音没接通：{why}",
        gotIt: "知道了",
        settings: "去设置",
        nobodyOnIt: "现在没有帮工在干，串还留着",
        replies: "{n} 条回复",
        back: "回到{channel}",
        dispatch: "派活",
        channel: "频道：{channel}，点开切换或开新频道",
        channels: "频道",
        directs: "私聊",
        projectTag: "项目 {project}",
        newChannel: "开新频道",
        pageAndSchedules: "频道页和定时任务",
        settingsLink: "设置",
        back2: "返回",
        newChannelLine: "一件长期的事、一个项目，单独一个地方说话、派活。在这里叫管家，活就派在这里。",
        nameHint: "名字，比如 clock-in",
        name: "频道名",
        descriptionHint: "做什么的（可以不填）",
        description: "频道说明",
        projectHint: "默认项目（可以不填）",
        project: "默认项目",
        open: "开",
        settingsOf: "{channel} 的设置",
        what: "做什么的",
        projectNone: "默认项目（空着就没有）",
        save: "存",
        sendTo: "派给{name}",
        anyone: "不指定帮工",
        inThread: "在串里说，{name}会看到…",
        inThreadAnyone: "在串里说…",
        toOrchestrator: "对管家说，@ 叫帮工…",
        toOrchestratorAlone: "只对管家说…",
        who: "叫谁",
        stop: "叫管家停下",
        stopHint: "叫管家停下这一轮，派出去的帮工照常干活",
        send: "发送",
        less: "收起",
        more: "展开阅读",
        foldDispatch: "收起派活",
        unfoldDispatch: "展开派活",
        spent: "这一轮花了 {spent}",
        newCount: "{n} 新",
        replyTo: "回复 {name}",
        replyToText: "回复 {name}：{text}",
        notSentLine: "没发出去",
        retrySend: "再发",
        dropSend: "不发了",
      },
      tool: {
        hand: { label: "手", hint: "点一块地看详情，点空地播种" },
        water: { hint: "给帮工带句话，正在干活的会中途收到" },
        bug: { label: "杀虫", hint: "活没做成（地里有虫）：让它接着修" },
        weed: { label: "除草", hint: "没过验收的意见会长成杂草：帮工修完、下一次验收通过就拔掉" },
        harvest: { label: "收获", hint: "熟了的地：收下成果，帮工收工" },
        shovel: { label: "铲除", hint: "正在干活的叫停；没在干活的请它收工" },
      },
      aim: {
        flowerbed: "开垦好的花坛",
        clearAt: "Lv.{level} 开垦这块地",
        unread: "这块地的工单还没读到",
        look: "看看这块地",
        sow: "播种",
        water: "给{name}浇水（带句话）",
        nothingYet: "还没种东西，先用手播种",
        bug: "杀虫：让它接着修",
        noBugs: "这块地没有虫",
        weeds: "帮工修完、验收通过草就拔了",
        noWeeds: "没有杂草",
        harvestRipe: "收获，帮工收工",
        harvestLook: "收获：看看它改了什么",
        nothingToHarvest: "空地没有东西可收",
        shovelStop: "铲除：叫停",
        shovelDismiss: "铲除：请它收工",
        noShovel: "空地不用铲",
        unavailable: "这张工单{state}，先打开地块看看",
      },
      command: { cannot: "这张工单现在不能「{act}」", stored: "收进仓库", noShovel: "这张工单现在不能铲除", changed: "这块地已经变了，请重新点一次" },
      page: { lost: "连不上农场，重连中……（server 开着吗？）", waiting: "在等农场……" },
      hud: {
        label: "农场的 HUD",
        look: "换管家的样子",
        workbenchHint: "工单、聊天……管活的页面",
        workbench: "工作台",
        treeHint: "记忆树：农场学会了什么",
        tree: "记忆树",
        mapHint: "地图：每个项目一座岛",
        map: "地图",
        channelsUnread: "频道，{n} 条没读",
        menuHint: "菜单（Esc）",
        tools: "农具",
        toLevel: "{xp}/{need} commit",
        toLevelNext: "{xp}/{need} commit · Lv.{next} 开垦",
      },
      quota: {
        unreported: "不报额度",
        signedOut: "没登录，额度读不到",
        unreadable: "读不到：{why}",
        balance: "{enough, select, true {按量计费 · {provider} 余额} other {按量计费 · {provider} 余额，不够用了}}",
        all: "各台农机 的剩余额度",
        lowest: "剩余额度，最少的还剩 {pct}%",
        quota: "额度",
        left: "剩余额度",
        refresh: "现在读一次额度",
        note: "从各家账户读来，几分钟更新一次；帮工干完一轮也会更新。",
        spentToday: "今天花了约 {spent}",
        spentTodayBudget: "今天花了约 {spent} / 预算 {budget}",
      },
      friends: {
        status: { bug: "地里有虫", ripe: "熟了，等你收", busy: "在干活", rest: "在地里歇着", away: "没在农场" },
        tally: " · 请过 {hired} 次，收成 {harvested} 次",
        energy: "精力 {short}",
        disabled: "停用了，派不出去",
        unpick: "不再指定",
        pick: "下一单派它",
        profile: "档案",
        helpers: "帮工",
      },
      fx: { coins: "{detail} · +{coins} 金币", notice: "提示", levelUp: "农场升到 Lv.{level}", level: "农场 Lv.{level}", cleared: "开垦了一块新地" },
      sign: { label: "项目牌：{project}", noProject: "没有项目", hint: "这座农场是这个项目的；点它回地图，进别的岛", project: "项目" },
      overlay: {
        click: "点击：{text}",
        clearAt: "Lv.{level} 开垦",
        idle: "今天种点什么？",
        unclaimed: "没开垦的地",
        flowerbed: "花坛",
        bare: "第 {plot} 块地 · 空地",
      },
      crop: {
        empty: "空地",
        seeded: "刚播种",
        sprout: "发芽",
        leafy: "长叶",
        flowering: "开花",
        wheat: "成熟",
        withered: "枯萎",
        weeds: "长草",
        dry: "干旱",
        harvested: "收完了",
        locked: "没开垦",
      },
      yard: {
        shop: { hint: "种子、装饰、开垦新地" },
        warehouse: { hint: "收进来的成果" },
        tasks: { hint: "新手任务、开垦、成就墙" },
        log: { hint: "说过的话和收成，按时间倒着排" },
        taskBoard: { label: "种植计划", hint: "一件长活拆成几步，交给几个帮工" },
        agents: { hint: "每个帮工用哪台农机、带什么人设和技能、长什么样" },
        manager: { hint: "跟管家说话" },
        runtimes: { label: "工坊 · 农具", hint: "每台农机是一种 runtime：装没装、用量" },
        skills: { label: "书屋 · 技能书", hint: "帮工能带的技能" },
      },
      canvas: {
        label: "码农场物语的像素农场",
        noMap: "没拿到村子的地图：{why}",
        map: "看地图……",
        moving: "搬东西进村 {done}/{total}",
        lights: "点灯……",
        entering: "进村",
      },
      title: {
        start: "开始游戏",
        continue: "继续游戏",
        keyFirst: "先填钥匙：管家要 DeepSeek 的 API Key 才能干活，在设置里填上。",
        label: "码农场物语 首页",
        name: "码农场物语",
        tagline: "一群写代码的小动物，等你来派活",
        nothingToContinue: "还没有农场可以继续：先开始游戏。",
      },
      debug: {
        title: "调试台",
        close: "关闭 `",
        call: "通话",
        open: "开工",
        dismiss: "收工",
        sky: "天色",
        time: "时间",
        stop: "停",
        progress: "游戏进度",
        levelUp: "升一级（带横幅）",
        achievement: "弹一个成就",
        helpers: "帮工 · {n}",
        nobody: "地里没人。",
        halt: "叫停",
        all: "全部",
        haltAll: "全部叫停",
        dismissAll: "全部收工",
        frames: "帧和事件 · {n}",
        resume: "接着记",
        pause: "暂停",
        clear: "清空",
        copy: "复制 .jsonl",
      },
    },
    "web.farm.map": {
      finding: "在找……",
      islands: "{n} 座岛",
      peopled: "{n} 座有人",
      working: "在做 {n}/{of} 张",
      queued: "排队 {n}",
      stake: "空位，点了派活",
      locked: "空位都占着",
      sack: "排队的活",
      send: "派一件活 · {project}",
      plot: "{name}的地",
      open: "空位，派一件活到 {project}",
      wait: "等地",
      queuedTip: "排队：{title}",
      queuedLabel: "排队的活：{title}",
      enter: "进{project}的农场",
      enterWord: "进岛",
      homeless: "不在哪个项目里：",
      sea: "工作目录下还没有项目，地图上还是一片海。",
      notDrafted: "先没起草：{why}",
      sowIntro: "种在 {project}：写一句要做的事，管家派帮工来干；或者先写成待办，看过再开工。",
      job: "要做的事",
      jobExample: "比如：登录页加一个「记住我」",
      todo: "先写成待办",
      sow: "种下",
      gone: "工作目录里没有这个项目了，只剩还在岛上的帮工。",
      worktrees: "worktree · {n} 个",
      noHelpers: "岛上还没有帮工：每派一件活来，就多一个 worktree。",
      noMore: "不再往这里派活。",
      canSend: "还能再派 {n} 件活，马上开工（这个项目最多同时 {of} 个帮工）。",
      shut: "已经有 {n} 张工单在做，派来的活先排队。",
      full: "满了：{n} 个帮工都在干活，派来的活先排队。",
      queue: "排队 · {n} 件",
      see: "看这张工单",
      growth: "长势 · {label}",
      growthSince: "长势 · {label} · 最近一次提交：{since}",
      crop: { never: "还没动过土", day: "正旺", week: "在长", month: "冒着芽", quarter: "有点干了", older: "荒了" },
      island: {
        branch: "\n分支 {branch}",
        open: "空位：派一件活来，马上开工",
        shut: "已经有 {n} 张工单在做，等有工单做完",
        gone: "不在工作目录里了",
        working: "{full, select, true {在干 {n}/{of}（满了）} other {在干 {n}/{of}}}",
        queued: "排队 {n}",
      },
    },
    "web.farm.phone": {
      ringing: "来电…",
      decline: "挂断",
      answer: "接听",
      callOrchestrator: "打给管家",
      missed: "未接 {n}",
      log: "记录",
      noCalls: "还没有通话。",
      answered: "接了",
      declined: "挂了",
      noMissed: "没有未接来电。地里都好好的。",
      phase: {
        connecting: "正在接通……",
        live: "通话中：说吧，管家在听",
        coming: "通话中：管家在路上",
        ending: "挂断中……",
        failed: "没接通：{why}",
        idle: "有事直接说，工单交回来、卡住了，管家也会打过来。",
      },
      manager: "管家",
      hangUp: "挂断",
      app: { missed: "未接", channels: "频道", graphs: "计划", games: "游戏" },
      game: { blocks: "方块", sokoban: "推箱子", dino: "小恐龙", bugs: "贪吃虫", merge: "种田 2048" },
      phone: "手机",
      phoneRinging: "手机：来电",
      phoneMissed: "手机，{n} 个未接来电",
      phoneUnread: "手机，田头 {n} 条新消息",
      ring: "来电",
      new: "新",
      label: "农场手机",
      home: "主屏",
      homeHint: "回主屏",
      brand: "农场通",
      openChat: "展开田头",
      openChatUnread: "展开田头，{n} 条新消息",
      key: { up: "上", left: "左", right: "右", down: "下" },
      pressA: "按 A {what}",
      again: "再来",
      start: "开始",
      resume: "继续",
      paused: "暂停",
      sokoban: {
        levels: { "0": "第一箱种子", "1": "绕到后面", "2": "两箱收成", "3": "仓库拐角", "4": "丰收入仓" },
        title: "推箱子 {level}/{of}",
        moves: "{moves} 步 · {pushes} 推",
        board: "仓库棋盘，{placed}/{of} 箱已归位",
        allIn: "收成全部入仓！",
        done: "这一仓收拾好了！",
        goal: "把木箱推到 ◆ 上",
        undo: "B 撤销",
        again: "再玩一轮",
        next: "下一关",
        restart: "重开",
        help: "方向键走动 · 箱子只能推",
      },
      dino: { road: "小恐龙的路", crashed: "撞上了", help: "A 或 ↑ 跳，↓ 或 B 蹲", help2: "跑得越远越快，后面会有鸟" },
      merge: {
        start: "按 A 开始",
        restartAsk: "重新种这块地？",
        restartKeys: "A 重开 · B 接着种",
        harvest: "丰收了！",
        goOn: "按 A 接着种",
        full: "地种满了 · {score} 分",
        overKeys: "按 A 再来 · B 悔一步",
        reached: "种到 {stage}",
        field: "田里：{n} 株，最高 {top}",
        stages: "收成图鉴",
        help: "方向键或划一下：一样的两株长成下一样",
        help2: "B 悔一步 · A 重开",
        stage: { "0": "种子", "1": "芽", "2": "叶", "3": "花", "4": "麦子", "5": "胡萝卜", "6": "麦捆", "7": "一筐", "8": "一车", "9": "粮仓", "10": "丰收" },
        past: "丰收{n}",
      },
      bugs: {
        ended: { wall: "撞到田埂了", self: "咬到自己了", full: "田里爬满了" },
        tally: "种子 {seeds} · 虫 {bugs}",
        field: "贪吃虫的田",
        help: "方向键转弯，B 暂停",
        help2: "吃种子长一节，虫子飞走前吃掉多得分",
      },
      blocks: {
        well: "方块的井",
        noRoom: "没地方了",
        score: "分数",
        lines: "行",
        level: "级",
        best: "最好",
        help: "←→ 移 ↑ 转",
        help2: "↓ 落 A 到底",
        help3: "B 暂停",
        next: "下一个",
      },
      chatTab: "田头",
    },
    "web.inbox": { tray: { working: "{n} 个帮工在干活", idle: "开工了，没有在干的活", off: "还没开工", unread: "频道 {n} 条没读" } },
    "web.issue": {
      reading: "在读……",
      never: "算了",
      later: "先放着",
      orchestrator: "管家",
      noHelper: "还没选帮工",
      board: {
        add: "＋ 写一张，回车存下",
        addLabel: "写一张待办",
        earlier: "更早的 {n} 张",
        recent: "只看最近的",
        empty: {
          todo: "想到要做的先写在这里，拖到「处理中」就派人开工；上下拖排先后。",
          working: "没有在干的活。",
          waiting: "做完的、没做成的在这里等你看；拖到「已关」完成或取消。",
          closed: "已完成、已取消的工单；拖回「处理中」重开。",
        },
        whichLane: "看哪一列",
        spots: "{taken} / {of} 个空位",
        moveFailed: "没挪过去",
        retryMove: "再挪一次",
        putBack: "放回原处",
      },
      display: {
        boardNote: "看板总按状态分列，拖过去就改状态；分组用在列表上。",
        orderNote: "不是「默认」排序时，待办不能上下拖着排先后。",
        defaultNote: "「默认」是待办里你排的先后。",
        show: "显示",
        group: "分组",
        order: "排序",
        reset: "恢复默认",
      },
      list: { noProject: "没有项目", all: "全部工单", unfold: "展开 {group}", fold: "收起 {group}", writeIn: "在「{group}」写一张" },
      page: {
        pickFirst: "还差一点：选好派哪个帮工、在哪个项目里做，再点「开工」。",
        notDrafted: "先没起草：{why}",
        historyUnread: "工单记录没读到：",
        notFound: "找不到这张工单",
        notFoundLine: "没有 {id} 这张工单：可能已经删掉了，或者链接写错了。",
        find: "找工单：标题、帮工、项目",
        findLabel: "找工单",
        filter: "筛选",
        byProject: "按项目看",
        allProjects: "所有项目",
        byHelper: "按帮工看",
        allHelpers: "所有帮工",
        shown: "{shown} / {of} 张",
        clear: "清掉筛选",
        view: "看法",
        missing: "这一轮的记录缺失：{what}。对它的操作暂不可用。",
        backToBoard: "工单",
      },
      marks: { priority: "优先级：{word}" },
      sheet: { less: "收起", more: "更多", at: "在「{stage}」", stageDone: "{stage}做完了" },
      acts: { reopened: "工单重开了", goesOn: "{helper} 接着做。", rejectWith: "打回，照上面修", carry: "带过去" },
      close: {
        title: "关上「{issue}」",
        working: "{who} 还在干这张工单。取消就是叫停它、让它收工，分支上的改动不合进主分支。",
        completable: "完成就是把 {who} 的分支合进项目的主分支，先看一遍改动；取消就是让它收工，改动不合进去。",
        notCompletable: "这张工单现在不能完成。取消会让 {who} 离开，改动不合进主分支。",
        review: "看改动，完成",
        stopAndCancel: "叫停并取消",
        cancel: "取消工单",
      },
      changes: {
        reading: "正在看它改了什么…",
        unreadable: "看不了改动：",
        none: "这一单没有改动。完成就是请它收工。",
        conflict: "合进 {base} 会冲突，先没法完成",
        resolveHow: "让它在自己的分支上把 {base} 合进来、解决冲突、跑一遍测试再提交；解决了再来完成。",
        behind: "它干活这段时间，{base} 上多了 {n} 个提交；完成时会合在一起（多一个合并提交）。",
        uncommitted: "还有 {n} 个文件没提交，完成时会先帮它提交：",
        letGo: "完成，请它收工",
        merge: "完成，合进 {base}",
        resolve: "让它解决冲突",
        moved: "工单状态变了，先回到工单看看要你做的事。",
        counts: "{commits} 个提交 · {files} 个文件",
        commits: "提交 {n}",
        files: "改了的文件 {n}",
        conflictMark: "冲突",
        binary: "二进制",
      },
      reopen: {
        title: "重开这张工单",
        line: "「{issue}」由同一份档案的新帮工接着做，它会知道这张工单原来要做什么、上一次是怎么关的。",
        what: "这次要它做什么（不填就是接着做完）",
        whatLabel: "这次要做什么",
        reopen: "重开",
      },
      detail: {
        now: "现在怎样",
        yours: "要你做的",
        rejectWhere: "哪里没过，一行一条",
        rejectLabel: "哪里没过",
        sayIt: "自己说……",
        answer: "回答",
        tell: "给{who}带句话",
        tellSection: "带话",
        tellWorking: "干着活也能收到这句话",
        tellIdle: "说一句，它接着做一轮",
        progress: "做到哪了",
        met: "{met} / {of} 条做到了",
        noCriteria: "{answer, select, true {这张工单没写做完的标准：交回来时看结论判断。} other {这张工单没写做完的标准：交回来时看改动判断。}}",
        rejected: "上次打回的",
        made: "做出了什么",
        nothingToSee: "没有可看的改动。",
        noAnswer: "还没有结论。",
        noChanges: "还没有改动。",
        changedFiles: "改了哪些文件",
        fileCount: "{n} 个",
        changesUnread: "读不到改动。",
        story: "怎么走到这一步",
        unread: "读不到。",
        full: "要做的（完整说明）",
        steps: "帮工的每一步",
        runs: "每一轮",
        time: "时间",
        opened: "开单",
        started: "开工",
        waiting: "在等你",
        since: "{clock} 起",
        reviewed: "验收过",
        closedAt: "关单",
        who: "谁在做",
        helper: "帮工",
        model: "模型",
        deliver: "交付",
        crew: "一起干活的",
        profile: "档案",
        branch: "分支",
        copyPath: "复制路径",
        took: "用时",
        resolved: "已解决的验收意见",
        answerTo: "回答：{question}",
        result: { met: "它说做到了", unmet: "它说没做到", unsure: "它说不确定" },
        ticked: "看过了：{criterion}",
        unsaid: "它还没说",
        noRuns: "还没有干过活。",
        runCount: "{n} 次",
        stepCount: "{n} 步",
        stepsAndTools: "{n} 步 · 用了 {tools} 个工具",
        step: {
          "run/start": "开工",
          "user/message": "听到",
          "memory/recalled": "想起",
          "assistant/thinking": "想",
          "assistant/message": "说",
          "tool/call": "用工具",
          "llm/retry": "重试",
          "run/error": "出错",
          "run/end": "这一轮结束",
        },
        orchestratorStuck: "管家这一轮没答成：在频道里看它说了什么",
        job: "要做的",
        from: "来自",
        fromCron: "定时任务：每次到点交给管家，答完等你看",
        answered: "在它的频道里",
        evidence: "依据",
        unsure: "拿不准的",
        next: "建议接着做",
        conflict: "合进 {base} 会冲突：{files}",
        graphStep: "计划「{graph}」的一件",
        backToGraph: "回到计划",
      },
      task: {
        label: "计划",
        steps: "{n} 件",
        done: "做完 {done} / {of} 件",
        waitsForYou: "有一件在等你：打开它回答或者验收。",
        splitting: "管家在把它拆成几件，拆好了会列在下面。",
        ok: "好了。",
        check: "检查",
        scope: "改哪里",
        conclusion: "结论",
        spent: "花了",
        tried: "试了",
        tries: "{n} 次",
        open: "打开这张工单",
        review: "看改动，{merge}…",
        state: "状态",
        project: "项目",
        progress: "进度",
        progressLine: "{done} / {of} 件",
        parallel: "同时做",
        atMost: "至多 {n} 件",
        written: "写于",
        note: "备注",
        abandonTitle: "{abandon}这个计划？",
        abandonLine: "还没做完的几件不再派出去；计划分支留着，做好的提交都还在。",
        abandon: "确定放弃",
        reading: "正在看计划分支改了什么…",
        behind: "这期间 {base} 多了 {n} 个提交",
        merge: "合进 {base}",
        layer: "第 {n} 批",
        layerTogether: "第 {n} 批 · 这 {size} 件可以同时做",
        waitsOn: "等「{steps}」",
        stepSeparator: "」「",
        conflict: "合进 {base} 会冲突：{files}。先不合，等 {base} 上的改动处理好。",
      },
      todo: {
        queued: "排上队了：空位都满了，有空位就自动开工。",
        refining: "{who}在起草",
        refiningLine: "它在读代码，写好了会填进下面各栏。",
        questions: "草稿写好了，它有 {n} 个问题要问你",
        questionsLine: "在下面回答，它照你的回答再起草一版。",
        drafted: "草稿写好了",
        draftedLine: "看一遍、改一改，没问题就开工。",
        what: "想做什么？",
        whatLine: "写一句就行：帮工读过代码，替你写成工单。",
        titleHint: "比如：给登录页加上记住我",
        title: "标题",
        descriptionHint: "说明：为什么、要做的、不做的、可能涉及哪些文件（起草会写好）",
        description: "说明",
        criteria: "验收标准",
        noCriteria: "还没写",
        criteriaSummary: "{n} 条 · {first}",
        criteriaHint: "一行一条：你验收时照着看的点",
        talk: "和帮工聊清楚",
        answerTo: "回答：{question}",
        answerHint: "回答它的问题",
        againHint: "再起草时要它改什么（可以不写）",
        whatHint: "想做什么，一句话就行",
        whatLabel: "想做什么",
        redraft: "再起草",
        draft: "起草",
        status: "状态",
        draftStatus: "草稿",
        todoStatus: "待办",
        pickForMe: "起草时替你挑",
        whichProject: "在哪个项目里做",
        firstProject: "还没有项目：新建一个",
        newProjectLink: "＋ 新建项目",
        priority: "优先级",
        inQueue: "排队中：{ago}排上的，有空位就按看板上的先后自动开工。",
        unqueue: "不排了",
        pickHelper: "先选好帮工",
        start: "开工",
        save: "存下改动",
        remove: "删掉",
        newProject: "新建项目",
        projectHint: "项目名，也是工作目录下的文件夹名",
        projectName: "项目名",
        create: "新建",
        writeOwn: "自己写说明",
      },
      boardLabels: {
        view: { board: "看板", list: "列表" },
        grouping: { status: "状态", project: "项目", agent: "帮工", none: "不分组" },
        ordering: { manual: "默认", priority: "优先级", updated: "最近更新", created: "创建时间" },
        lane: { todo: "待办", working: "处理中", waiting: "等你看", closed: "已关" },
        stage: { talk: "聊清楚", work: "安排活", finish: "完成" },
        newIssue: "新工单",
      },
      graph: {
        splitting: "在拆成几件",
        draft: "拆好了，看过再开工",
        running: "做到 {done} / {total} 件",
        paused: "暂停了",
        ready: "都做完了，等你合进主分支",
        done: "合进了主分支",
        abandoned: "放弃了",
      },
      trigger: {
        issue: "派出去",
        comment: "带话",
        commentNumbered: "带话（#{id}）",
        task: "计划",
        cron: "定时任务",
        missed: "定时任务（补跑）",
        refine: "起草",
        runtime: "农机自己",
      },
      run: { working: "正在干", heard: "中途听到 {n} 句" },
      card: {
        orchestrator: "管家",
        refining: "{name}在起草",
        draft: "草稿",
        queued: "排队中",
        cron: "定时任务",
        noHelper: "还没选帮工",
        pickFirst: "没选帮工或项目，开工前要选好",
        waiting: "等空位，{ago}排上的",
        written: "写于 {ago}",
        lost: "丢了",
        quiet: "{took}没动静",
        nth: "第 {n} 次",
        open: "开了 {took}",
        used: "用了 {took}",
        run: "第 {n} 轮",
        runs: "{n} 轮",
        orchestratorWorking: "管家在做",
        missingFlag: "记录缺失",
        graph: "计划：{title}",
        missing: "这一轮的记录缺失：{what}",
      },
      issue: {
        asking: "{who}有 {n} 个问题要问你",
        askingLine: "点一个选项就是回答，也可以自己说。",
        reviewed: "验收过了，可以完成",
        handedBack: "{who}交回来了，等你验收",
        conflict: "合进 {base} 会冲突",
        main: "主分支",
        failed: "这一轮没做成",
        interrupted: "这一轮停在半路",
        quiet: "{who}很久没动静了",
        quietLine: "可能在跑很久的命令，也可能卡住了：看看它的每一步，不对就叫停。",
        stuck: "卡住了",
        canceled: "已取消",
        reopenLine: "要它接着做就重开：写一句这次要做什么。",
        inGraph: "这是计划里的一件，跟着计划走。",
        splitting: "在拆计划「{graph}」：只读代码，不改文件。",
        editing: "{who}在改代码",
        history: "{n} 次：{line}",
        historyItem: "{name}（{id}）",
        since: "{span}了",
        ran: "第 {n} 轮",
        used: "共用 {span}",
        noSteps: "还什么都没做。",
        stepsGone: "轨迹只留 30 天（配置里的 session.trajectory_days），这张工单的已经清掉了。",
        change: { A: { mark: "新", label: "新增" }, M: { mark: "改", label: "修改" }, D: { mark: "删", label: "删除" } },
        and: "、",
        doing: "正在{action}",
        doingLabel: "正在{action}：{label}",
        who: "{name}",
        whoRuntime: "{name}（{runtime}）",
        changes: "{branch} → {base} · {commits} 个提交 · +{added} -{removed}",
        changesUncommitted: "{branch} → {base} · {commits} 个提交 · +{added} -{removed} · {uncommitted} 个没提交",
        graphStep: "计划「{graph}」的一件：{step}。做完自动合进计划的分支，整个计划合进主分支时才进主分支。",
        justNow: "刚刚",
      },
    },
    "web.lan": {
      lan: {
        section: { label: "连接到本机" },
        open: "开着",
        closed: "关着",
        intro: "打开以后，同一个局域网里的手机或另一台电脑扫码配对以后，就能用这台电脑上的 VibeValley：看帮工、派活、在频道里说话。",
        allow: "允许连接",
        address: "地址",
        add: "添加设备",
        close: "关掉连接",
        devices: "配对过的设备",
        deviceCount: "{n} 台",
        removeWhich: "移除 {name}",
        remove: "移除",
        copied: "复制好了：在另一台电脑的浏览器里打开它。",
        notCopied: "复制不了：选中链接自己复制吧。",
        qr: "配对二维码",
        scan: "手机用相机扫这个码；另一台电脑在浏览器里打开这个链接：",
        left: "还有 {s} 秒有效，只能用一次。",
        copy: "复制链接",
        newCode: "换一个码",
        stop: "不加了",
        asking: "「{name}」想连接到这台电脑。让它进来以后，它能和你一样用这台电脑上的 VibeValley。",
        letIn: "让它进来",
        refuse: "不让",
        paired: "配对于 {at} · 上次来 {seen}",
        pairedNever: "配对于 {at} · 还没来过",
        notes: {
          "0": "帮工能在这台电脑上跑命令，所以只让配对过的设备连进来；配对要你在这里点头。",
          "1": "配对过的设备和你一样用这台电脑上的 VibeValley。开关和设备只能在这台电脑上管。",
          "2": "连接走的是不加密的 HTTP：同一个网络里的人可能看到传的内容。只在信得过的网络里开，比如家里的 Wi-Fi、自己的热点。",
          "3": "电脑换了地址（换了网络）以后，设备连不上了，在这里添加设备再扫一次就好，不用重新点头。",
        },
      },
      devices: { android: "安卓手机", windows: "Windows 电脑", device: "一台设备" },
      pair: {
        title: "连进那台电脑",
        intro: "这台设备连进那台电脑上的 VibeValley，和主人一样看帮工、派活、在频道里说话。配对要那台电脑上的主人点头。",
        code: "配对码",
        codeHint: "在那台电脑的「连接到本机」里点「添加设备」",
        name: "这台设备叫",
        nameHint: "主人在设备列表里看到的名字",
        ask: "请主人放行",
        waiting: "等那台电脑上的主人点头……",
      },
    },
    "web.memory": {
      memory: {
        yours: "你记的",
        orchestrators: "管家替它记的",
        sessions: "{name} 记的",
        own: "它自己记的",
        intro:
          "这个 agent 派出去的帮工共用一份记性。每一轮开始，和这一轮有关的几条放在它收到的话前面；一轮结束，它在汇报里写的「记住：」那几行，和这件活做到哪了，记进来。",
        issues: "手上的工单",
        noIssues: "它的帮工还没做完过一轮。",
        helper: "帮工",
        allProjects: "所有项目",
        notes: "记下的",
        all: "全部",
        emptyHere: "这一栏没有。",
        nothing: "还没记下什么。帮工在汇报里写「记住：」，或者你在上面替它记。",
        neverRecalled: "还没想起过",
        fading: "快忘了：记满 {keep} 条时最先丢",
        inSource: "在 {source} 里",
        forgetThere: "要删到 {source} 里删",
        sources: "记性从哪来",
        on: "在用",
        off: "没接上：{why}",
        listed: "记下的列在下面",
        unlisted: "不在这里列出",
        forgettable: "能在这里忘掉",
        forgetElsewhere: "要删到它那里删",
        transcripts: "收整段干活的对话",
        sourcesNote: "在开头的「设置」里接上、关掉，或改读写。",
        next: "下回开工会想起",
        preview: "{n} 条 · {chars} / {limit} 字",
        where: "在哪个项目开工",
        pick: "选项目",
        words: "这一轮的话",
        wordsHint: "这一轮的话（可以不填）",
        blank: "在这个项目里开工，什么也想不起来。",
        noProjects: "还没有项目。",
        orchestratorReading: "在读管家的记性……",
        orchestratorIntro: "管家开工时和每次压缩后读一遍记性；中间记下、忘掉的，它下一句就知道。",
        orchestratorNothing: "还没记下什么。跟管家说「记住……」，或者你在上面替它记。",
        orchestratorOwn: "管家自己记的",
        told: "你交代的",
        tooOld: "太旧了，带不进系统提示",
        archiveIntro: "对话太长时，管家把前面的部分压成一段摘要，原文一字不改地存在这里。摘要里缺了细节，它自己会用 search_archive 来翻；你也可以在这里翻。",
        search: "在旧账里搜",
        searchHint: "搜一个词",
        find: "搜",
        found: "搜到的",
        compacted: "压掉的对话",
        noArchive: "还没有：管家的对话还没长到要压缩。",
        chars: "{n} 字",
        note: "替它记一条",
        noteProject: "比如：clock-in 的测试用 pnpm test，别用 npm",
        noteOrchestrator: "比如：提交信息写中文；周末别派夜班",
        project: "项目",
        projectHint: "项目（可以不填）",
        noteHint: "写成下次一看就懂的一句话。",
        noteHintProject: "写成下次一看就懂的一句话。项目留空就是所有项目都用得上。",
        forget: "忘掉",
        recalled: "想起过 {n} 次",
        recalledLast: "想起过 {n} 次，上次 {last}",
      },
    },
    "web.orchestrator": {
      looks: {
        farmer: { name: "青年农夫", blurb: "草帽、背带裤，爱笑的年轻人。" },
        foreman: { name: "包工头", blurb: "安全帽、反光背心，对讲机不离身，一喊就到。" },
        auntie: { name: "农场大婶", blurb: "头巾围裙，小本子上记着每块地的活。" },
        grandpa: { name: "老把式", blurb: "白胡子，种了一辈子地，不慌不忙。" },
        gardener: { name: "园艺师", blurb: "宽檐草帽别朵小花，剪刀揣在围裙兜里。" },
        robot: { name: "机器人管家", blurb: "圆滚滚的农场机器人，脸上的屏会笑。" },
      },
      pet: { dog: "小狗", ragdoll: "重点色布偶猫", bluecat: "蓝猫" },
      orchestrator: {
        tab: { memory: "记性", trajectory: "轨迹", archive: "旧账", voice: "声音" },
        all: "← 全部档案",
        title: "管家",
        intro: "管家不当帮工：听你说要做什么，派帮工去做，盯着进度，转告结果。",
        look: "长相是{name}。",
        profile: "改它的档案",
        tabs: "管家的",
        heard: "收到",
        quiet: "管家还没开过口。",
        trajectory: "管家每一轮的经过",
        about:
          "它收到的话、调的每个工具（点一行看参数和结果）、它说的话。新的在下面，一直留着最近的 1000 步。哪一轮做错了，在它收到的话上点「这一轮做错了」，写一句应该怎样，存成一条评测。",
      },
    },
    "web.project": {
      title: "项目",
      list: "项目列表",
      add: "新增项目",
      repos: "代码库",
      all: "全部",
      allLine: "整张地图：每个项目一座岛",
      notGit: "还不是 git 仓库",
      finding: "在找……",
      none: "工作目录下还没有项目。点「新增项目」新建一个，或从 GitHub 下载一个。",
      copied: "复制好了：{path}",
      notCopied: "复制不了：选中路径自己复制吧。",
      recency: {
        label: "最近一次提交：{label}",
        never: "还没有提交",
        day: "一天内有提交",
        week: "一周内有提交",
        month: "一个月内有提交",
        quarter: "三个月内有提交",
        older: "三个月没有提交",
      },
      firstCommit: "第一次提交",
      noCommits: "还没有提交",
      commitCount: "提交",
      commits: "{n} 次提交",
      code: "代码",
      lines: "{n} 行",
      uncounted: "没数",
      languages: "语言",
      kinds: "{n} 种",
      copyPath: "复制路径",
      counting: "在数……",
      recount: "重新统计",
      countedAgo: "{ago}数过",
      whatLanguages: "用了哪些语言",
      byLines: "按行数，不算空行 · tokei 数的",
      linesAndFiles: "{lines} 行 · {files} 个文件",
      empty: "还没有数得出来的代码。",
      noTokei: "数代码行数要用 tokei，这台机器上还没有。",
      install: "在终端里装一个：",
      or: "（或 ",
      thenRecount: "），装好点上面的「重新统计」。",
      level: { "0": "没有提交", "1": "少", "2": "一些", "3": "较多", "4": "很多" },
      year: "过去一年 · 一格一天，提交越多格子越满",
      dayCommits: "{n} 次提交，{level}",
      noCommitsThatDay: "没有提交",
      busiest: "最忙的一天：{day}，{n} 次提交",
      calendar: "提交日历",
      inYear: "一年里",
      daysWorked: "有提交的日子",
      days: "{n} 天",
      longest: "最长连着干",
      current: "最近连着干",
      yearLabel: "过去一年 {commits} 次提交，{days} 天有提交",
      readingCommits: "在读提交",
      rows: { "0": "", "1": "一", "2": "", "3": "三", "4": "", "5": "五", "6": "" },
      fewer: "少",
      more: "多",
      who: "谁来干过活",
      whoWhen: "过去一年的提交",
      times: "{n} 次",
      rest: "还有 {people} 位，一共 {commits} 次。",
      how: "怎么来",
      fresh: "新建一个",
      github: "去别人家看看",
      githubAddress: "GitHub 地址",
      githubHint: "公开仓库的主页地址。下载到本地后，就能查看项目和安排帮工。",
      name: "项目名",
      nameHint: "保存在工作目录里；已有同名项目不会被覆盖。",
      nameExample: "比如 raft-source",
      downloading: "正在下载仓库… 大仓库需要多等一会儿，最多 3 分钟。",
      making: "正在新建…",
      cancel: "取消",
      busy: "进行中…",
      download: "下载到工作目录",
      create: "创建项目",
      otherLang: "其他",
    },
    "web.runtime": {
      capability: {
        listModels: "模型列表",
        accountUsage: "账户用量",
        checkUpdate: "检查更新",
        upgrade: "升级",
        skills: "技能清单",
        mcpServers: "MCP 清单",
        tools: "工具清单",
      },
      available: "可用",
      disabled: "已停用",
      unsupported: "不支持",
      notFound: "没找到",
      checking: "检测中…",
      noRuntimes: "读不到农机：",
      title: "农机",
      list: "农机列表",
      intro: "机器上的编码 agent",
      usedBy: " · {n} 个 agent",
      reading: "读取中…",
      bundled: "随 oar 一起装",
      commandLine: "命令行",
      unsupportedWhy: "不支持：{why}",
      notHere: "这台机器上没找到",
      checkedAt: "检测于 {clock}",
      recheck: "重新检测",
      account: "账户",
      skills: "技能",
      mcp: "MCP 服务器",
      tools: "工具",
      agents: "用到它的 agent",
      makeAgent: "用它捏一个新 agent →",
      noneYet: "还没有。",
      afterInstall: "装好以后才能读到。",
      noUsage: "这台农机 不报告账户用量。",
      signedOut: "没登录。在这台机器上运行 {runtime} 登录一次。",
      unreadable: "读不到：{why}",
      balance: "{enough, select, true {按量计费，这里是 {provider} 账户余额。} other {按量计费，这里是 {provider} 账户余额，不够用了。}}",
      subscription: "套餐：{tier}",
      left: "剩 {pct}%",
      windowLeft: "{label} 剩 {pct}%",
      resets: "{moment} 重置",
      can: "能做什么",
      steer: "干活时能接话（steer）",
      noSteer: "干活时不能插话，话会排到这一轮之后",
      inProcess: "· 跑在 server 进程里（Node SDK）",
      ownProcess: "· 作为单独的命令行进程运行",
      refused: "不接受的开 session 参数",
      acceptsAll: "都接受。",
      queries: "oar 提供的查询",
      noEffort: "这个模型没有推理强度可选。",
      settings: "设置",
      discard: "放弃",
      save: "保存",
      enabled: "让 agent 用它",
      enabledHint: "停用后，用它的 agent 都派不出去。",
      binPath: "命令路径",
      binPathHint: "对应 oar 的 OAR_{id}_BIN。留空就在 PATH 里找。",
      auto: "自动查找",
      defaultModel: "默认模型",
      defaultModelHint: "agent 没指定模型时用它。",
      ownDefault: "农机自己的默认",
      defaultEffort: "默认推理强度",
      default: "默认",
      maxWorking: "最多同时干活",
      maxWorkingHint: "用它的帮工同时干活的上限，服务商限并发时有用。到了上限，新活派不出去，等有人干完。留空只受 VibeValley 整体的上限（同时 6 张工单）。",
      noLimit: "不另设",
      budget: "每日预算（元）",
      budgetLabel: "每日预算",
      budgetHint:
        "{pi, select, true {今天已经花了 {spent}（按 pi 的价目表估算）。到了预算就不再派新活，正在干的会干完。留空不设上限。} other {今天已经花了 {spent}（按模型的价目表估算）。到了预算就不再派新活，正在干的会干完。留空不设上限。}}",
      unlimited: "不设上限",
      env: "环境变量",
      envHint: "叠加到这台农机上的每个帮工；agent 自己的环境变量优先。",
      models: "模型",
      modelCount: "{n} 个",
      noModels: "这台农机 不报告模型列表。",
      effort: "推理强度",
      unreported: "不报告。",
      none: "没有。",
      library: {
        book: "技能书",
        search: "搜索技能",
        searchHint: "搜名字、说明、农机……",
        noRuntimes: "读不到农机：",
        installed: "这台电脑上装的 · {count}",
        noneReported: "农机还没报告装了哪些技能（或者还在读）。",
        noMatch: "没有对得上的。",
        own: "VibeValley 自己的 · {count}",
        newSkill: "新技能",
        noSkills: "还没有技能：写一个 VibeValley 自己的，或者在农机上装好再回来看。",
        installedNote: "装在农机上的技能：用这些农机的帮工会自己按需加载，不用在档案里勾。要改它，去它的文件里改。",
        where: "哪些农机有它",
        inUse: "{n} 个 agent 在用，删掉会从它们身上去掉。",
        removeIt: "删掉？",
        name: "名字",
        nameLabel: "技能名字",
        nameHint: "比如：先写测试",
        when: "什么时候用",
        whenHint: "一句话。按需加载技能的农机 先读这句，再决定要不要读正文。",
        description: "技能说明",
        descriptionHint: "改行为之前，先补一个会失败的测试。",
        body: "正文",
        bodyHint: "写成给 agent 看的指令（SKILL.md 的正文）。",
        bodyExample: "改任何行为之前，先写一个能复现问题的测试……",
        who: "谁在用",
        nobody: "还没有 agent 带这个技能。到 agent 的「技能」页签里勾上。",
      },
      quota: {
        session: "当前会话",
        weekly: "本周额度",
        week: "本周（{models}）",
        oneWeek: "· 一周",
        weekdays: { "0": "周日", "1": "周一", "2": "周二", "3": "周三", "4": "周四", "5": "周五", "6": "周六" },
        now: "马上重置",
        minutes: "{m} 分钟后重置",
        hours: "{h} 小时后重置",
        on: "{weekday}重置",
        unreported: "不报额度",
        signedOut: "没登录",
      },
      spentToday: "今天帮工花了约 {spent}，没设每日预算。",
      spentTodayBudget: "今天帮工花了约 {spent}，每日预算 {budget}。",
    },
    "web.session": {
      log: {
        heard: "收到",
        process: "轨迹",
        fold: "收起这一轮",
        unfold: "展开这一轮",
        steps: "{n} 步 · {took}",
        live: " · 进行中",
        see: "看这一轮的 {n} 步",
        less: "收起",
        all: "展开全部",
        subagentGot: "帮手接到",
        told: "带话",
        recalled: "想起了",
        subagentThought: "帮手想了想",
        thought: "想了想",
        subagentSaid: "帮手说",
        said: "它说",
        farm: "频道",
        running: "进行中",
        ok: "成功",
        failed: "失败",
        tool: "工具 {name}",
        pending: "还没返回",
        noOutput: "没有输出",
      },
      runs: {
        farm: {
          channel_message_send: "在频道里说话",
          channel_message_list: "读频道的消息",
          channel_unread_list: "看有没有找它的话",
          session_list: "看频道里都有谁",
          other: "频道：{tool}",
        },
        span: { heard: "收到", recalled: "想起", thinking: "思考", said: "说", retry: "重试", cache: "缓存", error: "出错", farm: "频道", tool: "工具" },
        earlier: "更早的几步",
        unasked: "自己起的一轮",
        subagentGot: "帮手接到",
        issue: "工单",
        told: "带话",
        usedTools: "用了 {n} 个工具",
        process: "这一轮的轨迹",
        tag: { thought: "想了想", subagentThought: "帮手想了想", said: "它说", subagentSaid: "帮手说", usage: "用量" },
        thoughtFor: "想了 {took} · 用了 {n} 个工具",
      },
      trajectory: {
        lane: { asked: "收到", model: "模型", tool: "工具" },
        runs: "{n} 轮",
        steps: "{n} 步",
        modelTime: "模型用时 {took}",
        toolTime: "工具用时 {took}",
        cacheHit: "缓存命中 {pct}%",
        tokens: "输入 {input} / 输出 {output} token",
        quiet: "还没有动静。",
        run: "第 {n} 轮",
        earlier: "更早",
        search: "搜索轨迹",
        searchHint: "搜索",
        noMatch: "没有对得上的一步。",
        pending: "还没返回",
        noOutput: "没有输出",
        tool: "工具 {name}",
        running: "进行中",
        ok: "成功",
        failed: "失败",
        input: "输入",
        output: "输出",
        wrong: "这一轮做错了",
        marked: "标成了做错的一轮，存成了一条评测",
        want: "这一轮应该怎样",
        wantHint: "它应该怎样：比如「先问我是哪个项目，别直接派活」",
        neverSent: "还没派出去过。",
        sent: "派出去的帮工",
        here: "在场",
        hired: "{ago}接活",
        hiredAndLeft: "{hired}接活 · {left}走的",
        pick: "选一个帮工，看它的轨迹。",
      },
    },
    "web.setting": {
      language: {
        title: "语言",
        line: "界面上的字、管家和帮工回你的话、发到聊天软件的汇报，都用这种话。换了以后页面会重新打开。",
        zh: "中文",
        en: "English",
        label: "界面语言",
      },
      keys: { deepseekHint: "sk-…（不改就空着）", saved: "存好了，马上就用上。" },
      source: {
        off: "没接",
        on: "接上了",
        closed: "关着",
        configure: "配置 {label}",
        enabled: "启用",
        enable: "启用 {label}",
        noKey: "本机的不用 key",
        address: "{label} 的地址",
        key: "{label} 的 key",
        keyHint: "key（不用或不改就空着）",
        user: "{label} 的 user_id",
        userHint: "你在 EverOS 里的 user_id（空着就是 owner）",
        read: "读",
        readHint: "开工想起、帮工翻记性时也问它",
        write: "写",
        writeHint: "记下的也送一份过去",
        everything: "读全部",
        everythingHint: "不只读 VibeValley 替帮工记的，主人在里面的记忆每个帮工都读得到",
      },
      github: {
        noGh: "没装 gh",
        note: "能提 PR 的项目在「项目」里看；完成时提 PR 要在配置里打开（github.pr_projects）。",
        recheck: "重新检测",
        cli: "gh 命令行",
        cliHint: "合并时开 PR、读仓库用它",
        login: "登录",
        loginHint: "gh auth login 登录的账号",
        notLoggedIn: "没登录",
      },
      nav: {
        label: "设置的分区",
        search: "搜索设置…",
        general: "通用",
        appearance: "外观",
        models: "模型",
        about: "关于",
        memory: "记性",
        skills: "技能",
        call: "通话线路",
        dictation: "听写",
        chat: "聊天软件",
        devices: "设备",
        width: "导航的宽窄（拖动，双击回默认）",
      },
      groups: { options: "选项", helpers: "帮工", voice: "语音", connect: "连接" },
      words: {
        general: "语言 language 启动 打开 工作台 农场",
        appearance: "主题 深色 浅色 暗色 dark light 界面大小 缩放 字号",
        models: "DeepSeek key 钥匙 模型 管家",
        about: "版本 家目录 设置文件 version",
        memory: "Nowledge EverOS 记性 记忆",
        skills: "技能 skill",
        call: "声网 Agora 电话 识别 合成 谁接电话 区域",
        moss: "MOSS 试音 key 实时",
        dictation: "听写 转写 语音输入",
        github: "gh PR 登录",
        chat: "微信 飞书 QQ 连接器 配对",
        devices: "手机 配对 连接到本机 局域网",
      },
      scope: { farm: "对整个 VibeValley", device: "只对这台设备" },
      general: {
        languageHint: "界面、管家和帮工说的话都用它",
        start: "启动时打开",
        startHint: "打开应用、或者打开首页时先进哪里",
        starts: { workbench: "工作台", farm: "农场" },
      },
      appearance: {
        intro: "只改工作台；农场、记忆树是画出来的，有自己的颜色和昼夜。",
        theme: "主题",
        themeHint: "跟随系统时随电脑的浅色和深色变",
        themes: { light: "浅色", dark: "深色", system: "跟随系统" },
        scale: "界面大小",
        scaleHint: "缩放整个工作台；农场按整数倍放大，不跟着变",
      },
      models: { intro: "管家和 VibeValley 自己的帮工用的模型。", deepseekHint: "管家和 VibeValley 自己的帮工用它" },
      memory: { intro: "帮工还能去外面的记性里查、往里记。" },
      about: {
        version: "版本",
        versionHint: "这台电脑上的服务端",
        files: "文件",
        home: "家目录",
        homeHint: "VibeValley 的一切都在这里",
        settings: "设置文件",
        settingsHint: "钥匙和这几页的设置",
        copy: "复制路径",
        copied: "路径复制好了",
        reveal: "在访达里显示",
        update: "更新",
        updateHint: "桌面版从 GitHub 上的发布自己更新",
        upToDate: "已是最新",
        checking: "正在查有没有新版本…",
        downloading: "正在下载 {next}（{percent}%）",
        ready: "{next} 已下好，退出时装上",
        readyNewFarm: "{next} 已下好：它会从新的数据开始，旧的留在一边",
        manual: {
          diskImage: "{next} 要手动装：应用还在安装盘里运行，先拖进「应用程序」",
          translocated: "{next} 要手动装：macOS 把应用挪到了临时的地方运行，先拖进「应用程序」再打开",
          readOnly: "{next} 要手动装：应用所在的文件夹不能写",
          noBuild: "{next} 没有这台 Mac 的版本",
        },
        failed: "没查成：{why}",
        check: "检查更新",
        restart: "重启更新",
        restartQuestion: "重启到新版本？",
        workingQuestion: "{n} 个帮工在干活，重启会打断它们。现在重启？",
        newFarmQuestion: "新版本从新的数据开始，旧的留在家目录里。现在重启？",
        download: "去下载",
      },
    },
    "web.tree": {
      kind: { leaf: "叶", fruit: "果", seed: "种子" },
      stage: { "1": "芽", "2": "小苗", "3": "小树", "4": "大树", "5": "老树" },
      distilled: "提炼自 {n} 次经验",
      noted: "这件活记下了 {n} 片叶",
      seeds: "长出了 {n} 颗种子",
      grew: "长成了 {n} 次经验",
      together: "常和 {n} 条一起想起",
      sown: "「{body}」播进了技能书（还是假的，接上服务端以后才真写进去）",
      sky: "农场的记忆星空",
      skyHint: "中间是种子，往外是果和叶，越远越旧；拖动可以转",
      back: "回到树下",
      farm: "回农场",
      earliest: "最早",
      past: "看看从前：拖到哪天，树就长回那天的样子",
      now: "现在",
      day: "第 {n} 天",
      byHelper: "只看哪个帮工的",
      allHelpers: "全部帮工",
      byProject: "只看哪个项目的",
      allProjects: "全部项目",
      everyProject: "所有项目",
      title: "农场的记忆树",
      stats: "第 {days} 天 · {rounds} 轮 · 想起 {recalls} 次",
      nextStage: "再干 {rounds} 轮长成{stage}",
      grown: "长成了",
      experience: "一次经验",
      fold: "收起",
      intent: "想做什么",
      approach: "怎么做的",
      insight: "关键心得",
      recalled: "想起过 {n} 次",
      recent: "最近长出的",
      fading: "快落的叶 {n}",
      look: "看看",
      fadingNote: "最久没想起的会先落；落了就忘了。",
      waiting: "待播种的手艺",
      noSeeds: "没有新的手艺；好几次经验说的是一件事时，会提炼出一颗种子。",
      sow: "播种",
      lookUp: "抬头看星空",
      from: "提炼自",
      notedBy: "这件活记下的",
      grewInto: "长出了",
      grewTo: "长成了",
      often: "常一起想起",
      aboutToFall: " · 快落了",
      scene: "记忆树：每片叶是记下的一句话，每颗果是一次经验，树下的种子是手艺；抬头是同一份记忆的星空",
    },
    "web.ui.pixel": {
      sound: {
        group: { ui: "界面", tools: "农具", field: "地里", yard: "院子", reward: "奖励", voice: "语音" },
        label: {
          tap: "点击",
          nope: "点不了",
          pick: "拿工具",
          open: "展开",
          close: "收起",
          water: "浇水",
          spray: "杀虫",
          weed: "除草",
          harvest: "收获",
          shovel: "铲除",
          plant: "播种",
          ripe: "熟了",
          bug: "长虫",
          coin: "金币",
          levelUp: "升级",
          achievement: "成就",
          arrive: "帮工到了",
          rustle: "草叶沙沙",
          splash: "扑通",
          thud: "踩土",
          woof: "小狗叫",
          meow: "小猫叫",
          mew: "小猫短叫",
          purr: "小猫呼噜",
          yip: "小狗跳",
          pant: "小狗喘气",
          voiceOn: "语音接通",
          voiceOff: "语音挂断",
          ring: "来电",
        },
      },
      close: "关上",
      optional: "  可选",
      drop: "去掉 {chip}",
      noticeTitle: { info: "提示", warn: "没派成", error: "出错了" },
    },
    "web.voice": {
      voice: {
        section: { label: "声音" },
        noSettings: "问不到服务端的设置（{why}）。",
        range: "{min} 到 {max}，默认 {fallback}",
        saved: "存好了，下一通电话就用上。",
        answer: {
          orchestrator:
            "频道里那个管家本人接电话：看得到现状，自己派活，记得你们说过的话。声网经一个公网地址访问本机的一个接口（配置的 voice.line.url，比如 Tailscale Funnel；没配时临时开 cloudflared），只有这一个接口对外，每通电话一把钥匙。",
          agora: "声网托管的模型，不用别的 key。",
          deepseek: "用设置里的 DeepSeek key（{from}）。",
          noDeepseek: "用设置里的 DeepSeek key，现在还没有：去首页「设置」填。",
          openai: "任何 OpenAI 兼容的接口：通义、Kimi、自己部署的……",
        },
        intro:
          "管家用声网的对话式 AI 听你说话、开口回答。这里配线路：凭据、怎么听、谁接电话，都可以用声网托管的（不用别的 key），也可以换成自己的服务。管家的人设、开场白和音色在",
        orchestratorPage: "管家页",
        period: "。",
        ready: "能接通",
        missing: "还缺凭据",
        nextCall: "改了以后，下一通电话生效",
        credentials: "凭据",
        console: "声网控制台",
        hex: "32 位十六进制",
        area: "区域",
        areaHint: "Agora 接口的区域，选离服务端近的；中国大陆的项目选中国大陆。",
        listen: "听",
        listenParts: "识别 · VAD 断句",
        asr: "识别",
        microsoft: "微软 Azure 语音，用自己的 key。",
        hosted: "声网托管，不用别的 key。",
        language: "语言",
        languageHint: "听哪种话。人设里也写明用这种话回答。",
        deepgramModel: "Deepgram 模型",
        azureArea: "Azure 区域",
        azureAreaHint: "语音资源所在的区域，比如 eastasia、eastus。",
        asrArea: "识别的 Azure 区域",
        microsoftKey: "微软语音的 key",
        think: "想",
        who: "谁接电话",
        model: "模型",
        deepseekModel: "DeepSeek 的模型名。",
        deepseekModelLabel: "DeepSeek 模型",
        address: "地址",
        llmAddress: "OpenAI 兼容的 chat completions 完整地址。",
        llmAddressLabel: "大模型地址",
        llmModel: "大模型名",
        llmKey: "接口的 key",
        speechServer: "本机的 speech-server",
        dictationIntro: "转给你填的 OpenAI 兼容地址；用本机的 speech-server，声音不出这台电脑。",
        dictationAddress: "到 /v1 为止。本机：http://127.0.0.1:8080/v1；OpenAI：https://api.openai.com/v1。空着就不用听写。",
        dictationAddressLabel: "听写的地址",
        dictationModel: "本机的 speech-server 填 qwen3；OpenAI 填 gpt-4o-mini-transcribe。",
        dictationModelLabel: "听写的模型",
        dictationKey: "凭据（本机可以空着）",
        persona: {
          intro: "打电话时管家怎么开口、用什么声音。凭据、怎么听、谁接电话在",
          page: "页。",
          open: "开口",
          openParts: "人设 · 开场白",
          ownCall: "电话由管家自己接：它就是频道里那个管家，用它自己的提示词，不另设人设。",
          persona: "人设",
          personaHint: "电话里先答话的模型是谁、怎么说话。它看不到现状，派活由本机的管家做；写明别编进度。",
          greeting: "开场白",
          greetingHint: "接通时先说的一句。",
          failure: "出错时说",
          failureHint: "大模型出错时说的一句。",
          speak: "说",
          tts: "合成",
          ttsModel: "合成模型",
          voice: "音色",
          openaiVoice: "OpenAI tts-1 的音色。",
          ttsArea: "合成的 Azure 区域",
          azureVoice: "Azure 的神经网络音色名，比如 zh-CN-XiaoxiaoNeural。",
          microsoftVoice: "微软音色",
          minimaxVoice: "点名字选它，点左边的播放键先听一句；也可以在下面填别的 MiniMax 系统音色 id。",
          voiceId: "音色 id",
          sample: "试听：{greeting}",
          noSample: "没有样音",
          stop: "停下 {name}",
          play: "试听 {name}",
        },
        moss: { console: "MOSS 开放平台", verify: "测一下能不能接通", checking: "在接…", ok: "接通了", keyHint: "MOSS 开放平台的 key，只在这台电脑的服务端用" },
        dictationVia: "听写走哪",
        dictationOwn: "自己的地址",
        dictationMossIntro: "录音经服务端交给 MOSS 转写，用 MOSS Live 的同一把 Key。",
        dictationMossKey: "API Key",
      },
      choices: {
        area: { US: "美国", EU: "欧洲", AP: "亚太", CN: "中国大陆" },
        language: { "zh-CN": "普通话", "zh-HK": "粤语（香港）", "zh-TW": "中文（台湾）", "en-US": "英语（美国）", "ja-JP": "日语", "ko-KR": "韩语" },
        asr: { ares: "声网 ARES", microsoft: "微软" },
        answer: { agora: "声网托管", openai: "自己的接口" },
        minimax: {
          gentle: "温润青年",
          qingse: "青涩青年",
          jingying: "精英青年",
          badao: "霸道青年",
          student: "青年大学生",
          girl: "少女",
          yujie: "御姐",
          mature: "成熟女性",
          sweet: "甜美女性",
          presenterMale: "男性主持人",
          presenterFemale: "女性主持人",
          audiobookMale: "男性有声书",
          audiobookFemale: "女性有声书",
        },
        number: { silenceMs: "停顿多久算说完（毫秒）", interruptMs: "说多久能打断他（毫秒）", idleSeconds: "没人时多久离开（秒）" },
      },
      dictation: {
        unset: "听写还没配：在「声音」页的「听写」里填地址和模型",
        recording: "在听…再点一下停",
        transcribing: "在认字…",
        failed: "上次没认出来：{why}",
        start: "听写：点一下开始说，再点一下停",
        stop: "停下听写",
        label: "听写",
        noMic: "录不了音：没有麦克风权限",
        cannot: "录不了音：{why}",
        nothing: "没录上",
      },
      call: { renew: "令牌续期失败：{why}", noMic: "没有麦克风权限", cannotHear: "声网：听不到对面：{why}", agora: "声网：{code} {msg}" },
      moss: {
        intro: "直接和 MOSS Live 说话，听它怎么答；连线经本机服务端，key 不出这台电脑。说的话不进田头。",
        persona: "人设（不填用 MOSS 默认的）",
        personaHint: "比如：你是我的管家，说话简短。",
        instructions: "规则",
        defaultInstructions: "用简短的中文回答。",
        talk: "开始说话",
        connecting: "在接通…",
        hangUp: "挂断",
        mute: "静音",
        unmute: "取消静音",
        you: "你",
        said: "对话",
        nothingSaid: "接通后直接说话，这里显示双方说的。",
        events: "线路上的消息",
        eventsHint: "发出的动作和收到的事件，原样的 JSON；正在变的字和音频的通告不列。",
        up: "发",
        down: "收",
        closed: "MOSS Live 断开了",
        qos: {
          title: "线路质量",
          hint: "每秒算一次，只算这次通话。",
          reply: "应答",
          ms: "{last} ms · 平均 {mean}",
          replyTip: "从你说完（MOSS 判断你停了）到它的第一段声音到这里；已经算了 {n} 轮。超过 2.5 秒标红。",
          up: "上行",
          upTip: "这一秒发出去的：麦克风的声音和发的消息。16 kHz 的声音约 256 kbps。",
          down: "下行",
          downTip: "这一秒收到的：回答的声音和事件。48 kHz 的声音在说话时约 768 kbps。",
          frames: "麦克风帧",
          framesTip: "这一秒发出的 20 ms 声音帧，正常是 50；少了说明录音或页面跟不上。",
          backlog: "发送积压",
          backlogTip: "还在本机等着发出去的字节；一直涨说明上行太慢。",
          ahead: "播放缓冲",
          aheadTip: "已经收到、还没放完的回答，毫秒。",
          gaps: "断音",
          gapsTip: "同一个回答里，上一段放完了下一段还没到的次数。",
          stopsTip: "MOSS 自己停下回答的次数，悬停看原因（比如 playback_timeout：没及时报告播放进度）。",
          stops: "被停",
        },
        tryIt: "试音",
        notInChat: "说的话不进田头",
      },
    },
  },
  en: {
    desktop: {
      open: "Open VibeValley",
      quit: "Quit",
      cannotStart: "VibeValley cannot start",
      seeLog: "{reason}; the log is at {log}",
      noAddress: "The server gave no ready address within {seconds} seconds",
      failed: "The server failed to start: {why}",
      exited: "The server exited ({code})",
      waiting: "{n} for you",
      working: "{n} working",
      idle: "idle",
      menu: {
        about: "About {app}",
        hide: "Hide {app}",
        hideOthers: "Hide Others",
        unhide: "Show All",
        quit: "Quit {app}",
        edit: "Edit",
        undo: "Undo",
        redo: "Redo",
        cut: "Cut",
        copy: "Copy",
        paste: "Paste",
        selectAll: "Select All",
        view: "View",
        reload: "Reload",
        devTools: "Developer Tools",
        resetZoom: "Actual Size",
        zoomIn: "Zoom In",
        zoomOut: "Zoom Out",
        fullScreen: "Toggle Full Screen",
        window: "Window",
        minimize: "Minimize",
        zoom: "Zoom",
        front: "Bring All to Front",
        close: "Close Window",
      },
    },
    mobile: {
      cannotRead: "The saved connection cannot be read: {why}",
      unreachable: "Cannot reach that computer: both devices must be on the same network, and that computer must allow connections",
      answered: "That computer answered {status}",
      cannotSave: "Saving the pairing failed: {why}",
      cannotRestore: "Restoring the saved connection failed: {why}",
      cannotForget: "The saved connection cannot be forgotten: {why}",
      callEnded: "The call has ended",
      noNotify: "No permission for notifications: turn it on in the system settings",
      noCamera: "No permission for the camera: turn it on in the system settings, or paste the link",
      stopScan: "Stop scanning",
      title: "Connect to VibeValley",
      intro:
        "On the computer running VibeValley, open Connect to this machine under Settings, press Add a device, and scan its QR code. Pairing needs the owner's approval on that computer.",
      scan: "Scan the QR code",
      paste: "Or paste the pairing link",
      name: "This phone is called",
      waiting: "Waiting for the owner on that computer to approve…",
      ask: "Ask the owner to let it in",
      cancel: "Cancel pairing",
      agora: "Agora: {what} failed ({code})",
      agoraLost: "Agora: the connection failed ({reason})",
      step: {
        mute: "muting",
        unmute: "unmuting",
        renew: "renewing",
        initialize: "starting",
        mic: "turning on the microphone",
        volume: "reading the volume",
        join: "joining the channel",
      },
      noMic: "No microphone permission",
      android: "Android phone",
      phone: "A phone",
    },
    server: {
      lookIn: {
        issue: "List the tickets and find its number",
        session: "List the helpers and find its id",
        project: "List the projects and find its name",
        runtime: "List the machines and find its id",
        agent: "List the profiles and find its id",
        skill: "List the skills and find its id",
        template: "List the templates and find its id",
        cron: "List the scheduled tasks and find its id",
        device: "See the connected devices and find its id",
        archive: "List the manager's archive",
        channel: "List the channels and find its id",
        graph: "List the plans and find its id",
        memories: "List its memories and find that one's id",
        artifact: "List the artifacts to find its id",
      },
      projectRef: "project {id}",
      helperRef: "helper {id}",
      archiveRef: "archive {name}",
    },
    "server.agent": {
      template: {
        unreadable: "The template does not read: {file} ({why})",
        noFile: "Not a template: there is no {file}",
        badId: 'The template id "{id}" will not do ({file}): lowercase letters, digits and - only, up to 32',
        badVersion: "A template's version is a whole number from 1 ({file})",
        noRuntime: "A helper's template names the machine it is for, runtime ({file})",
        noTemplate: "There is no template {id}",
        taken: "There is a template {id} already",
        builtIn: "{id} is built in and cannot be deleted",
        notFrom: '"{name}" was not installed from a template',
        gone: '"{name}"\'s template {template} is gone',
        delete: 'Delete the template "{name}"',
        deleteKept: 'Delete the template "{name}": the {installed} profiles installed from it stay',
      },
      notSaved: "Not saved: could not write {file} ({why})",
      orchestratorStays: "The default manager cannot be deleted: there is always at least one manager",
      defaultStaysOrchestrator: "The default manager stays a manager: there is always at least one",
      noAgent: "There is no profile {id}",
      noSkill: "There is no skill {id}",
      orchestratorRuntime: "A manager runs only on VibeValley's own agent: its machine must be {runtime}",
      newAgentId: "Leave a new profile's id empty; to choose the id, save it instead",
      newSkillId: "Leave a new skill's id empty; to choose the id, save it instead",
      removeAgent: 'Delete the profile "{name}" ({id}, on {runtime}): tickets already sent to it keep it',
      removeSkill: 'Delete the skill "{name}"',
      modelFailed: "the model failed",
      noDeepSeekKey: "No DeepSeek key: set DEEPSEEK_API_KEY, or put it in vibevalley.yaml under deepseek.api_key.",
      refused: { launchArgs: "VibeValley runs inside the server process and takes no command-line arguments", serviceTier: "DeepSeek has no service tiers" },
      unequip: "Take it off the profiles of {holders}",
      quoted: '"{name}"',
      efforts: '{runtime} has only the {efforts} thinking efforts, not "{asked}"',
      effortsAnd: " and ",
    },
    "server.artifact": {
      noTitle: "An artifact needs a title",
      longTitle: "The title is too long: at most {max} characters",
      badKind: "No artifact of kind {kind}: only {kinds}",
      empty: "The artifact is empty",
      tooBig: "A version is at most {mb} MB",
      notKept: "The artifact was not kept: {why}",
      missing: "There is no artifact {id}",
      noVersion: '"{title}" has no version {version}; the latest is {latest}',
      noFile: 'The content of "{title}" version {version} is gone',
      made: 'Made "{title}"',
      versioned: '"{title}" is at version {version}',
      withNote: "{said}: {note}",
      preview: {
        remove: 'Delete "{title}" and its {n} versions',
        cards: "Its cards stay in the conversation and say it was deleted when opened",
        removeBlocks: "Delete “{title}” and its {n} blocks",
      },
      untitled: "Untitled",
      noBatch: "This batch of changes has no batchId",
      demoNotInserted: "The demo's block was not inserted: {status}",
      noWriter: "No helper can write: turn one on in the profiles first",
      demoRunning: "The demo is writing: try again when it is done",
      notApplied: "The block was not written",
      op: {
        deleted: "This block was deleted",
        noAttr: "There is no attribute {name}",
        noBlock: "There is no block {id}",
        noId: "The new block has no id",
        taken: "Block {id} already exists",
        unknownType: "Unknown block type {type}",
        badKey: "Not a valid order key: {key}",
        missing: "There is no such block",
        noText: "This block has no text",
        noRev: "There is no version {rev}",
        changed: "Someone else just changed this block",
        underSelf: "A block cannot move under itself",
        splitAtEnd: "Someone else just changed this block, so it was split at its end",
        splitOutside: "The split position {at} is outside the text ({length} characters)",
        intoSelf: "A block cannot merge into itself",
      },
      demo: {
        "0": {
          heading: "Background · demo",
          paragraphs: {
            "0": "(Demo) A script wrote this section; no helper really thought of it. We have several helpers here, and an article used to be written by one of them from start to end while the others waited.",
            "1": "Now a artifact is stored in blocks, each with its own version. Each helper writes its own section without fighting over a block, and the bar on the left shows at a glance who wrote which.",
            "2": "This demo lets you see it for yourself: three helpers write at once, the words grow paragraph by paragraph, and in the end they make one whole article.",
          },
        },
        "1": {
          heading: "How · demo",
          paragraphs: {
            "0": "(Demo) Each helper first inserts an empty paragraph at the end of its section, then replaces that paragraph about once a second, so it looks like a paragraph slowly growing.",
            "1": "Every change goes through the same op pipeline as yours: inserting is insert_block, growing is update_text with the last version's number, and the server takes them in order, batch by batch.",
            "2": "If you change the words in a paragraph a helper is writing, the helper's next write conflicts and does not go in; it leaves that paragraph to you and goes on to the next.",
          },
        },
        "2": {
          heading: "Next · demo",
          paragraphs: {
            "0": "(Demo) Once broadcasting is done, the page will no longer ask the server every second: when a helper writes, you see it at once.",
            "1": "Later, a helper that wants to change another section's words will not change them directly but leave a suggestion for you to approve; a finished section is marked in the outline as done and waiting for you.",
            "2": "That is the end of the demo. Keep this artifact or delete it: it touches no ticket and no memory.",
          },
        },
      },
      badBlockType: "A block's type can only be {types}",
      otherArtifact: "This batch of changes ({batch}) belongs to another artifact",
      notBlocks: "“{title}” is a whole web page, not changed block by block: hand in a new version",
      notHtml: "“{title}” is written together and takes no new version: change it block by block (artifact_block_create, artifact_block_update)",
    },
    "server.base": {
      noFile: "{path}: no such file",
      notPort: "{path}: {name} is not a port: {port}",
      prPoll: "github.pr_poll_seconds must be above 0",
      homeTaken: "The home {home} is used by another server: connect to that one, or stop it first",
      homeUnlocked: "Could not lock the home {home}",
      requestKeyLong: "requestKey is too long (at most {max} characters)",
    },
    "server.channel": {
      name: { owner: "You", orchestrator: "Manager" },
      mention: { orchestrator: "@manager", owner: "@owner", everyone: "@everyone" },
      channelName: "A channel name has only letters, digits, - and _, up to 24 characters",
      channelTaken: "There is already a channel called {name}",
      hopLimit: "The helpers have gone back and forth {limit} times: they pause here until you say something.",
      notBack: "The helpers have not come back yet",
      breaker: "{name} failed {failed} times in a row as soon as it was woken, so it is not woken again for now; telling it something directly tries again.",
      dispatch: {
        step: 'task "{task}" of the plan {graph}',
        split: "splitting the plan {graph}",
        draft: "reading the code and drafting this ticket",
        project: "the project",
        sent: "Sent @{id} ({name}) to {project}: {what}",
        redraft: "This ticket goes to @{id} ({name}) for another draft",
        handedOn: "This ticket goes to @{id} ({name}) to carry on, sent for the {nth, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} time",
      },
      badTarget: "Unknown place: {target} (write #<channel>, such as #general, or #<channel>:<message number>)",
      noMessage: "The channel has no message {n}",
      empty: "Nothing was said",
      sendKeyLong: "The sendKey is too long",
      channelGone: "The channel cannot be found",
      noHelper: "There is no helper {id}",
      noChannel: "There is no channel {id}",
      notOrchestrator: "{id} is not a manager's profile: only a manager can look after a channel",
      noMessageId: "There is no message {id}",
      threadOnlyTitle: "A thread can only get a title",
      defaultStays: "The default channel cannot be archived or deleted: make another one the default first",
      deletesChannel: "Delete {target}, with its {threads} threads and {said} messages",
      inUse: "Cannot delete it: {why}. It can be archived",
      helpersThere: "helpers still work in this channel",
      cronsThere: "{n} scheduled tasks are here",
      connectorsThere: "a connector is bound to it",
      queuedThere: "{n} tickets wait in the queue to start here",
      issuesThere: "{n} tickets were worked here",
      noAttachment: "There is no attachment {id}: upload it first, then say it",
      messageGone: "This message is deleted already",
      notYours: "Only your own words can be changed",
      badEmoji: "A reaction is one emoji or a short word, without spaces",
      threadOnlyInChannel: "A thread opens only under a message in a channel",
      emptyFile: "The file is empty",
      deletes: "Delete message {number} in {target} ({name}: {text}); its number stays",
      deletesDeliveries: "{n} not yet handed are no longer sent",
      defaultIsChannel: "Only a channel can be the default, not a direct channel or a thread",
      noDirect: "{target}: there is no direct channel between you",
      noChannelNamed: "There is no channel #{name}. There are: {tags}",
      absent: "{n, plural, one {{who} is} other {{who} are}} not here; not delivered",
      fileTooBig: "The file is too big: {mb} MB at most",
    },
    "server.cli": {
      flag: {
        prompt: "Ask once and leave, without a conversation",
        runtime: "claude, codex, kimi, pi…; vibevalley is VibeValley's own agent",
        model: "The model",
        effort: "How hard to think",
        resume: "Go on with this session",
        cwd: "Which folder; the current one when empty",
        ownCwd: "Which folder the own agent works in; the current one when empty",
        name: "The own agent's name (its home is ~/.vibevalley/agent/<name>)",
        ownModel: "The model; the configuration's when empty",
        mcp: "The MCP configuration file; mcp.json in the home when empty",
        server: "The server's address; VIBEVALLEY_SERVER when empty, else the one running on this machine (the home's server.json), else {fallback}",
        dryRun: "Only say what it would do, without doing it (commands that delete, merge, close or send a helper away)",
        json: "The request body: JSON text, - to read stdin, @file to read a file",
        watch: "Keep watching: one JSON line per frame",
      },
      command: {
        runtimeChat: "Talk to a machine directly, not through VibeValley: no trajectory, no spending",
        root: "With no command, talk to VibeValley's own agent; every other command calls one of VibeValley's endpoints and answers JSON",
        state: "The core state (GET {path})",
        events: "Side effects, one per line (GET {path})",
        issueWork: "Move a backlog ticket to To do, wait for it to come back and print its changes; each status passed goes to stderr",
        group: "The {group} endpoints",
      },
      next: {
        help: "See how this command is written",
        whatItDoes: "See what this command does",
        startServer: "Start the server first (vp run --filter @vibevalley/server start), or point --server at one that runs",
      },
      and: "; ",
      failure: {
        unreachable: "Cannot reach {base}: {why}",
        shape: "The answer does not fit its Schema: {why}",
        stdin: "Cannot read stdin: {why}",
        file: "Cannot read {file}: {why}",
        notJson: "--json is not JSON: {why}",
        body: "--json does not fit {op}'s request body: {why}",
        dryRun: "{op} changes things, but has no dry run: drop --dry-run to do it",
        retry: "The server asked the stream to reconnect; the command line does not",
        stream: "The stream cannot be read: {why}",
        gone: "Ticket #{n} is gone: it was deleted",
        missingArgument: "<{name}> is missing: give it after the command, or in --json",
      },
      chat: {
        error: "\nSomething went wrong: {why}",
        compacted: "(the conversation so far was compacted into a summary; the original is in {archive})",
        usage: "{aborted, select, true {(stopped, input {input}, cached {cached}, output {output})} other {(input {input}, cached {cached}, output {output})}}",
        hello: "{skills} skills, {tools} MCP tools. /reset forgets the conversation, /exit quits, Ctrl+C stops.",
        forgot: "Forgotten.",
        noRuntime: "There is no machine {id}",
        unknownInstall: "Cannot tell whether {id} is installed",
        unusable: "{id} cannot be used: {kind}",
        resumed: " (resumed)",
        direct: "Talking directly: not through VibeValley, no trajectory, no spending. Ctrl+C stops this turn; again when idle quits.",
        rejected: "Not taken: {why}",
        notSent: "Not delivered: {why}",
      },
    },
    "server.connector": {
      media: { image: "[image]", file: "[file]", audio: "[voice]", video: "[video]", sticker: "[sticker]", message: "[message]", attachment: "[attachment]" },
      namedFile: "[file: {name}]",
      staleLogin: "WeChat says the login expired",
      qqKeys: "Fill in the QQ bot's AppID and AppSecret (on the bot management page at q.qq.com).",
      unreadSecrets: "The saved login cannot be read: disconnect and connect again",
      expired: "The login expired: try again in an hour, or disconnect and connect again.",
      paired: "Paired: what you say here from now on is what you say in the default channel.",
      stopped: "receiving stopped",
      switched: "the account changed",
      disconnected: "disconnected",
      noConnector: "There is no connection {id}",
      noChannel: "There is no channel called {name}",
      line: { orchestrator: "Manager", dispatch: "sent", thread: "in a ticket's thread", head: "[{who}]", headWhat: "[{who} · {what}]" },
      feishu: {
        register: "Feishu registration: {why}",
        registerTimeout: "Feishu registration: timed out",
        noQr: "Feishu does not support making an app by scanning right now: try again later.",
        noLink: "Feishu gave no QR code: try again.",
        denied: "Refused in Feishu.",
        qrExpired: "The QR code expired.",
        incomplete: "Feishu confirmed, but did not give the whole login: try again.",
        tooLong: "Not scanned in time: the QR code expired.",
        disconnected: "Feishu's connection dropped: {why}",
        send: "Feishu send: {why}",
        noId: "Feishu send: no message id confirmed",
      },
      qq: {
        auth: "QQ authentication: {why}",
        authTimeout: "QQ authentication: timed out",
        badKeys: "the AppID or AppSecret is wrong",
        gateway: "QQ gateway: {why}",
        noGateway: "QQ gave no gateway address",
        gatewayError: "QQ gateway: connection error",
        reconnect: "QQ gateway: QQ asked to reconnect",
        invalid: "QQ gateway: QQ says the session is invalid",
        closed: "QQ gateway: connection closed ({code})",
        send: "QQ send: {why}",
        unread: "QQ send: the result cannot be read: {why}",
        noId: "QQ send: no message id confirmed {why}",
      },
      weixin: {
        noQr: "Could not get the login QR code: {why}",
        qrExpiredTimes: "The QR code expired several times: start again.",
        codeWrongTimes: "The digits were wrong several times: start again.",
        taken: "This WeChat is already connected: delete it in WeChat first, or scan with another WeChat.",
        incomplete: "WeChat confirmed, but did not give the whole login: try again.",
        tooLong: "Not scanned in time: the QR code expired.",
      },
      digest: "{n} messages while you were away:\n{lines}\n\nThe whole of them is in the default channel.",
    },
    "server.cron": {
      weekdays: { "0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed", "4": "Thu", "5": "Fri", "6": "Sat" },
      when: {
        once: "once at {clock}",
        hours: "{n, plural, one {every hour} other {every # hours}}",
        minutes: "every {n} minutes",
        daily: "every day at {time}",
        weekdays: "weekdays at {time}",
        weekend: "weekends at {time}",
        monthly: "on day {day} of every month at {time}",
        hourly: "every hour at minute {minute}",
        cron: "cron {expr}",
        weekly: "every {days} at {time}",
      },
      next: { never: "never again", pending: "waiting for your approval", done: "done", off: "off" },
      expr: {
        fields: { "0": "minute", "1": "hour", "2": "day", "3": "month", "4": "weekday" },
        badField: "the cron {name} is wrong: {field}",
        fiveFields: "cron takes five fields: minute hour day month weekday, such as 0 9 * * 1-5",
        never: "this cron never comes due: {expr}",
      },
      problem: {
        noName: "A scheduled task needs a name",
        noText: "A scheduled task needs what to do when it is due",
        zone: "Unknown time zone: {tz}",
        past: "A one-off time must be in the future",
        every: "The interval is at least {min} minutes",
        time: "Write the time as HH:MM, such as 09:00: {time}",
        days: "Which days of the week: 0 to 6, 0 is Sunday",
      },
      due: '{missed, select, true {⏰ The scheduled task "{name}" is due (missed while the server was off, made up once): {text}} other {⏰ The scheduled task "{name}" is due: {text}}}',
      noCron: "There is no scheduled task {id}",
      noChannel: "There is no channel {name}",
      noProfile: "There is no profile called {name}",
      noProject: "#{channel} has no default project: a scheduled task sent straight to a helper needs a project",
      removeWhen: 'Delete the scheduled task "{name}" ({when}): it no longer starts work when due; the tickets it opened stay',
    },
    "server.game": {
      badge: { ripe: "Ripe", bugs: "Bugs", retrying: "Retrying", rest: "Resting", weeding: "Weeding {n}" },
      tier: { silver: "Silver {title}", gold: "Gold {title}" },
      reached: { starter: "Starter task done", secret: "Found a secret", gold: "Up to gold", silver: "Up to silver", unlocked: "Achievement unlocked" },
    },
    "server.inbox": {
      orchestrator: "The manager",
      conflictFiles: "{files, plural, one {# file conflicts with main} other {# files conflict with main}}",
      step: "{graph}: {step}",
      item: {
        review: { label: "For you to see", title: "{who} is done", tray: "{who} is done, for you to see" },
        ask: { label: "A question for you", title: "{who} has a question for you" },
        fix: { label: "It failed", title: "{who} failed", tray: "{who} failed" },
        interrupted: { title: "{who} stopped halfway" },
        conflict: { label: "Won't merge", title: "{who}'s work would conflict with main", tray: "{who}'s work would conflict" },
        quiet: {
          label: "Quiet for a while",
          title: "{who} has been quiet for a while",
          body: "It may be running a long command, or it may be stuck: look at what it has been doing.",
          tray: "{who} has gone quiet",
        },
        "graph-draft": {
          label: "Plan drafted",
          title: 'The plan "{text}" is drafted',
          body: "Look it over before it starts",
          tray: 'The plan "{text}" is for you to see',
        },
        "graph-ready": {
          label: "Plan done",
          title: 'The plan "{text}" is all done',
          body: "Look over the changes and merge them into main",
          tray: 'The plan "{text}" is ready to merge into main',
        },
        "task-failed": { label: "Plan stuck", title: "A plan is stuck: {text}", body: "Retry, edit the ticket, or skip it", tray: 'The plan "{text}" failed' },
        mention: { label: "Calling you", title: "{who} is calling you" },
        "cron-ask": {
          label: "A scheduled task to approve",
          title: "The manager wants to set a scheduled task",
          body: '"{text}": it starts once you approve',
          tray: 'The scheduled task "{text}" waits for your approval',
        },
      },
    },
    "server.issue": {
      issueNumbered: "ticket #{n}",
      issueRef: "ticket {ref}",
      helperRef: "helper {id}",
      projectRef: "project {name}",
      helper: "the helper",
      notStarted: "This ticket has not started yet",
      inGraph: "This ticket belongs to a plan: change it in the plan",
      started: "This ticket has already started",
      noTitle: "The ticket has no title",
      notQueued: "Ticket {id} is not in the queue",
      orchestratorNotHelper: "The manager is not a helper: send it to a helper",
      disabled: "{name} is disabled",
      cannotSend: "{name} cannot be sent: {why}",
      noProject: "No project was named: a project is a folder in the work folder",
      notRecorded: "{name}'s ticket was not recorded: {why}",
      workKept: "{refused}; ticket #{n} and its changes are kept, and it can be sent again",
      drafting: "{name} is drafting it: start it once the draft comes back",
      pickHint: 'Once picked, give it when moving to To do: {command}, with --json status "todo" and assignee (the profile\'s id)',
      noAssignee: "No helper has been picked yet",
      profileGone: "The profile {id} is gone",
      sendFailed: "It could not be sent",
      queued: "{full}: queued, it starts as soon as there is room",
      queuedStarted: 'The queued "{title}" has started: {session}',
      queuedStuck: 'The queued "{title}" could not start: {why}; it could not go back to To do either, and stays in the queue',
      queuedBack: 'The queued "{title}" could not start and stays in To do: {why}',
      graphRetry: "This ticket belongs to a plan and follows it: retry the task in the plan, or reopen the whole plan",
      neverStarted: "This ticket has never started: just start it",
      stillOpen: "This ticket is still open: moving it back to To do is another round",
      stillWorking: "{name} is still on this ticket: tell it directly",
      senderGone: "The profile it was sent to, {id}, is gone",
      cronNoIssue: 'The scheduled task "{name}" could not write its ticket: {why}',
      cronNoStart: 'The scheduled task "{name}" could not start: {why}',
      closedReopen: "This ticket is closed: reopen it with a few words",
      noProfileNamed: "There is no profile called {key}",
      handOverOnTodo: "Handing over happens when moving to To do: move it there and say who takes over",
      stopFirst: "#{n} is still in this round: stop it, and hand it over once it has stopped",
      noStatus: "There is no such status: {to}",
      roundNeedsWords: "Another round needs a few words: what it should do this round",
      talkTitle: "Talking with {name}",
      closed: "This ticket is closed",
      cannotMoveProject: "Ticket #{n} cannot change project yet: {why}",
      cannotDelete: "Ticket #{n} cannot be deleted yet: {why}",
      noConflict: "{name} has no conflict with main",
      orchestratorAnswers: "This ticket is the manager's: it closes once the manager answers",
      graphAcceptance: "This ticket belongs to a plan and follows it: accept it in the plan",
      nothingToAccept: "Nothing has been handed back yet, so there is nothing to accept",
      failNeedsFindings: "Failing the acceptance needs what is wrong: write at least one point",
      does: {
        toOrchestrator: "{n} goes to the manager to answer",
        sendTo: "{n} is sent to {agent}",
        noRoom: "No room now ({full}): it is queued in To do and starts as soon as there is room",
        startIn: "{n} sends {agent} to work in {project}",
        start: "{n} sends {agent} to work",
        unqueue: "{n} leaves the queue, back to Backlog",
        leaves: "{helper} leaves, the branch is kept",
        takesOver: "{taker} takes over and carries on on the same branch",
        orchestratorRound: "{n} goes back to the manager for another answer: {said}",
        round: "Tell {helper} this, for another round: {said}",
        thisTime: "What to do this time: {said}",
        revive: "{n} goes back to Backlog",
        completeNone: "{n} closes as done: nothing to merge",
        completeKept: "{n} closes as done: the branch is kept, not merged ({commits} commits)",
        helperLeaves: "{helper} leaves",
        commitFirst: "First commit {helper}'s {files} uncommitted files for it",
        check: "Run the project's check before merging (.vibevalley/check, if any): if it fails nothing is merged and the ticket stays for you to see",
        pullRequest: "Push the branch and open a PR ({commits} commits): it closes as done once the PR is merged",
        cancel: "{n} closes as canceled",
        cancelLeaves: "{helper} leaves; a branch with commits is kept",
        drop: "{n} closes as canceled: it was never sent",
        drafterLeaves: "{name}, who is drafting it, leaves",
        reject: "#{n} goes back: {findings} points for {helper} to fix in another round",
        resolve: "Have {helper} merge main into its branch, resolve the conflict, and hand it back",
        resume: "Have {helper} carry on: {words}",
        cure: "Have {helper} fix it and hand it back",
        deleteIssue: 'Delete ticket #{n} "{title}"',
        cleanWorktree: "Clear its worktree and its branch with no commits; with changes left it is not deleted",
        reopen: "{n} reopens: a new helper of the same profile carries on",
        reopenBy: "{n} reopens: {taker} carries on",
        conflicts: "Merging into {base} would conflict ({files}): nothing is merged, the conflict is marked, and the ticket stays for you to see",
        merge: "Merge into {base} ({commits} commits), close as done, and {helper} leaves",
        mainBranch: "main",
      },
      brief: {
        reopenDefault: "Finish this ticket",
        handedOver: "This ticket is handed over to you; {name} ({id}) was on it before",
        reopened: "This ticket is reopened; {name} ({id}) did it last time",
        how: "\n\n({how}.)",
        original: "\nThe ticket was: {brief}",
        answer: "\nLast time's answer: {conclusion}",
        closed: "\nHow it was closed: {closed}",
        lastRun: "\nThe last round {outcome}: {summary}",
        previous: "\nThis branch already has last time's commits; carry on from them.",
        end: "\nFirst look at the project as it is now, then carry on.",
        failedHead: "The acceptance failed; these need fixing:",
        failedEnd: "\n\nOnce fixed, say how each was fixed in your conclusion.",
        resume: "The last round stopped halfway; carry on and finish it.",
        cure: "Fix it: {brief}. Look at the errors, fix them, and run the tests again",
        cureHead: "Fix it: ",
        cureTail: ". Look at the errors, fix them, and run the tests again",
        answerUnread: "Fix it: the answer handed back last round could not be read ({problem}). Find it out, and hand it back in this format at the end:",
      },
      move: {
        inGraph: "This ticket belongs to a plan and follows it: change it in the plan",
        same: "It already has this status",
        byHelpers: "In progress and For you to see come from a helper's work: move it to To do and it starts",
        drafting: "{name} is drafting it: start it once the draft comes back",
        working: "This round is still going: wait for it to come back, or move it to Canceled",
        failed: "This round failed: send it for another round with a few words, or close it",
        reopen: "Moving a closed ticket back to To do reopens it with a few words",
        revive: "A ticket canceled before it started goes back to Backlog first",
        cannot: "Cannot move from {from} to {to}",
        sayWithText: "{label}: {command}, with --json the text to say",
        moveTo: "Move to {status}",
        roundWithText: '{say}: {command}, with --json status "{to}" and the text of what to do this round',
      },
      template: { commands: { test: "the tests", lint: "the linter", build: "the build" }, done: "{title}\nDone when: {done}" },
      timeline: {
        opened: "Opened",
        refine: "Started drafting",
        told: "You told it something; another round",
        start: "Started",
        restart: "Reopened, carrying on",
        graph: "Started by the plan",
        cron: "{missed, select, true {Started on schedule (made up)} other {Started on schedule}}",
        runtime: "The machine carried on by itself",
        refined: "Drafted",
        reported: "Handed back",
        said: ": {summary}",
        accepted: "Accepted",
        asked: "Asked you: {questions}",
        rejected: "Sent back: {lines}",
        rejectedSeparator: "; ",
      },
      merge: { tellFailed: "\nCould not tell the helper: {why}", merged: "{name}'s work is merged: {text}" },
      refinement: {
        noDrafter: "No helper can be sent to draft it",
        orchestrator: "This ticket is the manager's: the manager reads it itself",
        onlyBacklog: "Only a ticket in Backlog can be drafted: move it back to Backlog first",
        drafting: "{name} is drafting it: wait for it to come back",
        noProject: "No project was named: pick a project first",
        unread: "The draft {name} handed back could not be read ({problem}); the ticket is unchanged: draft it again",
        unfinished: "{name} did not finish the draft ({summary}); the ticket is unchanged: draft it again",
        canceled: '"{title}" was canceled: {why}',
        noBlock: "No draft found: it goes in a json code block",
        notObject: "it must be an object",
        unreadable: "the json cannot be read: {why}",
        noTitle: "the draft has no title",
        lines: "{field}: must be a string or an array of strings",
        text: "{field}: must be a string",
        why: "Why:",
        todo: "To do:",
        notDoing: "Not doing:",
        files: "May touch:",
      },
    },
    "server.lan": {
      aDevice: "A device",
      noDevice: "There is no device {id}",
      notUp: "VibeValley is not up yet",
      unpaired: "This device is not paired, or the owner removed it: pair it again by scanning on that computer",
      notRemote: "A connected device cannot do this: only the computer running VibeValley can",
      badGateway: "Could not pass it on",
      cannotOpen: "The connection cannot open: {why}",
      noAddress: "Cannot find this computer's address on the local network: connect to Wi-Fi or a cable and try again",
      notOpen: "Connections are not allowed yet: turn them on first",
      noneAsking: "No device is waiting for your approval",
      closedThere: "That computer does not allow connections: turn on Connect to this machine there",
      codeExpired: "The pairing code expired: get a new one on that computer",
      wrongCode: "Wrong pairing code",
      anotherAsking: "Another device is waiting for the owner's approval: try again in a moment",
      ownerLate: "The owner did not approve in time and the pairing code expired: get a new one on that computer",
      denied: "The owner did not let this device in",
      noCode: "No pairing code is out: nothing changes",
      dropCode: "Withdraw the pairing code {code}",
      dropAsking: '"{name}", waiting for your approval, cannot get in',
      forget: 'Forget the device "{name}": its key stops working, and it must pair again to connect',
      cut: "Cut its {n} open connections",
      local: "This is the machine running VibeValley, not a connected device",
    },
    "server.memory": {
      source: { local: "Local", nowledge: "Nowledge Mem", everos: "EverOS" },
      noUrl: "no address",
      off: "off",
      unknownSource: "unknown kind of source",
      stopped: "The memory sources have stopped",
      forgetThere: "Memories in {source} are deleted there",
      coverage: {
        failed: "reading failed, was canceled or timed out; this source is not included",
        everosAcross: "searching across projects is not supported: name a project; EverOS is not included this time",
        everosAgent: "this search needs a profile; EverOS is not included this time",
        unconfirmed: "some hits' project could not be confirmed and were left out of this project's search",
        note: "{source}: {note}",
      },
      everosList: "EverOS memories are not listed here",
      everosForget: "EverOS memories are deleted in EverOS",
      nowledgeForget: "Nowledge Mem memories are deleted in Nowledge Mem",
      empty: "There is nothing to remember",
      dbFailed: "Not remembered: the database could not be written",
      fileFailed: "Not remembered: MEMORY.md could not be written",
      noMemory: "{agent}'s memory has no {id}",
      forgetOrchestrator: 'Delete this line from the manager\'s MEMORY.md: "{text}"',
      forget: 'Forget from {agent}\'s memory: "{text}"',
      orchestratorRecall: "The manager does not recall: it always carries its whole memory",
    },
    "server.orchestrator": {
      label: "The manager",
      noKey:
        "I don't have a DeepSeek key yet, so I can't think. Put a DeepSeek API Key in Settings (also at the bottom of the workbench's left bar), then tell me again.",
      cannotStart: "I can't start on my side: {why}",
      onlyDeepseek:
        "The manager runs only on DeepSeek models: set the manager profile's model to deepseek/<model> or just the model's name; {configured} cannot be used",
    },
    "server.project": {
      badName: "A project name starts with a letter or a digit and has only letters, digits, -, _ and ., up to 64 characters",
      badGithub: "Give a GitHub repository address, such as https://github.com/botiverse/raft-source",
      branchMoved: "The branch changed after the check: check again before merging",
      mainMoved: "Main changed during the check: check again before merging",
      mergedWorktreeLeft: "The changes are merged; the worktree {cwd} and the branch {branch} are not cleared yet: {why}",
      mergedBranchLeft: "The changes are merged; the branch {branch} is not cleared yet: {why}",
      noTokei: "Counting code needs tokei, which is not on this machine: install it (brew install tokei, or cargo install tokei) and count again",
      noName: "unnamed",
      gh: {
        missing: "gh is not installed",
        failed: "gh could not be checked",
        signedOut: "not signed in to GitHub",
        noAccount: "the GitHub account could not be confirmed",
      },
      notProjectName: '"{name}" cannot be a project name: use a simple English folder name, such as clock-in',
      outside: "A project must be inside the work folder, not linked to somewhere outside it",
      commit: {
        initial: "Initial commit (a project VibeValley made)",
        initialShort: "Initial commit",
        leftOver: "Commit what was left uncommitted before merging",
        merge: "Merge {branch}",
      },
      notChecked: "The project has not been checked: refresh GitHub's state",
      check: {
        timedOut: "The project's check .vibevalley/check timed out ({seconds}s)",
        failed: "The project's check .vibevalley/check failed: {why}",
        exited: "The project's check .vibevalley/check failed: exit status {code}",
      },
      mergeFailed: "Merging into {main} failed, {kept}: {why}",
      mergeStuck: "Merging into {main} failed, {kept}: {why}; aborting the merge failed too ({abort}), and {main} is stuck halfway: it needs tidying by hand",
      exists: '"{name}" already exists: pick another project name',
      cloneFailedGh: "The download failed: check the GitHub sign-in, the repository's permissions and the network, then retry",
      cloneFailed:
        "The download failed: check that the repository is public, the address is right and the network works; it stops after 3 minutes, and can be retried",
      tokeiFailed: "tokei did not finish counting: {why}",
      tokeiUnread: "tokei's output cannot be read: try a newer tokei",
      noBranchRead: "Could not read the branch {branch}: {why}",
      inProjectNoBranch: "It works right in the project, so there is no branch to merge",
      inProjectNothing: "It works right in the project, so there is no branch to merge",
      keptBoth: "the {branch} branch and its worktree are kept",
      keptBranch: "the {branch} branch is kept",
      merged: "{ahead} commits merged into {project}'s {main}",
      nothingNew: "This one has no new commits",
      nothingNewInPlan: "The plan's branch has no new commits",
      branchLeft: "; the changes are merged, the branch {branch} is not cleared yet: {why}",
      clear: {
        uncommitted: "{branch} has uncommitted changes; its worktree stays at {cwd}",
        branchLeft: "{branch} was not cleared: {why}",
        unmerged: "{branch} has {ahead} unmerged commits: the branch is kept, the worktree cleared",
        notWorktree: "Not a worktree, so it cannot be reset: {cwd}",
        worktreeLeft: "The worktree {cwd} was not cleared: {why}",
        unconfirmed: "Could not confirm {branch} was cleared: {why}",
        unmergedKept: "{branch} has unmerged commits: the branch is kept",
      },
      github: {
        unchecked: "GitHub has not been checked",
        notGithub: "Not a GitHub repository",
        noPermission: "The repository's permissions could not be checked",
        readOnly: "No write permission",
        wrongBranch: "The ticket's branch does not match",
        pushFailed: "Pushing the ticket's branch failed: check origin and the sign-in, then retry",
        listFailed: "Looking up existing PRs failed; the branch is pushed, so it can be retried",
        listUnread: "The existing PRs could not be read",
        checked: ".vibevalley/check passed.",
        noCheck: "This project has no .vibevalley/check, so no check was run.",
        body: "Ticket #{n}\n\n{conclusion}\n\n{check}",
        createFailed: "Creating the PR failed; the branch is pushed, so it can be retried",
        urlUnread: "The new PR's address could not be read; the lookup can be retried",
        viewFailed: "Looking up PR #{n} failed",
        stateUnread: "PR #{n}'s state could not be read",
        stateUnknown: "PR #{n}'s state is not one VibeValley knows",
        worktreeLeft: "The PR is over, but clearing the worktree failed: {why}",
        branchLeft: "The PR is over, but clearing the local branch failed: {why}",
      },
      mergeTree: "git merge-tree failed ({code})",
      moreLines: "… {n} more lines not shown",
      conflict: "merging into {base} conflicts",
    },
    "server.runtime": {
      date: "{month}/{day} {time}",
      quotaGone: "{runtime}'s quota is used up ({window}){resets}; send work then",
      resets: ", it resets {when}",
      balanceGone: "{provider}'s balance is used up; top it up before sending work",
      budget: "Today's spending is {spent}, the daily budget of {budget} (the Runtimes page can change it)",
      quota: {
        none: "no quota reported",
        signedOut: "not signed in",
        unread: "the quota cannot be read ({why})",
        noBalance: "{provider}'s balance cannot be read",
        some: "has quota",
        balance: "{provider} balance {balances}",
        balanceLow: "{provider} balance {balances}, not enough",
        window: "{label} {left}% left",
        windowSeparator: ", ",
      },
      lessThanCent: "less than ¥0.01",
      persona: "{refused}. Change the persona to go at the start of the ticket.",
      noModel: "{runtime}'s model list has no {model}",
      runtimeDefault: "{runtime}'s default {model}",
      unknownRuntime: "Unknown runtime: {runtime}",
      notInstalled: "This runtime is not on this machine",
      disabled: "This runtime is disabled on the Runtimes page",
      noUsage: "This runtime reports no usage",
      cursor: "Cursor needs its own SDK (@cursor/sdk), which VibeValley does not use yet",
      oarUnknown: "oar does not know this runtime",
      tools: "{n, plural, one {# tool} other {# tools}}",
      notSaved: "{id}'s settings were not saved: {why}",
      cannotDrive: "oar cannot drive {runtime}",
      cannotSend: "{name} cannot be sent: {why}",
      defaultModel: "{runtime} has no model {model}; {name} uses the default for now",
      piNoBalance: "{provider} reports no balance",
      piNoModel: "pi has no default model set",
      piUnread: "The DeepSeek balance could not be read",
      effort: "{model} has no {effort} effort; it has: {levels}",
    },
    "server.session": {
      failure: {
        auth: "something is wrong with the sign-in or the key",
        quota: "the quota is used up",
        rate_limited: "too many requests, rate limited",
        billing: "not enough balance",
        model_unavailable: "this model cannot be used",
        input_too_large: "the context is too long to fit",
        invalid_request: "the provider refused the request",
        overloaded: "the provider is too busy",
        provider: "the provider failed",
        runtime_exited: "the runtime process exited halfway",
        unknown: "something went wrong",
      },
      failureNext: { userAction: "it needs you first", now: "it can try again", later: "try again in a while" },
      failureStatus: " (HTTP {status})",
      failureReason: ": {reason}",
      failureThen: ". {next}",
      done: "done",
      unfinished: "unfinished",
      answer: {
        lines: "{field}: must be a string or an array of strings",
        noBlock: "No answer found: it goes in a json code block",
        notObject: "it must be an object",
        unreadable: "the json cannot be read: {why}",
        empty: "the conclusion is empty",
        noEvidence: "the conclusion rests on nothing: give at least one piece of evidence",
      },
      noRoom: {
        farm: "{max} helpers are already at work",
        runtime: "{on} helpers are already at work on {runtime}, at most {max} at once (the Runtimes page can change it)",
        project: "{on} helpers are already at work in {project}, at most {max} at once: more would edit the same files",
      },
      notTaken: {
        conflictOwner:
          "Not merged: merging into {base} would conflict ({files}). {name} is still here, with its branch and worktree. To have it resolve this, tell it: {brief}",
        conflictNotice: "{name}'s branch would conflict with {base} ({files}), so it was not merged. It can resolve the conflict itself",
        conflictShort: "Merging into {base} would conflict: {files}",
        checkFix: "{reason}\nFix the check and hand it back.",
        owner: "Not merged: {why}. {name} is still here",
        notice: "{name}'s work was not merged: {why}",
        checkShort: "the project's check failed",
      },
      log: {
        stopped: "VibeValley stopped, and this round was cut short",
        image: "[image]",
        exitedNotice: "{name}: {why}",
        staleRun: "The last round stopped halfway too long ago, and was not carried on",
        stoppedByOwner: "You stopped it",
        folded: "Folded the conversation, {usage}",
        clipped: "… {n} characters left out …",
        quiet: "Quiet for {span}{last}. It may be running a long command, or it may be stuck",
        quietLast: " (last: {label})",
        restarted: "VibeValley restarted, and this round stopped halfway",
        retry: "The model call failed, retry {attempt}",
        retryOf: "The model call failed, retry {attempt}/{of}",
        retryIn: " in {s} s",
        retryWhy: ": {reason}",
        exited: "{runtime} exited",
        exitedCode: "{runtime} exited (exit code {code})",
      },
      usage: {
        parts: { instructions: "instructions", env: "environment", skills: "skills", memory: "memory", tools: "tools" },
        cached: "cache hit {percent}%: read from cache {read}, missed {missed}, output {output}",
        unread: "how much was read was not reported: output {output}",
        changed: "; the start changed: {parts}",
      },
      host: {
        stopped: "{label} has stopped",
        cannotStart: "cannot start: {why}",
        notRecorded: "{label}'s run could not be recorded: {why}",
        startFailed: "{label} cannot start: {why}",
        callerStart: "I cannot start on my side: {why}",
        failed: "{label} failed: {why}",
        markNeedsWords: "Write a line on what it should be",
        noStep: "{label}'s log has no step {on}",
        stepHint: "The step numbers are in its log on the page, before each step",
        notAsked: "Step {on} is not something {label} was told",
        notInConversation: "What step {on} told {label} did not reach its conversation (was {label} not up then?)",
      },
      life: {
        stoppedNeedsYou: "{name} stopped: {why}",
        quietNotice: "{name} has been quiet for {span}{last}: open its plot to see what it is doing, and stop it if it is wrong",
        notStopped: "The machine did not stop, and its working folder is kept: {why}",
        notReturned: "The machine has not handed the working folder back from last time",
        agentGone: "{name}'s profile was deleted; it cannot be woken",
        cannotWake: "{name} cannot be woken: {why}",
        noHelper: "There is no helper {id}",
        helperRef: "helper {id}",
        stillClosing: "{name}'s machine did not stop: its working folder is kept, and no new round can start",
        noRoom: "{name} does not carry on for now: {full}",
        notReceived: "{name} did not get it: {why}",
        inGraph: "{name} is working on a step of the plan {graph}: it merges into the plan's branch when done, and into main with the whole plan",
        stillWorking: "{name} is still working: wait for this round to finish, or stop it first, then collect it",
        notBack: "{name} did not come back: {why}",
        placeGone: "its working folder is gone ({cwd})",
        noRecord: "there is no record of it",
        restartedNotice: "VibeValley restarted and {name}'s round stopped; tell it something to carry on",
        issueNotReturned: "This ticket's machine has not handed the working folder back",
        noPlace: "{name} has nowhere to work: {why}",
        cannotSend: "{name} cannot be sent: {why}",
        notRecorded: "{name}'s ticket was not recorded: {why}",
        steered: "{name} is at work; the words were put in",
        queued: "{name} reads this once this round is done",
        started: "{woke, select, true {{name} woke up and starts a new round} other {{name} starts a new round}}",
        notReset: "{name}'s working folder could not be reset: {why}",
        left: "{name} has left: {why}",
        stillHasHelper: "This ticket still has a helper; its working folder cannot be cleared",
        seconds: "{n} s",
        minutes: "{n} min",
      },
      conflictBrief:
        "Merging {base} into your branch conflicts ({files}). On your branch, run git merge {base}, resolve the conflicts, run the tests, and commit. In your conclusion, say how each conflict was settled.",
    },
    "server.setting": {
      deepseekKey: "The DeepSeek API Key does not look right: a string with no spaces, usually starting with sk-",
      agoraId: "Agora's App ID is 32 hexadecimal digits: find it in your project on Agora's console",
      agoraCertificate: "Agora's App Certificate is 32 hexadecimal digits: find it in your project on Agora's console",
      voiceKeySpace: "A voice service's key should have no spaces",
      dictationUrl: "The dictation address is a full address starting with http(s), up to /v1, such as http://127.0.0.1:8080/v1 on this machine",
      dictationModel: "Dictation needs a model name, such as qwen3 for a local speech-server, or OpenAI's gpt-4o-mini-transcribe",
      memory: {
        unknown: "Unknown memory source: {kind}",
        twice: "Only one memory source of each kind: {kind}",
        noUrl: "To connect a memory source, fill in its address first",
        url: "A memory source's address is a full address starting with http(s), such as http://127.0.0.1:14242/mcp/ for Nowledge Mem",
        keySpace: "A memory source's key should have no spaces",
      },
      voice: {
        label: {
          silenceMs: "How long a pause ends a turn (ms)",
          interruptMs: "How long you speak to interrupt (ms)",
          idleSeconds: "How long before it leaves an empty call (s)",
        },
        range: "{label} must be between {min} and {max}",
        region: "Microsoft recognition needs a region, such as eastasia",
        model: "The model needs a name",
        url: "The model's address is a full address starting with http(s), such as https://api.openai.com/v1/chat/completions",
        voiceId: "The voice cannot be empty: pick one or fill in a MiniMax voice id",
        microsoft: "Microsoft speech needs a region and a voice name",
        persona: "The manager's persona cannot be empty",
      },
      defaults: { failureMessage: "I got stuck for a moment. Could you say that again?" },
      notSaved: "Could not save {file}: {why}",
    },
    "server.task": {
      graphState: {
        splitting: "being split",
        draft: "waiting for you to look it over before it starts",
        running: "in progress",
        paused: "paused",
        ready: "all done, waiting for you to merge it into main",
        done: "merged into main",
        abandoned: "abandoned",
      },
      graphTag: {
        splitting: "Splitting",
        draft: "For you to see",
        running: "In progress",
        paused: "Paused",
        ready: "To merge",
        done: "Merged",
        abandoned: "Abandoned",
      },
      graphAction: { start: "Start", pause: "Pause", resume: "Resume", abandon: "Abandon", merge: "Merge into main" },
      taskState: { waiting: "waiting", working: "in progress", merged: "merged", failed: "failed", skipped: "skipped" },
      taskAction: { retry: "Retry", skip: "Skip" },
      actor: { owner: "You", orchestrator: "Manager", session: "Helper", system: "VibeValley" },
      field: { title: "title", brief: "ticket", needs: "waits for", agent: "who does it", check: "check", scope: "where to change" },
      event: {
        splitting: "A plan is to be split{why}",
        paused: "Paused{why}",
        resumed: "Resumed",
        ready: "All done, waiting for you to merge it into main",
        merged: "Merged into main",
        abandoned: "Abandoned{why}",
        taskStarted: "{step} started{by}",
        taskSentBack: "{step} sent back to redo{by}{why}",
        taskFailed: "{step} failed{why}",
        taskRetried: "{step} retried",
        taskRequeued: "{step} has no helper on it any more, queued again",
        taskSkipped: "{step} skipped, the rest go on",
        taskAdded: "Added the task {step}",
        taskRemoved: 'Removed the task "{title}"',
        step: '"{title}"',
        by: " ({session})",
        why: ": {detail}",
        drafted: "Split, waiting for you",
        draftedSteps: "Split into {steps} tasks, waiting for you",
        started: "Started",
        startedOn: "Started on branch {branch}",
        taskMerged: "{step} merged into the plan's branch{why}",
        taskMergedCommits: "{step} merged into the plan's branch ({commits}){why}",
        taskEdited: "Changed {step}'s {fields}",
      },
      problem: {
        empty: "The plan has no tasks",
        tooMany: "At most {max} tasks, this has {n}: merge the small ones",
        badId: '"{id}" cannot be a task id: use a short English word, such as api',
        duplicate: 'The task id "{id}" is used twice',
        noBrief: '"{id}" has no ticket',
        noCheck: 'The acceptance task "{id}" has no check command: the command is the acceptance',
        self: '"{id}" cannot wait for itself',
        missing: '"{id}" waits for "{other}", which does not exist',
        circle: "These tasks wait for each other in a circle: {ids}",
      },
      parse: {
        object: "must be an object",
        string: "{at} must be a string",
        array: "{at} must be an array",
        stepObject: "{at} must be an object",
        missing: "{at} is missing",
        boolean: "{at} must be a boolean",
        noBlock: "No plan found: it goes in a json code block",
        unreadable: "the json cannot be read: {why}",
        shape: "the plan's format is wrong: {why}",
      },
      edit: {
        taskSettled: '"{title}" is {state} and cannot be changed now',
        graphSettled: "The plan is {state}; no tasks can be added now",
        noStep: 'The plan has no task "{id}"',
        cannotRemove: '"{title}" is {state} and cannot be removed: you can skip it',
        remove: 'Remove the task "{step}" from the plan "{graph}"',
        stopWaiting: "{steps} no longer wait for it",
      },
      noGraph: "There is no plan {id}",
      notSaved: 'The plan "{title}" could not be saved: {why}',
      notice: {
        notSplit: 'The plan "{title}" could not be split: {why}',
        splitStopped: "the planning was stopped",
        plannerFailed: "the planner failed: {summary}",
        noGraph: "it gave no usable plan: {problem}",
        drafted: 'The plan "{title}" is split into {steps} tasks: look it over under Plans before it starts',
        noHelper: "no helper can be sent",
        waits: '"{title}" waits for now: {why}',
        taskFailed: 'In the plan "{graph}", "{task}" failed: {why}',
        unknownFiles: "cannot tell which files it changed: {why}",
        acceptancePassed: "the acceptance {check} already passes",
        checkFailed: "{check} failed after the task",
        noBranch: "the plan has no branch yet",
        stepNotSaved: 'The task "{title}" is merged into the plan\'s branch, but its done state could not be saved: {why}',
        ready: 'The plan "{title}" is all done: look over the changes under Plans and merge them into main',
        stepStopped: '"{title}" was stopped and the plan is paused; resume to carry on',
        plannerGone: "the planner was sent home",
        helperGone: "the helper was sent home before the task was done",
        done: "done",
        restartedSplitting: "VibeValley restarted while planning: say again what to do",
        restarted: "VibeValley restarted and the plan is paused; resume to carry on",
        split: '{name} split the ticket "{title}" into {n} sub-tickets and started them',
        splitBy: "split by {name}",
        splitNotSaved: "The plan's branch {branch} was made, but the split tickets could not be saved: {why}",
        frozenTouched: "it changed the frozen acceptance: {files}",
      },
      act: {
        noGoal: "Nothing was said to do",
        noProject: "No project was named: a project is a folder in the work folder",
        noSplitter: "No helper can be sent to split the plan",
        notSent: "it was not sent",
        plannerNotSent: "The planner could not be sent: {why}",
        splittingBy: "{name} is reading the code and splitting the plan ({id}). It will be under Plans; look it over before it starts.",
        startNotSaved: "The plan's branch {branch} was made, but its start could not be saved: {why}",
        started: 'The plan "{title}" has started on branch {branch}',
        pausedNote: "Paused: the tasks under way finish, no new ones start",
        paused: 'The plan "{title}" is paused: the tasks under way finish, no new ones start',
        resumed: 'The plan "{title}" carries on',
        branchKeptNote: "; the branch {branch} is kept",
        abandonedNote: "Abandoned{kept}",
        notMergedNote: "Not merged: {why}",
        notMerged: "Not merged: {why}. The plan's branch {branch} is kept",
        mergeNotSaved: "The plan's branch is merged into main, but its done state could not be saved: {why}",
        merged: 'The plan "{title}" is merged: {text}',
        noStep: 'The plan has no task "{id}"',
        graphIs: "The plan is {state}",
        notFailed: '"{title}" did not fail; there is nothing to retry',
        retried: '{name} carries on with "{title}"',
        requeued: '"{title}" is queued again',
        working: '"{title}" is in progress: stop it first',
        finished: '"{title}" is already done',
        skipped: 'Skipped "{title}"; the tasks after it start as usual',
        stepAct: '{action} "{title}"',
        edited: "Changed",
        notStarted: 'The plan "{title}" has not started and has no branch',
        branchGone: 'The plan "{title}"\'s branch is gone: check whether it was deleted',
        stepsWrong: "The tasks have problems; fix them and split again:\n- {problems}",
        cannot: 'The plan "{title}" is {state}: it cannot {action}',
        abandoned: 'The plan "{title}" is abandoned',
        abandonedKept: 'The plan "{title}" is abandoned, the branch {branch} is kept',
        conflict: "Merging into {base} would conflict ({files}): {base} changed meanwhile",
      },
    },
    "server.tool": {
      labels: {
        project_list: "Projects",
        channel_list: "Channels",
        channel_create: "Open a channel",
        channel_update: "Change a channel",
        cron_create: "New scheduled task",
        cron_list: "See the scheduled tasks",
        cron_delete: "Cancel a scheduled task",
        issue_review: "Review",
        issue_diff_get: "See the changes",
        session_list: "Helper roster",
        issue_get: "See the progress",
        issue_comment_create: "Tell a helper",
        channel_message_list: "Read the chat",
        channel_message_send: "Say",
        channel_unread_list: "See what is unread",
        session_stop: "Stop",
        issue_list: "Find tickets",
        issue_create: "Write a ticket",
        issue_update: "Change a ticket",
        issue_status_update: "Move a ticket",
        graph_split: "Split a plan",
        graph_list: "See the plans",
        graph_get: "See a plan",
        graph_task_update: "Change a plan",
        graph_task_delete: "Delete a plan's task",
        graph_act: "Plan",
        graph_task_act: "A plan's task",
        issue_split: "Split a ticket",
        remember: "Remember",
        rewrite_memory: "Tidy the memory",
        search_archive: "Search old talks",
        memory_search: "Search the memory",
        memory_create: "Remember for a helper",
        artifact_block_create: "Add to an artifact",
        artifact_block_update: "Change an artifact's block",
      },
      about: "{label}: {about}",
    },
    "server.voice": {
      misheard: "Hm? I didn't catch that. Could you say it again?",
      unknownSuffix: "the server cannot use it yet",
      unknown: "{vendor} for {what}: the server cannot use it yet",
      part: { asr: "recognition", llm: "the model", tts: "speech" },
      noAsrKey: "Microsoft recognition has no key yet: fill it in under Recognition on the Voice page",
      noLine: "The manager's voice line is not connected",
      noDeepseekKey: "DeepSeek needs a DeepSeek key first: fill it in under Settings",
      noLlmKey: "Your own model has no key yet: fill it in under Think on the Voice page",
      noTtsKey: "Microsoft speech has no key yet: fill it in under Speak on the Voice page",
      unusable: "The voice settings cannot be used: {why}",
      tunnel: {
        timedOut: "cloudflared gave no address within 30 seconds",
        missing: "cloudflared is not installed: brew install cloudflared, or set voice.line.url in the configuration to use your own tunnel",
        exited: "cloudflared exited without giving an address",
      },
      noAgora: "No Agora credentials yet: fill in the App ID and the App Certificate under Settings",
      lineDown: "The voice line cannot open: {why}",
      lineClosed: "The voice line is closed",
      lineNotOpen: "The voice line is not open yet",
      hungUp: "This call has already hung up",
      noToken: "Could not sign a voice token: {why}",
      stopped: "The voice service has stopped",
      grantGone: "This call's voice credentials have expired: connect again",
      connecting: "This call is already connecting",
      lineFailed: "The manager's voice line cannot connect: {why}",
      joinFailed: "Could not bring the manager into the channel: {why}",
      leaveFailed: "Could not have the manager leave: {why}",
      manyCalls: "Several calls are connecting: update the app and try again",
      noCall: "No call is connecting",
      dictation: {
        unset: "Dictation is not set up: fill in your own address and model under Dictation, or switch to MOSS",
        format: "Dictation does not know recordings in {format}",
        empty: "The recording is empty, or not base64",
        tooLong: "The recording is too long: at most 25 MB a piece",
        unreachable: "The dictation address cannot be reached: {why}",
        cut: "The dictation answer broke off halfway: {why}",
        status: "The dictation address answered {status}: {detail}",
        shape: "The dictation address did not answer in OpenAI's transcription format",
        noMossKey: "Dictation goes through MOSS, and no MOSS API key is saved: add it under Dictation",
      },
      moss: {
        noKey: "No MOSS Live API key yet",
        refused: "MOSS Live refused the key: {why}",
        unreachable: "Cannot reach MOSS Live: {why}",
        failed: "MOSS Live did not connect: {why}",
        silent: "MOSS Live did not answer within 8 seconds",
      },
    },
    shared: {
      action: {
        run_command: "running a command",
        read_file: "reading a file",
        edit_file: "editing a file",
        search: "searching",
        web: "on the web",
        mcp: "using an MCP tool",
        wait: "waiting",
        other: "using a tool",
        thinking: "thinking",
        speaking_text: "writing its report",
        none: "",
      },
      outcome: { completed: "done", failed: "failed", interrupted: "stopped halfway" },
      status: { backlog: "Backlog", todo: "To do", in_progress: "In progress", in_review: "For you to see", done: "Done", canceled: "Canceled" },
      priority: { urgent: "Urgent", high: "High", medium: "Normal", low: "Low" },
      deliverable: { change: "A change, merged into the project", branch: "A change, left on its branch", answer: "An answer, reading only" },
      delivered: {
        merged: "merged into main",
        merged_into_parent: "merged into the plan's branch",
        pull_request: "its PR was merged",
        kept: "branch kept, not merged",
        none: "nothing to merge",
      },
      canceled: { dismissed: "canceled", lost: "its working folder is gone" },
      doneWith: "Done, {what}",
      canceledFor: "Canceled, {why}",
      attention: {
        draft: "Draft",
        queued: "Queued",
        working: "Working",
        asking: "Waiting for your answer",
        reviewing: "Waiting for your review",
        stuck: "Stuck",
        done: "Done",
        canceled: "Canceled",
      },
      stuck: { conflict: "conflict", failed: "failed", interrupted: "stopped halfway", quiet: "gone quiet" },
      act: {
        start: "Start",
        answer: "Answer",
        reject: "Send back",
        complete: "Complete",
        acknowledge: "Got it",
        resolve: "Have it resolve the conflict",
        resume: "Carry on",
        cure: "Fix it",
        tell: "Tell it",
        stop: "Stop this round",
        close: "Cancel",
        reopen: "Reopen",
      },
      phase: {
        arriving: "just sent, getting started",
        quiet: "{what} (quiet for {span})",
        done: "this round is done, for you to see{conflict}",
        failed: "this round failed",
        resting: "resting (last round {last}){conflict}",
        unfinished: "unfinished",
        conflict: "; merging into {base} would conflict ({files})",
        working: "{action}",
        workingOn: "{action}: {label}",
        retrying: "{what} (the model call failed, retry {attempt})",
        retryingOf: "{what} (the model call failed, retry {attempt}/{of})",
      },
      order: { invalid: "not a valid order key", unordered: "order key {a} is not before {b}" },
      greeting: "Hey there! What shall we grow today?",
      serverAnswered: "the server answered {status}",
      seconds: "{n} s",
      minutes: "{n} min",
      join: { labeled: "{label}: {text}", aside: "{text} ({aside})", sentence: "{text}.", and: "{a}, {b}", clauses: "{a}; {b}", separator: ", " },
    },
    web: { opening: { waking: "Waking VibeValley…", label: "Waking VibeValley", cannotStart: "VibeValley cannot start: {why}" } },
    "web.agent": {
      newName: "New {runtime}",
      noProfiles: "The server's profiles could not be read: ",
      noRuntimes: "The machines could not be read: {why}",
      loading: "Reading the configuration…",
      noSuch: "There is no such profile.",
      backToAll: "Back to all profiles",
      unnamedAgent: "Unnamed agent",
      unnamed: "Unnamed helper",
      all: "← All profiles",
      isNew: "New",
      unsaved: "Not saved",
      saved: "Saved",
      discard: "Discard changes",
      talk: "Message",
      saving: "Saving…",
      create: "Done, save it",
      save: "Save",
      backToProfile: "← Back to the profile",
      trajectoriesHint:
        "Every helper sent from it, every step since it took the ticket: what it heard, every tool it used (click a row for the input and output), what it said. Steps are kept 30 days after it leaves; the helper itself stays listed.",
      trajectories: "Trajectories",
      remove: "Delete",
      removeWhich: "Delete {name}?",
      fine: "The configuration is fine: it can be sent work.",
      problems: "Why it cannot be sent",
      cannot: "Cannot be sent: ",
      random: "A random one",
      looksAs: "On the farm it is",
      looksHint: "Only looks: the same runtime can be different animals.",
      wears: "Wears",
      tab: { who: "Who", runtime: "Machine", persona: "Persona", skills: "Skills", tools: "Tools", env: "Environment", memory: "Memory" },
      tabs: "Profile",
      name: "Name",
      nameTip: "The manager and the captions call it this, and you can name it when you speak.",
      nameTaken: "An agent of this name already exists",
      duty: "Duty",
      dutyTip: "A sentence. The manager reads it when picking someone.",
      roleHint: "Such as: writes endpoints, changes the server, runs the Go tests",
      tags: "Good for",
      tagsTip: "When your words have these, the manager on Auto sends it first. Enter adds one.",
      tagsHint: "frontend, tests, docs…",
      enabled: "Enabled",
      enabledHint: "Disabled, the manager does not send it, and refuses when it is named.",
      workdir: "Default project",
      workdirTip:
        "A folder under the work folder (VIBEVALLEY_WORK_ROOT). Used when the manager sends work without naming a project; when empty, the project must be named.",
      workdirHint: "such as clock-in",
      worktree: "A git worktree for each helper",
      worktreeHint:
        "Each helper changes its own branch, so helpers do not overwrite each other; completing merges it into the project. Off, it changes the project directly, with no branch to merge.",
      env: "Environment variables",
      envHint: "On top of the runtime's own environment variables.",
      machine: "Machine",
      machineTip: "Changing the machine clears the model and the effort; the looks (animal and outfit) stay.",
      readingMachines: "Reading the machines…",
      available: "available",
      disabled: "disabled",
      checking: "checking…",
      notHere: "not on this machine",
      model: "Model",
      noModels: "This runtime cannot list its models right now.",
      modelLevels: "{name} ({n} effort levels)",
      effort: "Effort",
      effortDefault: "By default the runtime decides.",
      defaultEffort: "Default",
      can: "What {runtime} can do",
      steer: "Takes words while it works (steer)",
      noSteer: "Cannot be interrupted while it works: words queue after the round",
      inProcess: "· Runs inside the server process (Node SDK)",
      ownProcess: "· Runs as its own command-line process",
      refuses: "Refuses ",
      colon: ": ",
      persona: {
        append: { label: "Append to the system prompt", detail: "Keeps the runtime's own way of working and adds the persona after it. Usually this one." },
        replace: { label: "Replace the system prompt", detail: "Replaces the runtime's own system prompt whole. Only when you know what you are doing." },
        prompt: {
          label: "Put at the top of each ticket",
          detail: "Adds the persona before each ticket. Every runtime can do it, but a long conversation dilutes it.",
        },
      },
      personaLabel: "Persona",
      personaTip: "Who it is, how it works, what it does not do. It goes to the runtime the way picked below.",
      personaHint: "You are a careful backend engineer. Understand the code before you change it…",
      personaMode: "How it goes to the runtime",
      library: "Skill library",
      libraryTip: "The skills picked go to the helper with the persona, a section each.",
      manageLibrary: "Manage the skill library →",
      ownSkills: "Skills {runtime} installed itself",
      ownSkillsTip: "Reported by the runtime: already usable on this machine, no need to tick them here.",
      mcp: "MCP servers",
      mcpHint: "Given to the runtime when a session opens (oar's SessionOptions.mcpServers).",
      removeNamed: "Delete {name}",
      mcpKind: "MCP kind",
      mcpName: "MCP name",
      mcpTarget: "MCP command or address",
      add: "Add",
      disallowed: "Disallowed tools",
      disallowedHint: "This agent cannot use these tools. Click a tool the runtime reports below to add it.",
      disallowedExample: "such as WebSearch",
      ownMcp: "MCP servers {runtime} connects itself",
      ownMcpTip: "Reported by the runtime, together with those added above.",
      unreported: "This runtime does not report this.",
      none: "None.",
      role: { orchestrator: "Manager", helper: "Helper" },
      templates: {
        title: "Templates",
        intro:
          "Each template is a recipe for an agent: its role, duty, persona, the machine it is written for and its look. Installing one adds a profile, and one template can be installed many times; change what is installed as you like, and when the template has a new version the profile says so.",
        open: "Install from a template",
        openLine: "Recipes for managers and helpers, to pick from",
        folder: "Template folder",
        folderHint: "The path of a template folder on this machine (with agent.json in it)",
        add: "Add it",
        added: 'The template "{name}" is added, not installed yet',
        onServer: "Runs on VibeValley's own agent",
        runsOn: "Written for {runtime}, which this machine has",
        notHere: "Written for {runtime}, which this machine lacks: once installed, pick another machine in the profile",
        noPersona: "No persona.",
        installed: "{n} installed",
        addedHere: " · added on this machine",
        look: "Look",
        fold: "Fold",
        removeSure: "Really delete the template",
        install: "Install",
        none: "No helpers yet: install some from a template, or make one yourself.",
        from: 'From the template "{name}", version {version}',
        update: "Update to the template's version {version}",
        updateHint: "The template's new version replaces the duty, tags, persona and how it is given; the name, look, machine, model and environment stay.",
        updated: "Updated from the template",
      },
      orchestrator: {
        newName: "New manager",
        intro:
          "A manager stays, leads and does no work itself: it hears what you want done, sends helpers to do it, watches progress and passes on results. It runs on VibeValley's own agent, with its own direct messages, memory and trajectory; hand it a channel to look after, and what you say there it answers.",
        page: "Its memory and trajectory →",
        nameTip: "Its name in the chat; others call it with @ and its profile id.",
        model: "Model",
        modelTip: "A DeepSeek model; empty is the default one.",
        modelHint: "deepseek-v4-flash",
        dutyTip: "One sentence: what it looks after.",
        personaTip: "Who it is, how it talks, what it looks after; it follows the manager's prompt.",
        personaHint: "You look after the clock-in project; read the tests before sending work…",
        look: "Look",
      },
      list: {
        title: "Profiles",
        intro:
          "Each profile is an agent. Managers stay, lead and do no work themselves, and there may be several; helpers are runtimes set up: which runtime and model, what persona and skills, and which little animal they are on the farm. When a manager sends work, it sends a helper.",
        orchestrators: "Managers",
        helpers: "Helpers",
        make: "Make a new helper",
        makeOrchestrator: "Add a manager",
        orchestratorLine: "Not a helper: sends work, watches progress, passes on results.",
        ledger: "Ledger",
        voice: "Voice",
        disable: "Disable",
        enable: "Enable",
        toggle: "{act} {name}",
        here: "{n} here",
        tallyHint: "How many times helpers sent from this profile got work merged into main",
        hired: "Hired",
        merged: "Merged",
      },
      runtimeDefault: "The runtime's default",
      runtimeDefaultModel: "The runtime's default ({model})",
      noEffort: "This model has no effort levels.",
      noEffortModel: "{model} has no effort levels.",
    },
    "web.artifact": {
      place: { label: "Artifacts", hint: "What you, the helpers and the manager leave to be read: pages written together and web pages handed in" },
      card: { version: "Version {version}", open: 'Open "{title}"' },
      page: {
        by: "Made by {name}",
        updated: "Updated {when}",
        versions: "Versions",
        open: "Open in a new tab",
        delete: "Delete",
        deleteAsk: "Delete “{title}”? Its cards stay in the conversation.",
        deleted: 'Deleted "{title}"',
        gone: "This artifact was deleted, or there is no such artifact.",
        frame: '"{title}" version {version}',
        list: "All artifacts",
        new: "New",
        none: "No artifacts yet: give one a title to start it, or have a helper hand one in.",
        all: "All artifacts",
        forIssue: "For #{number}",
        untitled: "Untitled",
        find: "Find by title",
        nothingFound: "No title matches",
        title: "Title",
        more: "More",
        copyLink: "Copy link",
        copied: "Link copied",
      },
      talk: {
        atMessage: "In the conversation",
        reply: "Reply",
        replyHint: "For the helper who made it: what to change",
        send: "Reply",
        sent: "Replied",
        replyVersion: "Reply to this version",
        sentVersion: "Replied to version {version}",
      },
      issue: { title: "Artifacts" },
      blocks: {
        memoryItem: "Memory",
        saving: "Saving…",
        saved: "All saved",
        blocks: "{n, plural, one {# block} other {# blocks}}",
        helpersWriting: "helpers writing",
        demo: "Demo: several helpers writing at once",
        append: "Write a paragraph at the end",
        owner: "Owner",
        done: "Done",
        notDone: "Not done",
        writing: "{who} is writing",
        wrote: "{who} wrote it",
        issue: "Ticket {id}",
        unknown: 'This block is a "{type}", which this version cannot draw yet: it can be read, not changed',
        block: "Block {id}",
        heading: "Heading",
        notSaved: "Not saved: {why}",
        changed: "Someone else just changed this block",
        conflict: "{why}: what you wrote was not saved and stays in the revision",
        image: "Image: {alt} {src}",
        start: "Start writing here…",
      },
      body: { blocks: "Written together", html: "Web page" },
    },
    "web.base": {
      place: {
        chat: { label: "Chat", hint: "Channels and threads" },
        issues: { label: "Tickets", hint: "Every ticket from written to closed" },
        agents: { label: "Profiles", hint: "Profiles: managers and helpers" },
        runtimes: { label: "Machines", hint: "The coding agents on this computer" },
        projects: { label: "Projects", hint: "An island for each project" },
        catalog: { label: "Catalog", hint: "Assets: every picture, cursor and sound the farm uses, and the workbench's kit" },
        settings: { label: "Settings", hint: "General, appearance, models, memory, skills, voice, connections" },
      },
      link: { connecting: "Connecting", open: "Connected", lost: "Lost, reconnecting" },
      rail: "Workbench",
      farm: "Back to the farm",
      working: "Open · {n} working",
      off: "Not open",
      chips: {
        drop: "Remove {v}",
        valueOf: "{k}'s value",
        removeKey: "Delete {k}",
        remove: "Delete",
        name: "Variable name",
        value: "Variable value",
        valueHint: "Value",
        add: "Add",
      },
      toasts: "Notices",
      runtime: "Runs on: {name}",
      owner: "Me",
      orchestrator: "Manager",
      unreachable: "The server cannot be reached for now: try again when it is back.",
      form: {
        asking: "Asking the server…",
        unreachable: "The server cannot be asked: {why}",
        none: "None yet",
        unset: "Not set",
        removeOnSave: "Removed when saved",
        removeKey: "Remove {label}",
        keepKey: "Keep {label}",
        undo: "Undo",
        storedIn: "Saved in {file}",
        keepEmpty: "Leave empty to keep",
        save: "Save",
        reset: "Reset",
        never: "Never mind",
        remove: "Delete",
        from: { settings: "saved in the settings", config: "from the configuration (vibevalley.yaml or the environment)" },
        inUse: "Using {hint} ({from})",
        fromOnly: "In use ({from})",
        example: "e.g. {value}",
      },
      time: {
        justNow: "just now",
        secondsAgo: "{s}s ago",
        minutesAgo: "{m} min ago",
        hoursAgo: "{h, plural, one {an hour ago} other {# hours ago}}",
        daysAgo: "{d, plural, one {a day ago} other {# days ago}}",
        monthsAgo: "{m, plural, one {a month ago} other {# months ago}}",
        yearsAgo: "{y} years ago",
        seconds: "{s}s",
        minutes: "{m} min {s}s",
        hours: "{h} h {m} min",
        round: {
          underMinute: "under a minute",
          minutes: "{m} min",
          hours: "{h, plural, one {an hour} other {# hours}}",
          days: "{d, plural, one {a day} other {# days}}",
        },
        tenths: "{s}s",
        today: "Today",
        yesterday: "Yesterday",
        clock: "{am, select, true {{hh}:{mm} AM} other {{hh}:{mm} PM}}",
        weekdays: { "0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed", "4": "Thu", "5": "Fri", "6": "Sat" },
        monthDay: "{month, select, 1 {Jan} 2 {Feb} 3 {Mar} 4 {Apr} 5 {May} 6 {Jun} 7 {Jul} 8 {Aug} 9 {Sep} 10 {Oct} 11 {Nov} other {Dec}} {day}",
        month: "{month, select, 1 {Jan} 2 {Feb} 3 {Mar} 4 {Apr} 5 {May} 6 {Jun} 7 {Jul} 8 {Aug} 9 {Sep} 10 {Oct} 11 {Nov} other {Dec}}",
        date: "{m, select, 1 {Jan} 2 {Feb} 3 {Mar} 4 {Apr} 5 {May} 6 {Jun} 7 {Jul} 8 {Aug} 9 {Sep} 10 {Oct} 11 {Nov} other {Dec}} {d}, {y}",
        day: "{weekday}, {m, select, 1 {Jan} 2 {Feb} 3 {Mar} 4 {Apr} 5 {May} 6 {Jun} 7 {Jul} 8 {Aug} 9 {Sep} 10 {Oct} 11 {Nov} other {Dec}} {d}",
      },
      money: { underCent: "under ¥0.01", about: "about {yuan}", spent: "spent {yuan}" },
      cast: {
        species: { bear: "Bear", rabbit: "Rabbit", fox: "Fox", cat: "Cat", owl: "Owl", hedgehog: "Hedgehog", raccoon: "Raccoon" },
        outfit: { farmer: "Farmer", gardener: "Gardener", rain: "Raincoat", winter: "Winter coat" },
        pose: { idle: "Standing by", walk: "Walking over", think: "Pondering", work: "Working", cheer: "Done", worry: "Bugs!" },
      },
      reading: "Reading…",
      write: "Remember it",
      secret: { hide: "Hide", peek: "Peek" },
      big: "{n}k",
      file: { pdf: "PDF · opens in a new tab", remove: "Remove {name}" },
      lightbox: { label: "Pictures", prev: "Previous", next: "Next", original: "Open the original", close: "Close" },
      shortcuts: {
        title: "Keyboard shortcuts",
        place: {
          everywhere: "Everywhere",
          composer: "Message box",
          lists: "Menus and lists",
          pictures: "Pictures",
          farm: "Farm",
          desktop: "Desktop app (system-wide)",
        },
        say: {
          switcher: "Jump to a channel, thread or direct message",
          sheet: "Open this sheet",
          close: "Close a dialog, menu or popover",
          send: "Send",
          newline: "New line",
          mention: "Call someone",
          editLast: "Edit your last message (box empty)",
          dropReply: "Stop replying to that message",
          move: "Move up and down",
          pick: "Pick",
          flip: "Previous, next",
          tool: "Hold the nth tool",
          names: "Hold to name everything in the yard",
          farmMenu: "Put the tool down, or open the menu",
          debug: "Debug console",
          voice: "Talk to the manager (changeable in settings)",
          command: "Commands: a ticket, remember, stop, a direct message",
        },
      },
      rich: {
        copy: "Copy",
        copied: "Copied",
        more: "Show all",
        less: "Show less",
        lines: "{n} lines",
        diagram: "Diagram",
        diagramFailed: "This diagram cannot be drawn: {why}",
        longMore: "Show all",
        longLess: "Show less",
        taskDone: "Done",
        taskOpen: "Not done",
      },
      updateReady: "{next} is ready: restart from About",
      intent: { timedOut: "No answer in time; try again", offline: "Not connected to the farm, so this was not sent" },
    },
    "web.catalog": {
      ground: { check: "Checks", grass: "Grass", night: "Night" },
      tab: { sprites: "Pictures", cursors: "Cursors", sounds: "Sounds" },
      shelves: "The catalog's shelves",
      find: "Find a picture",
      background: "Background",
      categories: "Categories",
      all: "All",
      count: "{n} pictures, cut from design/pixel/raw.",
      pick: "Click one for a big view: its size, anchor, animation frames, and which source sheet it was cut from and how to redraw it.",
      findHint: "Find: name, kind, animal, outfit (bear, raincoat, lang-, icon-…)",
      noMatch: "Nothing matches.",
      moves: "anim",
      copied: "Copied",
      copy: "Copy",
      anchor: "Anchor",
      head: "Head",
      zoom: "Zoom",
      marks: "Anchor and head",
      stop: "Stop",
      play: "Play",
      frames: "{n} frames",
      fps: "Frames per second",
      perSecond: "{n} fps",
      size: "Size",
      pixels: "{w} × {h} px",
      from: "From",
      unrecorded: "Not recorded (an old picture no longer used)",
      redraw: "Redraw",
      recut: "Cut again",
      cursorsIntro: "The mouse on the farm: normally, over something clickable, and holding a tool.",
      cursorsFind: "Find: a cursor's name (glove, water, harvest…)",
      cursors: "Cursors · {n}",
      cursorsNote:
        "The red dot is where a click lands. Normally a glove, a pointing finger over something clickable; holding a tool, that tool, sparkling where it can be used and with a no-entry mark where it cannot. Cut from design/pixel/raw/ui-cursors.png (design/pixel/process.py ui-cursors).",
      noCursors: "This build has no cursor pictures (assets/cursors).",
      soundsIntro: "Every sound on the farm: click one to hear it.",
      soundsFind: "Find: a sound's name or group (water, yard, coin…)",
      soundsRecipes: "The sounds are synthesized on the fly, with no audio files: the recipes are in",
      soundsMusic: ". With sound off they are silent. There is no background music yet; the prompts for Suno are in",
      period: ".",
      playSound: "Play {name}",
      shelf: {
        helpers: { label: "Helpers", hint: "Seven animals, four outfits: stand, walk, work, cheer, worry; sit, read, type and fix by the buildings" },
        orchestrator: { hint: "Six looks, each with talking, listening and a portrait" },
        dog: { label: "Dog", hint: "Sleep, wake, stretch, wag, bark, jump, roll over…" },
        plots: { label: "Plots", hint: "From bare soil to ripe, weedy, dry, withered and locked" },
        yard: { label: "Yard", hint: "The map, props, plants in front of the camera, little animals" },
        map: { label: "Map", hint: "An island for each project, the compass, clouds, queued seed bags, stumps for free spots" },
        machines: { label: "Machines", hint: "Each is a runtime" },
        icons: { label: "Icons", hint: "For panels, entries and hints" },
        acts: { label: "Doing", hint: "The little icons over a helper's head: read, edit, run a command, search…" },
        medals: { label: "Medals and badges", hint: "Medals, badge emblems, stamps, coins" },
        logos: { hint: "The agents on the machines, the chat apps, the web and desktop icons" },
        langs: { label: "Languages", hint: "What a project page has planted" },
        ui: { label: "Interface", hint: "The energy bottle, the farm chat's buttons, the calendar's cells" },
        other: { label: "Other", hint: "What fits no shelf" },
      },
    },
    "web.channel": {
      tab: { chat: "Chat", issues: "Tickets", crons: "Scheduled tasks" },
      defaultProject: "default project {project}",
      channels: "Channels",
      defaultHint: "The default channel: you, the manager and the helpers are all here",
      findHint: "Find in this channel…",
      find: "Find in this channel",
      findMessages: "Find messages",
      settings: "Channel settings",
      inChannel: "In the channel",
      empty: "Nobody has spoken in {label}: tell the manager something to do.",
      sendTo: "Message {label}",
      side: "Channels and helpers",
      channelsTitle: "Channels",
      directsTitle: "Direct messages",
      newChannel: "Create a channel",
      helpers: "Helpers",
      noHelpers: "No helpers here",
      mood: { idle: "resting", listening: "listening", thinking: "thinking", speaking: "speaking" },
      orchestrator: "Manager",
      nobodyOnIt: "No helper is on it now; the thread stays",
      replies: "{n, plural, one {# reply} other {# replies}}",
      thread: "Thread",
      closeThread: "Close the thread",
      threadEmpty: "Nobody has spoken in this thread yet. Its helper sees what is said here.",
      sayInThread: "Say it in the thread; {name} sees it",
      reply: "Reply in this thread",
      dialog: {
        projectExample: "such as clock-in",
        cancel: "Cancel",
        name: "Name",
        nameHint: "Letters, digits, Chinese characters, - and _, up to 24",
        nameExample: "such as clock-in",
        description: "Description (optional)",
        descriptionHint: "What is this channel for?",
        project: "Default project (optional)",
        projectHint: "Work sent in this channel without a project goes to this one",
        projectNone: "Empty means none: the manager asks which project when sending work",
        settingsOf: "Settings of # {name}",
        save: "Save",
      },
      issues: {
        empty: "No tickets in this channel yet. Tell the manager something to do in the chat; it sends a helper, and the ticket is listed here.",
        thread: "Ticket thread",
      },
      crons: {
        empty: 'No scheduled tasks: tell the manager "run the tests every day at nine".',
        next: "next {next}",
        direct: "straight to {agent}",
        byOrchestrator: "set by the manager",
        label: 'Scheduled task "{name}"',
        on: "On",
        off: "Off",
        remove: "Delete",
        removeWhich: 'Delete the scheduled task "{name}"',
        sure: "Delete it?",
        approveWhich: 'Approve the scheduled task "{name}"',
        approve: "Approve",
        refuseWhich: 'Refuse the scheduled task "{name}"',
        refuse: "Refuse",
      },
      messages: {
        label: "Messages",
        containing: 'Messages with "{text}"',
        start: "The start of the messages",
        older: "Older messages",
        notFound: "Nothing found",
        thinking: "thinking…",
        typing: "typing…",
        foldDispatch: "Fold the dispatch",
        unfoldDispatch: "Unfold the dispatch",
        owner: "Owner",
        dispatch: "Sent work",
        spent: "This round spent {spent}",
        unread: "{n} new",
        edited: "(edited)",
        deleted: "This message was deleted",
        replyGone: "The original message was deleted",
        pinned: "Pinned",
        newMessages: "New messages",
        searching: "Searching…",
        inThread: "in {address}",
        file: "File · {size}",
        reactedBy: "{names} reacted with {emoji}",
        linked: "Go to message {number} in {where}",
        newBelow: "{n} new below",
        toLatest: "Back to the newest",
        roundFor: "{what} · {took}",
        sentTo: "Sent {who} on",
        sending: "Sending…",
        notSent: "Not sent",
        retrySend: "Send again",
        dropSend: "Drop it",
      },
      tools: {
        label: "What this message offers",
        react: "React",
        reply: "Reply",
        thread: "Open a thread",
        pin: "Pin",
        unpin: "Unpin",
        edit: "Edit",
        remove: "Delete",
        sure: "Press again to delete",
        pick: "Pick a reaction",
        editHint: "Enter saves · Esc cancels",
      },
      pins: { open: "Pinned messages", title: "Pinned", none: "Nothing is pinned here yet" },
      members: { open: "Members", title: "Members", owner: "Owner", none: "No helpers here yet", looksAfter: "The manager looking after this" },
      composer: {
        notSent: "Not sent: {why}",
        who: "Who",
        mention: "@ to call someone",
        stop: "Stop the manager",
        stopHint: "Stops the manager's round; helpers already sent keep working",
        send: "Send",
        sendHint: "Enter sends · Shift+Enter for a new line",
        replying: "Replying to {name}",
        cancelReply: "Cancel the reply",
        attach: "Attach a file",
        uploadFailed: "Not uploaded: {why}",
      },
      manage: {
        name: "Name",
        category: "Group (optional)",
        categoryHint: "The sidebar lists channels by group",
        orchestrator: "Looked after by",
        orchestratorHint: "When you speak here without @ anyone, this manager answers",
        notify: "Notify",
        notifyAll: "All",
        notifyMentions: "Only @owner",
        notifyNone: "Nothing",
        notifyHint: "Nothing means no unread count, no Inbox and nothing forwarded to WeChat",
        archive: "Archive",
        unarchive: "Unarchive",
        archiveHint: "An archived channel leaves the sidebar; its messages and address stay",
        remove: "Delete channel",
        removeSure: "Delete it",
        removeWill: "Deleting it:",
        archivedTitle: "Archived",
        muted: "Muted",
        mentionsOnly: "Only @",
        drag: "Drop on another channel to place it before that one",
      },
      threadList: {
        title: "This channel's threads",
        none: "No threads in this channel yet",
        archived: "Archived threads ({n})",
        rename: 'Rename "{title}"',
        archive: 'Archive "{title}"',
        unarchive: 'Unarchive "{title}"',
        notify: "Thread notifications",
      },
      more: { label: "More", copyLink: "Copy link", copied: "Link copied", markUnread: "Mark unread from here", jump: "Jump to it" },
      switcher: {
        open: "Jump to…",
        title: "Jump to a channel, thread or direct message",
        hint: "Type a name; # finds channels and threads, @ direct messages",
        none: "Nothing found",
        direct: "Direct message",
        newDirect: "New direct message",
        keys: "{mac, select, true {⌘K} other {Ctrl K}}",
      },
      farmSearch: {
        open: "Search everything",
        title: "Search everything",
        hint: "Find messages…",
        filters: "from:owner  in:#channel  has:file / image / link  before: / after:2026-10-01",
        none: "Nothing found",
        searching: "Searching…",
      },
      direct: { add: "New direct message", pick: "Talk with", none: "No profiles yet", open: "Talk with {name}" },
      emoji: {
        open: "Emoji",
        groups: { frequent: "Frequent", faces: "Faces", hands: "Hands", things: "Things", nature: "Nature", signs: "Signs" },
        more: "More emoji",
      },
      media: {
        pdf: "PDF · opens in a new tab",
        drop: "Drop to upload here",
        uploadingFile: "{name} {percent}%",
        keep: "Keep {name}",
        takeOff: "Take off {name}",
        preview: "Link preview",
      },
      names: {
        issueThread: "Ticket thread",
        planThread: "Plan {id}",
        talkThread: "{who}'s thread",
        thread: "Thread",
        mention: { orchestrator: "@manager", owner: "@owner", everyone: "@everyone" },
        orchestratorNote: "sends work, splits plans, answers how it goes",
        everyone: "Everyone",
        everyoneNote: "wakes every helper here",
      },
      threadWidth: "Thread width (drag; double-click for the default)",
      commands: {
        issue: { name: "Write a ticket", note: "/issue title: into the backlog, in this channel's project", needs: "Write the ticket's title after /issue" },
        remember: {
          name: "Have the manager remember",
          note: "/remember a sentence: into the memory of the manager looking after this",
          needs: "Write what it should remember after /remember",
        },
        stop: { name: "Stop the manager", note: "The manager looking after this stops its round; helpers it sent keep working", needs: "" },
        dm: { name: "Direct message", note: "/dm name: open the direct channel with that profile", needs: "Write the profile's name or id after /dm" },
        done: { issue: "Written down as #{n}", remember: "Remembered", stop: "Stopped" },
      },
    },
    "web.connector": {
      connectors: {
        section: { label: "Connectors" },
        label: { weixin: "WeChat", feishu: "Feishu" },
        how: { weixin: "Scan to sign in, message the bot", feishu: "Scan to make a bot", qq: "Fill in the QQ bot's AppID" },
        notes: {
          weixin: {
            "0": "Only the WeChat that scanned counts: what others send this bot does not come in.",
            "1": "When a helper finishes, its report goes to WeChat at once, without waiting for you to speak first. When WeChat sometimes refuses, reports wait and are retried later (further apart each time, at most half an hour), and also come with your next message (several joined in one).",
            "2": "It uses Tencent's official interface for bots (the same as OpenClaw's WeChat plugin).",
          },
          feishu: {
            "0": "After the scan, Feishu makes a bot app that is yours alone; nothing to set up by hand on the open platform.",
            "1": "Then find the bot in Feishu and send it the pairing code in a direct message: whoever sends the code is the owner, and only the owner's words come in. Direct messages only, not groups.",
            "2": "A Feishu bot can message you any time, so reports do not wait for you to speak first.",
          },
          qq: {
            "0": "QQ cannot make a bot by scanning: make one on the QQ open platform (q.qq.com) first, turn on direct messages, and fill in its AppID and AppSecret here.",
            "1": "Add the bot with your own QQ and send it the pairing code in a direct message: whoever sends the code is the owner. Direct messages only.",
            "2": "QQ lets a bot reply only for a short while after you speak. Reports after that wait, are retried later, and come with your next message.",
          },
        },
        always:
          "Helpers can run commands on this computer, so only the owner counts; reply quoting a report and your words go to that ticket's thread. VibeValley only connects out and opens no port.",
        state: {
          off: "Not connected",
          waiting: "Waiting for your scan",
          scanned: "Scanned, waiting for the phone to confirm",
          verify: "Enter the digits on the phone",
          pairing: "Waiting for your pairing code",
          connected: "Connected",
          paused: "Paused",
        },
        list: "Connectors",
        intro: "Talk to the manager in a chat app: send work, ask how it goes, get reports.",
        know: "Good to know",
        disconnect: "Disconnect",
        weixinIntro:
          "Scan a code with WeChat on your phone and talk to the manager in WeChat: send work, ask how it goes; helpers' reports and questions come to WeChat too.",
        feishuIntro: "Scan a code with Feishu on your phone and Feishu makes a bot for you; talking to it in Feishu is talking to the manager.",
        scan: "Sign in to {app} by scanning",
        pairing: "The bot is connected. Last step: with your own {app}, message this bot directly and send:",
        pairingNote: "Whoever sends this code is the owner: from then on only that person's words come in. The code works once.",
        owner: "Owner",
        channel: "Connected to",
        since: "Connected since",
        lastInbound: "Last heard from you",
        pending: "Waiting to be sent to you",
        pendingCount: "{n}: sent with your next message",
        noPending: "None",
        paused: "The sign-in expired: retrying after {clock}; or disconnect and connect again.",
        whichChannel: "Which channel it connects to",
        qqBefore: "Make a bot on",
        qqPlatform: "the QQ open platform",
        qqAfter: ", turn on direct messages, and fill in its AppID and AppSecret here.",
        secretHint: "Kept only in this computer's database, and never shown again.",
        secret: "The bot's secret",
        connectQq: "Connect the QQ bot",
        scanWith: "Scan this code with {app} on your phone.",
        scanned: "Scanned: confirm on the phone.",
        digits: "Enter the digits shown on the phone:",
        gettingQr: "Getting the QR code…",
        qr: "{app} sign-in QR code",
        phoneDigits: "Digits on the phone",
        ok: "OK",
        cannotScan: "Cannot scan? Open this link on the phone: ",
        newCode: "Another code",
      },
    },
    "web.farm": {
      reading: "Reading…",
      unread: "Cannot be read.",
      never: "Never mind",
      notNow: "Not yet",
      orchestrator: "Manager",
      plotOf: "{name}'s plot",
      plot: {
        unread: "This plot's ticket has not been read yet.",
        failed: "Did not work",
        now: "Where it is",
        yours: "For you to do",
        answerTo: "Answer: {question}",
        rejectWhere: "What did not pass, one per line",
        sayIt: "Say it yourself…",
        reopenWhat: "What to do this time (empty to finish what was left)",
        tellWorking: "It hears this even while it works",
        tellIdle: "Say something and it works another round",
        rejectLabel: "What did not pass",
        answer: "Answer",
        reopen: "Reopen this ticket",
        tell: "Tell {who}",
        onBoard: "See it on the board",
        progress: "How far it got",
        progressMet: "How far it got · {met} / {of} met",
        noCriteria:
          "{answer, select, true {This ticket has no criteria for done: judge by its answer when it comes back.} other {This ticket has no criteria for done: judge by its changes when it comes back.}}",
        rejected: "Sent back · {text}",
        conclusion: "Answer",
        evidence: "Evidence · {line}",
        next: "Next · {line}",
        made: "What it made",
        madeNothing: "What it made: no changes yet",
        madeFiles: "What it made ({n} files)",
        changesUnread: "The changes cannot be read.",
        moreFiles: "{n} more files",
        story: "How it got here",
        steps: "The helper's every step",
        runs: "Every round of work",
        details: "Details",
        job: "To do",
        who: "Who",
        crew: "On the plot",
        review: "Acceptance",
        deliver: "Delivers",
        reviewed: "Accepted {clock}",
        weeded: "Weeds pulled",
        weed: "Pulled · {text}",
        model: "Model",
        branch: "Branch",
        copyPath: "Copy the path",
        opened: "Opened",
        closed: "Closed",
        history: "Worked by",
        took: "Took",
        thread: "See the ticket thread",
        graph: "See the plan",
        where: "Plot {plot} · round {round}",
        result: { met: "It says this is met", unmet: "It says this is not met", unsure: "It is not sure" },
        ticked: "Checked",
        noRuns: "No work yet.",
        runCount: "{n, plural, one {# round} other {# rounds}}",
        conflict: "Merging into {base} would conflict: {files}",
      },
      graph: {
        name: "Planting plans",
        new: "New plan",
        intro:
          "A long job: first a helper reads the code and splits it into steps, each for a helper, in order. You look over and edit the split before starting; each step merges into the plan's own branch when done, and when all are done you bring the whole into main at once.",
        goal: "What to do",
        goalExample: "Such as: add monthly check-in lookups to clock-in, with a page and tests",
        project: "Which project",
        splitter: "Who splits it",
        byRule: "Picked by the rules",
        split: "Split it",
        steps: "{done}/{of} steps",
        spent: "spent {spent}",
        projectTag: "Project {project}",
        running: "Each step merges into this branch when done; the harvest merges the whole branch into main",
        addStep: "Add a step",
        review: "See the changes, {merge}…",
        abandon: "{abandon} this plan",
        abandonSure: "Abandon it? The branch stays",
        splitting: "A helper is reading the code and splitting the plan. The split appears here for you to look over before starting.",
        no: "No",
        readingChanges: "Looking at what the plan's branch changed…",
        unreadable: "The changes cannot be read: ",
        summary: "{branch} → {project}'s {base}: {commits} commits, {files} files, ",
        behind: "; meanwhile {base} got {n} more commits",
        commits: "Commits",
        files: "Files",
        harvest: "Harvest, merge into {base}",
        noSteps: "The plan has no tasks yet.",
        first: "First",
        batch: "Batch {n}",
        acceptanceHint: "Acceptance: must fail when written; the last step makes it pass",
        checkHint: "Runs {check} when done",
        edit: "Edit",
        remove: "Delete",
        story: "History",
        stepId: "Task id",
        stepIdHint: "Task id, such as docs",
        title: "Title",
        brief: "Ticket",
        briefHint: "Ticket: the goal, where to change, what counts as done",
        whoHint: "Who does it: picked by the rules",
        who: "Who does it",
        check: "Check command",
        checkExample: "The check run when done, such as pnpm test (optional)",
        waitFor: "Wait for these first:",
        done: "Save",
        add: "Add",
        storyOf: 'History of "{title}"',
        wholeStory: "See the whole plan's history",
        nothing: "Nothing recorded yet.",
        readingStory: "Reading…",
        beforeAfter: "Before and after",
        empty: "(empty)",
        conflict: "Merging into {base} would conflict: {files}. Not bringing it in until the changes on {base} are sorted out.",
        frozen: "Acceptance, frozen: {files}",
        waits: "Waiting for {titles}",
        after: "After {titles}",
        onPlot: "{name} · plot {plot}",
        onPlotDoing: "{name} · plot {plot} · {doing}",
      },
      achievements: {
        tier: { "1": "Bronze", "2": "Silver", "3": "Gold" },
        category: { starter: "Starter tasks", harvest: "Harvest", craft: "Craft", thrift: "Thrift", team: "Teamwork", secret: "Secrets" },
        clearing: "Clearing",
        clearAt: "Lv.{level} clears a plot",
        toLevel: "{left} more commits to level up · {total} in all",
        toNext: "Commits to the next level",
        streak: "Streak {n} · harvest coins ×{multiplier}",
        coinsOnMerge: "Coins only for what is merged into main",
        title: "Title",
        pick: "Pick one",
        earnFirst: "Earn an achievement to get one",
        titles: "Title on the farm card",
        worn: "Worn",
        none: "No title",
        starterDone: "All starter tasks done.",
        starter: "Starter tasks {done}/{of}",
        perStarter: "+{coins} coins each",
        done: "Done",
        tiers: "tier {tier}/{of}",
        toTier: "To {tier}",
        secrets: "{n} secrets left",
        secretsLine: "You find out what they are when you come across them.",
        day: "{month, select, 1 {Jan} 2 {Feb} 3 {Mar} 4 {Apr} 5 {May} 6 {Jun} 7 {Jul} 8 {Aug} 9 {Sep} 10 {Oct} 11 {Nov} other {Dec}} {day}",
        earned: "earned {day}",
        earnedTier: "{tier} earned {day}",
      },
      sow: {
        notDrafted: "Not drafted",
        homeless: "This farm belongs to no project",
        toMap: "To plant, enter a project's farm first: go back to the map and pick an island.",
        noProjects: "No projects in the workbench yet: make one on the Projects page first.",
        map: "Go to the map",
        makeProject: "Make a project",
        plantIn: "Planting in {project}",
        rummaging: "Rummaging in the seed bags…",
        noSeeds: "The seed bags could not be fetched: ",
        retry: "Fetch the seed bags again",
        recent: "Recent",
        kinds: "Common jobs",
        own: "Write your own",
        jobHint: "What to do, and what counts as done",
        job: "Ticket",
        who: "Who plants it",
        orchestratorPicks: "Manager picks",
        how: "Start: the manager hands this to a helper, who starts in {project} at once. Draft: a helper reads the code and writes it up as a ticket for you to look over before starting.",
        draft: "Draft",
        start: "Start",
      },
      water: {
        drops: { "0": "Keep the change small", "1": "Leave the tests alone for now", "2": "Tell me when done", "3": "Add a test while at it" },
        working: "It is working: it hears this before its next step.",
        idle: "It is not working: this has it work another round.",
        thread: "This is kept in its ticket thread, with its replies.",
        job: "Its job now: {brief}",
        hint: "A word to pass on…",
        water: "Water",
        moved: "The ticket's status changed: go back to the plot and see what it asks of you.",
      },
      harvest: {
        reading: "Looking at what it changed…",
        project: "Project {project}",
        counts: "{commits} commits · {files} files",
        none: "This one has no changes. Harvesting just lets it go.",
        conflict: "Merging into {base} would conflict, so it cannot be harvested yet",
        resolveHow: "Have it merge {base} into its own branch, resolve the conflicts, run the tests and commit; then harvest it.",
        behind: "While it worked, {base} got {n} more commits; harvesting joins them (with one merge commit).",
        uncommitted: "{n} files are not committed yet; harvesting commits them first:",
        letGo: "Let it go",
        take: "Harvest, merge into {base}",
        resolve: "Have it resolve the conflict",
        files: "Changed files",
        empty: "The warehouse is empty. Work harvested into main is kept here.",
        graph: "Planting plan",
        taken: "harvested {ago}",
      },
      panel: {
        shop: "Shop",
        warehouse: "Warehouse",
        graphs: "Tasks and achievements",
        log: "Farm log",
        orchestrator: "Manager and pets",
        taskBoard: "Planting plans",
        harvest: "Harvest {name}'s plot",
        sow: "Sow · plot {plot}",
        water: "Water {name}",
        menu: "Menu",
        pickLook: "Pick a manager you like; the farm and the chat change at once.",
        drawing: "Still being drawn…",
        pets: "Pets",
        shopItems: {
          scarecrow: { name: "Scarecrow", note: "Scares off crows, looks nice" },
          seeds: { name: "Seed pack", note: "Common ticket templates" },
          bunting: { name: "Bunting", note: "Hangs on the fence" },
          doghouse: { name: "Doghouse", note: "For the manager's dog" },
        },
        shopClosed: "The shop is being done up and opens in the next version. You have {coins} coins: save them for now.",
      },
      menu: {
        chat: "Farm chat (channels)",
        agents: "Helper roster",
        runtimes: "Machines",
        skills: "Skill book",
        connectors: "Connectors",
        projects: "Projects",
        catalog: "Catalog",
        resume: "Resume",
        home: "Back to the title",
        soundOn: "Sound on",
        soundOff: "Sound off",
        elsewhere: "Go elsewhere",
        issues: "Tickets",
        yard: "What you can click in the yard",
      },
      log: {
        empty: "Nothing yet. Once you open, what you and the manager say and who finished what are kept here.",
        you: "You",
        said: "said",
        answered: "answered",
        spent: "This round spent {spent}",
      },
      conflictTag: "Conflict",
      binary: "binary",
      chat: {
        actions: {
          open: "What this message can do",
          react: "React",
          moreEmoji: "More emoji",
          reply: "Reply",
          copyLink: "Copy link",
          copied: "Link copied",
          edit: "Edit",
          remove: "Delete",
          sure: "Click again to delete",
          editHint: "Enter saves · Esc keeps it",
          cancelReply: "Don't reply",
        },
        edited: "(edited)",
        deleted: "This message was deleted",
        suggestions: {
          "0": "Have the writer make the captions panel",
          "1": "Have the tester run the tests",
          "2": "How is it going?",
          "3": "Everyone, call it a day",
        },
        greeting:
          'This is the farm chat, where you, the manager and the helpers talk. Tell me something to do, such as "have the tester run the tests".\n\nOnce helpers arrive, write a name like @w1 to call one directly; each ticket has its own thread under it.',
        phase: {
          off: "Type or press the mic to open",
          connecting: "Reaching the manager…",
          listening: "The manager is listening",
          thinking: "The manager is thinking…",
          speaking: "The manager is speaking",
          error: "Not connected: try again",
        },
        newIn: "new words in {n} places",
        newInThread: "New words in a thread",
        newInChannel: "New words in {channel}",
        label: "Farm chat",
        restore: "Restore the chat window",
        enlarge: "Enlarge the chat window",
        fold: "Fold the chat",
        thread: "Ticket thread",
        older: "Older messages",
        threadEmpty: "Nobody has spoken in this thread yet. Its helper sees what is said here.",
        sending: "Sending",
        captions: "Live captions",
        done: "Done speaking",
        speaking: "Speaking",
        notSent: "Not sent: {why}",
        noVoice: "The voice did not connect: {why}",
        gotIt: "Got it",
        settings: "Settings",
        nobodyOnIt: "No helper is on it now; the thread stays",
        replies: "{n, plural, one {# reply} other {# replies}}",
        back: "Back to {channel}",
        dispatch: "Sent work",
        channel: "Channel: {channel}; click to switch or open a new one",
        channels: "Channels",
        directs: "Direct messages",
        projectTag: "project {project}",
        newChannel: "New channel",
        pageAndSchedules: "Channel page and scheduled tasks",
        settingsLink: "Settings",
        back2: "Back",
        newChannelLine: "A long-running matter or a project gets a place of its own to talk and send work. Call the manager here and the work is sent here.",
        nameHint: "Name, such as clock-in",
        name: "Channel name",
        descriptionHint: "What it is for (optional)",
        description: "Channel description",
        projectHint: "Default project (optional)",
        project: "Default project",
        open: "Open",
        settingsOf: "Settings of {channel}",
        what: "What it is for",
        projectNone: "Default project (empty for none)",
        save: "Save",
        sendTo: "Send to {name}",
        anyone: "Any helper",
        inThread: "Say it in the thread; {name} sees it…",
        inThreadAnyone: "Say it in the thread…",
        toOrchestrator: "Tell the manager; @ calls a helper…",
        toOrchestratorAlone: "Just between you and the manager…",
        who: "Who",
        stop: "Stop the manager",
        stopHint: "Stops the manager's round; helpers already sent keep working",
        send: "Send",
        less: "Less",
        more: "Read more",
        foldDispatch: "Fold the dispatch",
        unfoldDispatch: "Unfold the dispatch",
        spent: "This round spent {spent}",
        newCount: "{n} new",
        replyTo: "Replying to {name}",
        replyToText: "Replying to {name}: {text}",
        notSentLine: "Not sent",
        retrySend: "Send again",
        dropSend: "Drop it",
      },
      tool: {
        hand: { label: "Hand", hint: "Click a plot for its details, an empty one to sow" },
        water: { hint: "Pass a helper a word; one at work hears it on the way" },
        bug: { label: "Spray", hint: "The job failed (bugs in the plot): have it go on fixing" },
        weed: { label: "Weed", hint: "Review notes that did not pass grow as weeds: pulled when the helper fixes them and the next review passes" },
        harvest: { label: "Harvest", hint: "A ripe plot: bring in the result and let the helper go" },
        shovel: { label: "Shovel", hint: "Stops one at work; lets one not at work go" },
      },
      aim: {
        flowerbed: "A cleared flowerbed",
        clearAt: "Lv.{level} clears this plot",
        unread: "This plot's ticket has not been read yet",
        look: "Look at this plot",
        sow: "Sow",
        water: "Water {name} (pass a word)",
        nothingYet: "Nothing planted yet: sow with the hand first",
        bug: "Spray: have it go on fixing",
        noBugs: "No bugs in this plot",
        weeds: "Weeds are pulled once the helper fixes them and the review passes",
        noWeeds: "No weeds",
        harvestRipe: "Harvest, let the helper go",
        harvestLook: "Harvest: see what it changed",
        nothingToHarvest: "Nothing to harvest on an empty plot",
        shovelStop: "Shovel: stop it",
        shovelDismiss: "Shovel: let it go",
        noShovel: "Nothing to shovel on an empty plot",
        unavailable: "This ticket is {state}: open the plot to see",
      },
      command: {
        cannot: 'This ticket cannot "{act}" now',
        stored: "Into the warehouse",
        noShovel: "This ticket cannot be shoveled now",
        changed: "This plot has changed: click again",
      },
      page: { lost: "Cannot reach the farm, reconnecting… (is the server running?)", waiting: "Waiting for the farm…" },
      hud: {
        label: "The farm's HUD",
        look: "Change the manager's look",
        workbenchHint: "Tickets, chat… the pages for managing work",
        workbench: "Workbench",
        treeHint: "Memory tree: what the farm has learned",
        tree: "Memory tree",
        mapHint: "Map: an island for each project",
        map: "Map",
        channelsUnread: "Channels, {n} unread",
        menuHint: "Menu (Esc)",
        tools: "Tools",
        toLevel: "{xp}/{need} commits",
        toLevelNext: "{xp}/{need} commits · Lv.{next} clears a plot",
      },
      quota: {
        unreported: "reports no allowance",
        signedOut: "Not signed in: the allowance cannot be read",
        unreadable: "Cannot be read: {why}",
        balance: "{enough, select, true {Pay as you go · {provider} balance} other {Pay as you go · {provider} balance, running out}}",
        all: "Allowance left on each runtime",
        lowest: "Allowance left: the lowest has {pct}%",
        quota: "Allowance",
        left: "Allowance left",
        refresh: "Read the allowance now",
        note: "Read from each account every few minutes, and after each round a helper works.",
        spentToday: "About {spent} spent today",
        spentTodayBudget: "About {spent} spent today / budget {budget}",
      },
      friends: {
        status: { bug: "Bugs in its plot", ripe: "Ripe, waiting for you", busy: "Working", rest: "Resting in its plot", away: "Not on the farm" },
        tally: " · hired {hired} times, harvested {harvested}",
        energy: "Energy {short}",
        disabled: "Disabled: cannot be sent",
        unpick: "Stop picking it",
        pick: "Send it the next job",
        profile: "Profile",
        helpers: "Helpers",
      },
      fx: {
        coins: "{detail} · +{coins} coins",
        notice: "Notice",
        levelUp: "The farm reached Lv.{level}",
        level: "Farm Lv.{level}",
        cleared: "A new plot was cleared",
      },
      sign: {
        label: "Project sign: {project}",
        noProject: "No project",
        hint: "This farm belongs to this project; click it to go back to the map and visit another island",
        project: "Project",
      },
      overlay: {
        click: "Click: {text}",
        clearAt: "Lv.{level} clears it",
        idle: "What shall we plant today?",
        unclaimed: "Uncleared plot",
        flowerbed: "Flowerbed",
        bare: "Plot {plot} · empty",
      },
      crop: {
        empty: "empty",
        seeded: "just sown",
        sprout: "sprouting",
        leafy: "leafy",
        flowering: "flowering",
        wheat: "ripe",
        withered: "withered",
        weeds: "weedy",
        dry: "dry",
        harvested: "harvested",
        locked: "uncleared",
      },
      yard: {
        shop: { hint: "Seeds, decorations, clearing new plots" },
        warehouse: { hint: "What was harvested" },
        tasks: { hint: "Starter tasks, clearing, the wall of achievements" },
        log: { hint: "What was said and harvested, newest first" },
        taskBoard: { label: "Planting plans", hint: "A long job split into steps for several helpers" },
        agents: { hint: "Which machine each helper uses, its persona and skills, how it looks" },
        manager: { hint: "Talk to the manager" },
        runtimes: { label: "Workshop · machines", hint: "Each machine is a runtime: installed or not, usage" },
        skills: { label: "Library · skill book", hint: "Skills helpers can carry" },
      },
      canvas: {
        label: "VibeValley's pixel farm",
        noMap: "The village map could not be fetched: {why}",
        map: "Reading the map…",
        moving: "Moving into the village {done}/{total}",
        lights: "Lighting up…",
        entering: "Entering the village",
      },
      title: {
        start: "New game",
        continue: "Continue",
        keyFirst: "Fill in the key first: the manager needs a DeepSeek API key to work. Fill it in under Settings.",
        label: "VibeValley title screen",
        name: "VibeValley",
        tagline: "A crew of little animals who write code, waiting for your jobs",
        nothingToContinue: "No farm to continue yet: start a new game first.",
      },
      debug: {
        title: "Debug console",
        close: "Close `",
        call: "Call",
        open: "Open",
        dismiss: "Dismiss",
        sky: "Sky",
        time: "Time",
        stop: "Stop",
        progress: "Game progress",
        levelUp: "Level up (with banner)",
        achievement: "Pop an achievement",
        helpers: "Helpers · {n}",
        nobody: "Nobody in the field.",
        halt: "Stop",
        all: "All",
        haltAll: "Stop all",
        dismissAll: "Dismiss all",
        frames: "Frames and events · {n}",
        resume: "Resume",
        pause: "Pause",
        clear: "Clear",
        copy: "Copy .jsonl",
      },
    },
    "web.farm.map": {
      finding: "Looking…",
      islands: "{n, plural, one {# island} other {# islands}}",
      peopled: "{n} with helpers",
      working: "{n}/{of} being worked on",
      queued: "{n} queued",
      stake: "A free spot: click to send work",
      locked: "Every spot taken",
      sack: "Queued work",
      send: "Send a ticket · {project}",
      plot: "{name}'s plot",
      open: "A free spot: send a ticket to {project}",
      wait: "Waiting for a plot",
      queuedTip: "Queued: {title}",
      queuedLabel: "Queued work: {title}",
      enter: "Enter {project}'s farm",
      enterWord: "Enter",
      homeless: "Not in any project: ",
      sea: "No projects in the work folder yet: the map is all sea.",
      notDrafted: "Not drafted: {why}",
      sowIntro: "Planting in {project}: write a line on what to do, and the manager sends a helper; or write it as a to-do first and start it after a look.",
      job: "What to do",
      jobExample: "Such as: add Remember me to the sign-in page",
      todo: "Write it as a to-do",
      sow: "Plant it",
      gone: "This project is no longer in the work folder; only the helpers still on the island are left.",
      worktrees: "worktrees · {n}",
      noHelpers: "No helpers on the island yet: each ticket sent here adds a worktree.",
      noMore: "No more work is sent here.",
      canSend: "{n} more tickets can start at once (this project takes at most {of} helpers at a time).",
      shut: "{n} tickets are already being worked on: new work queues.",
      full: "Full: all {n} helpers are working, so new work queues.",
      queue: "Queued · {n}",
      see: "See this ticket",
      growth: "Growth · {label}",
      growthSince: "Growth · {label} · last commit {since}",
      crop: { never: "never dug", day: "thriving", week: "growing", month: "sprouting", quarter: "drying out", older: "gone wild" },
      island: {
        branch: "\nbranch {branch}",
        open: "Free spot: send a ticket here and it starts at once",
        shut: "{n} tickets are already being worked on: wait for one to finish",
        gone: "no longer in the work folder",
        working: "{full, select, true {working {n}/{of} (full)} other {working {n}/{of}}}",
        queued: "{n} queued",
      },
    },
    "web.farm.phone": {
      ringing: "Incoming…",
      decline: "Decline",
      answer: "Answer",
      callOrchestrator: "Call the manager",
      missed: "Missed {n}",
      log: "Log",
      noCalls: "No calls yet.",
      answered: "answered",
      declined: "declined",
      noMissed: "No missed calls. All is well in the field.",
      phase: {
        connecting: "Connecting…",
        live: "On the call: go ahead, the manager is listening",
        coming: "On the call: the manager is on the way",
        ending: "Hanging up…",
        failed: "Not connected: {why}",
        idle: "Just say it. When a ticket comes back or gets stuck, the manager calls you too.",
      },
      manager: "Manager",
      hangUp: "Hang up",
      app: { missed: "Missed", channels: "Chat", graphs: "Plans", games: "Games" },
      game: { blocks: "Blocks", sokoban: "Sokoban", dino: "Dino", bugs: "Bug snake", merge: "Farm 2048" },
      phone: "Phone",
      phoneRinging: "Phone: incoming call",
      phoneMissed: "Phone, {n} missed calls",
      phoneUnread: "Phone, {n} new in the farm chat",
      ring: "Call",
      new: "new",
      label: "Farm phone",
      home: "Home",
      homeHint: "Back to the home screen",
      brand: "FarmTel",
      openChat: "Open the farm chat",
      openChatUnread: "Open the farm chat, {n} new",
      key: { up: "Up", left: "Left", right: "Right", down: "Down" },
      pressA: "Press A to {what}",
      again: "play again",
      start: "start",
      resume: "resume",
      paused: "Paused",
      sokoban: {
        levels: { "0": "First crate of seeds", "1": "Round the back", "2": "Two crates of harvest", "3": "Warehouse corner", "4": "Harvest home" },
        title: "Sokoban {level}/{of}",
        moves: "{moves} moves · {pushes} pushes",
        board: "Warehouse board, {placed}/{of} crates in place",
        allIn: "The whole harvest is in!",
        done: "This store is tidied!",
        goal: "Push the crates onto ◆",
        undo: "B undo",
        again: "Play again",
        next: "Next level",
        restart: "Restart",
        help: "Arrows walk · crates can only be pushed",
      },
      dino: {
        road: "The dino's road",
        crashed: "Crashed",
        help: "A or ↑ jumps, ↓ or B ducks",
        help2: "The further it runs the faster it goes; birds come later",
      },
      merge: {
        start: "Press A to start",
        restartAsk: "Replant this plot?",
        restartKeys: "A restart · B keep planting",
        harvest: "Bumper harvest!",
        goOn: "Press A to keep planting",
        full: "The plot is full · {score} points",
        overKeys: "A again · B take back a move",
        reached: "Grew {stage}",
        field: "In the field: {n} plants, best {top}",
        stages: "Harvest catalog",
        help: "Arrows or a swipe: two of a kind grow into the next",
        help2: "B take back · A restart",
        stage: {
          "0": "Seed",
          "1": "Sprout",
          "2": "Leaf",
          "3": "Flower",
          "4": "Wheat",
          "5": "Carrot",
          "6": "Sheaf",
          "7": "Basket",
          "8": "Cart",
          "9": "Granary",
          "10": "Harvest",
        },
        past: "Harvest {n}",
      },
      bugs: {
        ended: { wall: "Hit the ridge", self: "Bit itself", full: "The field is full" },
        tally: "Seeds {seeds} · bugs {bugs}",
        field: "The bug snake's field",
        help: "Arrows turn, B pauses",
        help2: "Seeds add a segment; eat a bug before it flies off for more points",
      },
      blocks: {
        well: "The blocks' well",
        noRoom: "No room left",
        score: "Score",
        lines: "Lines",
        level: "Level",
        best: "Best",
        help: "←→ move ↑ turn",
        help2: "↓ drop A to the bottom",
        help3: "B pause",
        next: "Next",
      },
      chatTab: "CHAT",
    },
    "web.inbox": {
      tray: {
        working: "{n, plural, one {# helper working} other {# helpers working}}",
        idle: "Open, nothing being worked on",
        off: "Not open yet",
        unread: "{n} unread in the channels",
      },
    },
    "web.issue": {
      reading: "Reading…",
      never: "Never mind",
      later: "Leave it for now",
      orchestrator: "Manager",
      noHelper: "No helper yet",
      board: {
        add: "+ Write one, Enter saves it",
        addLabel: "Write a to-do",
        earlier: "{n} earlier",
        recent: "Recent only",
        empty: {
          todo: "Write down what you want done here; drag it to In progress to start someone on it, up and down to order it.",
          working: "Nothing being worked on.",
          waiting: "What is done or failed waits here for you; drag it to Closed to complete or cancel it.",
          closed: "Completed and canceled tickets; drag one back to In progress to reopen it.",
        },
        whichLane: "Which column",
        spots: "{taken} / {of} spots",
        moveFailed: "Not moved",
        retryMove: "Move it again",
        putBack: "Put it back",
      },
      display: {
        boardNote: "The board always has a column per status, and dragging changes the status; grouping is for the list.",
        orderNote: "Unless the order is Default, to-dos cannot be dragged up and down.",
        defaultNote: "Default is the order you gave the to-dos.",
        show: "Display",
        group: "Group",
        order: "Order",
        reset: "Reset",
      },
      list: { noProject: "No project", all: "All tickets", unfold: "Unfold {group}", fold: "Fold {group}", writeIn: 'Write one in "{group}"' },
      page: {
        pickFirst: "Almost: pick which helper and which project, then press Start.",
        notDrafted: "Not drafted: {why}",
        historyUnread: "The tickets' records could not be read: ",
        notFound: "No such ticket",
        notFoundLine: "There is no ticket {id}: it may have been deleted, or the link is wrong.",
        find: "Find a ticket: title, helper, project",
        findLabel: "Find a ticket",
        filter: "Filter",
        byProject: "By project",
        allProjects: "All projects",
        byHelper: "By helper",
        allHelpers: "All helpers",
        shown: "{shown} / {of}",
        clear: "Clear the filter",
        view: "View",
        missing: "The run's record is missing: {what}. Its acts are not available.",
        backToBoard: "Issues",
      },
      marks: { priority: "Priority: {word}" },
      sheet: { less: "Less", more: "More", at: 'At "{stage}"', stageDone: "{stage}: done" },
      acts: { reopened: "Ticket reopened", goesOn: "{helper} carries on.", rejectWith: "Send back, fix what is above", carry: "Pass it on" },
      close: {
        title: 'Close "{issue}"',
        working: "{who} is still working on this ticket. Canceling stops it and lets it go; the changes on its branch are not merged into main.",
        completable:
          "Completing merges {who}'s branch into the project's main branch, after you look over the changes; canceling lets it go without merging them.",
        notCompletable: "This ticket cannot be completed now. Canceling lets {who} go, and its changes are not merged into main.",
        review: "See the changes, complete",
        stopAndCancel: "Stop and cancel",
        cancel: "Cancel the ticket",
      },
      changes: {
        reading: "Looking at what it changed…",
        unreadable: "The changes cannot be read: ",
        none: "This one has no changes. Completing just lets it go.",
        conflict: "Merging into {base} would conflict, so it cannot be completed yet",
        resolveHow: "Have it merge {base} into its own branch, resolve the conflicts, run the tests and commit; then complete it.",
        behind: "While it worked, {base} got {n} more commits; completing joins them (with one merge commit).",
        uncommitted: "{n} files are not committed yet; completing commits them first:",
        letGo: "Complete, let it go",
        merge: "Complete, merge into {base}",
        resolve: "Have it resolve the conflict",
        moved: "The ticket's status changed: go back to the ticket and see what it asks of you.",
        counts: "{commits} commits · {files} files",
        commits: "Commits {n}",
        files: "Changed files {n}",
        conflictMark: "Conflict",
        binary: "binary",
      },
      reopen: {
        title: "Reopen this ticket",
        line: 'A new helper of the same profile carries "{issue}" on; it will know what the ticket was for and how it was closed last time.',
        what: "What to do this time (empty to finish what was left)",
        whatLabel: "What to do this time",
        reopen: "Reopen",
      },
      detail: {
        now: "Where it is",
        yours: "For you to do",
        rejectWhere: "What did not pass, one per line",
        rejectLabel: "What did not pass",
        sayIt: "Say it yourself…",
        answer: "Answer",
        tell: "Tell {who}",
        tellSection: "Tell it",
        tellWorking: "It hears this even while it works",
        tellIdle: "Say something and it works another round",
        progress: "How far it got",
        met: "{met} / {of} met",
        noCriteria:
          "{answer, select, true {This ticket has no criteria for done: judge by its answer when it comes back.} other {This ticket has no criteria for done: judge by its changes when it comes back.}}",
        rejected: "Sent back last time",
        made: "What it made",
        nothingToSee: "No changes to see.",
        noAnswer: "No answer yet.",
        noChanges: "No changes yet.",
        changedFiles: "Changed files",
        fileCount: "{n}",
        changesUnread: "The changes cannot be read.",
        story: "How it got here",
        unread: "Cannot be read.",
        full: "What to do (in full)",
        steps: "The helper's every step",
        runs: "Every round of work",
        time: "Time",
        opened: "Opened",
        started: "Started",
        waiting: "Waiting for you",
        since: "since {clock}",
        reviewed: "Accepted",
        closedAt: "Closed",
        who: "Who",
        helper: "Helper",
        model: "Model",
        deliver: "Delivers",
        crew: "Worked on by",
        profile: "Profile",
        branch: "Branch",
        copyPath: "Copy the path",
        took: "Took",
        resolved: "Resolved review notes",
        answerTo: "Answer: {question}",
        result: { met: "It says this is met", unmet: "It says this is not met", unsure: "It is not sure" },
        ticked: "Checked: {criterion}",
        unsaid: "It has not said yet",
        noRuns: "No work yet.",
        runCount: "{n, plural, one {# round} other {# rounds}}",
        stepCount: "{n, plural, one {# step} other {# steps}}",
        stepsAndTools: "{n} steps · used {tools} tools",
        step: {
          "run/start": "Started",
          "user/message": "Heard",
          "memory/recalled": "Recalled",
          "assistant/thinking": "Thought",
          "assistant/message": "Said",
          "tool/call": "Used a tool",
          "llm/retry": "Retried",
          "run/error": "Error",
          "run/end": "Round over",
        },
        orchestratorStuck: "The manager did not finish answering this round: see what it said in its channel",
        job: "To do",
        from: "From",
        fromCron: "A scheduled task: each time it is due it goes to the manager, and its answer waits for you",
        answered: "In its channel",
        evidence: "Evidence",
        unsure: "Not sure about",
        next: "Suggested next",
        conflict: "Merging into {base} would conflict: {files}",
        graphStep: 'A task of the plan "{graph}"',
        backToGraph: "Back to the plan",
      },
      task: {
        label: "Plan",
        steps: "{n, plural, one {# task} other {# tasks}}",
        done: "{done} / {of} tasks done",
        waitsForYou: "A task is waiting for you: open it to answer or review.",
        splitting: "The manager is splitting it into tasks; they will be listed below.",
        ok: "Done.",
        check: "Check",
        scope: "Where it changes",
        conclusion: "Conclusion",
        spent: "Spent",
        tried: "Tried",
        tries: "{n} times",
        open: "Open this ticket",
        review: "See the changes, {merge}…",
        state: "State",
        project: "Project",
        progress: "Progress",
        progressLine: "{done} / {of} tasks",
        parallel: "At once",
        atMost: "at most {n} tasks",
        written: "Written",
        note: "Note",
        abandonTitle: "{abandon} this plan?",
        abandonLine: "The tasks not done yet are not sent out; the plan's branch stays, with every commit made so far.",
        abandon: "Abandon it",
        reading: "Looking at what the plan's branch changed…",
        behind: "Meanwhile {base} got {n} more commits",
        merge: "Merge into {base}",
        layer: "Batch {n}",
        layerTogether: "Batch {n} · these {size} tasks can run at once",
        waitsOn: 'waiting for "{steps}"',
        stepSeparator: '", "',
        conflict: "Merging into {base} would conflict: {files}. Not merging until the changes on {base} are sorted out.",
      },
      todo: {
        queued: "Queued: every spot is taken, and it starts by itself when one frees up.",
        refining: "{who} is drafting",
        refiningLine: "It is reading the code, and will fill in the fields below.",
        questions: "{n, plural, one {The draft is written, and it has a question for you} other {The draft is written, and it has # questions for you}}",
        questionsLine: "Answer below, and it drafts again by your answers.",
        drafted: "The draft is written",
        draftedLine: "Look it over, change what you like, and start it.",
        what: "What should be done?",
        whatLine: "A line is enough: a helper reads the code and writes it up as a ticket.",
        titleHint: "Such as: add Remember me to the sign-in page",
        title: "Title",
        descriptionHint: "Description: why, what to do, what not to do, which files it may touch (drafting writes it)",
        description: "Description",
        criteria: "Acceptance criteria",
        noCriteria: "Not written yet",
        criteriaSummary: "{n} · {first}",
        criteriaHint: "One per line: the points you check when you review",
        talk: "Talk it through with the helper",
        answerTo: "Answer: {question}",
        answerHint: "Answer its questions",
        againHint: "What to change when it drafts again (optional)",
        whatHint: "What should be done, in a line",
        whatLabel: "What should be done",
        redraft: "Draft again",
        draft: "Draft",
        status: "Status",
        draftStatus: "Draft",
        todoStatus: "To do",
        pickForMe: "Picked for you when drafting",
        whichProject: "Which project",
        firstProject: "No project yet: make one",
        newProjectLink: "+ New project",
        priority: "Priority",
        inQueue: "Queued {ago}: it starts by itself in the board's order when a spot frees up.",
        unqueue: "Unqueue",
        pickHelper: "Pick a helper first",
        start: "Start",
        save: "Save",
        remove: "Delete",
        newProject: "New project",
        projectHint: "The project's name, which is also its folder under the work folder",
        projectName: "Project name",
        create: "Create",
        writeOwn: "Write it yourself",
      },
      boardLabels: {
        view: { board: "Board", list: "List" },
        grouping: { status: "Status", project: "Project", agent: "Helper", none: "No grouping" },
        ordering: { manual: "Default", priority: "Priority", updated: "Last updated", created: "Created" },
        lane: { todo: "To do", working: "In progress", waiting: "For you to see", closed: "Closed" },
        stage: { talk: "Talk it through", work: "Get it worked", finish: "Finish" },
        newIssue: "New ticket",
      },
      graph: {
        splitting: "splitting into tasks",
        draft: "split: look it over, then start",
        running: "{done} / {total} tasks done",
        paused: "paused",
        ready: "all done, waiting for you to merge into main",
        done: "merged into main",
        abandoned: "abandoned",
      },
      trigger: {
        issue: "sent out",
        comment: "a word passed on",
        commentNumbered: "a word passed on (#{id})",
        task: "plan",
        cron: "scheduled task",
        missed: "scheduled task (made up)",
        refine: "drafting",
        runtime: "the machine itself",
      },
      run: { working: "working", heard: "{n, plural, one {heard # word on the way} other {heard # words on the way}}" },
      card: {
        orchestrator: "Manager",
        refining: "{name} is drafting",
        draft: "Draft",
        queued: "Queued",
        cron: "Scheduled task",
        noHelper: "No helper yet",
        pickFirst: "No helper or project picked: pick them before starting",
        waiting: "waiting for a free spot, queued {ago}",
        written: "written {ago}",
        lost: "Lost",
        quiet: "quiet for {took}",
        nth: "attempt {n}",
        open: "open for {took}",
        used: "took {took}",
        run: "round {n}",
        runs: "{n, plural, one {# round} other {# rounds}}",
        orchestratorWorking: "the manager is on it",
        missingFlag: "Record missing",
        graph: "Plan: {title}",
        missing: "The run's record is missing: {what}",
      },
      issue: {
        asking: "{n, plural, one {{who} has a question for you} other {{who} has # questions for you}}",
        askingLine: "Pick an option to answer, or say it yourself.",
        reviewed: "Accepted: it can be completed",
        handedBack: "{who} handed it back for you to review",
        conflict: "merging into {base} would conflict",
        main: "main",
        failed: "This round failed",
        interrupted: "This round stopped halfway",
        quiet: "{who} has been quiet a long while",
        quietLine: "It may be running a long command, or it may be stuck: look at its steps, and stop it if it is wrong.",
        stuck: "Stuck",
        canceled: "Canceled",
        reopenLine: "To have it carry on, reopen it: write a line on what to do this time.",
        inGraph: "This is a task of a plan, and goes with the plan.",
        splitting: 'Splitting the plan "{graph}": reading code only, changing no files.',
        editing: "{who} is changing the code",
        history: "{n} times: {line}",
        historyItem: "{name} ({id})",
        since: "for {span}",
        ran: "round {n}",
        used: "{span} in all",
        noSteps: "No steps yet.",
        stepsGone: "Work steps are kept for 30 days (session.trajectory_days in the configuration); this ticket's are cleared.",
        change: { A: { mark: "A", label: "Added" }, M: { mark: "M", label: "Modified" }, D: { mark: "D", label: "Deleted" } },
        and: ", ",
        doing: "{action}",
        doingLabel: "{action}: {label}",
        who: "{name}",
        whoRuntime: "{name} ({runtime})",
        changes: "{branch} → {base} · {commits} commits · +{added} -{removed}",
        changesUncommitted: "{branch} → {base} · {commits} commits · +{added} -{removed} · {uncommitted} uncommitted",
        graphStep: 'A task of the plan "{graph}": {step}. When done it merges into the plan\'s branch by itself, and reaches main when the whole plan does.',
        justNow: "just now",
      },
    },
    "web.lan": {
      lan: {
        section: { label: "Connect to this machine" },
        open: "On",
        closed: "Off",
        intro:
          "Once on, a phone or another computer on the same local network can scan to pair, then use VibeValley on this computer: see helpers, send work, talk in the channels.",
        allow: "Allow connections",
        address: "Address",
        add: "Add a device",
        close: "Turn off",
        devices: "Paired devices",
        deviceCount: "{n}",
        removeWhich: "Remove {name}",
        remove: "Remove",
        copied: "Copied: open it in the other computer's browser.",
        notCopied: "Cannot copy: select the link and copy it yourself.",
        qr: "Pairing QR code",
        scan: "Scan this code with the phone's camera; on another computer, open this link in the browser:",
        left: "Valid for {s} more seconds, once.",
        copy: "Copy the link",
        newCode: "Another code",
        stop: "Stop adding",
        asking: '"{name}" wants to connect to this computer. Let in, it can use VibeValley on this computer as you do.',
        letIn: "Let it in",
        refuse: "Refuse",
        paired: "Paired {at} · last seen {seen}",
        pairedNever: "Paired {at} · never seen",
        notes: {
          "0": "Helpers can run commands on this computer, so only paired devices may connect; pairing needs your approval here.",
          "1": "A paired device uses VibeValley on this computer as you do. The switch and the devices are managed only on this computer.",
          "2": "The connection is plain HTTP: people on the same network may see what goes over it. Turn it on only on networks you trust, such as your home Wi-Fi or your own hotspot.",
          "3": "When the computer's address changes (another network), devices cannot connect; add the device here and scan again, without approving again.",
        },
      },
      devices: { android: "Android phone", windows: "Windows PC", device: "A device" },
      pair: {
        title: "Connect to that computer",
        intro:
          "This device connects to VibeValley on that computer and, like the owner, sees helpers, sends work and talks in the channels. Pairing needs the owner's approval on that computer.",
        code: "Pairing code",
        codeHint: "On that computer, press Add a device under Connect to this machine",
        name: "This device is called",
        nameHint: "The name the owner sees in the list of devices",
        ask: "Ask the owner to let it in",
        waiting: "Waiting for the owner on that computer to approve…",
      },
    },
    "web.memory": {
      memory: {
        yours: "you remembered",
        orchestrators: "the manager remembered for it",
        sessions: "{name} remembered",
        own: "it remembered",
        intro:
          'The helpers sent from this agent share one memory. At the start of each round, the few notes that bear on it go before what it hears; at the end, the "Remember:" lines in its report, and how far the ticket got, are kept.',
        issues: "Tickets in hand",
        noIssues: "Its helpers have not finished a round yet.",
        helper: "Helper",
        allProjects: "All projects",
        notes: "Remembered",
        all: "All",
        emptyHere: "Nothing here.",
        nothing: 'Nothing remembered yet. A helper writes "Remember:" in its report, or you write one for it above.',
        neverRecalled: "never recalled",
        fading: "Fading: the first to go when {keep} are kept",
        inSource: "in {source}",
        forgetThere: "delete it in {source}",
        sources: "Where memory comes from",
        on: "in use",
        off: "not connected: {why}",
        listed: "what it keeps is listed below",
        unlisted: "not listed here",
        forgettable: "can be forgotten here",
        forgetElsewhere: "delete it there",
        transcripts: "takes whole work conversations",
        sourcesNote: "Connect, turn off, or change reading and writing under Settings.",
        next: "Recalled at the next start",
        preview: "{n} · {chars} / {limit} characters",
        where: "Which project it starts in",
        pick: "Pick a project",
        words: "This round's words",
        wordsHint: "This round's words (optional)",
        blank: "Starting in this project, nothing comes to mind.",
        noProjects: "No projects yet.",
        orchestratorReading: "Reading the manager's memory…",
        orchestratorIntro:
          "The manager reads its memory when it starts and after each compaction; what is remembered or forgotten in between, it knows by its next line.",
        orchestratorNothing: 'Nothing remembered yet. Tell the manager "Remember…", or write one for it above.',
        orchestratorOwn: "the manager remembered",
        told: "you told it",
        tooOld: "Too old to go into the system prompt",
        archiveIntro:
          "When the conversation grows too long, the manager compacts the earlier part into a summary and keeps the original here word for word. When the summary misses a detail, it looks it up with search_archive; you can look here too.",
        search: "Search the archive",
        searchHint: "A word",
        find: "Search",
        found: "Found",
        compacted: "Compacted conversations",
        noArchive: "None yet: the manager's conversation has not grown long enough to compact.",
        chars: "{n} characters",
        note: "Write one for it",
        noteProject: "Such as: clock-in's tests run with pnpm test, not npm",
        noteOrchestrator: "Such as: write commit messages in English; no night shifts on weekends",
        project: "Project",
        projectHint: "Project (optional)",
        noteHint: "A sentence that is clear at a glance next time.",
        noteHintProject: "A sentence that is clear at a glance next time. With no project it holds for every project.",
        forget: "Forget",
        recalled: "recalled {n} times",
        recalledLast: "recalled {n} times, last {last}",
      },
    },
    "web.orchestrator": {
      looks: {
        farmer: { name: "Young farmer", blurb: "Straw hat and overalls, always smiling." },
        foreman: { name: "Foreman", blurb: "Hard hat and safety vest, walkie-talkie always on, there at a call." },
        auntie: { name: "Farm auntie", blurb: "Headscarf and apron, every plot's work in her notebook." },
        grandpa: { name: "Old hand", blurb: "White beard, a lifetime of farming, never in a hurry." },
        gardener: { name: "Gardener", blurb: "A flower in a wide straw hat, shears in the apron pocket." },
        robot: { name: "Robot manager", blurb: "A round farm robot whose face screen smiles." },
      },
      pet: { dog: "Puppy", ragdoll: "Colorpoint ragdoll", bluecat: "Blue cat" },
      orchestrator: {
        tab: { memory: "Memory", trajectory: "Trajectory", archive: "Archive", voice: "Voice" },
        all: "← All profiles",
        title: "Manager",
        intro: "The manager is not a helper: it hears what you want done, sends helpers to do it, watches progress and passes on results.",
        look: "It looks like {name}.",
        profile: "Edit its profile",
        tabs: "The manager's",
        heard: "Heard",
        quiet: "The manager has not spoken yet.",
        trajectory: "Each of the manager's rounds",
        about:
          'What it heard, every tool it called (click a row for the arguments and the result), what it said. Newest at the bottom; the last 1000 steps are kept. When a round went wrong, click "This round went wrong" on what it heard, write what it should have done, and it is kept as an eval.',
      },
    },
    "web.project": {
      title: "Projects",
      list: "Projects",
      add: "New project",
      repos: "Code bases",
      all: "All",
      allLine: "The whole map: an island for each project",
      notGit: "Not a git repository yet",
      finding: "Looking…",
      none: "No projects in the work folder yet. Press New project to add one, or download one from GitHub.",
      copied: "Copied: {path}",
      notCopied: "Cannot copy: select the path and copy it yourself.",
      recency: {
        label: "Last commit: {label}",
        never: "No commits yet",
        day: "Committed in the last day",
        week: "Committed in the last week",
        month: "Committed in the last month",
        quarter: "Committed in the last three months",
        older: "No commits for three months",
      },
      firstCommit: "First commit",
      noCommits: "No commits yet",
      commitCount: "Commits",
      commits: "{n} commits",
      code: "Code",
      lines: "{n} lines",
      uncounted: "Not counted",
      languages: "Languages",
      kinds: "{n}",
      copyPath: "Copy the path",
      counting: "Counting…",
      recount: "Count again",
      countedAgo: "counted {ago}",
      whatLanguages: "Languages used",
      byLines: "By lines, blank lines left out · counted by tokei",
      linesAndFiles: "{lines} lines · {files} files",
      empty: "No code that can be counted yet.",
      noTokei: "Counting lines needs tokei, which is not on this computer yet.",
      install: "Install it in a terminal: ",
      or: " (or ",
      thenRecount: "), then press Count again above.",
      level: { "0": "none", "1": "a few", "2": "some", "3": "many", "4": "the most" },
      year: "The past year · a cell a day, fuller with more commits",
      dayCommits: "{n} commits, {level}",
      noCommitsThatDay: "no commits",
      busiest: "Busiest day: {day}, {n} commits",
      calendar: "Commit calendar",
      inYear: "In a year",
      daysWorked: "Days with commits",
      days: "{n, plural, one {# day} other {# days}}",
      longest: "Longest streak",
      current: "Current streak",
      yearLabel: "{commits} commits in the past year, on {days} days",
      readingCommits: "Reading commits",
      rows: { "0": "", "1": "Mon", "2": "", "3": "Wed", "4": "", "5": "Fri", "6": "" },
      fewer: "Less",
      more: "More",
      who: "Who worked here",
      whoWhen: "Commits in the past year",
      times: "{n}",
      rest: "{people} more, {commits} in all.",
      how: "How",
      fresh: "Start empty",
      github: "Visit a neighbor",
      githubAddress: "GitHub address",
      githubHint: "A public repository's home page. Once downloaded, you can see the project and set helpers on it.",
      name: "Project name",
      nameHint: "Kept in the work folder; a project of the same name is never overwritten.",
      nameExample: "such as raft-source",
      downloading: "Downloading the repository… a big one takes longer, up to 3 minutes.",
      making: "Creating…",
      cancel: "Cancel",
      busy: "Working…",
      download: "Download to the work folder",
      create: "Create the project",
      otherLang: "Other",
    },
    "web.runtime": {
      capability: {
        listModels: "Model list",
        accountUsage: "Account usage",
        checkUpdate: "Update check",
        upgrade: "Upgrade",
        skills: "Skill list",
        mcpServers: "MCP list",
        tools: "Tool list",
      },
      available: "available",
      disabled: "disabled",
      unsupported: "unsupported",
      notFound: "not found",
      checking: "checking…",
      noRuntimes: "The machines could not be read: ",
      title: "Machines",
      list: "Machines",
      intro: "The coding agents on this computer",
      usedBy: " · {n} agents",
      reading: "Reading…",
      bundled: "installed with oar",
      commandLine: "command line",
      unsupportedWhy: "Unsupported: {why}",
      notHere: "Not found on this computer",
      checkedAt: "checked at {clock}",
      recheck: "Check again",
      account: "Account",
      skills: "Skills",
      mcp: "MCP servers",
      tools: "Tools",
      agents: "Agents using it",
      makeAgent: "Make a new agent with it →",
      noneYet: "None yet.",
      afterInstall: "Readable once it is installed.",
      noUsage: "This runtime does not report account usage.",
      signedOut: "Not signed in. Run {runtime} on this computer and sign in once.",
      unreadable: "Cannot be read: {why}",
      balance:
        "{enough, select, true {Pay as you go: this is the {provider} account's balance.} other {Pay as you go: this is the {provider} account's balance, and it is running out.}}",
      subscription: "Plan: {tier}",
      left: "{pct}% left",
      windowLeft: "{label}: {pct}% left",
      resets: "resets {moment}",
      can: "What it can do",
      steer: "Takes words while it works (steer)",
      noSteer: "Cannot be interrupted while it works: words queue after the round",
      inProcess: "· Runs inside the server process (Node SDK)",
      ownProcess: "· Runs as its own command-line process",
      refused: "Session options it refuses",
      acceptsAll: "Accepts them all.",
      queries: "Queries oar offers",
      noEffort: "This model has no effort levels.",
      settings: "Settings",
      discard: "Discard",
      save: "Save",
      enabled: "Let agents use it",
      enabledHint: "Disabled, the agents using it cannot be sent.",
      binPath: "Command path",
      binPathHint: "oar's OAR_{id}_BIN. Empty searches the PATH.",
      auto: "Find it",
      defaultModel: "Default model",
      defaultModelHint: "Used when an agent names no model.",
      ownDefault: "The runtime's own default",
      defaultEffort: "Default effort",
      default: "Default",
      maxWorking: "At most at once",
      maxWorkingHint:
        "How many helpers using it may work at once, useful when the provider limits concurrency. At the limit, new work waits until one finishes. Empty, only VibeValley's overall limit applies (6 tickets at once).",
      noLimit: "No separate limit",
      budget: "Daily budget (¥)",
      budgetLabel: "Daily budget",
      budgetHint:
        "{pi, select, true {Spent {spent} today (estimated from pi's price list). At the budget no new work is sent; work under way finishes. Empty sets no limit.} other {Spent {spent} today (estimated from the model's price list). At the budget no new work is sent; work under way finishes. Empty sets no limit.}}",
      unlimited: "No limit",
      env: "Environment variables",
      envHint: "Added to every session of this runtime; the agent's own environment variables win.",
      models: "Models",
      modelCount: "{n}",
      noModels: "This runtime does not report its models.",
      effort: "Effort",
      unreported: "Not reported.",
      none: "None.",
      library: {
        book: "Skill book",
        search: "Search skills",
        searchHint: "Search names, descriptions, machines…",
        noRuntimes: "The machines could not be read: ",
        installed: "Installed on this computer · {count}",
        noneReported: "The machines have not reported their skills yet (or are still being read).",
        noMatch: "Nothing matches.",
        own: "VibeValley's own · {count}",
        newSkill: "New skill",
        noSkills: "No skills yet: write one of VibeValley's own, or install some on a runtime and come back.",
        installedNote:
          "A skill installed on the machines: helpers using these machines load it when needed, no need to tick it in a profile. To change it, edit its file.",
        where: "Machines that have it",
        inUse: "{n} agents use it; deleting it takes it off them.",
        removeIt: "Delete it?",
        name: "Name",
        nameLabel: "Skill name",
        nameHint: "Such as: write the test first",
        when: "When to use it",
        whenHint: "A sentence. A runtime that loads skills when needed reads this first, then decides whether to read the body.",
        description: "Skill description",
        descriptionHint: "Before changing behavior, add a test that fails.",
        body: "Body",
        bodyHint: "Written as instructions for an agent (the body of SKILL.md).",
        bodyExample: "Before changing any behavior, write a test that reproduces the problem…",
        who: "Used by",
        nobody: "No agent carries this skill yet. Tick it on an agent's Skills tab.",
      },
      quota: {
        session: "This session",
        weekly: "This week's allowance",
        week: "This week ({models})",
        oneWeek: "· a week",
        weekdays: { "0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday", "4": "Thursday", "5": "Friday", "6": "Saturday" },
        now: "resets now",
        minutes: "resets in {m} min",
        hours: "{h, plural, one {resets in an hour} other {resets in # hours}}",
        on: "resets {weekday}",
        unreported: "reports no allowance",
        signedOut: "Not signed in",
      },
      spentToday: "Helpers spent about {spent} today, with no daily budget.",
      spentTodayBudget: "Helpers spent about {spent} today, against a daily budget of {budget}.",
    },
    "web.session": {
      log: {
        heard: "Heard",
        process: "Work",
        fold: "Fold this round",
        unfold: "Unfold this round",
        steps: "{n} steps · {took}",
        live: " · running",
        see: "See this round's {n} steps",
        less: "Less",
        all: "Show all",
        subagentGot: "Subagent got",
        told: "Passed on",
        recalled: "Recalled",
        subagentThought: "Subagent thought",
        thought: "Thought",
        subagentSaid: "Subagent said",
        said: "Said",
        farm: "Chat",
        running: "running",
        ok: "succeeded",
        failed: "failed",
        tool: "tool {name}",
        pending: "Not returned yet",
        noOutput: "No output",
      },
      runs: {
        farm: {
          channel_message_send: "speaking in the chat",
          channel_message_list: "reading the chat",
          channel_unread_list: "checking for words to it",
          session_list: "seeing who is in the chat",
          other: "Chat: {tool}",
        },
        span: {
          heard: "Heard",
          recalled: "Recalled",
          thinking: "Thinking",
          said: "Said",
          retry: "Retry",
          cache: "Cache",
          error: "Error",
          farm: "Chat",
          tool: "Tool",
        },
        earlier: "Earlier steps",
        unasked: "A round it began itself",
        subagentGot: "Subagent got",
        issue: "Ticket",
        told: "Passed on",
        usedTools: "{n, plural, one {used # tool} other {used # tools}}",
        process: "This round's work",
        tag: { thought: "Thought", subagentThought: "Subagent thought", said: "Said", subagentSaid: "Subagent said", usage: "Usage" },
        thoughtFor: "Thought for {took} · {n} tools",
      },
      trajectory: {
        lane: { asked: "Heard", model: "Model", tool: "Tool" },
        runs: "{n, plural, one {# round} other {# rounds}}",
        steps: "{n, plural, one {# step} other {# steps}}",
        modelTime: "model {took}",
        toolTime: "tools {took}",
        cacheHit: "cache hit {pct}%",
        tokens: "input {input} / output {output} tokens",
        quiet: "Nothing yet.",
        run: "Round {n}",
        earlier: "Earlier",
        search: "Search the trajectory",
        searchHint: "Search",
        noMatch: "No step matches.",
        pending: "Not returned yet",
        noOutput: "No output",
        tool: "tool {name}",
        running: "running",
        ok: "succeeded",
        failed: "failed",
        input: "Input",
        output: "Output",
        wrong: "This round went wrong",
        marked: "Marked as a wrong round and kept as an eval",
        want: "What this round should have done",
        wantHint: 'What it should do: such as "ask me which project first, do not send work right away"',
        neverSent: "Nothing sent out yet.",
        sent: "Helpers sent out",
        here: "Here",
        hired: "took the ticket {ago}",
        hiredAndLeft: "took the ticket {hired} · left {left}",
        pick: "Pick a helper to see its trajectory.",
      },
    },
    "web.setting": {
      language: {
        title: "Language",
        line: "The page's words, what the manager and the helpers answer you, and the reports sent to chat apps all use this language. The page reopens when it changes.",
        zh: "中文",
        en: "English",
        label: "Page language",
      },
      keys: { deepseekHint: "sk-… (leave empty to keep)", saved: "Saved, in use at once." },
      source: {
        off: "Not set up",
        on: "On",
        closed: "Off",
        configure: "Set up {label}",
        enabled: "On",
        enable: "Turn on {label}",
        noKey: "A local one needs no key",
        address: "{label}'s address",
        key: "{label}'s key",
        keyHint: "key (leave empty if none or to keep)",
        user: "{label}'s user_id",
        userHint: "Your user_id in EverOS (empty means owner)",
        read: "Read",
        readHint: "Also asked when recalling at the start and when a helper looks things up",
        write: "Write",
        writeHint: "What is remembered is sent there too",
        everything: "Read everything",
        everythingHint: "Not only what VibeValley remembered for helpers: every helper reads your own memories there too",
      },
      github: {
        noGh: "gh is not installed",
        note: "Which projects can open PRs is on the Projects page; opening a PR on completion is turned on in the configuration (github.pr_projects).",
        recheck: "Check again",
        cli: "gh command line",
        cliHint: "Used to open PRs and read repositories when merging",
        login: "Login",
        loginHint: "The account gh auth login signed in",
        notLoggedIn: "Not signed in",
      },
      nav: {
        label: "Settings sections",
        search: "Search settings…",
        general: "General",
        appearance: "Appearance",
        models: "Models",
        about: "About",
        memory: "Memory",
        skills: "Skills",
        call: "Call line",
        dictation: "Dictation",
        chat: "Chat apps",
        devices: "Devices",
        width: "Navigation width (drag; double-click for the default)",
      },
      groups: { options: "Options", helpers: "Helpers", voice: "Voice", connect: "Connections" },
      words: {
        general: "language start open workbench farm",
        appearance: "theme dark light size zoom scale font",
        models: "DeepSeek key model manager",
        about: "version home folder settings file",
        memory: "Nowledge EverOS memory recall",
        skills: "skill library",
        call: "Agora phone call recognition speech who answers area",
        moss: "MOSS try key realtime",
        dictation: "dictation transcription voice input",
        github: "gh PR login",
        chat: "WeChat Feishu Lark QQ connectors pairing",
        devices: "phone pairing connect to this machine LAN",
      },
      scope: { farm: "For all of VibeValley", device: "This device only" },
      general: {
        languageHint: "The page, the manager and the helpers all speak it",
        start: "Open on start",
        startHint: "Where the app, or the home page, opens",
        starts: { workbench: "Workbench", farm: "Farm" },
      },
      appearance: {
        intro: "The workbench only; the farm and the memory tree are drawn and keep their own colours and day.",
        theme: "Theme",
        themeHint: "With the system, it follows the computer's light and dark",
        themes: { light: "Light", dark: "Dark", system: "System" },
        scale: "Interface size",
        scaleHint: "Scales the whole workbench; the farm keeps its whole-number scaling",
      },
      models: { intro: "The models the manager and VibeValley's own helpers use.", deepseekHint: "The manager and VibeValley's own helpers use it" },
      memory: { intro: "Helpers can also look things up in, and write to, memory outside VibeValley." },
      about: {
        version: "Version",
        versionHint: "The server on this machine",
        files: "Files",
        home: "Home folder",
        homeHint: "Everything VibeValley keeps is here",
        settings: "Settings file",
        settingsHint: "The keys and these pages' settings",
        copy: "Copy the path",
        copied: "Path copied",
        reveal: "Show in Finder",
        update: "Updates",
        updateHint: "The desktop app updates itself from the releases on GitHub",
        upToDate: "Up to date",
        checking: "Looking for a new version…",
        downloading: "Downloading {next} ({percent}%)",
        ready: "{next} is ready and goes in when you quit",
        readyNewFarm: "{next} is ready: it starts from fresh data and keeps the old aside",
        manual: {
          diskImage: "{next} needs installing by hand: the app runs from its disk image; drag it to Applications first",
          translocated: "{next} needs installing by hand: macOS runs the app from a temporary place; drag it to Applications and open it again",
          readOnly: "{next} needs installing by hand: the app's folder cannot be written",
          noBuild: "{next} has no build for this Mac",
        },
        failed: "Could not check: {why}",
        check: "Check for updates",
        restart: "Restart to update",
        restartQuestion: "Restart into the new version?",
        workingQuestion: "{n} helpers are working; restarting cuts them off. Restart now?",
        newFarmQuestion: "The new version starts from fresh data; the old stays in the home folder. Restart now?",
        download: "Download",
      },
    },
    "web.tree": {
      kind: { leaf: "Leaf", fruit: "Fruit", seed: "Seed" },
      stage: { "1": "sprout", "2": "seedling", "3": "young tree", "4": "big tree", "5": "old tree" },
      distilled: "Distilled from {n} experiences",
      noted: "This job noted {n} leaves",
      seeds: "Grew {n} seeds",
      grew: "Grew into {n} experiences",
      together: "Often recalled with {n} others",
      sown: '"{body}" was sown into the skill book (still pretend: it is really written once the server is hooked up)',
      sky: "The farm's sky of memories",
      skyHint: "Seeds in the middle, fruit and leaves further out, older the further; drag to turn",
      back: "Back under the tree",
      farm: "Back to the farm",
      earliest: "Earliest",
      past: "Look back: drag to a day and the tree grows back to how it was",
      now: "Now",
      day: "Day {n}",
      byHelper: "Only one helper's",
      allHelpers: "All helpers",
      byProject: "Only one project's",
      allProjects: "All projects",
      everyProject: "Every project",
      title: "The farm's memory tree",
      stats: "Day {days} · {rounds} rounds · recalled {recalls} times",
      nextStage: "{rounds} more rounds to a {stage}",
      grown: "Fully grown",
      experience: "An experience",
      fold: "Fold",
      intent: "Wanted",
      approach: "Did",
      insight: "Learned",
      recalled: "recalled {n} times",
      recent: "Newly grown",
      fading: "Leaves about to fall {n}",
      look: "Look",
      fadingNote: "The longest unrecalled fall first; fallen, they are forgotten.",
      waiting: "Crafts waiting to be sown",
      noSeeds: "No new crafts; when several experiences say the same thing, a seed is distilled.",
      sow: "Sow",
      lookUp: "Look up at the sky",
      from: "Distilled from",
      notedBy: "Noted by this job",
      grewInto: "Grew",
      grewTo: "Grew into",
      often: "Often recalled together",
      aboutToFall: " · about to fall",
      scene: "The memory tree: each leaf a note, each fruit an experience, the seeds under it crafts; looking up, the same memories as a sky",
    },
    "web.ui.pixel": {
      sound: {
        group: { ui: "Interface", tools: "Tools", field: "In the field", yard: "Yard", reward: "Rewards", voice: "Voice" },
        label: {
          tap: "Tap",
          nope: "Nope",
          pick: "Pick a tool",
          open: "Open",
          close: "Close",
          water: "Water",
          spray: "Spray",
          weed: "Weed",
          harvest: "Harvest",
          shovel: "Shovel",
          plant: "Sow",
          ripe: "Ripe",
          bug: "Bugs",
          coin: "Coin",
          levelUp: "Level up",
          achievement: "Achievement",
          arrive: "Helper arrives",
          rustle: "Rustling grass",
          splash: "Splash",
          thud: "Footstep",
          woof: "Puppy barks",
          meow: "Kitten meows",
          mew: "Kitten mews",
          purr: "Kitten purrs",
          yip: "Puppy jumps",
          pant: "Puppy pants",
          voiceOn: "Call connected",
          voiceOff: "Call ended",
          ring: "Ringing",
        },
      },
      close: "Close",
      optional: "  optional",
      drop: "Remove {chip}",
      noticeTitle: { info: "Notice", warn: "Not sent", error: "Something went wrong" },
    },
    "web.voice": {
      voice: {
        section: { label: "Voice" },
        noSettings: "The server's settings cannot be asked ({why}).",
        range: "{min} to {max}, default {fallback}",
        saved: "Saved: the next call uses it.",
        answer: {
          orchestrator:
            "The channel's manager itself takes the call: it sees how things are, sends work itself, and remembers what you said. Agora reaches one endpoint on this computer through a public address (voice.line.url in the configuration, such as Tailscale Funnel; cloudflared opened for the call when unset); only that endpoint is exposed, with a key per call.",
          agora: "A model hosted by Agora, no other key needed.",
          deepseek: "Uses the DeepSeek key in the settings ({from}).",
          noDeepseek: "Uses the DeepSeek key in the settings, which is not there yet: fill it in under Settings.",
          openai: "Any OpenAI-compatible endpoint: Qwen, Kimi, your own deployment…",
        },
        intro:
          "The manager hears you and answers through Agora's conversational AI. Here you set up the line: the credentials, how it listens and who answers can all be hosted by Agora (no other key), or your own services. The manager's persona, greeting and voice are on the",
        orchestratorPage: "manager page",
        period: ".",
        ready: "Can connect",
        missing: "Credentials missing",
        nextCall: "Changes take effect on the next call",
        credentials: "Credentials",
        console: "Agora console",
        hex: "32 hex characters",
        area: "Region",
        areaHint: "The region of Agora's endpoints: pick one near the server; projects in mainland China pick Mainland China.",
        listen: "Listen",
        listenParts: "Recognition · VAD",
        asr: "Recognition",
        microsoft: "Microsoft Azure speech, with your own key.",
        hosted: "Hosted by Agora, no other key needed.",
        language: "Language",
        languageHint: "Which language to hear. The persona should say to answer in it too.",
        deepgramModel: "Deepgram model",
        azureArea: "Azure region",
        azureAreaHint: "The region of the speech resource, such as eastasia or eastus.",
        asrArea: "Azure region for recognition",
        microsoftKey: "Microsoft speech key",
        think: "Think",
        who: "Who answers",
        model: "Model",
        deepseekModel: "DeepSeek's model name.",
        deepseekModelLabel: "DeepSeek model",
        address: "Address",
        llmAddress: "The full address of an OpenAI-compatible chat completions endpoint.",
        llmAddressLabel: "Model address",
        llmModel: "Model name",
        llmKey: "Endpoint key",
        speechServer: "Local speech-server",
        dictationIntro: "Sent to the OpenAI-compatible address you fill in; with a local speech-server, the sound stays on this computer.",
        dictationAddress: "Up to /v1. Local: http://127.0.0.1:8080/v1; OpenAI: https://api.openai.com/v1. Empty turns dictation off.",
        dictationAddressLabel: "Dictation address",
        dictationModel: "qwen3 for a local speech-server; gpt-4o-mini-transcribe for OpenAI.",
        dictationModelLabel: "Dictation model",
        dictationKey: "Credentials (may be empty locally)",
        persona: {
          intro: "How the manager opens a call and what voice it uses. The credentials, how it listens and who answers are on the",
          page: "page.",
          open: "Opening",
          openParts: "Persona · greeting",
          ownCall: "The manager takes the call itself: it is the channel's manager, with its own prompt and no separate persona.",
          persona: "Persona",
          personaHint:
            "Who the model that answers first on the call is, and how it speaks. It cannot see how things are; the manager on this computer sends work. Tell it not to make up progress.",
          greeting: "Greeting",
          greetingHint: "The first thing said when the call connects.",
          failure: "On a failure, say",
          failureHint: "What is said when the model fails.",
          speak: "Speak",
          tts: "Speech",
          ttsModel: "Speech model",
          voice: "Voice",
          openaiVoice: "An OpenAI tts-1 voice.",
          ttsArea: "Azure region for speech",
          azureVoice: "An Azure neural voice name, such as en-US-JennyNeural.",
          microsoftVoice: "Microsoft voice",
          minimaxVoice: "Click a name to pick it, the play button on its left to hear it first; or fill in another MiniMax system voice id below.",
          voiceId: "Voice id",
          sample: "Listen: {greeting}",
          noSample: "No sample",
          stop: "Stop {name}",
          play: "Listen to {name}",
        },
        moss: {
          console: "MOSS platform",
          verify: "Check that it connects",
          checking: "Connecting…",
          ok: "Connected",
          keyHint: "A key from the MOSS platform, used only by this machine's server",
        },
        dictationVia: "Dictation goes to",
        dictationOwn: "Your own address",
        dictationMossIntro: "The server hands recordings to MOSS, with the same key as MOSS Live.",
        dictationMossKey: "API key",
      },
      choices: {
        area: { US: "United States", EU: "Europe", AP: "Asia Pacific", CN: "Mainland China" },
        language: {
          "zh-CN": "Mandarin",
          "zh-HK": "Cantonese (Hong Kong)",
          "zh-TW": "Chinese (Taiwan)",
          "en-US": "English (US)",
          "ja-JP": "Japanese",
          "ko-KR": "Korean",
        },
        asr: { ares: "Agora ARES", microsoft: "Microsoft" },
        answer: { agora: "Agora hosted", openai: "Your own endpoint" },
        minimax: {
          gentle: "Gentle youth",
          qingse: "Shy youth",
          jingying: "Elite youth",
          badao: "Bossy youth",
          student: "College student",
          girl: "Young girl",
          yujie: "Poised woman",
          mature: "Mature woman",
          sweet: "Sweet woman",
          presenterMale: "Male presenter",
          presenterFemale: "Female presenter",
          audiobookMale: "Male audiobook",
          audiobookFemale: "Female audiobook",
        },
        number: { silenceMs: "Pause that ends a turn (ms)", interruptMs: "Speech that interrupts it (ms)", idleSeconds: "Leave when nobody is there (s)" },
      },
      dictation: {
        unset: "Dictation is not set up: fill in the address and the model under Dictation on the Voice page",
        recording: "Listening… click again to stop",
        transcribing: "Transcribing…",
        failed: "Last time it was not recognized: {why}",
        start: "Dictation: click to start speaking, again to stop",
        stop: "Stop dictation",
        label: "Dictation",
        noMic: "Cannot record: no microphone permission",
        cannot: "Cannot record: {why}",
        nothing: "Nothing was recorded",
      },
      call: {
        renew: "Renewing the token failed: {why}",
        noMic: "No microphone permission",
        cannotHear: "Agora: cannot hear the other side: {why}",
        agora: "Agora: {code} {msg}",
      },
      moss: {
        intro:
          "Talk to MOSS Live directly and hear how it answers; the line goes through this machine's server, and the key never leaves it. Nothing goes to the chat.",
        persona: "Persona (MOSS's own when empty)",
        personaHint: "E.g.: You are my steward; keep it short.",
        instructions: "Rules",
        defaultInstructions: "Answer briefly, in English.",
        talk: "Start talking",
        connecting: "Connecting…",
        hangUp: "Hang up",
        mute: "Mute",
        unmute: "Unmute",
        you: "You",
        said: "Conversation",
        nothingSaid: "Once connected, just talk; both sides' words show here.",
        events: "Messages on the line",
        eventsHint: "Actions sent and events received, as raw JSON; growing words and audio announcements are left out.",
        up: "out",
        down: "in",
        closed: "MOSS Live hung up",
        qos: {
          title: "Line quality",
          hint: "Worked out every second, for this call only.",
          reply: "Reply",
          ms: "{last} ms · mean {mean}",
          replyTip: "From the end of your words (as MOSS judged it) to its first sound arriving here; {n} turns so far. Red past 2.5 s.",
          up: "Up",
          upTip: "Sent in the last second: the microphone and the messages. 16 kHz audio is about 256 kbps.",
          down: "Down",
          downTip: "Received in the last second: the answer's audio and the events. 48 kHz audio is about 768 kbps while it speaks.",
          frames: "Mic frames",
          framesTip: "20 ms audio frames sent in the last second; 50 is right, fewer means recording or the page cannot keep up.",
          backlog: "Send backlog",
          backlogTip: "Bytes still waiting on this machine to go out; growing means the way up is too slow.",
          ahead: "Play buffer",
          aheadTip: "Answer audio received and not yet played, ms.",
          gaps: "Gaps",
          gapsTip: "Times, within one answer, a piece finished playing before the next arrived.",
          stopsTip: "Answers MOSS stopped itself; hover for the reasons (playback_timeout: playback was not reported in time).",
          stops: "Stopped",
        },
        tryIt: "Try it",
        notInChat: "Nothing goes to the chat",
      },
    },
  },
};

/** Every key, and the params its zh message names (undefined: none). */
export interface Messages {
  "desktop.cannotStart": undefined;
  "desktop.exited": { readonly code: string | number };
  "desktop.failed": { readonly why: string | number };
  "desktop.idle": undefined;
  "desktop.menu.about": { readonly app: string | number };
  "desktop.menu.close": undefined;
  "desktop.menu.copy": undefined;
  "desktop.menu.cut": undefined;
  "desktop.menu.devTools": undefined;
  "desktop.menu.edit": undefined;
  "desktop.menu.front": undefined;
  "desktop.menu.fullScreen": undefined;
  "desktop.menu.hide": { readonly app: string | number };
  "desktop.menu.hideOthers": undefined;
  "desktop.menu.minimize": undefined;
  "desktop.menu.paste": undefined;
  "desktop.menu.quit": { readonly app: string | number };
  "desktop.menu.redo": undefined;
  "desktop.menu.reload": undefined;
  "desktop.menu.resetZoom": undefined;
  "desktop.menu.selectAll": undefined;
  "desktop.menu.undo": undefined;
  "desktop.menu.unhide": undefined;
  "desktop.menu.view": undefined;
  "desktop.menu.window": undefined;
  "desktop.menu.zoom": undefined;
  "desktop.menu.zoomIn": undefined;
  "desktop.menu.zoomOut": undefined;
  "desktop.noAddress": { readonly seconds: string | number };
  "desktop.open": undefined;
  "desktop.quit": undefined;
  "desktop.seeLog": { readonly log: string | number; readonly reason: string | number };
  "desktop.waiting": { readonly n: string | number };
  "desktop.working": { readonly n: string | number };
  "mobile.agora": { readonly code: string | number; readonly what: string | number };
  "mobile.agoraLost": { readonly reason: string | number };
  "mobile.android": undefined;
  "mobile.answered": { readonly status: string | number };
  "mobile.ask": undefined;
  "mobile.callEnded": undefined;
  "mobile.cancel": undefined;
  "mobile.cannotForget": { readonly why: string | number };
  "mobile.cannotRead": { readonly why: string | number };
  "mobile.cannotRestore": { readonly why: string | number };
  "mobile.cannotSave": { readonly why: string | number };
  "mobile.intro": undefined;
  "mobile.name": undefined;
  "mobile.noCamera": undefined;
  "mobile.noMic": undefined;
  "mobile.noNotify": undefined;
  "mobile.paste": undefined;
  "mobile.phone": undefined;
  "mobile.scan": undefined;
  "mobile.step.initialize": undefined;
  "mobile.step.join": undefined;
  "mobile.step.mic": undefined;
  "mobile.step.mute": undefined;
  "mobile.step.renew": undefined;
  "mobile.step.unmute": undefined;
  "mobile.step.volume": undefined;
  "mobile.stopScan": undefined;
  "mobile.title": undefined;
  "mobile.unreachable": undefined;
  "mobile.waiting": undefined;
  "server.agent.defaultStaysOrchestrator": undefined;
  "server.agent.efforts": { readonly asked: string | number; readonly efforts: string | number; readonly runtime: string | number };
  "server.agent.effortsAnd": undefined;
  "server.agent.modelFailed": undefined;
  "server.agent.newAgentId": undefined;
  "server.agent.newSkillId": undefined;
  "server.agent.noAgent": { readonly id: string | number };
  "server.agent.noDeepSeekKey": undefined;
  "server.agent.noSkill": { readonly id: string | number };
  "server.agent.notSaved": { readonly file: string | number; readonly why: string | number };
  "server.agent.orchestratorRuntime": { readonly runtime: string | number };
  "server.agent.orchestratorStays": undefined;
  "server.agent.quoted": { readonly name: string | number };
  "server.agent.refused.launchArgs": undefined;
  "server.agent.refused.serviceTier": undefined;
  "server.agent.removeAgent": { readonly id: string | number; readonly name: string | number; readonly runtime: string | number };
  "server.agent.removeSkill": { readonly name: string | number };
  "server.agent.template.badId": { readonly file: string | number; readonly id: string | number };
  "server.agent.template.badVersion": { readonly file: string | number };
  "server.agent.template.builtIn": { readonly id: string | number };
  "server.agent.template.delete": { readonly name: string | number };
  "server.agent.template.deleteKept": { readonly installed: string | number; readonly name: string | number };
  "server.agent.template.gone": { readonly name: string | number; readonly template: string | number };
  "server.agent.template.noFile": { readonly file: string | number };
  "server.agent.template.noRuntime": { readonly file: string | number };
  "server.agent.template.noTemplate": { readonly id: string | number };
  "server.agent.template.notFrom": { readonly name: string | number };
  "server.agent.template.taken": { readonly id: string | number };
  "server.agent.template.unreadable": { readonly file: string | number; readonly why: string | number };
  "server.agent.unequip": { readonly holders: string | number };
  "server.archiveRef": { readonly name: string | number };
  "server.artifact.badBlockType": { readonly types: string | number };
  "server.artifact.badKind": { readonly kind: string | number; readonly kinds: string | number };
  "server.artifact.demo.0.heading": undefined;
  "server.artifact.demo.0.paragraphs.0": undefined;
  "server.artifact.demo.0.paragraphs.1": undefined;
  "server.artifact.demo.0.paragraphs.2": undefined;
  "server.artifact.demo.1.heading": undefined;
  "server.artifact.demo.1.paragraphs.0": undefined;
  "server.artifact.demo.1.paragraphs.1": undefined;
  "server.artifact.demo.1.paragraphs.2": undefined;
  "server.artifact.demo.2.heading": undefined;
  "server.artifact.demo.2.paragraphs.0": undefined;
  "server.artifact.demo.2.paragraphs.1": undefined;
  "server.artifact.demo.2.paragraphs.2": undefined;
  "server.artifact.demoNotInserted": { readonly status: string | number };
  "server.artifact.demoRunning": undefined;
  "server.artifact.empty": undefined;
  "server.artifact.longTitle": { readonly max: string | number };
  "server.artifact.made": { readonly title: string | number };
  "server.artifact.missing": { readonly id: string | number };
  "server.artifact.noBatch": undefined;
  "server.artifact.noFile": { readonly title: string | number; readonly version: string | number };
  "server.artifact.noTitle": undefined;
  "server.artifact.noVersion": { readonly latest: string | number; readonly title: string | number; readonly version: string | number };
  "server.artifact.noWriter": undefined;
  "server.artifact.notApplied": undefined;
  "server.artifact.notBlocks": { readonly title: string | number };
  "server.artifact.notHtml": { readonly title: string | number };
  "server.artifact.notKept": { readonly why: string | number };
  "server.artifact.op.badKey": { readonly key: string | number };
  "server.artifact.op.changed": undefined;
  "server.artifact.op.deleted": undefined;
  "server.artifact.op.intoSelf": undefined;
  "server.artifact.op.missing": undefined;
  "server.artifact.op.noAttr": { readonly name: string | number };
  "server.artifact.op.noBlock": { readonly id: string | number };
  "server.artifact.op.noId": undefined;
  "server.artifact.op.noRev": { readonly rev: string | number };
  "server.artifact.op.noText": undefined;
  "server.artifact.op.splitAtEnd": undefined;
  "server.artifact.op.splitOutside": { readonly at: string | number; readonly length: string | number };
  "server.artifact.op.taken": { readonly id: string | number };
  "server.artifact.op.underSelf": undefined;
  "server.artifact.op.unknownType": { readonly type: string | number };
  "server.artifact.otherArtifact": { readonly batch: string | number };
  "server.artifact.preview.cards": undefined;
  "server.artifact.preview.remove": { readonly n: string | number; readonly title: string | number };
  "server.artifact.preview.removeBlocks": { readonly n: string | number; readonly title: string | number };
  "server.artifact.tooBig": { readonly mb: string | number };
  "server.artifact.untitled": undefined;
  "server.artifact.versioned": { readonly title: string | number; readonly version: string | number };
  "server.artifact.withNote": { readonly note: string | number; readonly said: string | number };
  "server.base.homeTaken": { readonly home: string | number };
  "server.base.homeUnlocked": { readonly home: string | number };
  "server.base.noFile": { readonly path: string | number };
  "server.base.notPort": { readonly name: string | number; readonly path: string | number; readonly port: string | number };
  "server.base.prPoll": undefined;
  "server.base.requestKeyLong": { readonly max: string | number };
  "server.channel.absent": { readonly n: number; readonly who: string | number };
  "server.channel.badEmoji": undefined;
  "server.channel.badTarget": { readonly target: string | number };
  "server.channel.breaker": { readonly failed: string | number; readonly name: string | number };
  "server.channel.channelGone": undefined;
  "server.channel.channelName": undefined;
  "server.channel.channelTaken": { readonly name: string | number };
  "server.channel.connectorsThere": undefined;
  "server.channel.cronsThere": { readonly n: string | number };
  "server.channel.defaultIsChannel": undefined;
  "server.channel.defaultStays": undefined;
  "server.channel.deletes": {
    readonly name: string | number;
    readonly number: string | number;
    readonly target: string | number;
    readonly text: string | number;
  };
  "server.channel.deletesChannel": { readonly said: string | number; readonly target: string | number; readonly threads: string | number };
  "server.channel.deletesDeliveries": { readonly n: string | number };
  "server.channel.dispatch.draft": undefined;
  "server.channel.dispatch.handedOn": { readonly id: string | number; readonly name: string | number; readonly nth: number };
  "server.channel.dispatch.project": undefined;
  "server.channel.dispatch.redraft": { readonly id: string | number; readonly name: string | number };
  "server.channel.dispatch.sent": {
    readonly id: string | number;
    readonly name: string | number;
    readonly project: string | number;
    readonly what: string | number;
  };
  "server.channel.dispatch.split": { readonly graph: string | number };
  "server.channel.dispatch.step": { readonly graph: string | number; readonly task: string | number };
  "server.channel.empty": undefined;
  "server.channel.emptyFile": undefined;
  "server.channel.fileTooBig": { readonly mb: string | number };
  "server.channel.helpersThere": undefined;
  "server.channel.hopLimit": { readonly limit: string | number };
  "server.channel.inUse": { readonly why: string | number };
  "server.channel.issuesThere": { readonly n: string | number };
  "server.channel.mention.everyone": undefined;
  "server.channel.mention.orchestrator": undefined;
  "server.channel.mention.owner": undefined;
  "server.channel.messageGone": undefined;
  "server.channel.name.orchestrator": undefined;
  "server.channel.name.owner": undefined;
  "server.channel.noAttachment": { readonly id: string | number };
  "server.channel.noChannel": { readonly id: string | number };
  "server.channel.noChannelNamed": { readonly name: string | number; readonly tags: string | number };
  "server.channel.noDirect": { readonly target: string | number };
  "server.channel.noHelper": { readonly id: string | number };
  "server.channel.noMessage": { readonly n: string | number };
  "server.channel.noMessageId": { readonly id: string | number };
  "server.channel.notBack": undefined;
  "server.channel.notOrchestrator": { readonly id: string | number };
  "server.channel.notYours": undefined;
  "server.channel.queuedThere": { readonly n: string | number };
  "server.channel.sendKeyLong": undefined;
  "server.channel.threadOnlyInChannel": undefined;
  "server.channel.threadOnlyTitle": undefined;
  "server.cli.and": undefined;
  "server.cli.chat.compacted": { readonly archive: string | number };
  "server.cli.chat.direct": undefined;
  "server.cli.chat.error": { readonly why: string | number };
  "server.cli.chat.forgot": undefined;
  "server.cli.chat.hello": { readonly skills: string | number; readonly tools: string | number };
  "server.cli.chat.noRuntime": { readonly id: string | number };
  "server.cli.chat.notSent": { readonly why: string | number };
  "server.cli.chat.rejected": { readonly why: string | number };
  "server.cli.chat.resumed": undefined;
  "server.cli.chat.unknownInstall": { readonly id: string | number };
  "server.cli.chat.unusable": { readonly id: string | number; readonly kind: string | number };
  "server.cli.chat.usage": { readonly aborted: boolean; readonly cached: string | number; readonly input: string | number; readonly output: string | number };
  "server.cli.command.events": { readonly path: string | number };
  "server.cli.command.group": { readonly group: string | number };
  "server.cli.command.issueWork": undefined;
  "server.cli.command.root": undefined;
  "server.cli.command.runtimeChat": undefined;
  "server.cli.command.state": { readonly path: string | number };
  "server.cli.failure.body": { readonly op: string | number; readonly why: string | number };
  "server.cli.failure.dryRun": { readonly op: string | number };
  "server.cli.failure.file": { readonly file: string | number; readonly why: string | number };
  "server.cli.failure.gone": { readonly n: string | number };
  "server.cli.failure.missingArgument": { readonly name: string | number };
  "server.cli.failure.notJson": { readonly why: string | number };
  "server.cli.failure.retry": undefined;
  "server.cli.failure.shape": { readonly why: string | number };
  "server.cli.failure.stdin": { readonly why: string | number };
  "server.cli.failure.stream": { readonly why: string | number };
  "server.cli.failure.unreachable": { readonly base: string | number; readonly why: string | number };
  "server.cli.flag.cwd": undefined;
  "server.cli.flag.dryRun": undefined;
  "server.cli.flag.effort": undefined;
  "server.cli.flag.json": undefined;
  "server.cli.flag.mcp": undefined;
  "server.cli.flag.model": undefined;
  "server.cli.flag.name": undefined;
  "server.cli.flag.ownCwd": undefined;
  "server.cli.flag.ownModel": undefined;
  "server.cli.flag.prompt": undefined;
  "server.cli.flag.resume": undefined;
  "server.cli.flag.runtime": undefined;
  "server.cli.flag.server": { readonly fallback: string | number };
  "server.cli.flag.watch": undefined;
  "server.cli.next.help": undefined;
  "server.cli.next.startServer": undefined;
  "server.cli.next.whatItDoes": undefined;
  "server.connector.digest": { readonly lines: string | number; readonly n: string | number };
  "server.connector.disconnected": undefined;
  "server.connector.expired": undefined;
  "server.connector.feishu.denied": undefined;
  "server.connector.feishu.disconnected": { readonly why: string | number };
  "server.connector.feishu.incomplete": undefined;
  "server.connector.feishu.noId": undefined;
  "server.connector.feishu.noLink": undefined;
  "server.connector.feishu.noQr": undefined;
  "server.connector.feishu.qrExpired": undefined;
  "server.connector.feishu.register": { readonly why: string | number };
  "server.connector.feishu.registerTimeout": undefined;
  "server.connector.feishu.send": { readonly why: string | number };
  "server.connector.feishu.tooLong": undefined;
  "server.connector.line.dispatch": undefined;
  "server.connector.line.head": { readonly who: string | number };
  "server.connector.line.headWhat": { readonly what: string | number; readonly who: string | number };
  "server.connector.line.orchestrator": undefined;
  "server.connector.line.thread": undefined;
  "server.connector.media.attachment": undefined;
  "server.connector.media.audio": undefined;
  "server.connector.media.file": undefined;
  "server.connector.media.image": undefined;
  "server.connector.media.message": undefined;
  "server.connector.media.sticker": undefined;
  "server.connector.media.video": undefined;
  "server.connector.namedFile": { readonly name: string | number };
  "server.connector.noChannel": { readonly name: string | number };
  "server.connector.noConnector": { readonly id: string | number };
  "server.connector.paired": undefined;
  "server.connector.qq.auth": { readonly why: string | number };
  "server.connector.qq.authTimeout": undefined;
  "server.connector.qq.badKeys": undefined;
  "server.connector.qq.closed": { readonly code: string | number };
  "server.connector.qq.gateway": { readonly why: string | number };
  "server.connector.qq.gatewayError": undefined;
  "server.connector.qq.invalid": undefined;
  "server.connector.qq.noGateway": undefined;
  "server.connector.qq.noId": { readonly why: string | number };
  "server.connector.qq.reconnect": undefined;
  "server.connector.qq.send": { readonly why: string | number };
  "server.connector.qq.unread": { readonly why: string | number };
  "server.connector.qqKeys": undefined;
  "server.connector.staleLogin": undefined;
  "server.connector.stopped": undefined;
  "server.connector.switched": undefined;
  "server.connector.unreadSecrets": undefined;
  "server.connector.weixin.codeWrongTimes": undefined;
  "server.connector.weixin.incomplete": undefined;
  "server.connector.weixin.noQr": { readonly why: string | number };
  "server.connector.weixin.qrExpiredTimes": undefined;
  "server.connector.weixin.taken": undefined;
  "server.connector.weixin.tooLong": undefined;
  "server.cron.due": { readonly missed: boolean; readonly name: string | number; readonly text: string | number };
  "server.cron.expr.badField": { readonly field: string | number; readonly name: string | number };
  "server.cron.expr.fields.0": undefined;
  "server.cron.expr.fields.1": undefined;
  "server.cron.expr.fields.2": undefined;
  "server.cron.expr.fields.3": undefined;
  "server.cron.expr.fields.4": undefined;
  "server.cron.expr.fiveFields": undefined;
  "server.cron.expr.never": { readonly expr: string | number };
  "server.cron.next.done": undefined;
  "server.cron.next.never": undefined;
  "server.cron.next.off": undefined;
  "server.cron.next.pending": undefined;
  "server.cron.noChannel": { readonly name: string | number };
  "server.cron.noCron": { readonly id: string | number };
  "server.cron.noProfile": { readonly name: string | number };
  "server.cron.noProject": { readonly channel: string | number };
  "server.cron.problem.days": undefined;
  "server.cron.problem.every": { readonly min: string | number };
  "server.cron.problem.noName": undefined;
  "server.cron.problem.noText": undefined;
  "server.cron.problem.past": undefined;
  "server.cron.problem.time": { readonly time: string | number };
  "server.cron.problem.zone": { readonly tz: string | number };
  "server.cron.removeWhen": { readonly name: string | number; readonly when: string | number };
  "server.cron.weekdays.0": undefined;
  "server.cron.weekdays.1": undefined;
  "server.cron.weekdays.2": undefined;
  "server.cron.weekdays.3": undefined;
  "server.cron.weekdays.4": undefined;
  "server.cron.weekdays.5": undefined;
  "server.cron.weekdays.6": undefined;
  "server.cron.when.cron": { readonly expr: string | number };
  "server.cron.when.daily": { readonly time: string | number };
  "server.cron.when.hourly": { readonly minute: string | number };
  "server.cron.when.hours": { readonly n: number };
  "server.cron.when.minutes": { readonly n: string | number };
  "server.cron.when.monthly": { readonly day: string | number; readonly time: string | number };
  "server.cron.when.once": { readonly clock: string | number };
  "server.cron.when.weekdays": { readonly time: string | number };
  "server.cron.when.weekend": { readonly time: string | number };
  "server.cron.when.weekly": { readonly days: string | number; readonly time: string | number };
  "server.game.badge.bugs": undefined;
  "server.game.badge.rest": undefined;
  "server.game.badge.retrying": undefined;
  "server.game.badge.ripe": undefined;
  "server.game.badge.weeding": { readonly n: string | number };
  "server.game.reached.gold": undefined;
  "server.game.reached.secret": undefined;
  "server.game.reached.silver": undefined;
  "server.game.reached.starter": undefined;
  "server.game.reached.unlocked": undefined;
  "server.game.tier.gold": { readonly title: string | number };
  "server.game.tier.silver": { readonly title: string | number };
  "server.helperRef": { readonly id: string | number };
  "server.inbox.conflictFiles": { readonly files: number };
  "server.inbox.item.ask.label": undefined;
  "server.inbox.item.ask.title": { readonly who: string | number };
  "server.inbox.item.conflict.label": undefined;
  "server.inbox.item.conflict.title": { readonly who: string | number };
  "server.inbox.item.conflict.tray": { readonly who: string | number };
  "server.inbox.item.cron-ask.body": { readonly text: string | number };
  "server.inbox.item.cron-ask.label": undefined;
  "server.inbox.item.cron-ask.title": undefined;
  "server.inbox.item.cron-ask.tray": { readonly text: string | number };
  "server.inbox.item.fix.label": undefined;
  "server.inbox.item.fix.title": { readonly who: string | number };
  "server.inbox.item.fix.tray": { readonly who: string | number };
  "server.inbox.item.graph-draft.body": undefined;
  "server.inbox.item.graph-draft.label": undefined;
  "server.inbox.item.graph-draft.title": { readonly text: string | number };
  "server.inbox.item.graph-draft.tray": { readonly text: string | number };
  "server.inbox.item.graph-ready.body": undefined;
  "server.inbox.item.graph-ready.label": undefined;
  "server.inbox.item.graph-ready.title": { readonly text: string | number };
  "server.inbox.item.graph-ready.tray": { readonly text: string | number };
  "server.inbox.item.interrupted.title": { readonly who: string | number };
  "server.inbox.item.mention.label": undefined;
  "server.inbox.item.mention.title": { readonly who: string | number };
  "server.inbox.item.quiet.body": undefined;
  "server.inbox.item.quiet.label": undefined;
  "server.inbox.item.quiet.title": { readonly who: string | number };
  "server.inbox.item.quiet.tray": { readonly who: string | number };
  "server.inbox.item.review.label": undefined;
  "server.inbox.item.review.title": { readonly who: string | number };
  "server.inbox.item.review.tray": { readonly who: string | number };
  "server.inbox.item.task-failed.body": undefined;
  "server.inbox.item.task-failed.label": undefined;
  "server.inbox.item.task-failed.title": { readonly text: string | number };
  "server.inbox.item.task-failed.tray": { readonly text: string | number };
  "server.inbox.orchestrator": undefined;
  "server.inbox.step": { readonly graph: string | number; readonly step: string | number };
  "server.issue.brief.answer": { readonly conclusion: string | number };
  "server.issue.brief.answerUnread": { readonly problem: string | number };
  "server.issue.brief.closed": { readonly closed: string | number };
  "server.issue.brief.cure": { readonly brief: string | number };
  "server.issue.brief.cureHead": undefined;
  "server.issue.brief.cureTail": undefined;
  "server.issue.brief.end": undefined;
  "server.issue.brief.failedEnd": undefined;
  "server.issue.brief.failedHead": undefined;
  "server.issue.brief.handedOver": { readonly id: string | number; readonly name: string | number };
  "server.issue.brief.how": { readonly how: string | number };
  "server.issue.brief.lastRun": { readonly outcome: string | number; readonly summary: string | number };
  "server.issue.brief.original": { readonly brief: string | number };
  "server.issue.brief.previous": undefined;
  "server.issue.brief.reopenDefault": undefined;
  "server.issue.brief.reopened": { readonly id: string | number; readonly name: string | number };
  "server.issue.brief.resume": undefined;
  "server.issue.cannotDelete": { readonly n: string | number; readonly why: string | number };
  "server.issue.cannotMoveProject": { readonly n: string | number; readonly why: string | number };
  "server.issue.cannotSend": { readonly name: string | number; readonly why: string | number };
  "server.issue.closed": undefined;
  "server.issue.closedReopen": undefined;
  "server.issue.cronNoIssue": { readonly name: string | number; readonly why: string | number };
  "server.issue.cronNoStart": { readonly name: string | number; readonly why: string | number };
  "server.issue.disabled": { readonly name: string | number };
  "server.issue.does.cancel": { readonly n: string | number };
  "server.issue.does.cancelLeaves": { readonly helper: string | number };
  "server.issue.does.check": undefined;
  "server.issue.does.cleanWorktree": undefined;
  "server.issue.does.commitFirst": { readonly files: string | number; readonly helper: string | number };
  "server.issue.does.completeKept": { readonly commits: string | number; readonly n: string | number };
  "server.issue.does.completeNone": { readonly n: string | number };
  "server.issue.does.conflicts": { readonly base: string | number; readonly files: string | number };
  "server.issue.does.cure": { readonly helper: string | number };
  "server.issue.does.deleteIssue": { readonly n: string | number; readonly title: string | number };
  "server.issue.does.drafterLeaves": { readonly name: string | number };
  "server.issue.does.drop": { readonly n: string | number };
  "server.issue.does.helperLeaves": { readonly helper: string | number };
  "server.issue.does.leaves": { readonly helper: string | number };
  "server.issue.does.mainBranch": undefined;
  "server.issue.does.merge": { readonly base: string | number; readonly commits: string | number; readonly helper: string | number };
  "server.issue.does.noRoom": { readonly full: string | number };
  "server.issue.does.orchestratorRound": { readonly n: string | number; readonly said: string | number };
  "server.issue.does.pullRequest": { readonly commits: string | number };
  "server.issue.does.reject": { readonly findings: string | number; readonly helper: string | number; readonly n: string | number };
  "server.issue.does.reopen": { readonly n: string | number };
  "server.issue.does.reopenBy": { readonly n: string | number; readonly taker: string | number };
  "server.issue.does.resolve": { readonly helper: string | number };
  "server.issue.does.resume": { readonly helper: string | number; readonly words: string | number };
  "server.issue.does.revive": { readonly n: string | number };
  "server.issue.does.round": { readonly helper: string | number; readonly said: string | number };
  "server.issue.does.sendTo": { readonly agent: string | number; readonly n: string | number };
  "server.issue.does.start": { readonly agent: string | number; readonly n: string | number };
  "server.issue.does.startIn": { readonly agent: string | number; readonly n: string | number; readonly project: string | number };
  "server.issue.does.takesOver": { readonly taker: string | number };
  "server.issue.does.thisTime": { readonly said: string | number };
  "server.issue.does.toOrchestrator": { readonly n: string | number };
  "server.issue.does.unqueue": { readonly n: string | number };
  "server.issue.drafting": { readonly name: string | number };
  "server.issue.failNeedsFindings": undefined;
  "server.issue.graphAcceptance": undefined;
  "server.issue.graphRetry": undefined;
  "server.issue.handOverOnTodo": undefined;
  "server.issue.helper": undefined;
  "server.issue.helperRef": { readonly id: string | number };
  "server.issue.inGraph": undefined;
  "server.issue.issueNumbered": { readonly n: string | number };
  "server.issue.issueRef": { readonly ref: string | number };
  "server.issue.merge.merged": { readonly name: string | number; readonly text: string | number };
  "server.issue.merge.tellFailed": { readonly why: string | number };
  "server.issue.move.byHelpers": undefined;
  "server.issue.move.cannot": { readonly from: string | number; readonly to: string | number };
  "server.issue.move.drafting": { readonly name: string | number };
  "server.issue.move.failed": undefined;
  "server.issue.move.inGraph": undefined;
  "server.issue.move.moveTo": { readonly status: string | number };
  "server.issue.move.reopen": undefined;
  "server.issue.move.revive": undefined;
  "server.issue.move.roundWithText": { readonly command: string | number; readonly say: string | number; readonly to: string | number };
  "server.issue.move.same": undefined;
  "server.issue.move.sayWithText": { readonly command: string | number; readonly label: string | number };
  "server.issue.move.working": undefined;
  "server.issue.neverStarted": undefined;
  "server.issue.noAssignee": undefined;
  "server.issue.noConflict": { readonly name: string | number };
  "server.issue.noProfileNamed": { readonly key: string | number };
  "server.issue.noProject": undefined;
  "server.issue.noStatus": { readonly to: string | number };
  "server.issue.noTitle": undefined;
  "server.issue.notQueued": { readonly id: string | number };
  "server.issue.notRecorded": { readonly name: string | number; readonly why: string | number };
  "server.issue.notStarted": undefined;
  "server.issue.nothingToAccept": undefined;
  "server.issue.orchestratorAnswers": undefined;
  "server.issue.orchestratorNotHelper": undefined;
  "server.issue.pickHint": { readonly command: string | number };
  "server.issue.profileGone": { readonly id: string | number };
  "server.issue.projectRef": { readonly name: string | number };
  "server.issue.queued": { readonly full: string | number };
  "server.issue.queuedBack": { readonly title: string | number; readonly why: string | number };
  "server.issue.queuedStarted": { readonly session: string | number; readonly title: string | number };
  "server.issue.queuedStuck": { readonly title: string | number; readonly why: string | number };
  "server.issue.refinement.canceled": { readonly title: string | number; readonly why: string | number };
  "server.issue.refinement.drafting": { readonly name: string | number };
  "server.issue.refinement.files": undefined;
  "server.issue.refinement.lines": { readonly field: string | number };
  "server.issue.refinement.noBlock": undefined;
  "server.issue.refinement.noDrafter": undefined;
  "server.issue.refinement.noProject": undefined;
  "server.issue.refinement.noTitle": undefined;
  "server.issue.refinement.notDoing": undefined;
  "server.issue.refinement.notObject": undefined;
  "server.issue.refinement.onlyBacklog": undefined;
  "server.issue.refinement.orchestrator": undefined;
  "server.issue.refinement.text": { readonly field: string | number };
  "server.issue.refinement.todo": undefined;
  "server.issue.refinement.unfinished": { readonly name: string | number; readonly summary: string | number };
  "server.issue.refinement.unread": { readonly name: string | number; readonly problem: string | number };
  "server.issue.refinement.unreadable": { readonly why: string | number };
  "server.issue.refinement.why": undefined;
  "server.issue.roundNeedsWords": undefined;
  "server.issue.sendFailed": undefined;
  "server.issue.senderGone": { readonly id: string | number };
  "server.issue.started": undefined;
  "server.issue.stillOpen": undefined;
  "server.issue.stillWorking": { readonly name: string | number };
  "server.issue.stopFirst": { readonly n: string | number };
  "server.issue.talkTitle": { readonly name: string | number };
  "server.issue.template.commands.build": undefined;
  "server.issue.template.commands.lint": undefined;
  "server.issue.template.commands.test": undefined;
  "server.issue.template.done": { readonly done: string | number; readonly title: string | number };
  "server.issue.timeline.accepted": undefined;
  "server.issue.timeline.asked": { readonly questions: string | number };
  "server.issue.timeline.cron": { readonly missed: boolean };
  "server.issue.timeline.graph": undefined;
  "server.issue.timeline.opened": undefined;
  "server.issue.timeline.refine": undefined;
  "server.issue.timeline.refined": undefined;
  "server.issue.timeline.rejected": { readonly lines: string | number };
  "server.issue.timeline.rejectedSeparator": undefined;
  "server.issue.timeline.reported": undefined;
  "server.issue.timeline.restart": undefined;
  "server.issue.timeline.runtime": undefined;
  "server.issue.timeline.said": { readonly summary: string | number };
  "server.issue.timeline.start": undefined;
  "server.issue.timeline.told": undefined;
  "server.issue.workKept": { readonly n: string | number; readonly refused: string | number };
  "server.lan.aDevice": undefined;
  "server.lan.anotherAsking": undefined;
  "server.lan.badGateway": undefined;
  "server.lan.cannotOpen": { readonly why: string | number };
  "server.lan.closedThere": undefined;
  "server.lan.codeExpired": undefined;
  "server.lan.cut": { readonly n: string | number };
  "server.lan.denied": undefined;
  "server.lan.dropAsking": { readonly name: string | number };
  "server.lan.dropCode": { readonly code: string | number };
  "server.lan.forget": { readonly name: string | number };
  "server.lan.local": undefined;
  "server.lan.noAddress": undefined;
  "server.lan.noCode": undefined;
  "server.lan.noDevice": { readonly id: string | number };
  "server.lan.noneAsking": undefined;
  "server.lan.notOpen": undefined;
  "server.lan.notRemote": undefined;
  "server.lan.notUp": undefined;
  "server.lan.ownerLate": undefined;
  "server.lan.unpaired": undefined;
  "server.lan.wrongCode": undefined;
  "server.lookIn.agent": undefined;
  "server.lookIn.archive": undefined;
  "server.lookIn.artifact": undefined;
  "server.lookIn.channel": undefined;
  "server.lookIn.cron": undefined;
  "server.lookIn.device": undefined;
  "server.lookIn.graph": undefined;
  "server.lookIn.issue": undefined;
  "server.lookIn.memories": undefined;
  "server.lookIn.project": undefined;
  "server.lookIn.runtime": undefined;
  "server.lookIn.session": undefined;
  "server.lookIn.skill": undefined;
  "server.lookIn.template": undefined;
  "server.memory.coverage.everosAcross": undefined;
  "server.memory.coverage.everosAgent": undefined;
  "server.memory.coverage.failed": undefined;
  "server.memory.coverage.note": { readonly note: string | number; readonly source: string | number };
  "server.memory.coverage.unconfirmed": undefined;
  "server.memory.dbFailed": undefined;
  "server.memory.empty": undefined;
  "server.memory.everosForget": undefined;
  "server.memory.everosList": undefined;
  "server.memory.fileFailed": undefined;
  "server.memory.forget": { readonly agent: string | number; readonly text: string | number };
  "server.memory.forgetOrchestrator": { readonly text: string | number };
  "server.memory.forgetThere": { readonly source: string | number };
  "server.memory.noMemory": { readonly agent: string | number; readonly id: string | number };
  "server.memory.noUrl": undefined;
  "server.memory.nowledgeForget": undefined;
  "server.memory.off": undefined;
  "server.memory.orchestratorRecall": undefined;
  "server.memory.source.everos": undefined;
  "server.memory.source.local": undefined;
  "server.memory.source.nowledge": undefined;
  "server.memory.stopped": undefined;
  "server.memory.unknownSource": undefined;
  "server.orchestrator.cannotStart": { readonly why: string | number };
  "server.orchestrator.label": undefined;
  "server.orchestrator.noKey": undefined;
  "server.orchestrator.onlyDeepseek": { readonly configured: string | number };
  "server.project.badGithub": undefined;
  "server.project.badName": undefined;
  "server.project.branchLeft": { readonly branch: string | number; readonly why: string | number };
  "server.project.branchMoved": undefined;
  "server.project.check.exited": { readonly code: string | number };
  "server.project.check.failed": { readonly why: string | number };
  "server.project.check.timedOut": { readonly seconds: string | number };
  "server.project.clear.branchLeft": { readonly branch: string | number; readonly why: string | number };
  "server.project.clear.notWorktree": { readonly cwd: string | number };
  "server.project.clear.uncommitted": { readonly branch: string | number; readonly cwd: string | number };
  "server.project.clear.unconfirmed": { readonly branch: string | number; readonly why: string | number };
  "server.project.clear.unmerged": { readonly ahead: string | number; readonly branch: string | number };
  "server.project.clear.unmergedKept": { readonly branch: string | number };
  "server.project.clear.worktreeLeft": { readonly cwd: string | number; readonly why: string | number };
  "server.project.cloneFailed": undefined;
  "server.project.cloneFailedGh": undefined;
  "server.project.commit.initial": undefined;
  "server.project.commit.initialShort": undefined;
  "server.project.commit.leftOver": undefined;
  "server.project.commit.merge": { readonly branch: string | number };
  "server.project.conflict": { readonly base: string | number };
  "server.project.exists": { readonly name: string | number };
  "server.project.gh.failed": undefined;
  "server.project.gh.missing": undefined;
  "server.project.gh.noAccount": undefined;
  "server.project.gh.signedOut": undefined;
  "server.project.github.body": { readonly check: string | number; readonly conclusion: string | number; readonly n: string | number };
  "server.project.github.branchLeft": { readonly why: string | number };
  "server.project.github.checked": undefined;
  "server.project.github.createFailed": undefined;
  "server.project.github.listFailed": undefined;
  "server.project.github.listUnread": undefined;
  "server.project.github.noCheck": undefined;
  "server.project.github.noPermission": undefined;
  "server.project.github.notGithub": undefined;
  "server.project.github.pushFailed": undefined;
  "server.project.github.readOnly": undefined;
  "server.project.github.stateUnknown": { readonly n: string | number };
  "server.project.github.stateUnread": { readonly n: string | number };
  "server.project.github.unchecked": undefined;
  "server.project.github.urlUnread": undefined;
  "server.project.github.viewFailed": { readonly n: string | number };
  "server.project.github.worktreeLeft": { readonly why: string | number };
  "server.project.github.wrongBranch": undefined;
  "server.project.inProjectNoBranch": undefined;
  "server.project.inProjectNothing": undefined;
  "server.project.keptBoth": { readonly branch: string | number };
  "server.project.keptBranch": { readonly branch: string | number };
  "server.project.mainMoved": undefined;
  "server.project.mergeFailed": { readonly kept: string | number; readonly main: string | number; readonly why: string | number };
  "server.project.mergeStuck": {
    readonly abort: string | number;
    readonly kept: string | number;
    readonly main: string | number;
    readonly why: string | number;
  };
  "server.project.mergeTree": { readonly code: string | number };
  "server.project.merged": { readonly ahead: string | number; readonly main: string | number; readonly project: string | number };
  "server.project.mergedBranchLeft": { readonly branch: string | number; readonly why: string | number };
  "server.project.mergedWorktreeLeft": { readonly branch: string | number; readonly cwd: string | number; readonly why: string | number };
  "server.project.moreLines": { readonly n: string | number };
  "server.project.noBranchRead": { readonly branch: string | number; readonly why: string | number };
  "server.project.noName": undefined;
  "server.project.noTokei": undefined;
  "server.project.notChecked": undefined;
  "server.project.notProjectName": { readonly name: string | number };
  "server.project.nothingNew": undefined;
  "server.project.nothingNewInPlan": undefined;
  "server.project.outside": undefined;
  "server.project.tokeiFailed": { readonly why: string | number };
  "server.project.tokeiUnread": undefined;
  "server.projectRef": { readonly id: string | number };
  "server.runtime.balanceGone": { readonly provider: string | number };
  "server.runtime.budget": { readonly budget: string | number; readonly spent: string | number };
  "server.runtime.cannotDrive": { readonly runtime: string | number };
  "server.runtime.cannotSend": { readonly name: string | number; readonly why: string | number };
  "server.runtime.cursor": undefined;
  "server.runtime.date": { readonly day: string | number; readonly month: string | number; readonly time: string | number };
  "server.runtime.defaultModel": { readonly model: string | number; readonly name: string | number; readonly runtime: string | number };
  "server.runtime.disabled": undefined;
  "server.runtime.effort": { readonly effort: string | number; readonly levels: string | number; readonly model: string | number };
  "server.runtime.lessThanCent": undefined;
  "server.runtime.noModel": { readonly model: string | number; readonly runtime: string | number };
  "server.runtime.noUsage": undefined;
  "server.runtime.notInstalled": undefined;
  "server.runtime.notSaved": { readonly id: string | number; readonly why: string | number };
  "server.runtime.oarUnknown": undefined;
  "server.runtime.persona": { readonly refused: string | number };
  "server.runtime.piNoBalance": { readonly provider: string | number };
  "server.runtime.piNoModel": undefined;
  "server.runtime.piUnread": undefined;
  "server.runtime.quota.balance": { readonly balances: string | number; readonly provider: string | number };
  "server.runtime.quota.balanceLow": { readonly balances: string | number; readonly provider: string | number };
  "server.runtime.quota.noBalance": { readonly provider: string | number };
  "server.runtime.quota.none": undefined;
  "server.runtime.quota.signedOut": undefined;
  "server.runtime.quota.some": undefined;
  "server.runtime.quota.unread": { readonly why: string | number };
  "server.runtime.quota.window": { readonly label: string | number; readonly left: string | number };
  "server.runtime.quota.windowSeparator": undefined;
  "server.runtime.quotaGone": { readonly resets: string | number; readonly runtime: string | number; readonly window: string | number };
  "server.runtime.resets": { readonly when: string | number };
  "server.runtime.runtimeDefault": { readonly model: string | number; readonly runtime: string | number };
  "server.runtime.tools": { readonly n: number };
  "server.runtime.unknownRuntime": { readonly runtime: string | number };
  "server.session.answer.empty": undefined;
  "server.session.answer.lines": { readonly field: string | number };
  "server.session.answer.noBlock": undefined;
  "server.session.answer.noEvidence": undefined;
  "server.session.answer.notObject": undefined;
  "server.session.answer.unreadable": { readonly why: string | number };
  "server.session.conflictBrief": { readonly base: string | number; readonly files: string | number };
  "server.session.done": undefined;
  "server.session.failure.auth": undefined;
  "server.session.failure.billing": undefined;
  "server.session.failure.input_too_large": undefined;
  "server.session.failure.invalid_request": undefined;
  "server.session.failure.model_unavailable": undefined;
  "server.session.failure.overloaded": undefined;
  "server.session.failure.provider": undefined;
  "server.session.failure.quota": undefined;
  "server.session.failure.rate_limited": undefined;
  "server.session.failure.runtime_exited": undefined;
  "server.session.failure.unknown": undefined;
  "server.session.failureNext.later": undefined;
  "server.session.failureNext.now": undefined;
  "server.session.failureNext.userAction": undefined;
  "server.session.failureReason": { readonly reason: string | number };
  "server.session.failureStatus": { readonly status: string | number };
  "server.session.failureThen": { readonly next: string | number };
  "server.session.host.callerStart": { readonly why: string | number };
  "server.session.host.cannotStart": { readonly why: string | number };
  "server.session.host.failed": { readonly label: string | number; readonly why: string | number };
  "server.session.host.markNeedsWords": undefined;
  "server.session.host.noStep": { readonly label: string | number; readonly on: string | number };
  "server.session.host.notAsked": { readonly label: string | number; readonly on: string | number };
  "server.session.host.notInConversation": { readonly label: string | number; readonly on: string | number };
  "server.session.host.notRecorded": { readonly label: string | number; readonly why: string | number };
  "server.session.host.startFailed": { readonly label: string | number; readonly why: string | number };
  "server.session.host.stepHint": undefined;
  "server.session.host.stopped": { readonly label: string | number };
  "server.session.life.agentGone": { readonly name: string | number };
  "server.session.life.cannotSend": { readonly name: string | number; readonly why: string | number };
  "server.session.life.cannotWake": { readonly name: string | number; readonly why: string | number };
  "server.session.life.helperRef": { readonly id: string | number };
  "server.session.life.inGraph": { readonly graph: string | number; readonly name: string | number };
  "server.session.life.issueNotReturned": undefined;
  "server.session.life.left": { readonly name: string | number; readonly why: string | number };
  "server.session.life.minutes": { readonly n: string | number };
  "server.session.life.noHelper": { readonly id: string | number };
  "server.session.life.noPlace": { readonly name: string | number; readonly why: string | number };
  "server.session.life.noRecord": undefined;
  "server.session.life.noRoom": { readonly full: string | number; readonly name: string | number };
  "server.session.life.notBack": { readonly name: string | number; readonly why: string | number };
  "server.session.life.notReceived": { readonly name: string | number; readonly why: string | number };
  "server.session.life.notRecorded": { readonly name: string | number; readonly why: string | number };
  "server.session.life.notReset": { readonly name: string | number; readonly why: string | number };
  "server.session.life.notReturned": undefined;
  "server.session.life.notStopped": { readonly why: string | number };
  "server.session.life.placeGone": { readonly cwd: string | number };
  "server.session.life.queued": { readonly name: string | number };
  "server.session.life.quietNotice": { readonly last: string | number; readonly name: string | number; readonly span: string | number };
  "server.session.life.restartedNotice": { readonly name: string | number };
  "server.session.life.seconds": { readonly n: string | number };
  "server.session.life.started": { readonly name: string | number; readonly woke: boolean };
  "server.session.life.steered": { readonly name: string | number };
  "server.session.life.stillClosing": { readonly name: string | number };
  "server.session.life.stillHasHelper": undefined;
  "server.session.life.stillWorking": { readonly name: string | number };
  "server.session.life.stoppedNeedsYou": { readonly name: string | number; readonly why: string | number };
  "server.session.log.clipped": { readonly n: string | number };
  "server.session.log.exited": { readonly runtime: string | number };
  "server.session.log.exitedCode": { readonly code: string | number; readonly runtime: string | number };
  "server.session.log.exitedNotice": { readonly name: string | number; readonly why: string | number };
  "server.session.log.folded": { readonly usage: string | number };
  "server.session.log.image": undefined;
  "server.session.log.quiet": { readonly last: string | number; readonly span: string | number };
  "server.session.log.quietLast": { readonly label: string | number };
  "server.session.log.restarted": undefined;
  "server.session.log.retry": { readonly attempt: string | number };
  "server.session.log.retryIn": { readonly s: string | number };
  "server.session.log.retryOf": { readonly attempt: string | number; readonly of: string | number };
  "server.session.log.retryWhy": { readonly reason: string | number };
  "server.session.log.staleRun": undefined;
  "server.session.log.stopped": undefined;
  "server.session.log.stoppedByOwner": undefined;
  "server.session.noRoom.farm": { readonly max: string | number };
  "server.session.noRoom.project": { readonly max: string | number; readonly on: string | number; readonly project: string | number };
  "server.session.noRoom.runtime": { readonly max: string | number; readonly on: string | number; readonly runtime: string | number };
  "server.session.notTaken.checkFix": { readonly reason: string | number };
  "server.session.notTaken.checkShort": undefined;
  "server.session.notTaken.conflictNotice": { readonly base: string | number; readonly files: string | number; readonly name: string | number };
  "server.session.notTaken.conflictOwner": {
    readonly base: string | number;
    readonly brief: string | number;
    readonly files: string | number;
    readonly name: string | number;
  };
  "server.session.notTaken.conflictShort": { readonly base: string | number; readonly files: string | number };
  "server.session.notTaken.notice": { readonly name: string | number; readonly why: string | number };
  "server.session.notTaken.owner": { readonly name: string | number; readonly why: string | number };
  "server.session.unfinished": undefined;
  "server.session.usage.cached": {
    readonly missed: string | number;
    readonly output: string | number;
    readonly percent: string | number;
    readonly read: string | number;
  };
  "server.session.usage.changed": { readonly parts: string | number };
  "server.session.usage.parts.env": undefined;
  "server.session.usage.parts.instructions": undefined;
  "server.session.usage.parts.memory": undefined;
  "server.session.usage.parts.skills": undefined;
  "server.session.usage.parts.tools": undefined;
  "server.session.usage.unread": { readonly output: string | number };
  "server.setting.agoraCertificate": undefined;
  "server.setting.agoraId": undefined;
  "server.setting.deepseekKey": undefined;
  "server.setting.defaults.failureMessage": undefined;
  "server.setting.dictationModel": undefined;
  "server.setting.dictationUrl": undefined;
  "server.setting.memory.keySpace": undefined;
  "server.setting.memory.noUrl": undefined;
  "server.setting.memory.twice": { readonly kind: string | number };
  "server.setting.memory.unknown": { readonly kind: string | number };
  "server.setting.memory.url": undefined;
  "server.setting.notSaved": { readonly file: string | number; readonly why: string | number };
  "server.setting.voice.label.idleSeconds": undefined;
  "server.setting.voice.label.interruptMs": undefined;
  "server.setting.voice.label.silenceMs": undefined;
  "server.setting.voice.microsoft": undefined;
  "server.setting.voice.model": undefined;
  "server.setting.voice.persona": undefined;
  "server.setting.voice.range": { readonly label: string | number; readonly max: string | number; readonly min: string | number };
  "server.setting.voice.region": undefined;
  "server.setting.voice.url": undefined;
  "server.setting.voice.voiceId": undefined;
  "server.setting.voiceKeySpace": undefined;
  "server.task.act.abandoned": { readonly title: string | number };
  "server.task.act.abandonedKept": { readonly branch: string | number; readonly title: string | number };
  "server.task.act.abandonedNote": { readonly kept: string | number };
  "server.task.act.branchGone": { readonly title: string | number };
  "server.task.act.branchKeptNote": { readonly branch: string | number };
  "server.task.act.cannot": { readonly action: string | number; readonly state: string | number; readonly title: string | number };
  "server.task.act.conflict": { readonly base: string | number; readonly files: string | number };
  "server.task.act.edited": undefined;
  "server.task.act.finished": { readonly title: string | number };
  "server.task.act.graphIs": { readonly state: string | number };
  "server.task.act.mergeNotSaved": { readonly why: string | number };
  "server.task.act.merged": { readonly text: string | number; readonly title: string | number };
  "server.task.act.noGoal": undefined;
  "server.task.act.noProject": undefined;
  "server.task.act.noSplitter": undefined;
  "server.task.act.noStep": { readonly id: string | number };
  "server.task.act.notFailed": { readonly title: string | number };
  "server.task.act.notMerged": { readonly branch: string | number; readonly why: string | number };
  "server.task.act.notMergedNote": { readonly why: string | number };
  "server.task.act.notSent": undefined;
  "server.task.act.notStarted": { readonly title: string | number };
  "server.task.act.paused": { readonly title: string | number };
  "server.task.act.pausedNote": undefined;
  "server.task.act.plannerNotSent": { readonly why: string | number };
  "server.task.act.requeued": { readonly title: string | number };
  "server.task.act.resumed": { readonly title: string | number };
  "server.task.act.retried": { readonly name: string | number; readonly title: string | number };
  "server.task.act.skipped": { readonly title: string | number };
  "server.task.act.splittingBy": { readonly id: string | number; readonly name: string | number };
  "server.task.act.startNotSaved": { readonly branch: string | number; readonly why: string | number };
  "server.task.act.started": { readonly branch: string | number; readonly title: string | number };
  "server.task.act.stepAct": { readonly action: string | number; readonly title: string | number };
  "server.task.act.stepsWrong": { readonly problems: string | number };
  "server.task.act.working": { readonly title: string | number };
  "server.task.actor.orchestrator": undefined;
  "server.task.actor.owner": undefined;
  "server.task.actor.session": undefined;
  "server.task.actor.system": undefined;
  "server.task.edit.cannotRemove": { readonly state: string | number; readonly title: string | number };
  "server.task.edit.graphSettled": { readonly state: string | number };
  "server.task.edit.noStep": { readonly id: string | number };
  "server.task.edit.remove": { readonly graph: string | number; readonly step: string | number };
  "server.task.edit.stopWaiting": { readonly steps: string | number };
  "server.task.edit.taskSettled": { readonly state: string | number; readonly title: string | number };
  "server.task.event.abandoned": { readonly why: string | number };
  "server.task.event.by": { readonly session: string | number };
  "server.task.event.drafted": undefined;
  "server.task.event.draftedSteps": { readonly steps: string | number };
  "server.task.event.merged": undefined;
  "server.task.event.paused": { readonly why: string | number };
  "server.task.event.ready": undefined;
  "server.task.event.resumed": undefined;
  "server.task.event.splitting": { readonly why: string | number };
  "server.task.event.started": undefined;
  "server.task.event.startedOn": { readonly branch: string | number };
  "server.task.event.step": { readonly title: string | number };
  "server.task.event.taskAdded": { readonly step: string | number };
  "server.task.event.taskEdited": { readonly fields: string | number; readonly step: string | number };
  "server.task.event.taskFailed": { readonly step: string | number; readonly why: string | number };
  "server.task.event.taskMerged": { readonly step: string | number; readonly why: string | number };
  "server.task.event.taskMergedCommits": { readonly commits: string | number; readonly step: string | number; readonly why: string | number };
  "server.task.event.taskRemoved": { readonly title: string | number };
  "server.task.event.taskRequeued": { readonly step: string | number };
  "server.task.event.taskRetried": { readonly step: string | number };
  "server.task.event.taskSentBack": { readonly by: string | number; readonly step: string | number; readonly why: string | number };
  "server.task.event.taskSkipped": { readonly step: string | number };
  "server.task.event.taskStarted": { readonly by: string | number; readonly step: string | number };
  "server.task.event.why": { readonly detail: string | number };
  "server.task.field.agent": undefined;
  "server.task.field.brief": undefined;
  "server.task.field.check": undefined;
  "server.task.field.needs": undefined;
  "server.task.field.scope": undefined;
  "server.task.field.title": undefined;
  "server.task.graphAction.abandon": undefined;
  "server.task.graphAction.merge": undefined;
  "server.task.graphAction.pause": undefined;
  "server.task.graphAction.resume": undefined;
  "server.task.graphAction.start": undefined;
  "server.task.graphState.abandoned": undefined;
  "server.task.graphState.done": undefined;
  "server.task.graphState.draft": undefined;
  "server.task.graphState.paused": undefined;
  "server.task.graphState.ready": undefined;
  "server.task.graphState.running": undefined;
  "server.task.graphState.splitting": undefined;
  "server.task.graphTag.abandoned": undefined;
  "server.task.graphTag.done": undefined;
  "server.task.graphTag.draft": undefined;
  "server.task.graphTag.paused": undefined;
  "server.task.graphTag.ready": undefined;
  "server.task.graphTag.running": undefined;
  "server.task.graphTag.splitting": undefined;
  "server.task.noGraph": { readonly id: string | number };
  "server.task.notSaved": { readonly title: string | number; readonly why: string | number };
  "server.task.notice.acceptancePassed": { readonly check: string | number };
  "server.task.notice.checkFailed": { readonly check: string | number };
  "server.task.notice.done": undefined;
  "server.task.notice.drafted": { readonly steps: string | number; readonly title: string | number };
  "server.task.notice.frozenTouched": { readonly files: string | number };
  "server.task.notice.helperGone": undefined;
  "server.task.notice.noBranch": undefined;
  "server.task.notice.noGraph": { readonly problem: string | number };
  "server.task.notice.noHelper": undefined;
  "server.task.notice.notSplit": { readonly title: string | number; readonly why: string | number };
  "server.task.notice.plannerFailed": { readonly summary: string | number };
  "server.task.notice.plannerGone": undefined;
  "server.task.notice.ready": { readonly title: string | number };
  "server.task.notice.restarted": undefined;
  "server.task.notice.restartedSplitting": undefined;
  "server.task.notice.split": { readonly n: string | number; readonly name: string | number; readonly title: string | number };
  "server.task.notice.splitBy": { readonly name: string | number };
  "server.task.notice.splitNotSaved": { readonly branch: string | number; readonly why: string | number };
  "server.task.notice.splitStopped": undefined;
  "server.task.notice.stepNotSaved": { readonly title: string | number; readonly why: string | number };
  "server.task.notice.stepStopped": { readonly title: string | number };
  "server.task.notice.taskFailed": { readonly graph: string | number; readonly task: string | number; readonly why: string | number };
  "server.task.notice.unknownFiles": { readonly why: string | number };
  "server.task.notice.waits": { readonly title: string | number; readonly why: string | number };
  "server.task.parse.array": { readonly at: string | number };
  "server.task.parse.boolean": { readonly at: string | number };
  "server.task.parse.missing": { readonly at: string | number };
  "server.task.parse.noBlock": undefined;
  "server.task.parse.object": undefined;
  "server.task.parse.shape": { readonly why: string | number };
  "server.task.parse.stepObject": { readonly at: string | number };
  "server.task.parse.string": { readonly at: string | number };
  "server.task.parse.unreadable": { readonly why: string | number };
  "server.task.problem.badId": { readonly id: string | number };
  "server.task.problem.circle": { readonly ids: string | number };
  "server.task.problem.duplicate": { readonly id: string | number };
  "server.task.problem.empty": undefined;
  "server.task.problem.missing": { readonly id: string | number; readonly other: string | number };
  "server.task.problem.noBrief": { readonly id: string | number };
  "server.task.problem.noCheck": { readonly id: string | number };
  "server.task.problem.self": { readonly id: string | number };
  "server.task.problem.tooMany": { readonly max: string | number; readonly n: string | number };
  "server.task.taskAction.retry": undefined;
  "server.task.taskAction.skip": undefined;
  "server.task.taskState.failed": undefined;
  "server.task.taskState.merged": undefined;
  "server.task.taskState.skipped": undefined;
  "server.task.taskState.waiting": undefined;
  "server.task.taskState.working": undefined;
  "server.tool.about": { readonly about: string | number; readonly label: string | number };
  "server.tool.labels.artifact_block_create": undefined;
  "server.tool.labels.artifact_block_update": undefined;
  "server.tool.labels.channel_create": undefined;
  "server.tool.labels.channel_list": undefined;
  "server.tool.labels.channel_message_list": undefined;
  "server.tool.labels.channel_message_send": undefined;
  "server.tool.labels.channel_unread_list": undefined;
  "server.tool.labels.channel_update": undefined;
  "server.tool.labels.cron_create": undefined;
  "server.tool.labels.cron_delete": undefined;
  "server.tool.labels.cron_list": undefined;
  "server.tool.labels.graph_act": undefined;
  "server.tool.labels.graph_get": undefined;
  "server.tool.labels.graph_list": undefined;
  "server.tool.labels.graph_split": undefined;
  "server.tool.labels.graph_task_act": undefined;
  "server.tool.labels.graph_task_delete": undefined;
  "server.tool.labels.graph_task_update": undefined;
  "server.tool.labels.issue_comment_create": undefined;
  "server.tool.labels.issue_create": undefined;
  "server.tool.labels.issue_diff_get": undefined;
  "server.tool.labels.issue_get": undefined;
  "server.tool.labels.issue_list": undefined;
  "server.tool.labels.issue_review": undefined;
  "server.tool.labels.issue_split": undefined;
  "server.tool.labels.issue_status_update": undefined;
  "server.tool.labels.issue_update": undefined;
  "server.tool.labels.memory_create": undefined;
  "server.tool.labels.memory_search": undefined;
  "server.tool.labels.project_list": undefined;
  "server.tool.labels.remember": undefined;
  "server.tool.labels.rewrite_memory": undefined;
  "server.tool.labels.search_archive": undefined;
  "server.tool.labels.session_list": undefined;
  "server.tool.labels.session_stop": undefined;
  "server.voice.connecting": undefined;
  "server.voice.dictation.cut": { readonly why: string | number };
  "server.voice.dictation.empty": undefined;
  "server.voice.dictation.format": { readonly format: string | number };
  "server.voice.dictation.noMossKey": undefined;
  "server.voice.dictation.shape": undefined;
  "server.voice.dictation.status": { readonly detail: string | number; readonly status: string | number };
  "server.voice.dictation.tooLong": undefined;
  "server.voice.dictation.unreachable": { readonly why: string | number };
  "server.voice.dictation.unset": undefined;
  "server.voice.grantGone": undefined;
  "server.voice.hungUp": undefined;
  "server.voice.joinFailed": { readonly why: string | number };
  "server.voice.leaveFailed": { readonly why: string | number };
  "server.voice.lineClosed": undefined;
  "server.voice.lineDown": { readonly why: string | number };
  "server.voice.lineFailed": { readonly why: string | number };
  "server.voice.lineNotOpen": undefined;
  "server.voice.manyCalls": undefined;
  "server.voice.misheard": undefined;
  "server.voice.moss.failed": { readonly why: string | number };
  "server.voice.moss.noKey": undefined;
  "server.voice.moss.refused": { readonly why: string | number };
  "server.voice.moss.silent": undefined;
  "server.voice.moss.unreachable": { readonly why: string | number };
  "server.voice.noAgora": undefined;
  "server.voice.noAsrKey": undefined;
  "server.voice.noCall": undefined;
  "server.voice.noDeepseekKey": undefined;
  "server.voice.noLine": undefined;
  "server.voice.noLlmKey": undefined;
  "server.voice.noToken": { readonly why: string | number };
  "server.voice.noTtsKey": undefined;
  "server.voice.part.asr": undefined;
  "server.voice.part.llm": undefined;
  "server.voice.part.tts": undefined;
  "server.voice.stopped": undefined;
  "server.voice.tunnel.exited": undefined;
  "server.voice.tunnel.missing": undefined;
  "server.voice.tunnel.timedOut": undefined;
  "server.voice.unknown": { readonly vendor: string | number; readonly what: string | number };
  "server.voice.unknownSuffix": undefined;
  "server.voice.unusable": { readonly why: string | number };
  "shared.act.acknowledge": undefined;
  "shared.act.answer": undefined;
  "shared.act.close": undefined;
  "shared.act.complete": undefined;
  "shared.act.cure": undefined;
  "shared.act.reject": undefined;
  "shared.act.reopen": undefined;
  "shared.act.resolve": undefined;
  "shared.act.resume": undefined;
  "shared.act.start": undefined;
  "shared.act.stop": undefined;
  "shared.act.tell": undefined;
  "shared.action.edit_file": undefined;
  "shared.action.mcp": undefined;
  "shared.action.none": undefined;
  "shared.action.other": undefined;
  "shared.action.read_file": undefined;
  "shared.action.run_command": undefined;
  "shared.action.search": undefined;
  "shared.action.speaking_text": undefined;
  "shared.action.thinking": undefined;
  "shared.action.wait": undefined;
  "shared.action.web": undefined;
  "shared.attention.asking": undefined;
  "shared.attention.canceled": undefined;
  "shared.attention.done": undefined;
  "shared.attention.draft": undefined;
  "shared.attention.queued": undefined;
  "shared.attention.reviewing": undefined;
  "shared.attention.stuck": undefined;
  "shared.attention.working": undefined;
  "shared.canceled.dismissed": undefined;
  "shared.canceled.lost": undefined;
  "shared.canceledFor": { readonly why: string | number };
  "shared.deliverable.answer": undefined;
  "shared.deliverable.branch": undefined;
  "shared.deliverable.change": undefined;
  "shared.delivered.kept": undefined;
  "shared.delivered.merged": undefined;
  "shared.delivered.merged_into_parent": undefined;
  "shared.delivered.none": undefined;
  "shared.delivered.pull_request": undefined;
  "shared.doneWith": { readonly what: string | number };
  "shared.greeting": undefined;
  "shared.join.and": { readonly a: string | number; readonly b: string | number };
  "shared.join.aside": { readonly aside: string | number; readonly text: string | number };
  "shared.join.clauses": { readonly a: string | number; readonly b: string | number };
  "shared.join.labeled": { readonly label: string | number; readonly text: string | number };
  "shared.join.sentence": { readonly text: string | number };
  "shared.join.separator": undefined;
  "shared.minutes": { readonly n: string | number };
  "shared.order.invalid": undefined;
  "shared.order.unordered": { readonly a: string | number; readonly b: string | number };
  "shared.outcome.completed": undefined;
  "shared.outcome.failed": undefined;
  "shared.outcome.interrupted": undefined;
  "shared.phase.arriving": undefined;
  "shared.phase.conflict": { readonly base: string | number; readonly files: string | number };
  "shared.phase.done": { readonly conflict: string | number };
  "shared.phase.failed": undefined;
  "shared.phase.quiet": { readonly span: string | number; readonly what: string | number };
  "shared.phase.resting": { readonly conflict: string | number; readonly last: string | number };
  "shared.phase.retrying": { readonly attempt: string | number; readonly what: string | number };
  "shared.phase.retryingOf": { readonly attempt: string | number; readonly of: string | number; readonly what: string | number };
  "shared.phase.unfinished": undefined;
  "shared.phase.working": { readonly action: string | number };
  "shared.phase.workingOn": { readonly action: string | number; readonly label: string | number };
  "shared.priority.high": undefined;
  "shared.priority.low": undefined;
  "shared.priority.medium": undefined;
  "shared.priority.urgent": undefined;
  "shared.seconds": { readonly n: string | number };
  "shared.serverAnswered": { readonly status: string | number };
  "shared.status.backlog": undefined;
  "shared.status.canceled": undefined;
  "shared.status.done": undefined;
  "shared.status.in_progress": undefined;
  "shared.status.in_review": undefined;
  "shared.status.todo": undefined;
  "shared.stuck.conflict": undefined;
  "shared.stuck.failed": undefined;
  "shared.stuck.interrupted": undefined;
  "shared.stuck.quiet": undefined;
  "web.agent.add": undefined;
  "web.agent.all": undefined;
  "web.agent.available": undefined;
  "web.agent.backToAll": undefined;
  "web.agent.backToProfile": undefined;
  "web.agent.can": { readonly runtime: string | number };
  "web.agent.cannot": undefined;
  "web.agent.checking": undefined;
  "web.agent.colon": undefined;
  "web.agent.create": undefined;
  "web.agent.defaultEffort": undefined;
  "web.agent.disabled": undefined;
  "web.agent.disallowed": undefined;
  "web.agent.disallowedExample": undefined;
  "web.agent.disallowedHint": undefined;
  "web.agent.discard": undefined;
  "web.agent.duty": undefined;
  "web.agent.dutyTip": undefined;
  "web.agent.effort": undefined;
  "web.agent.effortDefault": undefined;
  "web.agent.enabled": undefined;
  "web.agent.enabledHint": undefined;
  "web.agent.env": undefined;
  "web.agent.envHint": undefined;
  "web.agent.fine": undefined;
  "web.agent.inProcess": undefined;
  "web.agent.isNew": undefined;
  "web.agent.library": undefined;
  "web.agent.libraryTip": undefined;
  "web.agent.list.disable": undefined;
  "web.agent.list.enable": undefined;
  "web.agent.list.helpers": undefined;
  "web.agent.list.here": { readonly n: string | number };
  "web.agent.list.hired": undefined;
  "web.agent.list.intro": undefined;
  "web.agent.list.ledger": undefined;
  "web.agent.list.make": undefined;
  "web.agent.list.makeOrchestrator": undefined;
  "web.agent.list.merged": undefined;
  "web.agent.list.orchestratorLine": undefined;
  "web.agent.list.orchestrators": undefined;
  "web.agent.list.tallyHint": undefined;
  "web.agent.list.title": undefined;
  "web.agent.list.toggle": { readonly act: string | number; readonly name: string | number };
  "web.agent.list.voice": undefined;
  "web.agent.loading": undefined;
  "web.agent.looksAs": undefined;
  "web.agent.looksHint": undefined;
  "web.agent.machine": undefined;
  "web.agent.machineTip": undefined;
  "web.agent.manageLibrary": undefined;
  "web.agent.mcp": undefined;
  "web.agent.mcpHint": undefined;
  "web.agent.mcpKind": undefined;
  "web.agent.mcpName": undefined;
  "web.agent.mcpTarget": undefined;
  "web.agent.model": undefined;
  "web.agent.modelLevels": { readonly n: string | number; readonly name: string | number };
  "web.agent.name": undefined;
  "web.agent.nameTaken": undefined;
  "web.agent.nameTip": undefined;
  "web.agent.newName": { readonly runtime: string | number };
  "web.agent.noEffort": undefined;
  "web.agent.noEffortModel": { readonly model: string | number };
  "web.agent.noModels": undefined;
  "web.agent.noProfiles": undefined;
  "web.agent.noRuntimes": { readonly why: string | number };
  "web.agent.noSteer": undefined;
  "web.agent.noSuch": undefined;
  "web.agent.none": undefined;
  "web.agent.notHere": undefined;
  "web.agent.orchestrator.dutyTip": undefined;
  "web.agent.orchestrator.intro": undefined;
  "web.agent.orchestrator.look": undefined;
  "web.agent.orchestrator.model": undefined;
  "web.agent.orchestrator.modelHint": undefined;
  "web.agent.orchestrator.modelTip": undefined;
  "web.agent.orchestrator.nameTip": undefined;
  "web.agent.orchestrator.newName": undefined;
  "web.agent.orchestrator.page": undefined;
  "web.agent.orchestrator.personaHint": undefined;
  "web.agent.orchestrator.personaTip": undefined;
  "web.agent.ownMcp": { readonly runtime: string | number };
  "web.agent.ownMcpTip": undefined;
  "web.agent.ownProcess": undefined;
  "web.agent.ownSkills": { readonly runtime: string | number };
  "web.agent.ownSkillsTip": undefined;
  "web.agent.persona.append.detail": undefined;
  "web.agent.persona.append.label": undefined;
  "web.agent.persona.prompt.detail": undefined;
  "web.agent.persona.prompt.label": undefined;
  "web.agent.persona.replace.detail": undefined;
  "web.agent.persona.replace.label": undefined;
  "web.agent.personaHint": undefined;
  "web.agent.personaLabel": undefined;
  "web.agent.personaMode": undefined;
  "web.agent.personaTip": undefined;
  "web.agent.problems": undefined;
  "web.agent.random": undefined;
  "web.agent.readingMachines": undefined;
  "web.agent.refuses": undefined;
  "web.agent.remove": undefined;
  "web.agent.removeNamed": { readonly name: string | number };
  "web.agent.removeWhich": { readonly name: string | number };
  "web.agent.role.helper": undefined;
  "web.agent.role.orchestrator": undefined;
  "web.agent.roleHint": undefined;
  "web.agent.runtimeDefault": undefined;
  "web.agent.runtimeDefaultModel": { readonly model: string | number };
  "web.agent.save": undefined;
  "web.agent.saved": undefined;
  "web.agent.saving": undefined;
  "web.agent.steer": undefined;
  "web.agent.tab.env": undefined;
  "web.agent.tab.memory": undefined;
  "web.agent.tab.persona": undefined;
  "web.agent.tab.runtime": undefined;
  "web.agent.tab.skills": undefined;
  "web.agent.tab.tools": undefined;
  "web.agent.tab.who": undefined;
  "web.agent.tabs": undefined;
  "web.agent.tags": undefined;
  "web.agent.tagsHint": undefined;
  "web.agent.tagsTip": undefined;
  "web.agent.talk": undefined;
  "web.agent.templates.add": undefined;
  "web.agent.templates.added": { readonly name: string | number };
  "web.agent.templates.addedHere": undefined;
  "web.agent.templates.fold": undefined;
  "web.agent.templates.folder": undefined;
  "web.agent.templates.folderHint": undefined;
  "web.agent.templates.from": { readonly name: string | number; readonly version: string | number };
  "web.agent.templates.install": undefined;
  "web.agent.templates.installed": { readonly n: string | number };
  "web.agent.templates.intro": undefined;
  "web.agent.templates.look": undefined;
  "web.agent.templates.noPersona": undefined;
  "web.agent.templates.none": undefined;
  "web.agent.templates.notHere": { readonly runtime: string | number };
  "web.agent.templates.onServer": undefined;
  "web.agent.templates.open": undefined;
  "web.agent.templates.openLine": undefined;
  "web.agent.templates.removeSure": undefined;
  "web.agent.templates.runsOn": { readonly runtime: string | number };
  "web.agent.templates.title": undefined;
  "web.agent.templates.update": { readonly version: string | number };
  "web.agent.templates.updateHint": undefined;
  "web.agent.templates.updated": undefined;
  "web.agent.trajectories": undefined;
  "web.agent.trajectoriesHint": undefined;
  "web.agent.unnamed": undefined;
  "web.agent.unnamedAgent": undefined;
  "web.agent.unreported": undefined;
  "web.agent.unsaved": undefined;
  "web.agent.wears": undefined;
  "web.agent.workdir": undefined;
  "web.agent.workdirHint": undefined;
  "web.agent.workdirTip": undefined;
  "web.agent.worktree": undefined;
  "web.agent.worktreeHint": undefined;
  "web.artifact.blocks.append": undefined;
  "web.artifact.blocks.block": { readonly id: string | number };
  "web.artifact.blocks.blocks": { readonly n: number };
  "web.artifact.blocks.changed": undefined;
  "web.artifact.blocks.conflict": { readonly why: string | number };
  "web.artifact.blocks.demo": undefined;
  "web.artifact.blocks.done": undefined;
  "web.artifact.blocks.heading": undefined;
  "web.artifact.blocks.helpersWriting": undefined;
  "web.artifact.blocks.image": { readonly alt: string | number; readonly src: string | number };
  "web.artifact.blocks.issue": { readonly id: string | number };
  "web.artifact.blocks.memoryItem": undefined;
  "web.artifact.blocks.notDone": undefined;
  "web.artifact.blocks.notSaved": { readonly why: string | number };
  "web.artifact.blocks.owner": undefined;
  "web.artifact.blocks.saved": undefined;
  "web.artifact.blocks.saving": undefined;
  "web.artifact.blocks.start": undefined;
  "web.artifact.blocks.unknown": { readonly type: string | number };
  "web.artifact.blocks.writing": { readonly who: string | number };
  "web.artifact.blocks.wrote": { readonly who: string | number };
  "web.artifact.body.blocks": undefined;
  "web.artifact.body.html": undefined;
  "web.artifact.card.open": { readonly title: string | number };
  "web.artifact.card.version": { readonly version: string | number };
  "web.artifact.issue.title": undefined;
  "web.artifact.page.all": undefined;
  "web.artifact.page.by": { readonly name: string | number };
  "web.artifact.page.copied": undefined;
  "web.artifact.page.copyLink": undefined;
  "web.artifact.page.delete": undefined;
  "web.artifact.page.deleteAsk": { readonly title: string | number };
  "web.artifact.page.deleted": { readonly title: string | number };
  "web.artifact.page.find": undefined;
  "web.artifact.page.forIssue": { readonly number: string | number };
  "web.artifact.page.frame": { readonly title: string | number; readonly version: string | number };
  "web.artifact.page.gone": undefined;
  "web.artifact.page.list": undefined;
  "web.artifact.page.more": undefined;
  "web.artifact.page.new": undefined;
  "web.artifact.page.none": undefined;
  "web.artifact.page.nothingFound": undefined;
  "web.artifact.page.open": undefined;
  "web.artifact.page.title": undefined;
  "web.artifact.page.untitled": undefined;
  "web.artifact.page.updated": { readonly when: string | number };
  "web.artifact.page.versions": undefined;
  "web.artifact.place.hint": undefined;
  "web.artifact.place.label": undefined;
  "web.artifact.talk.atMessage": undefined;
  "web.artifact.talk.reply": undefined;
  "web.artifact.talk.replyHint": undefined;
  "web.artifact.talk.replyVersion": undefined;
  "web.artifact.talk.send": undefined;
  "web.artifact.talk.sent": undefined;
  "web.artifact.talk.sentVersion": { readonly version: string | number };
  "web.base.big": { readonly n: string | number };
  "web.base.cast.outfit.farmer": undefined;
  "web.base.cast.outfit.gardener": undefined;
  "web.base.cast.outfit.rain": undefined;
  "web.base.cast.outfit.winter": undefined;
  "web.base.cast.pose.cheer": undefined;
  "web.base.cast.pose.idle": undefined;
  "web.base.cast.pose.think": undefined;
  "web.base.cast.pose.walk": undefined;
  "web.base.cast.pose.work": undefined;
  "web.base.cast.pose.worry": undefined;
  "web.base.cast.species.bear": undefined;
  "web.base.cast.species.cat": undefined;
  "web.base.cast.species.fox": undefined;
  "web.base.cast.species.hedgehog": undefined;
  "web.base.cast.species.owl": undefined;
  "web.base.cast.species.rabbit": undefined;
  "web.base.cast.species.raccoon": undefined;
  "web.base.chips.add": undefined;
  "web.base.chips.drop": { readonly v: string | number };
  "web.base.chips.name": undefined;
  "web.base.chips.remove": undefined;
  "web.base.chips.removeKey": { readonly k: string | number };
  "web.base.chips.value": undefined;
  "web.base.chips.valueHint": undefined;
  "web.base.chips.valueOf": { readonly k: string | number };
  "web.base.farm": undefined;
  "web.base.file.pdf": undefined;
  "web.base.file.remove": { readonly name: string | number };
  "web.base.form.asking": undefined;
  "web.base.form.example": { readonly value: string | number };
  "web.base.form.from.config": undefined;
  "web.base.form.from.settings": undefined;
  "web.base.form.fromOnly": { readonly from: string | number };
  "web.base.form.inUse": { readonly from: string | number; readonly hint: string | number };
  "web.base.form.keepEmpty": undefined;
  "web.base.form.keepKey": { readonly label: string | number };
  "web.base.form.never": undefined;
  "web.base.form.none": undefined;
  "web.base.form.remove": undefined;
  "web.base.form.removeKey": { readonly label: string | number };
  "web.base.form.removeOnSave": undefined;
  "web.base.form.reset": undefined;
  "web.base.form.save": undefined;
  "web.base.form.storedIn": { readonly file: string | number };
  "web.base.form.undo": undefined;
  "web.base.form.unreachable": { readonly why: string | number };
  "web.base.form.unset": undefined;
  "web.base.intent.offline": undefined;
  "web.base.intent.timedOut": undefined;
  "web.base.lightbox.close": undefined;
  "web.base.lightbox.label": undefined;
  "web.base.lightbox.next": undefined;
  "web.base.lightbox.original": undefined;
  "web.base.lightbox.prev": undefined;
  "web.base.link.connecting": undefined;
  "web.base.link.lost": undefined;
  "web.base.link.open": undefined;
  "web.base.money.about": { readonly yuan: string | number };
  "web.base.money.spent": { readonly yuan: string | number };
  "web.base.money.underCent": undefined;
  "web.base.off": undefined;
  "web.base.orchestrator": undefined;
  "web.base.owner": undefined;
  "web.base.place.agents.hint": undefined;
  "web.base.place.agents.label": undefined;
  "web.base.place.catalog.hint": undefined;
  "web.base.place.catalog.label": undefined;
  "web.base.place.chat.hint": undefined;
  "web.base.place.chat.label": undefined;
  "web.base.place.issues.hint": undefined;
  "web.base.place.issues.label": undefined;
  "web.base.place.projects.hint": undefined;
  "web.base.place.projects.label": undefined;
  "web.base.place.runtimes.hint": undefined;
  "web.base.place.runtimes.label": undefined;
  "web.base.place.settings.hint": undefined;
  "web.base.place.settings.label": undefined;
  "web.base.rail": undefined;
  "web.base.reading": undefined;
  "web.base.rich.copied": undefined;
  "web.base.rich.copy": undefined;
  "web.base.rich.diagram": undefined;
  "web.base.rich.diagramFailed": { readonly why: string | number };
  "web.base.rich.less": undefined;
  "web.base.rich.lines": { readonly n: string | number };
  "web.base.rich.longLess": undefined;
  "web.base.rich.longMore": undefined;
  "web.base.rich.more": undefined;
  "web.base.rich.taskDone": undefined;
  "web.base.rich.taskOpen": undefined;
  "web.base.runtime": { readonly name: string | number };
  "web.base.secret.hide": undefined;
  "web.base.secret.peek": undefined;
  "web.base.shortcuts.place.composer": undefined;
  "web.base.shortcuts.place.desktop": undefined;
  "web.base.shortcuts.place.everywhere": undefined;
  "web.base.shortcuts.place.farm": undefined;
  "web.base.shortcuts.place.lists": undefined;
  "web.base.shortcuts.place.pictures": undefined;
  "web.base.shortcuts.say.close": undefined;
  "web.base.shortcuts.say.command": undefined;
  "web.base.shortcuts.say.debug": undefined;
  "web.base.shortcuts.say.dropReply": undefined;
  "web.base.shortcuts.say.editLast": undefined;
  "web.base.shortcuts.say.farmMenu": undefined;
  "web.base.shortcuts.say.flip": undefined;
  "web.base.shortcuts.say.mention": undefined;
  "web.base.shortcuts.say.move": undefined;
  "web.base.shortcuts.say.names": undefined;
  "web.base.shortcuts.say.newline": undefined;
  "web.base.shortcuts.say.pick": undefined;
  "web.base.shortcuts.say.send": undefined;
  "web.base.shortcuts.say.sheet": undefined;
  "web.base.shortcuts.say.switcher": undefined;
  "web.base.shortcuts.say.tool": undefined;
  "web.base.shortcuts.say.voice": undefined;
  "web.base.shortcuts.title": undefined;
  "web.base.time.clock": { readonly am: boolean; readonly hh: string | number; readonly mm: string | number };
  "web.base.time.date": { readonly d: string | number; readonly m: string | number; readonly y: string | number };
  "web.base.time.day": { readonly d: string | number; readonly m: string | number; readonly weekday: string | number };
  "web.base.time.daysAgo": { readonly d: number };
  "web.base.time.hours": { readonly h: string | number; readonly m: string | number };
  "web.base.time.hoursAgo": { readonly h: number };
  "web.base.time.justNow": undefined;
  "web.base.time.minutes": { readonly m: string | number; readonly s: string | number };
  "web.base.time.minutesAgo": { readonly m: string | number };
  "web.base.time.month": { readonly month: string | number };
  "web.base.time.monthDay": { readonly day: string | number; readonly month: string | number };
  "web.base.time.monthsAgo": { readonly m: number };
  "web.base.time.round.days": { readonly d: number };
  "web.base.time.round.hours": { readonly h: number };
  "web.base.time.round.minutes": { readonly m: string | number };
  "web.base.time.round.underMinute": undefined;
  "web.base.time.seconds": { readonly s: string | number };
  "web.base.time.secondsAgo": { readonly s: string | number };
  "web.base.time.tenths": { readonly s: string | number };
  "web.base.time.today": undefined;
  "web.base.time.weekdays.0": undefined;
  "web.base.time.weekdays.1": undefined;
  "web.base.time.weekdays.2": undefined;
  "web.base.time.weekdays.3": undefined;
  "web.base.time.weekdays.4": undefined;
  "web.base.time.weekdays.5": undefined;
  "web.base.time.weekdays.6": undefined;
  "web.base.time.yearsAgo": { readonly y: string | number };
  "web.base.time.yesterday": undefined;
  "web.base.toasts": undefined;
  "web.base.unreachable": undefined;
  "web.base.updateReady": { readonly next: string | number };
  "web.base.working": { readonly n: string | number };
  "web.base.write": undefined;
  "web.catalog.all": undefined;
  "web.catalog.anchor": undefined;
  "web.catalog.background": undefined;
  "web.catalog.categories": undefined;
  "web.catalog.copied": undefined;
  "web.catalog.copy": undefined;
  "web.catalog.count": { readonly n: string | number };
  "web.catalog.cursors": { readonly n: string | number };
  "web.catalog.cursorsFind": undefined;
  "web.catalog.cursorsIntro": undefined;
  "web.catalog.cursorsNote": undefined;
  "web.catalog.find": undefined;
  "web.catalog.findHint": undefined;
  "web.catalog.fps": undefined;
  "web.catalog.frames": { readonly n: string | number };
  "web.catalog.from": undefined;
  "web.catalog.ground.check": undefined;
  "web.catalog.ground.grass": undefined;
  "web.catalog.ground.night": undefined;
  "web.catalog.head": undefined;
  "web.catalog.marks": undefined;
  "web.catalog.moves": undefined;
  "web.catalog.noCursors": undefined;
  "web.catalog.noMatch": undefined;
  "web.catalog.perSecond": { readonly n: string | number };
  "web.catalog.period": undefined;
  "web.catalog.pick": undefined;
  "web.catalog.pixels": { readonly h: string | number; readonly w: string | number };
  "web.catalog.play": undefined;
  "web.catalog.playSound": { readonly name: string | number };
  "web.catalog.recut": undefined;
  "web.catalog.redraw": undefined;
  "web.catalog.shelf.acts.hint": undefined;
  "web.catalog.shelf.acts.label": undefined;
  "web.catalog.shelf.dog.hint": undefined;
  "web.catalog.shelf.dog.label": undefined;
  "web.catalog.shelf.helpers.hint": undefined;
  "web.catalog.shelf.helpers.label": undefined;
  "web.catalog.shelf.icons.hint": undefined;
  "web.catalog.shelf.icons.label": undefined;
  "web.catalog.shelf.langs.hint": undefined;
  "web.catalog.shelf.langs.label": undefined;
  "web.catalog.shelf.logos.hint": undefined;
  "web.catalog.shelf.machines.hint": undefined;
  "web.catalog.shelf.machines.label": undefined;
  "web.catalog.shelf.map.hint": undefined;
  "web.catalog.shelf.map.label": undefined;
  "web.catalog.shelf.medals.hint": undefined;
  "web.catalog.shelf.medals.label": undefined;
  "web.catalog.shelf.orchestrator.hint": undefined;
  "web.catalog.shelf.other.hint": undefined;
  "web.catalog.shelf.other.label": undefined;
  "web.catalog.shelf.plots.hint": undefined;
  "web.catalog.shelf.plots.label": undefined;
  "web.catalog.shelf.ui.hint": undefined;
  "web.catalog.shelf.ui.label": undefined;
  "web.catalog.shelf.yard.hint": undefined;
  "web.catalog.shelf.yard.label": undefined;
  "web.catalog.shelves": undefined;
  "web.catalog.size": undefined;
  "web.catalog.soundsFind": undefined;
  "web.catalog.soundsIntro": undefined;
  "web.catalog.soundsMusic": undefined;
  "web.catalog.soundsRecipes": undefined;
  "web.catalog.stop": undefined;
  "web.catalog.tab.cursors": undefined;
  "web.catalog.tab.sounds": undefined;
  "web.catalog.tab.sprites": undefined;
  "web.catalog.unrecorded": undefined;
  "web.catalog.zoom": undefined;
  "web.channel.channels": undefined;
  "web.channel.channelsTitle": undefined;
  "web.channel.closeThread": undefined;
  "web.channel.commands.dm.name": undefined;
  "web.channel.commands.dm.needs": undefined;
  "web.channel.commands.dm.note": undefined;
  "web.channel.commands.done.issue": { readonly n: string | number };
  "web.channel.commands.done.remember": undefined;
  "web.channel.commands.done.stop": undefined;
  "web.channel.commands.issue.name": undefined;
  "web.channel.commands.issue.needs": undefined;
  "web.channel.commands.issue.note": undefined;
  "web.channel.commands.remember.name": undefined;
  "web.channel.commands.remember.needs": undefined;
  "web.channel.commands.remember.note": undefined;
  "web.channel.commands.stop.name": undefined;
  "web.channel.commands.stop.needs": undefined;
  "web.channel.commands.stop.note": undefined;
  "web.channel.composer.attach": undefined;
  "web.channel.composer.cancelReply": undefined;
  "web.channel.composer.mention": undefined;
  "web.channel.composer.notSent": { readonly why: string | number };
  "web.channel.composer.replying": { readonly name: string | number };
  "web.channel.composer.send": undefined;
  "web.channel.composer.sendHint": undefined;
  "web.channel.composer.stop": undefined;
  "web.channel.composer.stopHint": undefined;
  "web.channel.composer.uploadFailed": { readonly why: string | number };
  "web.channel.composer.who": undefined;
  "web.channel.crons.approve": undefined;
  "web.channel.crons.approveWhich": { readonly name: string | number };
  "web.channel.crons.byOrchestrator": undefined;
  "web.channel.crons.direct": { readonly agent: string | number };
  "web.channel.crons.empty": undefined;
  "web.channel.crons.label": { readonly name: string | number };
  "web.channel.crons.next": { readonly next: string | number };
  "web.channel.crons.off": undefined;
  "web.channel.crons.on": undefined;
  "web.channel.crons.refuse": undefined;
  "web.channel.crons.refuseWhich": { readonly name: string | number };
  "web.channel.crons.remove": undefined;
  "web.channel.crons.removeWhich": { readonly name: string | number };
  "web.channel.crons.sure": undefined;
  "web.channel.defaultHint": undefined;
  "web.channel.defaultProject": { readonly project: string | number };
  "web.channel.dialog.cancel": undefined;
  "web.channel.dialog.description": undefined;
  "web.channel.dialog.descriptionHint": undefined;
  "web.channel.dialog.name": undefined;
  "web.channel.dialog.nameExample": undefined;
  "web.channel.dialog.nameHint": undefined;
  "web.channel.dialog.project": undefined;
  "web.channel.dialog.projectExample": undefined;
  "web.channel.dialog.projectHint": undefined;
  "web.channel.dialog.projectNone": undefined;
  "web.channel.dialog.save": undefined;
  "web.channel.dialog.settingsOf": { readonly name: string | number };
  "web.channel.direct.add": undefined;
  "web.channel.direct.none": undefined;
  "web.channel.direct.open": { readonly name: string | number };
  "web.channel.direct.pick": undefined;
  "web.channel.directsTitle": undefined;
  "web.channel.emoji.groups.faces": undefined;
  "web.channel.emoji.groups.frequent": undefined;
  "web.channel.emoji.groups.hands": undefined;
  "web.channel.emoji.groups.nature": undefined;
  "web.channel.emoji.groups.signs": undefined;
  "web.channel.emoji.groups.things": undefined;
  "web.channel.emoji.more": undefined;
  "web.channel.emoji.open": undefined;
  "web.channel.empty": { readonly label: string | number };
  "web.channel.farmSearch.filters": undefined;
  "web.channel.farmSearch.hint": undefined;
  "web.channel.farmSearch.none": undefined;
  "web.channel.farmSearch.open": undefined;
  "web.channel.farmSearch.searching": undefined;
  "web.channel.farmSearch.title": undefined;
  "web.channel.find": undefined;
  "web.channel.findHint": undefined;
  "web.channel.findMessages": undefined;
  "web.channel.helpers": undefined;
  "web.channel.inChannel": undefined;
  "web.channel.issues.empty": undefined;
  "web.channel.issues.thread": undefined;
  "web.channel.manage.archive": undefined;
  "web.channel.manage.archiveHint": undefined;
  "web.channel.manage.archivedTitle": undefined;
  "web.channel.manage.category": undefined;
  "web.channel.manage.categoryHint": undefined;
  "web.channel.manage.drag": undefined;
  "web.channel.manage.mentionsOnly": undefined;
  "web.channel.manage.muted": undefined;
  "web.channel.manage.name": undefined;
  "web.channel.manage.notify": undefined;
  "web.channel.manage.notifyAll": undefined;
  "web.channel.manage.notifyHint": undefined;
  "web.channel.manage.notifyMentions": undefined;
  "web.channel.manage.notifyNone": undefined;
  "web.channel.manage.orchestrator": undefined;
  "web.channel.manage.orchestratorHint": undefined;
  "web.channel.manage.remove": undefined;
  "web.channel.manage.removeSure": undefined;
  "web.channel.manage.removeWill": undefined;
  "web.channel.manage.unarchive": undefined;
  "web.channel.media.drop": undefined;
  "web.channel.media.keep": { readonly name: string | number };
  "web.channel.media.pdf": undefined;
  "web.channel.media.preview": undefined;
  "web.channel.media.takeOff": { readonly name: string | number };
  "web.channel.media.uploadingFile": { readonly name: string | number; readonly percent: string | number };
  "web.channel.members.looksAfter": undefined;
  "web.channel.members.none": undefined;
  "web.channel.members.open": undefined;
  "web.channel.members.owner": undefined;
  "web.channel.members.title": undefined;
  "web.channel.messages.containing": { readonly text: string | number };
  "web.channel.messages.deleted": undefined;
  "web.channel.messages.dispatch": undefined;
  "web.channel.messages.dropSend": undefined;
  "web.channel.messages.edited": undefined;
  "web.channel.messages.file": { readonly size: string | number };
  "web.channel.messages.foldDispatch": undefined;
  "web.channel.messages.inThread": { readonly address: string | number };
  "web.channel.messages.label": undefined;
  "web.channel.messages.linked": { readonly number: string | number; readonly where: string | number };
  "web.channel.messages.newBelow": { readonly n: string | number };
  "web.channel.messages.newMessages": undefined;
  "web.channel.messages.notFound": undefined;
  "web.channel.messages.notSent": undefined;
  "web.channel.messages.older": undefined;
  "web.channel.messages.owner": undefined;
  "web.channel.messages.pinned": undefined;
  "web.channel.messages.reactedBy": { readonly emoji: string | number; readonly names: string | number };
  "web.channel.messages.replyGone": undefined;
  "web.channel.messages.retrySend": undefined;
  "web.channel.messages.roundFor": { readonly took: string | number; readonly what: string | number };
  "web.channel.messages.searching": undefined;
  "web.channel.messages.sending": undefined;
  "web.channel.messages.sentTo": { readonly who: string | number };
  "web.channel.messages.spent": { readonly spent: string | number };
  "web.channel.messages.start": undefined;
  "web.channel.messages.thinking": undefined;
  "web.channel.messages.toLatest": undefined;
  "web.channel.messages.typing": undefined;
  "web.channel.messages.unfoldDispatch": undefined;
  "web.channel.messages.unread": { readonly n: string | number };
  "web.channel.mood.idle": undefined;
  "web.channel.mood.listening": undefined;
  "web.channel.mood.speaking": undefined;
  "web.channel.mood.thinking": undefined;
  "web.channel.more.copied": undefined;
  "web.channel.more.copyLink": undefined;
  "web.channel.more.jump": undefined;
  "web.channel.more.label": undefined;
  "web.channel.more.markUnread": undefined;
  "web.channel.names.everyone": undefined;
  "web.channel.names.everyoneNote": undefined;
  "web.channel.names.issueThread": undefined;
  "web.channel.names.mention.everyone": undefined;
  "web.channel.names.mention.orchestrator": undefined;
  "web.channel.names.mention.owner": undefined;
  "web.channel.names.orchestratorNote": undefined;
  "web.channel.names.planThread": { readonly id: string | number };
  "web.channel.names.talkThread": { readonly who: string | number };
  "web.channel.names.thread": undefined;
  "web.channel.newChannel": undefined;
  "web.channel.noHelpers": undefined;
  "web.channel.nobodyOnIt": undefined;
  "web.channel.orchestrator": undefined;
  "web.channel.pins.none": undefined;
  "web.channel.pins.open": undefined;
  "web.channel.pins.title": undefined;
  "web.channel.replies": { readonly n: number };
  "web.channel.reply": undefined;
  "web.channel.sayInThread": { readonly name: string | number };
  "web.channel.sendTo": { readonly label: string | number };
  "web.channel.settings": undefined;
  "web.channel.side": undefined;
  "web.channel.switcher.direct": undefined;
  "web.channel.switcher.hint": undefined;
  "web.channel.switcher.keys": { readonly mac: boolean };
  "web.channel.switcher.newDirect": undefined;
  "web.channel.switcher.none": undefined;
  "web.channel.switcher.open": undefined;
  "web.channel.switcher.title": undefined;
  "web.channel.tab.chat": undefined;
  "web.channel.tab.crons": undefined;
  "web.channel.tab.issues": undefined;
  "web.channel.thread": undefined;
  "web.channel.threadEmpty": undefined;
  "web.channel.threadList.archive": { readonly title: string | number };
  "web.channel.threadList.archived": { readonly n: string | number };
  "web.channel.threadList.none": undefined;
  "web.channel.threadList.notify": undefined;
  "web.channel.threadList.rename": { readonly title: string | number };
  "web.channel.threadList.title": undefined;
  "web.channel.threadList.unarchive": { readonly title: string | number };
  "web.channel.threadWidth": undefined;
  "web.channel.tools.edit": undefined;
  "web.channel.tools.editHint": undefined;
  "web.channel.tools.label": undefined;
  "web.channel.tools.pick": undefined;
  "web.channel.tools.pin": undefined;
  "web.channel.tools.react": undefined;
  "web.channel.tools.remove": undefined;
  "web.channel.tools.reply": undefined;
  "web.channel.tools.sure": undefined;
  "web.channel.tools.thread": undefined;
  "web.channel.tools.unpin": undefined;
  "web.connector.connectors.always": undefined;
  "web.connector.connectors.cannotScan": undefined;
  "web.connector.connectors.channel": undefined;
  "web.connector.connectors.connectQq": undefined;
  "web.connector.connectors.digits": undefined;
  "web.connector.connectors.disconnect": undefined;
  "web.connector.connectors.feishuIntro": undefined;
  "web.connector.connectors.gettingQr": undefined;
  "web.connector.connectors.how.feishu": undefined;
  "web.connector.connectors.how.qq": undefined;
  "web.connector.connectors.how.weixin": undefined;
  "web.connector.connectors.intro": undefined;
  "web.connector.connectors.know": undefined;
  "web.connector.connectors.label.feishu": undefined;
  "web.connector.connectors.label.weixin": undefined;
  "web.connector.connectors.lastInbound": undefined;
  "web.connector.connectors.list": undefined;
  "web.connector.connectors.newCode": undefined;
  "web.connector.connectors.noPending": undefined;
  "web.connector.connectors.notes.feishu.0": undefined;
  "web.connector.connectors.notes.feishu.1": undefined;
  "web.connector.connectors.notes.feishu.2": undefined;
  "web.connector.connectors.notes.qq.0": undefined;
  "web.connector.connectors.notes.qq.1": undefined;
  "web.connector.connectors.notes.qq.2": undefined;
  "web.connector.connectors.notes.weixin.0": undefined;
  "web.connector.connectors.notes.weixin.1": undefined;
  "web.connector.connectors.notes.weixin.2": undefined;
  "web.connector.connectors.ok": undefined;
  "web.connector.connectors.owner": undefined;
  "web.connector.connectors.pairing": { readonly app: string | number };
  "web.connector.connectors.pairingNote": undefined;
  "web.connector.connectors.paused": { readonly clock: string | number };
  "web.connector.connectors.pending": undefined;
  "web.connector.connectors.pendingCount": { readonly n: string | number };
  "web.connector.connectors.phoneDigits": undefined;
  "web.connector.connectors.qqAfter": undefined;
  "web.connector.connectors.qqBefore": undefined;
  "web.connector.connectors.qqPlatform": undefined;
  "web.connector.connectors.qr": { readonly app: string | number };
  "web.connector.connectors.scan": { readonly app: string | number };
  "web.connector.connectors.scanWith": { readonly app: string | number };
  "web.connector.connectors.scanned": undefined;
  "web.connector.connectors.secret": undefined;
  "web.connector.connectors.secretHint": undefined;
  "web.connector.connectors.section.label": undefined;
  "web.connector.connectors.since": undefined;
  "web.connector.connectors.state.connected": undefined;
  "web.connector.connectors.state.off": undefined;
  "web.connector.connectors.state.pairing": undefined;
  "web.connector.connectors.state.paused": undefined;
  "web.connector.connectors.state.scanned": undefined;
  "web.connector.connectors.state.verify": undefined;
  "web.connector.connectors.state.waiting": undefined;
  "web.connector.connectors.weixinIntro": undefined;
  "web.connector.connectors.whichChannel": undefined;
  "web.farm.achievements.category.craft": undefined;
  "web.farm.achievements.category.harvest": undefined;
  "web.farm.achievements.category.secret": undefined;
  "web.farm.achievements.category.starter": undefined;
  "web.farm.achievements.category.team": undefined;
  "web.farm.achievements.category.thrift": undefined;
  "web.farm.achievements.clearAt": { readonly level: string | number };
  "web.farm.achievements.clearing": undefined;
  "web.farm.achievements.coinsOnMerge": undefined;
  "web.farm.achievements.day": { readonly day: string | number; readonly month: string | number };
  "web.farm.achievements.done": undefined;
  "web.farm.achievements.earnFirst": undefined;
  "web.farm.achievements.earned": { readonly day: string | number };
  "web.farm.achievements.earnedTier": { readonly day: string | number; readonly tier: string | number };
  "web.farm.achievements.none": undefined;
  "web.farm.achievements.perStarter": { readonly coins: string | number };
  "web.farm.achievements.pick": undefined;
  "web.farm.achievements.secrets": { readonly n: string | number };
  "web.farm.achievements.secretsLine": undefined;
  "web.farm.achievements.starter": { readonly done: string | number; readonly of: string | number };
  "web.farm.achievements.starterDone": undefined;
  "web.farm.achievements.streak": { readonly multiplier: string | number; readonly n: string | number };
  "web.farm.achievements.tier.1": undefined;
  "web.farm.achievements.tier.2": undefined;
  "web.farm.achievements.tier.3": undefined;
  "web.farm.achievements.tiers": { readonly of: string | number; readonly tier: string | number };
  "web.farm.achievements.title": undefined;
  "web.farm.achievements.titles": undefined;
  "web.farm.achievements.toLevel": { readonly left: string | number; readonly total: string | number };
  "web.farm.achievements.toNext": undefined;
  "web.farm.achievements.toTier": { readonly tier: string | number };
  "web.farm.achievements.worn": undefined;
  "web.farm.aim.bug": undefined;
  "web.farm.aim.clearAt": { readonly level: string | number };
  "web.farm.aim.flowerbed": undefined;
  "web.farm.aim.harvestLook": undefined;
  "web.farm.aim.harvestRipe": undefined;
  "web.farm.aim.look": undefined;
  "web.farm.aim.noBugs": undefined;
  "web.farm.aim.noShovel": undefined;
  "web.farm.aim.noWeeds": undefined;
  "web.farm.aim.nothingToHarvest": undefined;
  "web.farm.aim.nothingYet": undefined;
  "web.farm.aim.shovelDismiss": undefined;
  "web.farm.aim.shovelStop": undefined;
  "web.farm.aim.sow": undefined;
  "web.farm.aim.unavailable": { readonly state: string | number };
  "web.farm.aim.unread": undefined;
  "web.farm.aim.water": { readonly name: string | number };
  "web.farm.aim.weeds": undefined;
  "web.farm.binary": undefined;
  "web.farm.canvas.entering": undefined;
  "web.farm.canvas.label": undefined;
  "web.farm.canvas.lights": undefined;
  "web.farm.canvas.map": undefined;
  "web.farm.canvas.moving": { readonly done: string | number; readonly total: string | number };
  "web.farm.canvas.noMap": { readonly why: string | number };
  "web.farm.chat.actions.cancelReply": undefined;
  "web.farm.chat.actions.copied": undefined;
  "web.farm.chat.actions.copyLink": undefined;
  "web.farm.chat.actions.edit": undefined;
  "web.farm.chat.actions.editHint": undefined;
  "web.farm.chat.actions.moreEmoji": undefined;
  "web.farm.chat.actions.open": undefined;
  "web.farm.chat.actions.react": undefined;
  "web.farm.chat.actions.remove": undefined;
  "web.farm.chat.actions.reply": undefined;
  "web.farm.chat.actions.sure": undefined;
  "web.farm.chat.anyone": undefined;
  "web.farm.chat.back": { readonly channel: string | number };
  "web.farm.chat.back2": undefined;
  "web.farm.chat.captions": undefined;
  "web.farm.chat.channel": { readonly channel: string | number };
  "web.farm.chat.channels": undefined;
  "web.farm.chat.deleted": undefined;
  "web.farm.chat.description": undefined;
  "web.farm.chat.descriptionHint": undefined;
  "web.farm.chat.directs": undefined;
  "web.farm.chat.dispatch": undefined;
  "web.farm.chat.done": undefined;
  "web.farm.chat.dropSend": undefined;
  "web.farm.chat.edited": undefined;
  "web.farm.chat.enlarge": undefined;
  "web.farm.chat.fold": undefined;
  "web.farm.chat.foldDispatch": undefined;
  "web.farm.chat.gotIt": undefined;
  "web.farm.chat.greeting": undefined;
  "web.farm.chat.inThread": { readonly name: string | number };
  "web.farm.chat.inThreadAnyone": undefined;
  "web.farm.chat.label": undefined;
  "web.farm.chat.less": undefined;
  "web.farm.chat.more": undefined;
  "web.farm.chat.name": undefined;
  "web.farm.chat.nameHint": undefined;
  "web.farm.chat.newChannel": undefined;
  "web.farm.chat.newChannelLine": undefined;
  "web.farm.chat.newCount": { readonly n: string | number };
  "web.farm.chat.newIn": { readonly n: string | number };
  "web.farm.chat.newInChannel": { readonly channel: string | number };
  "web.farm.chat.newInThread": undefined;
  "web.farm.chat.noVoice": { readonly why: string | number };
  "web.farm.chat.nobodyOnIt": undefined;
  "web.farm.chat.notSent": { readonly why: string | number };
  "web.farm.chat.notSentLine": undefined;
  "web.farm.chat.older": undefined;
  "web.farm.chat.open": undefined;
  "web.farm.chat.pageAndSchedules": undefined;
  "web.farm.chat.phase.connecting": undefined;
  "web.farm.chat.phase.error": undefined;
  "web.farm.chat.phase.listening": undefined;
  "web.farm.chat.phase.off": undefined;
  "web.farm.chat.phase.speaking": undefined;
  "web.farm.chat.phase.thinking": undefined;
  "web.farm.chat.project": undefined;
  "web.farm.chat.projectHint": undefined;
  "web.farm.chat.projectNone": undefined;
  "web.farm.chat.projectTag": { readonly project: string | number };
  "web.farm.chat.replies": { readonly n: number };
  "web.farm.chat.replyTo": { readonly name: string | number };
  "web.farm.chat.replyToText": { readonly name: string | number; readonly text: string | number };
  "web.farm.chat.restore": undefined;
  "web.farm.chat.retrySend": undefined;
  "web.farm.chat.save": undefined;
  "web.farm.chat.send": undefined;
  "web.farm.chat.sendTo": { readonly name: string | number };
  "web.farm.chat.sending": undefined;
  "web.farm.chat.settings": undefined;
  "web.farm.chat.settingsLink": undefined;
  "web.farm.chat.settingsOf": { readonly channel: string | number };
  "web.farm.chat.speaking": undefined;
  "web.farm.chat.spent": { readonly spent: string | number };
  "web.farm.chat.stop": undefined;
  "web.farm.chat.stopHint": undefined;
  "web.farm.chat.suggestions.0": undefined;
  "web.farm.chat.suggestions.1": undefined;
  "web.farm.chat.suggestions.2": undefined;
  "web.farm.chat.suggestions.3": undefined;
  "web.farm.chat.thread": undefined;
  "web.farm.chat.threadEmpty": undefined;
  "web.farm.chat.toOrchestrator": undefined;
  "web.farm.chat.toOrchestratorAlone": undefined;
  "web.farm.chat.unfoldDispatch": undefined;
  "web.farm.chat.what": undefined;
  "web.farm.chat.who": undefined;
  "web.farm.command.cannot": { readonly act: string | number };
  "web.farm.command.changed": undefined;
  "web.farm.command.noShovel": undefined;
  "web.farm.command.stored": undefined;
  "web.farm.conflictTag": undefined;
  "web.farm.crop.dry": undefined;
  "web.farm.crop.empty": undefined;
  "web.farm.crop.flowering": undefined;
  "web.farm.crop.harvested": undefined;
  "web.farm.crop.leafy": undefined;
  "web.farm.crop.locked": undefined;
  "web.farm.crop.seeded": undefined;
  "web.farm.crop.sprout": undefined;
  "web.farm.crop.weeds": undefined;
  "web.farm.crop.wheat": undefined;
  "web.farm.crop.withered": undefined;
  "web.farm.debug.achievement": undefined;
  "web.farm.debug.all": undefined;
  "web.farm.debug.call": undefined;
  "web.farm.debug.clear": undefined;
  "web.farm.debug.close": undefined;
  "web.farm.debug.copy": undefined;
  "web.farm.debug.dismiss": undefined;
  "web.farm.debug.dismissAll": undefined;
  "web.farm.debug.frames": { readonly n: string | number };
  "web.farm.debug.halt": undefined;
  "web.farm.debug.haltAll": undefined;
  "web.farm.debug.helpers": { readonly n: string | number };
  "web.farm.debug.levelUp": undefined;
  "web.farm.debug.nobody": undefined;
  "web.farm.debug.open": undefined;
  "web.farm.debug.pause": undefined;
  "web.farm.debug.progress": undefined;
  "web.farm.debug.resume": undefined;
  "web.farm.debug.sky": undefined;
  "web.farm.debug.stop": undefined;
  "web.farm.debug.time": undefined;
  "web.farm.debug.title": undefined;
  "web.farm.friends.disabled": undefined;
  "web.farm.friends.energy": { readonly short: string | number };
  "web.farm.friends.helpers": undefined;
  "web.farm.friends.pick": undefined;
  "web.farm.friends.profile": undefined;
  "web.farm.friends.status.away": undefined;
  "web.farm.friends.status.bug": undefined;
  "web.farm.friends.status.busy": undefined;
  "web.farm.friends.status.rest": undefined;
  "web.farm.friends.status.ripe": undefined;
  "web.farm.friends.tally": { readonly harvested: string | number; readonly hired: string | number };
  "web.farm.friends.unpick": undefined;
  "web.farm.fx.cleared": undefined;
  "web.farm.fx.coins": { readonly coins: string | number; readonly detail: string | number };
  "web.farm.fx.level": { readonly level: string | number };
  "web.farm.fx.levelUp": { readonly level: string | number };
  "web.farm.fx.notice": undefined;
  "web.farm.graph.abandon": { readonly abandon: string | number };
  "web.farm.graph.abandonSure": undefined;
  "web.farm.graph.acceptanceHint": undefined;
  "web.farm.graph.add": undefined;
  "web.farm.graph.addStep": undefined;
  "web.farm.graph.after": { readonly titles: string | number };
  "web.farm.graph.batch": { readonly n: string | number };
  "web.farm.graph.beforeAfter": undefined;
  "web.farm.graph.behind": { readonly base: string | number; readonly n: string | number };
  "web.farm.graph.brief": undefined;
  "web.farm.graph.briefHint": undefined;
  "web.farm.graph.byRule": undefined;
  "web.farm.graph.check": undefined;
  "web.farm.graph.checkExample": undefined;
  "web.farm.graph.checkHint": { readonly check: string | number };
  "web.farm.graph.commits": undefined;
  "web.farm.graph.conflict": { readonly base: string | number; readonly files: string | number };
  "web.farm.graph.done": undefined;
  "web.farm.graph.edit": undefined;
  "web.farm.graph.empty": undefined;
  "web.farm.graph.files": undefined;
  "web.farm.graph.first": undefined;
  "web.farm.graph.frozen": { readonly files: string | number };
  "web.farm.graph.goal": undefined;
  "web.farm.graph.goalExample": undefined;
  "web.farm.graph.harvest": { readonly base: string | number };
  "web.farm.graph.intro": undefined;
  "web.farm.graph.name": undefined;
  "web.farm.graph.new": undefined;
  "web.farm.graph.no": undefined;
  "web.farm.graph.noSteps": undefined;
  "web.farm.graph.nothing": undefined;
  "web.farm.graph.onPlot": { readonly name: string | number; readonly plot: string | number };
  "web.farm.graph.onPlotDoing": { readonly doing: string | number; readonly name: string | number; readonly plot: string | number };
  "web.farm.graph.project": undefined;
  "web.farm.graph.projectTag": { readonly project: string | number };
  "web.farm.graph.readingChanges": undefined;
  "web.farm.graph.readingStory": undefined;
  "web.farm.graph.remove": undefined;
  "web.farm.graph.review": { readonly merge: string | number };
  "web.farm.graph.running": undefined;
  "web.farm.graph.spent": { readonly spent: string | number };
  "web.farm.graph.split": undefined;
  "web.farm.graph.splitter": undefined;
  "web.farm.graph.splitting": undefined;
  "web.farm.graph.stepId": undefined;
  "web.farm.graph.stepIdHint": undefined;
  "web.farm.graph.steps": { readonly done: string | number; readonly of: string | number };
  "web.farm.graph.story": undefined;
  "web.farm.graph.storyOf": { readonly title: string | number };
  "web.farm.graph.summary": {
    readonly base: string | number;
    readonly branch: string | number;
    readonly commits: string | number;
    readonly files: string | number;
    readonly project: string | number;
  };
  "web.farm.graph.title": undefined;
  "web.farm.graph.unreadable": undefined;
  "web.farm.graph.waitFor": undefined;
  "web.farm.graph.waits": { readonly titles: string | number };
  "web.farm.graph.who": undefined;
  "web.farm.graph.whoHint": undefined;
  "web.farm.graph.wholeStory": undefined;
  "web.farm.harvest.behind": { readonly base: string | number; readonly n: string | number };
  "web.farm.harvest.conflict": { readonly base: string | number };
  "web.farm.harvest.counts": { readonly commits: string | number; readonly files: string | number };
  "web.farm.harvest.empty": undefined;
  "web.farm.harvest.files": undefined;
  "web.farm.harvest.graph": undefined;
  "web.farm.harvest.letGo": undefined;
  "web.farm.harvest.none": undefined;
  "web.farm.harvest.project": { readonly project: string | number };
  "web.farm.harvest.reading": undefined;
  "web.farm.harvest.resolve": undefined;
  "web.farm.harvest.resolveHow": { readonly base: string | number };
  "web.farm.harvest.take": { readonly base: string | number };
  "web.farm.harvest.taken": { readonly ago: string | number };
  "web.farm.harvest.uncommitted": { readonly n: string | number };
  "web.farm.hud.channelsUnread": { readonly n: string | number };
  "web.farm.hud.label": undefined;
  "web.farm.hud.look": undefined;
  "web.farm.hud.map": undefined;
  "web.farm.hud.mapHint": undefined;
  "web.farm.hud.menuHint": undefined;
  "web.farm.hud.toLevel": { readonly need: string | number; readonly xp: string | number };
  "web.farm.hud.toLevelNext": { readonly need: string | number; readonly next: string | number; readonly xp: string | number };
  "web.farm.hud.tools": undefined;
  "web.farm.hud.tree": undefined;
  "web.farm.hud.treeHint": undefined;
  "web.farm.hud.workbench": undefined;
  "web.farm.hud.workbenchHint": undefined;
  "web.farm.log.answered": undefined;
  "web.farm.log.empty": undefined;
  "web.farm.log.said": undefined;
  "web.farm.log.spent": { readonly spent: string | number };
  "web.farm.log.you": undefined;
  "web.farm.map.canSend": { readonly n: string | number; readonly of: string | number };
  "web.farm.map.crop.day": undefined;
  "web.farm.map.crop.month": undefined;
  "web.farm.map.crop.never": undefined;
  "web.farm.map.crop.older": undefined;
  "web.farm.map.crop.quarter": undefined;
  "web.farm.map.crop.week": undefined;
  "web.farm.map.enter": { readonly project: string | number };
  "web.farm.map.enterWord": undefined;
  "web.farm.map.finding": undefined;
  "web.farm.map.full": { readonly n: string | number };
  "web.farm.map.gone": undefined;
  "web.farm.map.growth": { readonly label: string | number };
  "web.farm.map.growthSince": { readonly label: string | number; readonly since: string | number };
  "web.farm.map.homeless": undefined;
  "web.farm.map.island.branch": { readonly branch: string | number };
  "web.farm.map.island.gone": undefined;
  "web.farm.map.island.open": undefined;
  "web.farm.map.island.queued": { readonly n: string | number };
  "web.farm.map.island.shut": { readonly n: string | number };
  "web.farm.map.island.working": { readonly full: boolean; readonly n: string | number; readonly of: string | number };
  "web.farm.map.islands": { readonly n: number };
  "web.farm.map.job": undefined;
  "web.farm.map.jobExample": undefined;
  "web.farm.map.locked": undefined;
  "web.farm.map.noHelpers": undefined;
  "web.farm.map.noMore": undefined;
  "web.farm.map.notDrafted": { readonly why: string | number };
  "web.farm.map.open": { readonly project: string | number };
  "web.farm.map.peopled": { readonly n: string | number };
  "web.farm.map.plot": { readonly name: string | number };
  "web.farm.map.queue": { readonly n: string | number };
  "web.farm.map.queued": { readonly n: string | number };
  "web.farm.map.queuedLabel": { readonly title: string | number };
  "web.farm.map.queuedTip": { readonly title: string | number };
  "web.farm.map.sack": undefined;
  "web.farm.map.sea": undefined;
  "web.farm.map.see": undefined;
  "web.farm.map.send": { readonly project: string | number };
  "web.farm.map.shut": { readonly n: string | number };
  "web.farm.map.sow": undefined;
  "web.farm.map.sowIntro": { readonly project: string | number };
  "web.farm.map.stake": undefined;
  "web.farm.map.todo": undefined;
  "web.farm.map.wait": undefined;
  "web.farm.map.working": { readonly n: string | number; readonly of: string | number };
  "web.farm.map.worktrees": { readonly n: string | number };
  "web.farm.menu.agents": undefined;
  "web.farm.menu.catalog": undefined;
  "web.farm.menu.chat": undefined;
  "web.farm.menu.connectors": undefined;
  "web.farm.menu.elsewhere": undefined;
  "web.farm.menu.home": undefined;
  "web.farm.menu.issues": undefined;
  "web.farm.menu.projects": undefined;
  "web.farm.menu.resume": undefined;
  "web.farm.menu.runtimes": undefined;
  "web.farm.menu.skills": undefined;
  "web.farm.menu.soundOff": undefined;
  "web.farm.menu.soundOn": undefined;
  "web.farm.menu.yard": undefined;
  "web.farm.never": undefined;
  "web.farm.notNow": undefined;
  "web.farm.orchestrator": undefined;
  "web.farm.overlay.bare": { readonly plot: string | number };
  "web.farm.overlay.clearAt": { readonly level: string | number };
  "web.farm.overlay.click": { readonly text: string | number };
  "web.farm.overlay.flowerbed": undefined;
  "web.farm.overlay.idle": undefined;
  "web.farm.overlay.unclaimed": undefined;
  "web.farm.page.lost": undefined;
  "web.farm.page.waiting": undefined;
  "web.farm.panel.drawing": undefined;
  "web.farm.panel.graphs": undefined;
  "web.farm.panel.harvest": { readonly name: string | number };
  "web.farm.panel.log": undefined;
  "web.farm.panel.menu": undefined;
  "web.farm.panel.orchestrator": undefined;
  "web.farm.panel.pets": undefined;
  "web.farm.panel.pickLook": undefined;
  "web.farm.panel.shop": undefined;
  "web.farm.panel.shopClosed": { readonly coins: string | number };
  "web.farm.panel.shopItems.bunting.name": undefined;
  "web.farm.panel.shopItems.bunting.note": undefined;
  "web.farm.panel.shopItems.doghouse.name": undefined;
  "web.farm.panel.shopItems.doghouse.note": undefined;
  "web.farm.panel.shopItems.scarecrow.name": undefined;
  "web.farm.panel.shopItems.scarecrow.note": undefined;
  "web.farm.panel.shopItems.seeds.name": undefined;
  "web.farm.panel.shopItems.seeds.note": undefined;
  "web.farm.panel.sow": { readonly plot: string | number };
  "web.farm.panel.taskBoard": undefined;
  "web.farm.panel.warehouse": undefined;
  "web.farm.panel.water": { readonly name: string | number };
  "web.farm.phone.again": undefined;
  "web.farm.phone.answer": undefined;
  "web.farm.phone.answered": undefined;
  "web.farm.phone.app.channels": undefined;
  "web.farm.phone.app.games": undefined;
  "web.farm.phone.app.graphs": undefined;
  "web.farm.phone.app.missed": undefined;
  "web.farm.phone.blocks.best": undefined;
  "web.farm.phone.blocks.help": undefined;
  "web.farm.phone.blocks.help2": undefined;
  "web.farm.phone.blocks.help3": undefined;
  "web.farm.phone.blocks.level": undefined;
  "web.farm.phone.blocks.lines": undefined;
  "web.farm.phone.blocks.next": undefined;
  "web.farm.phone.blocks.noRoom": undefined;
  "web.farm.phone.blocks.score": undefined;
  "web.farm.phone.blocks.well": undefined;
  "web.farm.phone.brand": undefined;
  "web.farm.phone.bugs.ended.full": undefined;
  "web.farm.phone.bugs.ended.self": undefined;
  "web.farm.phone.bugs.ended.wall": undefined;
  "web.farm.phone.bugs.field": undefined;
  "web.farm.phone.bugs.help": undefined;
  "web.farm.phone.bugs.help2": undefined;
  "web.farm.phone.bugs.tally": { readonly bugs: string | number; readonly seeds: string | number };
  "web.farm.phone.callOrchestrator": undefined;
  "web.farm.phone.chatTab": undefined;
  "web.farm.phone.decline": undefined;
  "web.farm.phone.declined": undefined;
  "web.farm.phone.dino.crashed": undefined;
  "web.farm.phone.dino.help": undefined;
  "web.farm.phone.dino.help2": undefined;
  "web.farm.phone.dino.road": undefined;
  "web.farm.phone.game.blocks": undefined;
  "web.farm.phone.game.bugs": undefined;
  "web.farm.phone.game.dino": undefined;
  "web.farm.phone.game.merge": undefined;
  "web.farm.phone.game.sokoban": undefined;
  "web.farm.phone.hangUp": undefined;
  "web.farm.phone.home": undefined;
  "web.farm.phone.homeHint": undefined;
  "web.farm.phone.key.down": undefined;
  "web.farm.phone.key.left": undefined;
  "web.farm.phone.key.right": undefined;
  "web.farm.phone.key.up": undefined;
  "web.farm.phone.label": undefined;
  "web.farm.phone.log": undefined;
  "web.farm.phone.manager": undefined;
  "web.farm.phone.merge.field": { readonly n: string | number; readonly top: string | number };
  "web.farm.phone.merge.full": { readonly score: string | number };
  "web.farm.phone.merge.goOn": undefined;
  "web.farm.phone.merge.harvest": undefined;
  "web.farm.phone.merge.help": undefined;
  "web.farm.phone.merge.help2": undefined;
  "web.farm.phone.merge.overKeys": undefined;
  "web.farm.phone.merge.past": { readonly n: string | number };
  "web.farm.phone.merge.reached": { readonly stage: string | number };
  "web.farm.phone.merge.restartAsk": undefined;
  "web.farm.phone.merge.restartKeys": undefined;
  "web.farm.phone.merge.stage.0": undefined;
  "web.farm.phone.merge.stage.1": undefined;
  "web.farm.phone.merge.stage.10": undefined;
  "web.farm.phone.merge.stage.2": undefined;
  "web.farm.phone.merge.stage.3": undefined;
  "web.farm.phone.merge.stage.4": undefined;
  "web.farm.phone.merge.stage.5": undefined;
  "web.farm.phone.merge.stage.6": undefined;
  "web.farm.phone.merge.stage.7": undefined;
  "web.farm.phone.merge.stage.8": undefined;
  "web.farm.phone.merge.stage.9": undefined;
  "web.farm.phone.merge.stages": undefined;
  "web.farm.phone.merge.start": undefined;
  "web.farm.phone.missed": { readonly n: string | number };
  "web.farm.phone.new": undefined;
  "web.farm.phone.noCalls": undefined;
  "web.farm.phone.noMissed": undefined;
  "web.farm.phone.openChat": undefined;
  "web.farm.phone.openChatUnread": { readonly n: string | number };
  "web.farm.phone.paused": undefined;
  "web.farm.phone.phase.coming": undefined;
  "web.farm.phone.phase.connecting": undefined;
  "web.farm.phone.phase.ending": undefined;
  "web.farm.phone.phase.failed": { readonly why: string | number };
  "web.farm.phone.phase.idle": undefined;
  "web.farm.phone.phase.live": undefined;
  "web.farm.phone.phone": undefined;
  "web.farm.phone.phoneMissed": { readonly n: string | number };
  "web.farm.phone.phoneRinging": undefined;
  "web.farm.phone.phoneUnread": { readonly n: string | number };
  "web.farm.phone.pressA": { readonly what: string | number };
  "web.farm.phone.resume": undefined;
  "web.farm.phone.ring": undefined;
  "web.farm.phone.ringing": undefined;
  "web.farm.phone.sokoban.again": undefined;
  "web.farm.phone.sokoban.allIn": undefined;
  "web.farm.phone.sokoban.board": { readonly of: string | number; readonly placed: string | number };
  "web.farm.phone.sokoban.done": undefined;
  "web.farm.phone.sokoban.goal": undefined;
  "web.farm.phone.sokoban.help": undefined;
  "web.farm.phone.sokoban.levels.0": undefined;
  "web.farm.phone.sokoban.levels.1": undefined;
  "web.farm.phone.sokoban.levels.2": undefined;
  "web.farm.phone.sokoban.levels.3": undefined;
  "web.farm.phone.sokoban.levels.4": undefined;
  "web.farm.phone.sokoban.moves": { readonly moves: string | number; readonly pushes: string | number };
  "web.farm.phone.sokoban.next": undefined;
  "web.farm.phone.sokoban.restart": undefined;
  "web.farm.phone.sokoban.title": { readonly level: string | number; readonly of: string | number };
  "web.farm.phone.sokoban.undo": undefined;
  "web.farm.phone.start": undefined;
  "web.farm.plot.answer": undefined;
  "web.farm.plot.answerTo": { readonly question: string | number };
  "web.farm.plot.branch": undefined;
  "web.farm.plot.changesUnread": undefined;
  "web.farm.plot.closed": undefined;
  "web.farm.plot.conclusion": undefined;
  "web.farm.plot.conflict": { readonly base: string | number; readonly files: string | number };
  "web.farm.plot.copyPath": undefined;
  "web.farm.plot.crew": undefined;
  "web.farm.plot.deliver": undefined;
  "web.farm.plot.details": undefined;
  "web.farm.plot.evidence": { readonly line: string | number };
  "web.farm.plot.failed": undefined;
  "web.farm.plot.graph": undefined;
  "web.farm.plot.history": undefined;
  "web.farm.plot.job": undefined;
  "web.farm.plot.made": undefined;
  "web.farm.plot.madeFiles": { readonly n: string | number };
  "web.farm.plot.madeNothing": undefined;
  "web.farm.plot.model": undefined;
  "web.farm.plot.moreFiles": { readonly n: string | number };
  "web.farm.plot.next": { readonly line: string | number };
  "web.farm.plot.noCriteria": { readonly answer: boolean };
  "web.farm.plot.noRuns": undefined;
  "web.farm.plot.now": undefined;
  "web.farm.plot.onBoard": undefined;
  "web.farm.plot.opened": undefined;
  "web.farm.plot.progress": undefined;
  "web.farm.plot.progressMet": { readonly met: string | number; readonly of: string | number };
  "web.farm.plot.rejectLabel": undefined;
  "web.farm.plot.rejectWhere": undefined;
  "web.farm.plot.rejected": { readonly text: string | number };
  "web.farm.plot.reopen": undefined;
  "web.farm.plot.reopenWhat": undefined;
  "web.farm.plot.result.met": undefined;
  "web.farm.plot.result.unmet": undefined;
  "web.farm.plot.result.unsure": undefined;
  "web.farm.plot.review": undefined;
  "web.farm.plot.reviewed": { readonly clock: string | number };
  "web.farm.plot.runCount": { readonly n: number };
  "web.farm.plot.runs": undefined;
  "web.farm.plot.sayIt": undefined;
  "web.farm.plot.steps": undefined;
  "web.farm.plot.story": undefined;
  "web.farm.plot.tell": { readonly who: string | number };
  "web.farm.plot.tellIdle": undefined;
  "web.farm.plot.tellWorking": undefined;
  "web.farm.plot.thread": undefined;
  "web.farm.plot.ticked": undefined;
  "web.farm.plot.took": undefined;
  "web.farm.plot.unread": undefined;
  "web.farm.plot.weed": { readonly text: string | number };
  "web.farm.plot.weeded": undefined;
  "web.farm.plot.where": { readonly plot: string | number; readonly round: string | number };
  "web.farm.plot.who": undefined;
  "web.farm.plot.yours": undefined;
  "web.farm.plotOf": { readonly name: string | number };
  "web.farm.quota.all": undefined;
  "web.farm.quota.balance": { readonly enough: boolean; readonly provider: string | number };
  "web.farm.quota.left": undefined;
  "web.farm.quota.lowest": { readonly pct: string | number };
  "web.farm.quota.note": undefined;
  "web.farm.quota.quota": undefined;
  "web.farm.quota.refresh": undefined;
  "web.farm.quota.signedOut": undefined;
  "web.farm.quota.spentToday": { readonly spent: string | number };
  "web.farm.quota.spentTodayBudget": { readonly budget: string | number; readonly spent: string | number };
  "web.farm.quota.unreadable": { readonly why: string | number };
  "web.farm.quota.unreported": undefined;
  "web.farm.reading": undefined;
  "web.farm.sign.hint": undefined;
  "web.farm.sign.label": { readonly project: string | number };
  "web.farm.sign.noProject": undefined;
  "web.farm.sign.project": undefined;
  "web.farm.sow.draft": undefined;
  "web.farm.sow.homeless": undefined;
  "web.farm.sow.how": { readonly project: string | number };
  "web.farm.sow.job": undefined;
  "web.farm.sow.jobHint": undefined;
  "web.farm.sow.kinds": undefined;
  "web.farm.sow.makeProject": undefined;
  "web.farm.sow.map": undefined;
  "web.farm.sow.noProjects": undefined;
  "web.farm.sow.noSeeds": undefined;
  "web.farm.sow.notDrafted": undefined;
  "web.farm.sow.orchestratorPicks": undefined;
  "web.farm.sow.own": undefined;
  "web.farm.sow.plantIn": { readonly project: string | number };
  "web.farm.sow.recent": undefined;
  "web.farm.sow.retry": undefined;
  "web.farm.sow.rummaging": undefined;
  "web.farm.sow.start": undefined;
  "web.farm.sow.toMap": undefined;
  "web.farm.sow.who": undefined;
  "web.farm.title.continue": undefined;
  "web.farm.title.keyFirst": undefined;
  "web.farm.title.label": undefined;
  "web.farm.title.name": undefined;
  "web.farm.title.nothingToContinue": undefined;
  "web.farm.title.start": undefined;
  "web.farm.title.tagline": undefined;
  "web.farm.tool.bug.hint": undefined;
  "web.farm.tool.bug.label": undefined;
  "web.farm.tool.hand.hint": undefined;
  "web.farm.tool.hand.label": undefined;
  "web.farm.tool.harvest.hint": undefined;
  "web.farm.tool.harvest.label": undefined;
  "web.farm.tool.shovel.hint": undefined;
  "web.farm.tool.shovel.label": undefined;
  "web.farm.tool.water.hint": undefined;
  "web.farm.tool.weed.hint": undefined;
  "web.farm.tool.weed.label": undefined;
  "web.farm.unread": undefined;
  "web.farm.water.drops.0": undefined;
  "web.farm.water.drops.1": undefined;
  "web.farm.water.drops.2": undefined;
  "web.farm.water.drops.3": undefined;
  "web.farm.water.hint": undefined;
  "web.farm.water.idle": undefined;
  "web.farm.water.job": { readonly brief: string | number };
  "web.farm.water.moved": undefined;
  "web.farm.water.thread": undefined;
  "web.farm.water.water": undefined;
  "web.farm.water.working": undefined;
  "web.farm.yard.agents.hint": undefined;
  "web.farm.yard.log.hint": undefined;
  "web.farm.yard.manager.hint": undefined;
  "web.farm.yard.runtimes.hint": undefined;
  "web.farm.yard.runtimes.label": undefined;
  "web.farm.yard.shop.hint": undefined;
  "web.farm.yard.skills.hint": undefined;
  "web.farm.yard.skills.label": undefined;
  "web.farm.yard.taskBoard.hint": undefined;
  "web.farm.yard.taskBoard.label": undefined;
  "web.farm.yard.tasks.hint": undefined;
  "web.farm.yard.warehouse.hint": undefined;
  "web.inbox.tray.idle": undefined;
  "web.inbox.tray.off": undefined;
  "web.inbox.tray.unread": { readonly n: string | number };
  "web.inbox.tray.working": { readonly n: number };
  "web.issue.acts.carry": undefined;
  "web.issue.acts.goesOn": { readonly helper: string | number };
  "web.issue.acts.rejectWith": undefined;
  "web.issue.acts.reopened": undefined;
  "web.issue.board.add": undefined;
  "web.issue.board.addLabel": undefined;
  "web.issue.board.earlier": { readonly n: string | number };
  "web.issue.board.empty.closed": undefined;
  "web.issue.board.empty.todo": undefined;
  "web.issue.board.empty.waiting": undefined;
  "web.issue.board.empty.working": undefined;
  "web.issue.board.moveFailed": undefined;
  "web.issue.board.putBack": undefined;
  "web.issue.board.recent": undefined;
  "web.issue.board.retryMove": undefined;
  "web.issue.board.spots": { readonly of: string | number; readonly taken: string | number };
  "web.issue.board.whichLane": undefined;
  "web.issue.boardLabels.grouping.agent": undefined;
  "web.issue.boardLabels.grouping.none": undefined;
  "web.issue.boardLabels.grouping.project": undefined;
  "web.issue.boardLabels.grouping.status": undefined;
  "web.issue.boardLabels.lane.closed": undefined;
  "web.issue.boardLabels.lane.todo": undefined;
  "web.issue.boardLabels.lane.waiting": undefined;
  "web.issue.boardLabels.lane.working": undefined;
  "web.issue.boardLabels.newIssue": undefined;
  "web.issue.boardLabels.ordering.created": undefined;
  "web.issue.boardLabels.ordering.manual": undefined;
  "web.issue.boardLabels.ordering.priority": undefined;
  "web.issue.boardLabels.ordering.updated": undefined;
  "web.issue.boardLabels.stage.finish": undefined;
  "web.issue.boardLabels.stage.talk": undefined;
  "web.issue.boardLabels.stage.work": undefined;
  "web.issue.boardLabels.view.board": undefined;
  "web.issue.boardLabels.view.list": undefined;
  "web.issue.card.cron": undefined;
  "web.issue.card.draft": undefined;
  "web.issue.card.graph": { readonly title: string | number };
  "web.issue.card.lost": undefined;
  "web.issue.card.missing": { readonly what: string | number };
  "web.issue.card.missingFlag": undefined;
  "web.issue.card.noHelper": undefined;
  "web.issue.card.nth": { readonly n: string | number };
  "web.issue.card.open": { readonly took: string | number };
  "web.issue.card.orchestrator": undefined;
  "web.issue.card.orchestratorWorking": undefined;
  "web.issue.card.pickFirst": undefined;
  "web.issue.card.queued": undefined;
  "web.issue.card.quiet": { readonly took: string | number };
  "web.issue.card.refining": { readonly name: string | number };
  "web.issue.card.run": { readonly n: string | number };
  "web.issue.card.runs": { readonly n: number };
  "web.issue.card.used": { readonly took: string | number };
  "web.issue.card.waiting": { readonly ago: string | number };
  "web.issue.card.written": { readonly ago: string | number };
  "web.issue.changes.behind": { readonly base: string | number; readonly n: string | number };
  "web.issue.changes.binary": undefined;
  "web.issue.changes.commits": { readonly n: string | number };
  "web.issue.changes.conflict": { readonly base: string | number };
  "web.issue.changes.conflictMark": undefined;
  "web.issue.changes.counts": { readonly commits: string | number; readonly files: string | number };
  "web.issue.changes.files": { readonly n: string | number };
  "web.issue.changes.letGo": undefined;
  "web.issue.changes.merge": { readonly base: string | number };
  "web.issue.changes.moved": undefined;
  "web.issue.changes.none": undefined;
  "web.issue.changes.reading": undefined;
  "web.issue.changes.resolve": undefined;
  "web.issue.changes.resolveHow": { readonly base: string | number };
  "web.issue.changes.uncommitted": { readonly n: string | number };
  "web.issue.changes.unreadable": undefined;
  "web.issue.close.cancel": undefined;
  "web.issue.close.completable": { readonly who: string | number };
  "web.issue.close.notCompletable": { readonly who: string | number };
  "web.issue.close.review": undefined;
  "web.issue.close.stopAndCancel": undefined;
  "web.issue.close.title": { readonly issue: string | number };
  "web.issue.close.working": { readonly who: string | number };
  "web.issue.detail.answer": undefined;
  "web.issue.detail.answerTo": { readonly question: string | number };
  "web.issue.detail.answered": undefined;
  "web.issue.detail.backToGraph": undefined;
  "web.issue.detail.branch": undefined;
  "web.issue.detail.changedFiles": undefined;
  "web.issue.detail.changesUnread": undefined;
  "web.issue.detail.closedAt": undefined;
  "web.issue.detail.conflict": { readonly base: string | number; readonly files: string | number };
  "web.issue.detail.copyPath": undefined;
  "web.issue.detail.crew": undefined;
  "web.issue.detail.deliver": undefined;
  "web.issue.detail.evidence": undefined;
  "web.issue.detail.fileCount": { readonly n: string | number };
  "web.issue.detail.from": undefined;
  "web.issue.detail.fromCron": undefined;
  "web.issue.detail.full": undefined;
  "web.issue.detail.graphStep": { readonly graph: string | number };
  "web.issue.detail.helper": undefined;
  "web.issue.detail.job": undefined;
  "web.issue.detail.made": undefined;
  "web.issue.detail.met": { readonly met: string | number; readonly of: string | number };
  "web.issue.detail.model": undefined;
  "web.issue.detail.next": undefined;
  "web.issue.detail.noAnswer": undefined;
  "web.issue.detail.noChanges": undefined;
  "web.issue.detail.noCriteria": { readonly answer: boolean };
  "web.issue.detail.noRuns": undefined;
  "web.issue.detail.nothingToSee": undefined;
  "web.issue.detail.now": undefined;
  "web.issue.detail.opened": undefined;
  "web.issue.detail.orchestratorStuck": undefined;
  "web.issue.detail.profile": undefined;
  "web.issue.detail.progress": undefined;
  "web.issue.detail.rejectLabel": undefined;
  "web.issue.detail.rejectWhere": undefined;
  "web.issue.detail.rejected": undefined;
  "web.issue.detail.resolved": undefined;
  "web.issue.detail.result.met": undefined;
  "web.issue.detail.result.unmet": undefined;
  "web.issue.detail.result.unsure": undefined;
  "web.issue.detail.reviewed": undefined;
  "web.issue.detail.runCount": { readonly n: number };
  "web.issue.detail.runs": undefined;
  "web.issue.detail.sayIt": undefined;
  "web.issue.detail.since": { readonly clock: string | number };
  "web.issue.detail.started": undefined;
  "web.issue.detail.step.assistant/message": undefined;
  "web.issue.detail.step.assistant/thinking": undefined;
  "web.issue.detail.step.llm/retry": undefined;
  "web.issue.detail.step.memory/recalled": undefined;
  "web.issue.detail.step.run/end": undefined;
  "web.issue.detail.step.run/error": undefined;
  "web.issue.detail.step.run/start": undefined;
  "web.issue.detail.step.tool/call": undefined;
  "web.issue.detail.step.user/message": undefined;
  "web.issue.detail.stepCount": { readonly n: number };
  "web.issue.detail.steps": undefined;
  "web.issue.detail.stepsAndTools": { readonly n: string | number; readonly tools: string | number };
  "web.issue.detail.story": undefined;
  "web.issue.detail.tell": { readonly who: string | number };
  "web.issue.detail.tellIdle": undefined;
  "web.issue.detail.tellSection": undefined;
  "web.issue.detail.tellWorking": undefined;
  "web.issue.detail.ticked": { readonly criterion: string | number };
  "web.issue.detail.time": undefined;
  "web.issue.detail.took": undefined;
  "web.issue.detail.unread": undefined;
  "web.issue.detail.unsaid": undefined;
  "web.issue.detail.unsure": undefined;
  "web.issue.detail.waiting": undefined;
  "web.issue.detail.who": undefined;
  "web.issue.detail.yours": undefined;
  "web.issue.display.boardNote": undefined;
  "web.issue.display.defaultNote": undefined;
  "web.issue.display.group": undefined;
  "web.issue.display.order": undefined;
  "web.issue.display.orderNote": undefined;
  "web.issue.display.reset": undefined;
  "web.issue.display.show": undefined;
  "web.issue.graph.abandoned": undefined;
  "web.issue.graph.done": undefined;
  "web.issue.graph.draft": undefined;
  "web.issue.graph.paused": undefined;
  "web.issue.graph.ready": undefined;
  "web.issue.graph.running": { readonly done: string | number; readonly total: string | number };
  "web.issue.graph.splitting": undefined;
  "web.issue.issue.and": undefined;
  "web.issue.issue.asking": { readonly n: number; readonly who: string | number };
  "web.issue.issue.askingLine": undefined;
  "web.issue.issue.canceled": undefined;
  "web.issue.issue.change.A.label": undefined;
  "web.issue.issue.change.A.mark": undefined;
  "web.issue.issue.change.D.label": undefined;
  "web.issue.issue.change.D.mark": undefined;
  "web.issue.issue.change.M.label": undefined;
  "web.issue.issue.change.M.mark": undefined;
  "web.issue.issue.changes": {
    readonly added: string | number;
    readonly base: string | number;
    readonly branch: string | number;
    readonly commits: string | number;
    readonly removed: string | number;
  };
  "web.issue.issue.changesUncommitted": {
    readonly added: string | number;
    readonly base: string | number;
    readonly branch: string | number;
    readonly commits: string | number;
    readonly removed: string | number;
    readonly uncommitted: string | number;
  };
  "web.issue.issue.conflict": { readonly base: string | number };
  "web.issue.issue.doing": { readonly action: string | number };
  "web.issue.issue.doingLabel": { readonly action: string | number; readonly label: string | number };
  "web.issue.issue.editing": { readonly who: string | number };
  "web.issue.issue.failed": undefined;
  "web.issue.issue.graphStep": { readonly graph: string | number; readonly step: string | number };
  "web.issue.issue.handedBack": { readonly who: string | number };
  "web.issue.issue.history": { readonly line: string | number; readonly n: string | number };
  "web.issue.issue.historyItem": { readonly id: string | number; readonly name: string | number };
  "web.issue.issue.inGraph": undefined;
  "web.issue.issue.interrupted": undefined;
  "web.issue.issue.justNow": undefined;
  "web.issue.issue.main": undefined;
  "web.issue.issue.noSteps": undefined;
  "web.issue.issue.quiet": { readonly who: string | number };
  "web.issue.issue.quietLine": undefined;
  "web.issue.issue.ran": { readonly n: string | number };
  "web.issue.issue.reopenLine": undefined;
  "web.issue.issue.reviewed": undefined;
  "web.issue.issue.since": { readonly span: string | number };
  "web.issue.issue.splitting": { readonly graph: string | number };
  "web.issue.issue.stepsGone": undefined;
  "web.issue.issue.stuck": undefined;
  "web.issue.issue.used": { readonly span: string | number };
  "web.issue.issue.who": { readonly name: string | number };
  "web.issue.issue.whoRuntime": { readonly name: string | number; readonly runtime: string | number };
  "web.issue.later": undefined;
  "web.issue.list.all": undefined;
  "web.issue.list.fold": { readonly group: string | number };
  "web.issue.list.noProject": undefined;
  "web.issue.list.unfold": { readonly group: string | number };
  "web.issue.list.writeIn": { readonly group: string | number };
  "web.issue.marks.priority": { readonly word: string | number };
  "web.issue.never": undefined;
  "web.issue.noHelper": undefined;
  "web.issue.orchestrator": undefined;
  "web.issue.page.allHelpers": undefined;
  "web.issue.page.allProjects": undefined;
  "web.issue.page.backToBoard": undefined;
  "web.issue.page.byHelper": undefined;
  "web.issue.page.byProject": undefined;
  "web.issue.page.clear": undefined;
  "web.issue.page.filter": undefined;
  "web.issue.page.find": undefined;
  "web.issue.page.findLabel": undefined;
  "web.issue.page.historyUnread": undefined;
  "web.issue.page.missing": { readonly what: string | number };
  "web.issue.page.notDrafted": { readonly why: string | number };
  "web.issue.page.notFound": undefined;
  "web.issue.page.notFoundLine": { readonly id: string | number };
  "web.issue.page.pickFirst": undefined;
  "web.issue.page.shown": { readonly of: string | number; readonly shown: string | number };
  "web.issue.page.view": undefined;
  "web.issue.reading": undefined;
  "web.issue.reopen.line": { readonly issue: string | number };
  "web.issue.reopen.reopen": undefined;
  "web.issue.reopen.title": undefined;
  "web.issue.reopen.what": undefined;
  "web.issue.reopen.whatLabel": undefined;
  "web.issue.run.heard": { readonly n: number };
  "web.issue.run.working": undefined;
  "web.issue.sheet.at": { readonly stage: string | number };
  "web.issue.sheet.less": undefined;
  "web.issue.sheet.more": undefined;
  "web.issue.sheet.stageDone": { readonly stage: string | number };
  "web.issue.task.abandon": undefined;
  "web.issue.task.abandonLine": undefined;
  "web.issue.task.abandonTitle": { readonly abandon: string | number };
  "web.issue.task.atMost": { readonly n: string | number };
  "web.issue.task.behind": { readonly base: string | number; readonly n: string | number };
  "web.issue.task.check": undefined;
  "web.issue.task.conclusion": undefined;
  "web.issue.task.conflict": { readonly base: string | number; readonly files: string | number };
  "web.issue.task.done": { readonly done: string | number; readonly of: string | number };
  "web.issue.task.label": undefined;
  "web.issue.task.layer": { readonly n: string | number };
  "web.issue.task.layerTogether": { readonly n: string | number; readonly size: string | number };
  "web.issue.task.merge": { readonly base: string | number };
  "web.issue.task.note": undefined;
  "web.issue.task.ok": undefined;
  "web.issue.task.open": undefined;
  "web.issue.task.parallel": undefined;
  "web.issue.task.progress": undefined;
  "web.issue.task.progressLine": { readonly done: string | number; readonly of: string | number };
  "web.issue.task.project": undefined;
  "web.issue.task.reading": undefined;
  "web.issue.task.review": { readonly merge: string | number };
  "web.issue.task.scope": undefined;
  "web.issue.task.spent": undefined;
  "web.issue.task.splitting": undefined;
  "web.issue.task.state": undefined;
  "web.issue.task.stepSeparator": undefined;
  "web.issue.task.steps": { readonly n: number };
  "web.issue.task.tried": undefined;
  "web.issue.task.tries": { readonly n: string | number };
  "web.issue.task.waitsForYou": undefined;
  "web.issue.task.waitsOn": { readonly steps: string | number };
  "web.issue.task.written": undefined;
  "web.issue.todo.againHint": undefined;
  "web.issue.todo.answerHint": undefined;
  "web.issue.todo.answerTo": { readonly question: string | number };
  "web.issue.todo.create": undefined;
  "web.issue.todo.criteria": undefined;
  "web.issue.todo.criteriaHint": undefined;
  "web.issue.todo.criteriaSummary": { readonly first: string | number; readonly n: string | number };
  "web.issue.todo.description": undefined;
  "web.issue.todo.descriptionHint": undefined;
  "web.issue.todo.draft": undefined;
  "web.issue.todo.draftStatus": undefined;
  "web.issue.todo.drafted": undefined;
  "web.issue.todo.draftedLine": undefined;
  "web.issue.todo.firstProject": undefined;
  "web.issue.todo.inQueue": { readonly ago: string | number };
  "web.issue.todo.newProject": undefined;
  "web.issue.todo.newProjectLink": undefined;
  "web.issue.todo.noCriteria": undefined;
  "web.issue.todo.pickForMe": undefined;
  "web.issue.todo.pickHelper": undefined;
  "web.issue.todo.priority": undefined;
  "web.issue.todo.projectHint": undefined;
  "web.issue.todo.projectName": undefined;
  "web.issue.todo.questions": { readonly n: number };
  "web.issue.todo.questionsLine": undefined;
  "web.issue.todo.queued": undefined;
  "web.issue.todo.redraft": undefined;
  "web.issue.todo.refining": { readonly who: string | number };
  "web.issue.todo.refiningLine": undefined;
  "web.issue.todo.remove": undefined;
  "web.issue.todo.save": undefined;
  "web.issue.todo.start": undefined;
  "web.issue.todo.status": undefined;
  "web.issue.todo.talk": undefined;
  "web.issue.todo.title": undefined;
  "web.issue.todo.titleHint": undefined;
  "web.issue.todo.todoStatus": undefined;
  "web.issue.todo.unqueue": undefined;
  "web.issue.todo.what": undefined;
  "web.issue.todo.whatHint": undefined;
  "web.issue.todo.whatLabel": undefined;
  "web.issue.todo.whatLine": undefined;
  "web.issue.todo.whichProject": undefined;
  "web.issue.todo.writeOwn": undefined;
  "web.issue.trigger.comment": undefined;
  "web.issue.trigger.commentNumbered": { readonly id: string | number };
  "web.issue.trigger.cron": undefined;
  "web.issue.trigger.issue": undefined;
  "web.issue.trigger.missed": undefined;
  "web.issue.trigger.refine": undefined;
  "web.issue.trigger.runtime": undefined;
  "web.issue.trigger.task": undefined;
  "web.lan.devices.android": undefined;
  "web.lan.devices.device": undefined;
  "web.lan.devices.windows": undefined;
  "web.lan.lan.add": undefined;
  "web.lan.lan.address": undefined;
  "web.lan.lan.allow": undefined;
  "web.lan.lan.asking": { readonly name: string | number };
  "web.lan.lan.close": undefined;
  "web.lan.lan.closed": undefined;
  "web.lan.lan.copied": undefined;
  "web.lan.lan.copy": undefined;
  "web.lan.lan.deviceCount": { readonly n: string | number };
  "web.lan.lan.devices": undefined;
  "web.lan.lan.intro": undefined;
  "web.lan.lan.left": { readonly s: string | number };
  "web.lan.lan.letIn": undefined;
  "web.lan.lan.newCode": undefined;
  "web.lan.lan.notCopied": undefined;
  "web.lan.lan.notes.0": undefined;
  "web.lan.lan.notes.1": undefined;
  "web.lan.lan.notes.2": undefined;
  "web.lan.lan.notes.3": undefined;
  "web.lan.lan.open": undefined;
  "web.lan.lan.paired": { readonly at: string | number; readonly seen: string | number };
  "web.lan.lan.pairedNever": { readonly at: string | number };
  "web.lan.lan.qr": undefined;
  "web.lan.lan.refuse": undefined;
  "web.lan.lan.remove": undefined;
  "web.lan.lan.removeWhich": { readonly name: string | number };
  "web.lan.lan.scan": undefined;
  "web.lan.lan.section.label": undefined;
  "web.lan.lan.stop": undefined;
  "web.lan.pair.ask": undefined;
  "web.lan.pair.code": undefined;
  "web.lan.pair.codeHint": undefined;
  "web.lan.pair.intro": undefined;
  "web.lan.pair.name": undefined;
  "web.lan.pair.nameHint": undefined;
  "web.lan.pair.title": undefined;
  "web.lan.pair.waiting": undefined;
  "web.memory.memory.all": undefined;
  "web.memory.memory.allProjects": undefined;
  "web.memory.memory.archiveIntro": undefined;
  "web.memory.memory.blank": undefined;
  "web.memory.memory.chars": { readonly n: string | number };
  "web.memory.memory.compacted": undefined;
  "web.memory.memory.emptyHere": undefined;
  "web.memory.memory.fading": { readonly keep: string | number };
  "web.memory.memory.find": undefined;
  "web.memory.memory.forget": undefined;
  "web.memory.memory.forgetElsewhere": undefined;
  "web.memory.memory.forgetThere": { readonly source: string | number };
  "web.memory.memory.forgettable": undefined;
  "web.memory.memory.found": undefined;
  "web.memory.memory.helper": undefined;
  "web.memory.memory.inSource": { readonly source: string | number };
  "web.memory.memory.intro": undefined;
  "web.memory.memory.issues": undefined;
  "web.memory.memory.listed": undefined;
  "web.memory.memory.neverRecalled": undefined;
  "web.memory.memory.next": undefined;
  "web.memory.memory.noArchive": undefined;
  "web.memory.memory.noIssues": undefined;
  "web.memory.memory.noProjects": undefined;
  "web.memory.memory.note": undefined;
  "web.memory.memory.noteHint": undefined;
  "web.memory.memory.noteHintProject": undefined;
  "web.memory.memory.noteOrchestrator": undefined;
  "web.memory.memory.noteProject": undefined;
  "web.memory.memory.notes": undefined;
  "web.memory.memory.nothing": undefined;
  "web.memory.memory.off": { readonly why: string | number };
  "web.memory.memory.on": undefined;
  "web.memory.memory.orchestratorIntro": undefined;
  "web.memory.memory.orchestratorNothing": undefined;
  "web.memory.memory.orchestratorOwn": undefined;
  "web.memory.memory.orchestratorReading": undefined;
  "web.memory.memory.orchestrators": undefined;
  "web.memory.memory.own": undefined;
  "web.memory.memory.pick": undefined;
  "web.memory.memory.preview": { readonly chars: string | number; readonly limit: string | number; readonly n: string | number };
  "web.memory.memory.project": undefined;
  "web.memory.memory.projectHint": undefined;
  "web.memory.memory.recalled": { readonly n: string | number };
  "web.memory.memory.recalledLast": { readonly last: string | number; readonly n: string | number };
  "web.memory.memory.search": undefined;
  "web.memory.memory.searchHint": undefined;
  "web.memory.memory.sessions": { readonly name: string | number };
  "web.memory.memory.sources": undefined;
  "web.memory.memory.sourcesNote": undefined;
  "web.memory.memory.told": undefined;
  "web.memory.memory.tooOld": undefined;
  "web.memory.memory.transcripts": undefined;
  "web.memory.memory.unlisted": undefined;
  "web.memory.memory.where": undefined;
  "web.memory.memory.words": undefined;
  "web.memory.memory.wordsHint": undefined;
  "web.memory.memory.yours": undefined;
  "web.opening.cannotStart": { readonly why: string | number };
  "web.opening.label": undefined;
  "web.opening.waking": undefined;
  "web.orchestrator.looks.auntie.blurb": undefined;
  "web.orchestrator.looks.auntie.name": undefined;
  "web.orchestrator.looks.farmer.blurb": undefined;
  "web.orchestrator.looks.farmer.name": undefined;
  "web.orchestrator.looks.foreman.blurb": undefined;
  "web.orchestrator.looks.foreman.name": undefined;
  "web.orchestrator.looks.gardener.blurb": undefined;
  "web.orchestrator.looks.gardener.name": undefined;
  "web.orchestrator.looks.grandpa.blurb": undefined;
  "web.orchestrator.looks.grandpa.name": undefined;
  "web.orchestrator.looks.robot.blurb": undefined;
  "web.orchestrator.looks.robot.name": undefined;
  "web.orchestrator.orchestrator.about": undefined;
  "web.orchestrator.orchestrator.all": undefined;
  "web.orchestrator.orchestrator.heard": undefined;
  "web.orchestrator.orchestrator.intro": undefined;
  "web.orchestrator.orchestrator.look": { readonly name: string | number };
  "web.orchestrator.orchestrator.profile": undefined;
  "web.orchestrator.orchestrator.quiet": undefined;
  "web.orchestrator.orchestrator.tab.archive": undefined;
  "web.orchestrator.orchestrator.tab.memory": undefined;
  "web.orchestrator.orchestrator.tab.trajectory": undefined;
  "web.orchestrator.orchestrator.tab.voice": undefined;
  "web.orchestrator.orchestrator.tabs": undefined;
  "web.orchestrator.orchestrator.title": undefined;
  "web.orchestrator.orchestrator.trajectory": undefined;
  "web.orchestrator.pet.bluecat": undefined;
  "web.orchestrator.pet.dog": undefined;
  "web.orchestrator.pet.ragdoll": undefined;
  "web.project.add": undefined;
  "web.project.all": undefined;
  "web.project.allLine": undefined;
  "web.project.busiest": { readonly day: string | number; readonly n: string | number };
  "web.project.busy": undefined;
  "web.project.byLines": undefined;
  "web.project.calendar": undefined;
  "web.project.cancel": undefined;
  "web.project.code": undefined;
  "web.project.commitCount": undefined;
  "web.project.commits": { readonly n: string | number };
  "web.project.copied": { readonly path: string | number };
  "web.project.copyPath": undefined;
  "web.project.countedAgo": { readonly ago: string | number };
  "web.project.counting": undefined;
  "web.project.create": undefined;
  "web.project.current": undefined;
  "web.project.dayCommits": { readonly level: string | number; readonly n: string | number };
  "web.project.days": { readonly n: number };
  "web.project.daysWorked": undefined;
  "web.project.download": undefined;
  "web.project.downloading": undefined;
  "web.project.empty": undefined;
  "web.project.fewer": undefined;
  "web.project.finding": undefined;
  "web.project.firstCommit": undefined;
  "web.project.fresh": undefined;
  "web.project.github": undefined;
  "web.project.githubAddress": undefined;
  "web.project.githubHint": undefined;
  "web.project.how": undefined;
  "web.project.inYear": undefined;
  "web.project.install": undefined;
  "web.project.kinds": { readonly n: string | number };
  "web.project.languages": undefined;
  "web.project.level.0": undefined;
  "web.project.level.1": undefined;
  "web.project.level.2": undefined;
  "web.project.level.3": undefined;
  "web.project.level.4": undefined;
  "web.project.lines": { readonly n: string | number };
  "web.project.linesAndFiles": { readonly files: string | number; readonly lines: string | number };
  "web.project.list": undefined;
  "web.project.longest": undefined;
  "web.project.making": undefined;
  "web.project.more": undefined;
  "web.project.name": undefined;
  "web.project.nameExample": undefined;
  "web.project.nameHint": undefined;
  "web.project.noCommits": undefined;
  "web.project.noCommitsThatDay": undefined;
  "web.project.noTokei": undefined;
  "web.project.none": undefined;
  "web.project.notCopied": undefined;
  "web.project.notGit": undefined;
  "web.project.or": undefined;
  "web.project.otherLang": undefined;
  "web.project.readingCommits": undefined;
  "web.project.recency.day": undefined;
  "web.project.recency.label": { readonly label: string | number };
  "web.project.recency.month": undefined;
  "web.project.recency.never": undefined;
  "web.project.recency.older": undefined;
  "web.project.recency.quarter": undefined;
  "web.project.recency.week": undefined;
  "web.project.recount": undefined;
  "web.project.repos": undefined;
  "web.project.rest": { readonly commits: string | number; readonly people: string | number };
  "web.project.rows.0": undefined;
  "web.project.rows.1": undefined;
  "web.project.rows.2": undefined;
  "web.project.rows.3": undefined;
  "web.project.rows.4": undefined;
  "web.project.rows.5": undefined;
  "web.project.rows.6": undefined;
  "web.project.thenRecount": undefined;
  "web.project.times": { readonly n: string | number };
  "web.project.title": undefined;
  "web.project.uncounted": undefined;
  "web.project.whatLanguages": undefined;
  "web.project.who": undefined;
  "web.project.whoWhen": undefined;
  "web.project.year": undefined;
  "web.project.yearLabel": { readonly commits: string | number; readonly days: string | number };
  "web.runtime.acceptsAll": undefined;
  "web.runtime.account": undefined;
  "web.runtime.afterInstall": undefined;
  "web.runtime.agents": undefined;
  "web.runtime.auto": undefined;
  "web.runtime.available": undefined;
  "web.runtime.balance": { readonly enough: boolean; readonly provider: string | number };
  "web.runtime.binPath": undefined;
  "web.runtime.binPathHint": { readonly id: string | number };
  "web.runtime.budget": undefined;
  "web.runtime.budgetHint": { readonly pi: boolean; readonly spent: string | number };
  "web.runtime.budgetLabel": undefined;
  "web.runtime.bundled": undefined;
  "web.runtime.can": undefined;
  "web.runtime.capability.accountUsage": undefined;
  "web.runtime.capability.checkUpdate": undefined;
  "web.runtime.capability.listModels": undefined;
  "web.runtime.capability.mcpServers": undefined;
  "web.runtime.capability.skills": undefined;
  "web.runtime.capability.tools": undefined;
  "web.runtime.capability.upgrade": undefined;
  "web.runtime.checkedAt": { readonly clock: string | number };
  "web.runtime.checking": undefined;
  "web.runtime.commandLine": undefined;
  "web.runtime.default": undefined;
  "web.runtime.defaultEffort": undefined;
  "web.runtime.defaultModel": undefined;
  "web.runtime.defaultModelHint": undefined;
  "web.runtime.disabled": undefined;
  "web.runtime.discard": undefined;
  "web.runtime.effort": undefined;
  "web.runtime.enabled": undefined;
  "web.runtime.enabledHint": undefined;
  "web.runtime.env": undefined;
  "web.runtime.envHint": undefined;
  "web.runtime.inProcess": undefined;
  "web.runtime.intro": undefined;
  "web.runtime.left": { readonly pct: string | number };
  "web.runtime.library.body": undefined;
  "web.runtime.library.bodyExample": undefined;
  "web.runtime.library.bodyHint": undefined;
  "web.runtime.library.book": undefined;
  "web.runtime.library.description": undefined;
  "web.runtime.library.descriptionHint": undefined;
  "web.runtime.library.inUse": { readonly n: string | number };
  "web.runtime.library.installed": { readonly count: string | number };
  "web.runtime.library.installedNote": undefined;
  "web.runtime.library.name": undefined;
  "web.runtime.library.nameHint": undefined;
  "web.runtime.library.nameLabel": undefined;
  "web.runtime.library.newSkill": undefined;
  "web.runtime.library.noMatch": undefined;
  "web.runtime.library.noRuntimes": undefined;
  "web.runtime.library.noSkills": undefined;
  "web.runtime.library.nobody": undefined;
  "web.runtime.library.noneReported": undefined;
  "web.runtime.library.own": { readonly count: string | number };
  "web.runtime.library.removeIt": undefined;
  "web.runtime.library.search": undefined;
  "web.runtime.library.searchHint": undefined;
  "web.runtime.library.when": undefined;
  "web.runtime.library.whenHint": undefined;
  "web.runtime.library.where": undefined;
  "web.runtime.library.who": undefined;
  "web.runtime.list": undefined;
  "web.runtime.makeAgent": undefined;
  "web.runtime.maxWorking": undefined;
  "web.runtime.maxWorkingHint": undefined;
  "web.runtime.mcp": undefined;
  "web.runtime.modelCount": { readonly n: string | number };
  "web.runtime.models": undefined;
  "web.runtime.noEffort": undefined;
  "web.runtime.noLimit": undefined;
  "web.runtime.noModels": undefined;
  "web.runtime.noRuntimes": undefined;
  "web.runtime.noSteer": undefined;
  "web.runtime.noUsage": undefined;
  "web.runtime.none": undefined;
  "web.runtime.noneYet": undefined;
  "web.runtime.notFound": undefined;
  "web.runtime.notHere": undefined;
  "web.runtime.ownDefault": undefined;
  "web.runtime.ownProcess": undefined;
  "web.runtime.queries": undefined;
  "web.runtime.quota.hours": { readonly h: number };
  "web.runtime.quota.minutes": { readonly m: string | number };
  "web.runtime.quota.now": undefined;
  "web.runtime.quota.on": { readonly weekday: string | number };
  "web.runtime.quota.oneWeek": undefined;
  "web.runtime.quota.session": undefined;
  "web.runtime.quota.signedOut": undefined;
  "web.runtime.quota.unreported": undefined;
  "web.runtime.quota.week": { readonly models: string | number };
  "web.runtime.quota.weekdays.0": undefined;
  "web.runtime.quota.weekdays.1": undefined;
  "web.runtime.quota.weekdays.2": undefined;
  "web.runtime.quota.weekdays.3": undefined;
  "web.runtime.quota.weekdays.4": undefined;
  "web.runtime.quota.weekdays.5": undefined;
  "web.runtime.quota.weekdays.6": undefined;
  "web.runtime.quota.weekly": undefined;
  "web.runtime.reading": undefined;
  "web.runtime.recheck": undefined;
  "web.runtime.refused": undefined;
  "web.runtime.resets": { readonly moment: string | number };
  "web.runtime.save": undefined;
  "web.runtime.settings": undefined;
  "web.runtime.signedOut": { readonly runtime: string | number };
  "web.runtime.skills": undefined;
  "web.runtime.spentToday": { readonly spent: string | number };
  "web.runtime.spentTodayBudget": { readonly budget: string | number; readonly spent: string | number };
  "web.runtime.steer": undefined;
  "web.runtime.subscription": { readonly tier: string | number };
  "web.runtime.title": undefined;
  "web.runtime.tools": undefined;
  "web.runtime.unlimited": undefined;
  "web.runtime.unreadable": { readonly why: string | number };
  "web.runtime.unreported": undefined;
  "web.runtime.unsupported": undefined;
  "web.runtime.unsupportedWhy": { readonly why: string | number };
  "web.runtime.usedBy": { readonly n: string | number };
  "web.runtime.windowLeft": { readonly label: string | number; readonly pct: string | number };
  "web.session.log.all": undefined;
  "web.session.log.failed": undefined;
  "web.session.log.farm": undefined;
  "web.session.log.fold": undefined;
  "web.session.log.heard": undefined;
  "web.session.log.less": undefined;
  "web.session.log.live": undefined;
  "web.session.log.noOutput": undefined;
  "web.session.log.ok": undefined;
  "web.session.log.pending": undefined;
  "web.session.log.process": undefined;
  "web.session.log.recalled": undefined;
  "web.session.log.running": undefined;
  "web.session.log.said": undefined;
  "web.session.log.see": { readonly n: string | number };
  "web.session.log.steps": { readonly n: string | number; readonly took: string | number };
  "web.session.log.subagentGot": undefined;
  "web.session.log.subagentSaid": undefined;
  "web.session.log.subagentThought": undefined;
  "web.session.log.thought": undefined;
  "web.session.log.told": undefined;
  "web.session.log.tool": { readonly name: string | number };
  "web.session.log.unfold": undefined;
  "web.session.runs.earlier": undefined;
  "web.session.runs.farm.channel_message_list": undefined;
  "web.session.runs.farm.channel_message_send": undefined;
  "web.session.runs.farm.channel_unread_list": undefined;
  "web.session.runs.farm.other": { readonly tool: string | number };
  "web.session.runs.farm.session_list": undefined;
  "web.session.runs.issue": undefined;
  "web.session.runs.process": undefined;
  "web.session.runs.span.cache": undefined;
  "web.session.runs.span.error": undefined;
  "web.session.runs.span.farm": undefined;
  "web.session.runs.span.heard": undefined;
  "web.session.runs.span.recalled": undefined;
  "web.session.runs.span.retry": undefined;
  "web.session.runs.span.said": undefined;
  "web.session.runs.span.thinking": undefined;
  "web.session.runs.span.tool": undefined;
  "web.session.runs.subagentGot": undefined;
  "web.session.runs.tag.said": undefined;
  "web.session.runs.tag.subagentSaid": undefined;
  "web.session.runs.tag.subagentThought": undefined;
  "web.session.runs.tag.thought": undefined;
  "web.session.runs.tag.usage": undefined;
  "web.session.runs.thoughtFor": { readonly n: string | number; readonly took: string | number };
  "web.session.runs.told": undefined;
  "web.session.runs.unasked": undefined;
  "web.session.runs.usedTools": { readonly n: number };
  "web.session.trajectory.cacheHit": { readonly pct: string | number };
  "web.session.trajectory.earlier": undefined;
  "web.session.trajectory.failed": undefined;
  "web.session.trajectory.here": undefined;
  "web.session.trajectory.hired": { readonly ago: string | number };
  "web.session.trajectory.hiredAndLeft": { readonly hired: string | number; readonly left: string | number };
  "web.session.trajectory.input": undefined;
  "web.session.trajectory.lane.asked": undefined;
  "web.session.trajectory.lane.model": undefined;
  "web.session.trajectory.lane.tool": undefined;
  "web.session.trajectory.marked": undefined;
  "web.session.trajectory.modelTime": { readonly took: string | number };
  "web.session.trajectory.neverSent": undefined;
  "web.session.trajectory.noMatch": undefined;
  "web.session.trajectory.noOutput": undefined;
  "web.session.trajectory.ok": undefined;
  "web.session.trajectory.output": undefined;
  "web.session.trajectory.pending": undefined;
  "web.session.trajectory.pick": undefined;
  "web.session.trajectory.quiet": undefined;
  "web.session.trajectory.run": { readonly n: string | number };
  "web.session.trajectory.running": undefined;
  "web.session.trajectory.runs": { readonly n: number };
  "web.session.trajectory.search": undefined;
  "web.session.trajectory.searchHint": undefined;
  "web.session.trajectory.sent": undefined;
  "web.session.trajectory.steps": { readonly n: number };
  "web.session.trajectory.tokens": { readonly input: string | number; readonly output: string | number };
  "web.session.trajectory.tool": { readonly name: string | number };
  "web.session.trajectory.toolTime": { readonly took: string | number };
  "web.session.trajectory.want": undefined;
  "web.session.trajectory.wantHint": undefined;
  "web.session.trajectory.wrong": undefined;
  "web.setting.about.check": undefined;
  "web.setting.about.checking": undefined;
  "web.setting.about.copied": undefined;
  "web.setting.about.copy": undefined;
  "web.setting.about.download": undefined;
  "web.setting.about.downloading": { readonly next: string | number; readonly percent: string | number };
  "web.setting.about.failed": { readonly why: string | number };
  "web.setting.about.files": undefined;
  "web.setting.about.home": undefined;
  "web.setting.about.homeHint": undefined;
  "web.setting.about.manual.diskImage": { readonly next: string | number };
  "web.setting.about.manual.noBuild": { readonly next: string | number };
  "web.setting.about.manual.readOnly": { readonly next: string | number };
  "web.setting.about.manual.translocated": { readonly next: string | number };
  "web.setting.about.newFarmQuestion": undefined;
  "web.setting.about.ready": { readonly next: string | number };
  "web.setting.about.readyNewFarm": { readonly next: string | number };
  "web.setting.about.restart": undefined;
  "web.setting.about.restartQuestion": undefined;
  "web.setting.about.reveal": undefined;
  "web.setting.about.settings": undefined;
  "web.setting.about.settingsHint": undefined;
  "web.setting.about.upToDate": undefined;
  "web.setting.about.update": undefined;
  "web.setting.about.updateHint": undefined;
  "web.setting.about.version": undefined;
  "web.setting.about.versionHint": undefined;
  "web.setting.about.workingQuestion": { readonly n: string | number };
  "web.setting.appearance.intro": undefined;
  "web.setting.appearance.scale": undefined;
  "web.setting.appearance.scaleHint": undefined;
  "web.setting.appearance.theme": undefined;
  "web.setting.appearance.themeHint": undefined;
  "web.setting.appearance.themes.dark": undefined;
  "web.setting.appearance.themes.light": undefined;
  "web.setting.appearance.themes.system": undefined;
  "web.setting.general.languageHint": undefined;
  "web.setting.general.start": undefined;
  "web.setting.general.startHint": undefined;
  "web.setting.general.starts.farm": undefined;
  "web.setting.general.starts.workbench": undefined;
  "web.setting.github.cli": undefined;
  "web.setting.github.cliHint": undefined;
  "web.setting.github.login": undefined;
  "web.setting.github.loginHint": undefined;
  "web.setting.github.noGh": undefined;
  "web.setting.github.notLoggedIn": undefined;
  "web.setting.github.note": undefined;
  "web.setting.github.recheck": undefined;
  "web.setting.groups.connect": undefined;
  "web.setting.groups.helpers": undefined;
  "web.setting.groups.options": undefined;
  "web.setting.groups.voice": undefined;
  "web.setting.keys.deepseekHint": undefined;
  "web.setting.keys.saved": undefined;
  "web.setting.language.en": undefined;
  "web.setting.language.label": undefined;
  "web.setting.language.line": undefined;
  "web.setting.language.title": undefined;
  "web.setting.language.zh": undefined;
  "web.setting.memory.intro": undefined;
  "web.setting.models.deepseekHint": undefined;
  "web.setting.models.intro": undefined;
  "web.setting.nav.about": undefined;
  "web.setting.nav.appearance": undefined;
  "web.setting.nav.call": undefined;
  "web.setting.nav.chat": undefined;
  "web.setting.nav.devices": undefined;
  "web.setting.nav.dictation": undefined;
  "web.setting.nav.general": undefined;
  "web.setting.nav.label": undefined;
  "web.setting.nav.memory": undefined;
  "web.setting.nav.models": undefined;
  "web.setting.nav.search": undefined;
  "web.setting.nav.skills": undefined;
  "web.setting.nav.width": undefined;
  "web.setting.scope.device": undefined;
  "web.setting.scope.farm": undefined;
  "web.setting.source.address": { readonly label: string | number };
  "web.setting.source.closed": undefined;
  "web.setting.source.configure": { readonly label: string | number };
  "web.setting.source.enable": { readonly label: string | number };
  "web.setting.source.enabled": undefined;
  "web.setting.source.everything": undefined;
  "web.setting.source.everythingHint": undefined;
  "web.setting.source.key": { readonly label: string | number };
  "web.setting.source.keyHint": undefined;
  "web.setting.source.noKey": undefined;
  "web.setting.source.off": undefined;
  "web.setting.source.on": undefined;
  "web.setting.source.read": undefined;
  "web.setting.source.readHint": undefined;
  "web.setting.source.user": { readonly label: string | number };
  "web.setting.source.userHint": undefined;
  "web.setting.source.write": undefined;
  "web.setting.source.writeHint": undefined;
  "web.setting.words.about": undefined;
  "web.setting.words.appearance": undefined;
  "web.setting.words.call": undefined;
  "web.setting.words.chat": undefined;
  "web.setting.words.devices": undefined;
  "web.setting.words.dictation": undefined;
  "web.setting.words.general": undefined;
  "web.setting.words.github": undefined;
  "web.setting.words.memory": undefined;
  "web.setting.words.models": undefined;
  "web.setting.words.moss": undefined;
  "web.setting.words.skills": undefined;
  "web.tree.aboutToFall": undefined;
  "web.tree.allHelpers": undefined;
  "web.tree.allProjects": undefined;
  "web.tree.approach": undefined;
  "web.tree.back": undefined;
  "web.tree.byHelper": undefined;
  "web.tree.byProject": undefined;
  "web.tree.day": { readonly n: string | number };
  "web.tree.distilled": { readonly n: string | number };
  "web.tree.earliest": undefined;
  "web.tree.everyProject": undefined;
  "web.tree.experience": undefined;
  "web.tree.fading": { readonly n: string | number };
  "web.tree.fadingNote": undefined;
  "web.tree.farm": undefined;
  "web.tree.fold": undefined;
  "web.tree.from": undefined;
  "web.tree.grew": { readonly n: string | number };
  "web.tree.grewInto": undefined;
  "web.tree.grewTo": undefined;
  "web.tree.grown": undefined;
  "web.tree.insight": undefined;
  "web.tree.intent": undefined;
  "web.tree.kind.fruit": undefined;
  "web.tree.kind.leaf": undefined;
  "web.tree.kind.seed": undefined;
  "web.tree.look": undefined;
  "web.tree.lookUp": undefined;
  "web.tree.nextStage": { readonly rounds: string | number; readonly stage: string | number };
  "web.tree.noSeeds": undefined;
  "web.tree.noted": { readonly n: string | number };
  "web.tree.notedBy": undefined;
  "web.tree.now": undefined;
  "web.tree.often": undefined;
  "web.tree.past": undefined;
  "web.tree.recalled": { readonly n: string | number };
  "web.tree.recent": undefined;
  "web.tree.scene": undefined;
  "web.tree.seeds": { readonly n: string | number };
  "web.tree.sky": undefined;
  "web.tree.skyHint": undefined;
  "web.tree.sow": undefined;
  "web.tree.sown": { readonly body: string | number };
  "web.tree.stage.1": undefined;
  "web.tree.stage.2": undefined;
  "web.tree.stage.3": undefined;
  "web.tree.stage.4": undefined;
  "web.tree.stage.5": undefined;
  "web.tree.stats": { readonly days: string | number; readonly recalls: string | number; readonly rounds: string | number };
  "web.tree.title": undefined;
  "web.tree.together": { readonly n: string | number };
  "web.tree.waiting": undefined;
  "web.ui.pixel.close": undefined;
  "web.ui.pixel.drop": { readonly chip: string | number };
  "web.ui.pixel.noticeTitle.error": undefined;
  "web.ui.pixel.noticeTitle.info": undefined;
  "web.ui.pixel.noticeTitle.warn": undefined;
  "web.ui.pixel.optional": undefined;
  "web.ui.pixel.sound.group.field": undefined;
  "web.ui.pixel.sound.group.reward": undefined;
  "web.ui.pixel.sound.group.tools": undefined;
  "web.ui.pixel.sound.group.ui": undefined;
  "web.ui.pixel.sound.group.voice": undefined;
  "web.ui.pixel.sound.group.yard": undefined;
  "web.ui.pixel.sound.label.achievement": undefined;
  "web.ui.pixel.sound.label.arrive": undefined;
  "web.ui.pixel.sound.label.bug": undefined;
  "web.ui.pixel.sound.label.close": undefined;
  "web.ui.pixel.sound.label.coin": undefined;
  "web.ui.pixel.sound.label.harvest": undefined;
  "web.ui.pixel.sound.label.levelUp": undefined;
  "web.ui.pixel.sound.label.meow": undefined;
  "web.ui.pixel.sound.label.mew": undefined;
  "web.ui.pixel.sound.label.nope": undefined;
  "web.ui.pixel.sound.label.open": undefined;
  "web.ui.pixel.sound.label.pant": undefined;
  "web.ui.pixel.sound.label.pick": undefined;
  "web.ui.pixel.sound.label.plant": undefined;
  "web.ui.pixel.sound.label.purr": undefined;
  "web.ui.pixel.sound.label.ring": undefined;
  "web.ui.pixel.sound.label.ripe": undefined;
  "web.ui.pixel.sound.label.rustle": undefined;
  "web.ui.pixel.sound.label.shovel": undefined;
  "web.ui.pixel.sound.label.splash": undefined;
  "web.ui.pixel.sound.label.spray": undefined;
  "web.ui.pixel.sound.label.tap": undefined;
  "web.ui.pixel.sound.label.thud": undefined;
  "web.ui.pixel.sound.label.voiceOff": undefined;
  "web.ui.pixel.sound.label.voiceOn": undefined;
  "web.ui.pixel.sound.label.water": undefined;
  "web.ui.pixel.sound.label.weed": undefined;
  "web.ui.pixel.sound.label.woof": undefined;
  "web.ui.pixel.sound.label.yip": undefined;
  "web.voice.call.agora": { readonly code: string | number; readonly msg: string | number };
  "web.voice.call.cannotHear": { readonly why: string | number };
  "web.voice.call.noMic": undefined;
  "web.voice.call.renew": { readonly why: string | number };
  "web.voice.choices.answer.agora": undefined;
  "web.voice.choices.answer.openai": undefined;
  "web.voice.choices.area.AP": undefined;
  "web.voice.choices.area.CN": undefined;
  "web.voice.choices.area.EU": undefined;
  "web.voice.choices.area.US": undefined;
  "web.voice.choices.asr.ares": undefined;
  "web.voice.choices.asr.microsoft": undefined;
  "web.voice.choices.language.en-US": undefined;
  "web.voice.choices.language.ja-JP": undefined;
  "web.voice.choices.language.ko-KR": undefined;
  "web.voice.choices.language.zh-CN": undefined;
  "web.voice.choices.language.zh-HK": undefined;
  "web.voice.choices.language.zh-TW": undefined;
  "web.voice.choices.minimax.audiobookFemale": undefined;
  "web.voice.choices.minimax.audiobookMale": undefined;
  "web.voice.choices.minimax.badao": undefined;
  "web.voice.choices.minimax.gentle": undefined;
  "web.voice.choices.minimax.girl": undefined;
  "web.voice.choices.minimax.jingying": undefined;
  "web.voice.choices.minimax.mature": undefined;
  "web.voice.choices.minimax.presenterFemale": undefined;
  "web.voice.choices.minimax.presenterMale": undefined;
  "web.voice.choices.minimax.qingse": undefined;
  "web.voice.choices.minimax.student": undefined;
  "web.voice.choices.minimax.sweet": undefined;
  "web.voice.choices.minimax.yujie": undefined;
  "web.voice.choices.number.idleSeconds": undefined;
  "web.voice.choices.number.interruptMs": undefined;
  "web.voice.choices.number.silenceMs": undefined;
  "web.voice.dictation.cannot": { readonly why: string | number };
  "web.voice.dictation.failed": { readonly why: string | number };
  "web.voice.dictation.label": undefined;
  "web.voice.dictation.noMic": undefined;
  "web.voice.dictation.nothing": undefined;
  "web.voice.dictation.recording": undefined;
  "web.voice.dictation.start": undefined;
  "web.voice.dictation.stop": undefined;
  "web.voice.dictation.transcribing": undefined;
  "web.voice.dictation.unset": undefined;
  "web.voice.moss.closed": undefined;
  "web.voice.moss.connecting": undefined;
  "web.voice.moss.defaultInstructions": undefined;
  "web.voice.moss.down": undefined;
  "web.voice.moss.events": undefined;
  "web.voice.moss.eventsHint": undefined;
  "web.voice.moss.hangUp": undefined;
  "web.voice.moss.instructions": undefined;
  "web.voice.moss.intro": undefined;
  "web.voice.moss.mute": undefined;
  "web.voice.moss.notInChat": undefined;
  "web.voice.moss.nothingSaid": undefined;
  "web.voice.moss.persona": undefined;
  "web.voice.moss.personaHint": undefined;
  "web.voice.moss.qos.ahead": undefined;
  "web.voice.moss.qos.aheadTip": undefined;
  "web.voice.moss.qos.backlog": undefined;
  "web.voice.moss.qos.backlogTip": undefined;
  "web.voice.moss.qos.down": undefined;
  "web.voice.moss.qos.downTip": undefined;
  "web.voice.moss.qos.frames": undefined;
  "web.voice.moss.qos.framesTip": undefined;
  "web.voice.moss.qos.gaps": undefined;
  "web.voice.moss.qos.gapsTip": undefined;
  "web.voice.moss.qos.hint": undefined;
  "web.voice.moss.qos.ms": { readonly last: string | number; readonly mean: string | number };
  "web.voice.moss.qos.reply": undefined;
  "web.voice.moss.qos.replyTip": { readonly n: string | number };
  "web.voice.moss.qos.stops": undefined;
  "web.voice.moss.qos.stopsTip": undefined;
  "web.voice.moss.qos.title": undefined;
  "web.voice.moss.qos.up": undefined;
  "web.voice.moss.qos.upTip": undefined;
  "web.voice.moss.said": undefined;
  "web.voice.moss.talk": undefined;
  "web.voice.moss.tryIt": undefined;
  "web.voice.moss.unmute": undefined;
  "web.voice.moss.up": undefined;
  "web.voice.moss.you": undefined;
  "web.voice.voice.address": undefined;
  "web.voice.voice.answer.agora": undefined;
  "web.voice.voice.answer.deepseek": { readonly from: string | number };
  "web.voice.voice.answer.noDeepseek": undefined;
  "web.voice.voice.answer.openai": undefined;
  "web.voice.voice.answer.orchestrator": undefined;
  "web.voice.voice.area": undefined;
  "web.voice.voice.areaHint": undefined;
  "web.voice.voice.asr": undefined;
  "web.voice.voice.asrArea": undefined;
  "web.voice.voice.azureArea": undefined;
  "web.voice.voice.azureAreaHint": undefined;
  "web.voice.voice.console": undefined;
  "web.voice.voice.credentials": undefined;
  "web.voice.voice.deepgramModel": undefined;
  "web.voice.voice.deepseekModel": undefined;
  "web.voice.voice.deepseekModelLabel": undefined;
  "web.voice.voice.dictationAddress": undefined;
  "web.voice.voice.dictationAddressLabel": undefined;
  "web.voice.voice.dictationIntro": undefined;
  "web.voice.voice.dictationKey": undefined;
  "web.voice.voice.dictationModel": undefined;
  "web.voice.voice.dictationModelLabel": undefined;
  "web.voice.voice.dictationMossIntro": undefined;
  "web.voice.voice.dictationMossKey": undefined;
  "web.voice.voice.dictationOwn": undefined;
  "web.voice.voice.dictationVia": undefined;
  "web.voice.voice.hex": undefined;
  "web.voice.voice.hosted": undefined;
  "web.voice.voice.intro": undefined;
  "web.voice.voice.language": undefined;
  "web.voice.voice.languageHint": undefined;
  "web.voice.voice.listen": undefined;
  "web.voice.voice.listenParts": undefined;
  "web.voice.voice.llmAddress": undefined;
  "web.voice.voice.llmAddressLabel": undefined;
  "web.voice.voice.llmKey": undefined;
  "web.voice.voice.llmModel": undefined;
  "web.voice.voice.microsoft": undefined;
  "web.voice.voice.microsoftKey": undefined;
  "web.voice.voice.missing": undefined;
  "web.voice.voice.model": undefined;
  "web.voice.voice.moss.checking": undefined;
  "web.voice.voice.moss.console": undefined;
  "web.voice.voice.moss.keyHint": undefined;
  "web.voice.voice.moss.ok": undefined;
  "web.voice.voice.moss.verify": undefined;
  "web.voice.voice.nextCall": undefined;
  "web.voice.voice.noSettings": { readonly why: string | number };
  "web.voice.voice.orchestratorPage": undefined;
  "web.voice.voice.period": undefined;
  "web.voice.voice.persona.azureVoice": undefined;
  "web.voice.voice.persona.failure": undefined;
  "web.voice.voice.persona.failureHint": undefined;
  "web.voice.voice.persona.greeting": undefined;
  "web.voice.voice.persona.greetingHint": undefined;
  "web.voice.voice.persona.intro": undefined;
  "web.voice.voice.persona.microsoftVoice": undefined;
  "web.voice.voice.persona.minimaxVoice": undefined;
  "web.voice.voice.persona.noSample": undefined;
  "web.voice.voice.persona.open": undefined;
  "web.voice.voice.persona.openParts": undefined;
  "web.voice.voice.persona.openaiVoice": undefined;
  "web.voice.voice.persona.ownCall": undefined;
  "web.voice.voice.persona.page": undefined;
  "web.voice.voice.persona.persona": undefined;
  "web.voice.voice.persona.personaHint": undefined;
  "web.voice.voice.persona.play": { readonly name: string | number };
  "web.voice.voice.persona.sample": { readonly greeting: string | number };
  "web.voice.voice.persona.speak": undefined;
  "web.voice.voice.persona.stop": { readonly name: string | number };
  "web.voice.voice.persona.tts": undefined;
  "web.voice.voice.persona.ttsArea": undefined;
  "web.voice.voice.persona.ttsModel": undefined;
  "web.voice.voice.persona.voice": undefined;
  "web.voice.voice.persona.voiceId": undefined;
  "web.voice.voice.range": { readonly fallback: string | number; readonly max: string | number; readonly min: string | number };
  "web.voice.voice.ready": undefined;
  "web.voice.voice.saved": undefined;
  "web.voice.voice.section.label": undefined;
  "web.voice.voice.speechServer": undefined;
  "web.voice.voice.think": undefined;
  "web.voice.voice.who": undefined;
}

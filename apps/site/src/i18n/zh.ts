import type { IconName } from "../ui/icons";

export const zh = {
  lang: "zh-CN",
  home: "/",
  other: { label: "EN", href: "/en/", name: "English" },
  title: "码农场物语 · VibeValley",
  description: "在 Mac 上把工单交给 Claude Code、Codex 等编码 agent。到纸艺农场看进度，在原生工作台查看改动、运行检查、合进主分支。",
  nav: { how: "怎么玩", features: "能做什么", screens: "看看农场", start: "开始种地", github: "GitHub" },
  hero: {
    name: "码农场物语",
    aka: "VibeValley",
    tagline: "写代码，如收菜。",
    lead: "一群编码 agent，住在一座手作纸艺农场里，替你写代码、跑测试。",
    // A day on the farm, a line for each hour as the page goes down; every line ends on the same rhyme.
    verses: {
      morning: ["清早说一句，", "活儿派出来。"],
      day: ["帮工满地跑，", "浇水又除害。"],
      evening: ["傍晚田头坐，", "汇报一排排。"],
      night: ["夜里你睡下，", "它们接着栽。"],
    },
    primary: "查看 Mac 版源码",
    secondary: "怎么玩",
    hours: "换个时辰",
    hour: { morning: "清晨", day: "白天", evening: "傍晚", night: "夜里" },
    scroll: "往下看",
  },
  parade: {
    title: "帮工上工了",
    text: "七种小动物，四套衣服。每个帮工都是你电脑上真实的编码 agent：Claude Code、Codex、OpenCode，或 VibeValley 自带的那一台。",
  },
  harvest: {
    title: ["一觉醒过来，", "满园都是菜。"],
    text: "收成单一摊开：几个提交、改了哪里、会不会冲突。看好了，点一下，收进来。",
    // The same job as the story's (how.steps): a ticket's harvest list, as the app shows it.
    card: { title: "收成单", job: "clock-in：查询打卡记录的接口", commits: "个提交", files: "个文件", lines: "行", clean: "不会冲突", take: "收进来" },
  },
  how: {
    title: "一件活是怎么种出来的",
    git: { branch: "vibevalley/issue-3", worktree: "自己的 worktree", commits: "个提交", tests: "测试", merged: "收进 main" },
    steps: [
      { icon: "chat" as IconName, title: "说一句", text: "对助手说：「在 clock-in 里加一个查询打卡记录的接口，写测试。」打字也行，按住说话也行。" },
      {
        icon: "seedling" as IconName,
        title: "派活",
        text: "助手把这句话拆成工单，按档案挑一个帮工，在项目里给它开独立的分支和 worktree，像在空地上播下种子。",
      },
      {
        icon: "terminal" as IconName,
        title: "干活",
        text: "帮工读代码、改文件、跑测试、提交。地里的庄稼跟着它的真实进度长：读代码时发芽，改文件时长叶，做完了结出麦子。",
      },
      { icon: "harvest" as IconName, title: "收获", text: "你看过收成清单：几个提交、改了什么、会不会冲突，说「完成」才合进主分支；冲突了让它自己解决。" },
    ],
  },
  features: {
    title: "能做什么",
    // The farm's numbers (src/base/facts.ts), what each counts.
    tally: {
      views: "种视图：工作台和纸艺农场",
      looks: "种帮工：7 种小动物 × 4 套衣服",
      plots: "块地一起开工，每个仓库默认 3 块",
      achievements: "个成就",
      games: "个农场掌机小游戏",
      connectors: "个聊天软件能派活：微信、飞书、QQ",
    },
    items: [
      {
        icon: "board" as IconName,
        title: "一句话，派出一队人",
        text: "你只和助手说话，打字或按住说话都行。它把一句话拆成工单，按档案挑帮工、开分支，派出去；帮工在田头每件活的工单串里确认、提问、汇报，你随时插话。",
      },
      {
        icon: "branch" as IconName,
        title: "几块地一起种",
        text: "最多 6 个帮工同时干活（每个仓库默认 3 个），各在自己工单的 worktree 和分支上，互不踩脚。派不出去的排队，空出地来自动接上。",
      },
      {
        icon: "checklist" as IconName,
        title: "收不收由你",
        text: "做完的活先给你看提交、diff 和会不会冲突，你说「完成」才合进主分支。长任务拆成有先后的子工单；修 bug 先写一个会失败的验收测试，后面的子工单改不了它，最后一步要让它通过。",
      },
      {
        icon: "history" as IconName,
        title: "重开后接着看",
        text: "工单保留帮工的每轮记录。重新打开工作台，可以看上次汇报、还有哪条问题等你回答，也可以打开工作目录核对改动。",
      },
      {
        icon: "layout" as IconName,
        title: "工作台和农场",
        text: "工作台照 Linear：看板、工单详情、每一步的轨迹，哪一步不对就在那一步写评论。农场把同样的状态画出来：每个仓库是一座岛，在做的工单是一块地。",
      },
      {
        icon: "message" as IconName,
        title: "在聊天里派活",
        text: "在田头给助手分派工单，在工单串里回答帮工。配置微信、飞书或 QQ 连接后，也可以从对应聊天会话给助手发消息。",
      },
      {
        icon: "clock" as IconName,
        title: "少操心",
        text: "「每天九点跑一遍测试」这样的定时任务；不调模型的巡查，提醒没人回的提问、没动静的帮工、做完没收的活；每台农机的额度和每日预算，用完了就不再派。",
      },
      {
        icon: "home" as IconName,
        title: "全在你的电脑上",
        text: "服务端只听 127.0.0.1，数据在你的家目录（~/.vibevalley）；帮工的记性、档案、笔记和 Artifact 都在本机。",
      },
    ],
  },
  runtimes: {
    title: "你的农机",
    text: "帮工开的是你电脑上装好、登录好的编码 agent，由 oar 统一驱动，每台的额度和花费都看得见。VibeValley 也自带一台，只要 DeepSeek 的钥匙。",
    own: "VibeValley 自带",
  },
  devices: {
    title: "在 Mac 上照看农场",
    text: "每块地对应一张工单。点进地块看帮工的汇报，切到工作台审查改了哪些文件。",
    note: "工作台内置终端。打开工单的工作目录，就能在同一个窗口查看 Git 改动或运行项目检查。",
    shot: "Mac 原生应用里的纸艺农场与工作台导航",
  },
  screens: {
    title: "看看农场",
    items: [
      { image: "native-farm", caption: "Mac 上的农场：田地、帮工与工具栏" },
      { image: "native-workbench", caption: "工单看板：待办、开工中、等着看和已完成" },
      { image: "native-chat", caption: "Mac 工作台里的频道和田头消息" },
    ],
    open: "点开看大图",
    close: "关上",
  },
  safety: {
    title: "先说清楚",
    text: "帮工没有权限确认、不开沙箱，能在这台电脑上执行任意命令。服务端只听 127.0.0.1，不要把它暴露到网络上；只把你愿意交给编码 agent 的项目放进工作目录。",
    wip: "代码还在密集调整：概念、接口和存盘格式都还会变，可能会有 bug。升级前先备份农场的数据，遇到问题欢迎在 GitHub 上提 issue。",
  },
  start: {
    title: "开始种地",
    needs: "需要",
    list: [
      "Apple 芯片 Mac，macOS 14 或更新版本",
      "构建工具：Xcode（含 Swift 6）、Rust、Zig 和 Vite+（vp）",
      "使用帮工：在 Mac 上安装并登录 Claude Code、Codex 等编码 agent",
      "使用内置助手：配置 DeepSeek API 密钥",
    ],
    build: "从源码构建 Mac 版",
    more: "应用、DMG、更新用的 ZIP 和 release.json 都写入 apps/mac/dist。",
    readme: "阅读原生版 README",
    copy: "复制",
    copied: "复制好了",
  },
  footer: {
    license: "Apache 2.0 开源",
    top: "回到顶上",
  },
  lost: {
    title: "这块地什么也没种",
    text: "你要找的那一页不在农场里：也许挪了地方，也许从来没有过。",
    home: "回农场",
  },
};

/** What every language has to say. */
export type Copy = typeof zh;

// The page's words in Chinese, the site's first language (at /). en.ts has the same shape.

export const zh = {
  lang: 'zh-CN',
  home: '/',
  other: { label: 'EN', href: '/en/', name: 'English' },
  title: '码农场物语 · VibeValley',
  description: '一群写代码的小动物，等你来派活：用语音或打字指挥的编码 agent 团队，画成一座像素农场。跑在你自己的电脑上，开源。',
  nav: { how: '怎么玩', features: '能做什么', screens: '看看农场', start: '开始种地', github: 'GitHub' },
  hero: {
    name: '码农场物语',
    aka: 'VibeValley',
    tagline: '写代码，如收菜。',
    lead: '一群编码 agent，住在一座像素农场里，替你写代码、跑测试。',
    // A day on the farm, a line for each hour as the page goes down; every line ends on 菜's rhyme.
    verses: {
      morning: ['清早说一句，', '活儿派出来。'],
      day: ['帮工满地跑，', '浇水又除害。'],
      evening: ['傍晚田头坐，', '汇报一排排。'],
      night: ['夜里你睡下，', '它们接着栽。'],
    },
    primary: '在 GitHub 上看',
    secondary: '怎么玩',
    hours: '换个时辰',
    hour: { morning: '清晨', day: '白天', evening: '傍晚', night: '夜里' },
    scroll: '往下看',
  },
  parade: {
    title: '帮工上工了',
    text: '七种小动物，四套衣服。每个帮工都是你电脑上真实的编码 agent：pi、Claude Code、Codex，或 VibeValley 自带的那一台。',
  },
  harvest: {
    title: ['一觉醒过来，', '满园都是菜。'],
    text: '收成单一摊开：几个提交、改了哪里、会不会冲突。看好了，点一下，收进来。',
    // The same job as the story's (how.steps): a ticket's harvest list, as the app shows it.
    card: { title: '收成单', job: 'clock-in：查询打卡记录的接口', commits: '个提交', files: '个文件', lines: '行', clean: '不会冲突', take: '收进来' },
  },
  how: {
    title: '一件活是怎么种出来的',
    // The job's branch as the story goes (a helper's branch is vibevalley/<helper>-<time>).
    git: { branch: 'vibevalley/w3-mgr2k', worktree: '自己的 worktree', commits: '个提交', tests: '测试', merged: '收进 main' },
    steps: [
      { icon: 'act-speaking_text', title: '说一句', text: '对管家说：「在 clock-in 里加一个查询打卡记录的接口，写测试。」打字也行，按住说话也行。' },
      { icon: 'icon-seeds', title: '派活', text: '管家挑一个合适的帮工，在项目里给它开独立的分支和 worktree，像在空地上播下种子。' },
      { icon: 'act-run_command', title: '干活', text: '帮工读代码、改文件、跑测试、提交。地里的庄稼跟着它的真实进度长：读代码时发芽，改文件时长叶，做完了结出麦子。' },
      { icon: 'icon-harvest', title: '收获', text: '你看过收成清单：几个提交、改了什么、会不会冲突，确认了才合进主分支；冲突了让它自己解决。' },
    ],
  },
  features: {
    title: '能做什么',
    // The farm's numbers (lib/facts.ts), what each counts.
    tally: {
      machines: '台农机：自带的、pi、Claude Code、Codex',
      looks: '种帮工：7 种小动物 × 4 套衣服',
      plots: '块地一起开工',
      achievements: '个成就',
      games: '个手机小游戏',
      connectors: '个聊天软件能派活：微信、飞书、QQ',
    },
    items: [
      { icon: 'icon-board', title: '田头群聊', text: '你、管家和帮工在同一个群里说话。每件活下面挂一个工单串，帮工在里面确认、提问、汇报，你随时插话；还能按项目开频道。' },
      { icon: 'icon-plan', title: '种植计划', text: '长任务先拆成一张有先后的步骤图，你看过草稿再开工。修 bug 时第一步先写一个会失败的验收测试，后面的步骤谁也改不动它。' },
      { icon: 'button-mic', title: '张嘴就派活', text: '按住说话，语音管家听你说完，交给同一个管家去派活。' },
      { icon: 'icon-tasks', title: '工单看板和地图', text: '每次种植是一张工单：待办、处理中、等你看、已关。地满了就排队，空出地来自动开工。地图上每个项目是一座小岛，看得见哪块地在干活、还能派几件。' },
      { icon: 'icon-clock', title: '定时和巡查', text: '「每天九点跑一遍测试」这样的定时任务；不调模型的巡查，提醒没人回的提问、没动静的帮工、做完没收的活。' },
      { icon: 'icon-pigeon', title: '从外面派活', text: '把田头接到微信、飞书或 QQ，只认你自己的账号。手机或另一台电脑经「院门」连进来。' },
      { icon: 'icon-coin', title: '管住花费', text: '每台农机的额度、今天花了多少、每日预算；额度快用完时提醒，用完了就不再派。' },
      { icon: 'icon-trophy', title: '农场本身', text: '昼夜和光照，狗和会走路的帮工，成就和称号，还有一部能玩小游戏的手机。' },
    ],
  },
  runtimes: {
    title: '你的农机',
    text: '帮工开的是你电脑上装好、登录好的编码 agent，每台的额度和花费都看得见。VibeValley 也自带一台，只要 DeepSeek 的钥匙。',
    own: 'VibeValley 自带',
  },
  devices: {
    title: '在哪都能看农场',
    text: '界面是 Flutter 写的，Mac、iPhone、安卓用的是同一套。农场跑在你的 Mac 上；手机上的 VibeValley 扫一下「院门」的二维码，就连进同一个农场：在田头派活、看工单、收帮工的汇报。另一台 Mac 粘贴配对链接也能连。不在家时，把田头接到微信、飞书或 QQ。',
    platforms: ['macOS', 'iPhone', '安卓'],
    note: '手机版暂时要用同一份代码自己构建；院门只在信得过的网络里开。',
    shots: { mac: 'Mac 上的农场', chat: '手机上的田头', tickets: '手机上的工单' },
  },
  screens: {
    title: '看看农场',
    items: [
      { image: 'farm', caption: '农场：田地、管家和右下角的田头' },
      { image: 'title', caption: '首页：昼夜跟着你的时间走' },
      { image: 'chat', caption: '聊天页：频道、帮工和右边打开的工单串' },
    ],
    open: '点开看大图',
    close: '关上',
  },
  safety: {
    title: '先说清楚',
    text: '帮工没有权限确认、不开沙箱，能在这台电脑上执行任意命令。服务端只听 127.0.0.1，不要把它暴露到网络上；只把你愿意交给编码 agent 的项目放进工作目录。',
    wip: '代码还在密集调整：概念、接口和存盘格式都还会变，可能会有 bug。升级前先备份农场的数据，遇到问题欢迎在 GitHub 上提 issue。',
  },
  start: {
    title: '开始种地',
    needs: '需要',
    list: [
      'macOS（Apple 芯片）',
      '至少一个装好并登录的编码 agent：pi、Claude Code 或 Codex',
      '一把 DeepSeek 的 API 钥匙，管家要用',
      '自己构建要 Go 1.27、Flutter 3.47 和 Xcode',
    ],
    build: '打一个 macOS 应用',
    more: '更多见仓库里的 README 和 docs/。',
    readme: '读 README',
    copy: '复制',
    copied: '复制好了',
  },
  footer: {
    license: 'Apache 2.0 开源',
    font: '像素字：Fusion Pixel（SIL OFL）',
    top: '回到顶上',
  },
  lost: {
    title: '这块地什么也没种',
    text: '你要找的那一页不在农场里：也许挪了地方，也许从来没有过。',
    home: '回农场',
  },
}

/** What every language has to say. */
export type Copy = typeof zh

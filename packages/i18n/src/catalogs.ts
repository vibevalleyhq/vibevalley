// Written by `vpx scripts/gen/i18n.ts gen` from crates/i18n/locales: do not edit.

/** Each language's catalogs by namespace. */
export const catalogs = {
  zh: {
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
      status: { backlog: "备选", todo: "待办", in_progress: "处理中", in_review: "待验收", done: "已完成", canceled: "已取消" },
      priority: { urgent: "紧急", high: "高", medium: "普通", low: "低" },
      deliverable: { change: "改动，合进仓库", branch: "改动，分支留着不合", answer: "结论，只查不改代码", pull_request: "提交 PR/MR" },
      delivered: {
        merged: "合进了主分支",
        merged_into_parent: "合进了计划的分支",
        pull_request: "PR 合进去了",
        kept: "分支留着没合",
        none: "没有改动要合",
        submitted: "已提交 PR/MR",
      },
      canceled: { dismissed: "取消了", lost: "干活的目录丢了" },
      doneWith: "已完成，{what}",
      canceledFor: "已取消，{why}",
      stage: { draft: "草稿", queued: "排队", working: "在做", asking: "等你回答", reviewing: "等你验收", stuck: "卡住了", done: "已完成", canceled: "已取消" },
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
        quiet: "{what}（已经 {span}没动静了）",
        done: "这一轮做完了，等你看{conflict}",
        failed: "这一轮没做成",
        resting: "歇着（上一轮{last}）{conflict}",
        rested: "歇着{conflict}",
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
      join: { labeled: "{label}：{text}", aside: "{text}（{aside}）", sentence: "{text}。", separator: "、" },
    },
    "web.agent": {
      newName: "新的 {runtime}",
      noProfiles: "问不到服务端的角色：",
      noRuntimes: "读不到引擎：{why}",
      loading: "读取配置…",
      noSuch: "没有这份角色。",
      backToAll: "回到全部角色",
      unnamedAgent: "无名 agent",
      unnamed: "未命名角色",
      all: "全部角色",
      isNew: "新的",
      unsaved: "没保存",
      saved: "已保存",
      discard: "放弃改动",
      talk: "私聊",
      saving: "保存中…",
      create: "捏好了，保存",
      save: "保存",
      runsLink: "查看轨迹",
      remove: "删除",
      removeWhich: "删掉 {name}？",
      fine: "配置没问题，可以派活。",
      problems: "派不出去的原因",
      cannot: "派不出去：",
      random: "随机一个",
      avatar: "角色头像",
      avatarHint: "在工作台与聊天里展示这个头像；留空时显示农场里的小动物。",
      avatarAnimal: "默认小动物",
      looksAs: "在农场里是",
      looksHint: "只是长相：同一个引擎可以是不同的动物。",
      wears: "穿什么",
      tab: { who: "身份", runtime: "能力", persona: "人设", skills: "技能", tools: "工具", env: "环境", memory: "记忆" },
      tabs: "角色的",
      name: "名字",
      nameTip: "主助手和字幕里都叫这个名字，说话时也可以直接点名。",
      nameTaken: "已经有同名的 agent 了",
      duty: "职责",
      dutyTip: "一句话。主助手挑人时会读。",
      roleHint: "比如：写接口、改 server、跑 Go 测试",
      tags: "适合的活",
      tagsTip: "用户的话里出现这些词，主助手选「自动」时就优先派它。回车添加。",
      tagsHint: "前端、测试、文档…",
      enabled: "启用",
      enabledHint: "停用后主助手不会派它，名字点到也会拒绝。",
      workdir: "默认仓库",
      workdirTip: "工作区（VIBEVALLEY_WORK_ROOT）下的一个文件夹。主助手派活没说仓库时用它；留空时派活必须说在哪个仓库。",
      workdirHint: "比如 clock-in",
      worktree: "每个执行会话一个 git worktree",
      worktreeHint: "每个执行会话在自己的分支上改，几个执行会话不会互相覆盖；完成时合进仓库。关掉就直接在仓库里改，没有分支可合。",
      env: "环境变量",
      envHint: "叠加在引擎设置的环境变量之上。",
      machine: "引擎",
      machineTip: "换引擎会清掉模型和推理强度；长相（动物和衣服）不变。",
      readingMachines: "读取引擎…",
      available: "可用",
      disabled: "已停用",
      checking: "检测中…",
      notHere: "这台机器上没有",
      model: "模型",
      noModels: "这个引擎现在报不出模型列表。",
      modelLevels: "{name}（{n} 档推理）",
      effort: "推理强度",
      effortDefault: "默认由引擎决定。",
      defaultEffort: "默认",
      can: "{runtime} 能做什么",
      steer: "能在干活时接话（steer）",
      noSteer: "干活时不能插话，话会排到这一轮之后",
      inProcess: "· 跑在 server 进程里（Node SDK）",
      ownProcess: "· 作为单独的命令行进程运行",
      refuses: "不接受 ",
      colon: "：",
      persona: {
        append: { label: "追加到系统提示", detail: "保留引擎自带的工作方式，在后面加上人设。大多数情况选这个。" },
        replace: { label: "替换系统提示", detail: "整段换掉引擎自带的系统提示。只有你清楚自己在做什么时才用。" },
        prompt: { label: "写进任务开头", detail: "每个任务前面加上人设。所有引擎都能用，但会被长对话冲淡。" },
      },
      personaLabel: "人设",
      personaTip: "它是谁、怎么干活、什么不做。会按下面的方式交给引擎。",
      personaHint: "你是一个谨慎的后端工程师。先读懂现有代码再动手……",
      personaMode: "交给引擎的方式",
      library: "技能库",
      libraryTip: "选中的技能跟人设一起交给执行会话，每个技能一节。",
      manageLibrary: "管理技能库",
      ownSkills: "{runtime} 自己装的技能",
      ownSkillsTip: "引擎自己报告的，在这台机器上已经能用，不用在这里勾。",
      mcp: "MCP 服务器",
      mcpHint: "派出执行会话时交给引擎（oar 的 SessionOptions.mcpServers）。",
      removeNamed: "删除 {name}",
      mcpKind: "MCP 的种类",
      mcpName: "MCP 名字",
      mcpTarget: "MCP 命令或地址",
      add: "添加",
      disallowed: "禁用的工具",
      disallowedHint: "这些工具这个 agent 不能用。下面引擎报告的工具点一下就能加进来。",
      disallowedExample: "比如 WebSearch",
      ownMcp: "{runtime} 自己连的 MCP",
      ownMcpTip: "引擎自己报告的，和上面加的叠在一起。",
      unreported: "这个引擎不报告这一项。",
      none: "没有。",
      role: { orchestrator: "主助手", worker: "执行角色" },
      templates: {
        title: "模板",
        intro:
          "每个模板是一份 agent 的配方：角色、职责、人设、推荐的引擎和长相。装一份就多一份角色，同一个模板能装好几份；装好的随便改，模板出了新版本，角色页会提示更新。",
        open: "从模板装",
        openLine: "主助手与执行角色的配方，挑着装",
        folder: "模板文件夹",
        folderHint: "本机上一个模板文件夹的路径（里面有 agent.json）",
        add: "加进来",
        added: "模板「{name}」加进来了，还没装",
        onServer: "跑在 VibeValley 自己的 agent 上",
        notHere: "写给 {runtime}，这台机器上没有：装上以后在角色里换一个引擎",
        noPersona: "没写人设。",
        addedHere: " · 本机加进来的",
        skill: "技能「{name}」：{description}",
        fold: "收起",
        removeSure: "真的删掉模板",
        from: "来自模板「{name}」第 {version} 版",
        update: "照模板更新到第 {version} 版",
        updateHint: "用模板的新版本盖掉职责、适合的活、人设和交给引擎的方式；名字、长相、引擎、模型和环境不动。",
        updated: "照模板更新好了",
        galleryTitle: "开箱即用的模板",
        galleryIntro: "按分工挑一份模板：自带风格、人设与技能，一键采用即可派活。",
        manageLink: "全部模板与导入",
        adopt: "一键采用",
        adopted: "已采用 {n}",
        adoptedToast: "已采用「{name}」",
        willUse: "将用 {runtime}",
        style: "风格 · {style}",
        preview: "人设",
        category: { all: "全部", engineering: "研发工程", product: "产品设计", research: "调研文档", orchestration: "主助手" },
      },
      orchestrator: {
        newName: "新的主助手",
        intro:
          "主助手常驻、带队、自己不干活：听你说要做什么，派执行会话去做，盯紧进度，转告结果。它跑在 VibeValley 自己的 agent 上，有自己的私聊、记忆和轨迹；把频道交给它照看，在那个频道里说话就是它回答。",
        page: "它的记忆与语音",
        nameTip: "频道里叫这个名字；别人用 @它的角色 id 叫它。",
        model: "模型",
        modelTip: "DeepSeek 的模型，留空用默认的。",
        modelHint: "deepseek-v4-flash",
        dutyTip: "一句话：它专管什么。",
        personaTip: "它是谁、怎么说话、专管什么，接在主助手的提示后面。",
        personaHint: "你专管 clock-in 这个仓库，先看测试再派活……",
        look: "长相",
      },
      list: {
        filterLabel: "按类型筛选",
        all: "全部",
        orchestrators: "主助手",
        helpers: "执行角色",
        search: "搜索角色",
        searchHint: "搜名字、职责、引擎、标签…",
        make: "新建执行角色",
        makeOrchestrator: "新建主助手",
        orchestratorLine: "专职统筹：拆解任务、分配执行、跟踪进度、汇总结果。",
        orchestratorSummary: "常驻带队",
        defaultBadge: "默认",
        disabledBadge: "已停用",
        disable: "停用",
        enable: "启用",
        toggle: "{act} {name}",
        emptySearch: "没有符合条件的角色。",
        clearFilter: "清掉筛选",
      },
      runtimeDefault: "引擎默认",
      runtimeDefaultModel: "引擎默认（{model}）",
      noEffort: "这个模型没有推理强度可选。",
      noEffortModel: "{model}没有推理强度可选。",
      targetMachine: "执行机器",
      targetMachineTip: "将此角色固定到某台执行机器，或保持「自动」由总控端优先调度本机或在线机器。",
      targetMachineAuto: "自动（优先本机或在线）",
      targetMachineOffline: "{name}（离线）",
      targetMachineDraining: "{name}（排空中）",
    },
    "web.artifact": {
      card: { version: "第 {version} 稿", open: "打开「{title}」" },
      page: {
        delete: "删掉",
        deleteAsk: "删掉「{title}」？对话里的卡片还在。",
        deleted: "删掉了「{title}」",
        gone: "这份作品已经删掉了，或者没有这份作品。",
        new: "新建",
        none: "还没有作品：写个标题新建一篇，或者让执行会话交一份上来。",
        all: "全部作品",
        title: "标题",
        more: "更多",
        rail: "这篇的旁注",
        railShow: "打开旁注",
        railHide: "收起旁注",
      },
      issue: { title: "作品" },
      blocks: { saved: "都存好了", user: "你", start: "从这里开始写……" },
      canvas: { label: "打开的作品", close: "关掉", openPage: "在作品页打开" },
      suggestions: { title: "建议（{n}）", by: "{name} 提的", accept: "接受", reject: "不要", delete: "删掉这一块" },
      types: {
        defaultBadge: "默认体系",
        setDefault: "设为默认设计体系",
        unsetDefault: "取消默认",
        docs: "协作文档",
        outline: "大纲笔记",
        slides: "幻灯片",
        dashboard: "数据看板",
        motion: "动态短片",
        whiteboard: "无限白板",
        design: "界面画板",
        designSystem: "设计体系",
        sheet: "电子表格",
        prototype: "交互原型",
        diagram: "结构图表",
        storyboard: "分镜脚本",
      },
      timeline: {
        toggle: "时间轴历史",
        title: "时间轴",
        loading: "正在载入历史…",
        empty: "还没有可回放的提交",
        prev: "上一个提交",
        next: "下一个提交",
        backToLive: "回到最新",
        previewBanner: "历史只读预览 · {summary}",
        turn: "第 {n} 轮",
        restore: "恢复到此版本",
        restored: "已恢复到所选版本",
        fork: "分叉为新作品",
        forkTitle: "{title}（分支）",
        forked: "已分叉为「{title}」",
        undoTurn: "撤销此轮改动",
        undoneOrigin: "已撤销该来源的改动",
        compact: "压缩历史",
        compacted: "已压缩历史快照",
      },
      dashboard: { exportCsv: "导出 CSV" },
      whiteboard: {
        pan: "平移",
        select: "选择",
        rect: "矩形",
        sticky: "便签",
        card: "卡片",
        diamond: "菱形",
        text: "文字",
        container: "分区容器",
        pen: "画笔",
        sticker: "贴纸",
        arrow: "连线箭头",
        timeline: "时间线",
        undo: "撤销",
        redo: "重做",
        duplicate: "复制",
        chatWithOrchestrator: "问助手",
        templateTimeline: "时间线模板",
        templateArchitecture: "架构图模板",
        inspector: "属性检查器",
        label: "标题",
        body: "正文",
        noSticker: "无贴纸",
        save: "保存",
        entryJson: "条目 JSON",
        saveJson: "保存 JSON",
        exportedSvg: "已导出 SVG",
        exportedPng: "已导出 PNG",
        exportedJson: "已导出 JSON",
        exportedJsonCanvas: "已导出 JSON Canvas",
        deleteSelected: "删除选中",
        zoomIn: "放大",
        zoomOut: "缩小",
        fitView: "适应画布",
        elements: "{n} 个元素",
        emptyHint: "从底部工具栏放置卡片、时间线、连线与贴纸，或一键载入模板开始协作",
        fillDefault: "默认",
        fillSun: "暖黄",
        fillPeach: "暖橘",
        fillLeaf: "叶绿",
        fillWater: "湖蓝",
        fillLavender: "淡紫",
        fillBerry: "莓红",
        fillSide: "灰底",
        curveSmooth: "平滑曲线",
        curveOrthogonal: "直角折线",
        curveStraight: "直线",
        styleSolid: "实线",
        styleDashed: "虚线",
      },
      design: { noProps: "当前画板未声明可调属性（data-props）" },
      designSystem: { components: "组件预览" },
      slidesStore: { addSlide: "加一页" },
      edit: { save: "存成新的一稿", saved: "存成了第 {version} 稿" },
      slides: { previous: "上一页", next: "下一页", present: "全屏放映", presenter: "演讲者视图" },
      presenter: {
        missing: "没说要讲哪一份幻灯片：从作品的「演讲者视图」打开。",
        current: "这一页",
        next: "下一页",
        end: "这是最后一页",
        notes: "备注",
        noNotes: "这一页没有备注",
        clock: "讲了多久",
        restart: "重新计时",
        aside: "下一页和备注",
        waiting: "等待演示页就绪",
        empty: "没有可演示的页",
        loadFailure: "演示页未能载入：{reason}",
      },
      standalone: { missing: "这份作品已经删掉了，或者没有这份作品。", version: "第 {version} 稿", live: "最新" },
      applet: {
        button: "安装为桌面应用",
        buttonInstalled: "桌面应用已安装",
        badgeInstalled: "已安装",
        modalTitle: "本地桌面应用",
        subtitle: "将这份作品安装为独立 Mac 应用，可从聚焦搜索或程序坞直接打开。",
        appNameLabel: "应用名称",
        appNamePlaceholder: "输入应用显示名称",
        alwaysOnTopLabel: "窗口置顶",
        alwaysOnTopHint: "独立应用窗口保持在其它窗口之上。",
        statusInstalled: "已安装",
        statusNotInstalled: "尚未安装",
        bundlePathLabel: "应用位置",
        bundleIdLabel: "应用标识",
        install: "安装应用",
        reinstall: "更新并重装",
        installing: "正在安装…",
        open: "打开应用",
        uninstall: "卸载",
        installedToast: "已安装「{name}.app」",
        uninstalledToast: "已卸载「{name}.app」",
        openedToast: "正在打开「{name}.app」",
        nameRequired: "请先输入应用名称",
        unavailable: "当前宿主不支持安装本地桌面应用",
      },
    },
    "web.audio": {
      title: "音频工作台",
      notice:
        "请求可能产生费用。取消只停止本机等待，不代表厂商停止计费。结果未知时不会自动重新提交。生成音频每个文件最多 512 MB；超过 25 MiB 的结果保存在仅你可访问的 Media 存储中，与上传输入共用 2 GiB 配额，不能发布到频道。",
      configure: "请先在 AI 服务中配置这项用途。",
      refresh: "刷新账号与配置",
      account: "音色账号",
      chooseAccount: "选择账号",
      voices: "账号音色",
      voice: "音色",
      chooseVoice: "选择音色",
      first: "首页 / 刷新",
      next: "下一页",
      emptyVoices: "此账号没有返回音色。",
      queryVoice: "在本页查找音色",
      queryHint: "按名称或 ID 筛选此账号的当前页，更多音色请翻页。厂商不支持单个音色查询与删除。",
      speakerTitle: "多人语音",
      speakerHint:
        "最多为五位说话人选择配置账号的音色，再按顺序添加对话（合计不超过 10,000 字符）。说话人 ID 不能重复，只能包含英文字母、数字、下划线或连字符。",
      speaker: "说话人 ID",
      addSpeaker: "添加说话人",
      remove: "移除",
      dialogue: "对话",
      addTurn: "添加对话段",
      text: "文字",
      generate: "生成对话音频",
      designTitle: "设计音色",
      instructions: "音色描述",
      previewText: "试听文字",
      preview: "生成试听",
      designHint:
        "生成试听不会保存可复用音色。试听后，需明确选择保存到原账号。只有不超过 30 秒、10 MB 的 WAV、MP3 或 FLAC 试听可保存为音色；更长的试听只能下载。",
      voiceName: "可复用音色名称",
      saveVoice: "保存可复用音色",
      savedVoice: "已保存音色：{voice}",
      cloneTitle: "克隆声音样本",
      cloneHint: "只能使用你本人或已获得克隆许可的声音：WAV、MP3、M4A 或 FLAC，不超过 30 秒、10 MB。授权绑定当前文件和账号版本；换文件或账号后需要重新授权。",
      consent: "我有权使用这份声音，并授权将此文件上传到所选账号用于本次请求。",
      clone: "创建可复用音色",
      transcriptionTitle: "长音频转写",
      transcriptionHint:
        "将最长一小时的音频上传到独立配置的转写账号。异步模式等待远端任务；流式模式即时保存收到的文字和说话人分段。离开页面不会取消已保存的任务。只有完整结束才是最终结果；中断的流保留部分内容，不会自动重连或重新提交。",
      execution: "执行方式",
      executionHint: "仅说话人分离模型及其支持的快照版本可使用流式模式。",
      executionAsync: "异步任务",
      executionStreaming: "流式文字与说话人",
      partialTitle: "部分转写",
      partialTranscript: "部分转写——并非完整结果。",
      savePartialTranscript: "将部分转写保存为作品",
      chooseFile: "选一个音频文件",
      copyTranscript: "复制转写",
      copyPartialTranscript: "复制部分转写",
      usageAudioSeconds: "输入音频：{value} 秒",
      input: "音频文件",
      transcribe: "开始转写",
      timeline: "说话人时间轴",
      noTimestamps: "厂商没有返回带时间戳的分段。",
      saveTranscript: "将转写保存为作品",
      openTranscript: "打开已保存的转写作品",
      downloadAudio: "下载音频",
      history: "音频任务",
      empty: "还没有音频任务。",
      pending: "请求已固定。再次查询沿用同一 ID 和账号，不会新建请求。",
      check: "查询原请求",
      new: "新建请求",
      newAsk: "要发起另一笔请求吗？原请求仍可能完成并产生费用。",
      uploading: "正在将所选音频上传到本机服务端…",
      stopUpload: "停止上传",
      format: "音频格式",
      transcript: "转写结果",
      diarize: "识别说话人",
      resume: "继续查询原远端任务",
      cleanupPreview: "预览远端文件清理",
      cleanup: "重试清理远端文件",
      cleanupAsk: "要删除预览中列出的远端输入文件吗？此操作不会重新生成音频或改变已保存结果。",
      flashTitle: "Flash 实时播放",
      flashNotice:
        "明确开始后，边生成边播放收到的 PCM 音频。仅支持 Flash，完整结果保存为 WAV，最多缓冲五秒播放。停止、离开页面或切换设备都会关闭流，不能重连，厂商仍可能计费。",
      flashStart: "开始生成并播放",
      flashStop: "停止播放和本机任务",
      flashDraining: "音频流已完整接收，正在播完缓冲内容…",
      metadataFile: "从已保存音频测得",
      metadataProvider: "厂商报告",
      metadataRate: "{value} Hz",
      metadataDuration: "{value} 秒",
      metadataChannels: "{value} 声道",
      metadataBits: "{value} 位",
      usageCharacters: "输入字符：{value}",
      usagePrompt: "提示词 token：{value}",
      usageCompletion: "生成 token：{value}",
      usageTotal: "总 token：{value}",
      unknownSpeaker: "未标注说话人",
    },
    "web.base": {
      route: { missing: "这个页面不存在", invalid: "这个地址无效", home: "返回应用" },
      place: {
        chat: { label: "对话", hint: "频道与话题" },
        issues: { label: "任务", hint: "每件任务从记下到完成" },
        runs: { label: "运行与轨迹", hint: "执行会话、主助手审批与历史轨迹" },
        workspace: { hint: "管理仓库与工作区", name: "工作区" },
        content: { label: "内容", hint: "媒体库、作品与笔记" },
        runtimes: { label: "引擎", hint: "本机与远端已安装的编码引擎" },
        team: { label: "团队", hint: "角色与团队模板" },
        settings: { label: "设置", hint: "通用与外观、模型与密钥、语音与通话、外部连接、关于与数据" },
      },
      link: { connecting: "连接中", open: "已连上", lost: "断了，重连中" },
      rail: "工作台",
      farm: "回农场",
      farmShort: "农场",
      update: "更新",
      working: "运行中 · {n} 个执行会话",
      runsHint: "查看执行会话、主助手审批与轨迹",
      chips: { drop: "去掉 {v}", valueOf: "{k} 的值", removeKey: "删除 {k}", remove: "删除", name: "变量名", value: "变量的值", valueHint: "值", add: "添加" },
      toasts: "提示",
      runtime: "运行工具：{name}",
      user: "你",
      orchestrator: "主助手",
      unreachable: "暂时连不上服务端，请等它恢复后重试。",
      query: { invalidResponse: "返回的数据格式不符，已有的有效结果已保留。" },
      table: {
        columns: "显示的列",
        stale: "新页还在读取，当前显示的是上一次的结果，暂时不能操作这些行。",
        selectPage: "选择本页",
        selectRow: "选择行 {id}",
        empty: "暂无数据",
        previous: "上一页",
        next: "下一页",
        page: "第 {n} 页",
      },
      form: {
        invalid: "请检查这一项。",
        validationUnavailable: "暂时无法校验，输入已保留。",
        deliveryUnknown: "请求可能已送达，但还没收到确认。输入已保留，请先查看保存结果再决定是否重试。",
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
        place: {
          everywhere: "到处",
          composer: "输入框",
          lists: "菜单和名单",
          issues: "任务",
          pictures: "看图",
          library: "媒体库",
          farm: "农场",
          desktop: "桌面版（系统全局）",
        },
        say: {
          switcher: "跳到频道、话题、私聊",
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
          voice: "跟主助手说话（在设置里能换）",
          command: "命令：建任务、让主助手记住、叫停、私聊",
          newIssue: "新建任务",
          libraryMove: "在素材之间挪",
          libraryLook: "全屏看选中的图",
          libraryRemove: "从库里拿掉选中的",
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
        expand: "放大查看",
        viewDiagram: "图表",
        viewSource: "源码",
        zoomIn: "放大",
        zoomOut: "缩小",
        zoomReset: "重置缩放",
      },
      updateReady: "{next} 已下好，去「关于」重启",
      intent: { timedOut: "等了太久没回音，可以重试", offline: "没连上 VibeValley，这一下没发出去" },
      pickTooLarge: "{name} 没加上：超过 512 MiB 了",
      openTerminal: "在这里打开终端",
      play: "播放",
      stop: "停止",
    },
    "web.channel": {
      tab: { chat: "聊天", issues: "任务", crons: "定时任务" },
      defaultRepo: "默认仓库 {repo}",
      channels: "频道列表",
      defaultHint: "默认的频道：你、主助手和执行会话都在这儿",
      findHint: "在这个频道里找…",
      find: "在这个频道里找",
      findMessages: "找消息",
      settings: "频道设置",
      inChannel: "频道里的",
      empty: "{label} 还没人说话：跟主助手说一件要做的事。",
      sendTo: "发送消息至 {label}",
      side: "频道与执行会话",
      channelsTitle: "频道",
      directsTitle: "私聊",
      newChannel: "创建频道",
      newChat: "发起聊天",
      filter: { label: "筛选会话", all: "全部", group: "频道", direct: "私聊" },
      emptyPreview: "暂无消息",
      emptyList: "这里还没有对话",
      runsEntry: "查看执行会话",
      mood: { idle: "在歇着", listening: "在听", thinking: "在想", speaking: "在说" },
      orchestrator: "主助手",
      nobodyOnIt: "现在没有执行会话在干，串还留着",
      replies: "{n} 条回复",
      thread: "话题",
      closeThread: "关上话题",
      threadEmpty: "话题里还没人说话。在这里说的话，它的执行会话会看到。",
      sayInThread: "在话题里说，{name}会看到",
      reply: "回复这个话题",
      dialog: {
        repoExample: "比如 clock-in",
        cancel: "取消",
        name: "名称",
        nameHint: "字母、数字、汉字、- 和 _，不超过 24 个字",
        nameExample: "例如 clock-in",
        description: "描述（可不填）",
        descriptionHint: "这个频道是做什么的？",
        repo: "默认仓库（可不填）",
        repoHint: "在这个频道里派活、没说仓库时，就在这个仓库里干",
        repoNone: "空着就没有：派活时主助手要问在哪个仓库",
        settingsOf: "# {name} 的设置",
        save: "保存",
      },
      issues: { empty: "这个频道里还没有任务。在聊天里跟主助手说一件要做的事，它会派执行会话，任务就列在这里。", thread: "任务话题" },
      crons: {
        empty: "还没有定时任务：跟主助手说「每天九点跑一遍测试」。",
        next: "下次 {next}",
        direct: "直接派 {agent}",
        byOrchestrator: "主助手定的",
        label: "定时任务「{name}」",
        on: "开着",
        off: "关着",
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
        user: "你",
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
        searchFailed: "没搜成：{why}",
        readFailed: "消息没读到：{why}，稍后再试",
      },
      tools: {
        label: "这条消息能做的",
        react: "回应",
        reply: "回复",
        thread: "开一个话题",
        pin: "置顶",
        unpin: "取消置顶",
        edit: "改",
        remove: "删掉",
        sure: "再点一次删掉",
        pick: "选一个回应",
        editHint: "回车存下 · Esc 不改了",
      },
      pins: { open: "置顶的消息", title: "置顶", none: "这里还没有置顶的消息", failed: "置顶没读到：{why}" },
      members: { open: "成员", title: "成员", user: "你", none: "这里还没有执行会话", inChannel: "频道里的主助手" },
      composer: {
        notSent: "没发出去：{why}",
        who: "叫谁",
        mention: "叫人",
        stopHint: "叫主助手停下这一轮，派出去的执行会话照常干活",
        send: "发送",
        sendHint: "回车发送 · Shift+回车换行",
        replying: "回复 {name}",
        cancelReply: "不回复了",
        attach: "附上文件",
        uploadFailed: "没传上去：{why}",
        command: "命令",
        artifactContext: "当前上下文：{title}",
        artifactSlide: "第 {n} 页",
        artifactSelected: "已选 {n} 个元素",
        clearContext: "移除本次附带的上下文",
        runningHint: "正在处理中，可直接补充说明或点击停止",
      },
      manage: {
        name: "名称",
        category: "分组（可不填）",
        categoryHint: "侧栏里按分组列频道",
        members: "频道里的主助手",
        membersHint: "在频道里的主助手能看到这里没 @ 人的话和汇报；一个都不在，就要 @ 才有人接",
        notify: "提醒",
        notifyAll: "全部",
        notifyMentions: "只在有人 @你 时",
        notifyNone: "不提醒",
        notifyHint: "不提醒的不算未读、不进收件箱、不转到微信",
        archive: "归档",
        unarchive: "取消归档",
        archiveHint: "归档的频道不在侧栏里，消息和地址都还在",
        remove: "删除频道",
        removeSure: "确定删除",
        removeWill: "删除以后：",
        archivedTitle: "已归档",
        muted: "不提醒",
        mentionsOnly: "只 @",
      },
      threadList: {
        title: "这个频道的话题",
        none: "这个频道还没有串",
        archived: "已归档的话题（{n}）",
        rename: "给「{title}」改名",
        archive: "归档「{title}」",
        unarchive: "取消归档「{title}」",
        notify: "话题的提醒",
      },
      more: { label: "更多", copyLink: "复制链接", copied: "链接已复制", markUnread: "从这里标成未读", jump: "跳到这条" },
      switcher: {
        open: "跳到…",
        title: "跳到频道、话题或私聊",
        hint: "输入名字；# 只找频道和话题，@ 只找私聊",
        none: "没有找到",
        direct: "私聊",
        newDirect: "开一个私聊",
      },
      farmSearch: {
        title: "全部搜索",
        hint: "找消息…",
        filters: "from:用户  in:#频道  has:file / image / link  before: / after:2026-10-01",
        none: "没有找到",
        searching: "在找…",
        failed: "没搜成：{why}",
      },
      direct: { pick: "和谁私聊", none: "还没有角色", open: "和{name}私聊" },
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
        issueThread: "任务话题",
        talkThread: "{who}的话题",
        thread: "话题",
        mention: { orchestrator: "@主助手", user: "@用户", everyone: "@所有人" },
        orchestratorNote: "派活、拆计划、问进度",
        everyone: "所有人",
        everyoneNote: "叫醒在场的每个执行会话",
      },
      threadWidth: "话题的宽窄（拖动，双击回默认）",
      commands: {
        issue: { name: "记一个任务", args: "标题", note: "记进备选，在这个频道的仓库里", needs: "/issue 后面写任务的标题" },
        remember: { name: "让主助手记住", args: "一句话", note: "记进这里主助手的记忆", needs: "/remember 后面写要它记住的话" },
        stop: { name: "叫停主助手", args: "", note: "这里的主助手停下这一轮，派出去的执行会话照常干活", needs: "" },
        dm: { name: "私聊", args: "名字", note: "打开和这份角色的私聊", needs: "/dm 后面写角色的名字或 id" },
        imagegen: {
          name: "生图",
          args: "描述",
          note: "交给这里的主助手用 MOSS 画一张，画好发回这里",
          needs: "/imagegen 后面写想要的画面",
          nowhere: "先打开一个频道再生图",
          notReady: "生图还没设置好：{why}，回车去设置",
        },
        done: { issue: "记下了 #{n}", remember: "记下了", stop: "叫停了", imagegen: "交给主助手了，画好会发到这里" },
      },
      lacks: "回不了话：{why}",
      lacksFix: "去设置",
    },
    "web.connector": {
      connectors: {
        section: { label: "连接器" },
        label: { weixin: "微信", feishu: "飞书" },
        how: { weixin: "扫码登录，私聊机器人", feishu: "扫码自动建机器人", qq: "填 QQ 机器人的 AppID" },
        notes: {
          weixin: {
            "0": "只认扫码的那个微信：别人给这个机器人发的话进不来。",
            "1": "执行会话干完活，汇报马上发到微信上，不用等你先说话。微信偶尔不收时，汇报先攒着，隔一会儿再试（越隔越久，最多半小时），你下次说一句也会一起发过来（多了合成一条）。",
            "2": "用的是腾讯官方给机器人用的接口（和 OpenClaw 的微信插件一样）。",
          },
          feishu: {
            "0": "扫码后，飞书会替你建一个只属于你的机器人应用，不用去开放平台手动配。",
            "1": "建好后在飞书里找到这个机器人，私聊它发配对码：发了码的人就当作是你，只有这个人的话进得来。只收私聊，群里的不收。",
            "2": "飞书的机器人可以随时给你发消息，汇报不用等你先说话。",
          },
          qq: {
            "0": "QQ 没有扫码建机器人：先在 QQ 开放平台（q.qq.com）建一个机器人，打开「单聊」消息，把 AppID 和 AppSecret 填在这里。",
            "1": "用你自己的 QQ 加这个机器人，私聊它发配对码：发了码的人就当作是你。只收私聊。",
            "2": "QQ 只让机器人在你说话后的一小段时间里回复。过了时间的汇报先攒着，隔一会儿再试，你下次说一句就一起发过来。",
          },
        },
        always: "执行会话能在这台电脑上跑命令，所以只认你；回复时引用某条汇报，你的话会进那件活的任务话题。VibeValley 只往外连，不开端口。",
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
        intro: "在聊天软件里和主助手说话：派活、问进度、收汇报。",
        know: "要知道的",
        disconnect: "断开",
        weixinIntro: "用手机微信扫一个码，就能在微信里和主助手说话：派活、问进度，执行会话的汇报和提问也会发到微信上。",
        feishuIntro: "用手机飞书扫一个码，飞书会替你建一个机器人；在飞书里和它说话，就是和主助手说话。",
        scan: "{app}扫码登录",
        pairing: "机器人连上了。最后一步：用你自己的{app}，私聊这个机器人，发：",
        pairingNote: "发了这个码的人就当作是你：以后只有这个人的话进得来。码只能用一次。",
        user: "你",
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
    "web.devtools": {
      title: "开发者工具",
      tabs: { overview: "概览", routes: "路由", timeline: "时间线", trajectory: "轨迹", state: "状态与缓存", lab: "实验与覆盖" },
      actions: {
        refresh: "刷新",
        autoRefresh: "自动刷新",
        pause: "暂停",
        resume: "继续",
        detach: "独立窗口打开",
        close: "关闭",
        clear: "清空",
        exportBundle: "导出诊断包",
        exporting: "正在导出…",
        copy: "复制",
        copied: "已复制",
        apply: "应用",
        reset: "重置",
        disconnect: "模拟断开",
      },
      lanes: { all: "全部通道", coreApply: "Core::apply", bridgeRpc: "桥接 RPC", oarWire: "OAR 协议流", gpuiFrame: "GPUI 渲染帧" },
      overview: {
        channel: "发布通道",
        version: "版本",
        loopbackUrl: "本地地址",
        homePath: "宿主目录",
        workRoot: "空间目录",
        dbPath: "数据库",
        bundleMode: "构建模式",
        bootTime: "启动耗时",
        activeSessions: "活跃执行会话",
        activeClients: "活跃客户端",
        activeSubscriptions: "活跃订阅",
        latestSeq: "最新序号",
        lastFrameMs: "最近帧耗时",
        runtimes: "引擎状态",
        installed: "已安装",
        notInstalled: "未安装",
        ready: "就绪",
        notReady: "未就绪",
        graph: "拓扑关系",
        clients: "客户端",
        sessions: "执行会话",
        watches: "监听切片",
        subscriptions: "订阅",
        bundleExported: "诊断包已导出至 {path}（已脱敏 {redacted} 处）",
      },
      routes: { searchPlaceholder: "筛选路由…", empty: "暂无路由状态。" },
      timeline: {
        searchPlaceholder: "搜索事件…",
        slowOnly: "仅看慢事件",
        slow: "慢",
        dropped: "已丢弃 {count} 条",
        empty: "暂无时间线事件。",
        durationUs: "{us} µs",
        correlationId: "关联 #{id}",
      },
      trajectory: {
        kind: { issueSession: "任务", workspaceChat: "对话", orchestrator: "主助手" },
        silentError: "静默错误",
        tokens: "Token 消耗",
        rawPayload: "原始载荷",
        truncated: "已截断（原 {bytes} B）",
        subagents: "子代理",
        systemPrompt: "系统提示词",
        turns: "轮次",
        turnIndex: "第 {index} 轮",
        prompt: "输入提示",
        events: "事件",
        rawEntries: "原始帧",
        voyageRecords: "原始记录",
        emptyList: "暂无轨迹记录。",
        selectPrompt: "选择一条轨迹以查看各轮详情和原始帧。",
      },
      state: {
        seq: "状态序号",
        slices: "切片",
        watchers: "{count} 个监听者",
        counts: "实体计数",
        caches: "缓存统计",
        entries: "{count} 项",
        issues: "任务",
        sessions: "执行会话",
        channels: "频道",
        agents: "角色",
        repos: "仓库",
        artifacts: "作品",
        inbox: "收件箱",
        mediaJobs: "媒体",
        emptyCaches: "暂无缓存统计。",
      },
      lab: {
        rpcDelayMs: "RPC 延迟 (ms)",
        sliceDelayMs: "切片延迟 (ms)",
        targetFilter: "目标过滤",
        targetFilterPlaceholder: "如 issue.* 或 slice:board",
        disconnectTopic: "模拟断开主题",
        disconnectTopicPlaceholder: "如 slice:board 或 channel.follow",
        applied: "覆盖配置已应用。",
        resetDone: "已恢复默认配置。",
        warning: "已启用故障注入，将影响当前进程内的所有视图。",
      },
      status: { loading: "加载中…", error: "加载开发者工具数据失败：{reason}", disabled: "服务端未启用开发者工具。", empty: "暂无数据。" },
    },
    "web.farm": {
      panel: { harvest: "收获{name}的地", sow: "播种 · 第 {plot} 块地", water: "给{name}浇水" },
      menu: { issues: "工单", repos: "仓库" },
      native: { close: "关闭", loading: "载入中…" },
      chat: {
        channels: "频道",
        enlarge: "放大对话窗口",
        fold: "收起对话",
        greeting:
          "这里是田头，你、助手和帮工都在这儿说话。跟我说一句要做的活，比如「让测试小吴跑一遍测试」。\n\n帮工来了以后，写 @w1 这样的名字就是直接叫它；每张工单下面挂着它的工单串。",
        send: "发送",
      },
      hud: { workbench: "工作台" },
      sow: {
        homeless: "这座农场不是哪个仓库的",
        toMap: "种地要先进一个仓库的农场：去「仓库」里挑一个仓库。",
        noRepos: "工作台里还没有仓库：先在「仓库」页开一个。",
        makeRepo: "去开一个仓库",
        plantIn: "种在 {repo}",
        retry: "重新拿种子袋",
        recent: "最近",
        kinds: "常见的活",
        own: "自己写",
        jobHint: "要做什么，做到什么程度算完",
        who: "谁来种",
        orchestratorPicks: "助手挑",
        how: "开始：助手把这句话交给帮工，在 {repo} 里马上开工。草稿：帮工读过代码写成工单，你看过再开工。",
        draft: "草稿",
        start: "开始",
      },
      water: {
        drops: { "0": "改动小一点", "1": "先别动测试", "2": "做完跟我说一声", "3": "顺便补个测试" },
        working: "它正在干活，这句话会在下一步之前收到。",
        idle: "它现在没在干活，这句话会让它接着干一轮。",
        thread: "这句话记在它的工单串里，它回的话也在那儿。",
        hint: "带句话……",
        water: "浇水",
        moved: "工单状态变了，先回到地块看看要你做的事。",
      },
      harvest: { repo: "仓库 {repo}", counts: "{commits} 个提交 · {files} 个文件", letGo: "请它收工", take: "确认收获，合进 {base}", resolve: "让它解决冲突" },
      plotOf: "{name}的地",
    },
    "web.farm.phone": {
      ringing: "来电…",
      decline: "挂断",
      answer: "接听",
      callOrchestrator: "打给助手",
      missed: "未接 {n}",
      log: "记录",
      noCalls: "还没有通话。",
      answered: "接了",
      declined: "挂了",
      noMissed: "没有未接来电。地里都好好的。",
      phase: { live: "通话中：说吧，助手在听", idle: "有事直接说，工单交回来、卡住了，助手也会打过来。" },
      manager: "助手",
      hangUp: "挂断",
      app: { missed: "未接", channels: "频道", games: "游戏" },
      game: { blocks: "方块", sokoban: "推箱子", dino: "小恐龙", bugs: "贪吃虫", merge: "种田 2048" },
      brand: "农场通",
      openChat: "展开田头",
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
    "web.inbox": { tray: { working: "{n} 个执行会话在干活", idle: "开工了，没有在干的活", off: "还没开工", unread: "频道 {n} 条没读" } },
    "web.issue": {
      family: { children: "子任务", parent: "父任务" },
      reading: "在读……",
      never: "算了",
      later: "先放着",
      orchestrator: "主助手",
      noHelper: "还没选角色",
      board: {
        earlier: "更早的 {n} 张",
        recent: "只看最近的",
        empty: {
          todo: "想到要做的先写在这里，拖到「处理中」就派人开工；上下拖排先后。",
          working: "没有在干的活。",
          waiting: "做完的、没做成的在这里等你看；拖到「已关」完成或取消。",
          closed: "已完成、已取消的任务；拖回「处理中」重开。",
        },
        emptyGuide: {
          todoTitle: "待办还是空的",
          todoBody: "记下要做的任务，选好仓库和角色就能派发开工。",
          workingTitle: "暂无处理中任务",
          workingBody: "给待办任务选好角色并派发，或拖到这里即开独立 worktree 执行会话。",
          waitingTitle: "暂无待验收改动",
          waitingBody: "执行会话跑完一轮或有疑问时会停在这里，方便看改动、回复或完成交付。",
          closedTitle: "还没有已关任务",
          closedBody: "已完成或取消的任务会留在这里，拖回「处理中」即可随时重开。",
          filtered: "当前筛选条件下此列没有任务。",
        },
        whichLane: "看哪一列",
        spots: "{taken} / {of} 个并发上限",
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
      list: {
        noRepo: "没有仓库",
        all: "全部任务",
        unfold: "展开 {group}",
        fold: "收起 {group}",
        writeIn: "在「{group}」写一张",
        empty: "暂无任务，按 C 或点右上角「新任务」写下第一条。",
        emptyFiltered: "当前筛选条件下没有匹配的任务。",
      },
      page: {
        pickFirst: "还差一点：选好派哪个执行会话、在哪个仓库里做，再点「开工」。",
        notDrafted: "先没起草：{why}",
        historyUnread: "任务记录没读到：",
        notFound: "找不到这个任务",
        notFoundLine: "没有 {id} 这个任务：可能已经删掉了，或者链接写错了。",
        find: "找任务：标题、执行会话、仓库",
        findLabel: "找任务",
        filter: "筛选",
        byRepo: "按仓库看",
        allRepos: "所有仓库",
        byHelper: "按角色看",
        allHelpers: "全部角色",
        shown: "{shown} / {of} 张",
        clear: "清掉筛选",
        view: "看法",
        missing: "这一轮的记录缺失：{what}。对它的操作暂不可用。",
        backToBoard: "任务",
      },
      marks: { priority: "优先级：{word}" },
      sheet: { less: "收起", more: "更多", at: "在「{stage}」", stageDone: "{stage}做完了" },
      acts: {
        reopened: "任务重开了",
        goesOn: "{helper} 接着做。",
        rejectWith: "打回，照上面修",
        carry: "带过去",
        moving: "正在改状态…",
        sending: "发送中…",
        sayAgain: "再说一次",
        takeBack: "放回输入框",
        notSaid: "没说出去",
      },
      close: {
        title: "关上「{issue}」",
        working: "{who} 还在干这个任务。取消就是叫停它、让它收工，分支上的改动不合进主分支。",
        completable: "完成就是把 {who} 的分支合进仓库的主分支，先看一遍改动；取消就是让它收工，改动不合进去。",
        notCompletable: "这个任务现在不能完成。取消会让 {who} 离开，改动不合进主分支。",
        review: "看改动，完成",
        stopAndCancel: "叫停并取消",
        cancel: "取消任务",
      },
      changes: {
        checkOutput: "检查输出",
        reviewVersion: "审查版本",
        sinceReview: "自上次审查后的改动",
        projectCheck: "项目检查",
        check: { passed: "通过", failed: "失败", not_configured: "未配置检查" },
        mergedCommit: "合入提交",
        reading: "正在看它改了什么…",
        unreadable: "看不了改动：",
        none: "这个任务没有改动。完成就是请它收工。",
        conflict: "合进 {base} 会冲突，先没法完成",
        resolveHow: "让它在自己的分支上把 {base} 合进来、解决冲突、跑一遍测试再提交；解决了再来完成。",
        behind: "它干活这段时间，{base} 上多了 {n} 个提交；完成时会合在一起（多一个合并提交）。",
        uncommitted: "还有 {n} 个文件没提交，完成时会先帮它提交：",
        resolve: "让它解决冲突",
        moved: "任务状态变了，先回到任务看看要你做的事。",
        counts: "{commits} 个提交 · {files} 个文件",
        commits: "提交 {n}",
        files: "改了的文件 {n}",
        conflictMark: "冲突",
        binary: "二进制",
      },
      reopen: {
        title: "重开这个任务",
        line: "「{issue}」由同一份角色的新执行会话接着做，它会知道这个任务原来要做什么、上一次是怎么关的。",
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
        noCriteria: "{answer, select, true {这个任务没写做完的标准：交回来时看结论判断。} other {这个任务没写做完的标准：交回来时看改动判断。}}",
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
        steps: "执行会话的每一步",
        openTrajectory: "完整轨迹",
        runs: "每一轮",
        time: "时间",
        opened: "开单",
        started: "开工",
        waiting: "在等你",
        since: "{clock} 起",
        reviewed: "验收过",
        closedAt: "关单",
        who: "谁在做",
        helper: "执行会话",
        model: "模型",
        deliver: "交付",
        crew: "一起干活的",
        profile: "角色",
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
        orchestratorStuck: "主助手这一轮没答成：在频道里看它说了什么",
        job: "要做的",
        from: "来自",
        fromCron: "定时任务：每次到点交给主助手，答完等你看",
        answered: "在它的频道里",
        evidence: "依据",
        unsure: "拿不准的",
        next: "建议接着做",
        conflict: "合进 {base} 会冲突：{files}",
        properties: "属性",
        status: "状态",
        priority: "优先级",
        repo: "仓库",
        noRepo: "没有仓库",
        rename: "改标题",
        trail: "任务在哪",
      },
      task: { repo: "仓库", written: "写于" },
      todo: {
        queued: "排上队了：并发上限都满了，有并发上限就自动开工。",
        refining: "{who}在起草",
        refiningLine: "它在读代码，写好了会填进下面各栏。",
        questions: "草稿写好了，它有 {n} 个问题要问你",
        questionsLine: "在下面回答，它照你的回答再起草一版。",
        drafted: "草稿写好了",
        draftedLine: "看一遍、改一改，没问题就开工。",
        what: "想做什么？",
        whatLine: "写一句就行：执行会话读过代码，替你写成任务。",
        titleHint: "比如：给登录页加上记住我",
        title: "标题",
        descriptionHint: "说明：为什么、要做的、不做的、可能涉及哪些文件（起草会写好）",
        description: "说明",
        criteria: "验收标准",
        noCriteria: "还没写",
        criteriaSummary: "{n} 条 · {first}",
        criteriaHint: "一行一条：你验收时照着看的点",
        talk: "和执行会话聊清楚",
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
        whichRepo: "在哪个仓库里做",
        firstRepo: "还没有仓库：新建一个",
        newRepoLink: "新建仓库",
        priority: "优先级",
        inQueue: "排队中：{ago}排上的，有并发上限就按看板上的先后自动开工。",
        unqueue: "不排了",
        pickHelper: "先选好角色",
        start: "确认需求并派发",
        save: "存下改动",
        remove: "删掉",
        newRepo: "新建仓库",
        repoHint: "仓库名，也是工作区下的文件夹名",
        repoName: "仓库名",
        create: "新建",
        writeOwn: "自己写说明",
      },
      boardLabels: {
        view: { board: "看板", list: "列表" },
        grouping: { status: "状态", repo: "仓库", agent: "角色", none: "不分组" },
        ordering: { manual: "默认", priority: "优先级", updated: "最近更新", created: "创建时间" },
        lane: { todo: "待办", working: "处理中", waiting: "等你看", closed: "已关" },
        stage: { talk: "聊清楚", work: "安排活", finish: "完成" },
        newIssue: "新任务",
      },
      trigger: {
        issue: "派出去",
        comment: "带话",
        commentNumbered: "带话（#{id}）",
        cron: "定时任务",
        missed: "定时任务（补跑）",
        refine: "起草",
        runtime: "引擎自己",
      },
      run: { working: "正在干", heard: "中途听到 {n} 句", reconcile: "需要核对工作区", currentChanges: "查看任务当前改动" },
      card: {
        orchestrator: "主助手",
        refining: "{name}在起草",
        draft: "草稿",
        queued: "排队中",
        cron: "定时任务",
        noHelper: "还没选角色",
        assignHelper: "待选角色",
        pickFirst: "没选角色或仓库，开工前要选好",
        waiting: "等并发上限，{ago}排上的",
        written: "写于 {ago}",
        lost: "丢了",
        quiet: "{took}没动静",
        nth: "第 {n} 次",
        open: "开了 {took}",
        used: "用了 {took}",
        run: "第 {n} 轮",
        runs: "{n} 轮",
        orchestratorWorking: "主助手在做",
        missingFlag: "记录缺失",
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
        editing: "{who}在改代码",
        history: "{n} 次：{line}",
        historyItem: "{name}（{id}）",
        since: "{span}了",
        ran: "第 {n} 轮",
        used: "共用 {span}",
        noSteps: "还什么都没做。",
        stepsGone: "轨迹只留 30 天（配置里的 session.trajectory_days），这个任务的已经清掉了。",
        change: { A: { mark: "新", label: "新增" }, M: { mark: "改", label: "修改" }, D: { mark: "删", label: "删除" } },
        and: "、",
        doing: "正在{action}",
        doingLabel: "正在{action}：{label}",
        who: "{name}",
        whoRuntime: "{name}（{runtime}）",
        changes: "{branch} → {base} · {commits} 个提交 · +{added} -{removed}",
        changesUncommitted: "{branch} → {base} · {commits} 个提交 · +{added} -{removed} · {uncommitted} 个没提交",
        justNow: "刚刚",
        reviewAfterFailedCheck: "核对修复后，再次完成任务以重跑检查",
      },
      new: {
        title: "新任务",
        card: "新任务",
        words: "要做什么",
        placeholder: "要做什么？一句话就行，执行会话会照它起草",
        keys: "⌘ 回车记下",
        keep: "记下",
        editsKept: "刚才的内容已提交，修改后的草稿已保留。",
        machine: "执行机器",
        machineAuto: "自动分配机器",
        missingRepo: "还没有添加仓库，可先记在待办，添加仓库后再派发。",
        goRepos: "去添加仓库",
        missingRuntime: "尚未启用可用引擎，配置好编码引擎后就能自动起草和开工。",
        goRuntimes: "去配置引擎",
      },
      conversation: { title: "讨论与交付记录", older: "加载更早的消息", empty: "需求讨论、执行反馈与交付会保留在这里" },
      attachments: {
        title: "附件",
        attachFile: "添加附件",
        count: "{n} 个附件",
        uploadFailed: "附件上传失败：{why}",
        uploading: "正在上传 {name}…",
        remove: "移除附件 {name}",
      },
    },
    "web.library": {
      upload: "上传",
      uploading: "正在上传…",
      make: "生成",
      makeTitle: "生成",
      empty: "还没有媒体文件",
      emptyHow: "生成一张图或一段语音、上传或拖进来一个文件，或者在对话里让执行会话把找到的东西放进来。",
      nothingShown: "没有符合筛选的内容。",
      drop: "松开，放进媒体库",
      kind: { all: "全部", image: "图片", audio: "音频", video: "视频", other: "其它" },
      sortLabel: "排序",
      sort: { recent: "最近", name: "名字", size: "大小" },
      tileSize: "缩略图大小",
      job: {
        image: "生图",
        speech: "单人语音",
        speakers: "多人对白",
        voiceDesign: "音色设计",
        clone: "音色克隆",
        transcription: "转写",
        understanding: "理解",
      },
      from: {
        generated: "生成的 · {job}",
        uploadedHere: "你在媒体库上传的",
        uploadedIn: "你在 {channel} 发的",
        fetchedUrl: "{agent} 从 {url} 拿回来的",
        fetchedPath: "{agent} 从工作区的 {path} 拿回来的",
      },
      inspector: {
        kind: "种类",
        pixels: "尺寸",
        bytes: "大小",
        length: "时长",
        from: "来路",
        added: "加入",
        openChannel: "去 {channel} 看",
        versionBadge: "第 {version} 稿",
        selected: "已选 {n} 个",
        clear: "不选了",
        more: "更多",
      },
      sendTo: "发到频道",
      sentTo: "发到了 {channel}",
      remove: "从库里拿掉",
      removeAsk: "从媒体库拿掉「{name}」？对话里发过的照样能打开。",
      removeSome: "从媒体库拿掉这 {n} 个？对话里发过的照样能打开。",
      removeSure: "拿掉",
      keep: "算了",
      understand: "理解",
      understandTitle: "理解「{name}」",
      understood: "理解的结果",
      makeTabs: { image: "生图", speech: "单人语音", audio: "音频工作台" },
      content: {
        title: "内容",
        new: "新建",
        searchAll: "搜索全部内容…",
        sidebarToggle: "展开或收起内容导航",
        recent: "全部最近",
        pinned: "置顶收藏",
        pin: "置顶",
        unpin: "取消置顶",
        pinnedToast: "已置顶收藏",
        unpinnedToast: "已取消置顶",
        newNote: "新建大纲笔记",
        artifacts: "作品",
        media: "素材",
        sendArtifact: "发到频道",
        exportArtifact: "导出",
        turnIntoIssue: "转为任务",
        issueCreated: "已创建任务",
        source: { all: "全部来源", agent: "执行会话交付", user: "我创建的" },
        artifactType: { all: "全部作品" },
        inspector: {
          openExternal: "系统打开",
          saveAs: "另存为",
          copyPath: "复制路径",
          copiedPath: "已复制路径",
          reveal: "在访达中显示",
          stopAudio: "停止播放",
        },
        templates: {
          title: "新建内容",
          search: "搜索模板…",
          empty: "没有匹配的模板",
          cat: { recommended: "推荐", note: "大纲笔记", whiteboard: "白板与图表", deliverable: "交付作品", ai: "AI 生成" },
          items: {
            noteBlank: { name: "空白大纲笔记", desc: "轻量单栏大纲，支持缩进、待办与双链" },
            noteTech: { name: "技术方案大纲", desc: "背景目标、核心设计与拆解清单" },
            noteMeeting: { name: "会议纪要", desc: "讨论焦点、关键结论与后续待办" },
            noteDaily: { name: "每日工作记录", desc: "今日主线、阻塞点与交接摘要" },
            wbBlank: { name: "空白白板", desc: "自由无限画布，点阵网格与原生连线" },
            wbArch: { name: "系统架构图", desc: "分层节点与数据流箭头连线" },
            wbTimeline: { name: "产品发布时间线", desc: "里程碑节点与交付阶段节奏" },
            wbJourney: { name: "用户旅程图", desc: "关键触点、痛点观察与改进机会" },
            wbWorkshop: { name: "启动工作坊", desc: "目标拆解、发散便签与收口结论" },
            artDocs: { name: "协作文档", desc: "长文规范、评审报告或技术说明" },
            artSlides: { name: "演示幻灯片", desc: "宽屏多页演示文稿与分页备注" },
            artDashboard: { name: "数据看板", desc: "指标卡片、趋势核验与明细表" },
            artDesign: { name: "界面画板", desc: "多画板界面探索与组件属性调节" },
            artDesignSystem: { name: "设计体系", desc: "色彩令牌、字阶规范与对比度核验" },
            artMotion: { name: "动态短片", desc: "可交互动效预览与视频导出" },
            artHtml: { name: "单页网页", desc: "独立可交互网页与版本迭代" },
            artSheet: { name: "电子表格", desc: "多工作表结构化表格与 CSV 导出" },
            artDiagram: { name: "结构图表", desc: "节点、连线与架构流程表达" },
            artStoryboard: { name: "分镜脚本", desc: "镜头清单、景别、色调与对白脚本" },
            aiImage: { name: "AI 生成图片", desc: "根据描述生成概念插画、图标或配图" },
            aiSpeech: { name: "AI 单人语音", desc: "将文案合成为自然人声音频文件" },
            aiAudio: { name: "音频工作台", desc: "多人对白、音色设计、克隆与转写" },
          },
          seed: {
            noteTech: "## 背景与目标\n- 说明要解决的核心问题与收益边界\n## 核心设计\n- 梳理模块边界与数据流\n## 实施拆解\n- [ ] 拆分任务步骤并补全验收测试",
            noteMeeting: "## 讨论焦点\n- 记录本次沟通的核心议题\n## 关键结论\n- 写下已达成一致的决定\n## 后续待办\n- [ ] 跟进确认后的行动项",
            noteDaily: "## 今日主线\n- [ ] 列出今天优先推进的事项\n## 阻塞与风险\n- 记录需要协作解开的卡点\n## 交接摘要\n- 今日完成的结果与后续衔接点",
            wbBlankTitle: "中心主题",
            wbBlankBody: "从工具栏添加卡片、便签与连线",
            wbArchN1Title: "接入层 · UI",
            wbArchN1Body: "边界输入与事件分发",
            wbArchN2Title: "核心域 · Core",
            wbArchN2Body: "纯状态折叠与规则校验",
            wbArchN3Title: "持久化 · 存储",
            wbArchN3Body: "落盘写入与工作区同步",
            wbArchE1: "请求",
            wbArchE2: "写入",
            wbTlP1Title: "阶段一 · 锁定范围",
            wbTlP1Body: "确认交互原型与核心边界",
            wbTlP2Title: "阶段二 · 原生实现",
            wbTlP2Body: "完成核心功能与集成测试",
            wbTlP3Title: "阶段三 · 验收发布",
            wbTlP3Body: "双主题截图核验与发布上线",
            wbJourneyJ1Title: "1. 触发入口",
            wbJourneyJ1Body: "进入统一内容工作台",
            wbJourneyJ2Title: "2. 定位筛选",
            wbJourneyJ2Body: "一次定位笔记、作品与素材",
            wbJourneyJ3Title: "3. 协作交付",
            wbJourneyJ3Body: "发到频道或转为任务推进",
            wbJourneyS1Title: "痛点观察",
            wbJourneyS1Body: "减少列表与编辑页之间的来回切换",
            wbJourneyE1: "定位",
            wbJourneyE2: "闭环",
            wbWorkW1Title: "本次目标",
            wbWorkW1Body: "对齐交付范围、约束与优先级",
            wbWorkW2Title: "痛点发散",
            wbWorkW2Body: "贴出高频摩擦场景与想法",
            wbWorkW3Title: "方案收口",
            wbWorkW3Body: "收敛第一阶段优先落地的改动",
            wbWorkE1: "发散",
            wbWorkE2: "收敛",
          },
        },
        search: { title: "搜索内容", placeholder: "搜索笔记、作品和素材…", empty: "未找到匹配的笔记、作品或素材", typeMedia: "素材" },
      },
    },
    "web.media": {
      speech: {
        title: "单人语音生成",
        notice:
          "将文字发送到下方的 MOSS 账号，生成单人语音，可能产生费用。不会自动播放；Flash 流式播放也需手动开始。取消只停止本机等待，不代表供应商停止处理或计费。生成音频每个文件最多 512 MB；超过 25 MiB 的结果保存在仅你可访问的 Media 存储中，与上传输入共用 2 GiB 配额，不能发布到频道。",
        configure: "请先在 AI 服务中选择语音生成连接和 Flash 或 Pro 模型。",
        binding: "{account} · {connection} · {model} · 配置版本 {revision}",
        refresh: "刷新连接配置",
        voice: "音色",
        voiceHint: "音色属于下方显示的账号。音色可见不代表生成权限或效果已经验证。",
        chooseVoice: "选择账号音色",
        firstVoices: "重新加载音色首页",
        nextVoices: "下一页音色",
        emptyVoices: "此账号在这一页没有返回音色。",
        format: "音频格式",
        execution: "执行方式",
        synchronous: "等待生成结果",
        asynchronous: "可恢复的异步任务",
        downloadOnly: "此格式在当前设备上仅提供下载；原始 PCM 不包含可直接播放的参数。",
        resume: "恢复查询原任务",
        text: "要朗读的文字（最多 10,000 字符）",
        submit: "生成语音",
        pending:
          "请求 ID、原账号、配置版本、音色、文字与格式已固定。重试同一提交只会取回同一任务，不会重新生成结果未知的请求；要修改输入或再次生成，请明确开始新请求。",
        new: "新的语音请求",
        history: "最近的语音任务",
        empty: "还没有语音任务。先配置语音连接，选择音色并输入文字。",
        save: "保存音频",
        publish: "发布音频",
      },
      understanding: {
        title: "理解图片与视频",
        notice:
          "选 1–5 张图片（每张不超过 30 MB）或一个视频（不超过 200 MB），不要混传。文件先存到这台电脑，经你确认后才发给下方的 MOSS 连接，可能产生费用。停止等待不代表供应商停止处理。",
        configure: "请先在 AI 服务中选择图片与视频理解的连接。",
        prompt: "想让模型说明什么？",
        tokens: "最多输出多少 token",
        executor: "执行方式／授权频道",
        direct: "现在由我提交",
        authorize: "登记主助手授权",
        authorizationNotice: "仅登记这份问题、输入和输出上限，不立即上传到 MOSS。所选频道的主助手可在 15 分钟内替你执行一次；取消、过期或服务端重启后失效。",
        authorization: "已授权频道 {channel}。发送给主助手后才开始执行；授权在登记后 15 分钟失效。",
        delegate: "发送给主助手",
        delegated: "已发送给主助手",
        delegation: "请执行我已授权的媒体理解任务 {id}，完成后告诉我结果。",
        consent: "我同意将这些文件和问题发送到上方的 MOSS 连接。",
        uploading: "正在将选中的文件保存到本机…",
        stopUpload: "停止本机上传",
        submit: "提交理解",
        new: "新的理解请求",
        newAsk: "开始新的请求？这可能再次上传并产生费用，不会找回先前未知的结果。",
        pending: "已保留请求 ID；重复提交不会再次上传或推理。要换一个问题，请明确开始新的请求。",
        history: "最近的理解任务",
        truncated: "结果不完整，已收到的文字保留在下方。要增加输出上限，需要发起新请求，可能再次计费。",
        usage: "供应商回报：输入 {input} token · 输出 {output} token · 总计 {total}",
        save: "将文字存为作品",
        open: "打开保存的作品",
        cleanup: "清理远端文件",
        cleanupAsk: "删除已知远端文件并释放本机输入的保留？供应商可能还在处理结果未知的请求。没有确认 ID 的上传可能仍有文件，需要人工核对；这不会重复理解。",
      },
      sourceUser: "来源：你",
      sourceAgent: "来源：主助手 {agent} · 频道 {channel}",
      usage: "厂商报告：{images} 张 · {width} × {height}",
      usageUnknown: "尚无厂商用量结果；不代表未计费。",
      prompt: "提示词 / 布局 JSON",
      format: "输入方式",
      text: "文生图",
      layout: "布局生图",
      width: "宽度",
      height: "高度",
      advanced: "高级参数",
      seed: "随机初值（可选）",
      steps: "推理步数（可选）",
      guidance: "引导系数（可选）",
      negative: "负向提示词",
      enhance: "增强提示词",
      watermark: "保留可见水印",
      generate: "提交生成",
      resubmit: "重试同一提交",
      new: "新建生成",
      newAsk: "创建新的生成请求？新请求可能再次计费，不会恢复上一请求的未知结果。",
      notice: "提交会把输入发送给 MOSS，可能产生费用。超时或取消等待不代表厂商停止计算；不会自动重新生成。",
      pending: "这份输入已经提交。网络中断时可重试同一提交；要修改参数或再次生成，请明确新建生成。",
      empty: "还没有生成任务。先配置生图连接，再提交提示词。",
      history: "最近的生成任务",
      cancel: "取消等待",
      cancelAsk: "停止本机等待？厂商可能仍在生成或计费。",
      retry: "只重试下载",
      releasePreview: "查看本机音频释放范围",
      release: "释放本机音频",
      releaseAsk: "释放未共享的本机音频，并永久放弃此任务的恢复和下载重试？转写、音色、已发布附件和记录仍保留；远端处理和计费可能继续，不会重新生成音频。",
      save: "保存图片",
      channel: "发布到频道",
      chooseChannel: "选择频道",
      publish: "发布图片",
      published: "已发布",
    },
    "web.memory": {
      memory: {
        yours: "你记的",
        orchestrators: "主助手替它记的",
        sessions: "{name} 记的",
        own: "它自己记的",
        intro:
          "这个 agent 派出去的执行会话共用一份记忆。每一轮开始，和这一轮有关的几条放在它收到的话前面；一轮结束，它在汇报里写的「记住：」那几行，和这件活做到哪了，记进来。",
        issues: "手上的任务",
        noIssues: "它的执行会话还没做完过一轮。",
        helper: "执行会话",
        allRepos: "所有仓库",
        notes: "记下的",
        all: "全部",
        emptyHere: "这一栏没有。",
        nothing: "还没记下什么。执行会话在汇报里写「记住：」，或者你在上面替它记。",
        neverRecalled: "还没想起过",
        fading: "快忘了：记满 {keep} 条时最先丢",
        inSource: "在 {source} 里",
        forgetThere: "要删到 {source} 里删",
        sources: "记忆从哪来",
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
        where: "在哪个仓库开工",
        pick: "选仓库",
        words: "这一轮的话",
        wordsHint: "这一轮的话（可以不填）",
        blank: "在这个仓库里开工，什么也想不起来。",
        noRepos: "还没有仓库。",
        orchestratorReading: "在读主助手的记忆……",
        orchestratorIntro: "主助手开工时和每次压缩后读一遍记忆；中间记下、忘掉的，它下一句就知道。",
        orchestratorNothing: "还没记下什么。跟主助手说「记住……」，或者你在上面替它记。",
        orchestratorOwn: "主助手自己记的",
        told: "你交代的",
        note: "替它记一条",
        noteRepo: "比如：clock-in 的测试用 pnpm test，别用 npm",
        noteOrchestrator: "比如：提交信息写中文；周末别派夜班",
        repo: "仓库",
        repoHint: "仓库（可以不填）",
        noteHint: "写成下次一看就懂的一句话。",
        noteHintRepo: "写成下次一看就懂的一句话。仓库留空就是所有仓库都用得上。",
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
      orchestrator: {
        tab: { memory: "记忆", voice: "声音" },
        all: "全部角色",
        title: "主助手",
        intro: "主助手不当执行会话：听你说要做什么，派执行会话去做，盯着进度，转告结果。",
        look: "长相是{name}。",
        profile: "改它的角色",
        runsLink: "查看轨迹",
        tabs: "主助手的",
        heard: "收到",
        quiet: "主助手还没开过口。",
        trajectory: "主助手每一轮的经过",
        about:
          "它收到的话、调的每个工具（点一行看参数和结果）、它说的话。新的在下面，一直留着最近的 1000 步。哪一轮做错了，在它收到的话上点「这一轮做错了」，写一句应该怎样，存成一条评测。",
      },
      approval: { title: "待审批的工具调用", allow: "允许这次调用", deny: "拒绝这次调用", unavailable: "读不到待审批的工具调用：{why}" },
    },
    "web.provider": {
      speechNotice:
        "可独立选择 Flash 或 Pro，再到媒体库的「生成」里生成单人语音。完整音频生成后可播放并保存为 WAV 或 MP3，不是流式播放；保存设置不会生成音频。",
      title: "用途",
      intro: "每个功能用哪个账号和模型。账号和钥匙在「账号与钥匙」里填。",
      words: "供应商 MOSS 连接 模型 密钥 生图 快照 理解 语音 音频 AI",
      understandingNotice: "配置独立的连接和模型。在媒体库的一张图或视频上点「理解」并明确确认上传；保存配置不会上传文件或发起推理。",
      imageNotice: "保存默认连接和模型后，在「生图」页提交生成任务。保存配置不会发起生图。",
      add: "添加 MOSS 连接",
      reload: "重新加载",
      reloadAsk: "放弃未保存的修改，读取最新设置？",
      console: "MOSS 开放平台",
      empty: "还没有供应商连接。添加 MOSS 连接后，可以配置默认用途。",
      name: "连接名称",
      enabled: "启用",
      remove: "删除连接",
      removeAsk: "从草稿中移除这条连接？保存后生效，仍被用途引用时不能保存。",
      discover: "查询模型",
      saveFirst: "先保存修改，再查询账号可用模型。",
      discoveryHint: "只查询目录，不发推理请求；模型可见不代表推理已验证。",
      noModels: "此账号返回的模型目录为空。",
      unbound: "不使用",
      liveHint: "MOSS Live 使用独立的连接和模型，用于实时语音通话。",
      bindingHint: "删除、禁用或清除密钥前，先将引用它的用途设为「不使用」。在途请求使用发起时的配置；新请求读取新设置。",
      manage: "管理 AI 服务连接",
      connections: "连接",
      uses: "用途",
      usesIntro: "每个用途选一个连接和模型；不选就是不使用。",
      groupImage: "图像",
      groupVoice: "语音",
      groupLive: "实时",
      use: {
        image: "生图",
        understanding: "媒体理解",
        speech: "单人语音",
        speakers: "多人语音",
        voiceDesign: "音色设计",
        transcription: "音频转写",
        live: "MOSS Live",
        vision: "实时视觉",
      },
      connectionFor: "{use}用的连接",
      modelFor: "{use}用的模型",
      openSpeechShort: "去生成",
      adapted: "能用的模型",
    },
    "web.remote": {
      title: "远程访问",
      subtitle: "通过 Tailscale 从手机远程查看与操作这台 Mac 上的 VibeValley。",
      toggle: { enable: "开启远程访问", disable: "关闭远程访问", enabled: "已开启", disabled: "未开启" },
      tailscale: { online: "Tailscale 在线", offline: "Tailscale 未连接", ip: "Tailscale IP", url: "访问地址" },
      pair: {
        action: "配对新设备",
        qrHint: "在手机上扫描二维码，或手动输入地址与配对码",
        code: "配对码",
        expires: "有效期至 {time}",
        copy: "复制配对链接",
        copied: "已复制",
      },
      devices: {
        title: "已配对设备",
        platform: { ios: "iOS", android: "Android", cli: "命令行", machine: "执行机", sandbox: "沙箱", other: "其他设备" },
        lastSeen: "最近活跃：{time}",
        revoke: "撤销",
        empty: "还没有配对过设备。",
      },
      mobile: {
        pairTitle: "连接到 Mac",
        pairSubtitle: "输入 Mac 远程访问面板显示的地址和一次性配对码。",
        urlLabel: "Mac 地址",
        codeLabel: "配对码",
        deviceNameLabel: "设备名称",
        pairAction: "配对并连接",
        pairing: "正在配对…",
        invalidInput: "请填写有效的地址、配对码和设备名称。",
      },
      state: {
        connecting: "正在连接…",
        connected: "已连接",
        reconnecting: "连接中断，正在重连…",
        unauthorized: "访问权限已失效，请重新配对",
        offline: "已断开",
        disconnect: "断开连接",
      },
      tabs: { inbox: "收件箱", channels: "频道", sessions: "会话", issues: "任务" },
      inbox: { approve: "同意", deny: "拒绝", answer: "回复", empty: "收件箱为空，暂时没有待处理项。" },
      channel: { replyPlaceholder: "输入消息回复…", send: "发送", empty: "这个频道还没有消息。" },
      session: { promptPlaceholder: "给执行会话发一条指令…", send: "发送", stop: "停止", events: "轨迹", empty: "当前没有运行中的执行会话。" },
      issue: {
        filter: { all: "全部", active: "进行中", review: "待验收", done: "已完成" },
        comment: "评论",
        approve: "通过验收",
        changes: "打回修改",
        status: "状态",
        empty: "没有符合条件的任务。",
      },
      controlPlane: {
        title: "总控端连接",
        subtitle: "选择这台 Mac 运行本机内嵌服务端，还是连接到远端总控端。",
        modeLabel: "连接模式",
        mode: { embedded: "本机内嵌", remote: "远端总控端" },
        envOverride: "环境变量覆盖",
        switchAction: "连接远端总控",
        changeAction: "更换远端地址",
        resetAction: "恢复本机内嵌",
        methodLabel: "认证方式",
        method: { pair: "配对码", token: "令牌" },
        urlLabel: "总控端地址",
        urlPlaceholder: "https://hub.tailnet.ts.net:8791",
        codeLabel: "配对码",
        codePlaceholder: "6 位配对码",
        tokenLabel: "访问令牌",
        tokenPlaceholder: "vv_dev_…",
        labelField: "名称（可选）",
        labelPlaceholder: "例如：工作室主机",
        save: "保存连接",
        cancel: "取消",
        restartToRemote: "已保存远端总控端 {url}，重启 VibeValley 后生效。",
        restartToEmbedded: "已切回本机内嵌模式，重启 VibeValley 后生效。",
        tokenHint: "令牌 {hint}",
      },
    },
    "web.repo": {
      list: "仓库列表",
      add: "新增仓库",
      openWorkspace: "工作区",
      repos: "代码库",
      all: "全部",
      allLine: "整张地图：每个仓库一座岛",
      notGit: "还不是 git 仓库",
      finding: "在找……",
      none: "工作区里还没有仓库。点「新增仓库」新建一个，或从 GitHub 下载一个。",
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
      githubHint: "公开仓库的主页地址。下载到本地后，就能查看仓库和安排执行会话。",
      name: "仓库名",
      nameHint: "保存在工作区里；已有同名仓库不会被覆盖。",
      nameExample: "比如 raft-source",
      downloading: "正在下载仓库… 大仓库需要多等一会儿，最多 3 分钟。",
      making: "正在新建…",
      cancel: "取消",
      busy: "进行中…",
      download: "下载到工作区",
      create: "创建仓库",
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
      noRuntimes: "读不到引擎：",
      usedBy: " · {n} 个 agent",
      reading: "读取中…",
      bundled: "随 oar 一起装",
      commandLine: "命令行",
      unsupportedWhy: "不支持：{why}",
      checkedAt: "检测于 {clock}",
      recheck: "重新检测",
      account: "账户",
      skills: "技能",
      mcp: "MCP 服务器",
      tools: "工具",
      agents: "用到它的 agent",
      makeAgent: "用它捏一个新 agent",
      noneYet: "还没有。",
      afterInstall: "装好以后才能读到。",
      noUsage: "这个引擎不报告账户用量。",
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
      ownDefault: "引擎自己的默认",
      defaultEffort: "默认推理强度",
      default: "默认",
      maxWorking: "最多同时干活",
      maxWorkingHint: "用它的执行会话同时干活的上限，服务商限并发时有用。到了上限，新活派不出去，等有人干完。留空只受 VibeValley 整体的上限（同时 6 张任务）。",
      noLimit: "不另设",
      budget: "每日预算（元）",
      budgetLabel: "每日预算",
      budgetHint:
        "{pi, select, true {今天已经花了 {spent}（按 pi 的价目表估算）。到了预算就不再派新活，正在干的会干完。留空不设上限。} other {今天已经花了 {spent}（按模型的价目表估算）。到了预算就不再派新活，正在干的会干完。留空不设上限。}}",
      unlimited: "不设上限",
      env: "环境变量",
      envHint: "叠加到这个引擎上的每个执行会话；agent 自己的环境变量优先。",
      models: "模型",
      modelCount: "{n} 个",
      noModels: "这个引擎不报告模型列表。",
      effort: "推理强度",
      unreported: "不报告。",
      none: "没有。",
      library: {
        book: "技能书",
        search: "搜索技能",
        searchHint: "搜名字、说明、引擎……",
        noRuntimes: "读不到引擎：",
        installed: "这台电脑上装的 · {count}",
        noneReported: "引擎还没报告装了哪些技能（或者还在读）。",
        noMatch: "没有对得上的。",
        own: "你写的 · {count}",
        newSkill: "新技能",
        noSkills: "还没有技能：写一个 VibeValley 自己的，或者在引擎上装好再回来看。",
        builtIn: "VibeValley 自带 · {count}",
        builtInNote:
          "VibeValley 自带的技能：跟着 VibeValley 更新，不能在这里改或删。在 agent 的「技能」页签里勾上它，执行会话的提示里就带着它；想换一种做法，新建一个你自己的技能。",
        builtInTag: "自带",
        installedNote: "装在引擎上的技能：用这些引擎的执行会话会自己按需加载，不用在角色里勾。要改它，去它的文件里改。",
        where: "哪些引擎有它",
        inUse: "{n} 个 agent 在用，删掉会从它们身上去掉。",
        removeIt: "删掉？",
        name: "名字",
        nameLabel: "技能名字",
        nameHint: "比如：先写测试",
        when: "什么时候用",
        whenHint: "一句话。按需加载技能的引擎先读这句，再决定要不要读正文。",
        description: "技能说明",
        descriptionHint: "改行为之前，先补一个会失败的测试。",
        body: "正文",
        bodyHint: "写成给 agent 看的指令（SKILL.md 的正文）。",
        bodyExample: "改任何行为之前，先写一个能复现问题的测试……",
        who: "谁在用",
        nobody: "还没有 agent 带这个技能。到 agent 的「技能」页签里勾上。",
      },
      quota: { session: "当前会话", weekly: "本周额度", week: "本周（{models}）", oneWeek: "· 一周", unreported: "不报额度", signedOut: "没登录" },
      spentToday: "今天执行会话花了约 {spent}，没设每日预算。",
      spentTodayBudget: "今天执行会话花了约 {spent}，每日预算 {budget}。",
      signInTerminal: "打开终端登录",
      machines: {
        title: "执行机器",
        kind: { local: "本机", remote: "远端", sandbox: "临时沙箱" },
        platform: { macos: "macOS", linux: "Linux", container: "容器", other: "其他" },
        status: { online: "在线", offline: "离线", draining: "排空中" },
        machineId: "机器 ID",
        worktree: "工作树",
        worktreeYes: "支持",
        worktreeNo: "不支持",
        installedCount: "已装引擎",
        lastSeen: "最近在线",
      },
      sidebarToggle: "收起或展开引擎列表",
      refreshAll: "刷新机器与引擎",
      inspectorTitle: "机器与检查器",
      inspectorShow: "展开右侧检查器",
      inspectorHide: "收起右侧检查器",
      noneInstalled: "未检测到已安装的编码引擎",
      noneInstalledHint: "在本机或远端主机安装编码引擎后，点刷新即可查看并配置。",
      remoteSummary: "运行在 {machine} 上，由该执行主机托管。",
      sessions: "相关会话",
      noSessions: "暂无活跃或最近的会话。",
      quickActions: "快捷操作",
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
        subagentGot: "子代理接到",
        told: "带话",
        recalled: "想起了",
        subagentThought: "子代理想了想",
        thought: "想了想",
        subagentSaid: "子代理说",
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
        subagentGot: "子代理接到",
        issue: "任务",
        told: "带话",
        usedTools: "用了 {n} 个工具",
        process: "这一轮的轨迹",
        tag: { thought: "想了想", subagentThought: "子代理想了想", said: "它说", subagentSaid: "子代理说", usage: "用量" },
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
        searchHint: "搜索步骤、工具、参数...",
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
        wantHint: "它应该怎样：比如「先问我是哪个仓库，别直接派活」",
        hired: "{ago}接活",
        hiredAndLeft: "{hired}接活 · {left}走的",
      },
      hub: {
        search: "搜索运行与轨迹",
        searchHint: "搜名字、任务、仓库…",
        scopeLabel: "按范围看",
        scope: { all: "全部", active: "进行中", orchestrator: "主助手", worker: "执行会话" },
        list: "运行列表",
        back: "全部运行",
        filterAgent: "角色：{name}",
        filterIssue: "任务：{label}",
        clearFilter: "清掉筛选",
        clear: "清除",
        empty: "还没有运行记录。",
        emptyFiltered: "没有符合当前筛选的运行。",
        pick: "选一条运行，查看完整轨迹。",
        openIssue: "看任务",
        openProfile: "看角色",
        orchestratorRole: "主助手",
        status: { working: "进行中", listening: "在听", resting: "待命", done: "已完成", failed: "失败", interrupted: "已中断", closed: "已结束" },
      },
      subagents: {
        heading: "子任务",
        root: "主线程",
        wait: "{who}在等「{targets}」",
        observed: "{ago}确认 · {status}",
        creator: "派出者：{who}",
        openLog: "查看「{task}」的工作日志",
        noLog: "近期工作日志中暂无这条线程的步骤。",
        status: {
          pendingInit: "等待启动",
          running: "执行中",
          interrupted: "已中断",
          completed: "已完成",
          errored: "失败",
          shutdown: "已关闭",
          notFound: "找不到线程",
          unknown: "状态未知",
        },
        steps: { title: "最近报告的步骤", pending: "未开始", inProgress: "进行中", completed: "已完成" },
        disconnected: "{ago}检测到进度连接中断。以下为最后确认的状态。",
        lastWait: "中断前，{who}在等「{targets}」",
        mailbox: "{who}在等协作消息",
        lastMailbox: "中断前，{who}在等协作消息",
      },
    },
    "web.setting": {
      language: {
        title: "语言",
        line: "界面上的字、主助手和执行会话回你的话、发到聊天软件的汇报，都用这种话。换了以后页面会重新打开。",
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
        userHint: "你在 EverOS 里的 user_id（空着用默认的那个）",
        read: "读",
        readHint: "开工想起、执行会话翻记忆时也问它",
        write: "写",
        writeHint: "记下的也送一份过去",
        everything: "读全部",
        everythingHint: "不只读 VibeValley 替执行会话记的，你在里面的记忆每个执行会话都读得到",
      },
      github: {
        noGh: "没装 gh",
        note: "能提 PR 的仓库在「仓库」里看；完成时提 PR 要在配置里打开（github.pr_repos）。",
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
        general: "通用与外观",
        appearance: "外观",
        models: "模型与密钥",
        skills: "技能",
        voice: "语音与通话",
        connections: "外部连接",
        remote: "远程访问",
        about: "关于与数据",
        memory: "记忆",
        chat: "聊天软件",
        width: "导航的宽窄（拖动，双击回默认）",
      },
      words: {
        general: "语言 language 启动 打开 工作台 农场 主题 深色 浅色 暗色 dark light 界面大小 缩放 字体 字号 动画 无动画 动效 motion animation",
        models: "密钥 钥匙 账号 DeepSeek MOSS API Key 模型 绑定",
        skills: "技能 skill skills 内置 安装 指南 提示词",
        memory: "记忆 memory 来源 source Nowledge EverOS 外部记忆 读 写",
        voice: "电话 通话 MOSS Live 实时 视觉 转写 语音",
        connections: "微信 飞书 QQ 连接器 配对 GitHub gh PR 登录",
        remote: "远程 手机 Tailscale 配对 二维码 设备 iOS Android CLI 命令行 执行机 沙箱 监听 令牌 总控端 内嵌 远端",
        about: "版本 家目录 设置文件 数据 version",
      },
      scope: { farm: "对整个 VibeValley", device: "只对这台设备" },
      general: {
        languageHint: "界面、主助手和执行会话说的话都用它",
        start: "启动时打开",
        startHint: "打开应用、或者打开首页时先进哪里",
        starts: { workbench: "工作台", farm: "农场" },
      },
      appearance: {
        theme: "主题",
        themeHint: "跟随系统时随电脑的浅色和深色变",
        themes: { light: "浅色", dark: "深色", system: "跟随系统" },
        motion: "动画",
        motionHint: "关闭后跳过界面过渡动画与背景帧循环，更适合 UI 测试与专注模式。",
        motionOption: { off: "无动画", on: "动画", system: "跟随系统" },
        scale: "界面大小",
        scaleHint: "缩放整个工作台；农场按整数倍放大，不跟着变",
        monoFont: "终端与代码字体",
        monoFontRow: "终端与代码字体（支持 Nerd Font）",
        monoFontHint: "用于终端、Diff 与文件预览的等宽字体，内置 Nerd Font 图标回退链",
        terminalFontSize: "终端字号",
        terminalFontSizeHint: "也可在工作区随时按 ⌘+ / ⌘- / ⌘0 调整",
      },
      models: { intro: "配置主助手、执行会话与语音功能的模型账号和 API 密钥。", deepseekHint: "主助手和 VibeValley 自研执行会话用它" },
      memory: { intro: "执行会话还能去外面的记忆来源里查、往里记。" },
      about: {
        version: "版本",
        versionHint: "这台电脑上的服务端",
        files: "文件",
        home: "家目录",
        homeHint: "VibeValley 的一切都在这里",
        settings: "设置文件",
        settingsHint: "钥匙和这几页的设置",
        repos: "仓库目录",
        reposHint: "这个空间的仓库，每个文件夹都是一个 git 仓库",
        worktrees: "工作树目录",
        worktreesHint: "执行会话运行时每个任务自己的检出",
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
        workingQuestion: "{n} 个执行会话在运行，重启会打断它们。现在重启？",
        newFarmQuestion: "新版本从新的数据开始，旧的留在家目录里。现在重启？",
        download: "去下载",
        cli: "命令行",
        cliHint: "装上以后，在终端里用 {command} 读写这个 VibeValley，本机的 agent 也能用",
        cliReady: "在终端里用 {command}；本机的 agent 也能用它读写这个 VibeValley",
        cliNotOnPath: '已经装到 {link}，但 ~/.local/bin 不在 PATH 里：在 ~/.zshrc 里加一行 export PATH="$HOME/.local/bin:$PATH"',
        cliTaken: "{link} 已经有别的文件，没有换掉：先挪开它再装",
        cliInstall: "安装",
        cliRemove: "移除",
      },
      missing: {
        deepseekKey: "还没填 DeepSeek 的钥匙",
        mossAccount: "还没有 MOSS 账号",
        mossKey: "MOSS 账号还没填钥匙",
        mossOff: "用到的 MOSS 账号停用了",
        binding: "还没选用哪个账号和模型",
      },
      feature: {
        orchestrator: "主助手",
        image: "生图",
        understanding: "媒体理解",
        speech: "单人语音",
        speakers: "多人语音",
        voiceDesign: "音色设计",
        transcription: "音频转写",
        live: "MOSS Live",
        vision: "实时视觉",
        call: "通话",
      },
      readiness: { ready: "{feature}：可以用了", lacks: "{feature}：{why}", fix: "去设置" },
    },
    "web.shell": {
      sidebar: {
        title: "仓库与终端",
        addRepo: "添加仓库",
        addRepoButton: "仓库",
        addRepoTooltip: "添加本地仓库或文件夹",
        manageRepos: "管理仓库",
        running: "正在运行",
        runningAgent: "{agent} 正在运行",
        ready: "待命",
        readyAgent: "{agent} 待命",
        needsAttention: "需要关注",
        terminalCount: "{n} 个终端",
        workingCount: "{n} 运行中",
        readyCount: "{n} 待命",
        attentionCount: "{n} 需要关注",
        closeTab: "关闭标签",
        tabsGroup: "标签页",
        tabMore: "更多操作",
        newTerminal: "新终端：{name}",
        newChat: "新对话：{name}",
        closeFolder: "关闭文件夹：{name}",
        closeFolderMenu: "关闭文件夹",
        repoDetails: "仓库详情",
        backToRepos: "返回仓库列表",
        mainWorktree: "{label} · 主目录",
        mainLabel: "主目录",
        collapseAll: "折叠全部",
        expandCurrent: "展开当前",
        collapseItem: "折叠 {name}",
        expandItem: "展开 {name}",
        newTerminalHere: "在此新建终端",
        newChatHere: "在此新建对话",
        chatWaiting: "等待确认回复",
        revealInFinder: "在 Finder 中显示",
        copyPath: "复制路径",
        removeWorktree: "删除工作树",
        files: "文件",
        filesTip: "工作区文件",
        gitChanges: "变更",
        gitChangesTip: "工作区改动与暂存",
        gitBranches: "分支",
        gitBranchesTip: "本地分支与工作树",
        gitCommits: "提交",
        gitCommitsTip: "提交历史记录",
      },
      fileTree: {
        title: "文件",
        collapseAllDirs: "折叠全部目录",
        loading: "正在读取目录…",
        empty: "此目录为空。",
        copyRelPath: "复制相对路径",
        copyAbsPath: "复制绝对路径",
        revealInFinder: "在 Finder 中显示",
        newTerminalInDir: "在此目录新建终端",
      },
      git: {
        title: "版本控制",
        loading: "正在读取 Git 状态…",
        notRepo: "当前目录不是 Git 仓库。",
        refresh: "刷新 Git",
        justNow: "刚刚",
        minutesAgo: "{n}分钟前",
        hoursAgo: "{n}小时前",
        daysAgo: "{n}天前",
        confirmDiscard: "确认丢弃",
        cancel: "取消",
        unstagePath: "取消暂存 {path}",
        discardPath: "丢弃改动 {path}",
        stagePath: "暂存 {path}",
        tab: { changes: "变更", changesCount: "变更 ({count})", branches: "分支 ({count})", commits: "历史" },
        commitPlaceholder: "输入提交信息…",
        committing: "正在提交…",
        commitSuccess: "提交成功",
        commitStaged: "提交暂存变更 ({count})",
        noStaged: "暂无暂存文件",
        stageAllCount: "一键暂存全部变更 ({count})",
        conflicts: "冲突",
        staged: "已暂存",
        unstageAll: "全部取消暂存",
        stagedEmpty: "暂无已暂存的文件。",
        changes: "未暂存",
        stageAll: "全部暂存",
        clean: "工作区干净，没有未提交改动。",
        branches: "本地分支",
        filterBranches: "过滤分支名…",
        noMatchingBranches: "没有匹配的本地分支。",
        currentBranch: "{name}，当前分支",
        switchBranch: "切换到 {name}",
        switching: "切换中…",
        noBranches: "未找到本地分支。",
        worktrees: "工作树",
        newWorktree: "新建工作树",
        creatingWorktree: "创建中…",
        newBranchPlaceholder: "新分支名，如 feat/login",
        createBtn: "创建",
        mainLabel: "主目录",
        removing: "正在删除…",
        removedWorktree: "已删除工作树 {label}",
        removeFailed: "删除失败：{why}",
        wtConflictsCount: "{n} 冲突",
        wtChangedCount: "{n} 变更",
        wtClean: "干净",
        wtDirtyPrompt: "包含未提交变更",
        wtConfirmDeletePrompt: "确认删除该工作树？",
        wtForceDelete: "强制删除",
        wtConfirmDelete: "确认删除",
        wtRemoveMenu: "删除工作树…",
        wtRunning: "干活中",
        commits: "提交记录",
        noCommits: "暂无提交记录。",
      },
      section: { collapse: "折叠 {title}", expand: "展开 {title}" },
      palette: {
        placeholder: { commands: "输入命令或跳转到任意页面…", files: "跳转到文件…", search: "在项目中搜索文本…" },
        mode: { commands: "命令", files: "文件", search: "搜索" },
        a11y: { commands: "命令", files: "文件", search: "搜索结果" },
        searching: "搜索中…",
        empty: { commands: "没有匹配的命令。", files: "没有匹配的文件。", search: "没有匹配结果。" },
        footer: { select: "选择", run: "执行", close: "关闭" },
      },
      chat: {
        title: "工作区对话",
        runtime: "编码引擎",
        model: "模型",
        thoughtLevel: "思考深度",
        thoughtLow: "低",
        thoughtMedium: "中",
        thoughtHigh: "高",
        thoughtMax: "极深",
        statusWaiting: "等待确认",
        emptyTitle: "在当前工作区直接对话",
        emptyHint: "选择引擎后直接提问，工具调用结果可一键在右侧分栏打开源码或 Diff。",
        you: "你",
        steerTag: "轮中引导",
        thinking: "思考过程",
        toolOpenFile: "打开文件",
        toolOpenDiff: "查看 Diff",
        toolRunning: "执行中",
        toolOk: "完成",
        toolFailed: "失败",
        toolPending: "等待输出…",
        toolNoOutput: "无输出",
        interactionBadge: "需要你确认 · 不会自动批准",
        interactionAnswered: "已回复",
        interactionDeclined: "已拒绝",
        interactionCustomPlaceholder: "或输入自定义回复…",
        interactionConfirm: "确认并继续",
        interactionDecline: "拒绝",
        permissionBadge: "工具权限请求",
        permissionAllowOnce: "仅允许本次",
        permissionAllowSession: "本会话始终允许",
        permissionDeny: "拒绝",
        composerPlaceholder: "向 {runtime} 提问或下达改动任务… (Enter 发送，Shift+Enter 换行)",
        steerPlaceholder: "会话运行中，输入指令即插入轮中引导 (Steer)…",
        steeringBanner: "回合进行中 · 发送将经 session.send 插入轮中引导，不中断上下文",
        send: "发送",
        steer: "插入引导",
        stop: "停止",
        telemetryContext: "上下文 {pct}%",
        telemetryCache: "缓存 {pct}%",
        telemetryTurns: "{turns} 轮 · {tools} 工具",
        telemetryQuota: "配额 {pct}%",
        telemetryDetails: "遥测详情",
        telemetryHide: "收起遥测",
        telemetryContextTitle: "上下文窗口",
        telemetryCacheTitle: "Prompt Cache 与工具",
        telemetryQuotaTitle: "引擎配额",
        telemetryCached: "缓存读取",
        telemetryUncached: "新增输入",
        telemetryOutput: "输出",
        telemetryReasoning: "思考",
        telemetryQuotaUnavailable: "当前引擎未上报配额窗口。",
        sendFailed: "发送失败：{why}",
        configFailed: "切换配置失败：{why}",
        respondFailed: "提交回复失败：{why}",
        stopFailed: "中断会话失败：{why}",
        attachFile: "添加文件",
        removeFile: "移除 {name}",
        chooseModel: "切换引擎与模型",
      },
      swarm: {
        pill: "Swarm · {working}/{active}",
        openDrawer: "打开 Swarm 协作面板",
        closeDrawer: "收起 Swarm 协作面板",
        tabOverview: "总览",
        tabRoster: "成员",
        tabBoard: "黑板",
        overviewEmpty: "当前暂无协作线程总览。",
        roleCoordinator: "协调者",
        roleWorker: "成员",
        stateWorking: "工作中",
        stateWaiting: "等待中",
        stateWaitingMentions: "等待 @提及 #{seq}",
        stateWaitingAll: "等待全部 #{seq}",
        stateStopped: "已停止",
        stateKilled: "已结束",
        rosterSelectHint: "点击左侧成员查看近期轨迹步骤。",
        transcriptTitle: "近期轨迹",
        transcriptRefresh: "刷新轨迹",
        transcriptEmpty: "暂无可读轨迹步骤。",
        transcriptFailed: "加载轨迹失败：{why}",
        transcriptThinking: "思考",
        boardAll: "全部",
        boardFilterPlaceholder: "过滤黑板消息…",
        boardEmpty: "黑板暂无消息。",
        boardBrief: "任务简报",
        boardJumpLatest: "跳到最新",
        boardCount: "{shown}/{total} 条",
      },
      repoDetail: {
        badgeManaged: "VibeValley 仓库",
        badgeFolder: "本地目录",
        openFullPage: "打开完整仓库页",
        copied: "已复制路径",
        newChat: "新对话",
        newTerminal: "新终端",
        sectionOverview: "概览",
        branch: "当前分支",
        repoType: "类型",
        typeGit: "Git 仓库",
        typeFolder: "普通目录",
        activity: "工作区",
        activitySummary: "{worktrees} 工作树 · {tabs} 标签",
        openIssues: "进行中任务",
        runningSessions: "运行中会话",
        maxSessions: "并发上限",
        pullRequest: "合并请求",
        prReady: "可用",
        prUnavailable: "未就绪",
        commits: "提交数",
        languages: "语言构成",
        worktrees: "工作树",
        tabsCount: "{n} 标签",
        closeFolder: "从工作区关闭目录",
      },
    },
    "web.voice": {
      voice: {
        section: { label: "声音" },
        noSettings: "问不到服务端的设置（{why}）。",
        saved: "存好了，下一通电话就用上。",
        persona: {
          intro: "打电话时主助手怎么开口。MOSS Live 连接与测试在",
          page: "页。",
          open: "开口",
          openParts: "人设 · 开场白",
          persona: "人设",
          personaHint: "电话里先答话的模型是谁、怎么说话。它看不到现状，派活由本机的主助手做；写明别编进度。",
          greeting: "开场白",
          greetingHint: "接通时先说的一句。",
        },
        moss: { verify: "测一下能不能接通", checking: "在接…", ok: "接通了" },
      },
      moss: {
        intro: "直接和 MOSS Live 说话，听它怎么答；连线经本机服务端，key 不出这台电脑。说的话不进默认频道。",
        talk: "开始说话",
        connecting: "在接通…",
        hangUp: "挂断",
        mute: "静音",
        unmute: "取消静音",
        nativeCall: "MOSS Live 通话",
        nativeNotice: "开始后采集麦克风，音频发送到已配置的 MOSS 账号，可能产生费用；双方最终字幕记进默认频道。离开本页会挂断。",
      },
    },
  },
  en: {
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
      status: { backlog: "Backlog", todo: "To do", in_progress: "In progress", in_review: "In review", done: "Done", canceled: "Canceled" },
      priority: { urgent: "Urgent", high: "High", medium: "Normal", low: "Low" },
      deliverable: {
        change: "A change, merged into the repo",
        branch: "A change, left on its branch",
        answer: "An answer, reading only",
        pull_request: "Submit PR/MR",
      },
      delivered: {
        merged: "merged into main",
        merged_into_parent: "merged into the plan's branch",
        pull_request: "its PR was merged",
        kept: "branch kept, not merged",
        none: "nothing to merge",
        submitted: "PR/MR submitted",
      },
      canceled: { dismissed: "canceled", lost: "its working folder is gone" },
      doneWith: "Done, {what}",
      canceledFor: "Canceled, {why}",
      stage: {
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
        quiet: "{what} (quiet for {span})",
        done: "this round is done, for you to see{conflict}",
        failed: "this round failed",
        resting: "resting (last round {last}){conflict}",
        rested: "resting{conflict}",
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
      join: { labeled: "{label}: {text}", aside: "{text} ({aside})", sentence: "{text}.", separator: ", " },
    },
    "web.agent": {
      newName: "New {runtime}",
      noProfiles: "The server's profiles could not be read: ",
      noRuntimes: "The machines could not be read: {why}",
      loading: "Reading the configuration…",
      noSuch: "There is no such profile.",
      backToAll: "Back to all profiles",
      unnamedAgent: "Unnamed agent",
      unnamed: "Unnamed helper",
      all: "All profiles",
      isNew: "New",
      unsaved: "Not saved",
      saved: "Saved",
      discard: "Discard changes",
      talk: "Message",
      saving: "Saving…",
      create: "Done, save it",
      save: "Save",
      runsLink: "View runs",
      remove: "Delete",
      removeWhich: "Delete {name}?",
      fine: "The configuration is fine: it can be sent work.",
      problems: "Why it cannot be sent",
      cannot: "Cannot be sent: ",
      random: "A random one",
      avatar: "Role avatar",
      avatarHint: "Shown in lists and chat; when unset, the farm animal face is shown.",
      avatarAnimal: "Animal face",
      looksAs: "On the farm it is",
      looksHint: "Only looks: the same runtime can be different animals.",
      wears: "Wears",
      tab: { who: "Who", runtime: "Machine", persona: "Persona", skills: "Skills", tools: "Tools", env: "Environment", memory: "Memory" },
      tabs: "Profile",
      name: "Name",
      nameTip: "The assistant and the captions call it this, and you can name it when you speak.",
      nameTaken: "An agent of this name already exists",
      duty: "Duty",
      dutyTip: "A sentence. The assistant reads it when picking someone.",
      roleHint: "Such as: writes endpoints, changes the server, runs the Go tests",
      tags: "Good for",
      tagsTip: "When your words have these, the assistant on Auto sends it first. Enter adds one.",
      tagsHint: "frontend, tests, docs…",
      enabled: "Enabled",
      enabledHint: "Disabled, the assistant does not send it, and refuses when it is named.",
      workdir: "Default repo",
      workdirTip:
        "A folder under the work folder (VIBEVALLEY_WORK_ROOT). Used when the assistant sends work without naming a repo; when empty, the repo must be named.",
      workdirHint: "such as clock-in",
      worktree: "A git worktree for each helper",
      worktreeHint:
        "Each helper changes its own branch, so helpers do not overwrite each other; completing merges it into the repo. Off, it changes the repo directly, with no branch to merge.",
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
      manageLibrary: "Manage the skill library",
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
      role: { orchestrator: "Assistant", worker: "Helper" },
      templates: {
        title: "Templates",
        intro:
          "Each template is a recipe for an agent: its role, duty, persona, the machine it is written for and its look. Installing one adds a profile, and one template can be installed many times; change what is installed as you like, and when the template has a new version the profile says so.",
        open: "Install from a template",
        openLine: "Recipes for assistants and helpers, to pick from",
        folder: "Template folder",
        folderHint: "The path of a template folder on this machine (with agent.json in it)",
        add: "Add it",
        added: 'The template "{name}" is added, not installed yet',
        onServer: "Runs on VibeValley's own agent",
        notHere: "Written for {runtime}, which this machine lacks: once installed, pick another machine in the profile",
        noPersona: "No persona.",
        addedHere: " · added on this machine",
        skill: 'Skill "{name}": {description}',
        fold: "Fold",
        removeSure: "Really delete the template",
        from: 'From the template "{name}", version {version}',
        update: "Update to the template's version {version}",
        updateHint: "The template's new version replaces the duty, tags, persona and how it is given; the name, look, machine, model and environment stay.",
        updated: "Updated from the template",
        galleryTitle: "Starter templates",
        galleryIntro: "Adopt a ready-to-use role with a working style, persona, and skills.",
        manageLink: "All templates & import",
        adopt: "Adopt",
        adopted: "{n} adopted",
        adoptedToast: 'Adopted "{name}"',
        willUse: "Uses {runtime}",
        style: "Style · {style}",
        preview: "Persona",
        category: { all: "All", engineering: "Engineering", product: "Product & Design", research: "Research & Docs", orchestration: "Assistants" },
      },
      orchestrator: {
        newName: "New assistant",
        intro:
          "An assistant stays, leads and does no work itself: it hears what you want done, sends helpers to do it, watches progress and passes on results. It runs on VibeValley's own agent, with its own direct messages, memory and trajectory; hand it a channel to look after, and what you say there it answers.",
        page: "Its memory and voice",
        nameTip: "Its name in the chat; others call it with @ and its profile id.",
        model: "Model",
        modelTip: "A DeepSeek model; empty is the default one.",
        modelHint: "deepseek-v4-flash",
        dutyTip: "One sentence: what it looks after.",
        personaTip: "Who it is, how it talks, what it looks after; it follows the assistant's prompt.",
        personaHint: "You look after the clock-in repo; read the tests before sending work…",
        look: "Look",
      },
      list: {
        filterLabel: "Filter by role",
        all: "All",
        orchestrators: "Assistants",
        helpers: "Helpers",
        search: "Search profiles",
        searchHint: "Search name, duty, machine, tags…",
        make: "New helper",
        makeOrchestrator: "Add assistant",
        orchestratorLine: "Not a helper: sends work, watches progress, passes on results.",
        orchestratorSummary: "Standing assistant",
        defaultBadge: "Default",
        disabledBadge: "Disabled",
        disable: "Disable",
        enable: "Enable",
        toggle: "{act} {name}",
        emptySearch: "No profiles match the current filters.",
        clearFilter: "Clear filters",
      },
      runtimeDefault: "The runtime's default",
      runtimeDefaultModel: "The runtime's default ({model})",
      noEffort: "This model has no effort levels.",
      noEffortModel: "{model} has no effort levels.",
      targetMachine: "Execution machine",
      targetMachineTip: "Pin this profile to a specific execution machine, or leave on Auto to route to the local or best online machine.",
      targetMachineAuto: "Auto (local or online)",
      targetMachineOffline: "{name} (offline)",
      targetMachineDraining: "{name} (draining)",
    },
    "web.artifact": {
      card: { version: "Version {version}", open: 'Open "{title}"' },
      page: {
        delete: "Delete",
        deleteAsk: "Delete “{title}”? Its cards stay in the conversation.",
        deleted: 'Deleted "{title}"',
        gone: "This artifact was deleted, or there is no such artifact.",
        new: "New",
        none: "No artifacts yet: give one a title to start it, or have a helper hand one in.",
        all: "All artifacts",
        title: "Title",
        more: "More",
        rail: "Beside this artifact",
        railShow: "Show the side panel",
        railHide: "Hide the side panel",
      },
      issue: { title: "Artifacts" },
      blocks: { saved: "All saved", user: "You", start: "Start writing here…" },
      canvas: { label: "Open artifact", close: "Close", openPage: "Open its page" },
      suggestions: { title: "Suggestions ({n})", by: "From {name}", accept: "Accept", reject: "Dismiss", delete: "Delete this block" },
      types: {
        defaultBadge: "Default DS",
        setDefault: "Set as default design system",
        unsetDefault: "Unset default",
        docs: "Document",
        outline: "Outline Note",
        slides: "Slide Deck",
        dashboard: "Dashboard",
        motion: "Motion Film",
        whiteboard: "Whiteboard",
        design: "Design Canvas",
        designSystem: "Design System",
        sheet: "Sheet",
        prototype: "Prototype",
        diagram: "Diagram",
        storyboard: "Storyboard",
      },
      timeline: {
        toggle: "History timeline",
        title: "Timeline",
        loading: "Loading history…",
        empty: "No history commits yet",
        prev: "Previous commit",
        next: "Next commit",
        backToLive: "Back to live",
        previewBanner: "Read-only history preview · {summary}",
        turn: "Turn {n}",
        restore: "Restore",
        restored: "Restored to selected commit",
        fork: "Fork",
        forkTitle: "{title} (Fork)",
        forked: "Forked as “{title}”",
        undoTurn: "Undo this turn",
        undoneOrigin: "Undid edits from this origin",
        compact: "Compact",
        compacted: "Compacted history snapshot",
      },
      dashboard: { exportCsv: "Export CSV" },
      whiteboard: {
        pan: "Pan",
        select: "Select",
        rect: "Rectangle",
        sticky: "Sticky note",
        card: "Card",
        diamond: "Diamond",
        text: "Text",
        container: "Container",
        pen: "Pen",
        sticker: "Sticker",
        arrow: "Arrow",
        timeline: "Timeline",
        undo: "Undo",
        redo: "Redo",
        duplicate: "Duplicate",
        chatWithOrchestrator: "Ask Assistant",
        templateTimeline: "Timeline template",
        templateArchitecture: "Architecture template",
        inspector: "Inspector",
        label: "Title / Label",
        body: "Body",
        noSticker: "None",
        save: "Save",
        entryJson: "Entry JSON",
        saveJson: "Save JSON",
        exportedSvg: "Exported SVG",
        exportedPng: "Exported PNG",
        exportedJson: "Exported JSON",
        exportedJsonCanvas: "Exported JSON Canvas",
        deleteSelected: "Delete selected",
        zoomIn: "Zoom in",
        zoomOut: "Zoom out",
        fitView: "Fit view",
        elements: "{n} elements",
        emptyHint: "Place cards, timelines, connectors, and stickers from the bottom bar, or start from a template",
        fillDefault: "Default",
        fillSun: "Sun",
        fillPeach: "Peach",
        fillLeaf: "Leaf",
        fillWater: "Water",
        fillLavender: "Lavender",
        fillBerry: "Berry",
        fillSide: "Neutral",
        curveSmooth: "Smooth",
        curveOrthogonal: "Orthogonal",
        curveStraight: "Straight",
        styleSolid: "Solid",
        styleDashed: "Dashed",
      },
      design: { noProps: "This artboard declares no adjustable props (data-props)" },
      designSystem: { components: "Components" },
      slidesStore: { addSlide: "Add slide" },
      edit: { save: "Save as a new version", saved: "Saved as version {version}" },
      slides: { previous: "Previous slide", next: "Next slide", present: "Present full screen", presenter: "Presenter view" },
      presenter: {
        missing: "No deck named: open the presenter view from an artifact's controls.",
        current: "This slide",
        next: "Next slide",
        end: "This is the last slide",
        notes: "Notes",
        noNotes: "No notes on this slide",
        clock: "Time so far",
        restart: "Restart timer",
        aside: "Next slide and notes",
        waiting: "Waiting for the slide deck",
        empty: "This deck has no slides",
        loadFailure: "Could not load the slide deck: {reason}",
      },
      standalone: { missing: "This artifact was deleted, or there is no such artifact.", version: "v{version}", live: "Live" },
      applet: {
        button: "Install as App",
        buttonInstalled: "App Installed",
        badgeInstalled: "Installed",
        modalTitle: "Local Desktop App",
        subtitle: "Install this artifact as a standalone Mac app you can launch from Spotlight or the Dock.",
        appNameLabel: "App Name",
        appNamePlaceholder: "Enter app display name",
        alwaysOnTopLabel: "Always on Top",
        alwaysOnTopHint: "Keep the standalone applet window floating above other windows.",
        statusInstalled: "Installed",
        statusNotInstalled: "Not installed",
        bundlePathLabel: "Bundle Path",
        bundleIdLabel: "Bundle ID",
        install: "Install App",
        reinstall: "Update & Reinstall",
        installing: "Installing…",
        open: "Open App",
        uninstall: "Uninstall",
        installedToast: "Installed “{name}.app”",
        uninstalledToast: "Uninstalled “{name}.app”",
        openedToast: "Opening “{name}.app”",
        nameRequired: "Enter an app name first",
        unavailable: "Local desktop app installation is unavailable in this host",
      },
    },
    "web.audio": {
      title: "Audio studio",
      notice:
        "Requests may incur charges. Canceling stops local waiting, not remote billing. Unknown outcomes are never automatically submitted again. Generated audio supports up to 512 MB per file. Results over 25 MiB stay in Media storage only you can reach, share its 2 GiB quota with uploaded inputs, and cannot be published to a channel.",
      configure: "Configure this capability in AI services first.",
      refresh: "Refresh accounts and configuration",
      account: "Voice account",
      chooseAccount: "Choose an account",
      voices: "Account voices",
      voice: "Voice",
      chooseVoice: "Choose a voice",
      first: "First page / refresh",
      next: "Next page",
      emptyVoices: "No voices returned for this account.",
      queryVoice: "Find a voice on this page",
      queryHint: "Search this account's current page by name or ID. Use Next page for more voices; individual remote lookup and deletion are not supported.",
      speakerTitle: "Multiple speakers",
      speakerHint:
        "Map up to five speakers to voices from the configured account, then add dialogue turns in order (10,000 characters total). Speaker IDs must be unique and use letters, digits, underscores or hyphens.",
      speaker: "Speaker ID",
      addSpeaker: "Add speaker",
      remove: "Remove",
      dialogue: "Dialogue",
      addTurn: "Add turn",
      text: "Text",
      generate: "Generate dialogue",
      designTitle: "Design a voice",
      instructions: "Voice instructions",
      previewText: "Preview text",
      preview: "Generate preview",
      designHint:
        "Preview generation does not save a reusable voice. Listen first, then explicitly save on the original account. Saving is available for WAV, MP3 or FLAC previews up to 30 seconds and 10 MB; longer previews can only be downloaded.",
      voiceName: "Reusable voice name",
      saveVoice: "Save reusable voice",
      savedVoice: "Saved voice: {voice}",
      cloneTitle: "Clone a voice sample",
      cloneHint:
        "Use only a voice you own or have permission to clone: WAV, MP3, M4A or FLAC, up to 30 seconds and 10 MB. Consent applies to this exact file and account revision; changing either requires consent again.",
      consent: "I have permission to use this sample and authorize uploading this file to the selected account for this request.",
      clone: "Create reusable voice",
      transcriptionTitle: "Long audio transcription",
      transcriptionHint:
        "Uploads audio up to one hour to the independently configured transcription account. Async waits for a remote task; streaming saves incoming text and speaker segments immediately. Leaving this page does not cancel the saved task. Only a completed result is final; interrupted streams stay partial and never reconnect or resubmit automatically.",
      execution: "Execution",
      executionHint: "Streaming is available only for the diarization model and its supported snapshot.",
      executionAsync: "Asynchronous task",
      executionStreaming: "Streaming text and speakers",
      partialTitle: "Partial transcript",
      partialTranscript: "Partial transcript — not a completed result.",
      savePartialTranscript: "Save partial transcript as artifact",
      chooseFile: "Choose an audio file",
      copyTranscript: "Copy transcript",
      copyPartialTranscript: "Copy partial transcript",
      usageAudioSeconds: "Input audio: {value} s",
      input: "Audio file",
      transcribe: "Start transcription",
      timeline: "Speaker timeline",
      noTimestamps: "The provider returned no timestamped segments.",
      saveTranscript: "Save transcript as artifact",
      openTranscript: "Open saved transcript",
      downloadAudio: "Download audio",
      history: "Audio tasks",
      empty: "No audio tasks yet.",
      pending: "This request is frozen. Checking it again reuses the same ID and account; it does not create another request.",
      check: "Check original request",
      new: "New request",
      newAsk: "Start a separate request? The original may still complete and incur charges.",
      uploading: "Uploading the selected audio to this server…",
      stopUpload: "Stop upload",
      format: "Audio format",
      transcript: "Transcript",
      diarize: "Identify speakers",
      resume: "Resume polling the original task",
      cleanupPreview: "Preview remote file cleanup",
      cleanup: "Retry remote file cleanup",
      cleanupAsk: "Delete the remote input files shown in this preview? This does not regenerate audio or change the saved result.",
      flashTitle: "Flash live playback",
      flashNotice:
        "Start explicitly to generate and play PCM as it arrives. Flash only; the completed stream is saved as WAV. Playback buffers at most five seconds. Stopping, leaving this page or changing devices closes the stream; it cannot reconnect, and charges may still apply.",
      flashStart: "Start generation and playback",
      flashStop: "Stop playback and local task",
      flashDraining: "Stream complete; playing the remaining buffered audio…",
      metadataFile: "Measured from saved audio",
      metadataProvider: "Reported by the provider",
      metadataRate: "{value} Hz",
      metadataDuration: "{value} s",
      metadataChannels: "{value} channels",
      metadataBits: "{value}-bit",
      usageCharacters: "Input characters: {value}",
      usagePrompt: "Prompt tokens: {value}",
      usageCompletion: "Completion tokens: {value}",
      usageTotal: "Total tokens: {value}",
      unknownSpeaker: "Unlabeled speaker",
    },
    "web.base": {
      route: { missing: "This page does not exist", invalid: "This address is invalid", home: "Back to the app" },
      place: {
        chat: { label: "Chat", hint: "Channels and threads" },
        issues: { label: "Tasks", hint: "Every task from creation to completion" },
        runs: { label: "Runs & trajectories", hint: "Active sessions, orchestrator approvals, and trajectories" },
        workspace: { hint: "Manage repositories and workspaces", name: "Workspace" },
        content: { label: "Content", hint: "Library, artifacts, and notes" },
        runtimes: { label: "Engines", hint: "Installed coding engines across machines" },
        team: { label: "Team", hint: "Roles and team templates" },
        settings: { label: "Settings", hint: "General & appearance, models & keys, voice, connections, about" },
      },
      link: { connecting: "Connecting", open: "Connected", lost: "Lost, reconnecting" },
      rail: "Workbench",
      farm: "Back to the farm",
      farmShort: "Farm",
      update: "Update",
      working: "Open · {n} working",
      runsHint: "View active runs, assistant approvals, and trajectories",
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
      user: "Me",
      orchestrator: "Assistant",
      unreachable: "The server cannot be reached for now: try again when it is back.",
      query: { invalidResponse: "The response does not match the expected data format. The last valid result has been kept." },
      table: {
        columns: "Columns",
        stale: "Showing the previous result while the requested page loads. Row actions are unavailable.",
        selectPage: "Select this page",
        selectRow: "Select row {id}",
        empty: "No rows",
        previous: "Previous page",
        next: "Next page",
        page: "Page {n}",
      },
      form: {
        invalid: "Check this field.",
        validationUnavailable: "Validation is unavailable. Your input has been kept.",
        deliveryUnknown:
          "The request may have arrived, but no confirmation was received. Your input has been kept; check the saved result before trying again.",
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
          issues: "Issues",
          pictures: "Pictures",
          library: "Library",
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
          voice: "Talk to the assistant (changeable in settings)",
          command: "Commands: a ticket, remember, stop, a direct message",
          newIssue: "New issue",
          libraryMove: "Move between files",
          libraryLook: "See the picture full screen",
          libraryRemove: "Remove the selected from the library",
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
        expand: "Expand",
        viewDiagram: "Diagram",
        viewSource: "Source",
        zoomIn: "Zoom in",
        zoomOut: "Zoom out",
        zoomReset: "Reset zoom",
      },
      updateReady: "{next} is ready: restart from About",
      intent: { timedOut: "No answer in time; try again", offline: "Not connected to the farm, so this was not sent" },
      pickTooLarge: "{name} was not added: it is over 512 MiB",
      openTerminal: "Open a terminal here",
      play: "Play",
      stop: "Stop",
    },
    "web.channel": {
      tab: { chat: "Chat", issues: "Tickets", crons: "Scheduled tasks" },
      defaultRepo: "default repo {repo}",
      channels: "Channels",
      defaultHint: "The default channel: you, the assistant and the helpers are all here",
      findHint: "Find in this channel…",
      find: "Find in this channel",
      findMessages: "Find messages",
      settings: "Channel settings",
      inChannel: "In the channel",
      empty: "Nobody has spoken in {label}: tell the assistant something to do.",
      sendTo: "Message {label}",
      side: "Channels and helpers",
      channelsTitle: "Channels",
      directsTitle: "Direct messages",
      newChannel: "Create a channel",
      newChat: "New chat",
      filter: { label: "Filter chats", all: "All", group: "Channels", direct: "Direct" },
      emptyPreview: "No messages yet",
      emptyList: "No chats yet",
      runsEntry: "View running sessions",
      mood: { idle: "resting", listening: "listening", thinking: "thinking", speaking: "speaking" },
      orchestrator: "Assistant",
      nobodyOnIt: "No helper is on it now; the thread stays",
      replies: "{n, plural, one {# reply} other {# replies}}",
      thread: "Thread",
      closeThread: "Close the thread",
      threadEmpty: "Nobody has spoken in this thread yet. Its helper sees what is said here.",
      sayInThread: "Say it in the thread; {name} sees it",
      reply: "Reply in this thread",
      dialog: {
        repoExample: "such as clock-in",
        cancel: "Cancel",
        name: "Name",
        nameHint: "Letters, digits, Chinese characters, - and _, up to 24",
        nameExample: "such as clock-in",
        description: "Description (optional)",
        descriptionHint: "What is this channel for?",
        repo: "Default repo (optional)",
        repoHint: "Work sent in this channel without a repo goes to this one",
        repoNone: "Empty means none: the assistant asks which repo when sending work",
        settingsOf: "Settings of # {name}",
        save: "Save",
      },
      issues: {
        empty: "No tickets in this channel yet. Tell the assistant something to do in the chat; it sends a helper, and the ticket is listed here.",
        thread: "Ticket thread",
      },
      crons: {
        empty: 'No scheduled tasks: tell the assistant "run the tests every day at nine".',
        next: "next {next}",
        direct: "straight to {agent}",
        byOrchestrator: "set by the assistant",
        label: 'Scheduled task "{name}"',
        on: "On",
        off: "Off",
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
        user: "You",
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
        searchFailed: "The search failed: {why}",
        readFailed: "Could not read the messages: {why}; trying again shortly",
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
      pins: { open: "Pinned messages", title: "Pinned", none: "Nothing is pinned here yet", failed: "Could not read the pins: {why}" },
      members: { open: "Members", title: "Members", user: "You", none: "No helpers here yet", inChannel: "An assistant in the channel" },
      composer: {
        notSent: "Not sent: {why}",
        who: "Who",
        mention: "Mention someone",
        stopHint: "Stops the assistant's round; helpers already sent keep working",
        send: "Send",
        sendHint: "Enter sends · Shift+Enter for a new line",
        replying: "Replying to {name}",
        cancelReply: "Cancel the reply",
        attach: "Attach a file",
        uploadFailed: "Not uploaded: {why}",
        command: "Commands",
        artifactContext: "Context: {title}",
        artifactSlide: "Slide {n}",
        artifactSelected: "{n} selected",
        clearContext: "Remove attached context",
        runningHint: "Working — send a follow-up or click stop",
      },
      manage: {
        name: "Name",
        category: "Group (optional)",
        categoryHint: "The sidebar lists channels by group",
        members: "Assistants in the channel",
        membersHint: "The assistants in the channel see what is said here without @ anyone, and the reports; with none in it, @ someone to get an answer",
        notify: "Notify",
        notifyAll: "All",
        notifyMentions: "Only @user",
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
      },
      farmSearch: {
        title: "Search everything",
        hint: "Find messages…",
        filters: "from:user  in:#channel  has:file / image / link  before: / after:2026-10-01",
        none: "Nothing found",
        searching: "Searching…",
        failed: "The search failed: {why}",
      },
      direct: { pick: "Talk with", none: "No profiles yet", open: "Talk with {name}" },
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
        talkThread: "{who}'s thread",
        thread: "Thread",
        mention: { orchestrator: "@assistant", user: "@user", everyone: "@everyone" },
        orchestratorNote: "sends work, splits plans, answers how it goes",
        everyone: "Everyone",
        everyoneNote: "wakes every helper here",
      },
      threadWidth: "Thread width (drag; double-click for the default)",
      commands: {
        issue: { name: "Write a ticket", args: "title", note: "Kept as a draft, in this channel's repository", needs: "Write the ticket's title after /issue" },
        remember: {
          name: "Have the assistant remember",
          args: "a line",
          note: "Kept in the memory of the assistant here",
          needs: "Write what it should remember after /remember",
        },
        stop: { name: "Stop the assistant", args: "", note: "The assistant here stops this turn; helpers it sent keep working", needs: "" },
        dm: { name: "Direct message", args: "name", note: "Opens the direct channel with this profile", needs: "Write the profile's name or id after /dm" },
        imagegen: {
          name: "Make an image",
          args: "description",
          note: "The assistant here draws it with MOSS and posts it here",
          needs: "Write what to draw after /imagegen",
          nowhere: "Open a channel first to make an image",
          notReady: "Images aren't set up: {why}. Press Enter to set it up",
        },
        done: { issue: "Written down as #{n}", remember: "Remembered", stop: "Stopped", imagegen: "Handed to the assistant; the image will be posted here" },
      },
      lacks: "cannot answer: {why}",
      lacksFix: "Settings",
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
            "1": "Then find the bot in Feishu and send it the pairing code in a direct message: whoever sends the code counts as you, and only their words come in. Direct messages only, not groups.",
            "2": "A Feishu bot can message you any time, so reports do not wait for you to speak first.",
          },
          qq: {
            "0": "QQ cannot make a bot by scanning: make one on the QQ open platform (q.qq.com) first, turn on direct messages, and fill in its AppID and AppSecret here.",
            "1": "Add the bot with your own QQ and send it the pairing code in a direct message: whoever sends the code counts as you. Direct messages only.",
            "2": "QQ lets a bot reply only for a short while after you speak. Reports after that wait, are retried later, and come with your next message.",
          },
        },
        always:
          "Helpers can run commands on this computer, so only you count; reply quoting a report and your words go to that ticket's thread. VibeValley only connects out and opens no port.",
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
        intro: "Talk to the assistant in a chat app: send work, ask how it goes, get reports.",
        know: "Good to know",
        disconnect: "Disconnect",
        weixinIntro:
          "Scan a code with WeChat on your phone and talk to the assistant in WeChat: send work, ask how it goes; helpers' reports and questions come to WeChat too.",
        feishuIntro: "Scan a code with Feishu on your phone and Feishu makes a bot for you; talking to it in Feishu is talking to the assistant.",
        scan: "Sign in to {app} by scanning",
        pairing: "The bot is connected. Last step: with your own {app}, message this bot directly and send:",
        pairingNote: "Whoever sends this code counts as you: from then on only that person's words come in. The code works once.",
        user: "You",
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
    "web.devtools": {
      title: "DevTools",
      tabs: { overview: "Overview", routes: "Routes", timeline: "Timeline", trajectory: "Trajectory", state: "State & Cache", lab: "Lab & Overrides" },
      actions: {
        refresh: "Refresh",
        autoRefresh: "Auto-refresh",
        pause: "Pause",
        resume: "Resume",
        detach: "Detach Window",
        close: "Close",
        clear: "Clear",
        exportBundle: "Export Bundle",
        exporting: "Exporting…",
        copy: "Copy",
        copied: "Copied",
        apply: "Apply",
        reset: "Reset",
        disconnect: "Simulate Disconnect",
      },
      lanes: { all: "All Lanes", coreApply: "Core::apply", bridgeRpc: "Bridge RPC", oarWire: "OAR Wire", gpuiFrame: "GPUI Frame" },
      overview: {
        channel: "Channel",
        version: "Version",
        loopbackUrl: "Loopback URL",
        homePath: "Host Path",
        workRoot: "Space Root",
        dbPath: "Database",
        bundleMode: "Bundle Mode",
        bootTime: "Boot Time",
        activeSessions: "Active Helpers",
        activeClients: "Active Clients",
        activeSubscriptions: "Active Subscriptions",
        latestSeq: "Latest Seq",
        lastFrameMs: "Last Frame",
        runtimes: "Engines",
        installed: "Installed",
        notInstalled: "Not Installed",
        ready: "Ready",
        notReady: "Not Ready",
        graph: "Topology",
        clients: "Clients",
        sessions: "Helpers",
        watches: "Watches",
        subscriptions: "Subscriptions",
        bundleExported: "Bundle saved to {path} ({redacted} redacted)",
      },
      routes: { searchPlaceholder: "Filter routes…", empty: "No route state available." },
      timeline: {
        searchPlaceholder: "Search events…",
        slowOnly: "Slow Only",
        slow: "Slow",
        dropped: "{count} dropped",
        empty: "No timeline events recorded yet.",
        durationUs: "{us} µs",
        correlationId: "Correlation #{id}",
      },
      trajectory: {
        kind: { issueSession: "Ticket", workspaceChat: "Chat", orchestrator: "Assistant" },
        silentError: "Silent Error",
        tokens: "Tokens",
        rawPayload: "Raw Payload",
        truncated: "Truncated ({bytes} B)",
        subagents: "Subagents",
        systemPrompt: "System Prompt",
        turns: "Rounds",
        turnIndex: "Round #{index}",
        prompt: "Prompt",
        events: "Events",
        rawEntries: "Wire Entries",
        voyageRecords: "Voyage Records",
        emptyList: "No trajectories recorded yet.",
        selectPrompt: "Select a trajectory to inspect its rounds and raw frames.",
      },
      state: {
        seq: "State Seq",
        slices: "Slices",
        watchers: "{count} watchers",
        counts: "Entity Counts",
        caches: "Caches",
        entries: "{count} entries",
        issues: "Tickets",
        sessions: "Helpers",
        channels: "Channels",
        agents: "Profiles",
        repos: "Repos",
        artifacts: "Artifacts",
        inbox: "Inbox",
        mediaJobs: "Media",
        emptyCaches: "No cache metrics reported.",
      },
      lab: {
        rpcDelayMs: "RPC Delay (ms)",
        sliceDelayMs: "Slice Delay (ms)",
        targetFilter: "Target Filter",
        targetFilterPlaceholder: "e.g. issue.* or slice:board",
        disconnectTopic: "Disconnect Topic",
        disconnectTopicPlaceholder: "e.g. slice:board or channel.follow",
        applied: "Overrides applied.",
        resetDone: "Overrides reset to defaults.",
        warning: "Active fault injection affects all views in this process.",
      },
      status: {
        loading: "Loading…",
        error: "Failed to load DevTools data: {reason}",
        disabled: "DevTools are disabled on the server.",
        empty: "Nothing to show.",
      },
    },
    "web.farm": {
      panel: { harvest: "Harvest {name}'s plot", sow: "Sow · plot {plot}", water: "Water {name}" },
      menu: { issues: "Tickets", repos: "Repos" },
      native: { close: "Close", loading: "Loading…" },
      chat: {
        channels: "Channels",
        enlarge: "Enlarge the chat window",
        fold: "Fold the chat",
        greeting:
          'This is the farm chat, where you, the assistant and the helpers talk. Tell me something to do, such as "have the tester run the tests".\n\nOnce helpers arrive, write a name like @w1 to call one directly; each ticket has its own thread under it.',
        send: "Send",
      },
      hud: { workbench: "Workbench" },
      sow: {
        homeless: "This farm belongs to no repo",
        toMap: "To plant, enter a repo's farm first: open Repos and pick a repository.",
        noRepos: "No repos in the workbench yet: make one on the Repos page first.",
        makeRepo: "Make a repo",
        plantIn: "Planting in {repo}",
        retry: "Fetch the seed bags again",
        recent: "Recent",
        kinds: "Common jobs",
        own: "Write your own",
        jobHint: "What to do, and what counts as done",
        who: "Who plants it",
        orchestratorPicks: "Assistant picks",
        how: "Start: the assistant hands this to a helper, who starts in {repo} at once. Draft: a helper reads the code and writes it up as a ticket for you to look over before starting.",
        draft: "Draft",
        start: "Start",
      },
      water: {
        drops: { "0": "Keep the change small", "1": "Leave the tests alone for now", "2": "Tell me when done", "3": "Add a test while at it" },
        working: "It is working: it hears this before its next step.",
        idle: "It is not working: this has it work another round.",
        thread: "This is kept in its ticket thread, with its replies.",
        hint: "A word to pass on…",
        water: "Water",
        moved: "The ticket's status changed: go back to the plot and see what it asks of you.",
      },
      harvest: {
        repo: "Repo {repo}",
        counts: "{commits} commits · {files} files",
        letGo: "Let it go",
        take: "Harvest, merge into {base}",
        resolve: "Have it resolve the conflict",
      },
      plotOf: "{name}'s plot",
    },
    "web.farm.phone": {
      ringing: "Incoming…",
      decline: "Decline",
      answer: "Answer",
      callOrchestrator: "Call the assistant",
      missed: "Missed {n}",
      log: "Log",
      noCalls: "No calls yet.",
      answered: "answered",
      declined: "declined",
      noMissed: "No missed calls. All is well in the field.",
      phase: {
        live: "On the call: go ahead, the assistant is listening",
        idle: "Just say it. When a ticket comes back or gets stuck, the assistant calls you too.",
      },
      manager: "Assistant",
      hangUp: "Hang up",
      app: { missed: "Missed", channels: "Chat", games: "Games" },
      game: { blocks: "Blocks", sokoban: "Sokoban", dino: "Dino", bugs: "Bug snake", merge: "Farm 2048" },
      brand: "FarmTel",
      openChat: "Open the farm chat",
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
      family: { children: "Child issues", parent: "Parent issue" },
      reading: "Reading…",
      never: "Never mind",
      later: "Leave it for now",
      orchestrator: "Assistant",
      noHelper: "No helper yet",
      board: {
        earlier: "{n} earlier",
        recent: "Recent only",
        empty: {
          todo: "Write down what you want done here; drag it to In progress to start someone on it, up and down to order it.",
          working: "Nothing being worked on.",
          waiting: "What is done or failed waits here for you; drag it to Closed to complete or cancel it.",
          closed: "Completed and canceled tickets; drag one back to In progress to reopen it.",
        },
        emptyGuide: {
          todoTitle: "No to-dos yet",
          todoBody: "Jot down a ticket, pick a repo and helper, and dispatch it.",
          workingTitle: "Nothing in progress",
          workingBody: "Assign a helper and dispatch a To do ticket, or drag it here to start a worktree session.",
          waitingTitle: "Nothing waiting for review",
          waitingBody: "Completed rounds and helper questions appear here so you can inspect changes and merge.",
          closedTitle: "No closed tickets yet",
          closedBody: "Completed and canceled tickets stay here; drag one back to In progress to reopen.",
          filtered: "No matching tickets in this column.",
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
      list: {
        noRepo: "No repo",
        all: "All tickets",
        unfold: "Unfold {group}",
        fold: "Fold {group}",
        writeIn: 'Write one in "{group}"',
        empty: "No tickets yet. Press C or click New issue to create one.",
        emptyFiltered: "No tickets match the current filter.",
      },
      page: {
        pickFirst: "Almost: pick which helper and which repo, then press Start.",
        notDrafted: "Not drafted: {why}",
        historyUnread: "The tickets' records could not be read: ",
        notFound: "No such ticket",
        notFoundLine: "There is no ticket {id}: it may have been deleted, or the link is wrong.",
        find: "Find a ticket: title, helper, repo",
        findLabel: "Find a ticket",
        filter: "Filter",
        byRepo: "By repo",
        allRepos: "All repos",
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
      acts: {
        reopened: "Ticket reopened",
        goesOn: "{helper} carries on.",
        rejectWith: "Send back, fix what is above",
        carry: "Pass it on",
        moving: "Changing the status…",
        sending: "Sending…",
        sayAgain: "Say it again",
        takeBack: "Back into the box",
        notSaid: "Not said",
      },
      close: {
        title: 'Close "{issue}"',
        working: "{who} is still working on this ticket. Canceling stops it and lets it go; the changes on its branch are not merged into main.",
        completable:
          "Completing merges {who}'s branch into the repo's main branch, after you look over the changes; canceling lets it go without merging them.",
        notCompletable: "This ticket cannot be completed now. Canceling lets {who} go, and its changes are not merged into main.",
        review: "See the changes, complete",
        stopAndCancel: "Stop and cancel",
        cancel: "Cancel the ticket",
      },
      changes: {
        checkOutput: "Check output",
        reviewVersion: "Review base and tree",
        sinceReview: "Changes since last review",
        projectCheck: "Project check",
        check: { passed: "Passed", failed: "Failed", not_configured: "No check configured" },
        mergedCommit: "Merged commit",
        reading: "Looking at what it changed…",
        unreadable: "The changes cannot be read: ",
        none: "This one has no changes. Completing just lets it go.",
        conflict: "Merging into {base} would conflict, so it cannot be completed yet",
        resolveHow: "Have it merge {base} into its own branch, resolve the conflicts, run the tests and commit; then complete it.",
        behind: "While it worked, {base} got {n} more commits; completing joins them (with one merge commit).",
        uncommitted: "{n} files are not committed yet; completing commits them first:",
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
        openTrajectory: "Full trajectory",
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
        orchestratorStuck: "The assistant did not finish answering this round: see what it said in its channel",
        job: "To do",
        from: "From",
        fromCron: "A scheduled task: each time it is due it goes to the assistant, and its answer waits for you",
        answered: "In its channel",
        evidence: "Evidence",
        unsure: "Not sure about",
        next: "Suggested next",
        conflict: "Merging into {base} would conflict: {files}",
        properties: "Properties",
        status: "Status",
        priority: "Priority",
        repo: "Repo",
        noRepo: "No repo",
        rename: "Rename",
        trail: "Where the issue is",
      },
      task: { repo: "Repo", written: "Written" },
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
        whichRepo: "Which repo",
        firstRepo: "No repo yet: make one",
        newRepoLink: "New repo",
        priority: "Priority",
        inQueue: "Queued {ago}: it starts by itself in the board's order when a spot frees up.",
        unqueue: "Unqueue",
        pickHelper: "Pick a helper first",
        start: "Confirm and dispatch",
        save: "Save",
        remove: "Delete",
        newRepo: "New repo",
        repoHint: "The repo's name, which is also its folder under the work folder",
        repoName: "Repo name",
        create: "Create",
        writeOwn: "Write it yourself",
      },
      boardLabels: {
        view: { board: "Board", list: "List" },
        grouping: { status: "Status", repo: "Repo", agent: "Helper", none: "No grouping" },
        ordering: { manual: "Default", priority: "Priority", updated: "Last updated", created: "Created" },
        lane: { todo: "To do", working: "In progress", waiting: "For you to see", closed: "Closed" },
        stage: { talk: "Talk it through", work: "Get it worked", finish: "Finish" },
        newIssue: "New ticket",
      },
      trigger: {
        issue: "sent out",
        comment: "a word passed on",
        commentNumbered: "a word passed on (#{id})",
        cron: "scheduled task",
        missed: "scheduled task (made up)",
        refine: "drafting",
        runtime: "the machine itself",
      },
      run: {
        working: "working",
        heard: "{n, plural, one {heard # word on the way} other {heard # words on the way}}",
        reconcile: "Verify the working directory",
        currentChanges: "View current issue changes",
      },
      card: {
        orchestrator: "Assistant",
        refining: "{name} is drafting",
        draft: "Draft",
        queued: "Queued",
        cron: "Scheduled task",
        noHelper: "No helper yet",
        assignHelper: "Assign helper",
        pickFirst: "No helper or repo picked: pick them before starting",
        waiting: "waiting for a free spot, queued {ago}",
        written: "written {ago}",
        lost: "Lost",
        quiet: "quiet for {took}",
        nth: "attempt {n}",
        open: "open for {took}",
        used: "took {took}",
        run: "round {n}",
        runs: "{n, plural, one {# round} other {# rounds}}",
        orchestratorWorking: "the assistant is on it",
        missingFlag: "Record missing",
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
        justNow: "just now",
        reviewAfterFailedCheck: "Review the fix, then complete the issue to rerun the check",
      },
      new: {
        title: "New issue",
        card: "New issue",
        words: "What to do",
        placeholder: "What needs doing? A sentence is enough; it is drafted from your words",
        keys: "⌘ Enter to save",
        keep: "Save",
        editsKept: "The previous version was submitted. Your edits are still in the draft.",
        machine: "Execution machine",
        machineAuto: "Auto machine",
        missingRepo: "No repo added yet. Add a repo before dispatching this ticket.",
        goRepos: "Add repo",
        missingRuntime: "No ready engine configured yet. Set up an engine to draft and run tickets.",
        goRuntimes: "Configure engines",
      },
      conversation: { title: "Discussion and delivery", older: "Load earlier messages", empty: "Requirements, execution feedback and deliveries stay here" },
      attachments: {
        title: "Attachments",
        attachFile: "Attach file",
        count: "{n, plural, one {# attachment} other {# attachments}}",
        uploadFailed: "Upload failed: {why}",
        uploading: "Uploading {name}…",
        remove: "Remove attachment {name}",
      },
    },
    "web.library": {
      upload: "Upload",
      uploading: "Uploading…",
      make: "Generate",
      makeTitle: "Generate",
      empty: "Nothing here yet",
      emptyHow: "Generate an image or speech, upload or drop in a file, or ask a helper in the chat to put what it found here.",
      nothingShown: "Nothing matches these filters.",
      drop: "Let go to put it in the library",
      kind: { all: "All", image: "Images", audio: "Audio", video: "Video", other: "Other" },
      sortLabel: "Sort",
      sort: { recent: "Recent", name: "Name", size: "Size" },
      tileSize: "Thumbnail size",
      job: {
        image: "image",
        speech: "speech",
        speakers: "dialogue",
        voiceDesign: "voice design",
        clone: "voice clone",
        transcription: "transcription",
        understanding: "understanding",
      },
      from: {
        generated: "Generated · {job}",
        uploadedHere: "You uploaded it here",
        uploadedIn: "You sent it in {channel}",
        fetchedUrl: "{agent} brought it back from {url}",
        fetchedPath: "{agent} brought it back from {path} in its working directory",
      },
      inspector: {
        kind: "Kind",
        pixels: "Size",
        bytes: "File size",
        length: "Length",
        from: "From",
        added: "Added",
        openChannel: "See it in {channel}",
        versionBadge: "v{version}",
        selected: "{n} selected",
        clear: "Clear selection",
        more: "More",
      },
      sendTo: "Send to a channel",
      sentTo: "Sent to {channel}",
      remove: "Remove from library",
      removeAsk: "Remove “{name}” from the library? Messages that have it still open it.",
      removeSome: "Remove these {n} from the library? Messages that have them still open them.",
      removeSure: "Remove",
      keep: "Keep",
      understand: "Understand",
      understandTitle: "Understand “{name}”",
      understood: "What it shows",
      makeTabs: { image: "Image", speech: "Speech", audio: "Audio workbench" },
      content: {
        title: "Content",
        new: "New",
        searchAll: "Search all content…",
        sidebarToggle: "Toggle content sidebar",
        recent: "All recent",
        pinned: "Pinned",
        pin: "Pin",
        unpin: "Unpin",
        pinnedToast: "Pinned",
        unpinnedToast: "Unpinned",
        newNote: "New outline note",
        artifacts: "Artifacts",
        media: "Media",
        sendArtifact: "Send to channel",
        exportArtifact: "Export",
        turnIntoIssue: "Turn into ticket",
        issueCreated: "Ticket created",
        source: { all: "All sources", agent: "From helpers", user: "Created by me" },
        artifactType: { all: "All artifacts" },
        inspector: {
          openExternal: "Open externally",
          saveAs: "Save as",
          copyPath: "Copy path",
          copiedPath: "Path copied",
          reveal: "Reveal in Finder",
          stopAudio: "Stop audio",
        },
        templates: {
          title: "New content",
          search: "Search templates…",
          empty: "No matching templates",
          cat: { recommended: "Recommended", note: "Outline notes", whiteboard: "Whiteboards", deliverable: "Deliverables", ai: "AI media" },
          items: {
            noteBlank: { name: "Blank outline note", desc: "Single-column outline with nesting, todos, and wikilinks" },
            noteTech: { name: "Tech spec outline", desc: "Context, goals, architecture, and implementation checklist" },
            noteMeeting: { name: "Meeting notes", desc: "Key discussion points, decisions, and follow-up todos" },
            noteDaily: { name: "Daily log", desc: "Today's focus, blockers, and handoff summary" },
            wbBlank: { name: "Blank whiteboard", desc: "Infinite canvas with dot grid and native connectors" },
            wbArch: { name: "System architecture", desc: "Layered service nodes with directional data-flow arrows" },
            wbTimeline: { name: "Launch timeline", desc: "Milestone cards and delivery stages" },
            wbJourney: { name: "User journey", desc: "Touchpoints, friction points, and improvement opportunities" },
            wbWorkshop: { name: "Kickoff workshop", desc: "Goal framing, brainstorming stickies, and convergence" },
            artDocs: { name: "Collaborative doc", desc: "Long-form specs, review reports, and technical guides" },
            artSlides: { name: "Slide deck", desc: "Widescreen multi-slide deck with speaker notes" },
            artDashboard: { name: "Data dashboard", desc: "KPI cards, trend charts, and verified tables" },
            artDesign: { name: "Design canvas", desc: "Multi-artboard UI explorations with live prop controls" },
            artDesignSystem: { name: "Design system", desc: "Color tokens, typography scale, and contrast checks" },
            artMotion: { name: "Motion clip", desc: "Interactive animated canvas with video export" },
            artHtml: { name: "Web page", desc: "Standalone interactive HTML page with version history" },
            artSheet: { name: "Workbook sheet", desc: "Multi-sheet structured tables and CSV export" },
            artDiagram: { name: "Architecture diagram", desc: "Nodes, edges, and architecture flows" },
            artStoryboard: { name: "Storyboard shots", desc: "Shot list, framing, palette, and dialogue" },
            aiImage: { name: "AI image", desc: "Generate concept art, icons, or illustrations from text" },
            aiSpeech: { name: "AI speech", desc: "Synthesize natural voiceover audio from text" },
            aiAudio: { name: "Audio studio", desc: "Multi-speaker dialogue, voice design, cloning, and transcription" },
          },
          seed: {
            noteTech:
              "## Context & Goals\n- Core problem statement and expected impact\n## Core Design\n- Module boundaries and data flow\n## Implementation Checklist\n- [ ] Break down steps and add verification checks",
            noteMeeting:
              "## Discussion Focus\n- Key agenda topics for this session\n## Key Decisions\n- Record agreed conclusions and trade-offs\n## Follow-ups\n- [ ] Track confirmed action items",
            noteDaily:
              "## Today's Focus\n- [ ] List today's top priorities\n## Blockers & Risks\n- Note items awaiting collaboration\n## Handoff Summary\n- Outcomes shipped and next steps",
            wbBlankTitle: "Central Topic",
            wbBlankBody: "Add cards, stickies, and arrows from the toolbar",
            wbArchN1Title: "Client / UI",
            wbArchN1Body: "Boundary decoding and event dispatch",
            wbArchN2Title: "Core Engine",
            wbArchN2Body: "Pure state folding and domain rules",
            wbArchN3Title: "SQLite / Git",
            wbArchN3Body: "Durable writes and workspace sync",
            wbArchE1: "request",
            wbArchE2: "persist",
            wbTlP1Title: "Phase 1 · Scope",
            wbTlP1Body: "Finalize specs and interactive prototype",
            wbTlP2Title: "Phase 2 · Build",
            wbTlP2Body: "Ship core flows and integration tests",
            wbTlP3Title: "Phase 3 · Launch",
            wbTlP3Body: "Visual check across themes and release",
            wbJourneyJ1Title: "1. Entry",
            wbJourneyJ1Body: "Open unified Content workspace",
            wbJourneyJ2Title: "2. Discover",
            wbJourneyJ2Body: "Search or browse across notes and media",
            wbJourneyJ3Title: "3. Deliver",
            wbJourneyJ3Body: "Share to channel or turn into ticket",
            wbJourneyS1Title: "Friction note",
            wbJourneyS1Body: "Reduce clicks between browsing and editing",
            wbJourneyE1: "locate",
            wbJourneyE2: "ship",
            wbWorkW1Title: "Session Goal",
            wbWorkW1Body: "Align on scope, constraints, and priorities",
            wbWorkW2Title: "Diverge",
            wbWorkW2Body: "Collect high-frequency friction points",
            wbWorkW3Title: "Converge",
            wbWorkW3Body: "Pick top priorities for first milestone",
            wbWorkE1: "explore",
            wbWorkE2: "decide",
          },
        },
        search: {
          title: "Search content",
          placeholder: "Search notes, artifacts, and media…",
          empty: "No matching notes, artifacts, or media",
          typeMedia: "Media",
        },
      },
    },
    "web.media": {
      speech: {
        title: "Single-speaker speech",
        notice:
          "Send text to the displayed MOSS account to generate one speaker. Charges may apply. Playback never starts automatically; Flash streaming plays only when requested. Canceling stops local waiting, not necessarily provider work or charges. Generated audio supports up to 512 MB per file. Results over 25 MiB stay in Media storage only you can reach, share its 2 GiB quota with uploaded inputs, and cannot be published to a channel.",
        configure: "Select a speech connection and Flash or Pro model in AI services first.",
        binding: "{account} · {connection} · {model} · configuration revision {revision}",
        refresh: "Refresh connection settings",
        voice: "Voice",
        voiceHint: "Voices belong to the displayed account. Listing a voice does not verify generation permission or quality.",
        chooseVoice: "Choose an account voice",
        firstVoices: "Reload first voice page",
        nextVoices: "Next voice page",
        emptyVoices: "This account returned no voices on this page.",
        format: "Audio format",
        execution: "Execution",
        synchronous: "Wait for generation",
        asynchronous: "Persistent asynchronous task",
        downloadOnly: "This format is download-only on this device. Raw PCM has no self-describing playback parameters.",
        resume: "Resume querying the same task",
        text: "Text to speak (up to 10,000 characters)",
        submit: "Generate speech",
        pending:
          "The request ID and original account, configuration, voice, text and format are frozen. Retrying the same submission retrieves the same task; it never regenerates an uncertain result. Choose a new request to change inputs or generate again.",
        new: "New speech request",
        history: "Recent speech tasks",
        empty: "No speech tasks yet. Configure a speech connection, choose a voice and enter text.",
        save: "Save audio",
        publish: "Publish audio",
      },
      understanding: {
        title: "Understand images and video",
        notice:
          "Select 1–5 images (up to 30 MB each), or one video (up to 200 MB); do not mix them. Files are first stored on this computer, then sent to the displayed MOSS connection after your approval. Charges may apply. Canceling does not guarantee that the provider stopped.",
        configure: "Select an understanding connection in AI services first.",
        prompt: "What should the model explain?",
        tokens: "Maximum output tokens",
        executor: "Execution / authorized channel",
        direct: "Submit now myself",
        authorize: "Authorize the assistant",
        authorizationNotice:
          "Freeze this prompt, input and output limit without uploading to MOSS yet. An assistant acting for you in the selected channel may execute it once within 15 minutes. Cancellation, expiry or a server restart invalidates approval.",
        authorization: "Authorized channel: {channel}. Send to the assistant to begin. Approval expires 15 minutes after registration.",
        delegate: "Send to the assistant",
        delegated: "Sent to the assistant",
        delegation: "Execute my authorized media understanding task {id}, then report the result.",
        consent: "I approve sending these files and this prompt to the displayed MOSS connection.",
        uploading: "Storing selected files on this computer…",
        stopUpload: "Stop local upload",
        submit: "Submit understanding",
        new: "New understanding request",
        newAsk: "Start a new request? This may upload again and incur another charge. It will not recover an unknown earlier result.",
        pending:
          "The request ID is retained for retries. Repeating this submission does not upload or run inference again. A different question requires a new request.",
        history: "Recent understanding tasks",
        truncated:
          "This result is incomplete. The retained text is shown below; increasing the output limit requires a new request and may incur another charge.",
        usage: "Provider reported: {input} input tokens · {output} output tokens · {total} total",
        save: "Save text as a document",
        open: "Open saved document",
        cleanup: "Clean remote files",
        cleanupAsk:
          "Delete known remote files and release retained local inputs? The provider may still be processing an unknown request. Uploads without a confirmed ID may remain and need manual inspection. This does not repeat understanding.",
      },
      sourceUser: "Source: you",
      sourceAgent: "Source: assistant {agent} · channel {channel}",
      usage: "Provider reported: {images} image(s) · {width} × {height}",
      usageUnknown: "No provider usage result yet. This does not mean there was no charge.",
      prompt: "Prompt / layout JSON",
      format: "Input format",
      text: "Text to image",
      layout: "Layout to image",
      width: "Width",
      height: "Height",
      advanced: "Advanced options",
      seed: "Seed (optional)",
      steps: "Inference steps (optional)",
      guidance: "Guidance scale (optional)",
      negative: "Negative prompt",
      enhance: "Enhance prompt",
      watermark: "Keep visible watermark",
      generate: "Submit generation",
      resubmit: "Retry the same submission",
      new: "New generation",
      newAsk: "Create a new generation request? It may incur another charge and will not recover an unknown previous result.",
      notice:
        "Submission sends your input to MOSS and may incur charges. Timing out or canceling local waiting does not mean the provider stopped computing. Generation is never automatically retried.",
      pending:
        "This input has been submitted. Retry the same submission after a network interruption, or explicitly start a new generation to change parameters or generate again.",
      empty: "No generation tasks yet. Configure an image connection, then submit a prompt.",
      history: "Recent generation tasks",
      cancel: "Cancel waiting",
      cancelAsk: "Stop waiting locally? The provider may still be generating or charging.",
      retry: "Retry download only",
      releasePreview: "Review local audio release",
      release: "Release local audio",
      releaseAsk:
        "Release unshared local audio and permanently abandon this request's resume/download retries? Transcripts, voices, published attachments and history remain. Remote processing and charges may continue; audio will not be regenerated.",
      save: "Save image",
      channel: "Publish to channel",
      chooseChannel: "Choose a channel",
      publish: "Publish image",
      published: "Published",
    },
    "web.memory": {
      memory: {
        yours: "you remembered",
        orchestrators: "the assistant remembered for it",
        sessions: "{name} remembered",
        own: "it remembered",
        intro:
          'The helpers sent from this agent share one memory. At the start of each round, the few notes that bear on it go before what it hears; at the end, the "Remember:" lines in its report, and how far the ticket got, are kept.',
        issues: "Tickets in hand",
        noIssues: "Its helpers have not finished a round yet.",
        helper: "Helper",
        allRepos: "All repos",
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
        where: "Which repo it starts in",
        pick: "Pick a repo",
        words: "This round's words",
        wordsHint: "This round's words (optional)",
        blank: "Starting in this repo, nothing comes to mind.",
        noRepos: "No repos yet.",
        orchestratorReading: "Reading the assistant's memory…",
        orchestratorIntro:
          "The assistant reads its memory when it starts and after each compaction; what is remembered or forgotten in between, it knows by its next line.",
        orchestratorNothing: 'Nothing remembered yet. Tell the assistant "Remember…", or write one for it above.',
        orchestratorOwn: "the assistant remembered",
        told: "you told it",
        note: "Write one for it",
        noteRepo: "Such as: clock-in's tests run with pnpm test, not npm",
        noteOrchestrator: "Such as: write commit messages in English; no night shifts on weekends",
        repo: "Repo",
        repoHint: "Repo (optional)",
        noteHint: "A sentence that is clear at a glance next time.",
        noteHintRepo: "A sentence that is clear at a glance next time. With no repo it holds for every repo.",
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
        robot: { name: "Robot butler", blurb: "A round farm robot whose face screen smiles." },
      },
      orchestrator: {
        tab: { memory: "Memory", voice: "Voice" },
        all: "All profiles",
        title: "Assistant",
        intro: "The assistant is not a helper: it hears what you want done, sends helpers to do it, watches progress and passes on results.",
        look: "It looks like {name}.",
        profile: "Edit its profile",
        runsLink: "View runs",
        tabs: "The assistant's",
        heard: "Heard",
        quiet: "The assistant has not spoken yet.",
        trajectory: "Each of the assistant's rounds",
        about:
          'What it heard, every tool it called (click a row for the arguments and the result), what it said. Newest at the bottom; the last 1000 steps are kept. When a round went wrong, click "This round went wrong" on what it heard, write what it should have done, and it is kept as an eval.',
      },
      approval: {
        title: "Tool calls awaiting approval",
        allow: "Allow this call",
        deny: "Deny this call",
        unavailable: "Could not load pending tool calls: {why}",
      },
    },
    "web.provider": {
      speechNotice:
        "Choose a separate Flash or Pro binding, then generate one speaker from Generate in the Library. The completed audio can be played and saved as WAV or MP3; this is not streaming playback. Saving settings does not generate audio.",
      title: "Uses",
      intro: "Which account and model each feature uses. Accounts and keys are set under Accounts and keys.",
      words: "provider MOSS connection model key image generation snapshot understanding speech audio AI",
      understandingNotice:
        "Configure the independent connection and model. Choose Understand on an image or video in the Library and explicitly approve the upload. Saving this configuration does not upload or run inference.",
      imageNotice: "Save a default connection and model, then submit a task on the Images page. Saving settings does not generate an image.",
      add: "Add MOSS connection",
      reload: "Reload",
      reloadAsk: "Discard unsaved changes and load the latest settings?",
      console: "MOSS platform",
      empty: "No provider connections yet. Add a MOSS connection to configure default uses.",
      name: "Connection name",
      enabled: "Enabled",
      remove: "Delete connection",
      removeAsk: "Remove this connection from the draft? Saving applies the change and requires unbinding its uses first.",
      discover: "Query models",
      saveFirst: "Save changes before querying the account's available models.",
      discoveryHint: "Catalog only, no inference. A listed model has not been verified by inference.",
      noModels: "This account returned an empty model catalog.",
      unbound: "Not in use",
      liveHint: "MOSS Live uses its own connection and model for realtime voice calls.",
      bindingHint:
        "Unbind uses before deleting, disabling or clearing a connection's key. In-flight requests keep their starting configuration; new requests use the updated settings.",
      manage: "Manage AI service connections",
      connections: "Connections",
      uses: "Uses",
      usesIntro: "Pick a connection and model for each use; none leaves it unused.",
      groupImage: "Images",
      groupVoice: "Voice",
      groupLive: "Live",
      use: {
        image: "Image generation",
        understanding: "Media understanding",
        speech: "Speech",
        speakers: "Dialogue",
        voiceDesign: "Voice design",
        transcription: "Transcription",
        live: "MOSS Live",
        vision: "Live vision",
      },
      connectionFor: "Connection for {use}",
      modelFor: "Model for {use}",
      openSpeechShort: "Open",
      adapted: "Models it can use",
    },
    "web.remote": {
      title: "Remote Access",
      subtitle: "View and control VibeValley on this Mac from your phone over Tailscale.",
      toggle: { enable: "Enable remote access", disable: "Disable remote access", enabled: "Enabled", disabled: "Disabled" },
      tailscale: { online: "Tailscale online", offline: "Tailscale offline", ip: "Tailscale IP", url: "Access URL" },
      pair: {
        action: "Pair new device",
        qrHint: "Scan the QR code on your phone, or enter the address and pairing code",
        code: "Pairing code",
        expires: "Expires at {time}",
        copy: "Copy pairing link",
        copied: "Copied",
      },
      devices: {
        title: "Paired devices",
        platform: { ios: "iOS", android: "Android", cli: "CLI", machine: "Machine", sandbox: "Sandbox", other: "Other" },
        lastSeen: "Last active: {time}",
        revoke: "Revoke",
        empty: "No paired devices yet.",
      },
      mobile: {
        pairTitle: "Connect to Mac",
        pairSubtitle: "Enter the address and one-time pairing code shown in Remote Access settings on your Mac.",
        urlLabel: "Mac address",
        codeLabel: "Pairing code",
        deviceNameLabel: "Device name",
        pairAction: "Pair & connect",
        pairing: "Pairing…",
        invalidInput: "Enter a valid address, pairing code, and device name.",
      },
      state: {
        connecting: "Connecting…",
        connected: "Connected",
        reconnecting: "Connection lost, reconnecting…",
        unauthorized: "Access revoked or expired. Pair again.",
        offline: "Disconnected",
        disconnect: "Disconnect",
      },
      tabs: { inbox: "Inbox", channels: "Channels", sessions: "Sessions", issues: "Issues" },
      inbox: { approve: "Approve", deny: "Deny", answer: "Answer", empty: "Inbox is clear. Nothing needs your attention." },
      channel: { replyPlaceholder: "Write a reply…", send: "Send", empty: "No messages in this channel yet." },
      session: {
        promptPlaceholder: "Send instructions to this helper…",
        send: "Send",
        stop: "Stop",
        events: "Trajectory",
        empty: "No active helpers right now.",
      },
      issue: {
        filter: { all: "All", active: "Active", review: "In review", done: "Done" },
        comment: "Comment",
        approve: "Approve",
        changes: "Request changes",
        status: "Status",
        empty: "No matching issues.",
      },
      controlPlane: {
        title: "Control plane connection",
        subtitle: "Choose whether this Mac runs an embedded local server or connects to a remote control plane.",
        modeLabel: "Connection mode",
        mode: { embedded: "Local embedded", remote: "Remote control plane" },
        envOverride: "Environment override",
        switchAction: "Connect to remote",
        changeAction: "Change remote",
        resetAction: "Reset to local",
        methodLabel: "Authentication method",
        method: { pair: "Pairing code", token: "Bearer token" },
        urlLabel: "Control plane URL",
        urlPlaceholder: "https://hub.tailnet.ts.net:8791",
        codeLabel: "Pairing code",
        codePlaceholder: "6-character code",
        tokenLabel: "Bearer token",
        tokenPlaceholder: "vv_dev_…",
        labelField: "Label (optional)",
        labelPlaceholder: "Studio Hub",
        save: "Save connection",
        cancel: "Cancel",
        restartToRemote: "Remote target {url} saved. Restart VibeValley to switch connections.",
        restartToEmbedded: "Switched back to local embedded mode. Restart VibeValley to apply.",
        tokenHint: "Token {hint}",
      },
    },
    "web.repo": {
      list: "Repos",
      add: "New repo",
      openWorkspace: "Workspace",
      repos: "Code bases",
      all: "All",
      allLine: "The whole map: an island for each repo",
      notGit: "Not a git repository yet",
      finding: "Looking…",
      none: "No repos in the work folder yet. Press New repo to add one, or download one from GitHub.",
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
      githubHint: "A public repository's home page. Once downloaded, you can see the repo and set helpers on it.",
      name: "Repo name",
      nameHint: "Kept in the work folder; a repo of the same name is never overwritten.",
      nameExample: "such as raft-source",
      downloading: "Downloading the repository… a big one takes longer, up to 3 minutes.",
      making: "Creating…",
      cancel: "Cancel",
      busy: "Working…",
      download: "Download to the work folder",
      create: "Create the repo",
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
      usedBy: " · {n} agents",
      reading: "Reading…",
      bundled: "installed with oar",
      commandLine: "command line",
      unsupportedWhy: "Unsupported: {why}",
      checkedAt: "checked at {clock}",
      recheck: "Check again",
      account: "Account",
      skills: "Skills",
      mcp: "MCP servers",
      tools: "Tools",
      agents: "Agents using it",
      makeAgent: "Make a new agent with it",
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
        own: "Written by you · {count}",
        newSkill: "New skill",
        noSkills: "No skills yet: write one of VibeValley's own, or install some on a runtime and come back.",
        builtIn: "Ships with VibeValley · {count}",
        builtInNote:
          "A skill that ships with VibeValley: it is updated with VibeValley and can't be changed or deleted here. Tick it on a profile's Skills tab and the helper's prompt carries it; to work another way, make a skill of your own.",
        builtInTag: "Built in",
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
        unreported: "reports no allowance",
        signedOut: "Not signed in",
      },
      spentToday: "Helpers spent about {spent} today, with no daily budget.",
      spentTodayBudget: "Helpers spent about {spent} today, against a daily budget of {budget}.",
      signInTerminal: "Open a terminal to sign in",
      machines: {
        title: "Execution machines",
        kind: { local: "Local", remote: "Remote", sandbox: "Ephemeral sandbox" },
        platform: { macos: "macOS", linux: "Linux", container: "Container", other: "Other" },
        status: { online: "Online", offline: "Offline", draining: "Draining" },
        machineId: "Machine ID",
        worktree: "Worktree",
        worktreeYes: "Supported",
        worktreeNo: "Unavailable",
        installedCount: "Installed",
        lastSeen: "Last seen",
      },
      sidebarToggle: "Toggle engines sidebar",
      refreshAll: "Refresh machines and engines",
      inspectorTitle: "Machine & Inspector",
      inspectorShow: "Show inspector",
      inspectorHide: "Hide inspector",
      noneInstalled: "No installed coding engines found",
      noneInstalledHint: "Install a coding engine on this machine or a connected host, then refresh.",
      remoteSummary: "Hosted on {machine} and dispatched remotely.",
      sessions: "Related sessions",
      noSessions: "No active or recent sessions.",
      quickActions: "Quick actions",
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
        searchHint: "Filter steps, tools, args...",
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
        wantHint: 'What it should do: such as "ask me which repo first, do not send work right away"',
        hired: "took the ticket {ago}",
        hiredAndLeft: "took the ticket {hired} · left {left}",
      },
      hub: {
        search: "Search runs and trajectories",
        searchHint: "Search name, ticket, repo…",
        scopeLabel: "Filter scope",
        scope: { all: "All", active: "Active", orchestrator: "Assistants", worker: "Helpers" },
        list: "Runs",
        back: "All runs",
        filterAgent: "Profile: {name}",
        filterIssue: "Ticket: {label}",
        clearFilter: "Clear filters",
        clear: "Clear",
        empty: "No runs yet.",
        emptyFiltered: "No runs match the current filters.",
        pick: "Pick a run to inspect its trajectory.",
        openIssue: "Open ticket",
        openProfile: "Open profile",
        orchestratorRole: "Assistant",
        status: { working: "Working", listening: "Listening", resting: "Idle", done: "Done", failed: "Failed", interrupted: "Interrupted", closed: "Closed" },
      },
      subagents: {
        heading: "Subtasks",
        root: "Main thread",
        wait: "{who} is waiting for {targets}",
        observed: "Last observed {ago} · {status}",
        creator: "Started by {who}",
        openLog: "Show the work log for {task}",
        noLog: "No steps for this thread in the recent work log.",
        status: {
          pendingInit: "Starting",
          running: "Running",
          interrupted: "Interrupted",
          completed: "Completed",
          errored: "Failed",
          shutdown: "Closed",
          notFound: "Thread not found",
          unknown: "Unknown",
        },
        steps: { title: "Reported steps", pending: "Pending", inProgress: "In progress", completed: "Done" },
        disconnected: "Connection loss detected {ago}. Showing the last confirmed states.",
        lastWait: "At disconnect, {who} was waiting for {targets}",
        mailbox: "{who} is waiting for a collaboration message",
        lastMailbox: "At disconnect, {who} was waiting for a collaboration message",
      },
    },
    "web.setting": {
      language: {
        title: "Language",
        line: "The page's words, what the assistant and the helpers answer you, and the reports sent to chat apps all use this language. The page reopens when it changes.",
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
        userHint: "Your user_id in EverOS (empty uses the default one)",
        read: "Read",
        readHint: "Also asked when recalling at the start and when a helper looks things up",
        write: "Write",
        writeHint: "What is remembered is sent there too",
        everything: "Read everything",
        everythingHint: "Not only what VibeValley remembered for helpers: every helper reads your own memories there too",
      },
      github: {
        noGh: "gh is not installed",
        note: "Which repos can open PRs is on the Repos page; opening a PR on completion is turned on in the configuration (github.pr_repos).",
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
        general: "General & Appearance",
        appearance: "Appearance",
        models: "Models & Keys",
        skills: "Skills",
        voice: "Voice",
        connections: "Connections",
        remote: "Remote Access",
        about: "About & Data",
        memory: "Memory",
        chat: "Chat apps",
        width: "Navigation width (drag; double-click for the default)",
      },
      words: {
        general: "language start workbench farm theme dark light size zoom scale font animation motion reduce",
        models: "keys accounts DeepSeek MOSS API key models binding",
        skills: "skills skill built-in installed library prompt",
        memory: "memory source sources Nowledge EverOS external read write",
        voice: "call phone recognition speech MOSS live realtime vision transcription",
        connections: "WeChat Feishu Lark QQ connectors pairing GitHub gh PR login",
        remote: "remote mobile phone Tailscale pair pairing QR device iOS Android CLI machine sandbox listener token control plane embedded",
        about: "version home folder settings data",
      },
      scope: { farm: "For all of VibeValley", device: "This device only" },
      general: {
        languageHint: "The page, the assistant and the helpers all speak it",
        start: "Open on start",
        startHint: "Where the app, or the home page, opens",
        starts: { workbench: "Workbench", farm: "Farm" },
      },
      appearance: {
        theme: "Theme",
        themeHint: "With the system, it follows the computer's light and dark",
        themes: { light: "Light", dark: "Dark", system: "System" },
        motion: "Animations",
        motionHint: "Disable UI transitions and motion loops for deterministic UI testing or reduced motion.",
        motionOption: { off: "Off", on: "On", system: "System" },
        scale: "Interface size",
        scaleHint: "Scales the whole workbench; the farm keeps its whole-number scaling",
        monoFont: "Terminal & code font",
        monoFontRow: "Terminal & code font (Nerd Font)",
        monoFontHint: "Monospace font for terminals, diffs, and file previews, with built-in Nerd Font icon fallback",
        terminalFontSize: "Terminal font size",
        terminalFontSizeHint: "Also adjustable anytime in the terminal view with ⌘+ / ⌘- / ⌘0",
      },
      models: { intro: "Configure model accounts, API keys, and feature bindings.", deepseekHint: "The assistant and VibeValley's own helpers use it" },
      memory: { intro: "Helpers can also look things up in, and write to, memory outside VibeValley." },
      about: {
        version: "Version",
        versionHint: "The server on this machine",
        files: "Files",
        home: "Home folder",
        homeHint: "Everything VibeValley keeps is here",
        settings: "Settings file",
        settingsHint: "The keys and these pages' settings",
        repos: "Repositories",
        reposHint: "The space's repos; each folder is a git repository",
        worktrees: "Worktrees",
        worktreesHint: "Each issue's own checkout while a helper works",
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
        cli: "Command line",
        cliHint: "Once installed, {command} reads and writes this farm from a terminal, for agents on this Mac too",
        cliReady: "Use {command} in a terminal; agents on this Mac can read and write this farm with it",
        cliNotOnPath: 'Installed at {link}, but ~/.local/bin is not on your PATH: add export PATH="$HOME/.local/bin:$PATH" to ~/.zshrc',
        cliTaken: "{link} is another program's file and was not replaced: move it away, then install",
        cliInstall: "Install",
        cliRemove: "Remove",
      },
      missing: {
        deepseekKey: "No DeepSeek key yet",
        mossAccount: "No MOSS account yet",
        mossKey: "The MOSS account has no key yet",
        mossOff: "The MOSS account it uses is turned off",
        binding: "No account and model chosen for it yet",
      },
      feature: {
        orchestrator: "The assistant",
        image: "Image generation",
        understanding: "Media understanding",
        speech: "Speech",
        speakers: "Dialogue",
        voiceDesign: "Voice design",
        transcription: "Transcription",
        live: "MOSS Live",
        vision: "Live vision",
        call: "Calls",
      },
      readiness: { ready: "{feature}: ready", lacks: "{feature}: {why}", fix: "Set it up" },
    },
    "web.shell": {
      sidebar: {
        title: "Repos & terminals",
        addRepo: "Add repository",
        addRepoButton: "Repo",
        addRepoTooltip: "Add a local repository or folder",
        manageRepos: "Manage repositories",
        running: "Running",
        runningAgent: "{agent} running",
        ready: "Ready",
        readyAgent: "{agent} ready",
        needsAttention: "Needs attention",
        terminalCount: "{n} terminals",
        workingCount: "{n} running",
        readyCount: "{n} ready",
        attentionCount: "{n} attention",
        closeTab: "Close tab",
        tabsGroup: "Tabs",
        tabMore: "More actions",
        newTerminal: "New terminal: {name}",
        newChat: "New chat: {name}",
        closeFolder: "Close folder: {name}",
        closeFolderMenu: "Close folder",
        repoDetails: "Repository details",
        backToRepos: "Back to repositories",
        mainWorktree: "{label} · main",
        mainLabel: "main",
        collapseAll: "Collapse all",
        expandCurrent: "Expand current",
        collapseItem: "Collapse {name}",
        expandItem: "Expand {name}",
        newTerminalHere: "New terminal here",
        newChatHere: "New chat here",
        chatWaiting: "Waiting for confirmation",
        revealInFinder: "Reveal in Finder",
        copyPath: "Copy path",
        removeWorktree: "Delete worktree",
        files: "Files",
        filesTip: "Workspace files",
        gitChanges: "Changes",
        gitChangesTip: "Workspace changes & staged",
        gitBranches: "Branches",
        gitBranchesTip: "Local branches & worktrees",
        gitCommits: "Commits",
        gitCommitsTip: "Commit history",
      },
      fileTree: {
        title: "Files",
        collapseAllDirs: "Collapse all folders",
        loading: "Reading the project…",
        empty: "This folder is empty.",
        copyRelPath: "Copy relative path",
        copyAbsPath: "Copy full path",
        revealInFinder: "Reveal in Finder",
        newTerminalInDir: "New terminal in folder",
      },
      git: {
        title: "Source Control",
        loading: "Loading Git status…",
        notRepo: "This folder is not a Git repository.",
        refresh: "Refresh Git",
        justNow: "Just now",
        minutesAgo: "{n}m ago",
        hoursAgo: "{n}h ago",
        daysAgo: "{n}d ago",
        confirmDiscard: "Discard",
        cancel: "Cancel",
        unstagePath: "Unstage {path}",
        discardPath: "Discard changes in {path}",
        stagePath: "Stage {path}",
        tab: { changes: "Changes", changesCount: "Changes ({count})", branches: "Branches ({count})", commits: "Commits" },
        commitPlaceholder: "Commit message…",
        committing: "Committing…",
        commitSuccess: "Committed",
        commitStaged: "Commit staged ({count})",
        noStaged: "No staged files",
        stageAllCount: "Stage all changes ({count})",
        conflicts: "Conflicts",
        staged: "Staged",
        unstageAll: "Unstage all",
        stagedEmpty: "No staged files.",
        changes: "Unstaged",
        stageAll: "Stage all",
        clean: "Working tree clean, no uncommitted changes.",
        branches: "Branches",
        filterBranches: "Filter branches…",
        noMatchingBranches: "No matching local branches.",
        currentBranch: "{name}, current branch",
        switchBranch: "Switch to {name}",
        switching: "Switching…",
        noBranches: "No local branches found.",
        worktrees: "Worktrees",
        newWorktree: "New worktree",
        creatingWorktree: "Creating…",
        newBranchPlaceholder: "New branch, e.g. feat/login",
        createBtn: "Create",
        mainLabel: "main",
        removing: "Deleting…",
        removedWorktree: "Deleted worktree {label}",
        removeFailed: "Delete failed: {why}",
        wtConflictsCount: "{n} conflicts",
        wtChangedCount: "{n} changed",
        wtClean: "clean",
        wtDirtyPrompt: "Has uncommitted changes",
        wtConfirmDeletePrompt: "Delete this worktree?",
        wtForceDelete: "Force delete",
        wtConfirmDelete: "Confirm delete",
        wtRemoveMenu: "Delete worktree…",
        wtRunning: "Working",
        commits: "Commit history",
        noCommits: "No commits yet.",
      },
      section: { collapse: "Collapse {title}", expand: "Expand {title}" },
      palette: {
        placeholder: { commands: "Type a command or jump to any page…", files: "Jump to a file…", search: "Search text in project…" },
        mode: { commands: "Commands", files: "Files", search: "Search" },
        a11y: { commands: "Commands", files: "Files", search: "Search results" },
        searching: "Searching…",
        empty: { commands: "No matching commands.", files: "No matching files.", search: "No matching results." },
        footer: { select: "Select", run: "Run", close: "Close" },
      },
      chat: {
        title: "Workspace Chat",
        runtime: "Runtime",
        model: "Model",
        thoughtLevel: "Thinking",
        thoughtLow: "Low",
        thoughtMedium: "Med",
        thoughtHigh: "High",
        thoughtMax: "Max",
        statusWaiting: "Needs reply",
        emptyTitle: "Direct coding chat in this workspace",
        emptyHint: "Pick a runtime and start chatting. Tool call cards open files and diffs directly in an adjacent split pane.",
        you: "You",
        steerTag: "Steer",
        thinking: "Thinking",
        toolOpenFile: "Open file",
        toolOpenDiff: "View diff",
        toolRunning: "Running",
        toolOk: "Done",
        toolFailed: "Failed",
        toolPending: "Waiting for output…",
        toolNoOutput: "No output",
        interactionBadge: "Needs your confirmation · never auto-approved",
        interactionAnswered: "Answered",
        interactionDeclined: "Declined",
        interactionCustomPlaceholder: "Or type a custom reply…",
        interactionConfirm: "Confirm & continue",
        interactionDecline: "Decline",
        permissionBadge: "Tool permission request",
        permissionAllowOnce: "Allow once",
        permissionAllowSession: "Allow for session",
        permissionDeny: "Deny",
        composerPlaceholder: "Ask {runtime} or describe a change… (Enter to send, Shift+Enter for newline)",
        steerPlaceholder: "Turn running — type to steer mid-turn…",
        steeringBanner: "Turn active · sending steers mid-turn via session.send without cancelling context",
        send: "Send",
        steer: "Steer",
        stop: "Stop",
        telemetryContext: "Context {pct}%",
        telemetryCache: "Cache {pct}%",
        telemetryTurns: "{turns} turns · {tools} tools",
        telemetryQuota: "Quota {pct}%",
        telemetryDetails: "Telemetry",
        telemetryHide: "Hide telemetry",
        telemetryContextTitle: "Context window",
        telemetryCacheTitle: "Prompt cache & tools",
        telemetryQuotaTitle: "Runtime quota",
        telemetryCached: "Cached",
        telemetryUncached: "Uncached",
        telemetryOutput: "Output",
        telemetryReasoning: "Reasoning",
        telemetryQuotaUnavailable: "Quota window not reported by this runtime.",
        sendFailed: "Send failed: {why}",
        configFailed: "Failed to update config: {why}",
        respondFailed: "Failed to submit reply: {why}",
        stopFailed: "Failed to stop session: {why}",
        attachFile: "Attach file",
        removeFile: "Remove {name}",
        chooseModel: "Switch runtime & model",
      },
      swarm: {
        pill: "Swarm · {working}/{active}",
        openDrawer: "Open Swarm panel",
        closeDrawer: "Close Swarm panel",
        tabOverview: "Overview",
        tabRoster: "Roster",
        tabBoard: "Board",
        overviewEmpty: "No threads recorded yet.",
        roleCoordinator: "Coordinator",
        roleWorker: "Member",
        stateWorking: "Working",
        stateWaiting: "Waiting",
        stateWaitingMentions: "Waiting @mention #{seq}",
        stateWaitingAll: "Waiting all #{seq}",
        stateStopped: "Stopped",
        stateKilled: "Ended",
        rosterSelectHint: "Select a member to inspect recent transcript steps.",
        transcriptTitle: "Recent transcript",
        transcriptRefresh: "Refresh transcript",
        transcriptEmpty: "No transcript steps yet.",
        transcriptFailed: "Failed to load transcript: {why}",
        transcriptThinking: "Thinking",
        boardAll: "All",
        boardFilterPlaceholder: "Filter board messages…",
        boardEmpty: "No board messages yet.",
        boardBrief: "Brief",
        boardJumpLatest: "Latest",
        boardCount: "{shown}/{total}",
      },
      repoDetail: {
        badgeManaged: "VibeValley repo",
        badgeFolder: "Local folder",
        openFullPage: "Open full repository page",
        copied: "Path copied",
        newChat: "New chat",
        newTerminal: "New terminal",
        sectionOverview: "Overview",
        branch: "Branch",
        repoType: "Type",
        typeGit: "Git repository",
        typeFolder: "Folder",
        activity: "Workspace",
        activitySummary: "{worktrees} worktrees · {tabs} tabs",
        openIssues: "Open issues",
        runningSessions: "Running sessions",
        maxSessions: "Max sessions",
        pullRequest: "Pull Request",
        prReady: "Available",
        prUnavailable: "Unavailable",
        commits: "Commits",
        languages: "Languages",
        worktrees: "Worktrees",
        tabsCount: "{n} tabs",
        closeFolder: "Close folder from workspace",
      },
    },
    "web.voice": {
      voice: {
        section: { label: "Voice" },
        noSettings: "The server's settings cannot be asked ({why}).",
        saved: "Saved: the next call uses it.",
        persona: {
          intro: "How the assistant opens a call. MOSS Live connection and verification are on the",
          page: "page.",
          open: "Opening",
          openParts: "Persona · greeting",
          persona: "Persona",
          personaHint:
            "Who the model that answers first on the call is, and how it speaks. It cannot see how things are; the assistant on this computer sends work. Tell it not to make up progress.",
          greeting: "Greeting",
          greetingHint: "The first thing said when the call connects.",
        },
        moss: { verify: "Check that it connects", checking: "Connecting…", ok: "Connected" },
      },
      moss: {
        intro:
          "Talk to MOSS Live directly and hear how it answers; the line goes through this machine's server, and the key never leaves it. Nothing goes to the chat.",
        talk: "Start talking",
        connecting: "Connecting…",
        hangUp: "Hang up",
        mute: "Mute",
        unmute: "Unmute",
        nativeCall: "MOSS Live call",
        nativeNotice:
          "Starting captures your microphone and sends audio to the configured MOSS account; charges may apply. Final transcripts are recorded in the chat. Leaving this page hangs up.",
      },
    },
  },
};

/** Every key, and the params its zh message names (undefined: none). */
export interface Messages {
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
  "shared.canceled.dismissed": undefined;
  "shared.canceled.lost": undefined;
  "shared.canceledFor": { readonly why: string | number };
  "shared.deliverable.answer": undefined;
  "shared.deliverable.branch": undefined;
  "shared.deliverable.change": undefined;
  "shared.deliverable.pull_request": undefined;
  "shared.delivered.kept": undefined;
  "shared.delivered.merged": undefined;
  "shared.delivered.merged_into_parent": undefined;
  "shared.delivered.none": undefined;
  "shared.delivered.pull_request": undefined;
  "shared.delivered.submitted": undefined;
  "shared.doneWith": { readonly what: string | number };
  "shared.greeting": undefined;
  "shared.join.aside": { readonly aside: string | number; readonly text: string | number };
  "shared.join.labeled": { readonly label: string | number; readonly text: string | number };
  "shared.join.sentence": { readonly text: string | number };
  "shared.join.separator": undefined;
  "shared.minutes": { readonly n: string | number };
  "shared.order.invalid": undefined;
  "shared.order.unordered": { readonly a: string | number; readonly b: string | number };
  "shared.outcome.completed": undefined;
  "shared.outcome.failed": undefined;
  "shared.outcome.interrupted": undefined;
  "shared.phase.conflict": { readonly base: string | number; readonly files: string | number };
  "shared.phase.done": { readonly conflict: string | number };
  "shared.phase.failed": undefined;
  "shared.phase.quiet": { readonly span: string | number; readonly what: string | number };
  "shared.phase.rested": { readonly conflict: string | number };
  "shared.phase.resting": { readonly conflict: string | number; readonly last: string | number };
  "shared.phase.retrying": { readonly attempt: string | number; readonly what: string | number };
  "shared.phase.retryingOf": { readonly attempt: string | number; readonly of: string | number; readonly what: string | number };
  "shared.phase.working": { readonly action: string | number };
  "shared.phase.workingOn": { readonly action: string | number; readonly label: string | number };
  "shared.priority.high": undefined;
  "shared.priority.low": undefined;
  "shared.priority.medium": undefined;
  "shared.priority.urgent": undefined;
  "shared.seconds": { readonly n: string | number };
  "shared.serverAnswered": { readonly status: string | number };
  "shared.stage.asking": undefined;
  "shared.stage.canceled": undefined;
  "shared.stage.done": undefined;
  "shared.stage.draft": undefined;
  "shared.stage.queued": undefined;
  "shared.stage.reviewing": undefined;
  "shared.stage.stuck": undefined;
  "shared.stage.working": undefined;
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
  "web.agent.avatar": undefined;
  "web.agent.avatarAnimal": undefined;
  "web.agent.avatarHint": undefined;
  "web.agent.backToAll": undefined;
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
  "web.agent.list.all": undefined;
  "web.agent.list.clearFilter": undefined;
  "web.agent.list.defaultBadge": undefined;
  "web.agent.list.disable": undefined;
  "web.agent.list.disabledBadge": undefined;
  "web.agent.list.emptySearch": undefined;
  "web.agent.list.enable": undefined;
  "web.agent.list.filterLabel": undefined;
  "web.agent.list.helpers": undefined;
  "web.agent.list.make": undefined;
  "web.agent.list.makeOrchestrator": undefined;
  "web.agent.list.orchestratorLine": undefined;
  "web.agent.list.orchestratorSummary": undefined;
  "web.agent.list.orchestrators": undefined;
  "web.agent.list.search": undefined;
  "web.agent.list.searchHint": undefined;
  "web.agent.list.toggle": { readonly act: string | number; readonly name: string | number };
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
  "web.agent.role.orchestrator": undefined;
  "web.agent.role.worker": undefined;
  "web.agent.roleHint": undefined;
  "web.agent.runsLink": undefined;
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
  "web.agent.targetMachine": undefined;
  "web.agent.targetMachineAuto": undefined;
  "web.agent.targetMachineDraining": { readonly name: string | number };
  "web.agent.targetMachineOffline": { readonly name: string | number };
  "web.agent.targetMachineTip": undefined;
  "web.agent.templates.add": undefined;
  "web.agent.templates.added": { readonly name: string | number };
  "web.agent.templates.addedHere": undefined;
  "web.agent.templates.adopt": undefined;
  "web.agent.templates.adopted": { readonly n: string | number };
  "web.agent.templates.adoptedToast": { readonly name: string | number };
  "web.agent.templates.category.all": undefined;
  "web.agent.templates.category.engineering": undefined;
  "web.agent.templates.category.orchestration": undefined;
  "web.agent.templates.category.product": undefined;
  "web.agent.templates.category.research": undefined;
  "web.agent.templates.fold": undefined;
  "web.agent.templates.folder": undefined;
  "web.agent.templates.folderHint": undefined;
  "web.agent.templates.from": { readonly name: string | number; readonly version: string | number };
  "web.agent.templates.galleryIntro": undefined;
  "web.agent.templates.galleryTitle": undefined;
  "web.agent.templates.intro": undefined;
  "web.agent.templates.manageLink": undefined;
  "web.agent.templates.noPersona": undefined;
  "web.agent.templates.notHere": { readonly runtime: string | number };
  "web.agent.templates.onServer": undefined;
  "web.agent.templates.open": undefined;
  "web.agent.templates.openLine": undefined;
  "web.agent.templates.preview": undefined;
  "web.agent.templates.removeSure": undefined;
  "web.agent.templates.skill": { readonly description: string | number; readonly name: string | number };
  "web.agent.templates.style": { readonly style: string | number };
  "web.agent.templates.title": undefined;
  "web.agent.templates.update": { readonly version: string | number };
  "web.agent.templates.updateHint": undefined;
  "web.agent.templates.updated": undefined;
  "web.agent.templates.willUse": { readonly runtime: string | number };
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
  "web.artifact.applet.alwaysOnTopHint": undefined;
  "web.artifact.applet.alwaysOnTopLabel": undefined;
  "web.artifact.applet.appNameLabel": undefined;
  "web.artifact.applet.appNamePlaceholder": undefined;
  "web.artifact.applet.badgeInstalled": undefined;
  "web.artifact.applet.bundleIdLabel": undefined;
  "web.artifact.applet.bundlePathLabel": undefined;
  "web.artifact.applet.button": undefined;
  "web.artifact.applet.buttonInstalled": undefined;
  "web.artifact.applet.install": undefined;
  "web.artifact.applet.installedToast": { readonly name: string | number };
  "web.artifact.applet.installing": undefined;
  "web.artifact.applet.modalTitle": undefined;
  "web.artifact.applet.nameRequired": undefined;
  "web.artifact.applet.open": undefined;
  "web.artifact.applet.openedToast": { readonly name: string | number };
  "web.artifact.applet.reinstall": undefined;
  "web.artifact.applet.statusInstalled": undefined;
  "web.artifact.applet.statusNotInstalled": undefined;
  "web.artifact.applet.subtitle": undefined;
  "web.artifact.applet.unavailable": undefined;
  "web.artifact.applet.uninstall": undefined;
  "web.artifact.applet.uninstalledToast": { readonly name: string | number };
  "web.artifact.blocks.saved": undefined;
  "web.artifact.blocks.start": undefined;
  "web.artifact.blocks.user": undefined;
  "web.artifact.canvas.close": undefined;
  "web.artifact.canvas.label": undefined;
  "web.artifact.canvas.openPage": undefined;
  "web.artifact.card.open": { readonly title: string | number };
  "web.artifact.card.version": { readonly version: string | number };
  "web.artifact.dashboard.exportCsv": undefined;
  "web.artifact.design.noProps": undefined;
  "web.artifact.designSystem.components": undefined;
  "web.artifact.edit.save": undefined;
  "web.artifact.edit.saved": { readonly version: string | number };
  "web.artifact.issue.title": undefined;
  "web.artifact.page.all": undefined;
  "web.artifact.page.delete": undefined;
  "web.artifact.page.deleteAsk": { readonly title: string | number };
  "web.artifact.page.deleted": { readonly title: string | number };
  "web.artifact.page.gone": undefined;
  "web.artifact.page.more": undefined;
  "web.artifact.page.new": undefined;
  "web.artifact.page.none": undefined;
  "web.artifact.page.rail": undefined;
  "web.artifact.page.railHide": undefined;
  "web.artifact.page.railShow": undefined;
  "web.artifact.page.title": undefined;
  "web.artifact.presenter.aside": undefined;
  "web.artifact.presenter.clock": undefined;
  "web.artifact.presenter.current": undefined;
  "web.artifact.presenter.empty": undefined;
  "web.artifact.presenter.end": undefined;
  "web.artifact.presenter.loadFailure": { readonly reason: string | number };
  "web.artifact.presenter.missing": undefined;
  "web.artifact.presenter.next": undefined;
  "web.artifact.presenter.noNotes": undefined;
  "web.artifact.presenter.notes": undefined;
  "web.artifact.presenter.restart": undefined;
  "web.artifact.presenter.waiting": undefined;
  "web.artifact.slides.next": undefined;
  "web.artifact.slides.present": undefined;
  "web.artifact.slides.presenter": undefined;
  "web.artifact.slides.previous": undefined;
  "web.artifact.slidesStore.addSlide": undefined;
  "web.artifact.standalone.live": undefined;
  "web.artifact.standalone.missing": undefined;
  "web.artifact.standalone.version": { readonly version: string | number };
  "web.artifact.suggestions.accept": undefined;
  "web.artifact.suggestions.by": { readonly name: string | number };
  "web.artifact.suggestions.delete": undefined;
  "web.artifact.suggestions.reject": undefined;
  "web.artifact.suggestions.title": { readonly n: string | number };
  "web.artifact.timeline.backToLive": undefined;
  "web.artifact.timeline.compact": undefined;
  "web.artifact.timeline.compacted": undefined;
  "web.artifact.timeline.empty": undefined;
  "web.artifact.timeline.fork": undefined;
  "web.artifact.timeline.forkTitle": { readonly title: string | number };
  "web.artifact.timeline.forked": { readonly title: string | number };
  "web.artifact.timeline.loading": undefined;
  "web.artifact.timeline.next": undefined;
  "web.artifact.timeline.prev": undefined;
  "web.artifact.timeline.previewBanner": { readonly summary: string | number };
  "web.artifact.timeline.restore": undefined;
  "web.artifact.timeline.restored": undefined;
  "web.artifact.timeline.title": undefined;
  "web.artifact.timeline.toggle": undefined;
  "web.artifact.timeline.turn": { readonly n: string | number };
  "web.artifact.timeline.undoTurn": undefined;
  "web.artifact.timeline.undoneOrigin": undefined;
  "web.artifact.types.dashboard": undefined;
  "web.artifact.types.defaultBadge": undefined;
  "web.artifact.types.design": undefined;
  "web.artifact.types.designSystem": undefined;
  "web.artifact.types.diagram": undefined;
  "web.artifact.types.docs": undefined;
  "web.artifact.types.motion": undefined;
  "web.artifact.types.outline": undefined;
  "web.artifact.types.prototype": undefined;
  "web.artifact.types.setDefault": undefined;
  "web.artifact.types.sheet": undefined;
  "web.artifact.types.slides": undefined;
  "web.artifact.types.storyboard": undefined;
  "web.artifact.types.unsetDefault": undefined;
  "web.artifact.types.whiteboard": undefined;
  "web.artifact.whiteboard.arrow": undefined;
  "web.artifact.whiteboard.body": undefined;
  "web.artifact.whiteboard.card": undefined;
  "web.artifact.whiteboard.chatWithOrchestrator": undefined;
  "web.artifact.whiteboard.container": undefined;
  "web.artifact.whiteboard.curveOrthogonal": undefined;
  "web.artifact.whiteboard.curveSmooth": undefined;
  "web.artifact.whiteboard.curveStraight": undefined;
  "web.artifact.whiteboard.deleteSelected": undefined;
  "web.artifact.whiteboard.diamond": undefined;
  "web.artifact.whiteboard.duplicate": undefined;
  "web.artifact.whiteboard.elements": { readonly n: string | number };
  "web.artifact.whiteboard.emptyHint": undefined;
  "web.artifact.whiteboard.entryJson": undefined;
  "web.artifact.whiteboard.exportedJson": undefined;
  "web.artifact.whiteboard.exportedJsonCanvas": undefined;
  "web.artifact.whiteboard.exportedPng": undefined;
  "web.artifact.whiteboard.exportedSvg": undefined;
  "web.artifact.whiteboard.fillBerry": undefined;
  "web.artifact.whiteboard.fillDefault": undefined;
  "web.artifact.whiteboard.fillLavender": undefined;
  "web.artifact.whiteboard.fillLeaf": undefined;
  "web.artifact.whiteboard.fillPeach": undefined;
  "web.artifact.whiteboard.fillSide": undefined;
  "web.artifact.whiteboard.fillSun": undefined;
  "web.artifact.whiteboard.fillWater": undefined;
  "web.artifact.whiteboard.fitView": undefined;
  "web.artifact.whiteboard.inspector": undefined;
  "web.artifact.whiteboard.label": undefined;
  "web.artifact.whiteboard.noSticker": undefined;
  "web.artifact.whiteboard.pan": undefined;
  "web.artifact.whiteboard.pen": undefined;
  "web.artifact.whiteboard.rect": undefined;
  "web.artifact.whiteboard.redo": undefined;
  "web.artifact.whiteboard.save": undefined;
  "web.artifact.whiteboard.saveJson": undefined;
  "web.artifact.whiteboard.select": undefined;
  "web.artifact.whiteboard.sticker": undefined;
  "web.artifact.whiteboard.sticky": undefined;
  "web.artifact.whiteboard.styleDashed": undefined;
  "web.artifact.whiteboard.styleSolid": undefined;
  "web.artifact.whiteboard.templateArchitecture": undefined;
  "web.artifact.whiteboard.templateTimeline": undefined;
  "web.artifact.whiteboard.text": undefined;
  "web.artifact.whiteboard.timeline": undefined;
  "web.artifact.whiteboard.undo": undefined;
  "web.artifact.whiteboard.zoomIn": undefined;
  "web.artifact.whiteboard.zoomOut": undefined;
  "web.audio.account": undefined;
  "web.audio.addSpeaker": undefined;
  "web.audio.addTurn": undefined;
  "web.audio.check": undefined;
  "web.audio.chooseAccount": undefined;
  "web.audio.chooseFile": undefined;
  "web.audio.chooseVoice": undefined;
  "web.audio.cleanup": undefined;
  "web.audio.cleanupAsk": undefined;
  "web.audio.cleanupPreview": undefined;
  "web.audio.clone": undefined;
  "web.audio.cloneHint": undefined;
  "web.audio.cloneTitle": undefined;
  "web.audio.configure": undefined;
  "web.audio.consent": undefined;
  "web.audio.copyPartialTranscript": undefined;
  "web.audio.copyTranscript": undefined;
  "web.audio.designHint": undefined;
  "web.audio.designTitle": undefined;
  "web.audio.dialogue": undefined;
  "web.audio.diarize": undefined;
  "web.audio.downloadAudio": undefined;
  "web.audio.empty": undefined;
  "web.audio.emptyVoices": undefined;
  "web.audio.execution": undefined;
  "web.audio.executionAsync": undefined;
  "web.audio.executionHint": undefined;
  "web.audio.executionStreaming": undefined;
  "web.audio.first": undefined;
  "web.audio.flashDraining": undefined;
  "web.audio.flashNotice": undefined;
  "web.audio.flashStart": undefined;
  "web.audio.flashStop": undefined;
  "web.audio.flashTitle": undefined;
  "web.audio.format": undefined;
  "web.audio.generate": undefined;
  "web.audio.history": undefined;
  "web.audio.input": undefined;
  "web.audio.instructions": undefined;
  "web.audio.metadataBits": { readonly value: string | number };
  "web.audio.metadataChannels": { readonly value: string | number };
  "web.audio.metadataDuration": { readonly value: string | number };
  "web.audio.metadataFile": undefined;
  "web.audio.metadataProvider": undefined;
  "web.audio.metadataRate": { readonly value: string | number };
  "web.audio.new": undefined;
  "web.audio.newAsk": undefined;
  "web.audio.next": undefined;
  "web.audio.noTimestamps": undefined;
  "web.audio.notice": undefined;
  "web.audio.openTranscript": undefined;
  "web.audio.partialTitle": undefined;
  "web.audio.partialTranscript": undefined;
  "web.audio.pending": undefined;
  "web.audio.preview": undefined;
  "web.audio.previewText": undefined;
  "web.audio.queryHint": undefined;
  "web.audio.queryVoice": undefined;
  "web.audio.refresh": undefined;
  "web.audio.remove": undefined;
  "web.audio.resume": undefined;
  "web.audio.savePartialTranscript": undefined;
  "web.audio.saveTranscript": undefined;
  "web.audio.saveVoice": undefined;
  "web.audio.savedVoice": { readonly voice: string | number };
  "web.audio.speaker": undefined;
  "web.audio.speakerHint": undefined;
  "web.audio.speakerTitle": undefined;
  "web.audio.stopUpload": undefined;
  "web.audio.text": undefined;
  "web.audio.timeline": undefined;
  "web.audio.title": undefined;
  "web.audio.transcribe": undefined;
  "web.audio.transcript": undefined;
  "web.audio.transcriptionHint": undefined;
  "web.audio.transcriptionTitle": undefined;
  "web.audio.unknownSpeaker": undefined;
  "web.audio.uploading": undefined;
  "web.audio.usageAudioSeconds": { readonly value: string | number };
  "web.audio.usageCharacters": { readonly value: string | number };
  "web.audio.usageCompletion": { readonly value: string | number };
  "web.audio.usagePrompt": { readonly value: string | number };
  "web.audio.usageTotal": { readonly value: string | number };
  "web.audio.voice": undefined;
  "web.audio.voiceName": undefined;
  "web.audio.voices": undefined;
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
  "web.base.farmShort": undefined;
  "web.base.file.pdf": undefined;
  "web.base.file.remove": { readonly name: string | number };
  "web.base.form.asking": undefined;
  "web.base.form.deliveryUnknown": undefined;
  "web.base.form.example": { readonly value: string | number };
  "web.base.form.from.config": undefined;
  "web.base.form.from.settings": undefined;
  "web.base.form.fromOnly": { readonly from: string | number };
  "web.base.form.inUse": { readonly from: string | number; readonly hint: string | number };
  "web.base.form.invalid": undefined;
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
  "web.base.form.validationUnavailable": undefined;
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
  "web.base.openTerminal": undefined;
  "web.base.orchestrator": undefined;
  "web.base.pickTooLarge": { readonly name: string | number };
  "web.base.place.chat.hint": undefined;
  "web.base.place.chat.label": undefined;
  "web.base.place.content.hint": undefined;
  "web.base.place.content.label": undefined;
  "web.base.place.issues.hint": undefined;
  "web.base.place.issues.label": undefined;
  "web.base.place.runs.hint": undefined;
  "web.base.place.runs.label": undefined;
  "web.base.place.runtimes.hint": undefined;
  "web.base.place.runtimes.label": undefined;
  "web.base.place.settings.hint": undefined;
  "web.base.place.settings.label": undefined;
  "web.base.place.team.hint": undefined;
  "web.base.place.team.label": undefined;
  "web.base.place.workspace.hint": undefined;
  "web.base.place.workspace.name": undefined;
  "web.base.play": undefined;
  "web.base.query.invalidResponse": undefined;
  "web.base.rail": undefined;
  "web.base.reading": undefined;
  "web.base.rich.copied": undefined;
  "web.base.rich.copy": undefined;
  "web.base.rich.diagram": undefined;
  "web.base.rich.diagramFailed": { readonly why: string | number };
  "web.base.rich.expand": undefined;
  "web.base.rich.less": undefined;
  "web.base.rich.lines": { readonly n: string | number };
  "web.base.rich.longLess": undefined;
  "web.base.rich.longMore": undefined;
  "web.base.rich.more": undefined;
  "web.base.rich.viewDiagram": undefined;
  "web.base.rich.viewSource": undefined;
  "web.base.rich.zoomIn": undefined;
  "web.base.rich.zoomOut": undefined;
  "web.base.rich.zoomReset": undefined;
  "web.base.route.home": undefined;
  "web.base.route.invalid": undefined;
  "web.base.route.missing": undefined;
  "web.base.runsHint": undefined;
  "web.base.runtime": { readonly name: string | number };
  "web.base.secret.hide": undefined;
  "web.base.secret.peek": undefined;
  "web.base.shortcuts.place.composer": undefined;
  "web.base.shortcuts.place.desktop": undefined;
  "web.base.shortcuts.place.everywhere": undefined;
  "web.base.shortcuts.place.farm": undefined;
  "web.base.shortcuts.place.issues": undefined;
  "web.base.shortcuts.place.library": undefined;
  "web.base.shortcuts.place.lists": undefined;
  "web.base.shortcuts.place.pictures": undefined;
  "web.base.shortcuts.say.close": undefined;
  "web.base.shortcuts.say.command": undefined;
  "web.base.shortcuts.say.debug": undefined;
  "web.base.shortcuts.say.dropReply": undefined;
  "web.base.shortcuts.say.editLast": undefined;
  "web.base.shortcuts.say.farmMenu": undefined;
  "web.base.shortcuts.say.flip": undefined;
  "web.base.shortcuts.say.libraryLook": undefined;
  "web.base.shortcuts.say.libraryMove": undefined;
  "web.base.shortcuts.say.libraryRemove": undefined;
  "web.base.shortcuts.say.mention": undefined;
  "web.base.shortcuts.say.move": undefined;
  "web.base.shortcuts.say.names": undefined;
  "web.base.shortcuts.say.newIssue": undefined;
  "web.base.shortcuts.say.newline": undefined;
  "web.base.shortcuts.say.pick": undefined;
  "web.base.shortcuts.say.send": undefined;
  "web.base.shortcuts.say.sheet": undefined;
  "web.base.shortcuts.say.switcher": undefined;
  "web.base.shortcuts.say.tool": undefined;
  "web.base.shortcuts.say.voice": undefined;
  "web.base.shortcuts.title": undefined;
  "web.base.stop": undefined;
  "web.base.table.columns": undefined;
  "web.base.table.empty": undefined;
  "web.base.table.next": undefined;
  "web.base.table.page": { readonly n: string | number };
  "web.base.table.previous": undefined;
  "web.base.table.selectPage": undefined;
  "web.base.table.selectRow": { readonly id: string | number };
  "web.base.table.stale": undefined;
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
  "web.base.update": undefined;
  "web.base.updateReady": { readonly next: string | number };
  "web.base.user": undefined;
  "web.base.working": { readonly n: string | number };
  "web.base.write": undefined;
  "web.channel.channels": undefined;
  "web.channel.channelsTitle": undefined;
  "web.channel.closeThread": undefined;
  "web.channel.commands.dm.args": undefined;
  "web.channel.commands.dm.name": undefined;
  "web.channel.commands.dm.needs": undefined;
  "web.channel.commands.dm.note": undefined;
  "web.channel.commands.done.imagegen": undefined;
  "web.channel.commands.done.issue": { readonly n: string | number };
  "web.channel.commands.done.remember": undefined;
  "web.channel.commands.done.stop": undefined;
  "web.channel.commands.imagegen.args": undefined;
  "web.channel.commands.imagegen.name": undefined;
  "web.channel.commands.imagegen.needs": undefined;
  "web.channel.commands.imagegen.notReady": { readonly why: string | number };
  "web.channel.commands.imagegen.note": undefined;
  "web.channel.commands.imagegen.nowhere": undefined;
  "web.channel.commands.issue.args": undefined;
  "web.channel.commands.issue.name": undefined;
  "web.channel.commands.issue.needs": undefined;
  "web.channel.commands.issue.note": undefined;
  "web.channel.commands.remember.args": undefined;
  "web.channel.commands.remember.name": undefined;
  "web.channel.commands.remember.needs": undefined;
  "web.channel.commands.remember.note": undefined;
  "web.channel.commands.stop.args": undefined;
  "web.channel.commands.stop.name": undefined;
  "web.channel.commands.stop.needs": undefined;
  "web.channel.commands.stop.note": undefined;
  "web.channel.composer.artifactContext": { readonly title: string | number };
  "web.channel.composer.artifactSelected": { readonly n: string | number };
  "web.channel.composer.artifactSlide": { readonly n: string | number };
  "web.channel.composer.attach": undefined;
  "web.channel.composer.cancelReply": undefined;
  "web.channel.composer.clearContext": undefined;
  "web.channel.composer.command": undefined;
  "web.channel.composer.mention": undefined;
  "web.channel.composer.notSent": { readonly why: string | number };
  "web.channel.composer.replying": { readonly name: string | number };
  "web.channel.composer.runningHint": undefined;
  "web.channel.composer.send": undefined;
  "web.channel.composer.sendHint": undefined;
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
  "web.channel.crons.removeWhich": { readonly name: string | number };
  "web.channel.crons.sure": undefined;
  "web.channel.defaultHint": undefined;
  "web.channel.defaultRepo": { readonly repo: string | number };
  "web.channel.dialog.cancel": undefined;
  "web.channel.dialog.description": undefined;
  "web.channel.dialog.descriptionHint": undefined;
  "web.channel.dialog.name": undefined;
  "web.channel.dialog.nameExample": undefined;
  "web.channel.dialog.nameHint": undefined;
  "web.channel.dialog.repo": undefined;
  "web.channel.dialog.repoExample": undefined;
  "web.channel.dialog.repoHint": undefined;
  "web.channel.dialog.repoNone": undefined;
  "web.channel.dialog.save": undefined;
  "web.channel.dialog.settingsOf": { readonly name: string | number };
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
  "web.channel.emptyList": undefined;
  "web.channel.emptyPreview": undefined;
  "web.channel.farmSearch.failed": { readonly why: string | number };
  "web.channel.farmSearch.filters": undefined;
  "web.channel.farmSearch.hint": undefined;
  "web.channel.farmSearch.none": undefined;
  "web.channel.farmSearch.searching": undefined;
  "web.channel.farmSearch.title": undefined;
  "web.channel.filter.all": undefined;
  "web.channel.filter.direct": undefined;
  "web.channel.filter.group": undefined;
  "web.channel.filter.label": undefined;
  "web.channel.find": undefined;
  "web.channel.findHint": undefined;
  "web.channel.findMessages": undefined;
  "web.channel.inChannel": undefined;
  "web.channel.issues.empty": undefined;
  "web.channel.issues.thread": undefined;
  "web.channel.lacks": { readonly why: string | number };
  "web.channel.lacksFix": undefined;
  "web.channel.manage.archive": undefined;
  "web.channel.manage.archiveHint": undefined;
  "web.channel.manage.archivedTitle": undefined;
  "web.channel.manage.category": undefined;
  "web.channel.manage.categoryHint": undefined;
  "web.channel.manage.members": undefined;
  "web.channel.manage.membersHint": undefined;
  "web.channel.manage.mentionsOnly": undefined;
  "web.channel.manage.muted": undefined;
  "web.channel.manage.name": undefined;
  "web.channel.manage.notify": undefined;
  "web.channel.manage.notifyAll": undefined;
  "web.channel.manage.notifyHint": undefined;
  "web.channel.manage.notifyMentions": undefined;
  "web.channel.manage.notifyNone": undefined;
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
  "web.channel.members.inChannel": undefined;
  "web.channel.members.none": undefined;
  "web.channel.members.open": undefined;
  "web.channel.members.title": undefined;
  "web.channel.members.user": undefined;
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
  "web.channel.messages.pinned": undefined;
  "web.channel.messages.reactedBy": { readonly emoji: string | number; readonly names: string | number };
  "web.channel.messages.readFailed": { readonly why: string | number };
  "web.channel.messages.replyGone": undefined;
  "web.channel.messages.retrySend": undefined;
  "web.channel.messages.roundFor": { readonly took: string | number; readonly what: string | number };
  "web.channel.messages.searchFailed": { readonly why: string | number };
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
  "web.channel.messages.user": undefined;
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
  "web.channel.names.mention.user": undefined;
  "web.channel.names.orchestratorNote": undefined;
  "web.channel.names.talkThread": { readonly who: string | number };
  "web.channel.names.thread": undefined;
  "web.channel.newChannel": undefined;
  "web.channel.newChat": undefined;
  "web.channel.nobodyOnIt": undefined;
  "web.channel.orchestrator": undefined;
  "web.channel.pins.failed": { readonly why: string | number };
  "web.channel.pins.none": undefined;
  "web.channel.pins.open": undefined;
  "web.channel.pins.title": undefined;
  "web.channel.replies": { readonly n: number };
  "web.channel.reply": undefined;
  "web.channel.runsEntry": undefined;
  "web.channel.sayInThread": { readonly name: string | number };
  "web.channel.sendTo": { readonly label: string | number };
  "web.channel.settings": undefined;
  "web.channel.side": undefined;
  "web.channel.switcher.direct": undefined;
  "web.channel.switcher.hint": undefined;
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
  "web.connector.connectors.user": undefined;
  "web.connector.connectors.weixinIntro": undefined;
  "web.connector.connectors.whichChannel": undefined;
  "web.devtools.actions.apply": undefined;
  "web.devtools.actions.autoRefresh": undefined;
  "web.devtools.actions.clear": undefined;
  "web.devtools.actions.close": undefined;
  "web.devtools.actions.copied": undefined;
  "web.devtools.actions.copy": undefined;
  "web.devtools.actions.detach": undefined;
  "web.devtools.actions.disconnect": undefined;
  "web.devtools.actions.exportBundle": undefined;
  "web.devtools.actions.exporting": undefined;
  "web.devtools.actions.pause": undefined;
  "web.devtools.actions.refresh": undefined;
  "web.devtools.actions.reset": undefined;
  "web.devtools.actions.resume": undefined;
  "web.devtools.lab.applied": undefined;
  "web.devtools.lab.disconnectTopic": undefined;
  "web.devtools.lab.disconnectTopicPlaceholder": undefined;
  "web.devtools.lab.resetDone": undefined;
  "web.devtools.lab.rpcDelayMs": undefined;
  "web.devtools.lab.sliceDelayMs": undefined;
  "web.devtools.lab.targetFilter": undefined;
  "web.devtools.lab.targetFilterPlaceholder": undefined;
  "web.devtools.lab.warning": undefined;
  "web.devtools.lanes.all": undefined;
  "web.devtools.lanes.bridgeRpc": undefined;
  "web.devtools.lanes.coreApply": undefined;
  "web.devtools.lanes.gpuiFrame": undefined;
  "web.devtools.lanes.oarWire": undefined;
  "web.devtools.overview.activeClients": undefined;
  "web.devtools.overview.activeSessions": undefined;
  "web.devtools.overview.activeSubscriptions": undefined;
  "web.devtools.overview.bootTime": undefined;
  "web.devtools.overview.bundleExported": { readonly path: string | number; readonly redacted: string | number };
  "web.devtools.overview.bundleMode": undefined;
  "web.devtools.overview.channel": undefined;
  "web.devtools.overview.clients": undefined;
  "web.devtools.overview.dbPath": undefined;
  "web.devtools.overview.graph": undefined;
  "web.devtools.overview.homePath": undefined;
  "web.devtools.overview.installed": undefined;
  "web.devtools.overview.lastFrameMs": undefined;
  "web.devtools.overview.latestSeq": undefined;
  "web.devtools.overview.loopbackUrl": undefined;
  "web.devtools.overview.notInstalled": undefined;
  "web.devtools.overview.notReady": undefined;
  "web.devtools.overview.ready": undefined;
  "web.devtools.overview.runtimes": undefined;
  "web.devtools.overview.sessions": undefined;
  "web.devtools.overview.subscriptions": undefined;
  "web.devtools.overview.version": undefined;
  "web.devtools.overview.watches": undefined;
  "web.devtools.overview.workRoot": undefined;
  "web.devtools.routes.empty": undefined;
  "web.devtools.routes.searchPlaceholder": undefined;
  "web.devtools.state.agents": undefined;
  "web.devtools.state.artifacts": undefined;
  "web.devtools.state.caches": undefined;
  "web.devtools.state.channels": undefined;
  "web.devtools.state.counts": undefined;
  "web.devtools.state.emptyCaches": undefined;
  "web.devtools.state.entries": { readonly count: string | number };
  "web.devtools.state.inbox": undefined;
  "web.devtools.state.issues": undefined;
  "web.devtools.state.mediaJobs": undefined;
  "web.devtools.state.repos": undefined;
  "web.devtools.state.seq": undefined;
  "web.devtools.state.sessions": undefined;
  "web.devtools.state.slices": undefined;
  "web.devtools.state.watchers": { readonly count: string | number };
  "web.devtools.status.disabled": undefined;
  "web.devtools.status.empty": undefined;
  "web.devtools.status.error": { readonly reason: string | number };
  "web.devtools.status.loading": undefined;
  "web.devtools.tabs.lab": undefined;
  "web.devtools.tabs.overview": undefined;
  "web.devtools.tabs.routes": undefined;
  "web.devtools.tabs.state": undefined;
  "web.devtools.tabs.timeline": undefined;
  "web.devtools.tabs.trajectory": undefined;
  "web.devtools.timeline.correlationId": { readonly id: string | number };
  "web.devtools.timeline.dropped": { readonly count: string | number };
  "web.devtools.timeline.durationUs": { readonly us: string | number };
  "web.devtools.timeline.empty": undefined;
  "web.devtools.timeline.searchPlaceholder": undefined;
  "web.devtools.timeline.slow": undefined;
  "web.devtools.timeline.slowOnly": undefined;
  "web.devtools.title": undefined;
  "web.devtools.trajectory.emptyList": undefined;
  "web.devtools.trajectory.events": undefined;
  "web.devtools.trajectory.kind.issueSession": undefined;
  "web.devtools.trajectory.kind.orchestrator": undefined;
  "web.devtools.trajectory.kind.workspaceChat": undefined;
  "web.devtools.trajectory.prompt": undefined;
  "web.devtools.trajectory.rawEntries": undefined;
  "web.devtools.trajectory.rawPayload": undefined;
  "web.devtools.trajectory.selectPrompt": undefined;
  "web.devtools.trajectory.silentError": undefined;
  "web.devtools.trajectory.subagents": undefined;
  "web.devtools.trajectory.systemPrompt": undefined;
  "web.devtools.trajectory.tokens": undefined;
  "web.devtools.trajectory.truncated": { readonly bytes: string | number };
  "web.devtools.trajectory.turnIndex": { readonly index: string | number };
  "web.devtools.trajectory.turns": undefined;
  "web.devtools.trajectory.voyageRecords": undefined;
  "web.farm.chat.channels": undefined;
  "web.farm.chat.enlarge": undefined;
  "web.farm.chat.fold": undefined;
  "web.farm.chat.greeting": undefined;
  "web.farm.chat.send": undefined;
  "web.farm.harvest.counts": { readonly commits: string | number; readonly files: string | number };
  "web.farm.harvest.letGo": undefined;
  "web.farm.harvest.repo": { readonly repo: string | number };
  "web.farm.harvest.resolve": undefined;
  "web.farm.harvest.take": { readonly base: string | number };
  "web.farm.hud.workbench": undefined;
  "web.farm.menu.issues": undefined;
  "web.farm.menu.repos": undefined;
  "web.farm.native.close": undefined;
  "web.farm.native.loading": undefined;
  "web.farm.panel.harvest": { readonly name: string | number };
  "web.farm.panel.sow": { readonly plot: string | number };
  "web.farm.panel.water": { readonly name: string | number };
  "web.farm.phone.again": undefined;
  "web.farm.phone.answer": undefined;
  "web.farm.phone.answered": undefined;
  "web.farm.phone.app.channels": undefined;
  "web.farm.phone.app.games": undefined;
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
  "web.farm.phone.key.down": undefined;
  "web.farm.phone.key.left": undefined;
  "web.farm.phone.key.right": undefined;
  "web.farm.phone.key.up": undefined;
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
  "web.farm.phone.noCalls": undefined;
  "web.farm.phone.noMissed": undefined;
  "web.farm.phone.openChat": undefined;
  "web.farm.phone.paused": undefined;
  "web.farm.phone.phase.idle": undefined;
  "web.farm.phone.phase.live": undefined;
  "web.farm.phone.pressA": { readonly what: string | number };
  "web.farm.phone.resume": undefined;
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
  "web.farm.plotOf": { readonly name: string | number };
  "web.farm.sow.draft": undefined;
  "web.farm.sow.homeless": undefined;
  "web.farm.sow.how": { readonly repo: string | number };
  "web.farm.sow.jobHint": undefined;
  "web.farm.sow.kinds": undefined;
  "web.farm.sow.makeRepo": undefined;
  "web.farm.sow.noRepos": undefined;
  "web.farm.sow.orchestratorPicks": undefined;
  "web.farm.sow.own": undefined;
  "web.farm.sow.plantIn": { readonly repo: string | number };
  "web.farm.sow.recent": undefined;
  "web.farm.sow.retry": undefined;
  "web.farm.sow.start": undefined;
  "web.farm.sow.toMap": undefined;
  "web.farm.sow.who": undefined;
  "web.farm.water.drops.0": undefined;
  "web.farm.water.drops.1": undefined;
  "web.farm.water.drops.2": undefined;
  "web.farm.water.drops.3": undefined;
  "web.farm.water.hint": undefined;
  "web.farm.water.idle": undefined;
  "web.farm.water.moved": undefined;
  "web.farm.water.thread": undefined;
  "web.farm.water.water": undefined;
  "web.farm.water.working": undefined;
  "web.inbox.tray.idle": undefined;
  "web.inbox.tray.off": undefined;
  "web.inbox.tray.unread": { readonly n: string | number };
  "web.inbox.tray.working": { readonly n: number };
  "web.issue.acts.carry": undefined;
  "web.issue.acts.goesOn": { readonly helper: string | number };
  "web.issue.acts.moving": undefined;
  "web.issue.acts.notSaid": undefined;
  "web.issue.acts.rejectWith": undefined;
  "web.issue.acts.reopened": undefined;
  "web.issue.acts.sayAgain": undefined;
  "web.issue.acts.sending": undefined;
  "web.issue.acts.takeBack": undefined;
  "web.issue.attachments.attachFile": undefined;
  "web.issue.attachments.count": { readonly n: number };
  "web.issue.attachments.remove": { readonly name: string | number };
  "web.issue.attachments.title": undefined;
  "web.issue.attachments.uploadFailed": { readonly why: string | number };
  "web.issue.attachments.uploading": { readonly name: string | number };
  "web.issue.board.earlier": { readonly n: string | number };
  "web.issue.board.empty.closed": undefined;
  "web.issue.board.empty.todo": undefined;
  "web.issue.board.empty.waiting": undefined;
  "web.issue.board.empty.working": undefined;
  "web.issue.board.emptyGuide.closedBody": undefined;
  "web.issue.board.emptyGuide.closedTitle": undefined;
  "web.issue.board.emptyGuide.filtered": undefined;
  "web.issue.board.emptyGuide.todoBody": undefined;
  "web.issue.board.emptyGuide.todoTitle": undefined;
  "web.issue.board.emptyGuide.waitingBody": undefined;
  "web.issue.board.emptyGuide.waitingTitle": undefined;
  "web.issue.board.emptyGuide.workingBody": undefined;
  "web.issue.board.emptyGuide.workingTitle": undefined;
  "web.issue.board.moveFailed": undefined;
  "web.issue.board.putBack": undefined;
  "web.issue.board.recent": undefined;
  "web.issue.board.retryMove": undefined;
  "web.issue.board.spots": { readonly of: string | number; readonly taken: string | number };
  "web.issue.board.whichLane": undefined;
  "web.issue.boardLabels.grouping.agent": undefined;
  "web.issue.boardLabels.grouping.none": undefined;
  "web.issue.boardLabels.grouping.repo": undefined;
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
  "web.issue.card.assignHelper": undefined;
  "web.issue.card.cron": undefined;
  "web.issue.card.draft": undefined;
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
  "web.issue.changes.check.failed": undefined;
  "web.issue.changes.check.not_configured": undefined;
  "web.issue.changes.check.passed": undefined;
  "web.issue.changes.checkOutput": undefined;
  "web.issue.changes.commits": { readonly n: string | number };
  "web.issue.changes.conflict": { readonly base: string | number };
  "web.issue.changes.conflictMark": undefined;
  "web.issue.changes.counts": { readonly commits: string | number; readonly files: string | number };
  "web.issue.changes.files": { readonly n: string | number };
  "web.issue.changes.mergedCommit": undefined;
  "web.issue.changes.moved": undefined;
  "web.issue.changes.none": undefined;
  "web.issue.changes.projectCheck": undefined;
  "web.issue.changes.reading": undefined;
  "web.issue.changes.resolve": undefined;
  "web.issue.changes.resolveHow": { readonly base: string | number };
  "web.issue.changes.reviewVersion": undefined;
  "web.issue.changes.sinceReview": undefined;
  "web.issue.changes.uncommitted": { readonly n: string | number };
  "web.issue.changes.unreadable": undefined;
  "web.issue.close.cancel": undefined;
  "web.issue.close.completable": { readonly who: string | number };
  "web.issue.close.notCompletable": { readonly who: string | number };
  "web.issue.close.review": undefined;
  "web.issue.close.stopAndCancel": undefined;
  "web.issue.close.title": { readonly issue: string | number };
  "web.issue.close.working": { readonly who: string | number };
  "web.issue.conversation.empty": undefined;
  "web.issue.conversation.older": undefined;
  "web.issue.conversation.title": undefined;
  "web.issue.detail.answer": undefined;
  "web.issue.detail.answerTo": { readonly question: string | number };
  "web.issue.detail.answered": undefined;
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
  "web.issue.detail.helper": undefined;
  "web.issue.detail.job": undefined;
  "web.issue.detail.made": undefined;
  "web.issue.detail.met": { readonly met: string | number; readonly of: string | number };
  "web.issue.detail.model": undefined;
  "web.issue.detail.next": undefined;
  "web.issue.detail.noAnswer": undefined;
  "web.issue.detail.noChanges": undefined;
  "web.issue.detail.noCriteria": { readonly answer: boolean };
  "web.issue.detail.noRepo": undefined;
  "web.issue.detail.noRuns": undefined;
  "web.issue.detail.nothingToSee": undefined;
  "web.issue.detail.now": undefined;
  "web.issue.detail.openTrajectory": undefined;
  "web.issue.detail.opened": undefined;
  "web.issue.detail.orchestratorStuck": undefined;
  "web.issue.detail.priority": undefined;
  "web.issue.detail.profile": undefined;
  "web.issue.detail.progress": undefined;
  "web.issue.detail.properties": undefined;
  "web.issue.detail.rejectLabel": undefined;
  "web.issue.detail.rejectWhere": undefined;
  "web.issue.detail.rejected": undefined;
  "web.issue.detail.rename": undefined;
  "web.issue.detail.repo": undefined;
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
  "web.issue.detail.status": undefined;
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
  "web.issue.detail.trail": undefined;
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
  "web.issue.family.children": undefined;
  "web.issue.family.parent": undefined;
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
  "web.issue.issue.handedBack": { readonly who: string | number };
  "web.issue.issue.history": { readonly line: string | number; readonly n: string | number };
  "web.issue.issue.historyItem": { readonly id: string | number; readonly name: string | number };
  "web.issue.issue.interrupted": undefined;
  "web.issue.issue.justNow": undefined;
  "web.issue.issue.main": undefined;
  "web.issue.issue.noSteps": undefined;
  "web.issue.issue.quiet": { readonly who: string | number };
  "web.issue.issue.quietLine": undefined;
  "web.issue.issue.ran": { readonly n: string | number };
  "web.issue.issue.reopenLine": undefined;
  "web.issue.issue.reviewAfterFailedCheck": undefined;
  "web.issue.issue.reviewed": undefined;
  "web.issue.issue.since": { readonly span: string | number };
  "web.issue.issue.stepsGone": undefined;
  "web.issue.issue.stuck": undefined;
  "web.issue.issue.used": { readonly span: string | number };
  "web.issue.issue.who": { readonly name: string | number };
  "web.issue.issue.whoRuntime": { readonly name: string | number; readonly runtime: string | number };
  "web.issue.later": undefined;
  "web.issue.list.all": undefined;
  "web.issue.list.empty": undefined;
  "web.issue.list.emptyFiltered": undefined;
  "web.issue.list.fold": { readonly group: string | number };
  "web.issue.list.noRepo": undefined;
  "web.issue.list.unfold": { readonly group: string | number };
  "web.issue.list.writeIn": { readonly group: string | number };
  "web.issue.marks.priority": { readonly word: string | number };
  "web.issue.never": undefined;
  "web.issue.new.card": undefined;
  "web.issue.new.editsKept": undefined;
  "web.issue.new.goRepos": undefined;
  "web.issue.new.goRuntimes": undefined;
  "web.issue.new.keep": undefined;
  "web.issue.new.keys": undefined;
  "web.issue.new.machine": undefined;
  "web.issue.new.machineAuto": undefined;
  "web.issue.new.missingRepo": undefined;
  "web.issue.new.missingRuntime": undefined;
  "web.issue.new.placeholder": undefined;
  "web.issue.new.title": undefined;
  "web.issue.new.words": undefined;
  "web.issue.noHelper": undefined;
  "web.issue.orchestrator": undefined;
  "web.issue.page.allHelpers": undefined;
  "web.issue.page.allRepos": undefined;
  "web.issue.page.backToBoard": undefined;
  "web.issue.page.byHelper": undefined;
  "web.issue.page.byRepo": undefined;
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
  "web.issue.run.currentChanges": undefined;
  "web.issue.run.heard": { readonly n: number };
  "web.issue.run.reconcile": undefined;
  "web.issue.run.working": undefined;
  "web.issue.sheet.at": { readonly stage: string | number };
  "web.issue.sheet.less": undefined;
  "web.issue.sheet.more": undefined;
  "web.issue.sheet.stageDone": { readonly stage: string | number };
  "web.issue.task.repo": undefined;
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
  "web.issue.todo.firstRepo": undefined;
  "web.issue.todo.inQueue": { readonly ago: string | number };
  "web.issue.todo.newRepo": undefined;
  "web.issue.todo.newRepoLink": undefined;
  "web.issue.todo.noCriteria": undefined;
  "web.issue.todo.pickForMe": undefined;
  "web.issue.todo.pickHelper": undefined;
  "web.issue.todo.priority": undefined;
  "web.issue.todo.questions": { readonly n: number };
  "web.issue.todo.questionsLine": undefined;
  "web.issue.todo.queued": undefined;
  "web.issue.todo.redraft": undefined;
  "web.issue.todo.refining": { readonly who: string | number };
  "web.issue.todo.refiningLine": undefined;
  "web.issue.todo.remove": undefined;
  "web.issue.todo.repoHint": undefined;
  "web.issue.todo.repoName": undefined;
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
  "web.issue.todo.whichRepo": undefined;
  "web.issue.todo.writeOwn": undefined;
  "web.issue.trigger.comment": undefined;
  "web.issue.trigger.commentNumbered": { readonly id: string | number };
  "web.issue.trigger.cron": undefined;
  "web.issue.trigger.issue": undefined;
  "web.issue.trigger.missed": undefined;
  "web.issue.trigger.refine": undefined;
  "web.issue.trigger.runtime": undefined;
  "web.library.content.artifactType.all": undefined;
  "web.library.content.artifacts": undefined;
  "web.library.content.exportArtifact": undefined;
  "web.library.content.inspector.copiedPath": undefined;
  "web.library.content.inspector.copyPath": undefined;
  "web.library.content.inspector.openExternal": undefined;
  "web.library.content.inspector.reveal": undefined;
  "web.library.content.inspector.saveAs": undefined;
  "web.library.content.inspector.stopAudio": undefined;
  "web.library.content.issueCreated": undefined;
  "web.library.content.media": undefined;
  "web.library.content.new": undefined;
  "web.library.content.newNote": undefined;
  "web.library.content.pin": undefined;
  "web.library.content.pinned": undefined;
  "web.library.content.pinnedToast": undefined;
  "web.library.content.recent": undefined;
  "web.library.content.search.empty": undefined;
  "web.library.content.search.placeholder": undefined;
  "web.library.content.search.title": undefined;
  "web.library.content.search.typeMedia": undefined;
  "web.library.content.searchAll": undefined;
  "web.library.content.sendArtifact": undefined;
  "web.library.content.sidebarToggle": undefined;
  "web.library.content.source.agent": undefined;
  "web.library.content.source.all": undefined;
  "web.library.content.source.user": undefined;
  "web.library.content.templates.cat.ai": undefined;
  "web.library.content.templates.cat.deliverable": undefined;
  "web.library.content.templates.cat.note": undefined;
  "web.library.content.templates.cat.recommended": undefined;
  "web.library.content.templates.cat.whiteboard": undefined;
  "web.library.content.templates.empty": undefined;
  "web.library.content.templates.items.aiAudio.desc": undefined;
  "web.library.content.templates.items.aiAudio.name": undefined;
  "web.library.content.templates.items.aiImage.desc": undefined;
  "web.library.content.templates.items.aiImage.name": undefined;
  "web.library.content.templates.items.aiSpeech.desc": undefined;
  "web.library.content.templates.items.aiSpeech.name": undefined;
  "web.library.content.templates.items.artDashboard.desc": undefined;
  "web.library.content.templates.items.artDashboard.name": undefined;
  "web.library.content.templates.items.artDesign.desc": undefined;
  "web.library.content.templates.items.artDesign.name": undefined;
  "web.library.content.templates.items.artDesignSystem.desc": undefined;
  "web.library.content.templates.items.artDesignSystem.name": undefined;
  "web.library.content.templates.items.artDiagram.desc": undefined;
  "web.library.content.templates.items.artDiagram.name": undefined;
  "web.library.content.templates.items.artDocs.desc": undefined;
  "web.library.content.templates.items.artDocs.name": undefined;
  "web.library.content.templates.items.artHtml.desc": undefined;
  "web.library.content.templates.items.artHtml.name": undefined;
  "web.library.content.templates.items.artMotion.desc": undefined;
  "web.library.content.templates.items.artMotion.name": undefined;
  "web.library.content.templates.items.artSheet.desc": undefined;
  "web.library.content.templates.items.artSheet.name": undefined;
  "web.library.content.templates.items.artSlides.desc": undefined;
  "web.library.content.templates.items.artSlides.name": undefined;
  "web.library.content.templates.items.artStoryboard.desc": undefined;
  "web.library.content.templates.items.artStoryboard.name": undefined;
  "web.library.content.templates.items.noteBlank.desc": undefined;
  "web.library.content.templates.items.noteBlank.name": undefined;
  "web.library.content.templates.items.noteDaily.desc": undefined;
  "web.library.content.templates.items.noteDaily.name": undefined;
  "web.library.content.templates.items.noteMeeting.desc": undefined;
  "web.library.content.templates.items.noteMeeting.name": undefined;
  "web.library.content.templates.items.noteTech.desc": undefined;
  "web.library.content.templates.items.noteTech.name": undefined;
  "web.library.content.templates.items.wbArch.desc": undefined;
  "web.library.content.templates.items.wbArch.name": undefined;
  "web.library.content.templates.items.wbBlank.desc": undefined;
  "web.library.content.templates.items.wbBlank.name": undefined;
  "web.library.content.templates.items.wbJourney.desc": undefined;
  "web.library.content.templates.items.wbJourney.name": undefined;
  "web.library.content.templates.items.wbTimeline.desc": undefined;
  "web.library.content.templates.items.wbTimeline.name": undefined;
  "web.library.content.templates.items.wbWorkshop.desc": undefined;
  "web.library.content.templates.items.wbWorkshop.name": undefined;
  "web.library.content.templates.search": undefined;
  "web.library.content.templates.seed.noteDaily": undefined;
  "web.library.content.templates.seed.noteMeeting": undefined;
  "web.library.content.templates.seed.noteTech": undefined;
  "web.library.content.templates.seed.wbArchE1": undefined;
  "web.library.content.templates.seed.wbArchE2": undefined;
  "web.library.content.templates.seed.wbArchN1Body": undefined;
  "web.library.content.templates.seed.wbArchN1Title": undefined;
  "web.library.content.templates.seed.wbArchN2Body": undefined;
  "web.library.content.templates.seed.wbArchN2Title": undefined;
  "web.library.content.templates.seed.wbArchN3Body": undefined;
  "web.library.content.templates.seed.wbArchN3Title": undefined;
  "web.library.content.templates.seed.wbBlankBody": undefined;
  "web.library.content.templates.seed.wbBlankTitle": undefined;
  "web.library.content.templates.seed.wbJourneyE1": undefined;
  "web.library.content.templates.seed.wbJourneyE2": undefined;
  "web.library.content.templates.seed.wbJourneyJ1Body": undefined;
  "web.library.content.templates.seed.wbJourneyJ1Title": undefined;
  "web.library.content.templates.seed.wbJourneyJ2Body": undefined;
  "web.library.content.templates.seed.wbJourneyJ2Title": undefined;
  "web.library.content.templates.seed.wbJourneyJ3Body": undefined;
  "web.library.content.templates.seed.wbJourneyJ3Title": undefined;
  "web.library.content.templates.seed.wbJourneyS1Body": undefined;
  "web.library.content.templates.seed.wbJourneyS1Title": undefined;
  "web.library.content.templates.seed.wbTlP1Body": undefined;
  "web.library.content.templates.seed.wbTlP1Title": undefined;
  "web.library.content.templates.seed.wbTlP2Body": undefined;
  "web.library.content.templates.seed.wbTlP2Title": undefined;
  "web.library.content.templates.seed.wbTlP3Body": undefined;
  "web.library.content.templates.seed.wbTlP3Title": undefined;
  "web.library.content.templates.seed.wbWorkE1": undefined;
  "web.library.content.templates.seed.wbWorkE2": undefined;
  "web.library.content.templates.seed.wbWorkW1Body": undefined;
  "web.library.content.templates.seed.wbWorkW1Title": undefined;
  "web.library.content.templates.seed.wbWorkW2Body": undefined;
  "web.library.content.templates.seed.wbWorkW2Title": undefined;
  "web.library.content.templates.seed.wbWorkW3Body": undefined;
  "web.library.content.templates.seed.wbWorkW3Title": undefined;
  "web.library.content.templates.title": undefined;
  "web.library.content.title": undefined;
  "web.library.content.turnIntoIssue": undefined;
  "web.library.content.unpin": undefined;
  "web.library.content.unpinnedToast": undefined;
  "web.library.drop": undefined;
  "web.library.empty": undefined;
  "web.library.emptyHow": undefined;
  "web.library.from.fetchedPath": { readonly agent: string | number; readonly path: string | number };
  "web.library.from.fetchedUrl": { readonly agent: string | number; readonly url: string | number };
  "web.library.from.generated": { readonly job: string | number };
  "web.library.from.uploadedHere": undefined;
  "web.library.from.uploadedIn": { readonly channel: string | number };
  "web.library.inspector.added": undefined;
  "web.library.inspector.bytes": undefined;
  "web.library.inspector.clear": undefined;
  "web.library.inspector.from": undefined;
  "web.library.inspector.kind": undefined;
  "web.library.inspector.length": undefined;
  "web.library.inspector.more": undefined;
  "web.library.inspector.openChannel": { readonly channel: string | number };
  "web.library.inspector.pixels": undefined;
  "web.library.inspector.selected": { readonly n: string | number };
  "web.library.inspector.versionBadge": { readonly version: string | number };
  "web.library.job.clone": undefined;
  "web.library.job.image": undefined;
  "web.library.job.speakers": undefined;
  "web.library.job.speech": undefined;
  "web.library.job.transcription": undefined;
  "web.library.job.understanding": undefined;
  "web.library.job.voiceDesign": undefined;
  "web.library.keep": undefined;
  "web.library.kind.all": undefined;
  "web.library.kind.audio": undefined;
  "web.library.kind.image": undefined;
  "web.library.kind.other": undefined;
  "web.library.kind.video": undefined;
  "web.library.make": undefined;
  "web.library.makeTabs.audio": undefined;
  "web.library.makeTabs.image": undefined;
  "web.library.makeTabs.speech": undefined;
  "web.library.makeTitle": undefined;
  "web.library.nothingShown": undefined;
  "web.library.remove": undefined;
  "web.library.removeAsk": { readonly name: string | number };
  "web.library.removeSome": { readonly n: string | number };
  "web.library.removeSure": undefined;
  "web.library.sendTo": undefined;
  "web.library.sentTo": { readonly channel: string | number };
  "web.library.sort.name": undefined;
  "web.library.sort.recent": undefined;
  "web.library.sort.size": undefined;
  "web.library.sortLabel": undefined;
  "web.library.tileSize": undefined;
  "web.library.understand": undefined;
  "web.library.understandTitle": { readonly name: string | number };
  "web.library.understood": undefined;
  "web.library.upload": undefined;
  "web.library.uploading": undefined;
  "web.media.advanced": undefined;
  "web.media.cancel": undefined;
  "web.media.cancelAsk": undefined;
  "web.media.channel": undefined;
  "web.media.chooseChannel": undefined;
  "web.media.empty": undefined;
  "web.media.enhance": undefined;
  "web.media.format": undefined;
  "web.media.generate": undefined;
  "web.media.guidance": undefined;
  "web.media.height": undefined;
  "web.media.history": undefined;
  "web.media.layout": undefined;
  "web.media.negative": undefined;
  "web.media.new": undefined;
  "web.media.newAsk": undefined;
  "web.media.notice": undefined;
  "web.media.pending": undefined;
  "web.media.prompt": undefined;
  "web.media.publish": undefined;
  "web.media.published": undefined;
  "web.media.release": undefined;
  "web.media.releaseAsk": undefined;
  "web.media.releasePreview": undefined;
  "web.media.resubmit": undefined;
  "web.media.retry": undefined;
  "web.media.save": undefined;
  "web.media.seed": undefined;
  "web.media.sourceAgent": { readonly agent: string | number; readonly channel: string | number };
  "web.media.sourceUser": undefined;
  "web.media.speech.asynchronous": undefined;
  "web.media.speech.binding": {
    readonly account: string | number;
    readonly connection: string | number;
    readonly model: string | number;
    readonly revision: string | number;
  };
  "web.media.speech.chooseVoice": undefined;
  "web.media.speech.configure": undefined;
  "web.media.speech.downloadOnly": undefined;
  "web.media.speech.empty": undefined;
  "web.media.speech.emptyVoices": undefined;
  "web.media.speech.execution": undefined;
  "web.media.speech.firstVoices": undefined;
  "web.media.speech.format": undefined;
  "web.media.speech.history": undefined;
  "web.media.speech.new": undefined;
  "web.media.speech.nextVoices": undefined;
  "web.media.speech.notice": undefined;
  "web.media.speech.pending": undefined;
  "web.media.speech.publish": undefined;
  "web.media.speech.refresh": undefined;
  "web.media.speech.resume": undefined;
  "web.media.speech.save": undefined;
  "web.media.speech.submit": undefined;
  "web.media.speech.synchronous": undefined;
  "web.media.speech.text": undefined;
  "web.media.speech.title": undefined;
  "web.media.speech.voice": undefined;
  "web.media.speech.voiceHint": undefined;
  "web.media.steps": undefined;
  "web.media.text": undefined;
  "web.media.understanding.authorization": { readonly channel: string | number };
  "web.media.understanding.authorizationNotice": undefined;
  "web.media.understanding.authorize": undefined;
  "web.media.understanding.cleanup": undefined;
  "web.media.understanding.cleanupAsk": undefined;
  "web.media.understanding.configure": undefined;
  "web.media.understanding.consent": undefined;
  "web.media.understanding.delegate": undefined;
  "web.media.understanding.delegated": undefined;
  "web.media.understanding.delegation": { readonly id: string | number };
  "web.media.understanding.direct": undefined;
  "web.media.understanding.executor": undefined;
  "web.media.understanding.history": undefined;
  "web.media.understanding.new": undefined;
  "web.media.understanding.newAsk": undefined;
  "web.media.understanding.notice": undefined;
  "web.media.understanding.open": undefined;
  "web.media.understanding.pending": undefined;
  "web.media.understanding.prompt": undefined;
  "web.media.understanding.save": undefined;
  "web.media.understanding.stopUpload": undefined;
  "web.media.understanding.submit": undefined;
  "web.media.understanding.title": undefined;
  "web.media.understanding.tokens": undefined;
  "web.media.understanding.truncated": undefined;
  "web.media.understanding.uploading": undefined;
  "web.media.understanding.usage": { readonly input: string | number; readonly output: string | number; readonly total: string | number };
  "web.media.usage": { readonly height: string | number; readonly images: string | number; readonly width: string | number };
  "web.media.usageUnknown": undefined;
  "web.media.watermark": undefined;
  "web.media.width": undefined;
  "web.memory.memory.all": undefined;
  "web.memory.memory.allRepos": undefined;
  "web.memory.memory.blank": undefined;
  "web.memory.memory.emptyHere": undefined;
  "web.memory.memory.fading": { readonly keep: string | number };
  "web.memory.memory.forget": undefined;
  "web.memory.memory.forgetElsewhere": undefined;
  "web.memory.memory.forgetThere": { readonly source: string | number };
  "web.memory.memory.forgettable": undefined;
  "web.memory.memory.helper": undefined;
  "web.memory.memory.inSource": { readonly source: string | number };
  "web.memory.memory.intro": undefined;
  "web.memory.memory.issues": undefined;
  "web.memory.memory.listed": undefined;
  "web.memory.memory.neverRecalled": undefined;
  "web.memory.memory.next": undefined;
  "web.memory.memory.noIssues": undefined;
  "web.memory.memory.noRepos": undefined;
  "web.memory.memory.note": undefined;
  "web.memory.memory.noteHint": undefined;
  "web.memory.memory.noteHintRepo": undefined;
  "web.memory.memory.noteOrchestrator": undefined;
  "web.memory.memory.noteRepo": undefined;
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
  "web.memory.memory.recalled": { readonly n: string | number };
  "web.memory.memory.recalledLast": { readonly last: string | number; readonly n: string | number };
  "web.memory.memory.repo": undefined;
  "web.memory.memory.repoHint": undefined;
  "web.memory.memory.sessions": { readonly name: string | number };
  "web.memory.memory.sources": undefined;
  "web.memory.memory.sourcesNote": undefined;
  "web.memory.memory.told": undefined;
  "web.memory.memory.transcripts": undefined;
  "web.memory.memory.unlisted": undefined;
  "web.memory.memory.where": undefined;
  "web.memory.memory.words": undefined;
  "web.memory.memory.wordsHint": undefined;
  "web.memory.memory.yours": undefined;
  "web.orchestrator.approval.allow": undefined;
  "web.orchestrator.approval.deny": undefined;
  "web.orchestrator.approval.title": undefined;
  "web.orchestrator.approval.unavailable": { readonly why: string | number };
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
  "web.orchestrator.orchestrator.runsLink": undefined;
  "web.orchestrator.orchestrator.tab.memory": undefined;
  "web.orchestrator.orchestrator.tab.voice": undefined;
  "web.orchestrator.orchestrator.tabs": undefined;
  "web.orchestrator.orchestrator.title": undefined;
  "web.orchestrator.orchestrator.trajectory": undefined;
  "web.provider.adapted": undefined;
  "web.provider.add": undefined;
  "web.provider.bindingHint": undefined;
  "web.provider.connectionFor": { readonly use: string | number };
  "web.provider.connections": undefined;
  "web.provider.console": undefined;
  "web.provider.discover": undefined;
  "web.provider.discoveryHint": undefined;
  "web.provider.empty": undefined;
  "web.provider.enabled": undefined;
  "web.provider.groupImage": undefined;
  "web.provider.groupLive": undefined;
  "web.provider.groupVoice": undefined;
  "web.provider.imageNotice": undefined;
  "web.provider.intro": undefined;
  "web.provider.liveHint": undefined;
  "web.provider.manage": undefined;
  "web.provider.modelFor": { readonly use: string | number };
  "web.provider.name": undefined;
  "web.provider.noModels": undefined;
  "web.provider.openSpeechShort": undefined;
  "web.provider.reload": undefined;
  "web.provider.reloadAsk": undefined;
  "web.provider.remove": undefined;
  "web.provider.removeAsk": undefined;
  "web.provider.saveFirst": undefined;
  "web.provider.speechNotice": undefined;
  "web.provider.title": undefined;
  "web.provider.unbound": undefined;
  "web.provider.understandingNotice": undefined;
  "web.provider.use.image": undefined;
  "web.provider.use.live": undefined;
  "web.provider.use.speakers": undefined;
  "web.provider.use.speech": undefined;
  "web.provider.use.transcription": undefined;
  "web.provider.use.understanding": undefined;
  "web.provider.use.vision": undefined;
  "web.provider.use.voiceDesign": undefined;
  "web.provider.uses": undefined;
  "web.provider.usesIntro": undefined;
  "web.provider.words": undefined;
  "web.remote.channel.empty": undefined;
  "web.remote.channel.replyPlaceholder": undefined;
  "web.remote.channel.send": undefined;
  "web.remote.controlPlane.cancel": undefined;
  "web.remote.controlPlane.changeAction": undefined;
  "web.remote.controlPlane.codeLabel": undefined;
  "web.remote.controlPlane.codePlaceholder": undefined;
  "web.remote.controlPlane.envOverride": undefined;
  "web.remote.controlPlane.labelField": undefined;
  "web.remote.controlPlane.labelPlaceholder": undefined;
  "web.remote.controlPlane.method.pair": undefined;
  "web.remote.controlPlane.method.token": undefined;
  "web.remote.controlPlane.methodLabel": undefined;
  "web.remote.controlPlane.mode.embedded": undefined;
  "web.remote.controlPlane.mode.remote": undefined;
  "web.remote.controlPlane.modeLabel": undefined;
  "web.remote.controlPlane.resetAction": undefined;
  "web.remote.controlPlane.restartToEmbedded": undefined;
  "web.remote.controlPlane.restartToRemote": { readonly url: string | number };
  "web.remote.controlPlane.save": undefined;
  "web.remote.controlPlane.subtitle": undefined;
  "web.remote.controlPlane.switchAction": undefined;
  "web.remote.controlPlane.title": undefined;
  "web.remote.controlPlane.tokenHint": { readonly hint: string | number };
  "web.remote.controlPlane.tokenLabel": undefined;
  "web.remote.controlPlane.tokenPlaceholder": undefined;
  "web.remote.controlPlane.urlLabel": undefined;
  "web.remote.controlPlane.urlPlaceholder": undefined;
  "web.remote.devices.empty": undefined;
  "web.remote.devices.lastSeen": { readonly time: string | number };
  "web.remote.devices.platform.android": undefined;
  "web.remote.devices.platform.cli": undefined;
  "web.remote.devices.platform.ios": undefined;
  "web.remote.devices.platform.machine": undefined;
  "web.remote.devices.platform.other": undefined;
  "web.remote.devices.platform.sandbox": undefined;
  "web.remote.devices.revoke": undefined;
  "web.remote.devices.title": undefined;
  "web.remote.inbox.answer": undefined;
  "web.remote.inbox.approve": undefined;
  "web.remote.inbox.deny": undefined;
  "web.remote.inbox.empty": undefined;
  "web.remote.issue.approve": undefined;
  "web.remote.issue.changes": undefined;
  "web.remote.issue.comment": undefined;
  "web.remote.issue.empty": undefined;
  "web.remote.issue.filter.active": undefined;
  "web.remote.issue.filter.all": undefined;
  "web.remote.issue.filter.done": undefined;
  "web.remote.issue.filter.review": undefined;
  "web.remote.issue.status": undefined;
  "web.remote.mobile.codeLabel": undefined;
  "web.remote.mobile.deviceNameLabel": undefined;
  "web.remote.mobile.invalidInput": undefined;
  "web.remote.mobile.pairAction": undefined;
  "web.remote.mobile.pairSubtitle": undefined;
  "web.remote.mobile.pairTitle": undefined;
  "web.remote.mobile.pairing": undefined;
  "web.remote.mobile.urlLabel": undefined;
  "web.remote.pair.action": undefined;
  "web.remote.pair.code": undefined;
  "web.remote.pair.copied": undefined;
  "web.remote.pair.copy": undefined;
  "web.remote.pair.expires": { readonly time: string | number };
  "web.remote.pair.qrHint": undefined;
  "web.remote.session.empty": undefined;
  "web.remote.session.events": undefined;
  "web.remote.session.promptPlaceholder": undefined;
  "web.remote.session.send": undefined;
  "web.remote.session.stop": undefined;
  "web.remote.state.connected": undefined;
  "web.remote.state.connecting": undefined;
  "web.remote.state.disconnect": undefined;
  "web.remote.state.offline": undefined;
  "web.remote.state.reconnecting": undefined;
  "web.remote.state.unauthorized": undefined;
  "web.remote.subtitle": undefined;
  "web.remote.tabs.channels": undefined;
  "web.remote.tabs.inbox": undefined;
  "web.remote.tabs.issues": undefined;
  "web.remote.tabs.sessions": undefined;
  "web.remote.tailscale.ip": undefined;
  "web.remote.tailscale.offline": undefined;
  "web.remote.tailscale.online": undefined;
  "web.remote.tailscale.url": undefined;
  "web.remote.title": undefined;
  "web.remote.toggle.disable": undefined;
  "web.remote.toggle.disabled": undefined;
  "web.remote.toggle.enable": undefined;
  "web.remote.toggle.enabled": undefined;
  "web.repo.add": undefined;
  "web.repo.all": undefined;
  "web.repo.allLine": undefined;
  "web.repo.busiest": { readonly day: string | number; readonly n: string | number };
  "web.repo.busy": undefined;
  "web.repo.byLines": undefined;
  "web.repo.calendar": undefined;
  "web.repo.cancel": undefined;
  "web.repo.code": undefined;
  "web.repo.commitCount": undefined;
  "web.repo.commits": { readonly n: string | number };
  "web.repo.copied": { readonly path: string | number };
  "web.repo.copyPath": undefined;
  "web.repo.countedAgo": { readonly ago: string | number };
  "web.repo.counting": undefined;
  "web.repo.create": undefined;
  "web.repo.current": undefined;
  "web.repo.dayCommits": { readonly level: string | number; readonly n: string | number };
  "web.repo.days": { readonly n: number };
  "web.repo.daysWorked": undefined;
  "web.repo.download": undefined;
  "web.repo.downloading": undefined;
  "web.repo.empty": undefined;
  "web.repo.fewer": undefined;
  "web.repo.finding": undefined;
  "web.repo.firstCommit": undefined;
  "web.repo.fresh": undefined;
  "web.repo.github": undefined;
  "web.repo.githubAddress": undefined;
  "web.repo.githubHint": undefined;
  "web.repo.how": undefined;
  "web.repo.inYear": undefined;
  "web.repo.install": undefined;
  "web.repo.kinds": { readonly n: string | number };
  "web.repo.languages": undefined;
  "web.repo.level.0": undefined;
  "web.repo.level.1": undefined;
  "web.repo.level.2": undefined;
  "web.repo.level.3": undefined;
  "web.repo.level.4": undefined;
  "web.repo.lines": { readonly n: string | number };
  "web.repo.linesAndFiles": { readonly files: string | number; readonly lines: string | number };
  "web.repo.list": undefined;
  "web.repo.longest": undefined;
  "web.repo.making": undefined;
  "web.repo.more": undefined;
  "web.repo.name": undefined;
  "web.repo.nameExample": undefined;
  "web.repo.nameHint": undefined;
  "web.repo.noCommits": undefined;
  "web.repo.noCommitsThatDay": undefined;
  "web.repo.noTokei": undefined;
  "web.repo.none": undefined;
  "web.repo.notCopied": undefined;
  "web.repo.notGit": undefined;
  "web.repo.openWorkspace": undefined;
  "web.repo.or": undefined;
  "web.repo.otherLang": undefined;
  "web.repo.readingCommits": undefined;
  "web.repo.recency.day": undefined;
  "web.repo.recency.label": { readonly label: string | number };
  "web.repo.recency.month": undefined;
  "web.repo.recency.never": undefined;
  "web.repo.recency.older": undefined;
  "web.repo.recency.quarter": undefined;
  "web.repo.recency.week": undefined;
  "web.repo.recount": undefined;
  "web.repo.repos": undefined;
  "web.repo.rest": { readonly commits: string | number; readonly people: string | number };
  "web.repo.rows.0": undefined;
  "web.repo.rows.1": undefined;
  "web.repo.rows.2": undefined;
  "web.repo.rows.3": undefined;
  "web.repo.rows.4": undefined;
  "web.repo.rows.5": undefined;
  "web.repo.rows.6": undefined;
  "web.repo.thenRecount": undefined;
  "web.repo.times": { readonly n: string | number };
  "web.repo.uncounted": undefined;
  "web.repo.whatLanguages": undefined;
  "web.repo.who": undefined;
  "web.repo.whoWhen": undefined;
  "web.repo.year": undefined;
  "web.repo.yearLabel": { readonly commits: string | number; readonly days: string | number };
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
  "web.runtime.inspectorHide": undefined;
  "web.runtime.inspectorShow": undefined;
  "web.runtime.inspectorTitle": undefined;
  "web.runtime.left": { readonly pct: string | number };
  "web.runtime.library.body": undefined;
  "web.runtime.library.bodyExample": undefined;
  "web.runtime.library.bodyHint": undefined;
  "web.runtime.library.book": undefined;
  "web.runtime.library.builtIn": { readonly count: string | number };
  "web.runtime.library.builtInNote": undefined;
  "web.runtime.library.builtInTag": undefined;
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
  "web.runtime.machines.installedCount": undefined;
  "web.runtime.machines.kind.local": undefined;
  "web.runtime.machines.kind.remote": undefined;
  "web.runtime.machines.kind.sandbox": undefined;
  "web.runtime.machines.lastSeen": undefined;
  "web.runtime.machines.machineId": undefined;
  "web.runtime.machines.platform.container": undefined;
  "web.runtime.machines.platform.linux": undefined;
  "web.runtime.machines.platform.macos": undefined;
  "web.runtime.machines.platform.other": undefined;
  "web.runtime.machines.status.draining": undefined;
  "web.runtime.machines.status.offline": undefined;
  "web.runtime.machines.status.online": undefined;
  "web.runtime.machines.title": undefined;
  "web.runtime.machines.worktree": undefined;
  "web.runtime.machines.worktreeNo": undefined;
  "web.runtime.machines.worktreeYes": undefined;
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
  "web.runtime.noSessions": undefined;
  "web.runtime.noSteer": undefined;
  "web.runtime.noUsage": undefined;
  "web.runtime.none": undefined;
  "web.runtime.noneInstalled": undefined;
  "web.runtime.noneInstalledHint": undefined;
  "web.runtime.noneYet": undefined;
  "web.runtime.notFound": undefined;
  "web.runtime.ownDefault": undefined;
  "web.runtime.ownProcess": undefined;
  "web.runtime.queries": undefined;
  "web.runtime.quickActions": undefined;
  "web.runtime.quota.oneWeek": undefined;
  "web.runtime.quota.session": undefined;
  "web.runtime.quota.signedOut": undefined;
  "web.runtime.quota.unreported": undefined;
  "web.runtime.quota.week": { readonly models: string | number };
  "web.runtime.quota.weekly": undefined;
  "web.runtime.reading": undefined;
  "web.runtime.recheck": undefined;
  "web.runtime.refreshAll": undefined;
  "web.runtime.refused": undefined;
  "web.runtime.remoteSummary": { readonly machine: string | number };
  "web.runtime.resets": { readonly moment: string | number };
  "web.runtime.save": undefined;
  "web.runtime.sessions": undefined;
  "web.runtime.settings": undefined;
  "web.runtime.sidebarToggle": undefined;
  "web.runtime.signInTerminal": undefined;
  "web.runtime.signedOut": { readonly runtime: string | number };
  "web.runtime.skills": undefined;
  "web.runtime.spentToday": { readonly spent: string | number };
  "web.runtime.spentTodayBudget": { readonly budget: string | number; readonly spent: string | number };
  "web.runtime.steer": undefined;
  "web.runtime.subscription": { readonly tier: string | number };
  "web.runtime.tools": undefined;
  "web.runtime.unlimited": undefined;
  "web.runtime.unreadable": { readonly why: string | number };
  "web.runtime.unreported": undefined;
  "web.runtime.unsupported": undefined;
  "web.runtime.unsupportedWhy": { readonly why: string | number };
  "web.runtime.usedBy": { readonly n: string | number };
  "web.runtime.windowLeft": { readonly label: string | number; readonly pct: string | number };
  "web.session.hub.back": undefined;
  "web.session.hub.clear": undefined;
  "web.session.hub.clearFilter": undefined;
  "web.session.hub.empty": undefined;
  "web.session.hub.emptyFiltered": undefined;
  "web.session.hub.filterAgent": { readonly name: string | number };
  "web.session.hub.filterIssue": { readonly label: string | number };
  "web.session.hub.list": undefined;
  "web.session.hub.openIssue": undefined;
  "web.session.hub.openProfile": undefined;
  "web.session.hub.orchestratorRole": undefined;
  "web.session.hub.pick": undefined;
  "web.session.hub.scope.active": undefined;
  "web.session.hub.scope.all": undefined;
  "web.session.hub.scope.orchestrator": undefined;
  "web.session.hub.scope.worker": undefined;
  "web.session.hub.scopeLabel": undefined;
  "web.session.hub.search": undefined;
  "web.session.hub.searchHint": undefined;
  "web.session.hub.status.closed": undefined;
  "web.session.hub.status.done": undefined;
  "web.session.hub.status.failed": undefined;
  "web.session.hub.status.interrupted": undefined;
  "web.session.hub.status.listening": undefined;
  "web.session.hub.status.resting": undefined;
  "web.session.hub.status.working": undefined;
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
  "web.session.subagents.creator": { readonly who: string | number };
  "web.session.subagents.disconnected": { readonly ago: string | number };
  "web.session.subagents.heading": undefined;
  "web.session.subagents.lastMailbox": { readonly who: string | number };
  "web.session.subagents.lastWait": { readonly targets: string | number; readonly who: string | number };
  "web.session.subagents.mailbox": { readonly who: string | number };
  "web.session.subagents.noLog": undefined;
  "web.session.subagents.observed": { readonly ago: string | number; readonly status: string | number };
  "web.session.subagents.openLog": { readonly task: string | number };
  "web.session.subagents.root": undefined;
  "web.session.subagents.status.completed": undefined;
  "web.session.subagents.status.errored": undefined;
  "web.session.subagents.status.interrupted": undefined;
  "web.session.subagents.status.notFound": undefined;
  "web.session.subagents.status.pendingInit": undefined;
  "web.session.subagents.status.running": undefined;
  "web.session.subagents.status.shutdown": undefined;
  "web.session.subagents.status.unknown": undefined;
  "web.session.subagents.steps.completed": undefined;
  "web.session.subagents.steps.inProgress": undefined;
  "web.session.subagents.steps.pending": undefined;
  "web.session.subagents.steps.title": undefined;
  "web.session.subagents.wait": { readonly targets: string | number; readonly who: string | number };
  "web.session.trajectory.cacheHit": { readonly pct: string | number };
  "web.session.trajectory.earlier": undefined;
  "web.session.trajectory.failed": undefined;
  "web.session.trajectory.hired": { readonly ago: string | number };
  "web.session.trajectory.hiredAndLeft": { readonly hired: string | number; readonly left: string | number };
  "web.session.trajectory.input": undefined;
  "web.session.trajectory.lane.asked": undefined;
  "web.session.trajectory.lane.model": undefined;
  "web.session.trajectory.lane.tool": undefined;
  "web.session.trajectory.marked": undefined;
  "web.session.trajectory.modelTime": { readonly took: string | number };
  "web.session.trajectory.noMatch": undefined;
  "web.session.trajectory.noOutput": undefined;
  "web.session.trajectory.ok": undefined;
  "web.session.trajectory.output": undefined;
  "web.session.trajectory.pending": undefined;
  "web.session.trajectory.quiet": undefined;
  "web.session.trajectory.run": { readonly n: string | number };
  "web.session.trajectory.running": undefined;
  "web.session.trajectory.runs": { readonly n: number };
  "web.session.trajectory.search": undefined;
  "web.session.trajectory.searchHint": undefined;
  "web.session.trajectory.steps": { readonly n: number };
  "web.session.trajectory.tokens": { readonly input: string | number; readonly output: string | number };
  "web.session.trajectory.tool": { readonly name: string | number };
  "web.session.trajectory.toolTime": { readonly took: string | number };
  "web.session.trajectory.want": undefined;
  "web.session.trajectory.wantHint": undefined;
  "web.session.trajectory.wrong": undefined;
  "web.setting.about.check": undefined;
  "web.setting.about.checking": undefined;
  "web.setting.about.cli": undefined;
  "web.setting.about.cliHint": { readonly command: string | number };
  "web.setting.about.cliInstall": undefined;
  "web.setting.about.cliNotOnPath": { readonly link: string | number };
  "web.setting.about.cliReady": { readonly command: string | number };
  "web.setting.about.cliRemove": undefined;
  "web.setting.about.cliTaken": { readonly link: string | number };
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
  "web.setting.about.repos": undefined;
  "web.setting.about.reposHint": undefined;
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
  "web.setting.about.worktrees": undefined;
  "web.setting.about.worktreesHint": undefined;
  "web.setting.appearance.monoFont": undefined;
  "web.setting.appearance.monoFontHint": undefined;
  "web.setting.appearance.monoFontRow": undefined;
  "web.setting.appearance.motion": undefined;
  "web.setting.appearance.motionHint": undefined;
  "web.setting.appearance.motionOption.off": undefined;
  "web.setting.appearance.motionOption.on": undefined;
  "web.setting.appearance.motionOption.system": undefined;
  "web.setting.appearance.scale": undefined;
  "web.setting.appearance.scaleHint": undefined;
  "web.setting.appearance.terminalFontSize": undefined;
  "web.setting.appearance.terminalFontSizeHint": undefined;
  "web.setting.appearance.theme": undefined;
  "web.setting.appearance.themeHint": undefined;
  "web.setting.appearance.themes.dark": undefined;
  "web.setting.appearance.themes.light": undefined;
  "web.setting.appearance.themes.system": undefined;
  "web.setting.feature.call": undefined;
  "web.setting.feature.image": undefined;
  "web.setting.feature.live": undefined;
  "web.setting.feature.orchestrator": undefined;
  "web.setting.feature.speakers": undefined;
  "web.setting.feature.speech": undefined;
  "web.setting.feature.transcription": undefined;
  "web.setting.feature.understanding": undefined;
  "web.setting.feature.vision": undefined;
  "web.setting.feature.voiceDesign": undefined;
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
  "web.setting.keys.deepseekHint": undefined;
  "web.setting.keys.saved": undefined;
  "web.setting.language.en": undefined;
  "web.setting.language.label": undefined;
  "web.setting.language.line": undefined;
  "web.setting.language.title": undefined;
  "web.setting.language.zh": undefined;
  "web.setting.memory.intro": undefined;
  "web.setting.missing.binding": undefined;
  "web.setting.missing.deepseekKey": undefined;
  "web.setting.missing.mossAccount": undefined;
  "web.setting.missing.mossKey": undefined;
  "web.setting.missing.mossOff": undefined;
  "web.setting.models.deepseekHint": undefined;
  "web.setting.models.intro": undefined;
  "web.setting.nav.about": undefined;
  "web.setting.nav.appearance": undefined;
  "web.setting.nav.chat": undefined;
  "web.setting.nav.connections": undefined;
  "web.setting.nav.general": undefined;
  "web.setting.nav.label": undefined;
  "web.setting.nav.memory": undefined;
  "web.setting.nav.models": undefined;
  "web.setting.nav.remote": undefined;
  "web.setting.nav.search": undefined;
  "web.setting.nav.skills": undefined;
  "web.setting.nav.voice": undefined;
  "web.setting.nav.width": undefined;
  "web.setting.readiness.fix": undefined;
  "web.setting.readiness.lacks": { readonly feature: string | number; readonly why: string | number };
  "web.setting.readiness.ready": { readonly feature: string | number };
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
  "web.setting.words.connections": undefined;
  "web.setting.words.general": undefined;
  "web.setting.words.memory": undefined;
  "web.setting.words.models": undefined;
  "web.setting.words.remote": undefined;
  "web.setting.words.skills": undefined;
  "web.setting.words.voice": undefined;
  "web.shell.chat.attachFile": undefined;
  "web.shell.chat.chooseModel": undefined;
  "web.shell.chat.composerPlaceholder": { readonly runtime: string | number };
  "web.shell.chat.configFailed": { readonly why: string | number };
  "web.shell.chat.emptyHint": undefined;
  "web.shell.chat.emptyTitle": undefined;
  "web.shell.chat.interactionAnswered": undefined;
  "web.shell.chat.interactionBadge": undefined;
  "web.shell.chat.interactionConfirm": undefined;
  "web.shell.chat.interactionCustomPlaceholder": undefined;
  "web.shell.chat.interactionDecline": undefined;
  "web.shell.chat.interactionDeclined": undefined;
  "web.shell.chat.model": undefined;
  "web.shell.chat.permissionAllowOnce": undefined;
  "web.shell.chat.permissionAllowSession": undefined;
  "web.shell.chat.permissionBadge": undefined;
  "web.shell.chat.permissionDeny": undefined;
  "web.shell.chat.removeFile": { readonly name: string | number };
  "web.shell.chat.respondFailed": { readonly why: string | number };
  "web.shell.chat.runtime": undefined;
  "web.shell.chat.send": undefined;
  "web.shell.chat.sendFailed": { readonly why: string | number };
  "web.shell.chat.statusWaiting": undefined;
  "web.shell.chat.steer": undefined;
  "web.shell.chat.steerPlaceholder": undefined;
  "web.shell.chat.steerTag": undefined;
  "web.shell.chat.steeringBanner": undefined;
  "web.shell.chat.stop": undefined;
  "web.shell.chat.stopFailed": { readonly why: string | number };
  "web.shell.chat.telemetryCache": { readonly pct: string | number };
  "web.shell.chat.telemetryCacheTitle": undefined;
  "web.shell.chat.telemetryCached": undefined;
  "web.shell.chat.telemetryContext": { readonly pct: string | number };
  "web.shell.chat.telemetryContextTitle": undefined;
  "web.shell.chat.telemetryDetails": undefined;
  "web.shell.chat.telemetryHide": undefined;
  "web.shell.chat.telemetryOutput": undefined;
  "web.shell.chat.telemetryQuota": { readonly pct: string | number };
  "web.shell.chat.telemetryQuotaTitle": undefined;
  "web.shell.chat.telemetryQuotaUnavailable": undefined;
  "web.shell.chat.telemetryReasoning": undefined;
  "web.shell.chat.telemetryTurns": { readonly tools: string | number; readonly turns: string | number };
  "web.shell.chat.telemetryUncached": undefined;
  "web.shell.chat.thinking": undefined;
  "web.shell.chat.thoughtHigh": undefined;
  "web.shell.chat.thoughtLevel": undefined;
  "web.shell.chat.thoughtLow": undefined;
  "web.shell.chat.thoughtMax": undefined;
  "web.shell.chat.thoughtMedium": undefined;
  "web.shell.chat.title": undefined;
  "web.shell.chat.toolFailed": undefined;
  "web.shell.chat.toolNoOutput": undefined;
  "web.shell.chat.toolOk": undefined;
  "web.shell.chat.toolOpenDiff": undefined;
  "web.shell.chat.toolOpenFile": undefined;
  "web.shell.chat.toolPending": undefined;
  "web.shell.chat.toolRunning": undefined;
  "web.shell.chat.you": undefined;
  "web.shell.fileTree.collapseAllDirs": undefined;
  "web.shell.fileTree.copyAbsPath": undefined;
  "web.shell.fileTree.copyRelPath": undefined;
  "web.shell.fileTree.empty": undefined;
  "web.shell.fileTree.loading": undefined;
  "web.shell.fileTree.newTerminalInDir": undefined;
  "web.shell.fileTree.revealInFinder": undefined;
  "web.shell.fileTree.title": undefined;
  "web.shell.git.branches": undefined;
  "web.shell.git.cancel": undefined;
  "web.shell.git.changes": undefined;
  "web.shell.git.clean": undefined;
  "web.shell.git.commitPlaceholder": undefined;
  "web.shell.git.commitStaged": { readonly count: string | number };
  "web.shell.git.commitSuccess": undefined;
  "web.shell.git.commits": undefined;
  "web.shell.git.committing": undefined;
  "web.shell.git.confirmDiscard": undefined;
  "web.shell.git.conflicts": undefined;
  "web.shell.git.createBtn": undefined;
  "web.shell.git.creatingWorktree": undefined;
  "web.shell.git.currentBranch": { readonly name: string | number };
  "web.shell.git.daysAgo": { readonly n: string | number };
  "web.shell.git.discardPath": { readonly path: string | number };
  "web.shell.git.filterBranches": undefined;
  "web.shell.git.hoursAgo": { readonly n: string | number };
  "web.shell.git.justNow": undefined;
  "web.shell.git.loading": undefined;
  "web.shell.git.mainLabel": undefined;
  "web.shell.git.minutesAgo": { readonly n: string | number };
  "web.shell.git.newBranchPlaceholder": undefined;
  "web.shell.git.newWorktree": undefined;
  "web.shell.git.noBranches": undefined;
  "web.shell.git.noCommits": undefined;
  "web.shell.git.noMatchingBranches": undefined;
  "web.shell.git.noStaged": undefined;
  "web.shell.git.notRepo": undefined;
  "web.shell.git.refresh": undefined;
  "web.shell.git.removeFailed": { readonly why: string | number };
  "web.shell.git.removedWorktree": { readonly label: string | number };
  "web.shell.git.removing": undefined;
  "web.shell.git.stageAll": undefined;
  "web.shell.git.stageAllCount": { readonly count: string | number };
  "web.shell.git.stagePath": { readonly path: string | number };
  "web.shell.git.staged": undefined;
  "web.shell.git.stagedEmpty": undefined;
  "web.shell.git.switchBranch": { readonly name: string | number };
  "web.shell.git.switching": undefined;
  "web.shell.git.tab.branches": { readonly count: string | number };
  "web.shell.git.tab.changes": undefined;
  "web.shell.git.tab.changesCount": { readonly count: string | number };
  "web.shell.git.tab.commits": undefined;
  "web.shell.git.title": undefined;
  "web.shell.git.unstageAll": undefined;
  "web.shell.git.unstagePath": { readonly path: string | number };
  "web.shell.git.worktrees": undefined;
  "web.shell.git.wtChangedCount": { readonly n: string | number };
  "web.shell.git.wtClean": undefined;
  "web.shell.git.wtConfirmDelete": undefined;
  "web.shell.git.wtConfirmDeletePrompt": undefined;
  "web.shell.git.wtConflictsCount": { readonly n: string | number };
  "web.shell.git.wtDirtyPrompt": undefined;
  "web.shell.git.wtForceDelete": undefined;
  "web.shell.git.wtRemoveMenu": undefined;
  "web.shell.git.wtRunning": undefined;
  "web.shell.palette.a11y.commands": undefined;
  "web.shell.palette.a11y.files": undefined;
  "web.shell.palette.a11y.search": undefined;
  "web.shell.palette.empty.commands": undefined;
  "web.shell.palette.empty.files": undefined;
  "web.shell.palette.empty.search": undefined;
  "web.shell.palette.footer.close": undefined;
  "web.shell.palette.footer.run": undefined;
  "web.shell.palette.footer.select": undefined;
  "web.shell.palette.mode.commands": undefined;
  "web.shell.palette.mode.files": undefined;
  "web.shell.palette.mode.search": undefined;
  "web.shell.palette.placeholder.commands": undefined;
  "web.shell.palette.placeholder.files": undefined;
  "web.shell.palette.placeholder.search": undefined;
  "web.shell.palette.searching": undefined;
  "web.shell.repoDetail.activity": undefined;
  "web.shell.repoDetail.activitySummary": { readonly tabs: string | number; readonly worktrees: string | number };
  "web.shell.repoDetail.badgeFolder": undefined;
  "web.shell.repoDetail.badgeManaged": undefined;
  "web.shell.repoDetail.branch": undefined;
  "web.shell.repoDetail.closeFolder": undefined;
  "web.shell.repoDetail.commits": undefined;
  "web.shell.repoDetail.copied": undefined;
  "web.shell.repoDetail.languages": undefined;
  "web.shell.repoDetail.maxSessions": undefined;
  "web.shell.repoDetail.newChat": undefined;
  "web.shell.repoDetail.newTerminal": undefined;
  "web.shell.repoDetail.openFullPage": undefined;
  "web.shell.repoDetail.openIssues": undefined;
  "web.shell.repoDetail.prReady": undefined;
  "web.shell.repoDetail.prUnavailable": undefined;
  "web.shell.repoDetail.pullRequest": undefined;
  "web.shell.repoDetail.repoType": undefined;
  "web.shell.repoDetail.runningSessions": undefined;
  "web.shell.repoDetail.sectionOverview": undefined;
  "web.shell.repoDetail.tabsCount": { readonly n: string | number };
  "web.shell.repoDetail.typeFolder": undefined;
  "web.shell.repoDetail.typeGit": undefined;
  "web.shell.repoDetail.worktrees": undefined;
  "web.shell.section.collapse": { readonly title: string | number };
  "web.shell.section.expand": { readonly title: string | number };
  "web.shell.sidebar.addRepo": undefined;
  "web.shell.sidebar.addRepoButton": undefined;
  "web.shell.sidebar.addRepoTooltip": undefined;
  "web.shell.sidebar.attentionCount": { readonly n: string | number };
  "web.shell.sidebar.backToRepos": undefined;
  "web.shell.sidebar.chatWaiting": undefined;
  "web.shell.sidebar.closeFolder": { readonly name: string | number };
  "web.shell.sidebar.closeFolderMenu": undefined;
  "web.shell.sidebar.closeTab": undefined;
  "web.shell.sidebar.collapseAll": undefined;
  "web.shell.sidebar.collapseItem": { readonly name: string | number };
  "web.shell.sidebar.copyPath": undefined;
  "web.shell.sidebar.expandCurrent": undefined;
  "web.shell.sidebar.expandItem": { readonly name: string | number };
  "web.shell.sidebar.files": undefined;
  "web.shell.sidebar.filesTip": undefined;
  "web.shell.sidebar.gitBranches": undefined;
  "web.shell.sidebar.gitBranchesTip": undefined;
  "web.shell.sidebar.gitChanges": undefined;
  "web.shell.sidebar.gitChangesTip": undefined;
  "web.shell.sidebar.gitCommits": undefined;
  "web.shell.sidebar.gitCommitsTip": undefined;
  "web.shell.sidebar.mainLabel": undefined;
  "web.shell.sidebar.mainWorktree": { readonly label: string | number };
  "web.shell.sidebar.manageRepos": undefined;
  "web.shell.sidebar.needsAttention": undefined;
  "web.shell.sidebar.newChat": { readonly name: string | number };
  "web.shell.sidebar.newChatHere": undefined;
  "web.shell.sidebar.newTerminal": { readonly name: string | number };
  "web.shell.sidebar.newTerminalHere": undefined;
  "web.shell.sidebar.ready": undefined;
  "web.shell.sidebar.readyAgent": { readonly agent: string | number };
  "web.shell.sidebar.readyCount": { readonly n: string | number };
  "web.shell.sidebar.removeWorktree": undefined;
  "web.shell.sidebar.repoDetails": undefined;
  "web.shell.sidebar.revealInFinder": undefined;
  "web.shell.sidebar.running": undefined;
  "web.shell.sidebar.runningAgent": { readonly agent: string | number };
  "web.shell.sidebar.tabMore": undefined;
  "web.shell.sidebar.tabsGroup": undefined;
  "web.shell.sidebar.terminalCount": { readonly n: string | number };
  "web.shell.sidebar.title": undefined;
  "web.shell.sidebar.workingCount": { readonly n: string | number };
  "web.shell.swarm.boardAll": undefined;
  "web.shell.swarm.boardBrief": undefined;
  "web.shell.swarm.boardCount": { readonly shown: string | number; readonly total: string | number };
  "web.shell.swarm.boardEmpty": undefined;
  "web.shell.swarm.boardFilterPlaceholder": undefined;
  "web.shell.swarm.boardJumpLatest": undefined;
  "web.shell.swarm.closeDrawer": undefined;
  "web.shell.swarm.openDrawer": undefined;
  "web.shell.swarm.overviewEmpty": undefined;
  "web.shell.swarm.pill": { readonly active: string | number; readonly working: string | number };
  "web.shell.swarm.roleCoordinator": undefined;
  "web.shell.swarm.roleWorker": undefined;
  "web.shell.swarm.rosterSelectHint": undefined;
  "web.shell.swarm.stateKilled": undefined;
  "web.shell.swarm.stateStopped": undefined;
  "web.shell.swarm.stateWaiting": undefined;
  "web.shell.swarm.stateWaitingAll": { readonly seq: string | number };
  "web.shell.swarm.stateWaitingMentions": { readonly seq: string | number };
  "web.shell.swarm.stateWorking": undefined;
  "web.shell.swarm.tabBoard": undefined;
  "web.shell.swarm.tabOverview": undefined;
  "web.shell.swarm.tabRoster": undefined;
  "web.shell.swarm.transcriptEmpty": undefined;
  "web.shell.swarm.transcriptFailed": { readonly why: string | number };
  "web.shell.swarm.transcriptRefresh": undefined;
  "web.shell.swarm.transcriptThinking": undefined;
  "web.shell.swarm.transcriptTitle": undefined;
  "web.voice.moss.connecting": undefined;
  "web.voice.moss.hangUp": undefined;
  "web.voice.moss.intro": undefined;
  "web.voice.moss.mute": undefined;
  "web.voice.moss.nativeCall": undefined;
  "web.voice.moss.nativeNotice": undefined;
  "web.voice.moss.talk": undefined;
  "web.voice.moss.unmute": undefined;
  "web.voice.voice.moss.checking": undefined;
  "web.voice.voice.moss.ok": undefined;
  "web.voice.voice.moss.verify": undefined;
  "web.voice.voice.noSettings": { readonly why: string | number };
  "web.voice.voice.persona.greeting": undefined;
  "web.voice.voice.persona.greetingHint": undefined;
  "web.voice.voice.persona.intro": undefined;
  "web.voice.voice.persona.open": undefined;
  "web.voice.voice.persona.openParts": undefined;
  "web.voice.voice.persona.page": undefined;
  "web.voice.voice.persona.persona": undefined;
  "web.voice.voice.persona.personaHint": undefined;
  "web.voice.voice.saved": undefined;
  "web.voice.voice.section.label": undefined;
}

//! Deterministic multi-density scenario builder backed by `Core::apply` and `reduce`.
//!
//! Used by UI acceptance suites and fake-server fixture exporters so every
//! test frame carries genuine derived `status`, `stage`, `moves`, `inbox`,
//! `phaseText`, and `view.plots` from `vibevalley-core`.

use std::collections::BTreeMap;

use vibevalley_protocol::*;

use crate::Core;

/// Fixed epoch used across Rust scenarios and JS virtual-clock tests (2026-11-20 UTC).
pub const SCENARIO_NOW: Millis = 1_795_194_443_624;

const MIN_MS: Millis = 60_000;
const HOUR_MS: Millis = 60 * MIN_MS;

const LONG_ZH: &str = "把终端面板在窗口缩放时的回滚内容保留下来，并且在助手往里面持续输出很长的工具结果时保持光标所在行稳定，在一百二十赫兹显示器上也不掉帧 https://vibevalley.dev/issues/long-scrollback";
const LONG_EN: &str =
    "Keep scrollback anchored during rapid window resize while streaming multi-kilobyte tool output and Shiki code blocks at 120fps without main-thread stalls";
const LONG_SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LONG_PR_URL: &str = "https://github.com/vibevalley/vibevalley/pull/4242/commits/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/// Preset data densities spanning empty onboarding to high-density and exhaustive edge cases.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Density {
    Empty,
    Minimal,
    Typical,
    Dense,
    Extreme,
    Edge,
}

impl Density {
    pub const ALL: [Density; 6] = [
        Density::Empty,
        Density::Minimal,
        Density::Typical,
        Density::Dense,
        Density::Extreme,
        Density::Edge,
    ];

    pub fn slug(self) -> &'static str {
        match self {
            Density::Empty => "empty",
            Density::Minimal => "minimal",
            Density::Typical => "typical",
            Density::Dense => "dense",
            Density::Extreme => "extreme",
            Density::Edge => "edge",
        }
    }
}

/// Fluent builder that applies real `Fact` batches through `Core`.
pub struct ScenarioBuilder {
    core: Core,
    now: Millis,
    effects: Vec<GameEffect>,
}

impl ScenarioBuilder {
    pub fn new(now: Millis) -> Self {
        Self {
            core: Core::default(),
            now,
            effects: Vec::new(),
        }
    }

    pub fn now(&self) -> Millis {
        self.now
    }

    pub fn advance_ms(&mut self, delta_ms: Millis) {
        self.now += delta_ms;
    }

    pub fn apply(&mut self, facts: Vec<Fact>) {
        let applied = self.core.apply(facts);
        self.effects.extend(applied.effects);
    }

    pub fn frame(&self) -> StateFrame {
        self.core.frame(self.effects.clone())
    }
}

/// Builds the canonical `StateFrame` for `density` at `SCENARIO_NOW`.
pub fn preset(density: Density) -> StateFrame {
    let mut b = ScenarioBuilder::new(SCENARIO_NOW);
    match density {
        Density::Empty => {
            b.apply(vec![
                Fact::CallChanged(FactCallChanged {
                    at: b.now(),
                    state: CallState::Idle,
                    reason: String::new(),
                }),
                Fact::ChannelChanged(FactChannelChanged {
                    at: b.now(),
                    channel: channel("general", ChannelType::Channel, true, Some("general"), "", b.now()),
                }),
                Fact::MediaChanged(FactMediaChanged { at: b.now(), jobs: vec![] }),
            ]);
        }
        Density::Minimal => {
            let mut s = worker("w1", "老周", "laozhou", "claude", b.now() - 8 * MIN_MS);
            s.issue = Some("i1".into());
            s.repo = Some("~/vibevalley".into());
            s.branch = Some("issue-1-init".into());
            s.phase = Phase::working(b.now() - 2 * MIN_MS, SessionAction::EditFile, "session.ts");
            s.spent = Some(spent(42_000, 0.08));

            let mut i = issue("i1", 1, "修复登录过期跳转", Priority::High, b.now() - HOUR_MS);
            i.repo = Some("~/vibevalley".into());
            i.description = "会话过期后自动回到登录页并保留提示。".into();
            i.criteria = vec!["过期会话回到登录页".into()];
            assign(&mut i, "laozhou", &s.id, b.now() - 3 * MIN_MS);

            let msg1 = message(
                "general",
                1,
                Actor::User {
                    id: USER_ID.into(),
                    name: Some("你".into()),
                },
                MessageKind::Chat,
                "先看看登录过期的问题。",
                b.now() - 10 * MIN_MS,
            );
            let mut msg2 = message(
                "general",
                2,
                Actor::Agent {
                    id: "laozhou".into(),
                    role: AgentRole::Worker,
                    name: Some("老周".into()),
                    for_user: None,
                },
                MessageKind::Report,
                "已经在查 session.ts，很快给结果。",
                b.now() - 2 * MIN_MS,
            );
            msg2.from = "w1".into();
            msg2.session = Some("w1".into());
            msg2.run = Some("run-1".into());
            msg2.spent = Some(spent(42_000, 0.08));

            b.apply(vec![
                Fact::CallChanged(FactCallChanged {
                    at: b.now(),
                    state: CallState::Live,
                    reason: String::new(),
                }),
                Fact::SessionChanged(FactSessionChanged { at: b.now(), session: s }),
                Fact::IssueChanged(FactIssueChanged { at: b.now(), issue: i }),
                Fact::ChannelChanged(FactChannelChanged {
                    at: b.now(),
                    channel: channel("general", ChannelType::Channel, true, Some("general"), "团队默认频道", b.now()),
                }),
                Fact::MessageChanged(FactMessageChanged {
                    at: msg1.at,
                    message: msg1,
                    thread: None,
                    answers: None,
                }),
                Fact::MessageChanged(FactMessageChanged {
                    at: msg2.at,
                    message: msg2,
                    thread: None,
                    answers: None,
                }),
                Fact::CronChanged(FactCronChanged {
                    at: b.now(),
                    cron: cron(
                        "c1",
                        "每天站会",
                        CronWhen::Daily(CronWhenDaily { time: "09:30".into() }),
                        true,
                        b.now() - HOUR_MS,
                    ),
                }),
            ]);
        }
        Density::Typical => build_typical(&mut b),
        Density::Dense => build_dense(&mut b),
        Density::Extreme => build_extreme(&mut b),
        Density::Edge => return build_edge(&mut b),
    }
    b.frame()
}

fn build_typical(b: &mut ScenarioBuilder) {
    let now = b.now();
    let mut facts = Vec::new();

    facts.push(Fact::CallChanged(FactCallChanged {
        at: now,
        state: CallState::Live,
        reason: String::new(),
    }));
    facts.push(Fact::MachineChanged(FactMachineChanged {
        at: now,
        machine: Machine {
            id: "local".into(),
            name: "Mac Studio".into(),
            here: true,
            online: true,
            joined_at: now - 48 * HOUR_MS,
        },
    }));
    facts.push(Fact::ProgressChanged(FactProgressChanged {
        at: now,
        progress: Some(Progress {
            coins: 1280,
            streak: 4,
            best_streak: 9,
            counts: BTreeMap::from([("harvested".into(), 14), ("reviewed".into(), 11)]),
            unlocked: vec![Unlock {
                id: "first_harvest".into(),
                tier: 1,
                at: now - 24 * HOUR_MS,
            }],
            title: Some(ProgressTitle {
                id: "first_harvest".into(),
                tier: 1,
            }),
            agents: BTreeMap::from([(
                "laozhou".into(),
                AgentTally {
                    hired: 8,
                    harvested: 6,
                    failed: 1,
                },
            )]),
            multiplier: Some(JsNumber::from(1.2)),
        }),
        news: None,
        commits: Some(CommitCount { total: 42, repos: vec![] }),
        station: None,
    }));

    // Sessions covering Working, Resting, Done, Failed, and Refining.
    let mut w_work = worker("w1", "老周", "laozhou", "codex", now - 20 * MIN_MS);
    w_work.issue = Some("i18".into());
    w_work.repo = Some("vibevalley".into());
    w_work.branch = Some("issue-18-login".into());
    w_work.worktree = Some("/tmp/vibevalley/.worktrees/i18".into());
    w_work.runs = 2;
    w_work.spent = Some(spent(182_400, 0.42));
    w_work.phase = Phase::working(now - 3 * MIN_MS, SessionAction::EditFile, "session.ts");
    w_work.subagents = Some(SessionSubagents {
        run: "run-2".into(),
        root_thread_id: "main".into(),
        disconnected_at: None,
        threads: vec![
            SubagentThread {
                thread_id: "sub-check".into(),
                agent_name: Some("reviewer".into()),
                parent_thread_id: Some("main".into()),
                turn_id: Some("t-1".into()),
                steps: Some(vec![
                    SubagentStep {
                        step: "核对 token 过期时间".into(),
                        status: SubagentStepStatus::Completed,
                    },
                    SubagentStep {
                        step: "补充单元测试".into(),
                        status: SubagentStepStatus::InProgress,
                    },
                ]),
                task: Some("检查登录边界与回归用例".into()),
                status: Some(SubagentStatus::Running),
                last_activity: Some("运行 login.test.ts".into()),
                last_action: Some(ToolAction::RunCommand),
                updated_at: now - MIN_MS,
            },
            SubagentThread {
                thread_id: "sub-done".into(),
                agent_name: Some("scout".into()),
                parent_thread_id: Some("main".into()),
                turn_id: None,
                steps: None,
                task: Some("梳理现有鉴权中间件".into()),
                status: Some(SubagentStatus::Completed),
                last_activity: None,
                last_action: Some(ToolAction::ReadFile),
                updated_at: now - 2 * MIN_MS,
            },
        ],
        waits: vec![SubagentWait {
            thread_id: "main".into(),
            call_id: "wait-1".into(),
            targets: vec!["sub-check".into()],
        }],
    });
    w_work.tool_connections = Some(vec![ToolConnection {
        server: "vibevalley-mcp".into(),
        status: ToolConnectionStatus::Ready,
        reason: None,
    }]);

    let mut w_ask = worker("w2", "小林", "xiaolin", "claude", now - 40 * MIN_MS);
    w_ask.issue = Some("i33".into());
    w_ask.repo = Some("vibevalley".into());
    w_ask.branch = Some("issue-33-shell".into());
    w_ask.runs = 1;
    w_ask.phase = Phase::resting();
    w_ask.last_run = Some(LastRun {
        needs_reconciliation: false,
        outcome: Outcome::Completed,
        summary: "发现两种终端启动方式，需确认默认行为。".into(),
        at: now - 5 * MIN_MS,
        spent: Some(spent(64_000, 0.14)),
        answer: None,
    });

    let mut w_review = worker("w3", "老周", "laozhou", "claude", now - 2 * HOUR_MS);
    w_review.issue = Some("i31".into());
    w_review.repo = Some("vibevalley".into());
    w_review.branch = Some("issue-31-board".into());
    w_review.runs = 2;
    w_review.phase = Phase::done();
    w_review.last_run = Some(LastRun {
        needs_reconciliation: false,
        outcome: Outcome::Completed,
        summary: "补齐看板列表分组与键盘返回测试。".into(),
        at: now - 15 * MIN_MS,
        spent: Some(spent(120_000, 0.29)),
        answer: None,
    });

    let mut w_fail = worker("w4", "阿杰", "ajie", "claude", now - 90 * MIN_MS);
    w_fail.issue = Some("i34".into());
    w_fail.repo = Some("vibevalley".into());
    w_fail.runs = 1;
    w_fail.phase = Phase::failed();
    w_fail.last_run = Some(LastRun {
        needs_reconciliation: false,
        outcome: Outcome::Failed,
        summary: "测试环境缺少原生字体文件，断言失败。".into(),
        at: now - 12 * MIN_MS,
        spent: Some(spent(33_000, 0.06)),
        answer: None,
    });

    let mut w_refine = worker("w5", "起草员", "laozhou", "claude", now - 10 * MIN_MS);
    w_refine.issue = Some("i21".into());
    w_refine.refining = true;
    w_refine.phase = Phase::working(now - 4 * MIN_MS, SessionAction::ReadFile, "App.tsx");

    for s in [w_work, w_ask, w_review, w_fail, w_refine] {
        facts.push(Fact::SessionChanged(FactSessionChanged { at: now, session: s }));
    }

    // Issues covering all statuses, priorities, asking, conflict, family, and closed.
    let i21 = issue("i21", 21, "写一句话就能起草工单", Priority::Low, now - 4 * HOUR_MS);

    let mut i22 = issue("i22", 22, "看板拖拽与列表快捷键切换", Priority::High, now - 3 * HOUR_MS);
    i22.repo = Some("vibevalley".into());
    i22.queued_at = Some(now - 25 * MIN_MS);
    assign_pending(&mut i22, "laozhou", now - 25 * MIN_MS);

    let mut i18 = issue("i18", 18, "修好登录过期跳转", Priority::Urgent, now - 5 * HOUR_MS);
    i18.repo = Some("vibevalley".into());
    i18.description = "过期的会话目前一直报错转圈，应在过期时自动跳回登录页并提示原因。".into();
    i18.criteria = vec!["过期回到登录页".into(), "展示过期原因提示".into(), "补齐回归测试".into()];
    assign(&mut i18, "laozhou", "w1", now - 20 * MIN_MS);

    let mut i33 = issue("i33", 33, "选择新终端标签的默认 Shell", Priority::Medium, now - 6 * HOUR_MS);
    i33.repo = Some("vibevalley".into());
    i33.questions = vec![Question {
        question: "新建终端默认启动登录 Shell 还是当前用户配置 Shell？".into(),
        options: vec!["使用用户默认配置".into(), "强制使用登录 Shell".into()],
    }];
    assign(&mut i33, "xiaolin", "w2", now - 40 * MIN_MS);

    let mut i31 = issue("i31", 31, "补齐看板列表视图与 Esc 聚焦恢复", Priority::High, now - 7 * HOUR_MS);
    i31.repo = Some("vibevalley".into());
    i31.criteria = vec!["列表视图按状态分组".into(), "Esc 回到对应泳道卡片".into()];
    i31.checks = vec![
        CriterionCheck {
            criterion: 0,
            result: CheckResult::Met,
            proof: "ListView 分组测试通过".into(),
        },
        CriterionCheck {
            criterion: 1,
            result: CheckResult::Met,
            proof: "keyboard escape 回归通过".into(),
        },
    ];
    assign(&mut i31, "laozhou", "w3", now - 2 * HOUR_MS);

    let mut i34 = issue("i34", 34, "像素画布首次加载字体回退", Priority::Low, now - 8 * HOUR_MS);
    i34.repo = Some("vibevalley".into());
    assign(&mut i34, "ajie", "w4", now - 90 * MIN_MS);

    let mut i40 = issue("i40", 40, "拆单总览：原生工作台冷启动提速", Priority::High, now - 10 * HOUR_MS);
    i40.repo = Some("vibevalley".into());

    let mut i41 = issue("i41", 41, "子工单 A：延迟构建工作台状态帧", Priority::Medium, now - 9 * HOUR_MS);
    i41.parent = Some("i40".into());
    i41.repo = Some("vibevalley".into());
    i41.delivered = Some(Landing::MergedIntoParent);
    i41.closed_at = Some(now - HOUR_MS);

    let mut i42 = issue("i42", 42, "子工单 B：复用像素纹理与文本缓存", Priority::Medium, now - 8 * HOUR_MS);
    i42.parent = Some("i40".into());
    i42.blocked_by = vec!["i41".into()];
    i42.repo = Some("vibevalley".into());
    i42.queued_at = Some(now - 30 * MIN_MS);

    let mut i12 = issue("i12", 12, "设置页面按功能重新分组", Priority::Medium, now - 24 * HOUR_MS);
    i12.repo = Some("vibevalley".into());
    i12.delivered = Some(Landing::Merged);
    i12.reviewed_at = Some(now - 5 * HOUR_MS);
    i12.closed_at = Some(now - 5 * HOUR_MS);

    let mut i10 = issue("i10", 10, "取消的旧版同步实验", Priority::Low, now - 36 * HOUR_MS);
    i10.canceled = Some(IssueCanceled::Dismissed);
    i10.closed_at = Some(now - 20 * HOUR_MS);

    for item in [i21, i22, i18, i33, i31, i34, i40, i41, i42, i12, i10] {
        facts.push(Fact::IssueChanged(FactIssueChanged { at: now, issue: item }));
    }

    // Chat channels, thread, DM, and mentions.
    let mut general = channel("general", ChannelType::Channel, true, Some("general"), "日常协作与进度同步", now - 2 * MIN_MS);
    general.last_number = Some(3);
    general.unread = Some(1);
    general.last = Some(ChannelLast {
        from: "w1".into(),
        name: "老周".into(),
        text: "工单 #18 正在收尾。".into(),
        at: now - 2 * MIN_MS,
    });

    let design = channel("design", ChannelType::Channel, false, Some("design"), "UI 与设计系统", now - HOUR_MS);
    let mut thread = channel("t-login", ChannelType::Thread, false, None, "", now - 5 * MIN_MS);
    thread.parent = Some("general".into());
    thread.root_number = Some(1);
    thread.replies = 4;
    thread.subject_kind = Some(SubjectKind::Issue);
    thread.subject_id = Some("i18".into());
    thread.title = "登录过期讨论".into();

    let mut dm = channel("dm-laozhou", ChannelType::Direct, false, Some("老周"), "", now - 10 * MIN_MS);
    dm.peer = Some("profile:laozhou".into());

    for c in [general, design, thread, dm] {
        facts.push(Fact::ChannelChanged(FactChannelChanged { at: now, channel: c }));
    }

    let mut mention_msg = message(
        "general",
        3,
        Actor::Agent {
            id: "xiaolin".into(),
            role: AgentRole::Worker,
            name: Some("小林".into()),
            for_user: None,
        },
        MessageKind::Chat,
        "@user 请看一眼 #33 的默认配置选型。",
        now - 3 * MIN_MS,
    );
    mention_msg.id = "m-mention".into();
    mention_msg.from = "w2".into();
    facts.push(Fact::UserMentionsChanged(FactUserMentionsChanged {
        at: now,
        mentions: vec![UserMention {
            message: mention_msg,
            channel: "general".into(),
            address: "#general".into(),
        }],
    }));

    for c in [
        cron(
            "c1",
            "每天站会播报",
            CronWhen::Daily(CronWhenDaily { time: "09:30".into() }),
            true,
            now - 48 * HOUR_MS,
        ),
        cron(
            "c2",
            "每周五回归巡检",
            CronWhen::Weekly(CronWhenWeekly {
                days: vec![5],
                time: "17:00".into(),
            }),
            true,
            now - 72 * HOUR_MS,
        ),
    ] {
        facts.push(Fact::CronChanged(FactCronChanged { at: now, cron: c }));
    }

    for st in [
        connector(
            ConnectorID::Weixin,
            ConnectorState::Connected,
            Some("general"),
            Some("田头助手"),
            0,
            now - HOUR_MS,
        ),
        connector(ConnectorID::Feishu, ConnectorState::Waiting, Some("design"), None, 2, now - 10 * MIN_MS),
        connector(ConnectorID::Qq, ConnectorState::Paused, None, None, 0, now - 20 * MIN_MS),
    ] {
        facts.push(Fact::ConnectorChanged(FactConnectorChanged { at: now, status: st }));
    }

    facts.push(Fact::MediaChanged(FactMediaChanged {
        at: now,
        jobs: default_media_jobs(now),
    }));

    b.apply(facts);
}

fn build_dense(b: &mut ScenarioBuilder) {
    build_typical(b);
    let now = b.now();
    let mut facts = Vec::new();

    facts.push(Fact::CallChanged(FactCallChanged {
        at: now,
        state: CallState::Connecting,
        reason: "正在建立实时语音连接".into(),
    }));
    facts.push(Fact::ConnectorChanged(FactConnectorChanged {
        at: now,
        status: connector(ConnectorID::Qq, ConnectorState::Off, None, None, 0, now - 25 * MIN_MS),
    }));

    // Expand to 12 workers and 65 total issues spanning all lanes (including 17 closed > closedShown 15 for OlderLink folding).
    for idx in 6..=12 {
        let sid = format!("w{idx}");
        let issue_id = format!("i-d{idx}");
        let mut s = worker(
            &sid,
            &format!("帮工{idx}"),
            if idx % 2 == 0 { "laozhou" } else { "xiaolin" },
            "claude",
            now - idx as i64 * MIN_MS,
        );
        s.issue = Some(issue_id);
        s.repo = Some("vibevalley".into());
        s.phase = if idx <= 9 {
            Phase::working(now - idx as i64 * MIN_MS, SessionAction::RunCommand, format!("cargo test module_{idx}"))
        } else {
            Phase::done()
        };
        if idx > 9 {
            s.last_run = Some(LastRun {
                needs_reconciliation: false,
                outcome: Outcome::Completed,
                summary: format!("模块 {idx} 测试通过。"),
                at: now - idx as i64 * MIN_MS,
                spent: Some(spent(20_000, 0.05)),
                answer: None,
            });
        }
        facts.push(Fact::SessionChanged(FactSessionChanged { at: now, session: s }));
    }

    for n in 100..154 {
        let iid = format!("i-d{n}");
        let p = match n % 4 {
            0 => Priority::Urgent,
            1 => Priority::High,
            2 => Priority::Medium,
            _ => Priority::Low,
        };
        let mut t = issue(&iid, n, &format!("高密度压测工单 #{n}：优化工作台渲染与帧同步"), p, now - n * 5 * MIN_MS);
        t.repo = Some("vibevalley".into());
        match n % 4 {
            0 => {
                // Closed (triggers OlderLink when > 5)
                t.delivered = Some(Landing::Merged);
                t.closed_at = Some(now - n * MIN_MS);
            }
            1 => {
                t.queued_at = Some(now - n * MIN_MS);
            }
            2 => {
                let sidx = 6 + ((n - 100) % 4);
                let sid = format!("w{sidx}");
                assign(&mut t, "laozhou", &sid, now - MIN_MS);
            }
            _ => {
                assign(&mut t, "xiaolin", "w10", now - 2 * MIN_MS);
            }
        }
        facts.push(Fact::IssueChanged(FactIssueChanged { at: now, issue: t }));
    }

    for n in 3..=10 {
        facts.push(Fact::CronChanged(FactCronChanged {
            at: now,
            cron: cron(
                &format!("c{n}"),
                &format!("定时巡检 #{n}"),
                CronWhen::Every(CronWhenEvery { minutes: (n as i64) * 15 }),
                n % 2 == 0,
                now - (n as i64) * HOUR_MS,
            ),
        }));
    }

    b.apply(facts);
}

fn build_extreme(b: &mut ScenarioBuilder) {
    build_typical(b);
    let now = b.now();
    let mut facts = Vec::new();

    facts.push(Fact::CallChanged(FactCallChanged {
        at: now,
        state: CallState::Error,
        reason: "语音连接连续三次握手超时，请检查网关地址与网络策略配置。".into(),
    }));

    // Conflict + urgent + long CJK/EN/URL title.
    let mut w_conf = worker("w-ext-1", "冲突排查者", "laozhou", "codex", now - 30 * MIN_MS);
    w_conf.issue = Some("i-ext-conflict".into());
    w_conf.repo = Some("vibevalley".into());
    w_conf.worktree = Some("/tmp/vibevalley/.worktrees/i-ext-conflict".into());
    w_conf.phase = Phase::done();
    w_conf.last_run = Some(LastRun {
        needs_reconciliation: false,
        outcome: Outcome::Completed,
        summary: "本地分支已改动 6 个文件，与 main 基线发生冲突。".into(),
        at: now - 4 * MIN_MS,
        spent: Some(spent(990_000, 3.85)),
        answer: None,
    });
    facts.push(Fact::SessionChanged(FactSessionChanged { at: now, session: w_conf }));

    let mut i_conf = issue("i-ext-conflict", 901, LONG_ZH, Priority::Urgent, now - 4 * HOUR_MS);
    i_conf.repo = Some("vibevalley".into());
    i_conf.description = format!("{LONG_EN}\n\n{LONG_ZH}");
    i_conf.conflict = Some(Conflict {
        base: "main".into(),
        files: vec![
            "crates/vibevalley-core/src/core.rs".into(),
            "apps/mac/ui/vv/web/features/issue/views/Board.tsx".into(),
        ],
    });
    i_conf.findings = vec![Finding {
        id: "f1".into(),
        text: "存在未解决的三方合并冲突标记".into(),
        at: now - 3 * MIN_MS,
        resolved: false,
    }];
    i_conf.delivery_evidence = Some(DeliveryEvidence {
        reviews: vec![],
        check: Some(ProjectCheckReceipt {
            target_branch: "main".into(),
            target_commit: "abc1234".into(),
            source_tree: "tree-src".into(),
            candidate_commit: "def5678".into(),
            candidate_tree: "tree-cand".into(),
            status: ProjectCheckStatus::Failed,
            command: Some("vp run rust:check".into()),
            output: Some("error[E0599]: method not found in `BoardCard`".into()),
        }),
        merged_commit: None,
    });
    assign(&mut i_conf, "laozhou", "w-ext-1", now - 30 * MIN_MS);
    facts.push(Fact::IssueChanged(FactIssueChanged { at: now, issue: i_conf }));

    let mut i_long_en = issue("i-ext-en", 902, LONG_EN, Priority::High, now - 2 * HOUR_MS);
    i_long_en.repo = Some("vibevalley".into());
    i_long_en.queued_at = Some(now - 2 * MIN_MS);
    facts.push(Fact::IssueChanged(FactIssueChanged { at: now, issue: i_long_en }));

    b.apply(facts);
}

fn build_edge(b: &mut ScenarioBuilder) -> StateFrame {
    let now = b.now();
    let mut facts = Vec::new();

    facts.push(Fact::CallChanged(FactCallChanged {
        at: now,
        state: CallState::Ending,
        reason: "正在结束语音会话".into(),
    }));

    facts.push(Fact::MachineChanged(FactMachineChanged {
        at: now,
        machine: Machine {
            id: "local".into(),
            name: "Mac Studio".into(),
            here: true,
            online: true,
            joined_at: now - 72 * HOUR_MS,
        },
    }));

    // Remaining connector states: Scanned, Verify, Pairing (with Off/Waiting/Connected/Paused in Typical/Dense).
    for st in [
        connector(ConnectorID::Weixin, ConnectorState::Scanned, Some("general"), None, 0, now - 5 * MIN_MS),
        connector(ConnectorID::Feishu, ConnectorState::Verify, Some("general"), None, 1, now - 4 * MIN_MS),
        connector(ConnectorID::Qq, ConnectorState::Pairing, None, None, 0, now - 3 * MIN_MS),
    ] {
        facts.push(Fact::ConnectorChanged(FactConnectorChanged { at: now, status: st }));
    }

    // 999+ unread across parent channel + thread + direct channel, plus user mention.
    let mut general = channel("general", ChannelType::Channel, true, Some("general"), "边角压测频道", now - MIN_MS);
    general.last_number = Some(1500);
    general.unread = Some(1248);
    general.last = Some(ChannelLast {
        from: "w-edge-pr".into(),
        name: "老周".into(),
        text: format!("检查失败 SHA={LONG_SHA}"),
        at: now - MIN_MS,
    });
    let mut thread = channel("t-edge-burst", ChannelType::Thread, false, None, "", now - 2 * MIN_MS);
    thread.parent = Some("general".into());
    thread.root_number = Some(1400);
    thread.replies = 37;
    thread.unread = Some(37);
    thread.subject_kind = Some(SubjectKind::Issue);
    thread.subject_id = Some("i-edge-pr-open".into());
    thread.title = "PR 校验失败排查".into();
    let mut dm = channel("dm-orch", ChannelType::Direct, false, Some("助手"), "", now - 3 * MIN_MS);
    dm.peer = Some(format!("profile:{DEFAULT_ORCHESTRATOR}"));
    dm.unread = Some(2);
    for c in [general, thread, dm] {
        facts.push(Fact::ChannelChanged(FactChannelChanged { at: now, channel: c }));
    }

    let mut mention_msg = message(
        "general",
        1500,
        Actor::Agent {
            id: "xiaolin".into(),
            role: AgentRole::Worker,
            name: Some("小林".into()),
            for_user: None,
        },
        MessageKind::Chat,
        &format!("@user 请查看 PR #4242 失败日志 {LONG_PR_URL}"),
        now - MIN_MS,
    );
    mention_msg.id = "m-edge-mention".into();
    mention_msg.from = "w-edge-ask".into();
    facts.push(Fact::UserMentionsChanged(FactUserMentionsChanged {
        at: now,
        mentions: vec![UserMention {
            message: mention_msg,
            channel: "general".into(),
            address: "#general".into(),
        }],
    }));

    // Pending cron triggers InboxKind::CronAsk.
    let mut pending_cron = cron(
        "c-edge-ask",
        "等待确认的发布巡检",
        CronWhen::Cron(CronWhenExpr { expr: "0 9 * * 1-5".into() }),
        true,
        now - 15 * MIN_MS,
    );
    pending_cron.pending = true;
    facts.push(Fact::CronChanged(FactCronChanged { at: now, cron: pending_cron }));

    // Media jobs covering all 8 MediaPhase::ALL plus an active understanding job (excluded by MediaSummary).
    facts.push(Fact::MediaChanged(FactMediaChanged {
        at: now,
        jobs: edge_media_jobs(now),
    }));

    // Standing orchestrator session + issue (exercises IssueCardKind::Orchestrator and verifies running_slots excludes orchestrators).
    let mut s_orch = Session::worker("orch-1", "助手", now - 2 * HOUR_MS);
    s_orch.role = AgentRole::Orchestrator;
    s_orch.agent = DEFAULT_ORCHESTRATOR.into();
    s_orch.runtime = ORCHESTRATOR_RUNTIME.into();
    s_orch.phase = Phase::working(now - MIN_MS, SessionAction::Search, "issue_list");
    s_orch.channel = Some("general".into());
    facts.push(Fact::SessionChanged(FactSessionChanged { at: now, session: s_orch }));

    let mut i_orch = issue("i-edge-orch", 810, "助手汇总本周期发布风险清单", Priority::Medium, now - 30 * MIN_MS);
    i_orch.deliver = Deliverable::Answer;
    i_orch.assignments.push(Assignment {
        id: "as-i-edge-orch".into(),
        issue: "i-edge-orch".into(),
        agent: DEFAULT_ORCHESTRATOR.into(),
        assigned_at: now - 20 * MIN_MS,
        ended_at: None,
        executions: vec![Execution::Orchestrator {
            session: "orch-1".into(),
            started_at: now - 20 * MIN_MS,
        }],
    });
    i_orch.last_run = Some(IssueLastRun {
        started_at: now - 20 * MIN_MS,
        ended_at: None,
        outcome: None,
    });
    facts.push(Fact::IssueChanged(FactIssueChanged { at: now, issue: i_orch }));

    // 1. Asking -> IssuePromptKind::Asking + InboxKind::Ask
    let mut w_ask = worker("w-edge-ask", "小林", "xiaolin", "claude", now - 45 * MIN_MS);
    w_ask.issue = Some("i-edge-ask".into());
    w_ask.repo = Some("vibevalley".into());
    w_ask.phase = Phase::resting();
    w_ask.last_run = Some(LastRun {
        needs_reconciliation: false,
        outcome: Outcome::Completed,
        summary: "需要确认回滚策略。".into(),
        at: now - 10 * MIN_MS,
        spent: Some(spent(50_000, 0.12)),
        answer: None,
    });
    let mut i_ask = issue("i-edge-ask", 811, "确认生产数据库回滚窗口", Priority::High, now - 50 * MIN_MS);
    i_ask.repo = Some("vibevalley".into());
    i_ask.questions = vec![Question {
        question: "是否在凌晨 02:00 窗口执行迁移回滚？".into(),
        options: vec!["是，按窗口执行".into(), "否，立即热修".into()],
    }];
    assign(&mut i_ask, "xiaolin", "w-edge-ask", now - 45 * MIN_MS);

    // 2. Open PR + failed check + huge ¥1,234.56 spent + long unbroken SHA/URL -> ReviewAfterFailedCheck + Deliverable::PullRequest
    let mut w_pr = worker("w-edge-pr", "老周", "laozhou", "codex", now - 3 * HOUR_MS);
    w_pr.issue = Some("i-edge-pr-open".into());
    w_pr.repo = Some("vibevalley".into());
    w_pr.branch = Some("issue-812-pr-check".into());
    w_pr.worktree = Some("/tmp/vibevalley/.worktrees/i-edge-pr-open".into());
    w_pr.runs = 7;
    w_pr.phase = Phase::done();
    w_pr.spent = Some(spent(48_500_000, 1234.56));
    w_pr.last_run = Some(LastRun {
        needs_reconciliation: false,
        outcome: Outcome::Completed,
        summary: format!("PR #4242 远端检查未通过，提交 {LONG_SHA}"),
        at: now - 6 * MIN_MS,
        spent: Some(spent(48_500_000, 1234.56)),
        answer: None,
    });
    let mut i_pr = issue(
        "i-edge-pr-open",
        812,
        &format!("PR 校验失败与超长链接截断验证 {LONG_PR_URL}"),
        Priority::Urgent,
        now - 4 * HOUR_MS,
    );
    i_pr.repo = Some("vibevalley".into());
    i_pr.description = format!("Commit SHA: {LONG_SHA}\nURL: {LONG_PR_URL}\n{LONG_EN}");
    i_pr.deliver = Deliverable::PullRequest;
    i_pr.pull_request = Some(PullRequest {
        url: LONG_PR_URL.into(),
        number: 4242,
        state: PullRequestState::Open,
    });
    i_pr.delivery_evidence = Some(DeliveryEvidence {
        reviews: vec![],
        check: Some(ProjectCheckReceipt {
            target_branch: "main".into(),
            target_commit: LONG_SHA.into(),
            source_tree: "abcdef0123456789abcdef0123456789abcdef01".into(),
            candidate_commit: "fedcba9876543210fedcba9876543210fedcba98".into(),
            candidate_tree: "9876543210fedcba9876543210fedcba98765432".into(),
            status: ProjectCheckStatus::Failed,
            command: Some("vp run release:verify".into()),
            output: Some("FAIL pr-check: clippy warning in crates/vibevalley-core/src/scenario.rs".into()),
        }),
        merged_commit: None,
    });
    assign(&mut i_pr, "laozhou", "w-edge-pr", now - 3 * HOUR_MS);

    // 3. Reviewed + Deliverable::Branch -> IssuePromptKind::Reviewed
    let mut w_rev = worker("w-edge-rev", "老周", "laozhou", "claude", now - 90 * MIN_MS);
    w_rev.issue = Some("i-edge-reviewed".into());
    w_rev.repo = Some("vibevalley".into());
    w_rev.phase = Phase::done();
    w_rev.last_run = Some(LastRun {
        needs_reconciliation: false,
        outcome: Outcome::Completed,
        summary: "分支代码已复审通过，待交付。".into(),
        at: now - 9 * MIN_MS,
        spent: Some(spent(91_000, 0.21)),
        answer: None,
    });
    let mut i_rev = issue("i-edge-reviewed", 813, "已复审的分支交付工单", Priority::Medium, now - 2 * HOUR_MS);
    i_rev.repo = Some("vibevalley".into());
    i_rev.deliver = Deliverable::Branch;
    i_rev.reviewed_at = Some(now - 8 * MIN_MS);
    assign(&mut i_rev, "laozhou", "w-edge-rev", now - 90 * MIN_MS);

    // 4. HandedBack + Deliverable::Answer -> IssuePromptKind::HandedBack
    let answer = IssueAnswer {
        conclusion: "状态帧投影下沉 Rust 后宽窄屏计数完全一致。".into(),
        evidence: vec!["crates/vibevalley-core/src/status.rs".into()],
        unsure: vec![],
        next: vec![],
    };
    let mut w_hand = worker("w-edge-hand", "小林", "xiaolin", "claude", now - 70 * MIN_MS);
    w_hand.issue = Some("i-edge-handed".into());
    w_hand.repo = Some("vibevalley".into());
    w_hand.phase = Phase::done();
    w_hand.last_run = Some(LastRun {
        needs_reconciliation: false,
        outcome: Outcome::Completed,
        summary: "已给出结论与证据，请验收。".into(),
        at: now - 11 * MIN_MS,
        spent: Some(spent(60_000, 0.15)),
        answer: Some(answer.clone()),
    });
    let mut i_hand = issue("i-edge-handed", 814, "核查宽窄屏看板计数偏差原因", Priority::Low, now - 80 * MIN_MS);
    i_hand.repo = Some("vibevalley".into());
    i_hand.deliver = Deliverable::Answer;
    i_hand.answer = Some(answer);
    assign(&mut i_hand, "xiaolin", "w-edge-hand", now - 70 * MIN_MS);

    // 5. StuckConflict -> StuckReason::Conflict + IssuePromptKind::StuckConflict + InboxKind::Conflict
    let mut w_conf = worker("w-edge-conf", "阿杰", "ajie", "codex", now - 60 * MIN_MS);
    w_conf.issue = Some("i-edge-conflict".into());
    w_conf.repo = Some("vibevalley".into());
    w_conf.phase = Phase::done();
    w_conf.last_run = Some(LastRun {
        needs_reconciliation: false,
        outcome: Outcome::Completed,
        summary: "与主干分支发生三方合并冲突。".into(),
        at: now - 12 * MIN_MS,
        spent: Some(spent(72_000, 0.18)),
        answer: None,
    });
    let mut i_conf = issue("i-edge-conflict", 815, "合并冲突阻塞交付", Priority::Urgent, now - 65 * MIN_MS);
    i_conf.repo = Some("vibevalley".into());
    i_conf.conflict = Some(Conflict {
        base: "main".into(),
        files: vec!["crates/vibevalley-core/src/core.rs".into(), "packages/protocol/src/core/schema.ts".into()],
    });
    assign(&mut i_conf, "ajie", "w-edge-conf", now - 60 * MIN_MS);

    // 6. StuckFailed -> StuckReason::Failed + IssuePromptKind::StuckFailed + InboxKind::Fix
    let mut w_fail = worker("w-edge-fail", "阿杰", "ajie", "claude", now - 55 * MIN_MS);
    w_fail.issue = Some("i-edge-failed".into());
    w_fail.repo = Some("vibevalley".into());
    w_fail.phase = Phase::failed();
    w_fail.last_run = Some(LastRun {
        needs_reconciliation: false,
        outcome: Outcome::Failed,
        summary: "构建命令返回非零退出码。".into(),
        at: now - 13 * MIN_MS,
        spent: Some(spent(40_000, 0.09)),
        answer: None,
    });
    let mut i_fail = issue("i-edge-failed", 816, "失败重跑恢复链路", Priority::High, now - 60 * MIN_MS);
    i_fail.repo = Some("vibevalley".into());
    assign(&mut i_fail, "ajie", "w-edge-fail", now - 55 * MIN_MS);

    // 7. StuckInterrupted + needs_reconciliation -> StuckReason::Interrupted + IssuePromptKind::StuckInterrupted + needs_worktree_check + InboxKind::Interrupted
    let mut w_int = worker("w-edge-int", "老周", "laozhou", "claude", now - 50 * MIN_MS);
    w_int.issue = Some("i-edge-interrupted".into());
    w_int.repo = Some("vibevalley".into());
    w_int.worktree = Some("/tmp/vibevalley/.worktrees/i-edge-interrupted".into());
    w_int.phase = Phase::resting();
    w_int.last_run = Some(LastRun {
        needs_reconciliation: true,
        outcome: Outcome::Interrupted,
        summary: "进程意外中断，worktree 存在未提交改动需核对。".into(),
        at: now - 14 * MIN_MS,
        spent: Some(spent(88_000, 0.19)),
        answer: None,
    });
    let mut i_int = issue("i-edge-interrupted", 817, "中断后需核对工作区改动", Priority::High, now - 55 * MIN_MS);
    i_int.repo = Some("vibevalley".into());
    assign(&mut i_int, "laozhou", "w-edge-int", now - 50 * MIN_MS);

    // 8. StuckQuiet -> StuckReason::Quiet + IssuePromptKind::StuckQuiet + InboxKind::Quiet
    let mut w_quiet = worker("w-edge-quiet", "小林", "xiaolin", "codex", now - 40 * MIN_MS);
    w_quiet.issue = Some("i-edge-quiet".into());
    w_quiet.repo = Some("vibevalley".into());
    w_quiet.phase = Phase::Working(PhaseWorking {
        since: now - 35 * MIN_MS,
        quiet_since: Some(now - 25 * MIN_MS),
        retry: None,
        doing: Doing {
            action: SessionAction::RunCommand,
            label: "cargo test --workspace".into(),
        },
    });
    let mut i_quiet = issue("i-edge-quiet", 818, "静默超时阻塞中的长命令", Priority::Medium, now - 45 * MIN_MS);
    i_quiet.repo = Some("vibevalley".into());
    assign(&mut i_quiet, "xiaolin", "w-edge-quiet", now - 40 * MIN_MS);

    // 9. Defensive StuckUnknown issue (stage.stuck cleared right before frame_of)
    let mut w_unk = worker("w-edge-unk", "阿杰", "ajie", "claude", now - 38 * MIN_MS);
    w_unk.issue = Some("i-edge-stuck-unknown".into());
    w_unk.repo = Some("vibevalley".into());
    w_unk.phase = Phase::failed();
    w_unk.last_run = Some(LastRun {
        needs_reconciliation: false,
        outcome: Outcome::Failed,
        summary: "未知卡住原因兜底测试。".into(),
        at: now - 15 * MIN_MS,
        spent: None,
        answer: None,
    });
    let mut i_unk = issue("i-edge-stuck-unknown", 819, "未知阻塞原因兼容展示", Priority::Low, now - 42 * MIN_MS);
    i_unk.repo = Some("vibevalley".into());
    assign(&mut i_unk, "ajie", "w-edge-unk", now - 38 * MIN_MS);

    // 10. Deep 1-parent-6-child family with chained blocked_by dependencies + Landing::MergedIntoParent
    let mut i_fam = issue("i-edge-family", 800, "深层拆单家族：状态机投影与端到端收口", Priority::High, now - 6 * HOUR_MS);
    i_fam.repo = Some("vibevalley".into());

    let mut f1 = issue("i-edge-fam-1", 801, "子工单 1：协议枚举定义", Priority::High, now - 5 * HOUR_MS);
    f1.parent = Some("i-edge-family".into());
    f1.repo = Some("vibevalley".into());
    f1.delivered = Some(Landing::MergedIntoParent);
    f1.closed_at = Some(now - 4 * HOUR_MS);

    let mut f2 = issue("i-edge-fam-2", 802, "子工单 2：核心折叠汇总", Priority::High, now - 5 * HOUR_MS + MIN_MS);
    f2.parent = Some("i-edge-family".into());
    f2.blocked_by = vec!["i-edge-fam-1".into()];
    f2.repo = Some("vibevalley".into());
    f2.delivered = Some(Landing::MergedIntoParent);
    f2.closed_at = Some(now - 3 * HOUR_MS);

    let mut f3 = issue("i-edge-fam-3", 803, "子工单 3：淘汰冗余分支", Priority::Low, now - 5 * HOUR_MS + 2 * MIN_MS);
    f3.parent = Some("i-edge-family".into());
    f3.blocked_by = vec!["i-edge-fam-2".into()];
    f3.repo = Some("vibevalley".into());
    f3.canceled = Some(IssueCanceled::Dismissed);
    f3.closed_at = Some(now - 2 * HOUR_MS);

    let mut w_fam4 = worker("w-edge-fam4", "老周", "laozhou", "codex", now - 20 * MIN_MS);
    w_fam4.issue = Some("i-edge-fam-4".into());
    w_fam4.repo = Some("vibevalley".into());
    w_fam4.phase = Phase::working(now - 10 * MIN_MS, SessionAction::EditFile, "status.rs");

    let mut f4 = issue("i-edge-fam-4", 804, "子工单 4：面板计数统一", Priority::High, now - 5 * HOUR_MS + 3 * MIN_MS);
    f4.parent = Some("i-edge-family".into());
    f4.blocked_by = vec!["i-edge-fam-2".into(), "i-edge-fam-3".into()];
    f4.repo = Some("vibevalley".into());
    assign(&mut f4, "laozhou", "w-edge-fam4", now - 20 * MIN_MS);

    let mut f5 = issue("i-edge-fam-5", 805, "子工单 5：导出边角夹具", Priority::Medium, now - 5 * HOUR_MS + 4 * MIN_MS);
    f5.parent = Some("i-edge-family".into());
    f5.blocked_by = vec!["i-edge-fam-4".into()];
    f5.repo = Some("vibevalley".into());
    f5.queued_at = Some(now - 18 * MIN_MS);

    let mut f6 = issue(
        "i-edge-fam-6",
        806,
        "子工单 6：端到端验收回归",
        Priority::Medium,
        now - 5 * HOUR_MS + 5 * MIN_MS,
    );
    f6.parent = Some("i-edge-family".into());
    f6.blocked_by = vec!["i-edge-fam-4".into(), "i-edge-fam-5".into()];
    f6.repo = Some("vibevalley".into());

    // 11. Closed issues covering all remaining Landing::ALL + PullRequestState::{Merged, Closed} + CanceledReopenable
    let mut i_merged = issue("i-edge-land-merged", 820, "合并交付完成", Priority::Medium, now - 10 * HOUR_MS);
    i_merged.repo = Some("vibevalley".into());
    i_merged.delivered = Some(Landing::Merged);
    i_merged.closed_at = Some(now - 9 * HOUR_MS);

    let mut i_land_pr = issue("i-edge-land-pr", 821, "PR 已合并交付", Priority::Medium, now - 11 * HOUR_MS);
    i_land_pr.repo = Some("vibevalley".into());
    i_land_pr.deliver = Deliverable::PullRequest;
    i_land_pr.pull_request = Some(PullRequest {
        url: "https://github.com/vibevalley/vibevalley/pull/4201".into(),
        number: 4201,
        state: PullRequestState::Merged,
    });
    i_land_pr.delivered = Some(Landing::PullRequest);
    i_land_pr.closed_at = Some(now - 8 * HOUR_MS);

    let mut i_land_sub = issue("i-edge-land-submitted", 822, "分支已提交交付", Priority::Low, now - 12 * HOUR_MS);
    i_land_sub.repo = Some("vibevalley".into());
    i_land_sub.deliver = Deliverable::Branch;
    i_land_sub.delivered = Some(Landing::Submitted);
    i_land_sub.closed_at = Some(now - 7 * HOUR_MS);

    let mut i_land_kept = issue("i-edge-land-kept", 823, "保留本地分支交付", Priority::Low, now - 13 * HOUR_MS);
    i_land_kept.repo = Some("vibevalley".into());
    i_land_kept.delivered = Some(Landing::Kept);
    i_land_kept.closed_at = Some(now - 6 * HOUR_MS);

    let mut i_land_none = issue("i-edge-land-none", 824, "纯问答结论已确认", Priority::Low, now - 14 * HOUR_MS);
    i_land_none.deliver = Deliverable::Answer;
    i_land_none.delivered = Some(Landing::None);
    i_land_none.closed_at = Some(now - 5 * HOUR_MS);

    let mut i_canceled = issue("i-edge-canceled", 825, "已关闭 PR 且可重开工单", Priority::Low, now - 15 * HOUR_MS);
    i_canceled.repo = Some("vibevalley".into());
    i_canceled.deliver = Deliverable::PullRequest;
    i_canceled.pull_request = Some(PullRequest {
        url: "https://github.com/vibevalley/vibevalley/pull/4199".into(),
        number: 4199,
        state: PullRequestState::Closed,
    });
    i_canceled.canceled = Some(IssueCanceled::Lost);
    i_canceled.closed_at = Some(now - 4 * HOUR_MS);

    let i_draft = issue("i-edge-draft", 826, "待排期草稿工单", Priority::Low, now - 3 * MIN_MS);

    for s in [w_ask, w_pr, w_rev, w_hand, w_conf, w_fail, w_int, w_quiet, w_unk, w_fam4] {
        facts.push(Fact::SessionChanged(FactSessionChanged { at: now, session: s }));
    }
    for item in [
        i_ask,
        i_pr,
        i_rev,
        i_hand,
        i_conf,
        i_fail,
        i_int,
        i_quiet,
        i_unk,
        i_fam,
        f1,
        f2,
        f3,
        f4,
        f5,
        f6,
        i_merged,
        i_land_pr,
        i_land_sub,
        i_land_kept,
        i_land_none,
        i_canceled,
        i_draft,
    ] {
        facts.push(Fact::IssueChanged(FactIssueChanged { at: now, issue: item }));
    }

    b.apply(facts);

    // Exercise the defensive wire case where a stuck stage carries no stuck reason (IssuePromptKind::StuckUnknown).
    let mut state = b.core.state().clone();
    if let Some(unknown) = state.issues.iter_mut().find(|i| i.id == "i-edge-stuck-unknown") {
        unknown.stage.state = IssueStageKind::Stuck;
        unknown.stage.stuck = None;
    }
    crate::frame_of(&state, b.effects.clone(), b.core.seq())
}

fn edge_image_job(id: &str, phase: MediaPhase, problem: &str, now: Millis) -> MediaJob {
    MediaJob::MediaImageJob(MediaImageJob {
        kind: MediaImageJobKind::Image,
        id: id.into(),
        prompt: format!("边角媒体任务 ({})", phase.as_str()),
        model: "moss-image-1".into(),
        connection: "moss-main".into(),
        revision: 1,
        source: MediaSource::User {},
        usage: (phase == MediaPhase::Ready).then_some(MediaImageUsage {
            images: 1,
            width: 1024,
            height: 1024,
        }),
        phase,
        phase_text: phase.as_str().into(),
        problem: problem.into(),
        attachment: (phase == MediaPhase::Ready).then(|| Attachment {
            id: "lib-edge-img".into(),
            name: "edge-poster.png".into(),
            r#type: "image/png".into(),
            size: 256_000,
        }),
        can_cancel: matches!(phase, MediaPhase::Queued | MediaPhase::Generating | MediaPhase::Downloading),
        can_retry_download: phase == MediaPhase::DownloadFailed,
        created_at: now - 10 * MIN_MS,
        updated_at: now - MIN_MS,
    })
}

fn edge_speech_job(id: &str, phase: MediaPhase, problem: &str, now: Millis) -> MediaJob {
    MediaJob::MediaSpeechJob(MediaSpeechJob {
        kind: MediaSpeechJobKind::Speech,
        id: id.into(),
        prompt: format!("边角语音任务 ({})", phase.as_str()),
        model: "moss-tts-1.5-flash".into(),
        connection: "moss-main".into(),
        revision: 1,
        source: MediaSource::Orchestrator {
            agent: DEFAULT_ORCHESTRATOR.into(),
            channel: "general".into(),
        },
        voice: "voice-warm".into(),
        format: MediaAudioFormat::Wav,
        content_type: Some("audio/wav".into()),
        metadata: None,
        usage: None,
        can_resume: Some(false),
        can_release: phase == MediaPhase::Ready,
        phase,
        phase_text: phase.as_str().into(),
        problem: problem.into(),
        attachment: None,
        result_input: None,
        can_cancel: matches!(phase, MediaPhase::Queued | MediaPhase::Generating | MediaPhase::Downloading),
        can_retry_download: phase == MediaPhase::DownloadFailed,
        created_at: now - 8 * MIN_MS,
        updated_at: now - MIN_MS,
    })
}

fn edge_media_jobs(now: Millis) -> Vec<MediaJob> {
    vec![
        edge_image_job("job-edge-queued", MediaPhase::Queued, "", now),
        edge_image_job("job-edge-generating", MediaPhase::Generating, "", now),
        edge_speech_job("job-edge-downloading", MediaPhase::Downloading, "", now),
        edge_image_job("job-edge-ready", MediaPhase::Ready, "", now),
        edge_image_job("job-edge-failed", MediaPhase::Failed, "provider quota exceeded", now),
        edge_speech_job("job-edge-unknown", MediaPhase::Unknown, "remote poll timed out", now),
        edge_image_job("job-edge-canceled", MediaPhase::Canceled, "", now),
        edge_speech_job("job-edge-dl-failed", MediaPhase::DownloadFailed, "connection reset while saving audio", now),
        MediaJob::MediaUnderstandingJob(MediaUnderstandingJob {
            kind: MediaUnderstandingJobKind::Understanding,
            id: "job-edge-understanding".into(),
            prompt: "分析这段录屏中的状态帧异常".into(),
            inputs: vec![MediaInputReference {
                id: "in-edge-1".into(),
                kind: MediaInputKind::Image,
                name: "edge-trace.png".into(),
                mime: "image/png".into(),
                size: 120_000,
                hash: LONG_SHA.into(),
            }],
            model: "moss-vision-1".into(),
            connection: "moss-main".into(),
            revision: 1,
            source: MediaSource::User {},
            authorization: None,
            phase: MediaUnderstandingPhase::Generating,
            phase_text: "generating".into(),
            problem: String::new(),
            result: None,
            cleanup: MediaCleanup::Pending,
            cleanup_text: String::new(),
            can_cancel: true,
            can_cleanup: false,
            can_retry_download: LitFalse,
            created_at: now - 2 * MIN_MS,
            updated_at: now - MIN_MS,
        }),
    ]
}

fn spent(tokens: i64, cny: f64) -> Spent {
    Spent {
        tokens,
        cny: Some(JsNumber::from(cny)),
    }
}

fn issue(id: &str, number: i64, title: &str, priority: Priority, created_at: Millis) -> Issue {
    let mut t = Issue::new(id, number, title, created_at);
    t.priority = priority;
    t
}

fn worker(id: &str, name: &str, agent: &str, runtime: &str, hired_at: Millis) -> Session {
    let mut s = Session::worker(id, name, hired_at);
    s.agent = agent.into();
    s.runtime = runtime.into();
    s.runs = 1;
    s
}

fn assign(t: &mut Issue, agent: &str, session: &str, at: Millis) {
    t.assignments.push(Assignment {
        id: format!("as-{}", t.id),
        issue: t.id.clone(),
        agent: agent.into(),
        assigned_at: at,
        ended_at: None,
        executions: vec![Execution::Worker {
            session: session.into(),
            started_at: at,
        }],
    });
    t.queued_at = Some(at);
}

fn assign_pending(t: &mut Issue, agent: &str, at: Millis) {
    t.assignments.push(Assignment {
        id: format!("as-{}", t.id),
        issue: t.id.clone(),
        agent: agent.into(),
        assigned_at: at,
        ended_at: None,
        executions: vec![],
    });
}

fn channel(id: &str, r#type: ChannelType, default: bool, name: Option<&str>, description: &str, at: Millis) -> Channel {
    Channel {
        id: id.into(),
        r#type,
        default,
        peer: None,
        orchestrator: Some("orchestrator".into()),
        members: None,
        parent: None,
        category: String::new(),
        position: Some(1),
        archived: None,
        notify: Notify::All,
        root: None,
        root_number: None,
        name: name.map(str::to_string),
        description: description.into(),
        repo: None,
        subject_kind: None,
        subject_id: None,
        last_number: None,
        replies: 0,
        read: None,
        unread: None,
        title: name.unwrap_or(id).into(),
        last: None,
        at,
    }
}

fn message(channel: &str, number: i64, actor: Actor, kind: MessageKind, text: &str, at: Millis) -> ChatMessage {
    let (from, name) = match &actor {
        Actor::User { id, name } | Actor::Agent { id, name, .. } | Actor::System { id, name } => (id.clone(), name.clone().unwrap_or_else(|| id.clone())),
    };
    ChatMessage {
        id: format!("m-{channel}-{number}"),
        number,
        channel: channel.into(),
        from,
        actor,
        name,
        agent: None,
        kind,
        text: text.into(),
        mentions: vec![],
        session: None,
        run: None,
        outcome: None,
        spent: None,
        spoken: false,
        send_key: None,
        at,
        revision: 1,
        reply_to: None,
        edited: None,
        deleted: None,
        pinned: None,
        reactions: vec![],
        attachments: vec![],
        embeds: vec![],
        artifact: None,
        blocks: None,
        view_context: None,
    }
}

fn cron(id: &str, name: &str, when: CronWhen, enabled: bool, created: Millis) -> Cron {
    Cron {
        id: id.into(),
        name: name.into(),
        text: format!("巡检：{name}"),
        channel: "general".into(),
        agent: Some("orchestrator".into()),
        repo: Some("vibevalley".into()),
        when,
        tz: "Asia/Shanghai".into(),
        enabled,
        created,
        last_run: Some(created + HOUR_MS),
        by: ActorKind::User,
        pending: false,
    }
}

fn connector(id: ConnectorID, state: ConnectorState, channel: Option<&str>, user: Option<&str>, pending: i64, since: Millis) -> ConnectorStatus {
    ConnectorStatus {
        id,
        state,
        qr: String::new(),
        pair_code: String::new(),
        channel: channel.map(str::to_string),
        user: user.map(str::to_string),
        since: Some(since),
        last_inbound: Some(since + MIN_MS),
        paused_until: if state == ConnectorState::Paused { Some(since + HOUR_MS) } else { None },
        pending,
        error: String::new(),
    }
}

fn default_media_jobs(now: Millis) -> Vec<MediaJob> {
    vec![
        MediaJob::MediaImageJob(MediaImageJob {
            kind: MediaImageJobKind::Image,
            id: "job-img-ready".into(),
            prompt: "像素风麦田与小木屋".into(),
            model: "moss-image-1".into(),
            connection: "moss-main".into(),
            revision: 1,
            source: MediaSource::User {},
            usage: Some(MediaImageUsage {
                images: 1,
                width: 1024,
                height: 1024,
            }),
            phase: MediaPhase::Ready,
            phase_text: "已生成".into(),
            problem: String::new(),
            attachment: Some(Attachment {
                id: "lib-poster".into(),
                name: "farm-poster.png".into(),
                r#type: "image/png".into(),
                size: 482_113,
            }),
            can_cancel: false,
            can_retry_download: false,
            created_at: now - 30 * MIN_MS,
            updated_at: now - 29 * MIN_MS,
        }),
        MediaJob::MediaSpeechJob(MediaSpeechJob {
            kind: MediaSpeechJobKind::Speech,
            id: "job-speech-ready".into(),
            prompt: "今天的回归测试全部通过。".into(),
            model: "moss-tts-1.5-flash".into(),
            connection: "moss-main".into(),
            revision: 1,
            source: MediaSource::Orchestrator {
                agent: "orchestrator".into(),
                channel: "general".into(),
            },
            voice: "voice-warm".into(),
            format: MediaAudioFormat::Wav,
            content_type: Some("audio/wav".into()),
            metadata: None,
            usage: Some(MediaAudioUsage {
                input_characters: Some(12),
                prompt_tokens: None,
                completion_tokens: None,
                total_tokens: None,
                input_audio_seconds: None,
            }),
            can_resume: Some(false),
            can_release: true,
            phase: MediaPhase::Ready,
            phase_text: "已生成".into(),
            problem: String::new(),
            attachment: Some(Attachment {
                id: "lib-speech".into(),
                name: "speech.wav".into(),
                r#type: "audio/wav".into(),
                size: 115_244,
            }),
            result_input: None,
            can_cancel: false,
            can_retry_download: false,
            created_at: now - 20 * MIN_MS,
            updated_at: now - 19 * MIN_MS,
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn all_densities_roundtrip_and_cover_contract_space() {
        let mut statuses = HashSet::new();
        let mut priorities = HashSet::new();
        let mut phases = HashSet::new();
        let mut calls = HashSet::new();
        let mut saw_inbox = false;
        let mut saw_plots = false;
        let mut saw_crons = false;
        let mut saw_connectors = false;
        let mut saw_media = false;
        let mut saw_chat = false;
        let mut saw_blocked = false;
        let mut saw_family = false;
        let mut saw_subagents = false;
        let mut saw_tools = false;

        for d in Density::ALL {
            let frame = preset(d);
            let json = serde_json::to_string(&frame).unwrap();
            let decoded: StateFrame = serde_json::from_str(&json).unwrap();
            assert_eq!(decoded, frame, "roundtrip mismatch for {:?}", d);
            assert!(frame.seq > 0, "density {:?} did not apply facts cleanly", d);

            calls.insert(frame.state.call.as_str());
            for item in &frame.state.issues {
                statuses.insert(item.status.as_str());
                priorities.insert(item.priority.as_str());
                if !item.blocked_by.is_empty() {
                    saw_blocked = true;
                }
                if item.parent.is_some() {
                    saw_family = true;
                }
            }
            for s in &frame.state.sessions {
                let tag = match s.phase {
                    PhaseView::Working(_) => "working",
                    PhaseView::Resting(_) => "resting",
                    PhaseView::Done(_) => "done",
                    PhaseView::Failed(_) => "failed",
                    PhaseView::Closed(_) => "closed",
                };
                phases.insert(tag);
                if s.subagents.is_some() {
                    saw_subagents = true;
                }
                if s.tool_connections.as_ref().is_some_and(|v| !v.is_empty()) {
                    saw_tools = true;
                }
            }
            saw_inbox |= !frame.inbox.is_empty();
            saw_plots |= !frame.view.plots.is_empty();
            saw_crons |= !frame.state.crons.is_empty();
            saw_connectors |= !frame.state.connectors.is_empty();
            saw_media |= frame.state.media.as_ref().is_some_and(|m| !m.is_empty());
            saw_chat |= frame.state.chat.as_ref().is_some_and(|c| !c.channels.is_empty());
        }

        for status in IssueStatus::ALL {
            assert!(statuses.contains(status.as_str()), "missing status {}", status.as_str());
        }
        for pr in Priority::ALL {
            assert!(priorities.contains(pr.as_str()), "missing priority {}", pr.as_str());
        }
        for ph in ["working", "resting", "done", "failed"] {
            assert!(phases.contains(ph), "missing phase {ph}");
        }
        for cs in ["idle", "live", "error"] {
            assert!(calls.contains(cs), "missing call state {cs}");
        }
        assert!(saw_inbox, "expected non-empty inbox");
        assert!(saw_plots, "expected non-empty farm plots");
        assert!(saw_crons, "expected non-empty crons");
        assert!(saw_connectors, "expected non-empty connectors");
        assert!(saw_media, "expected non-empty media jobs");
        assert!(saw_chat, "expected non-empty chat");
        assert!(saw_blocked, "expected blocked_by dependency");
        assert!(saw_family, "expected parent/child family");
        assert!(saw_subagents, "expected subagents on session");
        assert!(saw_tools, "expected tool_connections on session");

        // Dense guarantees >= 60 issues including >15 closed for OlderLink coverage.
        let dense = preset(Density::Dense);
        assert!(dense.state.issues.len() >= 60);
        assert!(dense.state.issues.iter().filter(|i| i.status.is_closed()).count() > 15);
    }

    #[test]
    fn scenarios_enforce_exhaustive_protocol_enum_and_edge_coverage() {
        let mut stuck_reasons = HashSet::new();
        let mut deliverables = HashSet::new();
        let mut pr_states = HashSet::new();
        let mut landings = HashSet::new();
        let mut media_phases = HashSet::new();
        let mut connector_states = HashSet::new();
        let mut call_states = HashSet::new();
        let mut inbox_kinds = HashSet::new();
        let mut lanes = HashSet::new();
        let mut card_kinds = HashSet::new();
        let mut prompt_kinds = HashSet::new();

        let mut saw_needs_reconciliation = false;
        let mut saw_worktree_check = false;
        let mut saw_999_unread = false;
        let mut saw_deep_family = false;
        let mut saw_huge_spent = false;
        let mut saw_long_sha = false;
        let mut saw_failed_pr_check = false;

        for density in Density::ALL {
            let frame = preset(density);
            call_states.insert(frame.state.call);

            for conn in &frame.state.connectors {
                connector_states.insert(conn.state);
            }
            for item in &frame.inbox {
                inbox_kinds.insert(item.kind);
            }
            if let Some(jobs) = &frame.state.media {
                for job in jobs {
                    match job {
                        MediaJob::MediaImageJob(j) => {
                            media_phases.insert(j.phase);
                        }
                        MediaJob::MediaSpeechJob(j) => {
                            media_phases.insert(j.phase);
                        }
                        MediaJob::MediaAudioJob(j) => {
                            let phase = match j {
                                MediaAudioJob::Speakers { phase, .. }
                                | MediaAudioJob::VoiceDesign { phase, .. }
                                | MediaAudioJob::Clone { phase, .. }
                                | MediaAudioJob::Transcription { phase, .. } => *phase,
                            };
                            media_phases.insert(phase);
                        }
                        MediaJob::MediaUnderstandingJob(_) => {}
                    }
                }
            }
            for s in &frame.state.sessions {
                if s.last_run.as_ref().is_some_and(|r| r.needs_reconciliation) {
                    saw_needs_reconciliation = true;
                }
                if s.spent.as_ref().and_then(|sp| sp.cny).is_some_and(|cny| cny.get() >= 1234.56) {
                    saw_huge_spent = true;
                }
            }
            for item in &frame.state.issues {
                deliverables.insert(item.deliver);
                if let Some(reason) = item.stage.stuck {
                    stuck_reasons.insert(reason);
                }
                if let Some(pr) = &item.pull_request {
                    pr_states.insert(pr.state);
                    if item
                        .delivery_evidence
                        .as_ref()
                        .and_then(|e| e.check.as_ref())
                        .is_some_and(|c| c.status == ProjectCheckStatus::Failed)
                    {
                        saw_failed_pr_check = true;
                    }
                }
                if let Some(landing) = item.delivered {
                    landings.insert(landing);
                }
                if item.description.contains(LONG_SHA) && item.title.contains(LONG_PR_URL) {
                    saw_long_sha = true;
                }
            }

            let board = frame.state.board_summary.as_ref().expect("board_summary populated");
            assert_eq!(board.max_running, MAX_RUNNING as i64);
            assert_eq!(
                board.lane_counts.todo + board.lane_counts.working + board.lane_counts.waiting + board.lane_counts.closed,
                frame.state.issues.len() as i64,
                "lane_counts must equal issue count for {:?}",
                density
            );
            assert_eq!(board.by_issue.len(), frame.state.issues.len());
            for summary in board.by_issue.values() {
                lanes.insert(summary.lane);
                card_kinds.insert(summary.card_kind);
                if let Some(prompt) = summary.prompt {
                    prompt_kinds.insert(prompt);
                }
                if summary.needs_worktree_check {
                    saw_worktree_check = true;
                }
                if summary.family_total >= 6 {
                    saw_deep_family = true;
                }
            }

            let channel_summary = frame.state.channel_summary.as_ref().expect("channel_summary populated");
            if channel_summary.unread_total >= 999 {
                saw_999_unread = true;
            }
        }

        for r in StuckReason::ALL {
            assert!(stuck_reasons.contains(&r), "missing StuckReason::{}", r.as_str());
        }
        for d in Deliverable::ALL {
            assert!(deliverables.contains(&d), "missing Deliverable::{}", d.as_str());
        }
        for p in PullRequestState::ALL {
            assert!(pr_states.contains(&p), "missing PullRequestState::{}", p.as_str());
        }
        for l in Landing::ALL {
            assert!(landings.contains(&l), "missing Landing::{}", l.as_str());
        }
        for m in MediaPhase::ALL {
            assert!(media_phases.contains(&m), "missing MediaPhase::{}", m.as_str());
        }
        for c in ConnectorState::ALL {
            assert!(connector_states.contains(&c), "missing ConnectorState::{}", c.as_str());
        }
        for cs in CallState::ALL {
            assert!(call_states.contains(&cs), "missing CallState::{}", cs.as_str());
        }
        for ik in InboxKind::ALL {
            assert!(inbox_kinds.contains(&ik), "missing InboxKind::{}", ik.as_str());
        }
        for lane in IssueLane::ALL {
            assert!(lanes.contains(&lane), "missing IssueLane::{}", lane.as_str());
        }
        for kind in IssueCardKind::ALL {
            assert!(card_kinds.contains(&kind), "missing IssueCardKind::{}", kind.as_str());
        }
        for prompt in IssuePromptKind::ALL {
            assert!(prompt_kinds.contains(&prompt), "missing IssuePromptKind::{}", prompt.as_str());
        }

        assert!(saw_needs_reconciliation, "expected Interrupted session with needs_reconciliation");
        assert!(saw_worktree_check, "expected BoardIssueSummary.needs_worktree_check");
        assert!(saw_999_unread, "expected 999+ unread count");
        assert!(saw_deep_family, "expected 1-parent-6-child family");
        assert!(saw_huge_spent, "expected >= 1234.56 spent");
        assert!(saw_long_sha, "expected long unbroken SHA and URL");
        assert!(saw_failed_pr_check, "expected open PR with failed check receipt");

        // Verify Edge-specific summaries deterministically.
        let edge = preset(Density::Edge);
        let media = edge.state.media_summary.as_ref().expect("edge media_summary");
        assert_eq!(media.active_count, 3);
        assert_eq!(media.active_ids, vec!["job-edge-queued", "job-edge-generating", "job-edge-downloading"]);
        let chat = edge.state.channel_summary.as_ref().expect("edge channel_summary");
        assert_eq!(chat.unread_total, 1287);
        assert_eq!(chat.unread_under.get("general"), Some(&1285));
        assert_eq!(chat.unread_under.get("t-edge-burst"), Some(&37));
        assert_eq!(chat.unread_under.get("dm-orch"), Some(&2));
        let board = edge.state.board_summary.as_ref().expect("edge board_summary");
        // Running worker slots in Edge: w-edge-quiet (Working) + w-edge-fam4 (Working) = 2; orch-1 (Orchestrator) is excluded.
        assert_eq!(board.running_slots, 2);
        let fam = board.by_issue.get("i-edge-family").expect("edge family summary");
        assert_eq!(fam.card_kind, IssueCardKind::Family);
        assert_eq!((fam.family_done, fam.family_total), (3, 6));
        assert_eq!(board.by_issue.get("i-edge-orch").map(|s| s.card_kind), Some(IssueCardKind::Orchestrator));
    }

    #[test]
    fn builder_transitions_step_todo_working_asking_review_done_monotonically() {
        let mut b = ScenarioBuilder::new(SCENARIO_NOW);
        let mut item = issue("i-step", 50, "端到端状态流转工单", Priority::Medium, b.now());
        item.repo = Some("vibevalley".into());
        item.queued_at = Some(b.now());
        b.apply(vec![Fact::IssueChanged(FactIssueChanged {
            at: b.now(),
            issue: item.clone(),
        })]);
        assert_eq!(b.frame().state.issues[0].status, IssueStatus::Todo);
        let seq1 = b.frame().seq;

        b.advance_ms(MIN_MS);
        let mut sess = worker("w-step", "老周", "laozhou", "claude", b.now());
        sess.issue = Some("i-step".into());
        sess.repo = Some("vibevalley".into());
        sess.phase = Phase::working(b.now(), SessionAction::EditFile, "lib.rs");
        assign(&mut item, "laozhou", "w-step", b.now());
        b.apply(vec![
            Fact::SessionChanged(FactSessionChanged {
                at: b.now(),
                session: sess.clone(),
            }),
            Fact::IssueChanged(FactIssueChanged {
                at: b.now(),
                issue: item.clone(),
            }),
        ]);
        let f2 = b.frame();
        assert!(f2.seq > seq1);
        assert_eq!(f2.state.issues[0].status, IssueStatus::InProgress);
        assert_eq!(f2.state.issues[0].stage.state, IssueStageKind::Working);

        b.advance_ms(2 * MIN_MS);
        item.questions = vec![Question {
            question: "确认继续合并吗？".into(),
            options: vec!["确认".into()],
        }];
        b.apply(vec![
            Fact::SessionReported(FactSessionReported {
                at: b.now(),
                id: "w-step".into(),
                run: Some("r1".into()),
                outcome: Outcome::Completed,
                phase: None,
                summary: "等待确认".into(),
                runs: 1,
                spent: None,
                questions: item.questions.clone(),
                checks: vec![],
                answer: None,
            }),
            Fact::IssueChanged(FactIssueChanged {
                at: b.now(),
                issue: item.clone(),
            }),
        ]);
        let f3 = b.frame();
        assert!(f3.seq > f2.seq);
        assert_eq!(f3.state.issues[0].stage.state, IssueStageKind::Asking);
        assert!(!f3.inbox.is_empty());

        b.advance_ms(MIN_MS);
        item.questions.clear();
        b.apply(vec![Fact::IssueChanged(FactIssueChanged {
            at: b.now(),
            issue: item.clone(),
        })]);
        let f4 = b.frame();
        assert!(f4.seq > f3.seq);
        assert_eq!(f4.state.issues[0].status, IssueStatus::InReview);
        assert_eq!(f4.state.issues[0].stage.state, IssueStageKind::Reviewing);

        b.advance_ms(MIN_MS);
        item.delivered = Some(Landing::Merged);
        item.closed_at = Some(b.now());
        b.apply(vec![Fact::IssueChanged(FactIssueChanged { at: b.now(), issue: item })]);
        let f5 = b.frame();
        assert!(f5.seq > f4.seq);
        assert_eq!(f5.state.issues[0].status, IssueStatus::Done);
    }

    #[test]
    fn committed_scenario_fixtures_match_presets() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/mac/ui/fixtures/scenarios");
        for density in Density::ALL {
            let target = root.join(density.slug()).join("state.json");
            let expected = serde_json::to_value(preset(density)).expect("serialize preset value");
            let raw = std::fs::read_to_string(&target).unwrap_or_else(|e| {
                panic!(
                    "missing scenario fixture {} ({e}); run: cargo run -p vibevalley-core --features scenarios --example export_scenarios -- apps/mac/ui/fixtures/scenarios",
                    target.display()
                )
            });
            let actual: serde_json::Value = serde_json::from_str(&raw).unwrap_or_else(|e| {
                panic!(
                    "invalid scenario fixture {} ({e}); run: cargo run -p vibevalley-core --features scenarios --example export_scenarios -- apps/mac/ui/fixtures/scenarios",
                    target.display()
                )
            });
            assert_eq!(
                actual,
                expected,
                "scenario fixture {} is out of date; run: cargo run -p vibevalley-core --features scenarios --example export_scenarios -- apps/mac/ui/fixtures/scenarios",
                target.display()
            );
        }
    }
}

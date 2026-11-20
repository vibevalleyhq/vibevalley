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

/// Preset data densities spanning empty onboarding to high-density stress cases.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Density {
    Empty,
    Minimal,
    Typical,
    Dense,
    Extreme,
}

impl Density {
    pub const ALL: [Density; 5] = [Density::Empty, Density::Minimal, Density::Typical, Density::Dense, Density::Extreme];

    pub fn slug(self) -> &'static str {
        match self {
            Density::Empty => "empty",
            Density::Minimal => "minimal",
            Density::Typical => "typical",
            Density::Dense => "dense",
            Density::Extreme => "extreme",
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
}

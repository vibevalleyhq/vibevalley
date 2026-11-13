//! Ported from VibeValley `apps/server/src/modules/issue/when.test.ts`
//! (the fold test belongs to the server). Times are Asia/Shanghai.

use super::*;

const SH: &str = "Asia/Shanghai";

fn at(iso: &str) -> i64 {
    format!("{iso}+08:00").parse::<Timestamp>().unwrap().as_millisecond()
}

fn ms(s: &str) -> i64 {
    s.parse::<Timestamp>().unwrap().as_millisecond()
}

fn make() -> Cron {
    Cron {
        id: "c1".into(),
        name: "测试".into(),
        text: "跑一遍测试".into(),
        channel: "c1".into(),
        agent: None,
        repo: None,
        when: CronWhen::Daily { time: "09:00".into() },
        tz: SH.into(),
        enabled: true,
        created: at("2026-10-12T08:00:00"),
        last_run: None,
        by: ActorKind::User,
        pending: false,
    }
}

fn with(when: CronWhen) -> Cron {
    Cron { when, ..make() }
}

fn cron(expr: &str) -> Cron {
    with(CronWhen::Cron { expr: expr.into() })
}

fn req(when: CronWhen) -> CronRequest {
    CronRequest {
        name: "测试".into(),
        text: "跑测试".into(),
        channel: None,
        agent: None,
        repo: None,
        when,
        tz: None,
    }
}

#[test]
fn daily_and_weekly() {
    assert_eq!(next_run(&make()), Some(at("2026-10-12T09:00:00")));
    assert_eq!(
        next_run(&Cron {
            last_run: Some(at("2026-10-12T09:00:00")),
            ..make()
        }),
        Some(at("2026-10-13T09:00:00"))
    );
    assert_eq!(next_run(&Cron { tz: "UTC".into(), ..make() }), Some(ms("2026-10-12T09:00:00Z")));
    let w = |days: Vec<i64>, time: &str| with(CronWhen::Weekly { days, time: time.into() });
    assert_eq!(next_run(&w(vec![5, 3], "18:30")), Some(at("2026-10-14T18:30:00")));
    assert_eq!(next_run(&w(vec![0], "07:00")), Some(at("2026-10-18T07:00:00")));
}

#[test]
fn every_and_once() {
    let every = CronWhen::Every { minutes: 30.0 };
    assert_eq!(next_run(&with(every.clone())), Some(at("2026-10-12T08:30:00")));
    assert_eq!(
        next_run(&Cron {
            last_run: Some(at("2026-10-12T10:00:00")),
            ..with(every)
        }),
        Some(at("2026-10-12T10:30:00"))
    );
    let once = with(CronWhen::Once { at: at("2026-10-12T12:00:00") });
    assert_eq!(next_run(&once), Some(at("2026-10-12T12:00:00")));
    let done = Cron {
        last_run: Some(at("2026-10-12T12:00:05")),
        enabled: false,
        ..once
    };
    assert_eq!(next_run(&done), None);
    assert_eq!(next_text(&done), "做过了");
    assert_eq!(next_run(&Cron { enabled: false, ..make() }), None);
}

#[test]
fn every_spelling_of_a_fixed_zone_runs_the_same() {
    for when in [
        CronWhen::Daily { time: "09:00".into() },
        CronWhen::Weekly {
            days: vec![1],
            time: "09:00".into(),
        },
        CronWhen::Cron { expr: "0 9 * * 1".into() },
    ] {
        for tz in ["+08:00", "+0800", "+08", "GMT+08:00"] {
            let s = Cron {
                tz: tz.into(),
                ..with(when.clone())
            };
            let r = CronRequest {
                tz: Some(tz.into()),
                ..req(when.clone())
            };
            assert_eq!(cron_problem(&r, s.created), "", "{tz}");
            assert_eq!(next_run(&s), Some(at("2026-10-12T09:00:00")), "{when:?} {tz}");
            assert_eq!(next_text(&s), "10/12 09:00");
        }
    }
}

#[test]
fn what_a_request_gets_wrong() {
    let now = at("2026-10-12T08:00:00");
    assert_eq!(cron_problem(&req(CronWhen::Daily { time: "09:00".into() }), now), "");
    assert!(cron_problem(&req(CronWhen::Daily { time: "9点".into() }), now).contains("HH:MM"));
    assert!(cron_problem(&req(CronWhen::Once { at: now - 1 }), now).contains("以后"));
    assert!(cron_problem(&req(CronWhen::Every { minutes: 0.2 }), now).contains("至少"));
    assert!(
        cron_problem(
            &req(CronWhen::Weekly {
                days: vec![7],
                time: "09:00".into()
            }),
            now
        )
        .contains("0 到 6")
    );
    let daily = || req(CronWhen::Daily { time: "09:00".into() });
    assert!(
        cron_problem(
            &CronRequest {
                tz: Some("Mars/Base".into()),
                ..daily()
            },
            now
        )
        .contains("时区")
    );
    assert!(cron_problem(&CronRequest { text: " ".into(), ..daily() }, now).contains("做什么"));
    assert_eq!(
        cron_problem(
            &CronRequest {
                tz: Some("+08:00".into()),
                ..daily()
            },
            now
        ),
        ""
    );
    assert!(
        cron_problem(
            &CronRequest {
                tz: Some("Local".into()),
                ..daily()
            },
            now
        )
        .contains("时区")
    );
}

#[test]
fn when_it_runs_in_words() {
    assert_eq!(when_text(&CronWhen::Daily { time: "09:00".into() }, SH), "每天 09:00");
    assert_eq!(
        when_text(
            &CronWhen::Weekly {
                days: vec![3, 1],
                time: "09:00".into()
            },
            SH
        ),
        "每周一、三 09:00"
    );
    assert_eq!(when_text(&CronWhen::Every { minutes: 120.0 }, SH), "每 2 小时");
    assert_eq!(when_text(&CronWhen::Every { minutes: 45.0 }, SH), "每 45 分钟");
    assert_eq!(when_text(&CronWhen::Once { at: at("2026-01-06T00:03:00") }, SH), "1/6 00:03 一次");
    assert_eq!(next_text(&make()), "10/12 09:00");
    assert_eq!(next_text(&Cron { enabled: false, ..make() }), "关着");
    assert_eq!(
        next_text(&Cron {
            enabled: false,
            pending: true,
            ..make()
        }),
        "等你同意"
    );
}

#[test]
fn cron_next_run() {
    for (expr, last, want) in [
        ("0 9 * * 1-5", "", "2026-10-12T09:00:00"),
        ("0 9 * * 1-5", "2026-10-16T09:00:00", "2026-10-19T09:00:00"),
        ("15 * * * *", "", "2026-10-12T08:15:00"),
        ("*/20 8 * * *", "", "2026-10-12T08:20:00"),
        ("0 10 1 * *", "", "2026-11-01T10:00:00"),
        ("0 9 * * 7", "", "2026-10-18T09:00:00"),
        // Both day fields given: either one is due (the 13th is a Tuesday).
        ("0 9 13 * 5", "", "2026-10-13T09:00:00"),
        ("0 9 13 * 5", "2026-10-13T09:00:00", "2026-10-16T09:00:00"),
        ("0 0 29 2 *", "", "2028-02-29T00:00:00"),
        ("0,30 9-10 * * *", "2026-10-12T09:30:00", "2026-10-12T10:00:00"),
    ] {
        let s = Cron {
            last_run: (!last.is_empty()).then(|| at(last)),
            ..cron(expr)
        };
        assert_eq!(next_run(&s), Some(at(want)), "{expr} after {last:?}");
    }
}

#[test]
fn calendar_kinds_agree_across_clock_changes() {
    // New York: 2026-03-08 springs forward at 02:00, 2026-11-01 falls back at 02:00.
    let froms = [
        ms("2026-03-07T12:00:00-05:00"),
        ms("2026-03-08T01:59:00-05:00"),
        ms("2026-10-31T23:00:00-04:00"),
        ms("2026-11-01T01:30:00-04:00"),
    ];
    for tz in ["America/New_York", SH] {
        for time in ["02:30", "01:30", "00:00", "23:59"] {
            for created in froms {
                let base = Cron {
                    tz: tz.into(),
                    created,
                    ..make()
                };
                let expr = format!("{} {}", &time[3..], &time[..2]);
                let daily = next_run(&Cron {
                    when: CronWhen::Daily { time: time.into() },
                    ..base.clone()
                });
                let weekly = next_run(&Cron {
                    when: CronWhen::Weekly {
                        days: vec![0, 3],
                        time: time.into(),
                    },
                    ..base.clone()
                });
                assert!(daily.is_some());
                let as_cron = |e: String| {
                    next_run(&Cron {
                        when: CronWhen::Cron { expr: e },
                        ..base.clone()
                    })
                };
                assert_eq!(as_cron(format!("{expr} * * *")), daily, "{tz} {time} {created}");
                assert_eq!(as_cron(format!("{expr} * * 0,3")), weekly, "{tz} {time} {created}");
            }
        }
    }
    // The gap: 02:30 does not exist on 2026-03-08 in New York; it runs at 03:30 EDT.
    let gap = Cron {
        tz: "America/New_York".into(),
        created: ms("2026-03-08T01:59:00-05:00"),
        when: CronWhen::Daily { time: "02:30".into() },
        ..make()
    };
    assert_eq!(next_run(&gap), Some(ms("2026-03-08T03:30:00-04:00")));
    // The fold: 01:30 happens twice on 2026-11-01; the earlier one runs.
    let fold = Cron {
        created: ms("2026-11-01T00:00:00-04:00"),
        when: CronWhen::Daily { time: "01:30".into() },
        ..gap
    };
    assert_eq!(next_run(&fold), Some(ms("2026-11-01T01:30:00-04:00")));
}

#[test]
fn what_a_cron_gets_wrong() {
    let now = at("2026-10-12T08:00:00");
    let problem = |expr: &str| {
        cron_problem(
            &CronRequest {
                tz: Some(SH.into()),
                ..req(CronWhen::Cron { expr: expr.into() })
            },
            now,
        )
    };
    for (expr, want) in [
        ("0 9 * * 1-5", ""),
        ("*/5 * * * *", ""),
        ("0 9 * *", "五段"),
        ("60 * * * *", "分钟"),
        ("0 24 * * *", "小时"),
        ("0 9 0 * *", "日"),
        ("0 9 * 13 *", "月"),
        ("0 9 * * 8", "周几"),
        ("0 9 5-1 * *", "日"),
        ("*/0 * * * *", "分钟"),
        ("a b c d e", "分钟"),
        ("0 0 30 2 *", "永远"),
    ] {
        let p = problem(expr);
        if want.is_empty() {
            assert_eq!(p, "", "{expr}");
        } else {
            assert!(p.contains(want), "{expr}: {p}");
        }
    }
}

#[test]
fn cron_in_words() {
    for (expr, want) in [
        ("0 9 * * *", "每天 09:00"),
        ("0 9 * * 1-5", "工作日 09:00"),
        ("0 10 * * 6,0", "周末 10:00"),
        ("30 18 * * 3,1", "每周一、三 18:30"),
        ("0 7 * * 7", "每周日 07:00"),
        ("0 10 1 * *", "每月 1 号 10:00"),
        ("15 * * * *", "每小时第 15 分"),
        ("*/5 * * * *", "cron */5 * * * *"),
        ("0 9 1 1 *", "cron 0 9 1 1 *"),
        ("bad", "cron bad"),
    ] {
        assert_eq!(when_text(&CronWhen::Cron { expr: expr.into() }, SH), want, "{expr}");
    }
}

#[test]
fn due_missed_after_run_and_needs_ok() {
    let s = make();
    let nine = at("2026-10-12T09:00:00");
    assert_eq!(due_crons(std::slice::from_ref(&s), nine - 1).len(), 0);
    assert_eq!(due_crons(std::slice::from_ref(&s), nine).len(), 1);
    assert!(!is_missed(&s, nine + 60_000));
    assert!(is_missed(&s, nine + 6 * 60_000));
    let once = with(CronWhen::Once { at: nine });
    assert!(!after_run(&once, nine).enabled);
    assert!(after_run(&s, nine).enabled);
    assert!(due_text(&s, true).contains("补一次"));
    let daily = req(CronWhen::Daily { time: "09:00".into() });
    assert!(!needs_ok(&daily, true));
    assert!(needs_ok(&daily, false));
    assert!(!needs_ok(&req(CronWhen::Once { at: nine }), false));
    assert!(needs_ok(
        &CronRequest {
            agent: Some("lab".into()),
            ..req(CronWhen::Once { at: nine })
        },
        false
    ));
    let json = serde_json::to_value(&s).unwrap();
    assert_eq!(json["when"], serde_json::json!({"kind": "daily", "time": "09:00"}));
    assert!(json.get("lastRun").is_none());
}

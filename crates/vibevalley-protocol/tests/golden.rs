//! Values VibeValley's TypeScript wrote before the contract moved here (its
//! samples, its `reduce` and `frameOf`, each checked by its zod schema), read
//! into the Rust types and written back, must be the same JSON.

use std::collections::BTreeMap;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use vibevalley_protocol::*;

fn golden(name: &str) -> Value {
    let path = format!("{}/golden/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn round_trip<T: Serialize + DeserializeOwned>(name: &str) -> Vec<T> {
    let Value::Array(items) = golden(name) else {
        panic!("{name} is not an array")
    };
    items
        .into_iter()
        .enumerate()
        .map(|(i, want)| {
            let value: T = serde_json::from_value(want.clone()).unwrap_or_else(|e| panic!("{name}[{i}]: {e}\n{want:#}"));
            let got = serde_json::to_value(&value).unwrap();
            assert_eq!(got, want, "{name}[{i}] changed in the round trip");
            value
        })
        .collect()
}

#[test]
fn issues_from_the_servers_fold() {
    let issues = round_trip::<Issue>("issues");
    assert_eq!(issues.len(), 11);
    // The derived fields VibeValley's reduce wrote are kept as they are.
    let asking = issues.iter().find(|t| t.id == "i2").unwrap();
    assert_eq!(asking.stage.state, IssueStageKind::Asking);
}

#[test]
fn sessions_and_their_views() {
    round_trip::<Session>("sessions");
    round_trip::<SessionView>("session_views");
}

#[test]
fn facts() {
    round_trip::<Fact>("facts");
}

#[test]
fn inbox_items() {
    round_trip::<InboxItem>("inbox");
}

#[test]
fn the_state_frames_issues_sessions_and_inbox() {
    let frame = golden("state_frame");
    for (path, check) in [
        ("issues", round_value::<Vec<Issue>> as fn(&Value)),
        ("sessions", round_value::<Vec<SessionView>>),
        ("crons", round_value::<Vec<CronView>>),
    ] {
        check(&frame["state"][path]);
    }
    round_value::<Vec<InboxItem>>(&frame["inbox"]);
    assert_eq!(frame["seq"], 7);
}

fn round_value<T: Serialize + DeserializeOwned>(want: &Value) {
    let value: T = serde_json::from_value(want.clone()).unwrap();
    assert_eq!(&serde_json::to_value(&value).unwrap(), want);
}

#[test]
fn session_events_phases_crons_and_requests() {
    round_trip::<SessionEvent>("session_events");
    round_trip::<Phase>("phases");
    round_trip::<Cron>("crons");
    round_trip::<IssueRequest>("issue_requests");
    round_trip::<IssueStatusRequest>("status_requests");
}

#[test]
fn error_envelopes() {
    let envelopes = round_trip::<Envelope>("error_envelopes");
    let e = envelopes[2].error().unwrap();
    assert_eq!(e.biz_code, BizCode::IssueRefused);
    assert_eq!(e.detail.next.unwrap()[0].run.as_deref(), Some(&["vibevalley issue start 1".to_string()][..]));
    assert_eq!(
        serde_json::to_value(Envelope::void()).unwrap(),
        serde_json::json!({"bizCode": 0, "message": "ok"})
    );
}

#[test]
fn every_biz_code_and_its_meta() {
    let codes: BTreeMap<String, u32> = serde_json::from_value(golden("biz_codes")[0].clone()).unwrap();
    assert_eq!(codes.len(), BizCode::ALL.len() + 1, "Ok plus every error code");
    for code in BizCode::ALL {
        assert_eq!(codes[code.name()], code.code(), "{}", code.name());
    }
    let meta = golden("biz_code_meta")[0].clone();
    for code in BizCode::ALL {
        let want = &meta[code.code().to_string()];
        let m = code.meta();
        assert_eq!(want["status"], m.status, "{}", code.name());
        assert_eq!(want["kind"], serde_json::to_value(m.kind).unwrap(), "{}", code.name());
        assert_eq!(want["retryable"], m.retryable, "{}", code.name());
    }
}

#[test]
fn the_whole_state_frame() {
    round_value::<StateFrame>(&golden("state_frame"));
}

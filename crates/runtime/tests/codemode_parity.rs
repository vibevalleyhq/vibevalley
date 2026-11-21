use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tempfile::tempdir;
use vibevalley_runtime::agent::codemode::{CodeModeResult, CodeModeSpec, EXEC, KIND, register};
use vibevalley_runtime::agent::durable::{Error, Result, Scheduler, Store, Task};

fn make(script: &str) -> CodeModeSpec {
    CodeModeSpec {
        script: script.into(),
        seed: 42,
        start_time_ms: 1700000000000,
        ..Default::default()
    }
}
fn task(spec: CodeModeSpec) -> Task {
    let mut t = Task::new(KIND, EXEC);
    t.checkpoint = serde_json::to_value(spec).unwrap();
    t
}
fn run(s: &Scheduler, spec: CodeModeSpec) -> Task {
    let (t, _) = s.start(task(spec)).unwrap();
    s.wait(&t.id, Duration::from_secs(5)).unwrap()
}
fn done(t: Task) -> CodeModeResult {
    assert_eq!(t.terminal_reason, "completed", "{}", t.error_text);
    serde_json::from_value(t.result).unwrap()
}

#[test]
fn seeded_clock_and_random_advance_deterministically_over_replayed_calls() -> Result<()> {
    let s = Scheduler::new(Store::memory()?, 2);
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    register(&s, move |_, name, args| {
        calls.fetch_add(1, Ordering::Relaxed);
        Ok(match name {
            "values" => json!({"items":[1,2,3]}),
            _ => args,
        })
    });
    let spec = make(
        r#"
        class Acc { sum(xs) { return xs.reduce((a,b)=>a+b,0); } }
        const {items}=callTool("values", {});
        const r0=rand(), r1=Math.random();
        const t0=new Date().toISOString(); vibe.sleep(0); sleep(3);
        const v=vibe.call("sum",{sum:new Acc().sum(items.map(x=>x*2)), label:`t=${clock.now()}`});
        return {v,t0,t1:new Date().getTime(),t2:Date.now(),r0,r1};
    "#,
    );
    let r = done(run(&s, spec.clone()));
    assert_eq!(r.value["v"], json!({"sum":12,"label":"t=1700000000003"}));
    assert_eq!(r.value["t0"], "2023-11-14T22:13:20.000Z");
    assert_eq!(r.value["t1"], r.value["t2"]);
    assert_eq!(r.value["r0"], 0.7415648787718233);
    assert_eq!(r.value["r1"], 0.1599103928769201);
    assert_eq!(r.virtual_now_ms, 1700000000003);
    assert_eq!(r.replayed_calls, 2);
    assert_eq!(r.replayed_sleeps, 2);
    assert!(r.executed_steps > 5);
    assert_eq!(done(run(&s, spec)).value, r.value);
    assert_eq!(count.load(Ordering::Relaxed), 4);
    Ok(())
}

#[test]
fn interrupted_tool_recovers_without_repeating_completed_sibling_or_sleep() -> Result<()> {
    let dir = tempdir().unwrap();
    let path = dir.path().join("server.db");
    let store = Store::open(&path)?;
    let sched = Scheduler::new(store.clone(), 2);
    let (entered, wait) = flume::bounded(1);
    let completed = Arc::new(AtomicUsize::new(0));
    let first = completed.clone();
    register(&sched, move |ctx, name, _| {
        if name == "first" {
            first.fetch_add(1, Ordering::Relaxed);
            Ok(json!("product"))
        } else {
            entered.send(()).unwrap();
            let _ = ctx.cancellation().recv_timeout(Duration::from_secs(10));
            Err(Error::Invalid("interrupted".into()))
        }
    });
    let (t, _) = sched.start(task(make("const a=call('first'); sleep(1); return call('second', {a});")))?;
    wait.recv_timeout(Duration::from_secs(5)).unwrap();
    sched.close();
    store.close()?;
    let fresh = Store::open(&path)?;
    let sched = Scheduler::new(fresh.clone(), 2);
    register(&sched, |_, name, args| {
        assert_eq!(name, "second");
        Ok(args)
    });
    sched.recover()?;
    let r = done(sched.wait(&t.id, Duration::from_secs(5))?);
    assert_eq!(r.value, json!({"a":"product"}));
    assert_eq!(r.replayed_calls, 2);
    assert_eq!(r.replayed_sleeps, 1);
    assert_eq!(completed.load(Ordering::Relaxed), 1);
    assert_eq!(fresh.read(|r| r.children(&t.id))?.len(), 2);
    Ok(())
}

#[test]
fn catchable_tool_failure_preserves_the_original_error() -> Result<()> {
    let s = Scheduler::new(Store::memory()?, 1);
    let calls = Arc::new(AtomicUsize::new(0));
    let n = calls.clone();
    register(&s, move |_, name, args| {
        n.fetch_add(1, Ordering::Relaxed);
        if name == "flaky" {
            Err(Error::Invalid("empty harvest".into()))
        } else {
            Ok(args)
        }
    });
    let result = done(run(
        &s,
        make("let caught=''; try{vibe.call('flaky');}catch(e){caught=e.message;} sleep(0); return callTool('ok',{caught});"),
    ));
    assert!(result.value["caught"].as_str().unwrap().contains("empty harvest"));
    assert_eq!(result.replayed_calls, 2);
    assert_eq!(calls.load(Ordering::Relaxed), 2);
    Ok(())
}

#[test]
fn metering_bounds_memory_strings_results_recursion_and_dynamic_code() -> Result<()> {
    let s = Scheduler::new(Store::memory()?, 1);
    register(&s, |_, _, _| Ok(Value::Null));
    for (source, changes, expected) in [
        ("while(true){}", json!({"maxSteps":30}), "step quota"),
        ("while(true);", json!({"maxSteps":30}), "step quota"),
        ("try{while(true){}}catch(e){return 'ignored';}", json!({"maxSteps":30}), "step quota"),
        ("eval('while(true){}')", json!({"maxSteps":30}), "step quota"),
        ("const f=(()=>{}).constructor('while(true){}'); f();", json!({"maxSteps":30}), "step quota"),
        ("while(true){}", json!({"maxSteps":100000000,"timeoutMs":25}), "timeout"),
        (
            "let s='x'; for(let i=0;i<20;i++){s+=s;} return s.length",
            json!({"maxStringBytes":4096}),
            "quota",
        ),
        (
            "let s='x'; for(let i=0;i<20;i++){s=`${s}${s}`;} return s.length",
            json!({"maxStringBytes":4096}),
            "quota",
        ),
        ("return 'x'.repeat(200000)", json!({"maxStringBytes":256}), "quota"),
        ("return new Array(200000).join('a')", json!({"maxStringBytes":256}), "quota"),
        ("return new Uint8Array(1<<20).byteLength", json!({"maxMemoryBytes":65536}), "quota"),
        ("return 'x'.repeat(100)", json!({"maxOutputBytes":64}), "quota"),
        ("let a=1;let b=1;let c=1;return a+b+c", json!({"maxVars":2}), "variable limit"),
        ("for(let i=0;i<32;i++)globalThis['key'+i]=i", json!({"maxVars":3}), "variable limit"),
        ("let x='xy';for(let i=0;i<20;i++)x=x+x;return x.length", json!({"maxStringBytes":1024}), "quota"),
        ("return 'x'.padStart(16000,'z')", json!({"maxStringBytes":1024}), "quota"),
        ("const b=new ArrayBuffer(65536);return b.byteLength", json!({"maxMemoryBytes":32768}), "quota"),
        ("function deep(){return deep()+1;}return deep()", json!({"maxSteps":100000}), "quota"),
        ("let x=;", json!({}), "syntax"),
    ] {
        let mut spec = serde_json::to_value(make(source))?;
        for (k, v) in changes.as_object().unwrap() {
            spec[k] = v.clone();
        }
        let t = run(&s, serde_json::from_value(spec)?);
        assert_eq!(t.terminal_reason, "failed", "{source}: {:?}", t.result);
        assert!(t.error_text.to_lowercase().contains(expected), "{source}: {}", t.error_text);
    }
    Ok(())
}

#[test]
fn go_replay_fixtures_match_results_clocks_random_and_instruction_counts() -> Result<()> {
    let store = Store::memory()?;
    let sched = Scheduler::new(store, 2);
    register(&sched, |_, _, args| Ok(args));
    let rows: Vec<Value> = serde_json::from_str(include_str!("fixtures/go-script-results.json"))?;
    for case in rows {
        let mut spec = make(case["script"].as_str().unwrap());
        spec.start_time_ms = 1750000000000;
        let task = run(&sched, spec);
        assert_eq!(task.terminal_reason, case["reason"], "{}", task.error_text);
        assert_eq!(task.result, case["result"], "script {}", case["script"]);
    }
    Ok(())
}

#[test]
fn parked_tool_retains_conversation_identity_and_resumes_on_approval() -> Result<()> {
    use vibevalley_runtime::agent::codemode::{RUN, register_with};
    use vibevalley_runtime::agent::durable::Transition;
    let store = Store::memory()?;
    let scheduler = Scheduler::new(store.clone(), 1);
    let (tx, rx) = flume::bounded(1);
    register_with(&scheduler, move |ctx, name, value| {
        assert!(!ctx.task.is_model_task);
        assert_eq!(ctx.task.conversation_id, "conv");
        assert_eq!(name, "remember");
        if ctx.signal.is_none() {
            tx.send(ctx.task.id.clone()).unwrap();
            return Ok(Transition::Sleep {
                phase: RUN.into(),
                checkpoint: None,
                until_ms: None,
                signal: Some("approved".into()),
            });
        }
        assert_eq!(ctx.signal.as_ref().unwrap().payload, json!("ok"));
        Ok(Transition::Complete(value))
    });
    let mut t = task(make("return vibe.call('remember',{value:'keep'})"));
    t.conversation_id = "conv".into();
    let (parent, _) = scheduler.start(t)?;
    let child = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    scheduler.send_signal(&child, "approved", Some("one"), &json!("ok"))?;
    assert_eq!(done(scheduler.wait(&parent.id, Duration::from_secs(5))?).value, json!({"value":"keep"}));
    Ok(())
}

use super::{
    CodeModeResult, CodeModeSpec, Outcome, Tool, ToolRecord,
    instrument::{Guards, compile},
};
use crate::agent::durable::TaskContext;
use rquickjs::{CatchResultExt, Context, Ctx, Exception, Function, Runtime, Value as JsValue};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

struct Replay {
    id: String,
    now: i64,
    seed: u64,
    steps: u64,
    call_seq: u64,
    sleep_seq: u64,
    calls: u64,
    sleeps: u64,
    records: HashMap<String, ToolRecord>,
    finished_sleeps: HashSet<String>,
    pending: Option<Outcome>,
    fatal: Option<String>,
}

impl Replay {
    fn random(&mut self) -> f64 {
        self.seed = self.seed.wrapping_add(0x9e3779b97f4a7c15);
        let mut v = self.seed;
        v = (v ^ (v >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        v = (v ^ (v >> 27)).wrapping_mul(0x94d049bb133111eb);
        ((v ^ (v >> 31)) >> 11) as f64 / (1u64 << 53) as f64
    }
    fn request(&mut self, op: &str, name: String, args: &str) -> Result<String, String> {
        if let Some(err) = &self.fatal {
            return Err(err.clone());
        }
        if self.pending.is_some() {
            return Err("phase yielded".into());
        }
        match op {
            "call" => {
                self.call_seq += 1;
                let key = format!("{}:call:{}:{name}", self.id, self.call_seq);
                if let Some(rec) = self.records.get(&key) {
                    self.calls += 1;
                    return Ok(if rec.ok {
                        json!({"value":rec.result})
                    } else {
                        json!({"error":format!("codemode tool {name} failed: {}",rec.error.as_deref().unwrap_or("failed"))})
                    }
                    .to_string());
                }
                let args = serde_json::from_str(args).map_err(|e| e.to_string())?;
                self.pending = Some(Outcome::Tool(key, Tool { tool_name: name, args }));
                Err("phase yielded".into())
            }
            "sleep" => {
                let ms = serde_json::from_str::<i64>(args).map_err(|_| "invalid sleep duration".to_string())?;
                self.sleep_seq += 1;
                let key = format!("__cm_sleep_{}", self.sleep_seq);
                if self.finished_sleeps.contains(&key) {
                    self.sleeps += 1;
                    self.now = self.now.checked_add(ms).ok_or("virtual clock overflow")?;
                    return Ok(String::new());
                }
                self.pending = Some(Outcome::Sleep(key, ms));
                Err("phase yielded".into())
            }
            _ => Err("unknown codemode operation".into()),
        }
    }
}

fn bound(n: i64, default: usize) -> usize {
    usize::try_from(n).ok().filter(|n| *n > 0).unwrap_or(default)
}

pub(super) fn execute(
    tc: &TaskContext,
    spec: &CodeModeSpec,
    records: HashMap<String, ToolRecord>,
    finished_sleeps: HashSet<String>,
) -> Result<Outcome, String> {
    let max_vars = bound(spec.max_vars, 256);
    let max_steps = bound(spec.max_steps, 10_000);
    let max_memory = bound(spec.max_memory_bytes, 16 << 20);
    let max_string = bound(spec.max_string_bytes, 1 << 20).min(max_memory);
    let max_output = bound(spec.max_output_bytes, 1 << 20);
    let timeout = Duration::from_millis(bound(spec.timeout_ms, 5000) as u64);
    if spec.script.len() > max_memory {
        return Err("script quota exceeded: source size".into());
    }
    let seed = if spec.seed == 0 { 0x9e3779b97f4a7c15 } else { spec.seed };
    let guards = Arc::new(Guards::new(&spec.script, seed));
    let source = compile(&spec.script, &guards, max_vars)?;
    let state = Arc::new(Mutex::new(Replay {
        id: tc.task.id.clone(),
        now: if spec.start_time_ms == 0 { tc.task.created_at_ms } else { spec.start_time_ms },
        seed,
        steps: 0,
        call_seq: 0,
        sleep_seq: 0,
        calls: 0,
        sleeps: 0,
        records,
        finished_sleeps,
        pending: None,
        fatal: None,
    }));
    let rt = Runtime::new().map_err(|e| e.to_string())?;
    rt.set_max_stack_size(256 * 1024);
    let context = Context::full(&rt).map_err(|e| e.to_string())?;
    // QuickJS accounts for built-ins and bytecode alongside allocations by the script.
    let baseline = rt.memory_usage().malloc_size.max(0) as usize;
    rt.set_memory_limit(baseline.saturating_add(max_memory).saturating_add(64 * 1024));
    let cancel = tc.cancellation();
    let interrupt = state.clone();
    let started = Instant::now();
    rt.set_interrupt_handler(Some(Box::new(move || {
        let mut s = interrupt.lock().unwrap();
        if cancel.is_disconnected() {
            s.fatal.get_or_insert_with(|| "execution cancelled".into());
        }
        if started.elapsed() >= timeout {
            s.fatal.get_or_insert_with(|| "script timeout".into());
        }
        s.pending.is_some() || s.fatal.is_some()
    })));

    let value = context.with(|ctx| -> Result<Value, String> {
        let eval = || -> rquickjs::Result<Value> {
            let s = state.clone();
            let host = Function::new(ctx.clone(), move |ctx: Ctx<'_>, op: String, name: String, args: String| {
                s.lock().unwrap().request(&op, name, &args).map_err(|e| Exception::throw_message(&ctx, &e))
            })?;
            let s = state.clone();
            let clock = Function::new(ctx.clone(), move || s.lock().unwrap().now as f64)?;
            let s = state.clone();
            let rand = Function::new(ctx.clone(), move || s.lock().unwrap().random())?;
            let s = state.clone();
            let count = Function::new(ctx.clone(), move |ctx: Ctx<'_>| {
                let mut s = s.lock().unwrap();
                s.steps += 1;
                if s.steps > max_steps as u64 {
                    s.fatal.get_or_insert_with(|| "step quota exceeded".into());
                }
                if let Some(err) = &s.fatal {
                    return Err(Exception::throw_message(&ctx, err));
                }
                if s.pending.is_some() {
                    return Err(Exception::throw_message(&ctx, "phase yielded"));
                }
                Ok(())
            })?;
            let s = state.clone();
            let fail = Function::new(ctx.clone(), move |ctx: Ctx<'_>, msg: String| -> rquickjs::Result<()> {
                s.lock().unwrap().fatal.get_or_insert_with(|| msg.clone());
                Err(Exception::throw_message(&ctx, &msg))
            })?;
            let names = guards.clone();
            let dynamic = Function::new(ctx.clone(), move |ctx: Ctx<'_>, body: String| {
                if body.len() > max_memory {
                    return Err(Exception::throw_message(&ctx, "script quota exceeded: source size"));
                }
                compile(&body, &names, max_vars).map_err(|e| Exception::throw_syntax(&ctx, &e))
            })?;
            let init: Function = ctx.eval(include_str!("context.js"))?;
            let limits = ctx.json_parse(
                json!({"tickName":guards.tick,"stringName":guards.string,"maxVars":max_vars,"maxString":max_string,"maxMemory":max_memory}).to_string(),
            )?;
            let globals: Function = init.call((host, clock, rand, count, fail, dynamic, limits))?;
            let result: JsValue = ctx.eval(source)?;
            globals.call::<_, ()>(())?;
            let encoded = ctx.json_stringify(result)?.map(|s| s.to_string()).transpose()?.unwrap_or_else(|| "null".into());
            if encoded.len() > max_output {
                return Err(Exception::throw_message(&ctx, "script quota exceeded: result size"));
            }
            serde_json::from_str(&encoded).map_err(|e| Exception::throw_message(&ctx, &e.to_string()))
        };
        eval().catch(&ctx).map_err(|e| {
            let msg = e.to_string();
            let lower = msg.to_lowercase();
            if lower.contains("out of memory") || lower.contains("stack overflow") || lower.contains("maximum call stack") || lower.contains("allocation") {
                format!("script quota exceeded: {msg}")
            } else {
                msg
            }
        })
    });
    rt.set_interrupt_handler(None);
    let mut s = state.lock().unwrap();
    if let Some(pending) = s.pending.take() {
        return Ok(pending);
    }
    if let Some(err) = s.fatal.take() {
        return Err(err);
    }
    Ok(Outcome::Complete(CodeModeResult {
        value: value?,
        executed_steps: s.steps,
        replayed_calls: s.calls,
        replayed_sleeps: s.sleeps,
        virtual_now_ms: s.now,
    }))
}

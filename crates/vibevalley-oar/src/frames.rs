use std::collections::HashMap;

use serde_json::{Value, json};

#[derive(Default)]
pub(crate) struct Frames {
    partial_inputs: HashMap<(Vec<String>, u64), (String, String)>,
}

impl Frames {
    pub fn extras(&mut self, kind: &str, path: &[String], frame: &Value) -> Vec<Value> {
        let mut events = Vec::new();
        match kind {
            "system/init"=>{if let Some(model)=frame["model"].as_str(){events.push(json!({"kind":"model","model":model}));}}
            "assistant"=>{if let Some(model)=frame.pointer("/message/model").and_then(Value::as_str){events.push(json!({"kind":"model","model":model}));}}
            "system/task_started"=>events.push(json!({"kind":"task_started","taskId":frame["task_id"],"taskKind":if frame["task_type"]=="local_agent"{json!("agent")}else{frame["task_type"].clone()},"label":frame["description"]})),
            "system/task_progress"=>events.push(json!({"kind":"task_updated","taskId":frame["task_id"],"status":"running","summary":frame["description"]})),
            "system/task_notification"=>events.push(json!({"kind":"task_ended","taskId":frame["task_id"],"status":if frame["status"]=="killed"{json!("stopped")}else{frame["status"].clone()},"summary":frame["summary"]})),
            "session/update/tool_call_update"=>{let u=&frame["update"];if let Some(input)=u.get("rawInput").filter(|v|!v.is_null()){events.push(json!({"kind":"tool_call_input","callId":u["toolCallId"],"input":input.to_string()}));}}
            "stream_event"=>{
                let e=&frame["event"];
                let index=e["index"].as_u64().unwrap_or(0);
                let key=(path.to_owned(),index);
                match e["type"].as_str(){
                    Some("content_block_start") if e.pointer("/content_block/type")==Some(&json!("tool_use"))=>{
                        let b=&e["content_block"];
                        if let Some(id)=b["id"].as_str(){
                            self.partial_inputs.insert(key,(id.to_owned(),String::new()));
                            events.push(json!({"kind":"tool_call_started","callId":id,"tool":b["name"]}));
                        }
                    }
                    Some("content_block_delta")=>{if let Some((_,content))=self.partial_inputs.get_mut(&key) && let Some(chunk)=e.pointer("/delta/partial_json").and_then(Value::as_str){content.push_str(chunk);}}
                    Some("content_block_stop")=>{
                        if let Some((id,input))=self.partial_inputs.remove(&key) && !input.is_empty(){events.push(json!({"kind":"tool_call_input","callId":id,"input":input}));}
                    }
                    _=>{}
                }
            }
            _=>{}
        }
        events
    }
}

pub(crate) fn failure(reason: &str) -> &'static str {
    let s = reason.to_ascii_lowercase();
    for (class, terms) in [
        ("auth", &["unauthorized", "invalid api key", "reauth", "authentication"][..]),
        ("billing", &["insufficient balance", "billing", "payment"]),
        ("quota", &["quota", "usage limit"]),
        ("rate_limit", &["rate limit", "429"]),
        ("overloaded", &["overloaded", "capacity"]),
        ("context_length", &["context length", "too many tokens", "maximum context"]),
        ("model_unavailable", &["model not found", "model_unavailable"]),
        ("timeout", &["timeout", "timed out"]),
        ("cancelled", &["cancel", "abort", "interrupt"]),
        ("network", &["network", "connection"]),
    ] {
        if terms.iter().any(|t| s.contains(t)) {
            return class;
        }
    }
    "unknown"
}

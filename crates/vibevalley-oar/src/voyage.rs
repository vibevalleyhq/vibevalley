use std::collections::BTreeMap;
use std::io::{BufRead, Write};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};

use crate::{AgentError, Event, EventKind, Result, StopReason, Usage};

pub const FORMAT: &str = "oar-voyage/3";
const VERSION: u8 = 3;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub format: String,
    #[serde(default)]
    pub version: u8,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub runtime: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub session_id: String,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, String>,
}

impl Header {
    pub fn new(runtime: &str, id: &str, created_at: u64) -> Self {
        Self {
            format: FORMAT.into(),
            version: VERSION,
            runtime: runtime.into(),
            session_id: id.into(),
            created_at,
            metadata: BTreeMap::new(),
        }
    }
    fn validate(&mut self) -> Result<()> {
        if self.format != FORMAT || !matches!(self.version, 0 | VERSION) {
            return Err(AgentError::Protocol("invalid oar-voyage/3 header".into()));
        }
        self.version = VERSION;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Frame,
    Control,
    Marker,
}

fn raw_bytes<S: Serializer>(bytes: &[u8], serializer: S) -> std::result::Result<S::Ok, S::Error> {
    serializer.serialize_str(&STANDARD.encode(bytes))
}
fn decode_raw<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Vec<u8>, D::Error> {
    STANDARD.decode(String::deserialize(d)?).map_err(serde::de::Error::custom)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub seq: u64,
    pub kind: Kind,
    pub session_id: String,
    pub agent_path: Vec<String>,
    #[serde(default)]
    pub received_at: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub span_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub frame_type: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty", serialize_with = "raw_bytes", deserialize_with = "decode_raw")]
    pub raw: Vec<u8>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub native_events: Vec<Event>,
}

impl Record {
    fn validate(&self, last_seq: Option<u64>) -> Result<()> {
        if self.session_id.trim().is_empty() {
            return Err(AgentError::Protocol("voyage record missing sessionId".into()));
        }
        if last_seq.is_some_and(|seq| seq >= self.seq) {
            return Err(AgentError::Protocol("non-monotonic voyage record sequence".into()));
        }
        Ok(())
    }
    pub(crate) fn new(kind: Kind, session_id: String, at: u64) -> Self {
        Self {
            seq: 0,
            kind,
            session_id,
            agent_path: vec![],
            received_at: at,
            span_id: String::new(),
            frame_type: String::new(),
            raw: vec![],
            events: vec![],
            control: None,
            marker: None,
            native_events: vec![],
        }
    }
    pub(crate) fn event(id: String, event: &Event) -> Self {
        let mut rec = Self::new(Kind::Frame, id, event.at_ms);
        rec.agent_path = event.agent_path.clone();
        match &event.kind {
            EventKind::SessionStarted { model, .. } => {
                rec.kind = Kind::Marker;
                rec.marker = Some(json!({"name":"session_started"}));
                if let Some(model) = model {
                    rec.events.push(json!({"kind":"model","model":model}));
                }
            }
            EventKind::TurnStarted { prompt } => rec.events.push(json!({"kind":"turn_started","input":prompt})),
            EventKind::TextDelta { text } => rec.events.push(json!({"kind":"text_delta","text":text})),
            EventKind::ThinkingDelta { text } => rec.events.push(json!({"kind":"reasoning","reasoningKind":"text","text":text})),
            EventKind::ToolCallStarted { id, name, input } => rec
                .events
                .push(json!({"kind":"tool_call_started","callId":id,"tool":name,"input":input.to_string()})),
            EventKind::ToolCallFinished { id, ok, output } => rec
                .events
                .push(json!({"kind":"tool_call_ended","callId":id,"result":if *ok{"ok"}else{"failed"},"content":[{"type":"text","text":output}]})),
            EventKind::TurnFinished { reason, usage } => {
                rec.events.push(json!({"kind":"usage","usage":{"tokens":tokens(usage)}}));
                let outcome = match reason {
                    StopReason::Completed => "completed",
                    StopReason::Aborted => "aborted",
                    StopReason::MaxTurns | StopReason::Error => "failed",
                };
                rec.events.push(json!({"kind":"turn_ended","outcome":{"kind":outcome}}));
            }
            EventKind::SessionEnded => {
                rec.kind = Kind::Marker;
                rec.marker = Some(json!({"name":"session_ended"}));
                rec.events.push(json!({"kind":"exited"}));
            }
            _ => {
                rec.kind = Kind::Marker;
                rec.marker = Some(json!({"name":serde_json::to_value(&event.kind).expect("serializable event")["type"]}));
            }
        }
        rec.frame_type = rec.events.first().and_then(|e| e["kind"].as_str()).unwrap_or("marker").into();
        rec.native_events.push(event.clone());
        rec
    }
}

fn tokens(usage: &Usage) -> Value {
    if usage.input_tokens.is_none() && usage.output_tokens.is_none() && usage.cost_usd.is_none() {
        return Value::Null;
    }
    let mut tokens = json!({"inputTokens":usage.input_tokens.unwrap_or_default(),"outputTokens":usage.output_tokens.unwrap_or_default(),"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0});
    if let Some(cost) = usage.cost_usd {
        tokens["costMicros"] = json!((cost * 1_000_000.0).round() as i64);
    }
    tokens
}

fn line<W: Write, T: Serialize>(out: &mut W, item: &T) -> Result<()> {
    let mut bytes = serde_json::to_vec(item).map_err(|e| AgentError::Protocol(e.to_string()))?;
    bytes.push(b'\n');
    out.write_all(&bytes).map_err(|e| AgentError::Io(e.to_string()))
}

pub struct Writer<W> {
    out: W,
    last: Option<u64>,
}
impl<W: Write> Writer<W> {
    pub fn new(mut out: W, mut header: Header) -> Result<Self> {
        header.validate()?;
        line(&mut out, &header)?;
        Ok(Self { out, last: None })
    }
    pub(crate) fn from_existing(out: W, last: Option<u64>) -> Self {
        Self { out, last }
    }
    pub fn write(&mut self, rec: &Record) -> Result<()> {
        rec.validate(self.last)?;
        line(&mut self.out, rec)?;
        self.last = Some(rec.seq);
        Ok(())
    }
}

pub struct Reader<R> {
    input: R,
    last: Option<u64>,
    pub header: Header,
}
impl<R: BufRead> Reader<R> {
    pub fn new(mut input: R) -> Result<Self> {
        let mut header: Header = next_line(&mut input)?.ok_or_else(|| AgentError::Protocol("empty voyage".into()))?;
        header.validate()?;
        Ok(Self { input, last: None, header })
    }
    pub fn read(&mut self) -> Result<Option<Record>> {
        let Some(rec): Option<Record> = next_line(&mut self.input)? else {
            return Ok(None);
        };
        rec.validate(self.last)?;
        self.last = Some(rec.seq);
        Ok(Some(rec))
    }
}
fn next_line<R: BufRead, T: serde::de::DeserializeOwned>(reader: &mut R) -> Result<Option<T>> {
    let mut buf = String::new();
    loop {
        buf.clear();
        if reader.read_line(&mut buf).map_err(|e| AgentError::Io(e.to_string()))? == 0 {
            return Ok(None);
        }
        if !buf.trim().is_empty() {
            return serde_json::from_str(&buf).map(Some).map_err(|e| AgentError::Protocol(e.to_string()));
        }
    }
}

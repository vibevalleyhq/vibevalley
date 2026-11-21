use std::collections::HashMap;

use indexmap::IndexMap;

use crate::detect::DiagramType;
use crate::error::{ErrorCode, PeleError};
use crate::util::chars::{is_space_char, is_word};
use crate::util::yaml::{YamlValue, parse_yaml};

use super::colors::is_css_color;
use super::types::{
    LineType, Placement, SeqActor, SeqBox, SeqBoxData, SeqItem, SeqMessage, SeqMessageBody, SeqNote, SeqNoteTarget, SeqNumbering, SeqStatement, SeqText,
};

#[derive(Debug, Clone, Default)]
pub struct SeqDbOptions {
    pub wrap: Option<bool>,
    pub sequence_wrap: bool,
}

fn fail(message: impl Into<String>) -> PeleError {
    PeleError::new(message, ErrorCode::Semantic).with_diagram_type(DiagramType::Sequence)
}

fn extract_wrap(raw: &str) -> SeqText {
    let text = raw.trim();
    if let Some(rest) = text.strip_prefix(":wrap:").or_else(|| text.strip_prefix("wrap:")) {
        return SeqText {
            text: rest.trim().to_string(),
            wrap: Some(true),
        };
    }
    if let Some(rest) = text.strip_prefix(":nowrap:").or_else(|| text.strip_prefix("nowrap:")) {
        return SeqText {
            text: rest.trim().to_string(),
            wrap: Some(false),
        };
    }
    SeqText {
        text: text.to_string(),
        wrap: None,
    }
}

fn has_line_terminator(s: &str) -> bool {
    s.chars().any(|c| matches!(c, '\r' | '\u{2028}' | '\u{2029}'))
}

fn match_box_function(s: &str) -> Option<usize> {
    let prefix_len = if s.starts_with("rgba") || s.starts_with("hsla") {
        4
    } else if s.starts_with("rgb") || s.starts_with("hsl") {
        3
    } else {
        return None;
    };
    let mut p = prefix_len;
    while p < s.len() {
        let ch = s[p..].chars().next().unwrap();
        if is_space_char(ch) {
            p += ch.len_utf8();
        } else {
            break;
        }
    }
    if s.as_bytes().get(p) == Some(&b'(') { Some(p + 1) } else { None }
}

fn split_box(s: &str) -> Option<(&str, &str)> {
    if let Some(fn_len) = match_box_function(s)
        && let Some(close) = s.rfind(')')
        && close >= fn_len
    {
        if has_line_terminator(&s[fn_len..]) {
            return None;
        }
        return Some((&s[..=close], &s[close + 1..]));
    }
    if has_line_terminator(s) {
        return None;
    }
    let word_end = s.bytes().take_while(|&b| is_word(b as u32)).count();
    Some((&s[..word_end], &s[word_end..]))
}

fn yaml_to_string(v: &YamlValue) -> String {
    match v {
        YamlValue::Null => "null".to_string(),
        YamlValue::Bool(b) => b.to_string(),
        YamlValue::Number(n) => {
            if n.fract() == 0.0 && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                format!("{n}")
            }
        }
        YamlValue::String(s) => s.clone(),
        YamlValue::Seq(_) => String::new(),
        YamlValue::Map(_) => "[object Object]".to_string(),
    }
}

fn is_truthy_yaml(v: &YamlValue) -> bool {
    match v {
        YamlValue::Null => false,
        YamlValue::Bool(b) => *b,
        YamlValue::Number(n) => *n != 0.0 && !n.is_nan(),
        YamlValue::String(s) => !s.is_empty(),
        YamlValue::Seq(_) | YamlValue::Map(_) => true,
    }
}

fn yaml_entries(value: YamlValue) -> Vec<(String, YamlValue)> {
    match value {
        YamlValue::String(s) => s
            .chars()
            .enumerate()
            .map(|(i, ch)| (i.to_string(), YamlValue::String(ch.to_string())))
            .collect(),
        YamlValue::Seq(arr) => arr.into_iter().enumerate().map(|(i, v)| (i.to_string(), v)).collect(),
        YamlValue::Map(map) => map.into_iter().collect(),
        YamlValue::Null | YamlValue::Bool(_) | YamlValue::Number(_) => Vec::new(),
    }
}

#[derive(Debug, Clone)]
pub struct SeqDb {
    pub actors: IndexMap<String, SeqActor>,
    pub created_actors: IndexMap<String, usize>,
    pub destroyed_actors: IndexMap<String, usize>,
    pub boxes: Vec<SeqBox>,
    pub messages: Vec<SeqMessage>,
    pub notes: Vec<SeqNote>,
    pub title: Option<String>,
    pub acc_title: Option<String>,
    pub acc_descr: Option<String>,
    prev_actor: Option<String>,
    current_box: Option<usize>,
    last_created: Option<String>,
    last_destroyed: Option<String>,
    wrap_enabled: Option<bool>,
    sequence_wrap: bool,
    active: HashMap<String, usize>,
}

impl SeqDb {
    pub fn new(options: SeqDbOptions) -> Self {
        Self {
            actors: IndexMap::new(),
            created_actors: IndexMap::new(),
            destroyed_actors: IndexMap::new(),
            boxes: Vec::new(),
            messages: Vec::new(),
            notes: Vec::new(),
            title: None,
            acc_title: None,
            acc_descr: None,
            prev_actor: None,
            current_box: None,
            last_created: None,
            last_destroyed: None,
            wrap_enabled: options.wrap,
            sequence_wrap: options.sequence_wrap,
            active: HashMap::new(),
        }
    }

    pub fn auto_wrap(&self) -> bool {
        self.wrap_enabled.unwrap_or(self.sequence_wrap)
    }

    pub fn set_acc_title(&mut self, text: &str) {
        self.acc_title = Some(text.trim_start().to_string());
    }

    pub fn set_acc_description(&mut self, text: &str) {
        let mut out = String::with_capacity(text.len());
        let mut after_nl = false;
        for ch in text.chars() {
            if ch == '\n' {
                out.push('\n');
                after_nl = true;
            } else if after_nl && ch.is_whitespace() {
                continue;
            } else {
                after_nl = false;
                out.push(ch);
            }
        }
        self.acc_descr = Some(out);
    }

    pub fn set_diagram_title(&mut self, text: &str) {
        self.title = Some(text.to_string());
    }

    pub fn parse_message(&self, s: &str) -> SeqText {
        extract_wrap(s)
    }

    pub fn parse_box_data(&self, s: &str) -> SeqBoxData {
        let split = split_box(s);
        let mut color = split.map(|(c, _)| c.trim()).filter(|c| !c.is_empty()).unwrap_or("transparent").to_string();
        let mut title = split.map(|(_, t)| t.trim()).filter(|t| !t.is_empty()).map(str::to_string);
        if !is_css_color(&color) {
            color = "transparent".to_string();
            title = Some(s.trim().to_string());
        }
        let Some(title_raw) = title else {
            return SeqBoxData { text: None, color, wrap: None };
        };
        let extracted = extract_wrap(&title_raw);
        SeqBoxData {
            text: if extracted.text.is_empty() { None } else { Some(extracted.text) },
            color,
            wrap: extracted.wrap,
        }
    }

    pub fn add_box(&mut self, data: SeqBoxData) {
        let idx = self.boxes.len();
        self.boxes.push(SeqBox {
            name: data.text,
            wrap: data.wrap.unwrap_or_else(|| self.auto_wrap()),
            fill: data.color,
            actor_keys: Vec::new(),
        });
        self.current_box = Some(idx);
    }

    pub fn add_actor(
        &mut self,
        id: &str,
        name: &str,
        mut description: Option<SeqText>,
        mut actor_type: Option<String>,
        metadata: Option<&str>,
    ) -> Result<(), PeleError> {
        let mut assigned_box = self.current_box;
        let mut doc: Option<IndexMap<String, YamlValue>> = None;
        if let Some(meta) = metadata {
            let yaml = if meta.contains('\n') {
                format!("{meta}\n")
            } else {
                format!("{{\n{meta}\n}}")
            };
            let parsed = parse_yaml(&yaml).map_err(|err| {
                PeleError::new(format!("Config of participant \"{id}\" is not valid YAML. {err}"), ErrorCode::Syntax).with_diagram_type(DiagramType::Sequence)
            })?;
            if let YamlValue::Map(map) = parsed {
                doc = Some(map);
            }
        }
        if let Some(ref doc_map) = doc {
            if let Some(v) = doc_map.get("type")
                && !matches!(v, YamlValue::Null)
            {
                actor_type = Some(yaml_to_string(v));
            }
            if let Some(v) = doc_map.get("alias")
                && is_truthy_yaml(v)
                && description.as_ref().is_none_or(|d| d.text == name)
            {
                description = Some(SeqText {
                    text: yaml_to_string(v),
                    wrap: description.as_ref().and_then(|d| d.wrap),
                });
            }
        }

        if let Some(old) = self.actors.get_mut(id) {
            if let (Some(cur_b), Some(old_b)) = (self.current_box, old.box_idx)
                && cur_b != old_b
            {
                let old_name = old.name.clone();
                let old_b_name = self.boxes[old_b].name.as_deref().unwrap_or("undefined");
                let cur_b_name = self.boxes[cur_b].name.as_deref().unwrap_or("undefined");
                return Err(fail(format!(
                    "A same participant should only be defined in one Box: {old_name} can't be in '{old_b_name}' and in '{cur_b_name}' at the same time."
                )));
            }
            assigned_box = old.box_idx.or(self.current_box);
            old.box_idx = assigned_box;
            if name == old.name && description.is_none() {
                return Ok(());
            }
        }

        let (desc_text, desc_wrap) = match (description, actor_type.as_ref()) {
            (Some(d), Some(_)) => (d.text, d.wrap),
            _ => (name.to_string(), None),
        };

        let wrap = desc_wrap.unwrap_or_else(|| self.auto_wrap());
        let prev_actor = self.prev_actor.clone();
        self.actors.insert(
            id.to_string(),
            SeqActor {
                box_idx: assigned_box,
                name: name.to_string(),
                description: desc_text,
                wrap,
                prev_actor: prev_actor.clone(),
                next_actor: None,
                links: IndexMap::new(),
                properties: IndexMap::new(),
                details: None,
                actor_type: actor_type.unwrap_or_else(|| "participant".to_string()),
            },
        );
        if let Some(prev_id) = prev_actor
            && let Some(prev) = self.actors.get_mut(&prev_id)
        {
            prev.next_actor = Some(id.to_string());
        }
        if let Some(cur_b) = self.current_box {
            self.boxes[cur_b].actor_keys.push(id.to_string());
        }
        self.prev_actor = Some(id.to_string());
        Ok(())
    }

    pub fn add_signal(
        &mut self,
        from: Option<String>,
        to: Option<String>,
        message: Option<SeqText>,
        line_type: Option<LineType>,
        activate: bool,
        central_connection: Option<LineType>,
    ) -> Result<(), PeleError> {
        if line_type == Some(LineType::ActiveEnd) {
            let count = from.as_deref().and_then(|k| self.active.get(k).copied()).unwrap_or(0);
            if count < 1 {
                let who = from.as_deref().unwrap_or("undefined");
                return Err(fail(format!("Trying to inactivate an inactive participant ({who})")));
            }
            if let Some(ref k) = from {
                self.active.insert(k.clone(), count - 1);
            }
        } else if line_type == Some(LineType::ActiveStart)
            && let Some(ref k) = from
        {
            let cur = self.active.get(k).copied().unwrap_or(0);
            self.active.insert(k.clone(), cur + 1);
        }
        let wrap = message.as_ref().and_then(|m| m.wrap).unwrap_or_else(|| self.auto_wrap());
        let text = message.map_or_else(String::new, |m| m.text);
        self.messages.push(SeqMessage {
            id: self.messages.len().to_string(),
            from,
            to,
            message: SeqMessageBody::Text(text),
            wrap,
            line_type,
            activate,
            placement: None,
            central_connection,
        });
        Ok(())
    }

    pub fn add_note(&mut self, actor: SeqNoteTarget, placement: Placement, message: SeqText) {
        let wrap = message.wrap.unwrap_or_else(|| self.auto_wrap());
        let (from, to) = match &actor {
            SeqNoteTarget::Single(a) => (a.clone(), a.clone()),
            SeqNoteTarget::Pair(a, b) => (a.clone(), b.clone()),
        };
        self.notes.push(SeqNote {
            actor,
            placement,
            message: message.text.clone(),
            wrap,
        });
        self.messages.push(SeqMessage {
            id: self.messages.len().to_string(),
            from: Some(from),
            to: Some(to),
            message: SeqMessageBody::Text(message.text),
            wrap,
            line_type: Some(LineType::Note),
            activate: false,
            placement: Some(placement),
            central_connection: None,
        });
    }

    pub fn add_links(&mut self, actor_id: &str, text: &str) {
        let Some(actor) = self.actors.get_mut(actor_id) else {
            return;
        };
        if let Ok(parsed) = serde_json::from_str::<YamlValue>(text) {
            for (k, v) in yaml_entries(parsed) {
                actor.links.insert(k, v);
            }
        }
    }

    pub fn add_a_link(&mut self, actor_id: &str, text: &str) {
        let Some(actor) = self.actors.get_mut(actor_id) else {
            return;
        };
        if let Some(sep) = text.find('@') {
            let key_end = if sep == 0 {
                0
            } else {
                // Step back one char before `@`, matching Mermaid's `slice(0, sep - 1)`.
                text[..sep].char_indices().next_back().map_or(0, |(idx, _)| idx)
            };
            let key = text[..key_end].trim().to_string();
            let val = text[sep + 1..].trim().to_string();
            actor.links.insert(key, YamlValue::String(val));
        } else {
            let chars: Vec<char> = text.chars().collect();
            let key: String = chars[..chars.len().saturating_sub(2)].iter().collect();
            actor.links.insert(key.trim().to_string(), YamlValue::String(text.trim().to_string()));
        }
    }

    pub fn add_properties(&mut self, actor_id: &str, text: &str) {
        let Some(actor) = self.actors.get_mut(actor_id) else {
            return;
        };
        if let Ok(parsed) = serde_json::from_str::<YamlValue>(text) {
            for (k, v) in yaml_entries(parsed) {
                actor.properties.insert(k, v);
            }
        }
    }

    pub fn add_details(&mut self, actor_id: &str, text: &str) {
        if let Some(actor) = self.actors.get_mut(actor_id) {
            actor.details = Some(text.to_string());
        }
    }

    /// Walks nested statement lists with an explicit stack so arbitrary nesting never overflows.
    pub fn apply(&mut self, root: SeqItem) -> Result<(), PeleError> {
        let mut stack: Vec<std::vec::IntoIter<SeqItem>> = Vec::new();
        let mut current = Some(root);
        loop {
            if let Some(item) = current.take() {
                match item {
                    SeqItem::List(items) => {
                        stack.push(items.into_iter());
                    }
                    SeqItem::Stmt(stmt) => {
                        self.apply_one(stmt)?;
                    }
                    SeqItem::Ignored => {}
                }
            }
            match stack.last_mut() {
                None => return Ok(()),
                Some(iter) => match iter.next() {
                    Some(next) => current = Some(next),
                    None => {
                        stack.pop();
                    }
                },
            }
        }
    }

    fn apply_one(&mut self, stmt: SeqStatement) -> Result<(), PeleError> {
        match stmt {
            SeqStatement::SequenceIndex { start, step, visible } => {
                self.messages.push(SeqMessage {
                    id: self.messages.len().to_string(),
                    from: None,
                    to: None,
                    message: SeqMessageBody::Numbering(SeqNumbering { start, step, visible }),
                    wrap: false,
                    line_type: Some(LineType::Autonumber),
                    activate: false,
                    placement: None,
                    central_connection: None,
                });
            }
            SeqStatement::AddParticipant {
                actor,
                draw,
                description,
                config,
            } => {
                self.add_actor(&actor, &actor, description, draw, config.as_deref())?;
            }
            SeqStatement::CreateParticipant {
                actor,
                draw,
                description,
                config,
            } => {
                if self.actors.contains_key(&actor) {
                    return Err(fail(
                        "It is not possible to have actors with the same id, even if one is destroyed before the next is created. Use 'AS' aliases to simulate the behavior",
                    ));
                }
                self.last_created = Some(actor.clone());
                self.add_actor(&actor, &actor, description, draw, config.as_deref())?;
                self.created_actors.insert(actor, self.messages.len());
            }
            SeqStatement::DestroyParticipant { actor } => {
                self.last_destroyed = Some(actor.clone());
                self.destroyed_actors.insert(actor, self.messages.len());
            }
            SeqStatement::ActorSignal { actor, signal_type } => {
                self.add_signal(Some(actor), None, None, Some(signal_type), false, None)?;
            }
            SeqStatement::AddNote { actor, placement, text } => {
                self.add_note(actor, placement, text);
            }
            SeqStatement::AddLinks { actor, text } => {
                self.add_links(&actor, &text.text);
            }
            SeqStatement::AddALink { actor, text } => {
                self.add_a_link(&actor, &text.text);
            }
            SeqStatement::AddProperties { actor, text } => {
                self.add_properties(&actor, &text.text);
            }
            SeqStatement::AddDetails { actor, text } => {
                self.add_details(&actor, &text.text);
            }
            SeqStatement::AddMessage {
                from,
                to,
                msg,
                signal_type,
                activate,
                central_connection,
            } => {
                if let Some(ref created) = self.last_created {
                    if &to != created {
                        return Err(fail(format!(
                            "The created participant {created} does not have an associated creating message after its declaration. Please check the sequence diagram."
                        )));
                    }
                    self.last_created = None;
                } else if let Some(ref destroyed) = self.last_destroyed {
                    if &to != destroyed && &from != destroyed {
                        return Err(fail(format!(
                            "The destroyed participant {destroyed} does not have an associated destroying message after its declaration. Please check the sequence diagram."
                        )));
                    }
                    self.last_destroyed = None;
                }
                self.add_signal(Some(from), Some(to), Some(msg), Some(signal_type), activate, central_connection)?;
            }
            SeqStatement::BoxStart(data) => {
                self.add_box(data);
            }
            SeqStatement::BoxEnd => {
                self.current_box = None;
            }
            SeqStatement::BlockStart { text, signal_type } | SeqStatement::BlockDivider { text, signal_type } => {
                self.add_signal(None, None, Some(text), Some(signal_type), false, None)?;
            }
            SeqStatement::BlockEnd { signal_type } => {
                self.add_signal(None, None, None, Some(signal_type), false, None)?;
            }
        }
        Ok(())
    }
}

//! Channels and threads.

use serde::Deserialize;
use vibevalley_protocol::ChannelUpdate;

use super::{Farm, Who, given};
use crate::modules::collab::channel::{ReadOptions, Speaking, Spoken};
use crate::modules::team::orchestrator::words;

#[derive(Deserialize)]
pub struct ReadArgs {
    id: Option<String>,
    #[serde(default)]
    unread: bool,
    before: Option<i64>,
    limit: Option<i64>,
}

pub fn read(f: &Farm, who: &Who, a: ReadArgs) -> Result<String, String> {
    let (me, target) = match who {
        Who::Orchestrator(r) => {
            let target = given(&a.id).map(String::from).unwrap_or_else(|| f.chat.address_of(&r.channel).1);
            (f.chat.orchestrator_in(&r.channel), Some(target))
        }
        Who::Helper(h) => (h.id.clone(), given(&a.id).map(String::from)),
    };
    let opt = ReadOptions {
        target,
        unread: a.unread,
        before: a.before.filter(|b| *b != 0),
        limit: a.limit.filter(|b| *b != 0),
    };
    Ok(match f.chat.read(&me, opt) {
        Ok(r) => match r.messages.first() {
            None if a.unread => format!("{} 里没有你没读的消息", r.target),
            None => format!("{} 里还没有话", r.target),
            Some(first) => {
                let older = if r.older {
                    format!("（更早的还有：before:{} 往前翻）", first.number)
                } else {
                    String::new()
                };
                let lines: Vec<String> = r.messages.iter().map(words::message_line).collect();
                format!("{}{older}：\n{}", r.target, lines.join("\n"))
            }
        },
        Err(e) => format!("读不了：{}", e.message),
    })
}

#[derive(Deserialize)]
pub struct SendArgs {
    #[serde(default)]
    text: String,
    id: Option<String>,
    #[serde(default)]
    anyway: bool,
    #[serde(default)]
    confirm: bool,
    #[serde(rename = "replyTo")]
    reply_to: Option<i64>,
}

pub fn send(f: &Farm, who: &Who, a: SendArgs) -> Result<String, String> {
    let Who::Helper(me) = who else {
        return Err("助手的话就是它的回答，不用这个工具发".into());
    };
    let spoken = f
        .chat
        .speak(Speaking {
            from: me.id.clone(),
            text: a.text,
            run: None,
            target: given(&a.id).map(String::from),
            anyway: a.anyway,
            confirm: a.confirm,
            reply: a.reply_to,
        })
        .map_err(|e| e.message)?;
    Ok(spoken_text(&spoken))
}

#[derive(Deserialize)]
pub struct Nothing {}

pub fn unread(f: &Farm, who: &Who, _: Nothing) -> Result<String, String> {
    let me = match who {
        Who::Orchestrator(r) => f.chat.orchestrator_in(&r.channel),
        Who::Helper(h) => h.id.clone(),
    };
    let rows = f.chat.unread(&me, None);
    let Some(first) = rows.first() else {
        return Ok("没有没读的消息。".into());
    };
    let mut lines: Vec<String> = rows
        .iter()
        .map(|r| {
            let mut line = format!("- {}：{} 条", r.channel, r.unread);
            if r.mentions_you {
                line += "，提到了你";
            }
            if let Some(latest) = r.latest.as_deref().filter(|l| !l.is_empty()) {
                line += &format!("，最后是 {latest}");
            }
            line
        })
        .collect();
    lines.push(format!("下一步：channel_message_list id={} unread=true", first.channel));
    Ok(lines.join("\n"))
}

pub fn channels(f: &Farm, _: &Who, _: Nothing) -> Result<String, String> {
    Ok(f.chat
        .channels()
        .iter()
        .map(|c| format!("- {}", words::channel_line(&c.name, c.default, &c.description, &c.repo)))
        .collect::<Vec<_>>()
        .join("\n"))
}

#[derive(Deserialize)]
pub struct OpenArgs {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    repo: String,
}

pub fn open(f: &Farm, _: &Who, a: OpenArgs) -> Result<String, String> {
    let c = f.chat.open_channel(a.name.trim(), a.description.trim(), a.repo.trim()).map_err(|e| e.message)?;
    let repo = if c.repo.is_empty() {
        String::new()
    } else {
        format!("，默认仓库 {}", c.repo)
    };
    Ok(format!("开好了 #{}{repo}。", c.name))
}

#[derive(Deserialize)]
pub struct UpdateArgs {
    #[serde(default)]
    id: String,
    description: Option<String>,
    repo: Option<String>,
}

pub fn update(f: &Farm, _: &Who, a: UpdateArgs) -> Result<String, String> {
    let id = a.id.trim();
    let c = f
        .chat
        .channel_by_name(id)
        .or_else(|| f.chat.channels().into_iter().find(|c| c.id == id))
        .ok_or_else(|| format!("没有 {id} 这个频道"))?;
    f.chat
        .update_channel(
            &c.id,
            ChannelUpdate {
                description: a.description,
                repo: a.repo,
                name: None,
                category: None,
                before: None,
                members: None,
            },
        )
        .map_err(|e| e.message)?;
    Ok(format!("改好了 #{}。", c.name))
}

fn spoken_text(spoken: &Spoken) -> String {
    match spoken {
        Spoken::Held { target, shown, more } => {
            let lines: Vec<String> = shown.iter().map(words::message_line).collect();
            let latest = if *more > 0 {
                format!("（这里是最新的 {} 条）", shown.len())
            } else {
                String::new()
            };
            [
                format!("先没发：{target} 里有 {} 条你还没看过的新消息{latest}：", shown.len() + more),
                lines.join("\n"),
                String::new(),
                "看过了：要改就改了再发；原样发就加 anyway: true；不用发了就不发。".into(),
            ]
            .join("\n")
        }
        Spoken::Confirm { target, last_read } => {
            format!(
                "先没发：你刚读的是 {last_read}，这条却要发到 {target} 顶层。要回在那个串里，就把 id 写成 {last_read}；确实要发到顶层，就加 confirm: true。"
            )
        }
        Spoken::Sent { message, target, absent } => {
            let absent = if absent.is_empty() {
                String::new()
            } else {
                format!("。{} 不在场，没送到", absent.iter().map(|m| format!("@{m}")).collect::<Vec<_>>().join("、"))
            };
            format!("发出去了：{target} msg={}{absent}", message.number)
        }
    }
}

//! Repos and timers (direct calls into [`crate::repo::Repo`] and [`crate::cron::Scheduler`]).

use serde::Deserialize;
use vibevalley_protocol::{ActorKind, CronRequest, CronWhen, CronWhenDaily, CronWhenEvery, CronWhenExpr, CronWhenOnce, CronWhenWeekly};

use super::{ToolRegistry, Who, given};
use crate::agent::profile::text;

#[derive(Deserialize)]
pub struct Nothing {}

pub async fn repos(f: &ToolRegistry, _who: &Who, _: Nothing) -> Result<String, String> {
    let all = f.repo.list_async().await;
    if all.is_empty() {
        return Ok(format!("工作目录（{}）下还没有仓库。", f.repos_root.display()));
    }
    Ok(all
        .iter()
        .map(|r| format!("- {}{}", r.name, if r.git { "" } else { "（还不是 git 仓库，第一次派活时会建）" }))
        .collect::<Vec<_>>()
        .join("\n"))
}

pub async fn cron_list(f: &ToolRegistry, _who: &Who, _: Nothing) -> Result<String, String> {
    let all = f.cron.list();
    if all.is_empty() {
        return Ok("没有定时。".into());
    }
    let names: std::collections::HashMap<String, String> = f.chat.channels().into_iter().map(|c| (c.id, c.name)).collect();
    Ok(all
        .iter()
        .map(|c| text::cron_line(c, names.get(&c.channel).map(String::as_str).unwrap_or("?")))
        .collect::<Vec<_>>()
        .join("\n"))
}

#[derive(Deserialize)]
pub struct IdArgs {
    #[serde(default)]
    id: String,
}

pub async fn cron_delete(f: &ToolRegistry, _who: &Who, a: IdArgs) -> Result<String, String> {
    let id = a.id.trim().to_string();
    let name = f.cron.list().into_iter().find(|c| c.id == id).map(|c| c.name);
    Ok(match f.cron.remove_async(&id).await {
        Ok(_) => format!("删掉了「{}」。", name.unwrap_or(id)),
        Err(e) => text::failed(&e.message),
    })
}

/// When a timer fires, as a model writes it: `once` takes a time in the forms a model writes.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum When {
    Once {
        #[serde(default)]
        at: String,
    },
    Every {
        #[serde(default)]
        minutes: f64,
    },
    Daily {
        #[serde(default)]
        time: String,
    },
    Weekly {
        #[serde(default)]
        days: Vec<f64>,
        #[serde(default)]
        time: String,
    },
    Cron {
        #[serde(default)]
        expr: String,
    },
}

#[derive(Deserialize)]
pub struct CronArgs {
    #[serde(default)]
    name: String,
    #[serde(default)]
    text: String,
    channel: Option<String>,
    agent: Option<String>,
    repo: Option<String>,
    when: When,
    tz: Option<String>,
}

pub async fn cron_create(f: &ToolRegistry, who: &Who, a: CronArgs) -> Result<String, String> {
    create(f, who, a).await.or_else(|why| Ok(text::failed(&why)))
}

async fn create(f: &ToolRegistry, who: &Who, a: CronArgs) -> Result<String, String> {
    let Who::Orchestrator(here) = who else {
        return Err("定时只有助手能定".into());
    };
    let mut channel = f.chat.top_of(&here.channel);
    if let Some(name) = given(&a.channel) {
        channel = f
            .chat
            .channel_by_name(name)
            .ok_or_else(|| format!("没有 {name} 这个频道：先用 channel_list 看看"))?;
    }
    let when = match a.when {
        When::Once { at } => {
            let ms = parse_time(&at).ok_or_else(|| format!("at 不是一个时间：{}", if at.is_empty() { "（没填）" } else { &at }))?;
            CronWhen::Once(CronWhenOnce { at: ms })
        }
        When::Every { minutes } => CronWhen::Every(CronWhenEvery {
            minutes: minutes.round() as i64,
        }),
        When::Daily { time } => CronWhen::Daily(CronWhenDaily { time }),
        When::Weekly { days, time } => CronWhen::Weekly(CronWhenWeekly {
            days: days.into_iter().map(|d| d.trunc() as i64).collect(),
            time,
        }),
        When::Cron { expr } => CronWhen::Cron(CronWhenExpr { expr }),
    };
    let req = CronRequest {
        name: a.name.trim().into(),
        text: a.text.trim().into(),
        channel: Some(channel.id.clone()),
        agent: given(&a.agent).map(Into::into),
        repo: given(&a.repo).map(Into::into),
        when,
        tz: given(&a.tz).map(Into::into),
    };
    let actor = if here.user { ActorKind::User } else { ActorKind::Agent };
    let made = f.cron.add_async(req, actor).await.map_err(|e| e.message)?;
    let line = text::cron_line(&made, &channel.name);
    Ok(if made.pending {
        format!(
            "定好了，等用户同意才生效：\n{line}\n这一轮不是用户叫你定的，而它会反复来或直接派帮工：用户在定时任务列表里点「同意」才开始。跟用户说一声它是做什么的。"
        )
    } else {
        format!("定好了：\n{line}")
    })
}

/// `parseTime`: the forms a model writes, as an ISO time with its offset.
fn parse_time(s: &str) -> Option<i64> {
    let text = s.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(t) = text.parse::<jiff::Timestamp>() {
        return Some(t.as_millisecond());
    }
    let local = text.parse::<jiff::civil::DateTime>().ok()?;
    local
        .to_zoned_datetime(jiff::tz::TimeZone::system())
        .ok()
        .map(|z| z.timestamp().as_millisecond())
}

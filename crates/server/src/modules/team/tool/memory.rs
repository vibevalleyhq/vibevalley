//! What the helpers' profiles remember.

use serde::Deserialize;

use super::{Farm, Who, given};
use crate::modules::team::memory::{By, Note, found_text};
use crate::modules::team::orchestrator::words;

#[derive(Deserialize)]
pub struct Args {
    agent: Option<String>,
    repo: Option<String>,
    #[serde(default)]
    text: String,
}

/// The profile and repo scope a call reads or writes: a helper's own profile
/// and, unless it names one, the repo it works in; the orchestrator names
/// a helper profile, and its own notes are `remember`'s.
fn scope(f: &Farm, who: &Who, a: &Args, needed: bool) -> Result<(String, String), String> {
    match who {
        Who::Helper(me) => {
            let repo = match &a.repo {
                Some(r) => r.trim().to_string(),
                None => me.repo_name().unwrap_or_default().to_string(),
            };
            Ok((me.profile.clone().unwrap_or_default(), repo))
        }
        Who::Orchestrator(_) => {
            let repo = a.repo.as_deref().unwrap_or("").trim().to_string();
            match given(&a.agent) {
                Some(k) => Ok((profile(f, k)?, repo)),
                None if needed => Err(profile(f, "").unwrap_err()),
                None => Ok((String::new(), repo)),
            }
        }
    }
}

fn profile(f: &Farm, key: &str) -> Result<String, String> {
    const OWN: &str = "你自己的记性在系统提示里：要记用 remember";
    let k = key.trim();
    if k == "助手" {
        return Err(OWN.into());
    }
    let profiles = &f.agents.profiles;
    let a = profiles
        .named(k)
        .or_else(|| profiles.agent(k))
        .or_else(|| profiles.orchestrators().into_iter().find(|o| o.name == k));
    match a {
        Some(a) if profiles.is_orchestrator(&a.id) => Err(OWN.into()),
        Some(a) => Ok(a.id),
        None => Err(words::no_profile_named(k)),
    }
}

pub fn search(f: &Farm, who: &Who, a: Args) -> Result<String, String> {
    let (agent, repo) = match scope(f, who, &a, false) {
        Ok(s) => s,
        Err(why) => return Ok(words::failed(&why)),
    };
    let found = f.memories.search(&agent, &repo, &a.text, 0);
    Ok(found_text(&found, &agent, &repo, &a.text))
}

pub fn create(f: &Farm, who: &Who, a: Args) -> Result<String, String> {
    let (agent, repo) = match scope(f, who, &a, true) {
        Ok(s) => s,
        Err(why) => return Ok(words::failed(&why)),
    };
    let by = match who {
        Who::Helper(me) => By::Session(me.id.clone()),
        Who::Orchestrator(_) => By::Orchestrator,
    };
    let note = Note {
        agent: agent.clone(),
        text: a.text,
        repo,
        by,
    };
    let m = match f.memories.write(&note) {
        Ok(m) => m,
        Err(e) if matches!(who, Who::Helper(_)) => return Err(e.message),
        Err(e) => return Ok(words::failed(&e.message)),
    };
    let place = m.repo.as_deref().map(|r| format!("仓库 {r}")).unwrap_or_else(|| "所有仓库".into());
    Ok(match who {
        Who::Helper(_) => format!("记下了（{place}）〔{}〕", m.id),
        Who::Orchestrator(_) => format!("替 {agent} 记下了（{place}）〔{}〕", m.id),
    })
}

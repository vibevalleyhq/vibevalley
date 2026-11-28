use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use arc_swap::ArcSwap;
use vibevalley_runtime::agent::extensions::memory::{MemoryPort, Remember, RewriteMemory};
use vibevalley_runtime::agent::resources::skills::{LoadSkill, SkillInfo, scan_skills, skill_index};
use vibevalley_runtime::agent::{Brain, Tool, TypedToolAdapter};

use super::state::Orchestrator;
use super::types::{Input, Instance};
use super::words;
use crate::agent::memory::By;
use crate::agent::profile::{Profile, text};
use crate::agent::tool::{Route, held_for};

/// `quotaLow`: a runtime with less left than this is nearly used up.
const QUOTA_LOW: f64 = 15.0;

fn collect_orchestrator_skills(agent_skills_dir: &std::path::Path, user_skills_dir: &std::path::Path, profile: &Profile) -> Vec<SkillInfo> {
    let mut skills = scan_skills(&[agent_skills_dir.to_path_buf(), user_skills_dir.to_path_buf()]);
    let mut seen_ids: HashSet<String> = skills.iter().map(|s| s.id.clone()).collect();
    let mut seen_names: HashSet<String> = skills.iter().map(|s| s.name.clone()).collect();
    for k in profile.skills() {
        if seen_ids.contains(&k.id) || seen_names.contains(&k.name) {
            continue;
        }
        seen_ids.insert(k.id.clone());
        seen_names.insert(k.name.clone());
        let prefix = if k.built_in == Some(true) { "skill://built-in/" } else { "skill://local/" };
        let path = format!("{prefix}{}", k.id);
        let markdown = format!("---\nname: {}\ndescription: {}\n---\n\n{}", k.name, k.description, k.body.trim());
        skills.push(SkillInfo::inline(k.id, k.name, k.description, path, markdown));
    }
    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.name.cmp(&b.name)));
    skills
}

impl Orchestrator {
    pub async fn system_prompt_snapshot_async(&self, id: &str) -> String {
        let home = self.home.join("agent").join(id);
        let memory = self.memory.port_async(id, By::Orchestrator).await;
        self.system_prompt(id, &home, memory.as_ref())
    }

    fn system_prompt(&self, id: &str, home: &std::path::Path, memory: &dyn MemoryPort) -> String {
        let p = &*text::PROMPTS;
        let profile = self.profile.agent(id);
        let mut s = p.system.clone() + &p.agent;
        if id != vibevalley_protocol::DEFAULT_ORCHESTRATOR
            && let Some(a) = &profile
        {
            s += &words::identity_note(&a.name, &a.persona);
        }
        s = s.trim().to_string();
        s += "\n\n";
        s += &p.env.replace("{cwd}", &self.repo.root().display().to_string());
        let skills = collect_orchestrator_skills(&home.join("skills"), &self.home.join("skills"), &self.profile);
        if !skills.is_empty() {
            s += "\n\n";
            s += &p.skills.replace("{skills}", &skill_index(&skills, 160));
        }
        let mem = memory.prompt();
        if !mem.is_empty() {
            s += "\n\n";
            s += &p.memory.replace("{memory}", &mem);
        }
        s
    }

    /// Everything it can call: the farm's tools for where it is, its skills and its memory.
    pub(super) async fn tools_for_async(&self, id: &str, route: &Arc<ArcSwap<Route>>, skills_dir: PathBuf, memory: Arc<dyn MemoryPort>) -> Vec<Box<dyn Tool>> {
        let profile = self.profile.agent(id);
        let mut tools = held_for(&self.tool, route, profile.as_ref());
        if let Some(profile) = profile {
            tools.extend(self.mcp.tools(&profile).await);
        }
        let user_skills_dir = self.home.join("skills");
        let profile_ref = self.profile.clone();
        tools.push(Box::new(LoadSkill {
            skills: Box::new(move || collect_orchestrator_skills(&skills_dir, &user_skills_dir, &profile_ref)),
        }));
        tools.push(Box::new(TypedToolAdapter(Remember(memory.clone()))));
        tools.push(Box::new(TypedToolAdapter(RewriteMemory(memory))));
        tools
    }

    pub(super) async fn brain_at_async(&self, id: &str, route: &Arc<ArcSwap<Route>>, model: &str) -> Brain {
        let home = self.home.join("agent").join(id);
        let skills_dir = home.join("skills");
        let memory = self.memory.port_async(id, By::Orchestrator).await;
        let mut brain = Brain::new(self.client(), model, self.system_prompt(id, &home, memory.as_ref()));
        brain.tools = self.tools_for_async(id, route, skills_dir, memory).await;
        brain
    }

    /// The farm as it is shown before an input (`situation`).
    async fn situation_async(&self, channel: &str) -> String {
        let mut agents = vec![];
        for a in self.profile.managed_workers() {
            let assessed = self.profile.fleet.assess_async(&a).await;
            let p = &assessed.agent;
            let mut traits = vec![];
            if !p.duty.is_empty() {
                traits.push(format!("职责：{}", p.duty));
            }
            if !p.tags.is_empty() {
                traits.push(format!("适合的活：{}", p.tags.join("、")));
            }
            let mut line = words::agent_line(&p.name, &p.id, &p.runtime, &traits.join("；"));
            if p.enabled && assessed.blocking.is_empty() {
                let info = assessed.info.as_ref();
                let quota = info.and_then(|i| i.quota.as_ref());
                let low = quota.and_then(|q| q.left.as_ref()).is_some_and(|l| l.get() < QUOTA_LOW);
                let budget = info.and_then(|i| i.settings.daily_budget.as_ref()).map(|b| b.get()).unwrap_or(0.0);
                let spent = info.and_then(|i| i.spent_today.as_ref()).map(|s| s.get());
                line += &format!("；{}", words::quota_line(quota.map(|q| q.text.as_str()), low, spent, budget));
            } else if let Some(b) = assessed.blocking.first() {
                line += &words::blocked(&b.text);
            } else {
                line += words::DISABLED;
            }
            agents.push(line);
        }
        let roster = self.tool.roster_async().await;
        let default = self.chat.default_channel();
        let channels = self.chat.channels();
        let mut by_channel = Vec::with_capacity(channels.len());
        for c in &channels {
            let mut theirs = Vec::new();
            for h in roster.iter().filter(|h| h.channel_id().unwrap_or(default.as_str()) == c.id) {
                theirs.push(self.tool.session_line_async(h).await);
            }
            let head = text::channel_line(&c.name, c.default, &c.description, &c.repo);
            by_channel.push(format!(
                "{head}\n{}",
                if theirs.is_empty() {
                    words::NO_HELPERS.to_string()
                } else {
                    theirs.join("\n")
                }
            ));
        }
        let repos = self.repo.list_async().await;
        let healths = self.issue.repo_health_list_async(self.ctx.now()).await.unwrap_or_default();
        let folders = if repos.is_empty() {
            words::NO_REPOS.to_string()
        } else {
            repos
                .iter()
                .map(|r| match healths.iter().find(|h| h.repo == r.name) {
                    Some(h) => {
                        let status = match h.status {
                            vibevalley_protocol::RepoHealthStatus::OnTrack => "on_track",
                            vibevalley_protocol::RepoHealthStatus::AtRisk => "at_risk",
                            vibevalley_protocol::RepoHealthStatus::OffTrack => "off_track",
                        };
                        format!("{}（{}）", r.name, status)
                    }
                    None => r.name.clone(),
                })
                .collect::<Vec<_>>()
                .join("、")
        };
        let (direct, target) = self.chat.address_of(channel);
        words::whole(
            &self.repo.root().display().to_string(),
            &folders,
            &agents.join("\n"),
            &by_channel.join("\n"),
            &if direct { words::direct(&target) } else { target },
            &text::users_language(),
        )
    }

    /// The whole input of a turn on `batch`.
    pub(super) async fn input_of_async(&self, me: &Instance, batch: &[Input]) -> String {
        let channel = batch.last().map(|i| i.channel.clone()).unwrap_or_default();
        let situation = self.situation_async(&channel).await;
        let prev = me.shown.swap(Arc::new(situation.clone()));
        let shown = if prev.is_empty() {
            situation
        } else {
            words::situation_delta(&prev, &situation)
        };
        let heard: Vec<String> = self
            .runtime
            .drain_passive_context_async(&me.id)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|entry| entry.payload)
            .collect();
        let news = if heard.is_empty() { String::new() } else { words::news(&heard.join("\n")) };
        let at = jiff::Timestamp::from_millisecond(self.ctx.now())
            .unwrap_or_default()
            .to_zoned_datetime(jiff::tz::TimeZone::system());
        let time = at.strftime("%Y/%-m/%-d %H:%M").to_string();
        let asked: Vec<String> = batch.iter().map(|i| format!("{}{}", i.source.head(), i.line)).collect();
        [words::now_line(&time), shown, news, asked.join("\n\n")]
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

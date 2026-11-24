use std::sync::Arc;

use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, SayRequest};

use super::Chat;
use super::types::{Picked, Saying, Seat};
use crate::app::refusal::{LookIn, missing};
use crate::team::agent::AgentStore;

/// A helper profile's seat in the chat, the peer of its direct channel.
pub fn profile_id(agent: &str) -> String {
    format!("profile:{agent}")
}

/// The orchestrators seated under their profiles' names, each with its
/// direct channel (watch.ts `seatOrchestrator`).
async fn seat_orchestrator_async(chat: &Chat, agents: &AgentStore, agent: &vibevalley_protocol::Agent) -> Result<(), ApiError> {
    if !agents.profiles.is_orchestrator(&agent.id) {
        return Ok(());
    }
    let name = if agent.name.trim().is_empty() {
        t("server.channel.name.orchestrator", &[])
    } else {
        agent.name.trim().to_string()
    };
    chat.seat_async(&Seat {
        id: agent.id.clone(),
        name,
        agent: None,
        home: None,
    })
    .await?;
    chat.create_direct_async(&agent.id).await.map(|_| ())
}

/// Seats every configured orchestrator now and whenever a profile is saved.
pub async fn seat_orchestrators_async(chat: &Arc<Chat>, agents: &Arc<AgentStore>) {
    for agent in agents.profiles.orchestrators() {
        if let Err(e) = seat_orchestrator_async(chat, agents, &agent).await {
            eprintln!("vibevalley-server: chat: seating {}: {}", agent.id, e.message);
        }
    }
    let (c, a) = (Arc::downgrade(chat), Arc::downgrade(agents));
    agents.profiles.when_kept(Arc::new(move |agent| {
        if let (Some(c), Some(a)) = (c.upgrade(), a.upgrade()) {
            let agent = agent.clone();
            let runtime = c.runtime().clone();
            runtime.spawn(async move {
                if let Err(e) = seat_orchestrator_async(&c, &a, &agent).await {
                    eprintln!("vibevalley-server: chat: seating {}: {}", agent.id, e.message);
                }
            });
        }
        Ok(())
    }));
}

/// Async direct channel lookup/creation with a profile (by name or id).
pub async fn direct_async(chat: &Chat, agents: &AgentStore, reference: &str) -> Result<String, ApiError> {
    let name = reference.trim();
    let p = &agents.profiles;
    let agent = p
        .named(name)
        .or_else(|| p.agent(name))
        .or_else(|| p.orchestrators().into_iter().find(|o| o.name == name))
        .ok_or_else(|| missing(t("server.channel.noProfileNamed", &[("key", reference.into())]), LookIn::Agent))?;
    if p.is_orchestrator(&agent.id) {
        seat_orchestrator_async(chat, agents, &agent).await?;
        return chat.create_direct_async(&agent.id).await;
    }
    let seat = profile_id(&agent.id);
    chat.seat_async(&Seat {
        id: seat.clone(),
        name: agent.name.clone(),
        agent: Some(agent.id.clone()),
        home: None,
    })
    .await?;
    chat.create_direct_async(&seat).await
}

/// Handles `channel.message.send` cleanly with optional station selection and block quoting.
pub async fn send_message_async(
    chat: &Arc<Chat>,
    agents: &AgentStore,
    body: SayRequest,
    on_station: Option<&Arc<dyn Fn(i64) + Send + Sync>>,
) -> Result<(), ApiError> {
    if let (Some(station), Some(on_station)) = (body.station, on_station) {
        on_station(station);
    }
    // A profile picked that is not there is not passed on.
    let blocks = match body.blocks {
        Some(refs) if !refs.is_empty() => {
            let c_q = chat.clone();
            crate::spawn_blocking_traced(move || c_q.quoted(&refs)).await.unwrap_or_default()
        }
        _ => Vec::new(),
    };
    let picked = body.agent.as_deref().and_then(|x| agents.profiles.agent(x)).map(|x| x.id);
    chat.say_async(Saying {
        text: body.text,
        channel: Some(body.id),
        send_key: body.send_key.unwrap_or_default(),
        picked: Some(Picked {
            agent: picked,
            repo: body.repo.filter(|r| !r.is_empty()),
        }),
        reply_to: body.reply_to,
        attachments: body.attachments.unwrap_or_default(),
        to: body.to,
        blocks,
        view_context: body.view_context,
        ..Saying::default()
    })
    .await
    .map(|_| ())
}

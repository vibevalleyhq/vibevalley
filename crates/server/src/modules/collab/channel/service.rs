use std::sync::Arc;

use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode, ChannelUpdate, USER_ID, ops, subscriptions};

use super::Chat;
use super::types::{Picked, Saying, Seat};
use crate::Hub;
use crate::base::{LookIn, RequestKeys, missing};
use crate::modules::team::agent::Agents;

/// A helper profile's seat in the chat, the peer of its direct channel.
pub fn profile_id(agent: &str) -> String {
    format!("profile:{agent}")
}

/// The orchestrators seated under their profiles' names, each with its
/// direct channel (watch.ts `seatOrchestrator`).
fn seat_orchestrator(chat: &Chat, agents: &Agents, agent: &vibevalley_protocol::Agent) -> Result<(), ApiError> {
    if !agents.profiles.is_orchestrator(&agent.id) {
        return Ok(());
    }
    let name = if agent.name.trim().is_empty() {
        t("server.channel.name.orchestrator", &[])
    } else {
        agent.name.trim().to_string()
    };
    chat.seat(&Seat {
        id: agent.id.clone(),
        name,
        agent: None,
        home: None,
    })?;
    chat.create_direct(&agent.id).map(|_| ())
}

/// `watch.direct`: the direct channel with a profile (by name or id).
pub fn direct(chat: &Chat, agents: &Agents, reference: &str) -> Result<String, ApiError> {
    let name = reference.trim();
    let p = &agents.profiles;
    let agent = p
        .named(name)
        .or_else(|| p.agent(name))
        .or_else(|| p.orchestrators().into_iter().find(|o| o.name == name))
        .ok_or_else(|| missing(t("server.channel.noProfileNamed", &[("key", reference.into())]), LookIn::Agent))?;
    if p.is_orchestrator(&agent.id) {
        seat_orchestrator(chat, agents, &agent)?;
        return chat.create_direct(&agent.id);
    }
    let seat = profile_id(&agent.id);
    chat.seat(&Seat {
        id: seat.clone(),
        name: agent.name.clone(),
        agent: Some(agent.id.clone()),
        home: None,
    })?;
    chat.create_direct(&seat)
}

/// `channel.*`, `channel.follow`, `channel.reports`; the orchestrators
/// seated now and whenever a profile is kept.
pub fn install(hub: &Hub, chat: Arc<Chat>, agents: Arc<Agents>, on_station: Option<Arc<dyn Fn(i64) + Send + Sync>>) {
    for agent in agents.profiles.orchestrators() {
        if let Err(e) = seat_orchestrator(&chat, &agents, &agent) {
            eprintln!("vibevalley-server: chat: seating {}: {}", agent.id, e.message);
        }
    }
    {
        let (c, a) = (Arc::downgrade(&chat), Arc::downgrade(&agents));
        agents.profiles.when_kept(Arc::new(move |agent| match (c.upgrade(), a.upgrade()) {
            (Some(c), Some(a)) => seat_orchestrator(&c, &a, agent),
            _ => Ok(()),
        }));
    }

    hub.on::<ops::ChannelMessageSend>({
        let (c, a) = (chat.clone(), agents.clone());
        move |_, body| {
            if let (Some(station), Some(on_station)) = (body.station, &on_station) {
                on_station(station);
            }
            // A profile picked that is not there is not passed on.
            let blocks = c.quoted(body.blocks.as_deref().unwrap_or_default());
            let picked = body.agent.as_deref().and_then(|x| a.profiles.agent(x)).map(|x| x.id);
            c.say(Saying {
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
            .map(|_| ())
        }
    });
    hub.on::<ops::ChannelCreate>({
        let c = chat.clone();
        move |_, b| {
            c.open_channel(&b.name, b.description.as_deref().unwrap_or(""), b.repo.as_deref().unwrap_or(""))
                .map(|i| i.id)
        }
    });
    hub.on::<ops::ChannelUpdate>({
        let c = chat.clone();
        move |_, b| {
            c.update_channel(
                &b.id,
                ChannelUpdate {
                    description: b.description,
                    repo: b.repo,
                    name: b.name,
                    category: b.category,
                    before: b.before,
                    members: b.members,
                },
            )
        }
    });
    hub.on::<ops::ChannelArchiveSet>({
        let c = chat.clone();
        move |_, b| c.archive(&b.id, b.on)
    });
    hub.on::<ops::ChannelDelete>({
        let c = chat.clone();
        move |_, b| c.remove_channel(&b.id)
    });
    hub.on::<ops::ChannelPreviewDelete>({
        let c = chat.clone();
        move |_, b| c.preview_remove_channel(&b.id)
    });
    hub.on::<ops::ChannelNotifySet>({
        let c = chat.clone();
        move |_, b| c.set_notify(&b.id, b.notify)
    });
    hub.on::<ops::ChannelDirectCreate>({
        let (c, a) = (chat.clone(), agents.clone());
        move |_, b| direct(&c, &a, &b.agent)
    });
    hub.on::<ops::ChannelMarkUnread>({
        let c = chat.clone();
        move |_, b| c.mark_unread(&b.id, b.number)
    });
    hub.on::<ops::ChannelList>({
        let c = chat.clone();
        move |_, ()| c.list()
    });
    hub.on::<ops::ChannelUnreadList>({
        let c = chat.clone();
        move |_, ()| Ok(c.unread(USER_ID, None))
    });
    hub.on::<ops::ChannelDefaultSet>({
        let c = chat.clone();
        move |_, b| c.make_default(&b.id)
    });
    hub.on::<ops::ChannelMessageList>({
        let c = chat.clone();
        move |_, b| c.history(&b.id, b.before, b.limit)
    });
    hub.on::<ops::ChannelMarkRead>({
        let c = chat.clone();
        move |_, b| {
            c.mark_read(&b.id, b.number)
                .map_err(|e| ApiError::new(BizCode::ChannelNotFound, e.message).with_next(vec![LookIn::Channel.next()]))
        }
    });
    hub.on::<ops::ChannelMessageUpdate>({
        let c = chat.clone();
        move |_, b| c.edit(&b.id, &b.text, b.attachments.as_deref())
    });
    hub.on::<ops::ChannelMessageDelete>({
        let c = chat.clone();
        move |_, b| c.remove(&b.id)
    });
    hub.on::<ops::ChannelMessagePreviewDelete>({
        let c = chat.clone();
        move |_, b| c.preview_remove(&b.id)
    });
    hub.on::<ops::ChannelMessageSearch>({
        let c = chat.clone();
        move |_, b| c.search(&b.text, b.channel.as_deref())
    });
    hub.on::<ops::ChannelReactionSet>({
        let c = chat.clone();
        move |_, b| c.react(&b.id, USER_ID, &b.emoji, b.on)
    });
    hub.on::<ops::ChannelPinSet>({
        let c = chat.clone();
        move |_, b| c.pin(&b.id, b.on)
    });
    hub.on::<ops::ChannelPinList>({
        let c = chat.clone();
        move |_, b| c.pins(&b.id)
    });
    let thread_once = Arc::new(RequestKeys::<String>::default());
    hub.on::<ops::ChannelThreadCreate>({
        let c = chat.clone();
        move |_, b| thread_once.once(b.request_key.as_deref(), || c.thread_under(&b.id))
    });
    hub.on_subscription::<subscriptions::ChannelFollow>({
        let c = chat.clone();
        move |_, p, sink| c.follow(&p.id, p.after, sink)
    });
    hub.on_subscription::<subscriptions::ChannelReports>(move |_, p, sink| chat.reports(p.after, sink));
}

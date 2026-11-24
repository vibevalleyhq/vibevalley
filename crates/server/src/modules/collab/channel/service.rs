use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use tokio::sync::Mutex as AsyncMutex;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, BizCode, ChannelUpdate, USER_ID, ops, subscriptions};

use super::Chat;
use super::types::{Picked, Saying, Seat};
use crate::Hub;
use crate::base::{LookIn, missing};
use crate::modules::team::agent::Agents;

const REQUEST_KEY_MAX: usize = 64;
const REQUEST_KEYS_KEPT: usize = 500;
const REQUEST_KEY_TTL_MS: i64 = 5 * 60_000;

type Answered<T> = (Vec<String>, HashMap<String, (i64, T)>);

/// Async idempotency gate matching `base::RequestKeys` without holding a sync mutex across `.await`.
struct AsyncRequestKeys<T> {
    seen: AsyncMutex<Answered<T>>,
}

impl<T> Default for AsyncRequestKeys<T> {
    fn default() -> Self {
        Self {
            seen: AsyncMutex::new((Vec::new(), HashMap::new())),
        }
    }
}

impl<T: Clone> AsyncRequestKeys<T> {
    async fn once(&self, key: Option<&str>, work: impl Future<Output = Result<T, ApiError>>) -> Result<T, ApiError> {
        let Some(key) = key.filter(|k| !k.is_empty()) else { return work.await };
        if key.chars().count() > REQUEST_KEY_MAX {
            return Err(ApiError::new(
                BizCode::RequestKeyTooLong,
                t("server.base.requestKeyLong", &[("max", REQUEST_KEY_MAX.into())]),
            ));
        }
        // Held while working: a duplicate waits for the first answer.
        let mut seen = self.seen.lock().await;
        if let Some((expires, done)) = seen.1.get(key)
            && *expires > crate::now()
        {
            return Ok(done.clone());
        }
        let done = work.await?;
        seen.0.retain(|k| k != key);
        seen.0.push(key.to_string());
        seen.1.insert(key.to_string(), (crate::now() + REQUEST_KEY_TTL_MS, done.clone()));
        while seen.0.len() > REQUEST_KEYS_KEPT {
            let old = seen.0.remove(0);
            seen.1.remove(&old);
        }
        Ok(done)
    }
}

/// A helper profile's seat in the chat, the peer of its direct channel.
pub fn profile_id(agent: &str) -> String {
    format!("profile:{agent}")
}

/// The orchestrators seated under their profiles' names, each with its
/// direct channel (watch.ts `seatOrchestrator`).
async fn seat_orchestrator_async(chat: &Chat, agents: &Agents, agent: &vibevalley_protocol::Agent) -> Result<(), ApiError> {
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

fn seat_orchestrator(chat: &Chat, agents: &Agents, agent: &vibevalley_protocol::Agent) -> Result<(), ApiError> {
    crate::modules::collab::block_on(seat_orchestrator_async(chat, agents, agent))
}

/// Async direct channel lookup/creation with a profile (by name or id).
pub async fn direct_async(chat: &Chat, agents: &Agents, reference: &str) -> Result<String, ApiError> {
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

    hub.on_async::<ops::ChannelMessageSend, _, _>({
        let (c, a, on_station) = (chat.clone(), agents.clone(), on_station);
        move |_, body| {
            let (c, a, on_station) = (c.clone(), a.clone(), on_station.clone());
            async move {
                if let (Some(station), Some(on_station)) = (body.station, &on_station) {
                    on_station(station);
                }
                // A profile picked that is not there is not passed on.
                let blocks = match body.blocks {
                    Some(refs) if !refs.is_empty() => {
                        let c_q = c.clone();
                        crate::spawn_blocking_traced(move || c_q.quoted(&refs)).await.unwrap_or_default()
                    }
                    _ => Vec::new(),
                };
                let picked = body.agent.as_deref().and_then(|x| a.profiles.agent(x)).map(|x| x.id);
                c.say_async(Saying {
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
        }
    });
    hub.on_async::<ops::ChannelCreate, _, _>({
        let c = chat.clone();
        move |_, b| {
            let c = c.clone();
            async move {
                c.open_channel_async(&b.name, b.description.as_deref().unwrap_or(""), b.repo.as_deref().unwrap_or(""))
                    .await
                    .map(|i| i.id)
            }
        }
    });
    hub.on_async::<ops::ChannelUpdate, _, _>({
        let c = chat.clone();
        move |_, b| {
            let c = c.clone();
            async move {
                c.update_channel_async(
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
                .await
            }
        }
    });
    hub.on_async::<ops::ChannelArchiveSet, _, _>({
        let c = chat.clone();
        move |_, b| {
            let c = c.clone();
            async move { c.archive_async(&b.id, b.on).await }
        }
    });
    hub.on_async::<ops::ChannelDelete, _, _>({
        let c = chat.clone();
        move |_, b| {
            let c = c.clone();
            async move { c.remove_channel_async(&b.id).await }
        }
    });
    hub.on_async::<ops::ChannelPreviewDelete, _, _>({
        let c = chat.clone();
        move |_, b| {
            let c = c.clone();
            async move { c.preview_remove_channel_async(&b.id).await }
        }
    });
    hub.on_async::<ops::ChannelNotifySet, _, _>({
        let c = chat.clone();
        move |_, b| {
            let c = c.clone();
            async move { c.set_notify_async(&b.id, b.notify).await }
        }
    });
    hub.on_async::<ops::ChannelDirectCreate, _, _>({
        let (c, a) = (chat.clone(), agents.clone());
        move |_, b| {
            let (c, a) = (c.clone(), a.clone());
            async move { direct_async(&c, &a, &b.agent).await }
        }
    });
    hub.on_async::<ops::ChannelMarkUnread, _, _>({
        let c = chat.clone();
        move |_, b| {
            let c = c.clone();
            async move { c.mark_unread_async(&b.id, b.number).await }
        }
    });
    hub.on_async::<ops::ChannelList, _, _>({
        let c = chat.clone();
        move |_, ()| {
            let c = c.clone();
            async move { c.list_async().await }
        }
    });
    hub.on_async::<ops::ChannelUnreadList, _, _>({
        let c = chat.clone();
        move |_, ()| {
            let c = c.clone();
            async move { Ok(c.unread_async(USER_ID, None).await) }
        }
    });
    hub.on_async::<ops::ChannelDefaultSet, _, _>({
        let c = chat.clone();
        move |_, b| {
            let c = c.clone();
            async move { c.make_default_async(&b.id).await }
        }
    });
    hub.on_async::<ops::ChannelMessageList, _, _>({
        let c = chat.clone();
        move |_, b| {
            let c = c.clone();
            async move { c.history_async(&b.id, b.before, b.limit).await }
        }
    });
    hub.on_async::<ops::ChannelMarkRead, _, _>({
        let c = chat.clone();
        move |_, b| {
            let c = c.clone();
            async move {
                c.mark_read_async(&b.id, b.number)
                    .await
                    .map_err(|e| ApiError::new(BizCode::ChannelNotFound, e.message).with_next(vec![LookIn::Channel.next()]))
            }
        }
    });
    hub.on_async::<ops::ChannelMessageUpdate, _, _>({
        let c = chat.clone();
        move |_, b| {
            let c = c.clone();
            async move { c.edit_async(&b.id, &b.text, b.attachments.as_deref()).await }
        }
    });
    hub.on_async::<ops::ChannelMessageDelete, _, _>({
        let c = chat.clone();
        move |_, b| {
            let c = c.clone();
            async move { c.remove_async(&b.id).await }
        }
    });
    hub.on_async::<ops::ChannelMessagePreviewDelete, _, _>({
        let c = chat.clone();
        move |_, b| {
            let c = c.clone();
            async move { c.preview_remove_async(&b.id).await }
        }
    });
    hub.on_async::<ops::ChannelMessageSearch, _, _>({
        let c = chat.clone();
        move |_, b| {
            let c = c.clone();
            async move { c.search_async(&b.text, b.channel.as_deref()).await }
        }
    });
    hub.on_async::<ops::ChannelReactionSet, _, _>({
        let c = chat.clone();
        move |_, b| {
            let c = c.clone();
            async move { c.react_async(&b.id, USER_ID, &b.emoji, b.on).await }
        }
    });
    hub.on_async::<ops::ChannelPinSet, _, _>({
        let c = chat.clone();
        move |_, b| {
            let c = c.clone();
            async move { c.pin_async(&b.id, b.on).await }
        }
    });
    hub.on_async::<ops::ChannelPinList, _, _>({
        let c = chat.clone();
        move |_, b| {
            let c = c.clone();
            async move { c.pins_async(&b.id).await }
        }
    });
    let thread_once = Arc::new(AsyncRequestKeys::<String>::default());
    hub.on_async::<ops::ChannelThreadCreate, _, _>({
        let c = chat.clone();
        move |_, b| {
            let c = c.clone();
            let thread_once = thread_once.clone();
            async move { thread_once.once(b.request_key.as_deref(), c.thread_under_async(&b.id)).await }
        }
    });
    hub.on_subscription::<subscriptions::ChannelFollow>({
        let c = chat.clone();
        move |_, p, sink| c.follow(&p.id, p.after, sink)
    });
    hub.on_subscription::<subscriptions::ChannelReports>(move |_, p, sink| chat.reports(p.after, sink));
}

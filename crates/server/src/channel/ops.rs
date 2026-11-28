//! Agent-seat helpers and `pub(crate)` domain router dispatch handlers for all
//! `Channel*` endpoints, keeping `router.rs` free of channel domain logic.

use vibevalley_i18n::t;
use vibevalley_protocol::{
    Agent, ApiError, BizCode, CallState, Channel, ChannelUnread, ChannelUpdate, ChatMessage, MessageHit, Op, ParticipantId, Preview, ops,
};

use super::service::Chat;
use super::types::{Picked, Saying, Seat, agent_seat_id, local_user_id};
use crate::context::{LookIn, missing};

impl Chat {
    /// Seats an orchestrator under its profile name and ensures its direct channel exists.
    pub async fn seat_orchestrator_async(&self, agent: &Agent) -> Result<(), ApiError> {
        let name = if agent.name.trim().is_empty() {
            t("server.channel.name.orchestrator", &[])
        } else {
            agent.name.trim().to_string()
        };
        self.seat_async(&Seat {
            id: agent.id.clone(),
            name,
            agent: None,
            home: None,
        })
        .await?;
        self.create_direct_async(&agent.id).await.map(|_| ())
    }

    /// Creates or retrieves the direct channel with a resolved agent profile.
    pub async fn direct_with_agent_async(&self, agent: &Agent, is_orchestrator: bool) -> Result<String, ApiError> {
        if is_orchestrator {
            self.seat_orchestrator_async(agent).await?;
            return self.create_direct_async(&agent.id).await;
        }
        let seat = agent_seat_id(&agent.id);
        self.seat_async(&Seat {
            id: seat.clone(),
            name: agent.name.clone(),
            agent: Some(agent.id.clone()),
            home: None,
        })
        .await?;
        self.create_direct_async(&seat).await
    }

    /// Handles `channel.message.send` with optional station selection and async block quoting.
    /// Returns `true` when sending transitioned the live call banner into [`CallState::Live`].
    pub(crate) async fn handle_message_send(
        &self,
        body: <ops::ChannelMessageSend as Op>::Input,
        picked_agent: Option<String>,
        on_station: Option<&(dyn Fn(i64) + Send + Sync)>,
    ) -> Result<bool, ApiError> {
        if let (Some(station), Some(on_station)) = (body.station, on_station) {
            on_station(station);
        }
        let was_idle = self.ctx.live.call_snapshot().0 != CallState::Live;
        self.say_async(Saying {
            text: body.text,
            from: body.from,
            from_name: body.from_name,
            channel: Some(body.id),
            send_key: body.send_key.unwrap_or_default(),
            picked: Some(Picked {
                agent: picked_agent,
                repo: body.repo.filter(|r| !r.is_empty()),
            }),
            reply_to: body.reply_to,
            attachments: body.attachments.unwrap_or_default(),
            to: body.to,
            view_context: body.view_context,
            command: body.command,
            ..Saying::default()
        })
        .await?;
        Ok(was_idle && self.ctx.live.call_snapshot().0 == CallState::Live)
    }

    pub(crate) async fn handle_create(&self, req: <ops::ChannelCreate as Op>::Input) -> Result<String, ApiError> {
        let created = self
            .open_channel_async(&req.name, req.description.as_deref().unwrap_or(""), req.repo.as_deref().unwrap_or(""))
            .await?;
        Ok(created.id)
    }

    pub(crate) async fn handle_update(&self, req: <ops::ChannelUpdate as Op>::Input) -> Result<(), ApiError> {
        self.update_channel_async(
            &req.id,
            ChannelUpdate {
                description: req.description,
                repo: req.repo,
                name: req.name,
                category: req.category,
                before: req.before,
                members: req.members,
            },
        )
        .await
    }

    pub(crate) async fn handle_message_list(&self, req: <ops::ChannelMessageList as Op>::Input) -> Result<Vec<ChatMessage>, ApiError> {
        self.history_async(&req.id, req.before, req.limit).await
    }

    pub(crate) async fn handle_mark_read(&self, req: <ops::ChannelMarkRead as Op>::Input) -> Result<(), ApiError> {
        let who = req.from.unwrap_or_else(ParticipantId::local_user);
        self.mark_read_as_async(&who, &req.id, req.number)
            .await
            .map_err(|e| ApiError::new(BizCode::ChannelNotFound, e.message).with_next(vec![LookIn::Channel.next()]))
    }

    pub(crate) async fn handle_message_update(&self, req: <ops::ChannelMessageUpdate as Op>::Input) -> Result<ChatMessage, ApiError> {
        let who = req.from.unwrap_or_else(ParticipantId::local_user);
        self.edit_as_async(&who, &req.id, &req.text, req.attachments.as_deref()).await
    }

    pub(crate) async fn handle_message_delete(&self, req: <ops::ChannelMessageDelete as Op>::Input) -> Result<(), ApiError> {
        self.remove_async(&req.id).await
    }

    pub(crate) async fn handle_message_preview_delete(&self, req: <ops::ChannelMessagePreviewDelete as Op>::Input) -> Result<Preview, ApiError> {
        self.preview_remove_async(&req.id).await
    }

    pub(crate) async fn handle_message_search(&self, req: <ops::ChannelMessageSearch as Op>::Input) -> Result<Vec<MessageHit>, ApiError> {
        self.search_async(&req.text, req.channel.as_deref()).await
    }

    pub(crate) async fn handle_reaction_set(&self, req: <ops::ChannelReactionSet as Op>::Input) -> Result<ChatMessage, ApiError> {
        let who = req.from.unwrap_or_else(ParticipantId::local_user).to_string();
        self.react_async(&req.id, &who, &req.emoji, req.on).await
    }

    pub(crate) async fn handle_pin_set(&self, req: <ops::ChannelPinSet as Op>::Input) -> Result<ChatMessage, ApiError> {
        self.pin_async(&req.id, req.on).await
    }

    pub(crate) async fn handle_pin_list(&self, req: <ops::ChannelPinList as Op>::Input) -> Result<Vec<ChatMessage>, ApiError> {
        self.pins_async(&req.id).await
    }

    pub(crate) async fn handle_thread_create(&self, req: <ops::ChannelThreadCreate as Op>::Input) -> Result<String, ApiError> {
        self.create_thread_async(&req.id, req.request_key.as_deref()).await
    }

    pub(crate) async fn handle_archive_set(&self, req: <ops::ChannelArchiveSet as Op>::Input) -> Result<(), ApiError> {
        self.archive_async(&req.id, req.on).await
    }

    pub(crate) async fn handle_delete(&self, req: <ops::ChannelDelete as Op>::Input) -> Result<(), ApiError> {
        self.remove_channel_async(&req.id).await
    }

    pub(crate) async fn handle_preview_delete(&self, req: <ops::ChannelPreviewDelete as Op>::Input) -> Result<Preview, ApiError> {
        self.preview_remove_channel_async(&req.id).await
    }

    pub(crate) async fn handle_direct_create(
        &self,
        resolved: Option<(&Agent, bool)>,
        reference: &str,
        from: Option<ParticipantId>,
    ) -> Result<String, ApiError> {
        if let Some(peer) = ParticipantId::parse(reference).filter(ParticipantId::is_human) {
            let initiator = from.unwrap_or_else(ParticipantId::local_user);
            return self.create_direct_between_async(&initiator, &peer).await;
        }
        let Some((agent, is_orchestrator)) = resolved else {
            return Err(missing(t("server.channel.noProfileNamed", &[("key", reference.into())]), LookIn::Agent));
        };
        self.direct_with_agent_async(agent, is_orchestrator).await
    }

    pub(crate) async fn handle_notify_set(&self, req: <ops::ChannelNotifySet as Op>::Input) -> Result<(), ApiError> {
        self.set_notify_async(&req.id, req.notify).await
    }

    pub(crate) async fn handle_mark_unread(&self, req: <ops::ChannelMarkUnread as Op>::Input) -> Result<(), ApiError> {
        let who = req.from.unwrap_or_else(ParticipantId::local_user);
        self.mark_unread_as_async(&who, &req.id, req.number).await
    }

    pub(crate) async fn handle_list(&self) -> Result<Vec<Channel>, ApiError> {
        self.list_async().await
    }

    pub(crate) async fn handle_unread_list(&self) -> Vec<ChannelUnread> {
        self.unread_async(&local_user_id(), None).await
    }
}

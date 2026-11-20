//! The chat as the state keeps it.

use vibevalley_protocol::*;

use crate::rules::{actor_role_of, compare_text};

/// The state keeps at most these many channels; the database keeps all.
pub const KEEP_CHANNELS: usize = 100;

/// `targetOf`: a place's address as an agent writes it.
pub fn target_of(c: &Channel, channel_name: &str) -> String {
    if c.r#type == ChannelType::Direct {
        return format!("@{USER_ID}");
    }
    if c.r#type == ChannelType::Thread
        && let Some(root) = c.root_number
    {
        return format!("#{channel_name}:{root}");
    }
    format!("#{}", c.name.as_deref().unwrap_or(channel_name))
}

fn empty_chat() -> Chat {
    Chat {
        channels: vec![],
        user_mentions: vec![],
    }
}

/// `withUserMentions`.
pub fn with_user_mentions(chat: &mut Option<Chat>, mentions: Vec<UserMention>) {
    chat.get_or_insert_with(empty_chat).user_mentions = mentions;
}

/// `withMessage`: news when its number is past what the state knows of its
/// channel, or when the state does not keep that channel.
pub fn with_message(chat: &mut Option<Chat>, m: &ChatMessage) -> bool {
    let Some(chat) = chat else { return true };
    let Some(c) = chat.channels.iter_mut().find(|x| x.id == m.channel) else {
        return true;
    };
    if m.number <= c.last_number.unwrap_or(0) {
        return false;
    }
    c.last_number = Some(m.number);
    true
}

/// `withChannel`: beyond `KEEP_CHANNELS` the quietest threads go.
pub fn with_channel(chat: &mut Option<Chat>, c: Channel) {
    let base = chat.get_or_insert_with(empty_chat);
    base.channels.retain(|x| x.id != c.id);
    base.channels.push(c);
    if base.channels.len() > KEEP_CHANNELS {
        let top = |x: &Channel| i32::from(x.r#type != ChannelType::Thread);
        let mut ranked: Vec<&Channel> = base.channels.iter().collect();
        ranked.sort_by(|a, b| top(b).cmp(&top(a)).then(b.last_number.unwrap_or(0).cmp(&a.last_number.unwrap_or(0))));
        let keep: std::collections::HashSet<String> = ranked[..KEEP_CHANNELS].iter().map(|x| x.id.clone()).collect();
        base.channels.retain(|x| keep.contains(&x.id));
    }
    base.channels.sort_by(|a, b| compare_text(&a.id, &b.id));
}

/// `forUser`: whether a message is for the user to read.
pub fn for_user(m: &ChatMessage, notify: Notify) -> bool {
    let mentions_user = m.mentions.iter().any(|x| x == USER_ID || x == EVERYONE);
    if m.from == USER_ID || notify == Notify::None {
        return false;
    }
    if notify == Notify::Mentions {
        return mentions_user;
    }
    match m.kind {
        MessageKind::Report | MessageKind::Dispatch => true,
        MessageKind::Chat => actor_role_of(&m.actor) == Some(AgentRole::Orchestrator) || mentions_user,
        MessageKind::Notice => false,
    }
}

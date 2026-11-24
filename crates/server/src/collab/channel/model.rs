//! The chat kept in memory beside its tables (VibeValley
//! `modules/channel/rooms.ts`): changed only after the write it mirrors is
//! committed.

use std::collections::{BTreeSet, HashMap};

use vibevalley_core::rules::compare_text;

use super::db::{ChannelRow, ParticipantRow};

fn subject_key(kind: &str, id: &str) -> String {
    format!("{kind}:{id}")
}

/// Who is in each place.
#[derive(Clone, Default)]
pub struct Members {
    members: HashMap<String, BTreeSet<String>>,
}

impl Members {
    pub fn load(&mut self, follows: &[(String, String)]) {
        self.members.clear();
        for (c, p) in follows {
            self.member_added(c, p);
        }
    }

    pub fn member_added(&mut self, channel: &str, participant: &str) {
        self.members.entry(channel.into()).or_default().insert(participant.into());
    }

    pub fn member_removed(&mut self, channel: &str, participant: &str) {
        if let Some(held) = self.members.get_mut(channel)
            && held.remove(participant)
            && held.is_empty()
        {
            self.members.remove(channel);
        }
    }

    pub fn channel_removed(&mut self, channel: &str) {
        self.members.remove(channel);
    }

    pub fn left(&mut self, participant: &str) {
        self.members.retain(|_, held| {
            held.remove(participant);
            !held.is_empty()
        });
    }

    /// Sorted.
    pub fn members_of(&self, channel: &str) -> Vec<String> {
        self.members.get(channel).map(|m| m.iter().cloned().collect()).unwrap_or_default()
    }
}

#[derive(Clone, Default)]
pub struct ChatModel {
    by_id: HashMap<String, ChannelRow>,
    thread_by_root: HashMap<String, String>,
    thread_by_subject: HashMap<String, String>,
    people: Vec<ParticipantRow>,
    user_read: HashMap<String, i64>,
    members: Members,
    /// The target each participant last read, for `speak`'s confirmation.
    pub last_read: HashMap<String, String>,
    published_last: HashMap<String, i64>,
}

impl ChatModel {
    pub fn load(&mut self, channels: Vec<ChannelRow>, participants: Vec<ParticipantRow>, user_read: Vec<(String, i64)>, follows: &[(String, String)]) {
        *self = ChatModel::default();
        for c in channels {
            self.created(c);
        }
        self.people = participants;
        self.user_read = user_read.into_iter().collect();
        self.members.load(follows);
    }

    pub fn channel(&self, id: &str) -> Option<&ChannelRow> {
        self.by_id.get(id)
    }

    pub fn thread_of_root(&self, root: &str) -> Option<&str> {
        self.thread_by_root.get(root).map(String::as_str)
    }

    /// The newest thread about a subject (thread ids sort by time).
    pub fn thread_of_subject(&self, kind: &str, id: &str) -> Option<&str> {
        self.thread_by_subject.get(&subject_key(kind, id)).map(String::as_str)
    }

    pub fn default_channel(&self) -> Option<&ChannelRow> {
        self.by_id.values().find(|c| c.is_default)
    }

    pub fn default_id(&self) -> String {
        self.default_channel().map(|c| c.id.clone()).unwrap_or_default()
    }

    /// A direct channel's, or what is not there's, is the default channel.
    pub fn top_channel(&self, id: &str) -> Option<&ChannelRow> {
        match self.by_id.get(id) {
            None => self.default_channel(),
            Some(row) if row.r#type == "direct" => self.default_channel(),
            Some(row) if row.r#type == "thread" => row.parent_id.as_deref().and_then(|p| self.by_id.get(p)).or_else(|| self.default_channel()),
            Some(row) => Some(row),
        }
    }

    pub fn channel_by_name(&self, name: &str) -> Option<&ChannelRow> {
        self.by_id.values().find(|c| c.name.as_deref() == Some(name) && c.r#type == "channel")
    }

    /// The default first, then by place, then oldest.
    pub fn channels(&self, kind: &str) -> Vec<ChannelRow> {
        let mut all: Vec<ChannelRow> = self.by_id.values().filter(|c| c.r#type == kind).cloned().collect();
        let place = |c: &ChannelRow| c.position.unwrap_or(i64::MAX);
        all.sort_by(|a, b| {
            b.is_default
                .cmp(&a.is_default)
                .then(place(a).cmp(&place(b)))
                .then_with(|| compare_text(&a.id, &b.id))
        });
        all
    }

    pub fn threads_of(&self, channel: &str) -> Vec<ChannelRow> {
        self.by_id.values().filter(|c| c.parent_id.as_deref() == Some(channel)).cloned().collect()
    }

    pub fn created(&mut self, row: ChannelRow) {
        if let Some(root) = &row.root_id {
            self.thread_by_root.insert(root.clone(), row.id.clone());
        }
        if let (Some(kind), Some(id)) = (&row.subject_kind, &row.subject_id) {
            let key = subject_key(kind, id);
            if self.thread_by_subject.get(&key).is_none_or(|held| held.as_str() < row.id.as_str()) {
                self.thread_by_subject.insert(key, row.id.clone());
            }
        }
        self.by_id.insert(row.id.clone(), row);
    }

    pub fn patch(&mut self, id: &str, f: impl FnOnce(&mut ChannelRow)) {
        if let Some(c) = self.by_id.get_mut(id) {
            f(c);
        }
    }

    pub fn removed(&mut self, id: &str) {
        let gone: Vec<ChannelRow> = self
            .by_id
            .values()
            .filter(|c| c.id == id || c.parent_id.as_deref() == Some(id))
            .cloned()
            .collect();
        for c in gone {
            self.by_id.remove(&c.id);
            self.user_read.remove(&c.id);
            self.published_last.remove(&c.id);
            self.members.channel_removed(&c.id);
            if let Some(root) = &c.root_id {
                self.thread_by_root.remove(root);
            }
            if let (Some(kind), Some(sid)) = (&c.subject_kind, &c.subject_id) {
                let key = subject_key(kind, sid);
                if self.thread_by_subject.get(&key) == Some(&c.id) {
                    self.thread_by_subject.remove(&key);
                }
            }
        }
    }

    /// `markUnread` moves the user's cursor back.
    pub fn user_read_back(&mut self, channel: &str, number: i64) {
        self.user_read.insert(channel.into(), number);
    }

    pub fn default_moved(&mut self, from: &str, to: &str) {
        self.patch(from, |c| c.is_default = false);
        self.patch(to, |c| c.is_default = true);
    }

    pub fn touched(&mut self, id: &str, number: i64) {
        self.patch(id, |c| {
            c.last_number = Some(c.last_number.unwrap_or(0).max(number));
            if c.r#type == "thread" {
                c.reply_count += 1;
            }
        });
    }

    pub fn participants(&self) -> &[ParticipantRow] {
        &self.people
    }

    pub fn participant(&self, id: &str) -> Option<&ParticipantRow> {
        self.people.iter().find(|p| p.id == id)
    }

    /// One who rejoins keeps its kind and when it first joined; a home of
    /// none keeps the one it had.
    pub fn joined(&mut self, p: ParticipantRow) {
        if let Some(held) = self.people.iter_mut().find(|h| h.id == p.id) {
            held.name = p.name;
            held.agent_id = p.agent_id;
            if p.home_id.is_some() {
                held.home_id = p.home_id;
            }
            held.left_at = None;
        } else {
            self.people.push(ParticipantRow { left_at: None, ..p });
        }
    }

    pub fn left(&mut self, id: &str, at: i64) {
        self.members.left(id);
        self.last_read.remove(id);
        if let Some(p) = self.people.iter_mut().find(|p| p.id == id)
            && p.left_at.is_none()
        {
            p.left_at = Some(at);
        }
    }

    pub fn member_added(&mut self, channel: &str, participant: &str) {
        self.members.member_added(channel, participant);
    }

    pub fn member_removed(&mut self, channel: &str, participant: &str) {
        self.members.member_removed(channel, participant);
    }

    pub fn members_of(&self, channel: &str) -> Vec<String> {
        self.members.members_of(channel)
    }

    pub fn published_number(&self, channel: &str) -> Option<i64> {
        self.published_last.get(channel).copied()
    }

    pub fn note_published(&mut self, channel: &str, number: i64) {
        let n = self.published_last.entry(channel.into()).or_insert(0);
        *n = (*n).max(number);
    }

    pub fn user_read_in(&self, channel: &str) -> Option<i64> {
        self.user_read.get(channel).copied()
    }

    pub fn user_read_to(&mut self, channel: &str, number: i64) {
        let n = self.user_read.entry(channel.into()).or_insert(number);
        *n = (*n).max(number);
    }
}

#[cfg(test)]
mod tests {
    use super::Members;

    #[test]
    fn members_load_and_update() {
        let mut follows = Members::default();
        follows.load(&[("t".into(), "w3".into())]);
        follows.member_added("t", "w1");
        follows.member_added("t", "w3");
        assert_eq!(follows.members_of("t"), ["w1", "w3"]);
        assert!(follows.members_of("other").is_empty());
    }

    #[test]
    fn a_session_that_left_is_forgotten() {
        let mut follows = Members::default();
        follows.load(&[("t".into(), "w3".into()), ("u".into(), "w3".into()), ("u".into(), "w1".into())]);
        follows.left("w3");
        assert!(follows.members_of("t").is_empty());
        assert_eq!(follows.members_of("u"), ["w1"]);
    }
}

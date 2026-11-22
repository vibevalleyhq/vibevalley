use sqlx::SqliteConnection;
use vibevalley_i18n::{list, t};
use vibevalley_protocol::{
    ApiError, Attachment, CallState, ChatMessage, Fact, FactCallChanged, MessageHit, MessageKind, NoticeLevel, Preview, SubjectKind, USER_ID,
};

use super::db::{self, EventRow, MsgRow};
use super::store::{Q, tx};
use super::types::{
    AddressedMessage, Made, Meta, Note, Noticing, Picked, Posting, Saying, Speaking, Spoken, ThreadSubject, Told, Write, line_of, meta_of, meta_text,
    reactions_of, reactions_text, to_message,
};
use super::words::{self, Has};
use super::{BeforePost, Chat, HELD_SHOWN, LAST_MAX, NO_NUMBER, RETRY_WINDOW_MS, SEARCH_MAX, SEND_KEY_MAX, no_channel, publish, refused};
use crate::base::{LookIn, missing};
use crate::now;

impl Chat {
    /// `say`: the user's words in a place; the farm goes live.
    pub fn say(&self, s: Saying) -> Result<(ChatMessage, bool), ApiError> {
        let written = {
            let mut inner = self.locked();
            if let Some(hub) = self.hub.upgrade()
                && hub.read(|st| st.call != CallState::Live)
            {
                hub.apply(vec![Fact::CallChanged(FactCallChanged {
                    at: now(),
                    state: CallState::Live,
                    reason: String::new(),
                })]);
            }
            let files = self.files.of(&s.attachments)?;
            if s.text.trim().is_empty() && files.is_empty() {
                return Err(refused(t("server.channel.empty", &[])));
            }
            if s.send_key.encode_utf16().count() > SEND_KEY_MAX {
                return Err(refused(t("server.channel.sendKeyLong", &[])));
            }
            if let Some(to) = &s.to
                && !inner.is_orchestrator_seat(to)
            {
                return Err(refused(t("server.channel.notOrchestrator", &[("id", to.as_str().into())])));
            }
            let mut opened = None;
            let place = match &s.channel {
                None => inner.model.default_id(),
                Some(c) if inner.model.channel(c).is_some() => c.clone(),
                Some(c) => {
                    let (place, thread) = inner.resolve_target(USER_ID, c)?;
                    opened = thread;
                    place
                }
            };
            if let Some(thread) = opened {
                self.publish_channel(&inner, &thread)?;
            }
            if inner.model.channel(&place).is_none() {
                return Err(no_channel(&place));
            }
            inner.answered(&place, s.reply_to)?;
            let picked = Picked {
                agent: s.picked.as_ref().and_then(|p| p.agent.clone()).filter(|a| !a.is_empty()),
                repo: s
                    .picked
                    .as_ref()
                    .and_then(|p| p.repo.as_deref())
                    .map(str::trim)
                    .filter(|r| !r.is_empty())
                    .map(str::to_string),
            };
            let voice = s.source.as_deref() == Some("voice");
            let meta = Meta {
                ingress_recipient: s.to.clone(),
                attachments: (!files.is_empty()).then_some(files),
                picked: (picked.agent.is_some() || picked.repo.is_some()).then_some(picked),
                blocks: (!s.blocks.is_empty()).then(|| s.blocks.clone()),
                view_context: s.view_context.clone(),
                ingress_source: s.source.clone(),
                spoken: voice.then_some(true),
                response_port: s.response_port.clone(),
                voice_mode: s.voice_mode.clone(),
                ..Meta::default()
            };
            let empty = meta == Meta::default();
            let written = self.write(
                &mut inner,
                Write {
                    send_key: Some(s.send_key.clone()),
                    read_by: Some(USER_ID.into()),
                    reply_to: s.reply_to,
                    meta: (!empty).then_some(meta),
                    ..Write::new(&place, USER_ID, MessageKind::Chat, s.text.trim())
                },
            )?;
            if !written.again
                && !written.absent.is_empty()
                && let Some(hub) = self.hub.upgrade()
            {
                let who: Vec<String> = written.absent.iter().map(|m| words::mention_of(m).unwrap_or_else(|| format!("@{m}"))).collect();
                hub.notice(
                    NoticeLevel::Warn,
                    t("server.channel.absent", &[("who", list(&who).into()), ("n", written.absent.len().into())]),
                );
            }
            written
        };
        Ok((to_message(&written.row), written.again))
    }

    /// `speak`: an agent's words. A retry of the same words is the same
    /// message; newer words it has not seen are shown instead (held); a
    /// channel right after reading a thread elsewhere is confirmed once.
    pub fn speak(&self, s: Speaking) -> Result<Spoken, ApiError> {
        self.prepare_seat(&s.from);
        let mut inner = self.locked();
        let text = s.text.trim();
        if text.is_empty() {
            return Err(refused(t("server.channel.empty", &[])));
        }
        let (channel, opened) = inner.resolve_target(&s.from, s.target.as_deref().unwrap_or(""))?;
        if let Some(thread) = opened {
            self.publish_channel(&inner, &thread)?;
        }
        let row = inner
            .model
            .channel(&channel)
            .cloned()
            .ok_or_else(|| refused(t("server.channel.channelGone", &[])))?;
        let target = inner.target_of_channel(&row);
        if let Some(again) = db::recent_duplicate(&inner.db, &s.from, &channel, text, now() - RETRY_WINDOW_MS).q()?
            && let Some(m) = db::message_by_id(&inner.db, &again).q()?
        {
            return Ok(Spoken::Sent {
                message: Box::new(to_message(&m)),
                target,
                absent: vec![],
            });
        }
        let last = inner.model.last_read.get(&s.from).cloned().unwrap_or_default();
        if row.r#type != "thread" && !s.confirm && !last.is_empty() && last != target {
            return Ok(Spoken::Confirm { target, last_read: last });
        }
        let unseen = db::unseen_in(&inner.db, &channel, &s.from).q()?;
        if !unseen.is_empty() && !s.anyway {
            let mut shown = vec![];
            for id in unseen.iter().take(HELD_SHOWN) {
                if let Some(m) = db::message_by_id(&inner.db, id).q()? {
                    shown.push(inner.addressed_of(&m, &self.files));
                }
            }
            if let Some(newest) = shown.last() {
                let n = newest.number;
                tx(&mut inner, |me| me.set_read(&s.from, &channel, n, now()))?;
            }
            let more = unseen.len() - shown.len();
            return Ok(Spoken::Held { target, shown, more });
        }
        inner.answered(&channel, s.reply)?;
        let written = self.write(
            &mut inner,
            Write {
                reply_to: s.reply,
                meta: Some(Meta {
                    run: s.run.clone(),
                    ..Meta::default()
                }),
                ..Write::new(&channel, &s.from, MessageKind::Chat, text)
            },
        )?;
        let n = written.row.number;
        tx(&mut inner, |me| me.set_read(&s.from, &channel, n, now()))?;
        Ok(Spoken::Sent {
            message: Box::new(to_message(&written.row)),
            target,
            absent: written.absent,
        })
    }

    /// `post`: words written as `from` into a place; the speaker has read
    /// the place up to them.
    pub fn post(&self, p: Posting) -> Result<(ChatMessage, bool), ApiError> {
        self.post_storing(p, None)
    }

    /// A new card and its owner row share this connection until commit. A repeated send key skips the callback.
    pub(crate) fn post_with(
        &self,
        p: Posting,
        persist: impl FnOnce(&mut SqliteConnection, &ChatMessage) -> Result<(), ApiError>,
    ) -> Result<(ChatMessage, bool), ApiError> {
        self.post_storing(p, Some(Box::new(persist)))
    }

    fn post_storing(&self, p: Posting, persist: Option<BeforePost<'_>>) -> Result<(ChatMessage, bool), ApiError> {
        let written = {
            let mut inner = self.locked();
            if p.send_key.encode_utf16().count() > SEND_KEY_MAX {
                return Err(refused(t("server.channel.sendKeyLong", &[])));
            }
            if p.text.trim().is_empty() && p.made.is_none() {
                return Err(refused(t("server.channel.empty", &[])));
            }
            let place = if inner.model.channel(&p.channel).is_some() {
                p.channel.clone()
            } else {
                let (place, opened) = inner.resolve_target(&p.from, &p.channel)?;
                if let Some(thread) = opened {
                    self.publish_channel(&inner, &thread)?;
                }
                place
            };
            if inner.model.channel(&place).is_none() {
                return Err(refused(t("server.channel.channelGone", &[])));
            }
            let mut meta = Meta {
                run: p.run.clone(),
                spoken: p.spoken.then_some(true),
                ..Meta::default()
            };
            match &p.made {
                Some(Made::Card(card)) => meta.artifact = Some(card.clone()),
                Some(Made::Attachments(ids)) => meta.attachments = Some(self.files.of(ids)?),
                None => {}
            }
            self.write_with(
                &mut inner,
                Write {
                    meta: Some(meta),
                    send_key: Some(p.send_key.clone()),
                    read_by: Some(p.from.clone()),
                    ..Write::new(&place, &p.from, MessageKind::Chat, p.text.trim())
                },
                persist,
            )?
        };
        Ok((to_message(&written.row), written.again))
    }

    /// `notice`: the farm's line; best effort, never fails, wakes no one.
    pub fn notice(&self, n: Noticing) {
        let mut inner = self.locked();
        self.notice_locked(&mut inner, n);
    }

    pub(super) fn notice_locked(&self, inner: &mut super::store::Inner, n: Noticing) {
        if n.until_user_speaks && db::notice_since_user(&inner.db, &n.channel, &n.code).unwrap_or(0) > 0 {
            return;
        }
        let w = Write {
            meta: Some(Meta {
                code: Some(n.code),
                ..Meta::default()
            }),
            send_key: Some(n.send_key),
            ..Write::new(&n.channel, "system", MessageKind::Notice, &n.text)
        };
        if let Err(e) = self.write(inner, w) {
            eprintln!("vibevalley-server: chat: notice: {}", e.message);
        }
    }

    /// `note`: a dispatch or report; `topic` opens the place's thread about
    /// it under the note.
    pub fn note(&self, n: Note) -> Result<String, ApiError> {
        self.note_once(n, None)
    }

    pub(crate) fn note_once(&self, n: Note, key: Option<String>) -> Result<String, ApiError> {
        let mut inner = self.locked();
        if let Some(seat) = &n.seat {
            tx(&mut inner, |me| me.seat(seat))?;
        }
        let written = self.write(
            &mut inner,
            Write {
                meta: Some(n.meta),
                send_key: key,
                thread: n.topic,
                member: n.member,
                ..Write::new(&n.channel, &n.from, n.kind, &n.text)
            },
        )?;
        if let Some(mut seat) = n.seat {
            if seat.home.is_none() && !written.thread.is_empty() {
                seat.home = Some(written.thread.clone());
            }
            let at = now();
            tx(&mut inner, |me| {
                me.seat(&seat)?;
                me.set_read(&seat.id, &n.channel, written.row.number, at)
            })?;
        }
        Ok(written.thread)
    }

    /// `edit`: the user's own words, changed; nobody is woken.
    pub fn edit(&self, id: &str, text: &str, keep: Option<&[String]>) -> Result<ChatMessage, ApiError> {
        let mut inner = self.locked();
        let row = inner.message_of(id)?;
        if row.sender_id != USER_ID || row.kind != "chat" || row.deleted_at.is_some() {
            return Err(refused(t("server.channel.notYours", &[])));
        }
        let mut meta = meta_of(row.meta.as_deref());
        let had = meta.attachments.clone().unwrap_or_default();
        let files: Vec<Attachment> = match keep {
            None => had.clone(),
            Some(keep) => had.iter().filter(|a| keep.contains(&a.id)).cloned().collect(),
        };
        let words = text.trim().to_string();
        if words.is_empty() && files.is_empty() {
            return Err(refused(t("server.channel.empty", &[])));
        }
        if words == row.body && files.len() == had.len() {
            return Ok(to_message(&row));
        }
        let files_changed = files.len() != had.len();
        meta.attachments = Some(files);
        let text_meta = meta_text(Some(&meta));
        let changed = self.change(&mut inner, &row, |db, revision, at| {
            db::edit_message(db, id, &words, at, revision)?;
            if files_changed {
                db::set_meta(db, id, text_meta.as_deref(), revision)?;
            }
            Ok(())
        })?;
        if words != row.body {
            self.embed_later(&MsgRow { body: words.clone(), ..row });
        }
        Ok(changed)
    }

    /// `remove`: its words go, its number stays, pending deliveries are withdrawn immediately.
    pub fn remove(&self, id: &str) -> Result<(), ApiError> {
        let mut inner = self.locked();
        let row = inner.message_of(id)?;
        if row.deleted_at.is_some() {
            return Err(refused(t("server.channel.messageGone", &[])));
        }
        let mut seq = 0;
        let mut at = 0;
        self.change(&mut inner, &row, |db, revision, now| {
            db::delete_message(db, id, now, revision)?;
            db::withdraw_deliveries_for_message(db, id, now)?;
            seq = db::insert_event(db, "removed", &row.channel_id, id, now)?;
            at = now;
            Ok(())
        })?;
        let event = EventRow {
            seq,
            kind: "removed".into(),
            channel_id: row.channel_id.clone(),
            message_id: id.into(),
            at,
        };
        publish(&self.told, &Told::Removed(event));
        Ok(())
    }

    pub fn preview_remove(&self, id: &str) -> Result<Preview, ApiError> {
        let inner = self.locked();
        let row = inner.message_of(id)?;
        if row.deleted_at.is_some() {
            return Err(refused(t("server.channel.messageGone", &[])));
        }
        let target = inner.model.channel(&row.channel_id).map(|c| inner.target_of_channel(c)).unwrap_or_default();
        let mut does = vec![t(
            "server.channel.deletes",
            &[
                ("target", target.into()),
                ("number", row.number.into()),
                ("name", row.sender_name.as_str().into()),
                ("text", line_of(&row.body, LAST_MAX).into()),
            ],
        )];
        let pending = db::pending_deliveries_for_message(&inner.db, id).q()?;
        if pending > 0 {
            does.push(t("server.channel.deletesDeliveries", &[("n", pending.into())]));
        }
        Ok(Preview { does })
    }

    /// `reacting`: setting a reaction as it already is writes nothing.
    pub fn react(&self, id: &str, who: &str, emoji: &str, on: bool) -> Result<ChatMessage, ApiError> {
        let mut inner = self.locked();
        let e = emoji.trim();
        let fits = !e.is_empty() && e.chars().count() <= 16 && !e.chars().any(char::is_whitespace);
        if !fits {
            return Err(refused(t("server.channel.badEmoji", &[])));
        }
        let row = inner.message_of(id)?;
        if row.deleted_at.is_some() {
            return Err(refused(t("server.channel.messageGone", &[])));
        }
        let mut r = reactions_of(row.reactions.as_deref());
        let at = r.iter().position(|(k, _)| k == e);
        let by = at.map(|i| r[i].1.clone()).unwrap_or_default();
        if by.iter().any(|b| b == who) == on {
            return Ok(to_message(&row));
        }
        let next: Vec<String> = if on {
            by.into_iter().chain([who.to_string()]).collect()
        } else {
            by.into_iter().filter(|b| b != who).collect()
        };
        match at {
            Some(i) => r[i].1 = next,
            None => r.push((e.to_string(), next)),
        }
        let text = reactions_text(&r);
        self.change(&mut inner, &row, |db, revision, _| db::set_reactions(db, id, text.as_deref(), revision))
    }

    pub fn pin(&self, id: &str, on: bool) -> Result<ChatMessage, ApiError> {
        let mut inner = self.locked();
        let row = inner.message_of(id)?;
        if row.deleted_at.is_some() {
            return Err(refused(t("server.channel.messageGone", &[])));
        }
        if row.pinned_at.is_some() == on {
            return Ok(to_message(&row));
        }
        self.change(&mut inner, &row, |db, revision, at| db::set_pinned(db, id, on.then_some(at), revision))
    }

    pub fn pins(&self, channel: &str) -> Result<Vec<ChatMessage>, ApiError> {
        let inner = self.locked();
        if inner.model.channel(channel).is_none() {
            return Err(no_channel(channel));
        }
        Ok(db::pinned_in(&inner.db, channel).q()?.iter().map(to_message).collect())
    }

    /// `threadUnder`: the thread under a message in a channel, made if
    /// there is none.
    pub fn thread_under(&self, id: &str) -> Result<String, ApiError> {
        let mut inner = self.locked();
        let row = inner.message_of(id)?;
        if inner.model.channel(&row.channel_id).is_none_or(|c| c.r#type != "channel") {
            return Err(refused(t("server.channel.threadOnlyInChannel", &[])));
        }
        let talk = ThreadSubject {
            kind: SubjectKind::Talk,
            id: String::new(),
            owner: String::new(),
        };
        let thread = tx(&mut inner, |me| me.thread_for(&row.id, row.number, &row.channel_id, &talk))?;
        self.publish_channel(&inner, &thread)?;
        Ok(thread)
    }

    /// `issueThread`: the issue's thread, opened under a notice in
    /// `channel` (else the default) when there is none.
    pub fn issue_thread(&self, issue: &str, title: &str, channel: Option<&str>) -> Result<String, ApiError> {
        let mut inner = self.locked();
        if let Some(existing) = inner.model.thread_of_subject("issue", issue) {
            return Ok(existing.to_string());
        }
        let place = channel.map(str::to_string).unwrap_or_else(|| inner.model.default_id());
        if inner.model.channel(&place).is_none_or(|c| c.r#type != "channel") {
            return Err(refused(t("server.channel.threadOnlyInChannel", &[])));
        }
        let written = self.write(
            &mut inner,
            Write {
                thread: Some(ThreadSubject {
                    kind: SubjectKind::Issue,
                    id: issue.into(),
                    owner: String::new(),
                }),
                ..Write::new(&place, "system", MessageKind::Notice, title)
            },
        )?;
        Ok(written.thread)
    }

    pub fn issue_thread_id(&self, issue: &str) -> Option<String> {
        self.locked().model.thread_of_subject("issue", issue).map(str::to_string)
    }

    /// The newest 50 messages of an issue's thread.
    pub fn issue_messages(&self, issue: &str) -> Result<Vec<AddressedMessage>, ApiError> {
        let Some(thread) = self.issue_thread_id(issue) else { return Ok(vec![]) };
        self.recent(&thread, 50)
    }

    fn recent(&self, channel: &str, n: i64) -> Result<Vec<AddressedMessage>, ApiError> {
        let inner = self.locked();
        if inner.model.channel(channel).is_none() {
            return Ok(vec![]);
        }
        let mut rows = db::messages_before(&inner.db, channel, NO_NUMBER, n).q()?;
        rows.reverse();
        Ok(rows.iter().map(|r| inner.addressed_of(r, &self.files)).collect())
    }

    pub fn search(&self, text: &str, channel: Option<&str>) -> Result<Vec<MessageHit>, ApiError> {
        let q = words::parse_search(text);
        if q.words.is_empty() && q.from.is_none() && q.r#in.is_none() && q.has.is_empty() && q.before.is_none() && q.after.is_none() {
            return Err(refused(t("server.channel.empty", &[])));
        }
        let inner = self.locked();
        let mut scope = channel.unwrap_or("").to_string();
        if let Some(name) = &q.r#in {
            let named = inner.model.channel_by_name(name).ok_or_else(|| {
                missing(
                    t(
                        "server.channel.noChannelNamed",
                        &[("name", name.as_str().into()), ("tags", inner.channel_tags().into())],
                    ),
                    LookIn::Channel,
                )
            })?;
            scope = named.id.clone();
        }
        let rows = db::search_messages(
            &inner.db,
            &db::SearchParams {
                text: &q.words,
                channel: &scope,
                sender: q.from.as_deref().unwrap_or(""),
                has_file: q.has.contains(&Has::File),
                has_image: q.has.contains(&Has::Image),
                has_link: q.has.contains(&Has::Link),
                after: q.after.unwrap_or(0),
                before: q.before.unwrap_or(i64::MAX),
                n: SEARCH_MAX,
            },
        )
        .q()?;
        Ok(rows
            .into_iter()
            .map(|r| MessageHit {
                message: to_message(&r.row),
                channel: r.top_id.clone(),
                address: inner.target_of_row(&r.channel_type, r.root_number, None, Some(&r.top_id), Some(&r.channel_name)),
            })
            .collect())
    }
}

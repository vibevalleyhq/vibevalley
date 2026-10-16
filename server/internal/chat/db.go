package chat

// Times are milliseconds passed in by the caller (SQLite has no now() in milliseconds that matches NowMs), booleans 0/1, meta JSON text. A chatStore
// runs on the database or on an open transaction: with one connection, a query outside the transaction while it is open would wait for ever.

import (
	"database/sql"
	"encoding/json"
	"errors"

	"vibevalley/internal/protocol"
)

type chatQ interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

type chatStore struct{ q chatQ }

type chatMeta struct {
	Mentions    []string          `json:"mentions,omitempty"`
	Helper      string            `json:"helper,omitempty"`
	Outcome     *protocol.Outcome `json:"outcome,omitempty"`
	Spent       *protocol.Spent   `json:"spent,omitempty"`
	ForPlaybook bool              `json:"forPlaybook,omitempty"`
	Code        string            `json:"code,omitempty"`
}

// Anything unreadable is no meta.
func chatMetaOf(raw *string) chatMeta {
	var m chatMeta
	if raw == nil || *raw == "" {
		return m
	}
	if err := json.Unmarshal([]byte(*raw), &m); err != nil {
		return chatMeta{}
	}
	switch {
	case m.Outcome == nil:
	case *m.Outcome == protocol.OutcomeCompleted, *m.Outcome == protocol.OutcomeFailed, *m.Outcome == protocol.OutcomeInterrupted:
	default:
		return chatMeta{}
	}
	return m
}

func chatMetaText(m *chatMeta) (*string, error) {
	if m == nil {
		return nil, nil
	}
	body, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	s := string(body)
	return &s, nil
}

type chatParticipant struct {
	ID      string
	Kind    string
	Name    string
	AgentID *string
	Runtime *string
	Joined  int64
	Left    *int64
}

type chatMsgRow struct {
	Seq          int64
	Conversation int64
	Sender       string
	Kind         string
	Body         string
	Final        bool
	Meta         *string
	CreatedAt    int64
	Name         string
	SenderKind   string
	AgentID      *string
}

type chatConvRow struct {
	ID          int64
	Kind        string
	ParentSeq   *int64
	SubjectKind *string
	SubjectID   *string
	LastSeq     *int64
	Replies     int64
	CreatedAt   int64
	Name        *string
	Description *string
	Project     *string
	ChannelID   *int64
}

type chatDeliveryRow struct {
	Seq              int64
	Reason           string
	Wakes            bool
	HeldBy           *string
	State            string
	Session          *string
	Conversation     int64
	Sender           string
	Kind             string
	Body             string
	CreatedAt        int64
	Name             string
	SenderKind       string
	ConversationKind string
	ParentSeq        *int64
	SubjectKind      *string
	SubjectID        *string
	ChannelName      *string
}

type chatInboxRow struct {
	ID          int64
	Kind        string
	ParentSeq   *int64
	SubjectKind *string
	SubjectID   *string
	ChannelName *string
	Unread      int64
	MentionsYou bool
	Latest      *int64
}

const (
	chatMsgCols = `m.seq, m.conversation_id, m.sender_id, m.kind, m.body, m.final, m.meta, m.created_at, p.name, p.kind, p.agent_id
from messages m join participants p on p.id = m.sender_id`
	chatConvCols = `id, kind, parent_seq, subject_kind, subject_id, last_seq, reply_count, created_at, name, description, project, channel_id
from conversations`
	// "Before every message" where a query wants an upper bound.
	chatNoSeq = int64(1) << 62
)

func chatRows[T any](rows *sql.Rows, err error, scan func(*sql.Rows) (T, error)) ([]T, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []T
	for rows.Next() {
		v, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func chatScanMsg(r *sql.Rows) (chatMsgRow, error) {
	var m chatMsgRow
	err := r.Scan(&m.Seq, &m.Conversation, &m.Sender, &m.Kind, &m.Body, &m.Final, &m.Meta, &m.CreatedAt, &m.Name, &m.SenderKind, &m.AgentID)
	return m, err
}

func chatScanConv(r *sql.Rows) (chatConvRow, error) {
	var c chatConvRow
	err := r.Scan(&c.ID, &c.Kind, &c.ParentSeq, &c.SubjectKind, &c.SubjectID, &c.LastSeq, &c.Replies, &c.CreatedAt, &c.Name, &c.Description, &c.Project, &c.ChannelID)
	return c, err
}

func chatScanInt(r *sql.Rows) (int64, error) {
	var n int64
	err := r.Scan(&n)
	return n, err
}

func chatFirst[T any](list []T, err error) (*T, error) {
	if err != nil || len(list) == 0 {
		return nil, err
	}
	return &list[0], nil
}

func (s chatStore) one(query string, args ...any) (int64, error) {
	var n int64
	err := s.q.QueryRow(query, args...).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return n, err
}

func (s chatStore) exec(query string, args ...any) error {
	_, err := s.q.Exec(query, args...)
	return err
}

func (s chatStore) upsertParticipant(id, kind, name string, agent, runtime *string, at int64) error {
	return s.exec(`insert into participants (id, kind, name, agent_id, runtime, joined_at) values (?, ?, ?, ?, ?, ?)
on conflict (id) do update set name = excluded.name, agent_id = excluded.agent_id, runtime = excluded.runtime, left_at = null`,
		id, kind, name, agent, runtime, at)
}

func (s chatStore) participantLeft(id string, at int64) error {
	return s.exec(`update participants set left_at = ? where id = ? and left_at is null`, at, id)
}

func (s chatStore) participants() ([]chatParticipant, error) {
	rows, err := s.q.Query(`select id, kind, name, agent_id, runtime, joined_at, left_at from participants order by joined_at, rowid`)
	return chatRows(rows, err, func(r *sql.Rows) (chatParticipant, error) {
		var p chatParticipant
		err := r.Scan(&p.ID, &p.Kind, &p.Name, &p.AgentID, &p.Runtime, &p.Joined, &p.Left)
		return p, err
	})
}

func (s chatStore) squareID() (*int64, error) {
	rows, err := s.q.Query(`select id from conversations where kind = 'square'`)
	return chatFirst(chatRows(rows, err, chatScanInt))
}

func (s chatStore) createSquare(at int64) (int64, error) {
	return s.one(`insert into conversations (kind, name, created_at) values ('square', ?, ?) returning id`, protocol.SquareName, at)
}

func (s chatStore) createChannel(name string, description, project *string, at int64) (int64, error) {
	return s.one(`insert into conversations (kind, name, description, project, created_at) values ('channel', ?, ?, ?, ?) returning id`,
		name, description, project, at)
}

func (s chatStore) updateChannel(id int64, description, project *string) error {
	return s.exec(`update conversations set description = ?, project = ? where id = ? and kind in ('square', 'channel')`, description, project, id)
}

func (s chatStore) channelByName(name string) (*int64, error) {
	rows, err := s.q.Query(`select id from conversations where name = ? and kind in ('square', 'channel')`, name)
	return chatFirst(chatRows(rows, err, chatScanInt))
}

func (s chatStore) channels() ([]chatConvRow, error) {
	rows, err := s.q.Query(`select ` + chatConvCols + ` where kind in ('square', 'channel') order by case when kind = 'square' then 0 else 1 end, id`)
	return chatRows(rows, err, chatScanConv)
}

func (s chatStore) createThread(parent int64, subjectKind, subjectID *string, channel int64, at int64) (int64, error) {
	return s.one(`insert into conversations (kind, parent_seq, subject_kind, subject_id, channel_id, created_at) values ('thread', ?, ?, ?, ?, ?) returning id`,
		parent, subjectKind, subjectID, channel, at)
}

func (s chatStore) conversation(id int64) (*chatConvRow, error) {
	rows, err := s.q.Query(`select `+chatConvCols+` where id = ?`, id)
	return chatFirst(chatRows(rows, err, chatScanConv))
}

func (s chatStore) threadByParent(parent int64) (*int64, error) {
	rows, err := s.q.Query(`select id from conversations where parent_seq = ?`, parent)
	return chatFirst(chatRows(rows, err, chatScanInt))
}

func (s chatStore) threadOfSubject(kind, id string) (*int64, error) {
	rows, err := s.q.Query(`select id from conversations where subject_kind = ? and subject_id = ? order by id desc limit 1`, kind, id)
	return chatFirst(chatRows(rows, err, chatScanInt))
}

func (s chatStore) recentConversations(limit int) ([]chatConvRow, error) {
	rows, err := s.q.Query(`select `+chatConvCols+` order by coalesce(last_seq, 0) desc, id desc limit ?`, limit)
	return chatRows(rows, err, chatScanConv)
}

func (s chatStore) touchConversation(id, seq int64) error {
	return s.exec(`update conversations
set last_seq = max(coalesce(last_seq, 0), ?),
    reply_count = reply_count + case when kind = 'thread' then 1 else 0 end
where id = ?`, seq, id)
}

func (s chatStore) insertMessage(conversation int64, sender, kind, body string, final bool, meta *chatMeta, at int64) (int64, error) {
	m, err := chatMetaText(meta)
	if err != nil {
		return 0, err
	}
	return s.one(`insert into messages (conversation_id, sender_id, kind, body, final, meta, created_at) values (?, ?, ?, ?, ?, ?, ?) returning seq`,
		conversation, sender, kind, body, final, m, at)
}

func (s chatStore) updateMessageBody(seq int64, body string, final bool, at int64) error {
	return s.exec(`update messages set body = ?, final = ?, updated_at = ? where seq = ?`, body, final, at, seq)
}

func (s chatStore) updateMessageMeta(seq int64, meta chatMeta) error {
	m, err := chatMetaText(&meta)
	if err != nil {
		return err
	}
	return s.exec(`update messages set meta = ? where seq = ?`, m, seq)
}

func (s chatStore) message(seq int64) (*chatMsgRow, error) {
	rows, err := s.q.Query(`select `+chatMsgCols+` where m.seq = ?`, seq)
	return chatFirst(chatRows(rows, err, chatScanMsg))
}

func (s chatStore) recentMessages(limit int) ([]chatMsgRow, error) {
	rows, err := s.q.Query(`select `+chatMsgCols+` order by m.seq desc limit ?`, limit)
	return chatRows(rows, err, chatScanMsg)
}

// Newest first.
func (s chatStore) messagesBefore(conversation, before int64, limit int) ([]chatMsgRow, error) {
	rows, err := s.q.Query(`select `+chatMsgCols+` where m.conversation_id = ? and m.seq < ? order by m.seq desc limit ?`, conversation, before, limit)
	return chatRows(rows, err, chatScanMsg)
}

func (s chatStore) messagesAfter(conversation, after int64, limit int) ([]chatMsgRow, error) {
	rows, err := s.q.Query(`select `+chatMsgCols+` where m.conversation_id = ? and m.seq > ? order by m.seq limit ?`, conversation, after, limit)
	return chatRows(rows, err, chatScanMsg)
}

func (s chatStore) recentDuplicate(sender string, conversation int64, body string, since int64) (*int64, error) {
	rows, err := s.q.Query(`select seq from messages where sender_id = ? and conversation_id = ? and body = ? and created_at > ? order by seq desc limit 1`,
		sender, conversation, body, since)
	return chatFirst(chatRows(rows, err, chatScanInt))
}

func (s chatStore) latestSeq(conversation int64) (int64, error) {
	return s.one(`select coalesce(max(seq), 0) from messages where conversation_id = ?`, conversation)
}

func (s chatStore) messageCount() (int64, error) { return s.one(`select count(*) from messages`) }

func (s chatStore) finalizeAll(at int64) error {
	return s.exec(`update messages set final = 1, updated_at = ? where not final`, at)
}

func (s chatStore) calledBy(speaker string, conversation, before int64) (*string, error) {
	rows, err := s.q.Query(`select m.sender_id
from messages m
join mentions n on n.message_seq = m.seq and n.target_id = ?
join participants p on p.id = m.sender_id and p.kind = 'helper'
where m.conversation_id = ? and m.sender_id <> ? and m.seq < ?
  and m.seq > coalesce((select max(s.seq) from messages s where s.conversation_id = ? and s.sender_id = ? and s.seq < ?), 0)
order by m.seq desc
limit 1`, speaker, conversation, speaker, before, conversation, speaker, before)
	return chatFirst(chatRows(rows, err, func(r *sql.Rows) (string, error) {
		var id string
		err := r.Scan(&id)
		return id, err
	}))
}

func (s chatStore) insertMention(seq int64, target, resolved string) error {
	return s.exec(`insert into mentions (message_seq, target_id, resolved) values (?, ?, ?) on conflict do nothing`, seq, target, resolved)
}

func (s chatStore) follow(conversation int64, participant, reason string, from int64) error {
	return s.exec(`insert into follows (conversation_id, participant_id, reason, from_seq) values (?, ?, ?, ?)
on conflict (conversation_id, participant_id) do update set unfollowed_at = null`, conversation, participant, reason, from)
}

func (s chatStore) followers(conversation int64) ([]string, error) {
	rows, err := s.q.Query(`select participant_id from follows where conversation_id = ? and unfollowed_at is null order by participant_id`, conversation)
	return chatRows(rows, err, func(r *sql.Rows) (string, error) {
		var id string
		err := r.Scan(&id)
		return id, err
	})
}

func (s chatStore) setReadCursor(participant string, conversation, seq, at int64) error {
	return s.exec(`insert into read_cursors (participant_id, conversation_id, read_seq, updated_at) values (?, ?, ?, ?)
on conflict (participant_id, conversation_id) do update set read_seq = max(read_cursors.read_seq, excluded.read_seq), updated_at = excluded.updated_at`,
		participant, conversation, seq, at)
}

func (s chatStore) readCursor(participant string, conversation int64) (*int64, error) {
	rows, err := s.q.Query(`select read_seq from read_cursors where participant_id = ? and conversation_id = ?`, participant, conversation)
	return chatFirst(chatRows(rows, err, chatScanInt))
}

func (s chatStore) addSeenMark(participant string, seq int64) error {
	return s.exec(`insert into seen_marks (participant_id, message_seq) values (?, ?) on conflict do nothing`, participant, seq)
}

func (s chatStore) pruneSeenMarks(participant string, conversation, upto int64) error {
	return s.exec(`delete from seen_marks where participant_id = ?
  and message_seq in (select seq from messages where conversation_id = ? and seq <= ?)`, participant, conversation, upto)
}

// Newest first.
func (s chatStore) unseenIn(conversation int64, participant string) ([]int64, error) {
	rows, err := s.q.Query(`select m.seq from messages m
where m.conversation_id = ? and m.sender_id <> ? and m.final
  and m.seq > coalesce((select read_seq from read_cursors where participant_id = ? and conversation_id = ?), 0)
  and not exists (select 1 from seen_marks s where s.participant_id = ? and s.message_seq = m.seq)
order by m.seq desc`, conversation, participant, participant, conversation, participant)
	return chatRows(rows, err, chatScanInt)
}

func (s chatStore) insertDelivery(d protocol.Delivery, seq, at int64) error {
	var held *string
	if d.HeldBy != "" {
		h := string(d.HeldBy)
		held = &h
	}
	return s.exec(`insert into deliveries (recipient_id, message_seq, reason, wakes, held_by, created_at) values (?, ?, ?, ?, ?, ?) on conflict do nothing`,
		d.Recipient, seq, string(d.Reason), d.Wakes, held, at)
}

func (s chatStore) openDeliveries(recipient string) ([]chatDeliveryRow, error) {
	rows, err := s.q.Query(`select d.message_seq, d.reason, d.wakes, d.held_by, d.state, d.session, m.conversation_id, m.sender_id, m.kind, m.body, m.created_at,
       p.name, p.kind, c.kind, c.parent_seq, c.subject_kind, c.subject_id, coalesce(ch.name, c.name)
from deliveries d
join messages m on m.seq = d.message_seq
join participants p on p.id = m.sender_id
join conversations c on c.id = m.conversation_id
left join conversations ch on ch.id = c.channel_id
where d.recipient_id = ? and d.state in ('pending', 'announced', 'handed')
order by d.message_seq`, recipient)
	return chatRows(rows, err, func(r *sql.Rows) (chatDeliveryRow, error) {
		var d chatDeliveryRow
		err := r.Scan(&d.Seq, &d.Reason, &d.Wakes, &d.HeldBy, &d.State, &d.Session, &d.Conversation, &d.Sender, &d.Kind, &d.Body, &d.CreatedAt,
			&d.Name, &d.SenderKind, &d.ConversationKind, &d.ParentSeq, &d.SubjectKind, &d.SubjectID, &d.ChannelName)
		return d, err
	})
}

func (s chatStore) markAnnounced(recipient string, seq int64, session string, at int64) error {
	return s.exec(`update deliveries set state = 'announced', session = ?, announced_at = ?
where recipient_id = ? and message_seq = ? and state in ('pending', 'announced')`, session, at, recipient, seq)
}

func (s chatStore) markHanded(recipient string, seq int64, session string, at int64) error {
	return s.exec(`update deliveries set state = 'handed', session = ?, handed_at = ?
where recipient_id = ? and message_seq = ? and state in ('pending', 'announced')`, session, at, recipient, seq)
}

func (s chatStore) seenHanded(recipient, session string, at int64) ([]int64, error) {
	rows, err := s.q.Query(`update deliveries set state = 'seen', seen_at = ?
where recipient_id = ? and state = 'handed' and session = ?
returning message_seq`, at, recipient, session)
	return chatRows(rows, err, chatScanInt)
}

func (s chatStore) rollbackHanded(recipient string) (int64, error) {
	res, err := s.q.Exec(`update deliveries set state = 'pending', session = null where recipient_id = ? and state = 'handed'`, recipient)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s chatStore) rollbackAll() error {
	return s.exec(`update deliveries set state = 'pending', session = null where state in ('announced', 'handed')`)
}

func (s chatStore) rollbackAnnounced(recipient, session string) error {
	return s.exec(`update deliveries set state = 'pending', session = null where recipient_id = ? and state = 'announced' and session = ?`, recipient, session)
}

func (s chatStore) seenUpTo(recipient string, conversation, upto, at int64) error {
	return s.exec(`update deliveries set state = 'seen', seen_at = ?
where recipient_id = ? and message_seq <= ? and state in ('pending', 'announced', 'handed')
  and message_seq in (select seq from messages where conversation_id = ?)`, at, recipient, upto, conversation)
}

func (s chatStore) seenOne(recipient string, seq, at int64) error {
	return s.exec(`update deliveries set state = 'seen', seen_at = ?
where recipient_id = ? and message_seq = ? and state in ('pending', 'announced', 'handed')`, at, recipient, seq)
}

func (s chatStore) dropOpen(recipient, why string) error {
	return s.exec(`update deliveries set state = 'dropped', dropped_why = ?, session = null
where recipient_id = ? and state in ('pending', 'announced', 'handed')`, why, recipient)
}

func (s chatStore) agentWakesSinceUser(conversation int64) (int64, error) {
	return s.one(`select count(*) from deliveries d
join messages m on m.seq = d.message_seq
join participants s on s.id = m.sender_id
join participants r on r.id = d.recipient_id
where m.conversation_id = ?
  and m.seq > coalesce((select max(seq) from messages where conversation_id = ? and sender_id = 'user'), 0)
  and s.kind in ('helper', 'foreman') and r.kind in ('helper', 'foreman') and d.wakes and d.held_by is null`, conversation, conversation)
}

func (s chatStore) holdNoticeSinceUser(conversation int64) (int64, error) {
	return s.one(`select count(*) from messages
where conversation_id = ? and sender_id = 'system' and json_extract(meta, '$.code') = 'hop_limit'
  and seq > coalesce((select max(seq) from messages where conversation_id = ? and sender_id = 'user'), 0)`, conversation, conversation)
}

func (s chatStore) lastAgentWake(recipient string) (int64, error) {
	return s.one(`select coalesce(max(d.created_at), 0) from deliveries d
join messages m on m.seq = d.message_seq
join participants s on s.id = m.sender_id
where d.recipient_id = ? and s.kind in ('helper', 'foreman') and d.wakes and d.held_by is null`, recipient)
}

func (s chatStore) inboxOf(participant string, channel int64) ([]chatInboxRow, error) {
	rows, err := s.q.Query(`select c.id, c.kind, c.parent_seq, c.subject_kind, c.subject_id, coalesce(ch.name, c.name),
       count(m.seq),
       max(exists (select 1 from mentions x where x.message_seq = m.seq and x.target_id = ?)),
       max(m.seq)
from conversations c
left join conversations ch on ch.id = c.channel_id
join messages m on m.conversation_id = c.id
left join read_cursors rc on rc.participant_id = ? and rc.conversation_id = c.id
left join follows f on f.conversation_id = c.id and f.participant_id = ? and f.unfollowed_at is null
where m.sender_id <> ? and m.final and m.kind <> 'notice'
  and (c.id = ? or f.participant_id is not null)
  and m.seq > max(coalesce(rc.read_seq, 0), coalesce(f.from_seq, 0))
  and not exists (select 1 from seen_marks s where s.participant_id = ? and s.message_seq = m.seq)
group by c.id
order by max(m.seq) desc
limit 20`, participant, participant, participant, participant, channel, participant)
	return chatRows(rows, err, func(r *sql.Rows) (chatInboxRow, error) {
		var x chatInboxRow
		err := r.Scan(&x.ID, &x.Kind, &x.ParentSeq, &x.SubjectKind, &x.SubjectID, &x.ChannelName, &x.Unread, &x.MentionsYou, &x.Latest)
		return x, err
	})
}

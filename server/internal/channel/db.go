package channel

// Times are milliseconds passed in by the caller (SQLite has no now() in milliseconds that matches NowMs), meta JSON text. A chatStore
// runs on the database or on an open transaction: with one connection, a query outside the transaction while it is open would wait for ever.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
)

type chatStore struct{ q *generated.Queries }

type chatMeta struct {
	Mentions    []string          `json:"mentions,omitempty"`
	Session     string            `json:"session,omitempty"`
	Outcome     *protocol.Outcome `json:"outcome,omitempty"`
	Spent       *protocol.Spent   `json:"spent,omitempty"`
	ForPlaybook bool              `json:"forPlaybook,omitempty"`
	Code        string            `json:"code,omitempty"`
	// Said on a call: the manager heard it there, so it wakes no one here.
	Spoken bool `json:"spoken,omitempty"`
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
	ID           string
	Number       int64
	Conversation string
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
	ID           string
	Kind         string
	Parent       *string
	ParentNumber *int64
	SubjectKind  *string
	SubjectID    *string
	LastNumber   *int64
	Replies      int64
	CreatedAt    int64
	Name         *string
	Description  *string
	Project      *string
	Channel      *string
}

type chatDeliveryRow struct {
	Message          string
	Number           int64
	Reason           string
	Wakes            bool
	HeldBy           *string
	State            string
	Launch           *string
	Conversation     string
	Sender           string
	Kind             string
	Body             string
	CreatedAt        int64
	Name             string
	SenderKind       string
	ConversationKind string
	Parent           *string
	ParentNumber     *int64
	SubjectKind      *string
	SubjectID        *string
	ChannelName      *string
}

type chatInboxRow struct {
	ID           string
	Kind         string
	Parent       *string
	ParentNumber *int64
	SubjectKind  *string
	SubjectID    *string
	ChannelName  *string
	Unread       int64
	MentionsYou  bool
	Latest       int64
}

var bg = context.Background()

func textOf(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	return &s.String
}

func numberOf(n sql.NullInt64) *int64 {
	if !n.Valid {
		return nil
	}
	return &n.Int64
}

func nullText(s *string) sql.NullString {
	if s == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *s, Valid: true}
}

func at(ms int64) sql.NullInt64 { return sql.NullInt64{Int64: ms, Valid: true} }

// A thread outside any channel has no channel name.
func channelName(name string) *string {
	if name == "" {
		return nil
	}
	return &name
}

// No row is nothing found, not an error.
func found[T any](v T, err error) (*T, error) {
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &v, nil
}

func chatMsgOf(m generated.ChannelMessage, p generated.ChannelParticipant) chatMsgRow {
	return chatMsgRow{ID: m.ID, Number: m.Number, Conversation: m.ConversationID, Sender: m.SenderID, Kind: m.Kind, Body: m.Body, Final: m.Final,
		Meta: textOf(m.Meta), CreatedAt: m.CreatedAt, Name: p.Name, SenderKind: p.Kind, AgentID: textOf(p.AgentID)}
}

func chatConvOf(c generated.ChannelConversation) chatConvRow {
	return chatConvRow{ID: c.ID, Kind: c.Kind, Parent: textOf(c.ParentID), ParentNumber: numberOf(c.ParentNumber), SubjectKind: textOf(c.SubjectKind),
		SubjectID: textOf(c.SubjectID), LastNumber: numberOf(c.LastNumber), Replies: c.ReplyCount, CreatedAt: c.CreatedAt, Name: textOf(c.Name),
		Description: textOf(c.Description), Project: textOf(c.Project), Channel: textOf(c.ChannelID)}
}

func chatConvsOf(list []generated.ChannelConversation, err error) ([]chatConvRow, error) {
	if err != nil {
		return nil, err
	}
	out := make([]chatConvRow, len(list))
	for i, c := range list {
		out[i] = chatConvOf(c)
	}
	return out, nil
}

func (s chatStore) upsertParticipant(id, kind, name string, agent, runtime *string, joined int64) error {
	return s.q.UpsertParticipant(bg, generated.UpsertParticipantParams{ID: id, Kind: kind, Name: name, AgentID: nullText(agent), Runtime: nullText(runtime), JoinedAt: joined})
}

func (s chatStore) participantLeft(id string, left int64) error {
	return s.q.ParticipantLeft(bg, generated.ParticipantLeftParams{LeftAt: at(left), ID: id})
}

func (s chatStore) participants() ([]chatParticipant, error) {
	list, err := s.q.Participants(bg)
	if err != nil {
		return nil, err
	}
	out := make([]chatParticipant, len(list))
	for i, p := range list {
		out[i] = chatParticipant{ID: p.ID, Kind: p.Kind, Name: p.Name, AgentID: textOf(p.AgentID), Runtime: textOf(p.Runtime), Joined: p.JoinedAt, Left: numberOf(p.LeftAt)}
	}
	return out, nil
}

func (s chatStore) generalID() (*string, error) { return found(s.q.GeneralID(bg)) }

func (s chatStore) createGeneral(id string, created int64) error {
	return s.q.CreateGeneral(bg, generated.CreateGeneralParams{ID: id, Name: sql.NullString{String: protocol.GeneralName, Valid: true}, CreatedAt: created})
}

func (s chatStore) createChannel(id, name string, description, project *string, created int64) error {
	return s.q.CreateChannel(bg, generated.CreateChannelParams{ID: id, Name: sql.NullString{String: name, Valid: true}, Description: nullText(description),
		Project: nullText(project), CreatedAt: created})
}

func (s chatStore) updateChannel(id string, description, project *string) error {
	return s.q.UpdateChannel(bg, generated.UpdateChannelParams{Description: nullText(description), Project: nullText(project), ID: id})
}

func (s chatStore) channelByName(name string) (*string, error) {
	return found(s.q.ChannelByName(bg, sql.NullString{String: name, Valid: true}))
}

func (s chatStore) channels() ([]chatConvRow, error) { return chatConvsOf(s.q.Channels(bg)) }

func (s chatStore) createThread(id, parent string, parentNumber int64, subjectKind, subjectID *string, channel string, created int64) error {
	return s.q.CreateThread(bg, generated.CreateThreadParams{ID: id, ParentID: sql.NullString{String: parent, Valid: true},
		ParentNumber: at(parentNumber), SubjectKind: nullText(subjectKind), SubjectID: nullText(subjectID),
		ChannelID: sql.NullString{String: channel, Valid: true}, CreatedAt: created})
}

func (s chatStore) conversation(id string) (*chatConvRow, error) {
	c, err := found(s.q.ConversationByID(bg, id))
	if c == nil {
		return nil, err
	}
	row := chatConvOf(*c)
	return &row, nil
}

func (s chatStore) threadByParent(parent string) (*string, error) {
	return found(s.q.ThreadByParent(bg, sql.NullString{String: parent, Valid: true}))
}

func (s chatStore) threadOfSubject(kind, id string) (*string, error) {
	return found(s.q.ThreadOfSubject(bg, generated.ThreadOfSubjectParams{SubjectKind: nullText(&kind), SubjectID: nullText(&id)}))
}

func (s chatStore) recentConversations(limit int) ([]chatConvRow, error) {
	return chatConvsOf(s.q.RecentConversations(bg, int64(limit)))
}

func (s chatStore) touchConversation(id string, number int64) error {
	return s.q.TouchConversation(bg, generated.TouchConversationParams{Number: number, ID: id})
}

// sendKey "" is none.
func (s chatStore) insertMessage(id, conversation, sender, kind, body string, final bool, meta *chatMeta, sendKey string, created int64) (int64, error) {
	m, err := chatMetaText(meta)
	if err != nil {
		return 0, err
	}
	key := sql.NullString{String: sendKey, Valid: sendKey != ""}
	return s.q.InsertMessage(bg, generated.InsertMessageParams{ID: id, Conversation: conversation, Sender: sender, Kind: kind, Body: body, Final: final,
		Meta: nullText(m), SendKey: key, CreatedAt: created})
}

func (s chatStore) messageBySendKey(sender, sendKey string) (*chatMsgRow, error) {
	r, err := found(s.q.MessageBySendKey(bg, generated.MessageBySendKeyParams{SenderID: sender, SendKey: sql.NullString{String: sendKey, Valid: true}}))
	if r == nil {
		return nil, err
	}
	m := chatMsgOf(r.ChannelMessage, r.ChannelParticipant)
	return &m, nil
}

func (s chatStore) updateMessageBody(id string, body string, final bool, updated int64) error {
	return s.q.UpdateMessageBody(bg, generated.UpdateMessageBodyParams{Body: body, Final: final, UpdatedAt: at(updated), ID: id})
}

func (s chatStore) updateMessageMeta(id string, meta chatMeta) error {
	m, err := chatMetaText(&meta)
	if err != nil {
		return err
	}
	return s.q.UpdateMessageMeta(bg, generated.UpdateMessageMetaParams{Meta: nullText(m), ID: id})
}

func (s chatStore) message(id string) (*chatMsgRow, error) {
	r, err := found(s.q.MessageByID(bg, id))
	if r == nil {
		return nil, err
	}
	m := chatMsgOf(r.ChannelMessage, r.ChannelParticipant)
	return &m, nil
}

func (s chatStore) recentMessages(limit int) ([]chatMsgRow, error) {
	list, err := s.q.RecentMessages(bg, int64(limit))
	if err != nil {
		return nil, err
	}
	out := make([]chatMsgRow, len(list))
	for i, r := range list {
		out[i] = chatMsgOf(r.ChannelMessage, r.ChannelParticipant)
	}
	return out, nil
}

// Newest first.
func (s chatStore) messagesBefore(conversation string, before int64, limit int) ([]chatMsgRow, error) {
	list, err := s.q.MessagesBefore(bg, generated.MessagesBeforeParams{ConversationID: conversation, Number: before, Limit: int64(limit)})
	if err != nil {
		return nil, err
	}
	out := make([]chatMsgRow, len(list))
	for i, r := range list {
		out[i] = chatMsgOf(r.ChannelMessage, r.ChannelParticipant)
	}
	return out, nil
}

func (s chatStore) messagesAfter(conversation string, after int64, limit int) ([]chatMsgRow, error) {
	list, err := s.q.MessagesAfter(bg, generated.MessagesAfterParams{ConversationID: conversation, Number: after, Limit: int64(limit)})
	if err != nil {
		return nil, err
	}
	out := make([]chatMsgRow, len(list))
	for i, r := range list {
		out[i] = chatMsgOf(r.ChannelMessage, r.ChannelParticipant)
	}
	return out, nil
}

func (s chatStore) recentDuplicate(sender, conversation, body string, since int64) (*string, error) {
	return found(s.q.RecentDuplicate(bg, generated.RecentDuplicateParams{SenderID: sender, ConversationID: conversation, Body: body, CreatedAt: since}))
}

func (s chatStore) latestNumber(conversation string) (int64, error) {
	return s.q.LatestNumber(bg, conversation)
}

func (s chatStore) finalizeAll(updated int64) error { return s.q.FinalizeAll(bg, at(updated)) }

func (s chatStore) calledBy(speaker, conversation, before string) (*string, error) {
	return found(s.q.CalledBy(bg, generated.CalledByParams{Speaker: speaker, Conversation: conversation, Before: before}))
}

func (s chatStore) insertMention(message, target, resolved string) error {
	return s.q.InsertMention(bg, generated.InsertMentionParams{MessageID: message, TargetID: target, Resolved: resolved})
}

func (s chatStore) follow(conversation, participant, reason string, from int64) error {
	return s.q.Follow(bg, generated.FollowParams{ConversationID: conversation, ParticipantID: participant, Reason: reason, FromNumber: from})
}

func (s chatStore) followers(conversation string) ([]string, error) {
	return s.q.Followers(bg, conversation)
}

func (s chatStore) setReadCursor(participant, conversation string, number, updated int64) error {
	return s.q.SetReadCursor(bg, generated.SetReadCursorParams{ParticipantID: participant, ConversationID: conversation, ReadNumber: number, UpdatedAt: updated})
}

func (s chatStore) readCursor(participant, conversation string) (*int64, error) {
	return found(s.q.ReadCursor(bg, generated.ReadCursorParams{ParticipantID: participant, ConversationID: conversation}))
}

func (s chatStore) addSeenMark(participant, message string) error {
	return s.q.AddSeenMark(bg, generated.AddSeenMarkParams{ParticipantID: participant, MessageID: message})
}

func (s chatStore) pruneSeenMarks(participant, conversation string, upto int64) error {
	return s.q.PruneSeenMarks(bg, generated.PruneSeenMarksParams{Participant: participant, Conversation: conversation, Upto: upto})
}

// Newest first.
func (s chatStore) unseenIn(conversation, participant string) ([]string, error) {
	return s.q.UnseenIn(bg, generated.UnseenInParams{Conversation: conversation, Participant: participant})
}

func (s chatStore) insertDelivery(d chatDelivery, message string, created int64) error {
	held := sql.NullString{String: string(d.HeldBy), Valid: d.HeldBy != ""}
	return s.q.InsertDelivery(bg, generated.InsertDeliveryParams{RecipientID: d.Recipient, MessageID: message, Reason: string(d.Reason), Wakes: d.Wakes,
		HeldBy: held, CreatedAt: created})
}

func (s chatStore) openDeliveries(recipient string) ([]chatDeliveryRow, error) {
	list, err := s.q.OpenDeliveries(bg, recipient)
	if err != nil {
		return nil, err
	}
	out := make([]chatDeliveryRow, len(list))
	for i, d := range list {
		out[i] = chatDeliveryRow{Message: d.MessageID, Number: d.Number, Reason: d.Reason, Wakes: d.Wakes, HeldBy: textOf(d.HeldBy), State: d.State,
			Launch: textOf(d.Launch), Conversation: d.ConversationID, Sender: d.SenderID, Kind: d.Kind, Body: d.Body, CreatedAt: d.CreatedAt, Name: d.Name,
			SenderKind: d.SenderKind, ConversationKind: d.ConversationKind, Parent: textOf(d.ParentID), ParentNumber: numberOf(d.ParentNumber),
			SubjectKind: textOf(d.SubjectKind), SubjectID: textOf(d.SubjectID), ChannelName: channelName(d.ChannelName)}
	}
	return out, nil
}

func (s chatStore) markAnnounced(recipient, message string, launch string, when int64) error {
	return s.q.MarkAnnounced(bg, generated.MarkAnnouncedParams{Launch: nullText(&launch), AnnouncedAt: at(when), RecipientID: recipient, MessageID: message})
}

func (s chatStore) markHanded(recipient, message string, launch string, when int64) error {
	return s.q.MarkHanded(bg, generated.MarkHandedParams{Launch: nullText(&launch), HandedAt: at(when), RecipientID: recipient, MessageID: message})
}

func (s chatStore) seenHanded(recipient, launch string, when int64) ([]string, error) {
	return s.q.SeenHanded(bg, generated.SeenHandedParams{SeenAt: at(when), RecipientID: recipient, Launch: nullText(&launch)})
}

func (s chatStore) rollbackHanded(recipient string) (int64, error) {
	return s.q.RollbackHanded(bg, recipient)
}

func (s chatStore) rollbackAll() error { return s.q.RollbackAll(bg) }

func (s chatStore) rollbackAnnounced(recipient, launch string) error {
	return s.q.RollbackAnnounced(bg, generated.RollbackAnnouncedParams{RecipientID: recipient, Launch: nullText(&launch)})
}

func (s chatStore) seenUpTo(recipient, conversation string, upto, when int64) error {
	return s.q.SeenUpTo(bg, generated.SeenUpToParams{At: at(when), Recipient: recipient, Upto: upto, Conversation: conversation})
}

func (s chatStore) seenOne(recipient, message string, when int64) error {
	return s.q.SeenOne(bg, generated.SeenOneParams{SeenAt: at(when), RecipientID: recipient, MessageID: message})
}

func (s chatStore) dropOpen(recipient, why string) error {
	return s.q.DropOpen(bg, generated.DropOpenParams{DroppedWhy: nullText(&why), RecipientID: recipient})
}

func (s chatStore) agentWakesSinceUser(conversation string) (int64, error) {
	return s.q.AgentWakesSinceUser(bg, conversation)
}

func (s chatStore) holdNoticeSinceUser(conversation string) (int64, error) {
	return s.q.HoldNoticeSinceUser(bg, conversation)
}

func (s chatStore) lastAgentWake(recipient string) (int64, error) {
	return s.q.LastAgentWake(bg, recipient)
}

func (s chatStore) inboxOf(participant, channel string) ([]chatInboxRow, error) {
	list, err := s.q.InboxOf(bg, generated.InboxOfParams{Participant: participant, Channel: channel})
	if err != nil {
		return nil, err
	}
	out := make([]chatInboxRow, len(list))
	for i, x := range list {
		out[i] = chatInboxRow{ID: x.ID, Kind: x.Kind, Parent: textOf(x.ParentID), ParentNumber: numberOf(x.ParentNumber), SubjectKind: textOf(x.SubjectKind),
			SubjectID: textOf(x.SubjectID), ChannelName: channelName(x.ChannelName), Unread: x.Unread, MentionsYou: x.MentionsYou, Latest: x.Latest}
	}
	return out, nil
}

func (s chatStore) messageByNumber(conversation string, number int64) (*chatMsgRow, error) {
	r, err := found(s.q.MessageByNumber(bg, generated.MessageByNumberParams{ConversationID: conversation, Number: number}))
	if r == nil {
		return nil, err
	}
	m := chatMsgOf(r.ChannelMessage, r.ChannelParticipant)
	return &m, nil
}

package chat

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"maps"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/internal/runs"
)

// Every message is written to the database first, in one transaction with who it goes to; only then does it become a fact. A delivery goes pending →
// announced → handed → seen; a session that closes or a turn that ends without a word puts what it was handed back to pending: given twice rather
// than lost. Everything that changes the chat runs one at a time (mu).

const (
	chatReportMax = 1500
	chatReadLimit = 30
	chatRetryWake = 3 * time.Second
)

type chatCrew interface {
	Deliver(id, text string) base.Delivered
	Activity() *base.Hub[base.SessionActivity]
	Find(id string) *base.Roster
}

type Chat struct {
	cfg  base.Config
	db   *sql.DB
	site *base.Site
	crew chatCrew

	square      int64
	foreman     *base.Hub[base.ForemanNews]
	noticeEvery time.Duration
	retryWake   time.Duration

	// Guards everything that changes the chat.
	mu sync.Mutex
	// Nothing is slipped in while a helper compacts its context.
	compacting map[string]bool
	failures   map[string]int
	broken     map[string]bool
	lastRead   map[string]string
	streaming  map[string]int64
	notices    map[string]*time.Timer
	closed     bool

	// The channels' names, read without mu.
	namesMu sync.Mutex
	names   map[int64]string
}

func chatEnvMs(name string, fallback time.Duration) time.Duration {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return time.Duration(n) * time.Millisecond
		}
	}
	return fallback
}

func newChat(cfg base.Config, db *sql.DB, site *base.Site, crew *runs.Crew) (*Chat, error) {
	c := &Chat{
		cfg:         cfg,
		db:          db,
		site:        site,
		crew:        crew,
		foreman:     base.NewHub[base.ForemanNews](),
		noticeEvery: chatEnvMs("VIBEVALLEY_NOTICE_BATCH_MS", protocol.NoticeBatchMs*time.Millisecond),
		retryWake:   chatEnvMs("VIBEVALLEY_RETRY_WAKE_MS", chatRetryWake),
		compacting:  map[string]bool{},
		failures:    map[string]int{},
		broken:      map[string]bool{},
		lastRead:    map[string]string{},
		streaming:   map[string]int64{},
		notices:     map[string]*time.Timer{},
		names:       map[int64]string{},
	}
	s := c.store()
	now := base.NowMs()
	for _, p := range [][3]string{{"user", "user", "主人"}, {"foreman", "foreman", "管家"}, {"system", "system", "农场"}} {
		if err := s.upsertParticipant(p[0], p[1], p[2], nil, nil, now); err != nil {
			return nil, fmt.Errorf("chat: %w", err)
		}
	}
	square, err := s.squareID()
	if err != nil {
		return nil, fmt.Errorf("chat: %w", err)
	}
	if square != nil {
		c.square = *square
	} else if c.square, err = s.createSquare(now); err != nil {
		return nil, fmt.Errorf("chat: %w", err)
	}
	if _, err := c.loadChannels(); err != nil {
		return nil, fmt.Errorf("chat: %w", err)
	}
	if err := c.restore(); err != nil {
		return nil, fmt.Errorf("chat: %w", err)
	}
	return c, nil
}

func (c *Chat) store() chatStore { return chatStore{c.db} }

func (c *Chat) restore() error {
	s := c.store()
	c.mu.Lock()
	defer c.mu.Unlock()
	// Before the chat had a database, the conversation was in farm.json's lines: carried over once.
	if n, err := s.messageCount(); err != nil {
		return err
	} else if n == 0 {
		if err := c.carryLines(); err != nil {
			return err
		}
	}
	// A word half said when the server stopped is as said as it got; whatever was handed and not seen goes back.
	if err := s.finalizeAll(base.NowMs()); err != nil {
		return err
	}
	if err := s.rollbackAll(); err != nil {
		return err
	}
	for _, h := range c.helpers() {
		c.openJob(h)
	}
	convs, err := s.recentConversations(protocol.KeepConversations)
	if err != nil {
		return err
	}
	for i := len(convs) - 1; i >= 0; i-- {
		c.site.Apply(protocol.FactConversation{Conversation: c.toConversation(convs[i])})
	}
	msgs, err := s.recentMessages(protocol.KeepMessages)
	if err != nil {
		return err
	}
	for i := len(msgs) - 1; i >= 0; i-- {
		c.site.Apply(protocol.FactMessage{Message: chatToMessage(msgs[i])})
	}
	return nil
}

func (c *Chat) carryLines() error {
	body, err := os.ReadFile(filepath.Join(c.cfg.Home, "farm.json"))
	if err != nil {
		return nil
	}
	var raw struct {
		Lines []json.RawMessage `json:"lines"`
	}
	if json.Unmarshal(body, &raw) != nil {
		return nil
	}
	s := c.store()
	for _, l := range raw.Lines {
		var line struct {
			Role *string `json:"role"`
			Text *string `json:"text"`
		}
		if json.Unmarshal(l, &line) != nil || line.Role == nil || line.Text == nil {
			continue
		}
		from := "foreman"
		if *line.Role == "user" {
			from = "user"
		}
		seq, err := s.insertMessage(c.square, from, "chat", *line.Text, true, nil, base.NowMs())
		if err != nil {
			return err
		}
		if err := s.touchConversation(c.square, seq); err != nil {
			return err
		}
	}
	return nil
}

func (c *Chat) OnStart(ctx context.Context) error {
	_, events, stopEvents := c.site.Events()
	activity, stopActivity := c.crew.Activity().Subscribe()
	go func() {
		defer stopEvents()
		for {
			select {
			case <-ctx.Done():
				return
			case e, ok := <-events:
				if !ok {
					return
				}
				c.onFact(e)
			}
		}
	}()
	go func() {
		defer stopActivity()
		for {
			select {
			case <-ctx.Done():
				return
			case a, ok := <-activity:
				if !ok {
					return
				}
				c.onActivity(a)
			}
		}
	}()
	c.mu.Lock()
	defer c.mu.Unlock()
	ps, err := c.store().participants()
	if err != nil {
		return fmt.Errorf("chat: %w", err)
	}
	for _, p := range ps {
		if p.Kind == "helper" && p.Left == nil {
			c.kick(p.ID)
		}
	}
	return nil
}

func (c *Chat) OnStop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	for id, t := range c.notices {
		t.Stop()
		delete(c.notices, id)
	}
}

func (c *Chat) later(d time.Duration, fn func()) *time.Timer {
	return time.AfterFunc(d, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if !c.closed {
			fn()
		}
	})
}

func chatSenderKind(kind string) protocol.SenderKind {
	switch kind {
	case "user", "foreman", "helper":
		return protocol.SenderKind(kind)
	}
	return protocol.SenderKindSystem
}

func chatMessageKind(kind string) protocol.MessageKind {
	switch kind {
	case "dispatch", "report", "notice":
		return protocol.MessageKind(kind)
	}
	return protocol.MessageKindChat
}

func chatConversationKind(kind string) protocol.ConversationKind {
	switch kind {
	case "thread", "channel":
		return protocol.ConversationKind(kind)
	}
	return protocol.ConversationKindSquare
}

func chatSubjectKind(kind *string) *protocol.SubjectKind {
	if kind == nil {
		return nil
	}
	switch k := protocol.SubjectKind(*kind); k {
	case protocol.SubjectKindJob, protocol.SubjectKindPlaybook, protocol.SubjectKindTalk:
		return &k
	}
	return nil
}

func chatToMessage(row chatMsgRow) protocol.ChatMessage {
	meta := chatMetaOf(row.Meta)
	m := protocol.ChatMessage{
		Seq:          row.Seq,
		Conversation: row.Conversation,
		From:         row.Sender,
		FromKind:     chatSenderKind(row.SenderKind),
		Name:         row.Name,
		Kind:         chatMessageKind(row.Kind),
		Text:         row.Body,
		Final:        row.Final,
		Outcome:      meta.Outcome,
		Spent:        meta.Spent,
		At:           row.CreatedAt,
	}
	if row.AgentID != nil && *row.AgentID != "" {
		m.Agent = row.AgentID
	}
	if len(meta.Mentions) > 0 {
		m.Mentions = meta.Mentions
	}
	if meta.Helper != "" {
		helper := meta.Helper
		m.Helper = &helper
	}
	return m
}

func (c *Chat) toConversation(row chatConvRow) protocol.Conversation {
	conv := protocol.Conversation{
		ID:          row.ID,
		Kind:        chatConversationKind(row.Kind),
		Parent:      row.ParentSeq,
		Name:        row.Name,
		Description: row.Description,
		Project:     row.Project,
		Channel:     row.ChannelID,
		SubjectKind: chatSubjectKind(row.SubjectKind),
		SubjectID:   row.SubjectID,
		LastSeq:     row.LastSeq,
		Replies:     row.Replies,
		At:          row.CreatedAt,
	}
	if read, err := c.store().readCursor("user", row.ID); err == nil {
		conv.Read = read
	}
	return conv
}

func (c *Chat) channelName(id *int64) *string {
	if id == nil {
		return nil
	}
	c.namesMu.Lock()
	defer c.namesMu.Unlock()
	if name, ok := c.names[*id]; ok {
		return &name
	}
	return nil
}

func (c *Chat) targetOfRow(kind string, parent *int64, name *string, channelID *int64, channelName *string) string {
	conv := protocol.Conversation{Kind: chatConversationKind(kind), Parent: parent, Name: name}
	if conv.Name == nil {
		conv.Name = channelName
	}
	channel := channelName
	if channel == nil {
		channel = c.channelName(channelID)
	}
	return protocol.TargetOf(conv, channel)
}

func (c *Chat) targetOfConv(row chatConvRow) string {
	return c.targetOfRow(row.Kind, row.ParentSeq, row.Name, row.ChannelID, nil)
}

func (c *Chat) loadChannels() ([]chatConvRow, error) {
	rows, err := c.store().channels()
	if err != nil {
		return nil, err
	}
	c.namesMu.Lock()
	defer c.namesMu.Unlock()
	for _, r := range rows {
		if r.Name != nil {
			c.names[r.ID] = *r.Name
		}
	}
	return rows, nil
}

func (c *Chat) channelTags() []string {
	c.namesMu.Lock()
	defer c.namesMu.Unlock()
	ids := slices.Sorted(maps.Keys(c.names))
	tags := make([]string, len(ids))
	for i, id := range ids {
		tags[i] = "#" + c.names[id]
	}
	return tags
}

func (c *Chat) knownChannel(id int64) bool {
	c.namesMu.Lock()
	defer c.namesMu.Unlock()
	_, ok := c.names[id]
	return ok
}

func (c *Chat) channelIDOf(row chatConvRow) int64 {
	if row.Kind == "thread" {
		if row.ChannelID != nil {
			return *row.ChannelID
		}
		return c.square
	}
	return row.ID
}

// A channel the database does not have (farm.json kept, the database not) is the square.
func (c *Chat) channelOfHelper(h protocol.Helper) int64 {
	if h.Channel != nil && c.knownChannel(*h.Channel) {
		return *h.Channel
	}
	return c.square
}

func (c *Chat) helpers() []protocol.Helper { return c.site.State().Helpers }

func (c *Chat) helper(id string) *protocol.Helper { return c.site.Helper(id) }

func chatChannelInfo(row chatConvRow) base.ChannelInfo {
	info := base.ChannelInfo{ID: row.ID, Name: protocol.SquareName}
	if row.Name != nil {
		info.Name = *row.Name
	}
	if row.Description != nil {
		info.Description = *row.Description
	}
	if row.Project != nil {
		info.Project = *row.Project
	}
	return info
}

func (c *Chat) publishConversation(id int64) {
	row, err := c.store().conversation(id)
	if err != nil {
		log.Printf("chat: conversation %d: %v", id, err)
		return
	}
	if row != nil {
		c.site.Apply(protocol.FactConversation{Conversation: c.toConversation(*row)})
	}
}

func (c *Chat) publishMessage(seq int64, answers *string) {
	s := c.store()
	row, err := s.message(seq)
	if err != nil {
		log.Printf("chat: message %d: %v", seq, err)
		return
	}
	if row == nil {
		return
	}
	fact := protocol.FactMessage{Message: chatToMessage(*row), Answers: answers}
	if conv, err := s.conversation(row.Conversation); err == nil && conv != nil && conv.Kind == "thread" &&
		conv.SubjectKind != nil && *conv.SubjectKind == "job" && conv.SubjectID != nil && *conv.SubjectID != "" {
		fact.Thread = conv.SubjectID
	}
	c.site.Apply(fact)
}

func (c *Chat) jobThreadOf(helper string) *int64 {
	id, err := c.store().threadOfSubject("job", helper)
	if err != nil {
		log.Printf("chat: job thread of %s: %v", helper, err)
		return nil
	}
	return id
}

// A refusal's words are for the person.
func chatFail(format string, args ...any) error { return fmt.Errorf(format, args...) }

func (c *Chat) resolveTarget(who, target string) (int64, error) {
	s := c.store()
	if chatTrim(target) == "" {
		if who != "foreman" && who != "user" {
			if own := c.jobThreadOf(who); own != nil {
				return *own, nil
			}
		}
		return c.square, nil
	}
	parsed := protocol.ParseTarget(target)
	if parsed == nil {
		return 0, chatFail("不认识这个地方：%s（写 #<频道>，比如 #田头；或 #<频道>:<消息号>）", target)
	}
	if parsed.Kind == protocol.TargetKindChannel {
		found, err := s.channelByName(parsed.Name)
		if err != nil {
			return 0, err
		}
		if found != nil {
			return *found, nil
		}
		return 0, chatFail("没有叫 #%s 的频道。有：%s", parsed.Name, strings.Join(c.channelTags(), "、"))
	}
	under, err := s.threadByParent(parsed.Parent)
	if err != nil {
		return 0, err
	}
	if under != nil {
		return *under, nil
	}
	parent, err := s.message(parsed.Parent)
	if err != nil {
		return 0, err
	}
	var parentConv *chatConvRow
	if parent != nil {
		if parentConv, err = s.conversation(parent.Conversation); err != nil {
			return 0, err
		}
	}
	if parent == nil || parentConv == nil || parentConv.Kind == "thread" {
		return 0, chatFail("频道里没有 %d 这条消息", parsed.Parent)
	}
	talk := string(protocol.SubjectKindTalk)
	thread, err := s.createThread(parsed.Parent, &talk, nil, parentConv.ID, base.NowMs())
	if err != nil {
		return 0, err
	}
	c.publishConversation(thread)
	return thread, nil
}

func (c *Chat) Say(text string, conversation *int64) (protocol.ChatMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if chatTrim(text) == "" {
		return protocol.ChatMessage{}, errors.New("没说什么")
	}
	s := c.store()
	where := c.square
	if conversation != nil {
		where = *conversation
	}
	conv, err := s.conversation(where)
	if err != nil {
		return protocol.ChatMessage{}, err
	}
	if conv == nil {
		return protocol.ChatMessage{}, chatFail("没有 %d 这个对话", where)
	}
	written, err := c.insert(chatInsert{conversation: where, from: "user", kind: protocol.MessageKindChat, text: chatTrim(text), final: true})
	if err != nil {
		return protocol.ChatMessage{}, err
	}
	if err := s.setReadCursor("user", where, written.seq, base.NowMs()); err != nil {
		return protocol.ChatMessage{}, err
	}
	c.publishConversation(where)
	if len(written.notOnFarm) > 0 {
		names := make([]string, len(written.notOnFarm))
		for i, m := range written.notOnFarm {
			if w, ok := protocol.MentionOf[m]; ok {
				names[i] = w
			} else {
				names[i] = "@" + m
			}
		}
		c.site.Notice(protocol.NoticeLevelWarn, strings.Join(names, "、")+" 不在地里，没送到")
	}
	row, err := s.message(written.seq)
	if err != nil {
		return protocol.ChatMessage{}, err
	}
	if row == nil {
		return protocol.ChatMessage{}, errors.New("写进去了，但读不回来")
	}
	return chatToMessage(*row), nil
}

func (c *Chat) TellHelper(from, helper, text string) (protocol.ChatMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	thread := c.jobThreadOf(helper)
	if thread == nil {
		return protocol.ChatMessage{}, chatFail("没有 %s 的工单串", helper)
	}
	written, err := c.insert(chatInsert{conversation: *thread, from: from, kind: protocol.MessageKindChat, text: chatTrim(text), final: true})
	if err != nil {
		return protocol.ChatMessage{}, err
	}
	s := c.store()
	if from == "user" {
		if err := s.setReadCursor("user", *thread, written.seq, base.NowMs()); err != nil {
			return protocol.ChatMessage{}, err
		}
	}
	row, err := s.message(written.seq)
	if err != nil {
		return protocol.ChatMessage{}, err
	}
	if row == nil {
		return protocol.ChatMessage{}, errors.New("写进去了，但读不回来")
	}
	return chatToMessage(*row), nil
}

func chatInboxOf(row chatMsgRow, target string) base.InboxMessage {
	return base.InboxMessage{Seq: row.Seq, Target: target, From: row.Sender, FromKind: chatSenderKind(row.SenderKind), Name: row.Name, Text: row.Body}
}

func (c *Chat) Speak(from, text string, opt base.SpeakOptions) (base.Spoken, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if chatTrim(text) == "" {
		return base.Spoken{}, errors.New("没说什么")
	}
	words := chatTrim(text)
	s := c.store()
	conversation, err := c.resolveTarget(from, opt.Target)
	if err != nil {
		return base.Spoken{}, err
	}
	row, err := s.conversation(conversation)
	if err != nil {
		return base.Spoken{}, err
	}
	if row == nil {
		return base.Spoken{}, errors.New("找不到这个对话")
	}
	target := c.targetOfConv(*row)
	// A retry of the same words is the same message.
	again, err := s.recentDuplicate(from, conversation, words, base.NowMs()-protocol.RetryWindowMs)
	if err != nil {
		return base.Spoken{}, err
	}
	if again != nil {
		if m, err := s.message(*again); err == nil && m != nil {
			return base.Spoken{Kind: "sent", Message: chatToMessage(*m), Target: target, NotOnFarm: []string{}}, nil
		}
	}
	// Posting on a channel right after reading a thread: confirm once.
	if last := c.lastRead[from]; row.Kind != "thread" && !opt.Confirm && last != "" && last != target {
		return base.Spoken{Kind: "confirm", Target: target, LastRead: last}, nil
	}
	// Newer messages it has not seen: show them instead of sending.
	unseen, err := s.unseenIn(conversation, from)
	if err != nil {
		return base.Spoken{}, err
	}
	if len(unseen) > 0 && !opt.Anyway {
		now := base.NowMs()
		shown := []base.InboxMessage{}
		for _, seq := range unseen[:min(len(unseen), protocol.HeldShown)] {
			m, err := s.message(seq)
			if err != nil {
				return base.Spoken{}, err
			}
			if m == nil {
				continue
			}
			shown = append(shown, chatInboxOf(*m, target))
			if err := s.addSeenMark(from, m.Seq); err != nil {
				return base.Spoken{}, err
			}
			if err := s.seenOne(from, m.Seq, now); err != nil {
				return base.Spoken{}, err
			}
		}
		if len(shown) == len(unseen) {
			if err := s.setReadCursor(from, conversation, unseen[0], now); err != nil {
				return base.Spoken{}, err
			}
		}
		for i, j := 0, len(shown)-1; i < j; i, j = i+1, j-1 {
			shown[i], shown[j] = shown[j], shown[i]
		}
		return base.Spoken{Kind: "held", Target: target, Shown: shown, More: len(unseen) - len(shown)}, nil
	}
	var answers *string
	if from != "foreman" {
		if answers, err = s.calledBy(from, conversation, math.MaxInt64); err != nil {
			return base.Spoken{}, err
		}
	}
	written, err := c.insert(chatInsert{conversation: conversation, from: from, kind: protocol.MessageKindChat, text: words, final: true, answers: answers})
	if err != nil {
		return base.Spoken{}, err
	}
	if err := s.setReadCursor(from, conversation, written.seq, base.NowMs()); err != nil {
		return base.Spoken{}, err
	}
	m, err := s.message(written.seq)
	if err != nil {
		return base.Spoken{}, err
	}
	if m == nil {
		return base.Spoken{}, errors.New("写进去了，但读不回来")
	}
	notOnFarm := written.notOnFarm
	if notOnFarm == nil {
		notOnFarm = []string{}
	}
	return base.Spoken{Kind: "sent", Message: chatToMessage(*m), Target: target, NotOnFarm: notOnFarm}, nil
}

// The same key again replaces the words until final; delivered once final.
func (c *Chat) ForemanSays(conversation int64, key, text string, final bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	seq, growing := c.streaming[key]
	if !growing {
		if chatTrim(text) == "" && !final {
			return
		}
		written, err := c.insert(chatInsert{conversation: conversation, from: "foreman", kind: protocol.MessageKindChat, text: text, final: final})
		if err != nil {
			log.Printf("chat: the manager's words: %v", err)
			return
		}
		if !final {
			c.streaming[key] = written.seq
		}
		return
	}
	if !final {
		if err := c.store().updateMessageBody(seq, text, false, base.NowMs()); err != nil {
			log.Printf("chat: the manager's words: %v", err)
			return
		}
		c.publishMessage(seq, nil)
		return
	}
	delete(c.streaming, key)
	var written chatWritten
	err := c.inTx(func(s chatStore) error {
		if err := s.updateMessageBody(seq, text, true, base.NowMs()); err != nil {
			return err
		}
		var err error
		written, err = c.settle(s, seq)
		written.seq = seq
		return err
	})
	if err != nil {
		log.Printf("chat: the manager's words: %v", err)
		return
	}
	c.after(conversation, written, nil)
}

// code names the kind, for dropping repeats.
func (c *Chat) Notice(conversation int64, text, code string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := c.insert(chatInsert{conversation: conversation, from: "system", kind: protocol.MessageKindNotice, text: text, final: true, meta: &chatMeta{Code: code}}); err != nil {
		log.Printf("chat: notice: %v", err)
	}
}

func (c *Chat) Read(who string, opt base.ReadOptions) (base.ReadResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.store()
	conversation, err := c.resolveTarget(who, opt.Target)
	if err != nil {
		return base.ReadResult{}, err
	}
	row, err := s.conversation(conversation)
	if err != nil {
		return base.ReadResult{}, err
	}
	if row == nil {
		return base.ReadResult{}, errors.New("找不到这个对话")
	}
	target := c.targetOfConv(*row)
	limit := chatReadLimit
	if opt.Limit != 0 {
		limit = int(min(max(opt.Limit, 1), 100))
	}
	cursor := int64(0)
	if r, err := s.readCursor(who, conversation); err != nil {
		return base.ReadResult{}, err
	} else if r != nil {
		cursor = *r
	}
	var rows []chatMsgRow
	if opt.Unread {
		rows, err = s.messagesAfter(conversation, cursor, limit)
	} else {
		before := chatNoSeq
		if opt.Before != 0 {
			before = opt.Before
		}
		rows, err = s.messagesBefore(conversation, before, limit)
		for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
			rows[i], rows[j] = rows[j], rows[i]
		}
	}
	if err != nil {
		return base.ReadResult{}, err
	}
	if len(rows) > 0 && opt.Before == 0 {
		upto, now := rows[len(rows)-1].Seq, base.NowMs()
		if err := s.setReadCursor(who, conversation, upto, now); err != nil {
			return base.ReadResult{}, err
		}
		if err := s.pruneSeenMarks(who, conversation, upto); err != nil {
			return base.ReadResult{}, err
		}
		if err := s.seenUpTo(who, conversation, upto, now); err != nil {
			return base.ReadResult{}, err
		}
	}
	c.lastRead[who] = target
	older := false
	if len(rows) > 0 {
		before, err := s.messagesBefore(conversation, rows[0].Seq, 1)
		if err != nil {
			return base.ReadResult{}, err
		}
		older = len(before) > 0
	}
	messages := make([]base.InboxMessage, len(rows))
	for i, m := range rows {
		messages[i] = chatInboxOf(m, target)
	}
	return base.ReadResult{Target: target, Messages: messages, Older: older}, nil
}

func (c *Chat) Inbox(who string) []base.UnreadRow {
	c.mu.Lock()
	defer c.mu.Unlock()
	rows, err := c.inboxRows(who)
	if err != nil {
		log.Printf("chat: inbox of %s: %v", who, err)
	}
	return rows
}

func (c *Chat) History(conversation int64, before, limit *int64) ([]protocol.ChatMessage, error) {
	b, n := chatNoSeq, int64(50)
	if before != nil {
		b = *before
	}
	if limit != nil {
		n = *limit
	}
	rows, err := c.store().messagesBefore(conversation, b, int(min(max(n, 1), 200)))
	if err != nil {
		return nil, err
	}
	out := make([]protocol.ChatMessage, len(rows))
	for i, r := range rows {
		out[len(rows)-1-i] = chatToMessage(r)
	}
	return out, nil
}

func (c *Chat) MarkRead(conversation, seq int64) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.store()
	row, err := s.conversation(conversation)
	if err != nil {
		return err
	}
	if row == nil {
		return chatFail("没有 %d 这个对话", conversation)
	}
	if err := s.setReadCursor("user", conversation, seq, base.NowMs()); err != nil {
		return err
	}
	c.publishConversation(conversation)
	return nil
}

func (c *Chat) JobThread(helper string) *int64 { return c.jobThreadOf(helper) }

func (c *Chat) ForForeman() *base.Hub[base.ForemanNews] { return c.foreman }

func (c *Chat) ForemanDigest() []base.InboxMessage {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.store()
	rows, err := s.openDeliveries("foreman")
	if err != nil {
		log.Printf("chat: the manager's digest: %v", err)
		return nil
	}
	out := []base.InboxMessage{}
	now := base.NowMs()
	for _, r := range rows {
		if r.Wakes && r.HeldBy == nil {
			continue
		}
		if err := s.seenOne("foreman", r.Seq, now); err != nil {
			log.Printf("chat: the manager's digest: %v", err)
		}
		out = append(out, c.asInbox(r))
	}
	return out
}

func (c *Chat) Square() int64 { return c.square }

func (c *Chat) Channels() []base.ChannelInfo {
	rows, err := c.loadChannels()
	if err != nil {
		log.Printf("chat: channels: %v", err)
		return []base.ChannelInfo{{ID: c.square, Name: protocol.SquareName}}
	}
	out := make([]base.ChannelInfo, len(rows))
	for i, r := range rows {
		out[i] = chatChannelInfo(r)
	}
	return out
}

func chatOptional(s string) *string {
	if t := chatTrim(s); t != "" {
		return &t
	}
	return nil
}

func (c *Chat) OpenChannel(name, description, project string) (base.ChannelInfo, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	clean := strings.TrimPrefix(chatTrim(name), "#")
	rows, err := c.loadChannels()
	if err != nil {
		return base.ChannelInfo{}, err
	}
	taken := []string{}
	for _, r := range rows {
		if r.Name != nil {
			taken = append(taken, *r.Name)
		}
	}
	if problem := protocol.ChannelNameProblem(clean, taken); problem != "" {
		return base.ChannelInfo{}, errors.New(problem)
	}
	desc, proj := chatOptional(description), chatOptional(project)
	id, err := c.store().createChannel(clean, desc, proj, base.NowMs())
	if err != nil {
		return base.ChannelInfo{}, err
	}
	c.namesMu.Lock()
	c.names[id] = clean
	c.namesMu.Unlock()
	c.publishConversation(id)
	return chatChannelInfo(chatConvRow{ID: id, Name: &clean, Description: desc, Project: proj}), nil
}

// description nil or empty: as it was; project nil: as it was, empty: none.
func (c *Chat) UpdateChannel(id int64, description, project *string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.store()
	row, err := s.conversation(id)
	if err != nil {
		return err
	}
	if row == nil || row.Kind == "thread" {
		return chatFail("没有 %d 这个频道", id)
	}
	desc, proj := row.Description, row.Project
	if description != nil {
		if d := chatOptional(*description); d != nil {
			desc = d
		}
	}
	if project != nil {
		proj = chatOptional(*project)
	}
	if err := s.updateChannel(id, desc, proj); err != nil {
		return err
	}
	c.publishConversation(id)
	return nil
}

func (c *Chat) ChannelOf(conversation int64) base.ChannelInfo {
	s := c.store()
	id := c.square
	if row, err := s.conversation(conversation); err == nil && row != nil {
		id = c.channelIDOf(*row)
	}
	if channel, err := s.conversation(id); err == nil && channel != nil {
		return chatChannelInfo(*channel)
	}
	return base.ChannelInfo{ID: c.square, Name: protocol.SquareName}
}

func (c *Chat) ChannelByName(name string) *base.ChannelInfo {
	s := c.store()
	found, err := s.channelByName(strings.TrimPrefix(chatTrim(name), "#"))
	if err != nil || found == nil {
		return nil
	}
	row, err := s.conversation(*found)
	if err != nil || row == nil {
		return nil
	}
	info := chatChannelInfo(*row)
	return &info
}

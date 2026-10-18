package channel

import (
	"fmt"
	"log"
	"slices"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

// Every function here runs with c.mu held.

type chatWrite struct {
	id           string
	conversation string
	from         string
	kind         protocol.MessageKind
	text         string
	final        bool
	meta         *chatMeta
	answers      *string
	thread       *threadSubject
	// A participant who follows the conversation from this message on, in the same transaction.
	follow string
	// The client's key for one send, "" for none: the same key from the same sender again is that message, not a new one.
	sendKey string
}

type chatWritten struct {
	id         string
	number     int64
	recipients []string
	resetWake  []string
	notOnFarm  []string
	held       bool
	thread     string
	// A send with a key already written: nothing new is written or delivered.
	again bool
}

func (c *Service) inTx(fn func(s chatStore) error) error {
	tx, err := c.db.Begin()
	if err != nil {
		return err
	}
	if err := fn(chatStore{generated.New(tx)}); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

func (c *Service) settle(s chatStore, id string) (chatWritten, error) {
	row, err := s.message(id)
	if err != nil || row == nil {
		return chatWritten{}, err
	}
	conv, err := s.conversation(row.Conversation)
	if err != nil || conv == nil {
		return chatWritten{}, err
	}
	meta := chatMetaOf(row.Meta)
	mentions := mentionsIn(row.Body)
	sessions := c.onFarm()
	onFarm := make([]string, len(sessions))
	for i, h := range sessions {
		onFarm[i] = h.ID
	}
	participants, err := s.participants()
	if err != nil {
		return chatWritten{}, err
	}
	known := map[string]bool{}
	for _, p := range participants {
		known[p.ID] = true
	}
	type resolved struct{ id, how string }
	named := make([]resolved, len(mentions))
	for i, m := range mentions {
		how := "unknown"
		switch {
		case m == protocol.ManagerAgent || m == "user" || m == protocol.Everyone || slices.Contains(onFarm, m):
			how = "delivered"
		case known[m]:
			how = "not_on_farm"
		}
		named[i] = resolved{m, how}
		if err := s.insertMention(row.ID, m, how); err != nil {
			return chatWritten{}, err
		}
	}
	if len(mentions) > 0 {
		meta.Mentions = mentions
		if err := s.updateMessageMeta(row.ID, meta); err != nil {
			return chatWritten{}, err
		}
	}
	var followers []string
	if conv.Kind == "thread" {
		// A dispatch handing the issue to its next session makes no one a follower: the manager would be woken by every word in it.
		if row.Sender != "system" && row.Kind != string(protocol.MessageKindDispatch) {
			if err := s.follow(conv.ID, row.Sender, "replied", row.Number); err != nil {
				return chatWritten{}, err
			}
		}
		for _, m := range named {
			if m.how == "delivered" && (m.id == protocol.ManagerAgent || slices.Contains(onFarm, m.id)) {
				if err := s.follow(conv.ID, m.id, "mentioned", row.Number-1); err != nil {
					return chatWritten{}, err
				}
			}
		}
		if followers, err = s.followers(conv.ID); err != nil {
			return chatWritten{}, err
		}
	}
	hops, err := s.agentWakesSinceUser(conv.ID)
	if err != nil {
		return chatWritten{}, err
	}
	now := clock.NowMs()
	cooling := []string{}
	for _, h := range sessions {
		at, err := s.lastAgentWake(h.ID)
		if err != nil {
			return chatWritten{}, err
		}
		if now-at < protocol.AgentWakeCooldownMs {
			cooling = append(cooling, h.ID)
		}
	}
	audience := []string{}
	for _, h := range sessions {
		if conv.Kind == "thread" || c.channelOfSession(h) == conv.ID {
			audience = append(audience, h.ID)
		}
	}
	broken := slices.Sorted(func(yield func(string) bool) {
		for id := range c.broken {
			if !yield(id) {
				return
			}
		}
	})
	in := chatAudienceInput{
		From:         row.Sender,
		FromKind:     chatSenderKind(row.SenderKind),
		Kind:         chatMessageKind(row.Kind),
		Mentions:     mentions,
		Conversation: protocol.Conversation{Kind: chatConversationKind(conv.Kind)},
		ThreadOwner:  c.ownerOf(*conv),
		Sessions:     audience,
		OnFarm:       onFarm,
		Followers:    followers,
		Hops:         hops,
		Cooling:      cooling,
		Broken:       broken,
		Outcome:      meta.Outcome,
		ForTask:      meta.ForTask,
		Spoken:       meta.Spoken,
	}
	deliveries := chatAudience(in)
	for _, d := range deliveries {
		if err := s.insertDelivery(d, row.ID, now); err != nil {
			return chatWritten{}, err
		}
	}
	w := chatWritten{id: row.ID, number: row.Number}
	// Reset the breaker only after the message transaction commits.
	if row.Sender == "user" {
		for _, d := range deliveries {
			if d.Wakes {
				w.resetWake = append(w.resetWake, d.Recipient)
			}
		}
	}
	held := false
	if slices.ContainsFunc(deliveries, func(d chatDelivery) bool { return d.HeldBy == heldByHopLimit }) {
		n, err := s.holdNoticeSinceUser(conv.ID)
		if err != nil {
			return chatWritten{}, err
		}
		held = n == 0
	}
	w.held = held
	for _, d := range deliveries {
		if d.HeldBy == "" && !slices.Contains(w.recipients, d.Recipient) {
			w.recipients = append(w.recipients, d.Recipient)
		}
	}
	for _, m := range named {
		if m.how != "delivered" {
			w.notOnFarm = append(w.notOnFarm, m.id)
		}
	}
	return w, nil
}

func (c *Service) write(in chatWrite) (chatWritten, error) {
	var written chatWritten
	err := c.inTx(func(s chatStore) error {
		id := in.id
		var number int64
		if id == "" && in.sendKey != "" {
			seen, err := s.messageBySendKey(in.from, in.sendKey)
			if err != nil {
				return err
			}
			if seen != nil {
				written = chatWritten{id: seen.ID, number: seen.Number, again: true}
				return nil
			}
		}
		if id == "" {
			id = base.NewID()
			var err error
			number, err = s.insertMessage(id, in.conversation, in.from, string(in.kind), in.text, in.final, in.meta, in.sendKey, clock.NowMs())
			if err != nil {
				return err
			}
			if err := s.touchConversation(in.conversation, number); err != nil {
				return err
			}
		} else {
			if err := s.updateMessageBody(id, in.text, in.final, clock.NowMs()); err != nil {
				return err
			}
			row, err := s.message(id)
			if err != nil {
				return err
			}
			if row == nil {
				return fmt.Errorf("没有 %s 这条消息", id)
			}
			number = row.Number
		}
		if in.final {
			var err error
			if written, err = c.settle(s, id); err != nil {
				return err
			}
		}
		written.id, written.number = id, number
		if in.follow != "" {
			if err := s.follow(in.conversation, in.follow, "owner", number); err != nil {
				return err
			}
		}
		if in.thread != nil {
			var err error
			written.thread, err = s.threadFor(chatMsgRow{ID: id, Number: number, Conversation: in.conversation}, *in.thread)
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return chatWritten{}, err
	}
	if !written.again {
		c.after(in.conversation, written, in.answers)
	}
	return written, nil
}

func (c *Service) after(conversation string, written chatWritten, answers *string) {
	for _, recipient := range written.resetWake {
		delete(c.broken, recipient)
		delete(c.failures, recipient)
	}
	c.publishMessage(written.id, answers)
	c.publishConversation(conversation)
	if written.thread != "" {
		c.publishConversation(written.thread)
	}
	if written.held {
		text := hopLimitText(protocol.HopLimit)
		if _, err := c.write(chatWrite{conversation: conversation, from: "system", kind: protocol.MessageKindNotice, text: text, final: true, meta: &chatMeta{Code: "hop_limit"}}); err != nil {
			log.Printf("chat: hop limit notice: %v", err)
		}
	}
	for _, r := range written.recipients {
		c.kick(r)
	}
}

func (c *Service) deliveryTarget(r chatDeliveryRow) string {
	return c.targetOfRow(r.ConversationKind, r.Parent, r.ParentNumber, nil, nil, r.ChannelName)
}

func (c *Service) asInbox(r chatDeliveryRow) protocol.InboxMessage {
	return protocol.InboxMessage{ID: r.Message, Number: r.Number, Target: c.deliveryTarget(r), From: r.Sender, FromKind: chatSenderKind(r.SenderKind), Name: r.Name, Text: r.Body}
}

func (c *Service) groupRows(rows []chatDeliveryRow) []chatUnreadRow {
	var out []chatUnreadRow
	for _, r := range rows {
		target := c.deliveryTarget(r)
		i := slices.IndexFunc(out, func(u chatUnreadRow) bool { return u.Target == target })
		if i < 0 {
			out = append(out, chatUnreadRow{Target: target})
			i = len(out) - 1
		}
		out[i].Unread++
		out[i].MentionsYou = out[i].MentionsYou || r.Reason == "mention" || r.Reason == "everyone"
		out[i].Latest = r.Name
	}
	return out
}

func (c *Service) kick(recipient string) {
	if err := c.kicked(recipient); err != nil {
		log.Printf("chat: delivering to %s: %v", recipient, err)
	}
}

func (c *Service) kicked(recipient string) error {
	s := c.store()
	rows, err := s.openDeliveries(recipient)
	if err != nil {
		return err
	}
	var waking []chatDeliveryRow
	for _, r := range rows {
		if r.Wakes && r.HeldBy == nil && (r.State == "pending" || r.State == "announced") {
			waking = append(waking, r)
		}
	}
	if recipient == protocol.ManagerAgent {
		var order []string
		byConversation := map[string][]chatDeliveryRow{}
		for _, r := range waking {
			if _, ok := byConversation[r.Conversation]; !ok {
				order = append(order, r.Conversation)
			}
			byConversation[r.Conversation] = append(byConversation[r.Conversation], r)
		}
		now := clock.NowMs()
		for _, conversation := range order {
			rs := byConversation[conversation]
			messages := make([]protocol.InboxMessage, len(rs))
			for i, r := range rs {
				messages[i] = c.asInbox(r)
			}
			c.manager.Publish(ManagerNews{Conversation: conversation, Target: messages[0].Target, Messages: messages})
			for _, r := range rs {
				if err := s.seenOne(protocol.ManagerAgent, r.Message, now); err != nil {
					return err
				}
			}
		}
		return nil
	}
	session := c.sessionOf(recipient)
	if session == nil {
		return s.dropOpen(recipient, "left")
	}
	if protocol.IsBusy(*session) {
		// Gathered for a moment: a burst of messages is one notice.
		pending := slices.ContainsFunc(rows, func(r chatDeliveryRow) bool { return r.State == "pending" && r.HeldBy == nil })
		if pending && c.notices[recipient] == nil {
			c.notices[recipient] = c.later(c.noticeEvery, func() {
				delete(c.notices, recipient)
				c.notify(recipient)
			})
		}
		return nil
	}
	if len(waking) == 0 || c.broken[recipient] {
		return nil
	}
	messages := make([]protocol.InboxMessage, len(waking))
	for i, r := range waking {
		messages[i] = c.asInbox(r)
	}
	unread, err := c.inboxRows(recipient)
	if err != nil {
		return err
	}
	others := slices.DeleteFunc(unread, func(o chatUnreadRow) bool {
		return slices.ContainsFunc(messages, func(m protocol.InboxMessage) bool { return m.Target == o.Target })
	})
	delivered := c.sessions.Deliver(recipient, wakeInput(messages, others), protocol.RunTrigger{Kind: protocol.RunTriggerKindComment, Message: &waking[0].Message})
	if delivered.Kind == "refused" {
		log.Printf("chat: %s not woken: %s", recipient, delivered.Reason)
		return nil
	}
	now := clock.NowMs()
	for _, r := range waking {
		if err := s.markHanded(recipient, r.Message, delivered.Launch, now); err != nil {
			return err
		}
	}
	return nil
}

func (c *Service) notify(recipient string) {
	if c.compacting[recipient] {
		return
	}
	session := c.sessionOf(recipient)
	if session == nil {
		return
	}
	if !protocol.IsBusy(*session) {
		c.kick(recipient)
		return
	}
	s := c.store()
	all, err := s.openDeliveries(recipient)
	if err != nil {
		log.Printf("chat: notice for %s: %v", recipient, err)
		return
	}
	rows := slices.DeleteFunc(all, func(r chatDeliveryRow) bool { return r.State != "pending" || r.HeldBy != nil })
	if len(rows) == 0 {
		return
	}
	delivered := c.sessions.Deliver(recipient, busyNotice(c.groupRows(rows)), protocol.RunTrigger{Kind: protocol.RunTriggerKindComment, Message: &rows[0].Message})
	if delivered.Kind == "refused" {
		return
	}
	now := clock.NowMs()
	for _, r := range rows {
		if err := s.markAnnounced(recipient, r.Message, delivered.Launch, now); err != nil {
			log.Printf("chat: notice for %s: %v", recipient, err)
			return
		}
	}
}

func (c *Service) inboxRows(who string) ([]chatUnreadRow, error) {
	s := c.store()
	channel := c.general
	if h := c.sessionOf(who); h != nil {
		channel = c.channelOfSession(*h)
	}
	rows, err := s.inboxOf(who, channel)
	if err != nil {
		return nil, err
	}
	out := []chatUnreadRow{}
	for _, r := range rows[:min(len(rows), protocol.SummaryConversations)] {
		u := chatUnreadRow{Target: c.targetOfRow(r.Kind, r.Parent, r.ParentNumber, nil, nil, r.ChannelName), Unread: r.Unread, MentionsYou: r.MentionsYou}
		if latest, err := s.messageByNumber(r.ID, r.Latest); err == nil && latest != nil {
			u.Latest = latest.Name
		}
		out = append(out, u)
	}
	return out, nil
}

func (c *Service) onActivity(a session.LaunchActivity) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	s := c.store()
	switch a.Kind {
	case "spoke":
		delete(c.failures, a.ID)
		if err := c.heardLaunch(a.ID, a.Launch); err != nil {
			log.Printf("chat: %s spoke: %v", a.ID, err)
		}
	case "ended":
		if !a.Spoke {
			n, err := s.rollbackHanded(a.ID)
			if err != nil {
				log.Printf("chat: %s ended: %v", a.ID, err)
				return
			}
			if n > 0 {
				c.failures[a.ID]++
				failed := c.failures[a.ID]
				if failed >= protocol.WakeBreaker && !c.broken[a.ID] {
					c.broken[a.ID] = true
					where := c.general
					if thread := c.threadOfSession(a.ID); thread != nil {
						where = *thread
					}
					name := a.ID
					if h := c.sessionOf(a.ID); h != nil {
						name = h.Name
					}
					text := fmt.Sprintf("%s 连续 %d 次一叫醒就失败了，先不再叫它；你直接给它带句话会再试。", name, failed)
					if _, err := c.write(chatWrite{conversation: where, from: "system", kind: protocol.MessageKindNotice, text: text, final: true, meta: &chatMeta{Code: "wake_breaker"}}); err != nil {
						log.Printf("chat: wake breaker notice: %v", err)
					}
				}
				// Not straight away: what failed may fail again.
				id := a.ID
				c.later(c.retryWake, func() { c.kick(id) })
				return
			}
		}
		c.kick(a.ID)
	case "closed":
		if _, err := s.rollbackHanded(a.ID); err != nil {
			log.Printf("chat: %s closed: %v", a.ID, err)
		}
		if err := s.rollbackAnnounced(a.ID, a.Launch); err != nil {
			log.Printf("chat: %s closed: %v", a.ID, err)
		}
	case "compacting":
		if a.On {
			c.compacting[a.ID] = true
		} else {
			delete(c.compacting, a.ID)
			c.kick(a.ID)
		}
	}
}

// Handled before the next one.
func (c *Service) onFact(e protocol.SideEvent) {
	switch f := e.Value.(type) {
	case protocol.FactHired, protocol.FactLeft:
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.closed {
			return
		}
		if _, hired := f.(protocol.FactHired); hired {
			for _, h := range c.onFarm() {
				c.openJob(h)
			}
			return
		}
		c.sessionsLeft()
	case protocol.FactReport:
		c.mu.Lock()
		defer c.mu.Unlock()
		if !c.closed {
			c.postReport(f.ID, f.Outcome, f.Summary, f.Spent, f.Run)
		}
	}
}

func (c *Service) sessionsLeft() {
	s := c.store()
	on := map[string]bool{}
	for _, h := range c.onFarm() {
		on[h.ID] = true
	}
	ps, err := s.participants()
	if err != nil {
		log.Printf("chat: sessions left: %v", err)
		return
	}
	now := clock.NowMs()
	for _, p := range ps {
		if p.Kind != string(protocol.SenderKindAgent) || p.Left != nil || on[p.ID] {
			continue
		}
		if err := s.participantLeft(p.ID, now); err != nil {
			log.Printf("chat: %s left: %v", p.ID, err)
		}
		if err := s.dropOpen(p.ID, "left"); err != nil {
			log.Printf("chat: %s left: %v", p.ID, err)
		}
		if t := c.notices[p.ID]; t != nil {
			t.Stop()
			delete(c.notices, p.ID)
		}
		delete(c.broken, p.ID)
		delete(c.failures, p.ID)
	}
}

func (c *Service) openJob(h protocol.Session) {
	if err := c.openedJob(h); err != nil {
		log.Printf("chat: %s's job: %v", h.ID, err)
	}
}

func (c *Service) openedJob(h protocol.Session) error {
	s := c.store()
	agent, runtime := h.Agent, h.Runtime
	if err := s.upsertParticipant(h.ID, string(protocol.SenderKindAgent), h.Name, &agent, &runtime, clock.NowMs()); err != nil {
		return err
	}
	job := jobOf(h)
	if thread := c.threadOf(job); thread != nil {
		return c.handedOn(h, *thread)
	}
	channel := c.channelOfSession(h)
	latest, err := s.latestNumber(channel)
	if err != nil {
		return err
	}
	if err := s.setReadCursor(h.ID, channel, latest, clock.NowMs()); err != nil {
		return err
	}
	var what string
	switch {
	case h.Graph != nil && h.Graph.Task != nil:
		what = fmt.Sprintf("做种植计划 %s 的「%s」", h.Graph.ID, *h.Graph.Task)
	case h.Graph != nil:
		what = "拆种植计划 " + h.Graph.ID
	default:
		what = str.Head(str.Spaces.ReplaceAllString(h.Brief, " "), 80)
	}
	project := "项目"
	if h.Project != nil {
		project = *h.Project
	}
	text := fmt.Sprintf("派 @%s（%s）去 %s：%s", h.ID, h.Name, project, what)
	_, err = c.write(chatWrite{conversation: channel, from: protocol.ManagerAgent, kind: protocol.MessageKindDispatch, text: text, final: true,
		meta: &chatMeta{Session: h.ID}, thread: &job})
	return err
}

// The issue already has its thread (reopened, or sent to another session): the next session is told of in it and follows
// it, in one transaction, so a restart neither says it twice nor leaves it out.
func (c *Service) handedOn(h protocol.Session, thread string) error {
	s := c.store()
	followers, err := s.followers(thread)
	if err != nil {
		return err
	}
	if slices.Contains(followers, h.ID) {
		return nil
	}
	channel := c.channelOfSession(h)
	latest, err := s.latestNumber(channel)
	if err != nil {
		return err
	}
	if err := s.setReadCursor(h.ID, channel, latest, clock.NowMs()); err != nil {
		return err
	}
	nth := 1
	if i := slices.IndexFunc(c.core.State().Issues, func(t protocol.Issue) bool { return t.ID == *h.Issue }); i >= 0 {
		// Linked to the issue or not yet, it is the one after those before it.
		sessions := c.core.State().Issues[i].Sessions
		nth = len(sessions) + 1
		if at := slices.Index(sessions, h.ID); at >= 0 {
			nth = at + 1
		}
	}
	text := fmt.Sprintf("这张工单交给 @%s（%s）接着做，第 %d 次派活", h.ID, h.Name, nth)
	_, err = c.write(chatWrite{conversation: thread, from: protocol.ManagerAgent, kind: protocol.MessageKindDispatch, text: text, final: true,
		meta: &chatMeta{Session: h.ID}, follow: h.ID})
	return err
}

func (c *Service) postReport(id string, outcome protocol.Outcome, summary string, spent *protocol.Spent, run *string) {
	w := c.sessionOf(id)
	if w == nil || outcome == protocol.OutcomeInterrupted {
		return
	}
	thread := c.threadOfSession(id)
	if thread == nil {
		return
	}
	said := ""
	if outcome == protocol.OutcomeCompleted {
		if r := c.sessions.Find(id); r != nil {
			said = session.SummaryOf(r.LastText)
		}
	}
	text := said
	if text == "" {
		text = summary
	}
	o := outcome
	meta := &chatMeta{Outcome: &o, Spent: spent, ForTask: w.Graph != nil}
	if run != nil {
		meta.Run = *run
	}
	if _, err := c.write(chatWrite{conversation: *thread, from: id, kind: protocol.MessageKindReport, text: str.Head(text, chatReportMax), final: true, meta: meta}); err != nil {
		log.Printf("chat: %s's report: %v", id, err)
	}
}

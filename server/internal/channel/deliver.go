package channel

import (
	"fmt"
	"log"
	"slices"

	"vibevalley/internal/protocol"
	"vibevalley/internal/worker"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

// Every function here runs with c.mu held.

type chatInsert struct {
	conversation int64
	from         string
	kind         protocol.MessageKind
	text         string
	final        bool
	meta         *chatMeta
	answers      *string
}

type chatWritten struct {
	seq        int64
	recipients []string
	notOnFarm  []string
	held       bool
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

func (c *Service) settle(s chatStore, seq int64) (chatWritten, error) {
	row, err := s.message(seq)
	if err != nil || row == nil {
		return chatWritten{}, err
	}
	conv, err := s.conversation(row.Conversation)
	if err != nil || conv == nil {
		return chatWritten{}, err
	}
	meta := chatMetaOf(row.Meta)
	mentions := mentionsIn(row.Body)
	workers := c.onFarm()
	onFarm := make([]string, len(workers))
	for i, h := range workers {
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
		if err := s.insertMention(seq, m, how); err != nil {
			return chatWritten{}, err
		}
	}
	if len(mentions) > 0 {
		meta.Mentions = mentions
		if err := s.updateMessageMeta(seq, meta); err != nil {
			return chatWritten{}, err
		}
	}
	var followers []string
	if conv.Kind == "thread" {
		if row.Sender != "system" {
			if err := s.follow(conv.ID, row.Sender, "replied", seq); err != nil {
				return chatWritten{}, err
			}
		}
		for _, m := range named {
			if m.how == "delivered" && (m.id == protocol.ManagerAgent || slices.Contains(onFarm, m.id)) {
				if err := s.follow(conv.ID, m.id, "mentioned", seq-1); err != nil {
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
	for _, h := range workers {
		at, err := s.lastAgentWake(h.ID)
		if err != nil {
			return chatWritten{}, err
		}
		if now-at < protocol.AgentWakeCooldownMs {
			cooling = append(cooling, h.ID)
		}
	}
	audience := []string{}
	for _, h := range workers {
		if conv.Kind == "thread" || c.channelOfWorker(h) == conv.ID {
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
		Conversation: protocol.Conversation{Kind: chatConversationKind(conv.Kind), SubjectKind: chatSubjectKind(conv.SubjectKind), SubjectID: conv.SubjectID},
		Workers:      audience,
		OnFarm:       onFarm,
		Followers:    followers,
		Hops:         hops,
		Cooling:      cooling,
		Broken:       broken,
		Outcome:      meta.Outcome,
		ForPlaybook:  meta.ForPlaybook,
	}
	if in.Conversation.SubjectID != nil && *in.Conversation.SubjectID == "" {
		in.Conversation.SubjectID = nil
	}
	deliveries := chatAudience(in)
	for _, d := range deliveries {
		if err := s.insertDelivery(d, seq, now); err != nil {
			return chatWritten{}, err
		}
	}
	// The person speaking resets a worker's failed wakes: they asked for it themselves.
	if row.Sender == "user" {
		for _, d := range deliveries {
			if d.Wakes {
				delete(c.broken, d.Recipient)
				delete(c.failures, d.Recipient)
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
	w := chatWritten{seq: seq, held: held}
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

func (c *Service) insert(in chatInsert) (chatWritten, error) {
	var written chatWritten
	err := c.inTx(func(s chatStore) error {
		seq, err := s.insertMessage(in.conversation, in.from, string(in.kind), in.text, in.final, in.meta, clock.NowMs())
		if err != nil {
			return err
		}
		if err := s.touchConversation(in.conversation, seq); err != nil {
			return err
		}
		if in.final {
			if written, err = c.settle(s, seq); err != nil {
				return err
			}
		}
		written.seq = seq
		return nil
	})
	if err != nil {
		return chatWritten{}, err
	}
	c.after(in.conversation, written, in.answers)
	return written, nil
}

func (c *Service) after(conversation int64, written chatWritten, answers *string) {
	c.publishMessage(written.seq, answers)
	c.publishConversation(conversation)
	if written.held {
		text := hopLimitText(protocol.HopLimit)
		if _, err := c.insert(chatInsert{conversation: conversation, from: "system", kind: protocol.MessageKindNotice, text: text, final: true, meta: &chatMeta{Code: "hop_limit"}}); err != nil {
			log.Printf("chat: hop limit notice: %v", err)
		}
	}
	for _, r := range written.recipients {
		c.kick(r)
	}
}

func (c *Service) deliveryTarget(r chatDeliveryRow) string {
	return c.targetOfRow(r.ConversationKind, r.ParentSeq, nil, nil, r.ChannelName)
}

func (c *Service) asInbox(r chatDeliveryRow) protocol.InboxMessage {
	return protocol.InboxMessage{Seq: r.Seq, Target: c.deliveryTarget(r), From: r.Sender, FromKind: chatSenderKind(r.SenderKind), Name: r.Name, Text: r.Body}
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
		var order []int64
		byConversation := map[int64][]chatDeliveryRow{}
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
				if err := s.seenOne(protocol.ManagerAgent, r.Seq, now); err != nil {
					return err
				}
			}
		}
		return nil
	}
	worker := c.workerOf(recipient)
	if worker == nil {
		return s.dropOpen(recipient, "left")
	}
	if protocol.IsBusy(*worker) {
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
	delivered := c.workers.Deliver(recipient, wakeInput(messages, others), protocol.RunTrigger{Kind: protocol.RunTriggerKindComment, Message: &waking[0].Seq})
	if delivered.Kind == "refused" {
		log.Printf("chat: %s not woken: %s", recipient, delivered.Reason)
		return nil
	}
	now := clock.NowMs()
	for _, r := range waking {
		if err := s.markHanded(recipient, r.Seq, delivered.Session, now); err != nil {
			return err
		}
	}
	return nil
}

func (c *Service) notify(recipient string) {
	if c.compacting[recipient] {
		return
	}
	worker := c.workerOf(recipient)
	if worker == nil {
		return
	}
	if !protocol.IsBusy(*worker) {
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
	delivered := c.workers.Deliver(recipient, busyNotice(c.groupRows(rows)), protocol.RunTrigger{Kind: protocol.RunTriggerKindComment, Message: &rows[0].Seq})
	if delivered.Kind == "refused" {
		return
	}
	now := clock.NowMs()
	for _, r := range rows {
		if err := s.markAnnounced(recipient, r.Seq, delivered.Session, now); err != nil {
			log.Printf("chat: notice for %s: %v", recipient, err)
			return
		}
	}
}

func (c *Service) inboxRows(who string) ([]chatUnreadRow, error) {
	s := c.store()
	channel := c.general
	if h := c.workerOf(who); h != nil {
		channel = c.channelOfWorker(*h)
	}
	rows, err := s.inboxOf(who, channel)
	if err != nil {
		return nil, err
	}
	out := []chatUnreadRow{}
	for _, r := range rows[:min(len(rows), protocol.SummaryConversations)] {
		u := chatUnreadRow{Target: c.targetOfRow(r.Kind, r.ParentSeq, nil, nil, r.ChannelName), Unread: r.Unread, MentionsYou: r.MentionsYou}
		if r.Latest != nil {
			if latest, err := s.message(*r.Latest); err == nil && latest != nil {
				u.Latest = latest.Name
			}
		}
		out = append(out, u)
	}
	return out, nil
}

func (c *Service) onActivity(a worker.SessionActivity) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	s := c.store()
	switch a.Kind {
	case "spoke":
		delete(c.failures, a.ID)
		seen, err := s.seenHanded(a.ID, a.Session, clock.NowMs())
		if err != nil {
			log.Printf("chat: %s spoke: %v", a.ID, err)
			return
		}
		for _, seq := range seen {
			if err := s.addSeenMark(a.ID, seq); err != nil {
				log.Printf("chat: %s spoke: %v", a.ID, err)
			}
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
					if thread := c.issueThreadOf(a.ID); thread != nil {
						where = *thread
					}
					name := a.ID
					if h := c.workerOf(a.ID); h != nil {
						name = h.Name
					}
					text := fmt.Sprintf("%s 连续 %d 次一叫醒就失败了，先不再叫它；你直接给它带句话会再试。", name, failed)
					if _, err := c.insert(chatInsert{conversation: where, from: "system", kind: protocol.MessageKindNotice, text: text, final: true, meta: &chatMeta{Code: "wake_breaker"}}); err != nil {
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
		if err := s.rollbackAnnounced(a.ID, a.Session); err != nil {
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
		c.workersLeft()
	case protocol.FactReport:
		c.mu.Lock()
		defer c.mu.Unlock()
		if !c.closed {
			c.postReport(f.ID, f.Outcome, f.Summary, f.Spent)
		}
	}
}

func (c *Service) workersLeft() {
	s := c.store()
	on := map[string]bool{}
	for _, h := range c.onFarm() {
		on[h.ID] = true
	}
	ps, err := s.participants()
	if err != nil {
		log.Printf("chat: workers left: %v", err)
		return
	}
	now := clock.NowMs()
	for _, p := range ps {
		if p.Kind != string(protocol.SenderKindWorker) || p.Left != nil || on[p.ID] {
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

func (c *Service) openJob(h protocol.Worker) {
	if err := c.openedJob(h); err != nil {
		log.Printf("chat: %s's job: %v", h.ID, err)
	}
}

func (c *Service) openedJob(h protocol.Worker) error {
	s := c.store()
	agent, runtime := h.Agent, h.Runtime
	if err := s.upsertParticipant(h.ID, string(protocol.SenderKindWorker), h.Name, &agent, &runtime, clock.NowMs()); err != nil {
		return err
	}
	if c.issueThreadOf(h.ID) != nil {
		return nil
	}
	channel := c.channelOfWorker(h)
	latest, err := s.latestSeq(channel)
	if err != nil {
		return err
	}
	if err := s.setReadCursor(h.ID, channel, latest, clock.NowMs()); err != nil {
		return err
	}
	var what string
	switch {
	case h.Playbook != nil && h.Playbook.Node != nil:
		what = fmt.Sprintf("做种植计划 %s 的「%s」", h.Playbook.ID, *h.Playbook.Node)
	case h.Playbook != nil:
		what = "拆种植计划 " + h.Playbook.ID
	default:
		what = str.Head(str.Spaces.ReplaceAllString(h.Task, " "), 80)
	}
	project := "项目"
	if h.Project != nil {
		project = *h.Project
	}
	text := fmt.Sprintf("派 @%s（%s）去 %s：%s", h.ID, h.Name, project, what)
	written, err := c.insert(chatInsert{conversation: channel, from: protocol.ManagerAgent, kind: protocol.MessageKindDispatch, text: text, final: true, meta: &chatMeta{Worker: h.ID}})
	if err != nil {
		return err
	}
	job, id := string(protocol.SubjectKindIssue), h.ID
	thread, err := s.createThread(written.seq, &job, &id, channel, clock.NowMs())
	if err != nil {
		return err
	}
	if err := s.follow(thread, h.ID, "owner", written.seq); err != nil {
		return err
	}
	c.publishConversation(thread)
	return nil
}

func (c *Service) postReport(id string, outcome protocol.Outcome, summary string, spent *protocol.Spent) {
	w := c.workerOf(id)
	if w == nil || outcome == protocol.OutcomeInterrupted {
		return
	}
	thread := c.issueThreadOf(id)
	if thread == nil {
		return
	}
	said := ""
	if outcome == protocol.OutcomeCompleted {
		if r := c.workers.Find(id); r != nil {
			said = worker.SummaryOf(r.LastText)
		}
	}
	text := said
	if text == "" {
		text = summary
	}
	o := outcome
	meta := &chatMeta{Outcome: &o, Spent: spent, ForPlaybook: w.Playbook != nil}
	if _, err := c.insert(chatInsert{conversation: *thread, from: id, kind: protocol.MessageKindReport, text: str.Head(text, chatReportMax), final: true, meta: meta}); err != nil {
		log.Printf("chat: %s's report: %v", id, err)
	}
}

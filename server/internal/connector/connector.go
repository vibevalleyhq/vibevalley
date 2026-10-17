package connector

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/big"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/channel"
	"vibevalley/internal/core"
	"vibevalley/internal/manager"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/feishu"
	"vibevalley/pkg/qq"
	"vibevalley/pkg/weixin"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/ptr"
)

// Some apps let a bot answer only on the context of the owner's latest message, and only so many times on it: what an app will not take waits in
// connector_outbox and goes out when the owner next says something, several as one digest. The bots' secrets never leave the database.

// WeChat's official client rests this long too.
const voiceStalePause = time.Hour

// Held messages are tried again after voiceRetryFirst, then twice as long after each try that fails, up to
// voiceRetryMost; one going out starts over. The owner's next message sends them at once anyway. Variables: tests
// shorten them.
var (
	voiceRetryFirst = 30 * time.Second
	voiceRetryMost  = 30 * time.Minute
)

func voiceRetryAfter(wait time.Duration, clear bool) time.Duration {
	if clear {
		return voiceRetryFirst
	}
	return min(2*wait, voiceRetryMost)
}

type voiceInbound struct {
	// Each is taken once.
	ID   string
	From string
	Text string
	// WeChat's context token, QQ's message id.
	Reply  string
	Quoted string
}

type voiceFailure struct {
	Kind   string // restricted, stale, failed
	Reason string
}

func (f *voiceFailure) Error() string { return f.Reason }

type voiceLinked struct {
	Secrets map[string]string
	Owner   string
}

type voiceProgress struct {
	State protocol.ConnectorState
	Qr    string
}

type voiceReceiving struct {
	Cursor     string
	SaveCursor func(cursor string)
	Got        func(m voiceInbound)
}

type voiceAdapter interface {
	ID() protocol.ConnectorID
	Login(ctx context.Context, in protocol.ConnectorLogin, progress func(voiceProgress), verifyCode func() string) (voiceLinked, error)
	Receive(ctx context.Context, secrets map[string]string, io voiceReceiving) *voiceFailure
	Send(ctx context.Context, secrets map[string]string, to, text, reply string) (string, *voiceFailure)
}

type voiceAccount struct {
	secrets      map[string]string
	owner        string
	pairCode     string
	cursor       string
	replyContext string
	lastInbound  int64
	pausedUntil  int64
	connectedAt  int64
	channel      *string
}

func (a *voiceAccount) paused() bool { return a.pausedUntil != 0 && a.pausedUntil > clock.NowMs() }

type Service struct {
	q    *generated.Queries
	core *core.Service

	ilink  weixin.API
	feishu feishu.API
	qq     qq.API

	say           func(ctx context.Context, text string, conversation *string) error
	channelByName func(name string) *channel.Info
	general       func() string

	bridges map[protocol.ConnectorID]*voiceBridge
	order   []protocol.ConnectorID
	stop    func()
	done    chan struct{}
}

func newService(db *sql.DB, core *core.Service, chat *channel.Service, mgr *manager.Service) (*Service, error) {
	c := &Service{
		q:      generated.New(db),
		core:   core,
		ilink:  weixin.NewClient(),
		feishu: feishu.NewClient(),
		qq:     qq.NewClient(),
		say: func(ctx context.Context, text string, conversation *string) error {
			return mgr.Say(ctx, text, "", conversation)
		},
		channelByName: chat.ChannelByName,
		general:       chat.General,
		bridges:       map[protocol.ConnectorID]*voiceBridge{},
		order:         []protocol.ConnectorID{protocol.ConnectorIDWeixin, protocol.ConnectorIDFeishu, protocol.ConnectorIDQq},
	}
	adapters := []voiceAdapter{voiceWeixinAdapter{c}, voiceFeishuAdapter{c}, voiceQQAdapter{c}}
	for _, a := range adapters {
		b := &voiceBridge{c: c, adapter: a, id: a.ID(), fibers: map[string]context.CancelFunc{}, ctx: context.Background(), progressed: make(chan struct{}, 1)}
		if err := b.reload(); err != nil {
			return nil, err
		}
		c.bridges[a.ID()] = b
	}
	return c, nil
}

func (c *Service) OnStart(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	snapshot, events, stop := c.core.Events()
	c.stop = func() { cancel(); stop() }
	c.done = make(chan struct{})
	for _, id := range c.order {
		b := c.bridges[id]
		b.mu.Lock()
		b.ctx = ctx
		b.mu.Unlock()
	}
	// The snapshot is what was before: not news.
	state := snapshot.Value.(protocol.SideEventSnapshot).State
	go func() {
		defer close(c.done)
		for {
			select {
			case <-ctx.Done():
				return
			case e, open := <-events:
				if !open {
					return
				}
				switch v := e.Value.(type) {
				case protocol.FactMessage:
					for _, id := range c.order {
						c.bridges[id].offer(v.Message, &state)
					}
					state = c.core.State()
				case protocol.FactConversation:
					state = c.core.State()
				}
			}
		}
	}()
	return nil
}

func (c *Service) OnReady(context.Context) {
	for _, id := range c.order {
		if b := c.bridges[id]; b.accountNow() != nil {
			b.connect()
		}
	}
}

func (c *Service) OnStop() {
	if c.stop == nil {
		return
	}
	c.stop()
	<-c.done
	for _, b := range c.bridges {
		b.stopAll()
	}
}

func (c *Service) List() []protocol.ConnectorStatus {
	out := make([]protocol.ConnectorStatus, 0, len(c.order))
	for _, id := range c.order {
		out = append(out, c.bridges[id].status())
	}
	return out
}

func (c *Service) bridge(id protocol.ConnectorID) *voiceBridge {
	if b := c.bridges[id]; b != nil {
		return b
	}
	return nil
}

func (c *Service) Login(id protocol.ConnectorID, in protocol.ConnectorLogin) protocol.ConnectorStatus {
	if b := c.bridge(id); b != nil {
		return b.login(in)
	}
	return protocol.ConnectorStatus{ID: id, State: protocol.ConnectorStateOff}
}

func (c *Service) Verify(id protocol.ConnectorID, code string) protocol.ConnectorStatus {
	if b := c.bridge(id); b != nil {
		return b.verify(code)
	}
	return protocol.ConnectorStatus{ID: id, State: protocol.ConnectorStateOff}
}

func (c *Service) Logout(id protocol.ConnectorID) protocol.ConnectorStatus {
	if b := c.bridge(id); b != nil {
		return b.logout()
	}
	return protocol.ConnectorStatus{ID: id, State: protocol.ConnectorStateOff}
}

func (c *Service) SetChannel(id protocol.ConnectorID, name string) (protocol.ConnectorStatus, error) {
	b := c.bridge(id)
	if b == nil {
		return protocol.ConnectorStatus{}, fmt.Errorf("没有 %s 这个连接", id)
	}
	channel := c.channelByName(name)
	if channel == nil {
		return protocol.ConnectorStatus{}, fmt.Errorf("没有叫 %s 的频道", name)
	}
	var to *string
	if channel.ID != c.general() {
		to = &channel.ID
	}
	return b.setChannel(to)
}

type voiceBridge struct {
	c       *Service
	adapter voiceAdapter
	id      protocol.ConnectorID

	mu         sync.Mutex
	ctx        context.Context
	account    *voiceAccount
	progress   *voiceProgress
	verifyCode string
	// A login stopped by a newer one leaves the newer one's progress alone.
	attempt    int
	progressed chan struct{}
	err        string
	fibers     map[string]context.CancelFunc

	// The outbox goes out in order.
	sending sync.Mutex
}

func voiceNullable(s string) sql.NullString { return sql.NullString{String: s, Valid: s != ""} }

func (b *voiceBridge) reload() error {
	row, err := b.c.q.ConnectorAccount(context.Background(), string(b.id))
	b.mu.Lock()
	defer b.mu.Unlock()
	if errors.Is(err, sql.ErrNoRows) {
		b.account = nil
		return nil
	}
	if err != nil {
		return err
	}
	a := &voiceAccount{secrets: map[string]string{}, owner: row.OwnerID.String, pairCode: row.PairCode.String, cursor: row.Cursor,
		replyContext: row.ReplyContext.String, lastInbound: row.LastInbound.Int64, pausedUntil: row.PausedUntil.Int64, connectedAt: row.ConnectedAt}
	if row.ChannelID.Valid {
		a.channel = &row.ChannelID.String
	}
	if err := json.Unmarshal([]byte(row.Secrets), &a.secrets); err != nil {
		b.err = "存着的登录信息读不出来，断开重新连一次"
		log.Printf("vibevalley: %s: the saved secrets cannot be read: %v", b.id, err)
	}
	b.account = a
	return nil
}

// A write the bridge goes on without.
func (b *voiceBridge) kept(err error) {
	if err != nil {
		log.Printf("vibevalley: %s: %v", b.id, err)
	}
}

func (b *voiceBridge) mustReload() {
	if err := b.reload(); err != nil {
		log.Printf("vibevalley: %s: %v", b.id, err)
	}
}

func (b *voiceBridge) accountNow() *voiceAccount {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.account == nil {
		return nil
	}
	a := *b.account
	return &a
}

func (b *voiceBridge) setErr(reason string) {
	b.mu.Lock()
	b.err = reason
	b.mu.Unlock()
}

func (b *voiceBridge) status() protocol.ConnectorStatus {
	pending, _ := b.c.q.CountPendingOutbox(context.Background(), string(b.id))
	chat := b.c.core.State().Chat
	b.mu.Lock()
	defer b.mu.Unlock()
	s := protocol.ConnectorStatus{ID: b.id, Pending: pending}
	if b.err != "" {
		s.Error = ptr.To(b.err)
	}
	a := b.account
	if a != nil {
		var where *protocol.Conversation
		if a.channel != nil {
			where = protocol.ConversationOf(chat, *a.channel)
		} else {
			where = protocol.GeneralOf(chat)
		}
		if where != nil && where.Name != nil && *where.Name != "" {
			s.Channel = ptr.To(*where.Name)
		}
	}
	if p := b.progress; p != nil {
		s.State = p.State
		if p.Qr != "" {
			s.Qr = ptr.To(p.Qr)
		}
		return s
	}
	if a == nil {
		s.State = protocol.ConnectorStateOff
		return s
	}
	if a.owner == "" {
		s.State = protocol.ConnectorStatePairing
		if a.pairCode != "" {
			s.PairCode = ptr.To(a.pairCode)
		}
		s.Since = ptr.To(a.connectedAt)
		return s
	}
	s.State = protocol.ConnectorStateConnected
	if a.paused() {
		s.State = protocol.ConnectorStatePaused
		s.PausedUntil = ptr.To(a.pausedUntil)
	}
	s.Owner = ptr.To(shortID(a.owner))
	s.Since = ptr.To(a.connectedAt)
	if a.lastInbound != 0 {
		s.LastInbound = ptr.To(a.lastInbound)
	}
	return s
}

func (b *voiceBridge) pause() {
	b.kept(b.c.q.PauseAccount(context.Background(), generated.PauseAccountParams{
		PausedUntil: sql.NullInt64{Int64: clock.NowMs() + voiceStalePause.Milliseconds(), Valid: true}, Connector: string(b.id)}))
	b.mustReload()
	b.setErr("登录过期了，一小时后再试；也可以断开重新连。")
}

// Stops at the first the app will not take. late: it waited, so many go as one digest.
func (b *voiceBridge) drain(ctx context.Context, late bool) bool {
	b.sending.Lock()
	defer b.sending.Unlock()
	a := b.accountNow()
	if a == nil || a.owner == "" || a.paused() {
		return true
	}
	pending, err := b.c.q.PendingOutbox(ctx, string(b.id))
	if err != nil {
		log.Printf("vibevalley: %s: %v", b.id, err)
		return false
	}
	if len(pending) == 0 {
		return true
	}
	type batch struct {
		ids  []string
		text string
	}
	var batches []batch
	if late && len(pending) > digestOver {
		lines := make([]string, len(pending))
		ids := make([]string, len(pending))
		for i, r := range pending {
			lines[i], ids[i] = r.Body, r.ID
		}
		batches = []batch{{ids, flushText(lines)[0]}}
	} else {
		for _, r := range pending {
			batches = append(batches, batch{[]string{r.ID}, r.Body})
		}
	}
	for _, out := range batches {
		ext, failure := b.adapter.Send(ctx, a.secrets, a.owner, out.text, a.replyContext)
		if failure == nil {
			for _, id := range out.ids {
				b.kept(b.c.q.OutboxSent(ctx, generated.OutboxSentParams{SentAt: sql.NullInt64{Int64: clock.NowMs(), Valid: true}, ExtID: voiceNullable(ext), ID: id}))
			}
			b.setErr("")
			continue
		}
		for _, id := range out.ids {
			b.kept(b.c.q.OutboxFailed(ctx, generated.OutboxFailedParams{Error: voiceNullable(failure.Reason), ID: id}))
		}
		switch failure.Kind {
		case "stale":
			b.pause()
		case "restricted":
			// The app would not take it now (WeChat's, QQ's reply window): tried again later, and with the owner's
			// next message.
			b.setErr("")
		default:
			b.setErr(failure.Reason)
		}
		return false
	}
	return true
}

func (b *voiceBridge) offer(m protocol.ChatMessage, state *protocol.CoreState) {
	a := b.accountNow()
	if a == nil || a.owner == "" || !forOwner(m) {
		return
	}
	var chat *protocol.Chat
	if state != nil {
		chat = state.Chat
	}
	where := protocol.ConversationOf(chat, m.Conversation)
	var mine *string
	if a.channel != nil {
		mine = a.channel
	} else if general := protocol.GeneralOf(chat); general != nil {
		mine = &general.ID
	}
	channel := protocol.ChannelOf(chat, where)
	if (channel == nil) != (mine == nil) || (channel != nil && channel.ID != *mine) {
		return
	}
	for _, piece := range splitText(ownerLine(m, where), maxChars[b.id]) {
		b.kept(b.c.q.AddOutbox(context.Background(), generated.AddOutboxParams{ID: base.NewID(), Connector: string(b.id), MessageID: m.ID, Body: piece, CreatedAt: clock.NowMs()}))
	}
	b.mu.Lock()
	ctx := b.ctx
	b.mu.Unlock()
	b.drain(ctx, false)
}

func (b *voiceBridge) quotedConversation(ext string) *string {
	if ext == "" {
		return nil
	}
	seq, err := b.c.q.MessageOfExt(context.Background(), generated.MessageOfExtParams{Connector: string(b.id), ExtID: voiceNullable(ext)})
	if err != nil {
		return nil
	}
	if chat := b.c.core.State().Chat; chat != nil {
		for _, m := range chat.Messages {
			if m.ID == seq {
				return &m.Conversation
			}
		}
	}
	return nil
}

func (b *voiceBridge) saveReplyContext(reply string) {
	now := clock.NowMs()
	b.kept(b.c.q.AccountReply(context.Background(), generated.AccountReplyParams{
		ReplyContext: voiceNullable(reply), ReplyAt: sql.NullInt64{Int64: now, Valid: true}, LastInbound: sql.NullInt64{Int64: now, Valid: true}, Connector: string(b.id)}))
}

func (b *voiceBridge) got(ctx context.Context, m voiceInbound) {
	a := b.accountNow()
	if a == nil {
		return
	}
	if m.ID != "" {
		if _, err := b.c.q.InboundSeen(ctx, generated.InboundSeenParams{Connector: string(b.id), ExtID: m.ID}); err == nil {
			return
		}
		b.kept(b.c.q.AddInbound(ctx, generated.AddInboundParams{Connector: string(b.id), ExtID: m.ID, CreatedAt: clock.NowMs()}))
	}
	// Nobody paired yet: the first who sends the code becomes the owner; anyone else is not heard.
	if a.owner == "" {
		if a.pairCode == "" || !isPairing(m.Text, a.pairCode) {
			log.Printf("vibevalley: %s: a message before pairing was not let in", b.id)
			return
		}
		b.kept(b.c.q.AccountOwner(context.Background(), generated.AccountOwnerParams{OwnerID: voiceNullable(m.From), Connector: string(b.id)}))
		b.saveReplyContext(m.Reply)
		b.mustReload()
		b.adapter.Send(ctx, a.secrets, m.From, "配对好了：以后在这里说的话，就是你在农场的田头上说的。", m.Reply)
		return
	}
	if m.From != a.owner {
		log.Printf("vibevalley: %s: a message from someone else was not let in", b.id)
		return
	}
	b.saveReplyContext(m.Reply)
	b.mustReload()
	// A fresh context: what waited goes out first, so the answer to this comes after it.
	b.drain(ctx, true)
	if m.Text == "" {
		return
	}
	conversation := b.quotedConversation(m.Quoted)
	if conversation == nil {
		if now := b.accountNow(); now != nil {
			conversation = now.channel
		}
	}
	if b.c.core.Call() != protocol.CallStateLive {
		b.c.core.SetCall(protocol.CallStateLive, "")
	}
	if err := b.c.say(ctx, m.Text, conversation); err != nil {
		log.Printf("vibevalley: what came from %s was not said: %v", b.id, err)
	}
}

func (b *voiceBridge) receiving(ctx context.Context) {
	failures := 0
	for ctx.Err() == nil {
		a := b.accountNow()
		if a == nil {
			return
		}
		if a.paused() {
			if !clock.Sleep(ctx, time.Duration(a.pausedUntil-clock.NowMs())*time.Millisecond) {
				return
			}
			b.kept(b.c.q.PauseAccount(ctx, generated.PauseAccountParams{Connector: string(b.id)}))
			b.mustReload()
			continue
		}
		io := voiceReceiving{
			Cursor: a.cursor,
			SaveCursor: func(cursor string) {
				b.kept(b.c.q.AccountCursor(ctx, generated.AccountCursorParams{Cursor: cursor, Connector: string(b.id)}))
				b.mustReload()
			},
			Got: func(m voiceInbound) { b.got(ctx, m) },
		}
		stopped := b.adapter.Receive(ctx, a.secrets, io)
		if ctx.Err() != nil {
			return
		}
		if stopped == nil {
			stopped = &voiceFailure{Kind: "failed", Reason: "收消息停了"}
		}
		if stopped.Kind == "stale" {
			b.pause()
			continue
		}
		b.setErr(stopped.Reason)
		failures++
		wait := 2 * time.Second
		if failures >= 3 {
			wait, failures = 30*time.Second, 0
		}
		if !clock.Sleep(ctx, wait) {
			return
		}
	}
}

func (b *voiceBridge) run(name string, work func(ctx context.Context)) {
	b.mu.Lock()
	if stop := b.fibers[name]; stop != nil {
		stop()
	}
	ctx, cancel := context.WithCancel(b.ctx)
	b.fibers[name] = cancel
	b.mu.Unlock()
	go func() {
		defer cancel()
		work(ctx)
	}()
}

func (b *voiceBridge) remove(name string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if stop := b.fibers[name]; stop != nil {
		stop()
		delete(b.fibers, name)
	}
}

func (b *voiceBridge) stopAll() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for name, stop := range b.fibers {
		stop()
		delete(b.fibers, name)
	}
}

func (b *voiceBridge) connect() {
	b.run("receive", b.receiving)
	b.run("retry", func(ctx context.Context) {
		wait := voiceRetryFirst
		for clock.Sleep(ctx, wait) {
			wait = voiceRetryAfter(wait, b.drain(ctx, false))
		}
	})
}

func voicePairCode() string {
	n, err := rand.Int(rand.Reader, big.NewInt(900_000))
	if err != nil {
		return "100000"
	}
	return fmt.Sprint(100_000 + n.Int64())
}

func (b *voiceBridge) loggingIn(ctx context.Context, attempt int, in protocol.ConnectorLogin) {
	defer func() {
		b.mu.Lock()
		if b.attempt == attempt {
			b.progress, b.verifyCode = nil, ""
		}
		b.mu.Unlock()
		b.signal()
	}()
	progress := func(p voiceProgress) {
		b.mu.Lock()
		if b.attempt == attempt {
			b.progress = &p
		}
		b.mu.Unlock()
		b.signal()
	}
	verifyCode := func() string {
		b.mu.Lock()
		defer b.mu.Unlock()
		return b.verifyCode
	}
	linked, err := b.adapter.Login(ctx, in, progress, verifyCode)
	if ctx.Err() != nil {
		return
	}
	if err != nil {
		b.setErr(err.Error())
		return
	}
	b.remove("receive")
	b.kept(b.c.q.DropPendingOutbox(context.Background(), generated.DropPendingOutboxParams{Error: voiceNullable("换了账号"), Connector: string(b.id)}))
	secrets, _ := json.Marshal(linked.Secrets)
	pair := ""
	if linked.Owner == "" {
		pair = voicePairCode()
	}
	b.kept(b.c.q.ConnectAccount(context.Background(), generated.ConnectAccountParams{
		Connector: string(b.id), Secrets: string(secrets), OwnerID: voiceNullable(linked.Owner), PairCode: voiceNullable(pair), ConnectedAt: clock.NowMs()}))
	b.mustReload()
	b.setErr("")
	b.connect()
}

func (b *voiceBridge) login(in protocol.ConnectorLogin) protocol.ConnectorStatus {
	b.mu.Lock()
	busy := b.progress != nil
	b.mu.Unlock()
	if busy && (in.Force == nil || !*in.Force) {
		return b.status()
	}
	b.remove("login")
	b.mu.Lock()
	b.err = ""
	b.attempt++
	attempt := b.attempt
	b.progress = &voiceProgress{State: protocol.ConnectorStateWaiting}
	b.mu.Unlock()
	b.run("login", func(ctx context.Context) { b.loggingIn(ctx, attempt, in) })
	wait := time.NewTimer(1500 * time.Millisecond)
	defer wait.Stop()
	for {
		b.mu.Lock()
		shown := b.attempt != attempt || b.progress == nil || b.progress.Qr != ""
		b.mu.Unlock()
		if shown {
			break
		}
		select {
		case <-b.progressed:
		case <-wait.C:
			return b.status()
		}
	}
	return b.status()
}

func (b *voiceBridge) signal() {
	select {
	case b.progressed <- struct{}{}:
	default:
	}
}

func (b *voiceBridge) verify(code string) protocol.ConnectorStatus {
	b.mu.Lock()
	b.verifyCode = strings.TrimSpace(code)
	if b.progress != nil && b.progress.State == protocol.ConnectorStateVerify {
		b.progress = &voiceProgress{State: protocol.ConnectorStateScanned, Qr: b.progress.Qr}
	}
	b.mu.Unlock()
	return b.status()
}

func (b *voiceBridge) logout() protocol.ConnectorStatus {
	b.stopAll()
	b.kept(b.c.q.DisconnectAccount(context.Background(), string(b.id)))
	b.kept(b.c.q.DropPendingOutbox(context.Background(), generated.DropPendingOutboxParams{Error: voiceNullable("断开了"), Connector: string(b.id)}))
	b.mu.Lock()
	b.account, b.progress, b.err = nil, nil, ""
	b.attempt++
	b.mu.Unlock()
	return b.status()
}

func (b *voiceBridge) setChannel(channel *string) (protocol.ConnectorStatus, error) {
	to := sql.NullString{}
	if channel != nil {
		to = sql.NullString{String: *channel, Valid: true}
	}
	if err := b.c.q.AccountChannel(context.Background(), generated.AccountChannelParams{ChannelID: to, Connector: string(b.id)}); err != nil {
		return protocol.ConnectorStatus{}, err
	}
	b.mustReload()
	return b.status(), nil
}

package channels

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
	"vibevalley/internal/chat"
	"vibevalley/internal/manager"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/feishu"
	"vibevalley/pkg/qq"
	"vibevalley/pkg/weixin"
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
	channel      *int64
}

func (a *voiceAccount) paused() bool { return a.pausedUntil != 0 && a.pausedUntil > base.NowMs() }

type Connectors struct {
	db   *sql.DB
	site *base.Site

	ilink  weixin.API
	feishu feishu.API
	qq     qq.API

	say           func(ctx context.Context, text string, conversation *int64) error
	channelByName func(name string) *base.ChannelInfo
	square        func() int64

	bridges map[protocol.ConnectorID]*voiceBridge
	order   []protocol.ConnectorID
	stop    func()
	done    chan struct{}
}

func newConnectors(db *sql.DB, site *base.Site, chat *chat.Chat, foreman *manager.Foreman) (*Connectors, error) {
	c := &Connectors{
		db:     db,
		site:   site,
		ilink:  weixin.NewClient(),
		feishu: feishu.NewClient(),
		qq:     qq.NewClient(),
		say: func(ctx context.Context, text string, conversation *int64) error {
			return foreman.Say(ctx, text, "", conversation)
		},
		channelByName: chat.ChannelByName,
		square:        chat.Square,
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

func (c *Connectors) OnStart(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	snapshot, events, stop := c.site.Events()
	c.stop = func() { cancel(); stop() }
	c.done = make(chan struct{})
	for _, id := range c.order {
		b := c.bridges[id]
		b.mu.Lock()
		b.ctx = ctx
		b.mu.Unlock()
	}
	// The snapshot is what was before: not news.
	state := snapshot.Value.(protocol.SiteEventSnapshot).State
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
					state = c.site.State()
				case protocol.FactConversation:
					state = c.site.State()
				}
			}
		}
	}()
	return nil
}

func (c *Connectors) OnReady(context.Context) {
	for _, id := range c.order {
		if b := c.bridges[id]; b.accountNow() != nil {
			b.connect()
		}
	}
}

func (c *Connectors) OnStop() {
	if c.stop == nil {
		return
	}
	c.stop()
	<-c.done
	for _, b := range c.bridges {
		b.stopAll()
	}
}

func (c *Connectors) List() []protocol.ConnectorStatus {
	out := make([]protocol.ConnectorStatus, 0, len(c.order))
	for _, id := range c.order {
		out = append(out, c.bridges[id].status())
	}
	return out
}

func (c *Connectors) bridge(id protocol.ConnectorID) *voiceBridge {
	if b := c.bridges[id]; b != nil {
		return b
	}
	return nil
}

func (c *Connectors) Login(id protocol.ConnectorID, in protocol.ConnectorLogin) protocol.ConnectorStatus {
	if b := c.bridge(id); b != nil {
		return b.login(in)
	}
	return protocol.ConnectorStatus{ID: id, State: protocol.ConnectorStateOff}
}

func (c *Connectors) Verify(id protocol.ConnectorID, code string) protocol.ConnectorStatus {
	if b := c.bridge(id); b != nil {
		return b.verify(code)
	}
	return protocol.ConnectorStatus{ID: id, State: protocol.ConnectorStateOff}
}

func (c *Connectors) Logout(id protocol.ConnectorID) protocol.ConnectorStatus {
	if b := c.bridge(id); b != nil {
		return b.logout()
	}
	return protocol.ConnectorStatus{ID: id, State: protocol.ConnectorStateOff}
}

func (c *Connectors) SetChannel(id protocol.ConnectorID, name string) (protocol.ConnectorStatus, error) {
	b := c.bridge(id)
	if b == nil {
		return protocol.ConnectorStatus{}, fmt.Errorf("没有 %s 这个连接", id)
	}
	channel := c.channelByName(name)
	if channel == nil {
		return protocol.ConnectorStatus{}, fmt.Errorf("没有叫 %s 的频道", name)
	}
	var to *int64
	if channel.ID != c.square() {
		to = &channel.ID
	}
	return b.setChannel(to)
}

type voiceBridge struct {
	c       *Connectors
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

func voiceNullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (b *voiceBridge) reload() error {
	var (
		secrets                           string
		owner, pair, reply                sql.NullString
		cursor                            string
		lastInbound, pausedUntil, channel sql.NullInt64
		connectedAt                       int64
	)
	err := b.c.db.QueryRow(`select secrets, owner_id, pair_code, cursor, reply_context, last_inbound, paused_until, connected_at, channel_id
		from connector_accounts where connector = ?`, string(b.id)).
		Scan(&secrets, &owner, &pair, &cursor, &reply, &lastInbound, &pausedUntil, &connectedAt, &channel)
	b.mu.Lock()
	defer b.mu.Unlock()
	if errors.Is(err, sql.ErrNoRows) {
		b.account = nil
		return nil
	}
	if err != nil {
		return err
	}
	a := &voiceAccount{secrets: map[string]string{}, owner: owner.String, pairCode: pair.String, cursor: cursor, replyContext: reply.String,
		lastInbound: lastInbound.Int64, pausedUntil: pausedUntil.Int64, connectedAt: connectedAt}
	if channel.Valid {
		a.channel = &channel.Int64
	}
	_ = json.Unmarshal([]byte(secrets), &a.secrets)
	b.account = a
	return nil
}

func (b *voiceBridge) exec(query string, args ...any) {
	if _, err := b.c.db.Exec(query, args...); err != nil {
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

func voicePtr[T any](v T) *T { return &v }

func (b *voiceBridge) status() protocol.ConnectorStatus {
	var pending int64
	_ = b.c.db.QueryRow(`select count(*) from connector_outbox where connector = ? and state = 'pending'`, string(b.id)).Scan(&pending)
	chat := b.c.site.State().Chat
	b.mu.Lock()
	defer b.mu.Unlock()
	s := protocol.ConnectorStatus{ID: b.id, Pending: pending}
	if b.err != "" {
		s.Error = voicePtr(b.err)
	}
	a := b.account
	if a != nil {
		var where *protocol.Conversation
		if a.channel != nil {
			where = protocol.ConversationOf(chat, *a.channel)
		} else {
			where = protocol.SquareOf(chat)
		}
		if where != nil && where.Name != nil && *where.Name != "" {
			s.Channel = voicePtr(*where.Name)
		}
	}
	if p := b.progress; p != nil {
		s.State = p.State
		if p.Qr != "" {
			s.Qr = voicePtr(p.Qr)
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
			s.PairCode = voicePtr(a.pairCode)
		}
		s.Since = voicePtr(a.connectedAt)
		return s
	}
	s.State = protocol.ConnectorStateConnected
	if a.paused() {
		s.State = protocol.ConnectorStatePaused
		s.PausedUntil = voicePtr(a.pausedUntil)
	}
	s.Owner = voicePtr(protocol.ShortID(a.owner))
	s.Since = voicePtr(a.connectedAt)
	if a.lastInbound != 0 {
		s.LastInbound = voicePtr(a.lastInbound)
	}
	return s
}

func (b *voiceBridge) pause() {
	b.exec(`update connector_accounts set paused_until = ? where connector = ?`, base.NowMs()+voiceStalePause.Milliseconds(), string(b.id))
	b.mustReload()
	b.setErr("登录过期了，一小时后再试；也可以断开重新连。")
}

type voiceOutRow struct {
	id   int64
	body string
}

// Stops at the first the app will not take. late: it waited, so many go as one digest.
func (b *voiceBridge) drain(ctx context.Context, late bool) bool {
	b.sending.Lock()
	defer b.sending.Unlock()
	a := b.accountNow()
	if a == nil || a.owner == "" || a.paused() {
		return true
	}
	rows, err := b.c.db.Query(`select id, body from connector_outbox where connector = ? and state = 'pending' order by id`, string(b.id))
	if err != nil {
		log.Printf("vibevalley: %s: %v", b.id, err)
		return false
	}
	var pending []voiceOutRow
	for rows.Next() {
		var r voiceOutRow
		if rows.Scan(&r.id, &r.body) == nil {
			pending = append(pending, r)
		}
	}
	rows.Close()
	if len(pending) == 0 {
		return true
	}
	type batch struct {
		ids  []int64
		text string
	}
	var batches []batch
	if late && len(pending) > protocol.DigestOver {
		lines := make([]string, len(pending))
		ids := make([]int64, len(pending))
		for i, r := range pending {
			lines[i], ids[i] = r.body, r.id
		}
		batches = []batch{{ids, protocol.FlushText(lines)[0]}}
	} else {
		for _, r := range pending {
			batches = append(batches, batch{[]int64{r.id}, r.body})
		}
	}
	for _, out := range batches {
		ext, failure := b.adapter.Send(ctx, a.secrets, a.owner, out.text, a.replyContext)
		if failure == nil {
			for _, id := range out.ids {
				b.exec(`update connector_outbox set state = 'sent', sent_at = ?, ext_id = ?, tries = tries + 1, error = null where id = ?`,
					base.NowMs(), voiceNullable(ext), id)
			}
			b.setErr("")
			continue
		}
		for _, id := range out.ids {
			b.exec(`update connector_outbox set tries = tries + 1, error = ? where id = ?`, failure.Reason, id)
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

func (b *voiceBridge) offer(m protocol.ChatMessage, state *protocol.FarmState) {
	a := b.accountNow()
	if a == nil || a.owner == "" || !protocol.ForOwner(m) {
		return
	}
	var chat *protocol.Chat
	if state != nil {
		chat = state.Chat
	}
	where := protocol.ConversationOf(chat, m.Conversation)
	var mine *int64
	if a.channel != nil {
		mine = a.channel
	} else if square := protocol.SquareOf(chat); square != nil {
		mine = &square.ID
	}
	channel := protocol.ChannelOf(chat, where)
	if (channel == nil) != (mine == nil) || (channel != nil && channel.ID != *mine) {
		return
	}
	for _, piece := range protocol.SplitText(protocol.OwnerLine(m, where), protocol.ConnectorMaxChars[b.id]) {
		b.exec(`insert into connector_outbox (connector, message_seq, body, created_at) values (?, ?, ?, ?)`, string(b.id), m.Seq, piece, base.NowMs())
	}
	b.mu.Lock()
	ctx := b.ctx
	b.mu.Unlock()
	b.drain(ctx, false)
}

func (b *voiceBridge) quotedConversation(ext string) *int64 {
	if ext == "" {
		return nil
	}
	var seq sql.NullInt64
	err := b.c.db.QueryRow(`select message_seq from connector_outbox where connector = ? and ext_id = ?
		union all
		select message_seq from connector_inbound where connector = ? and ext_id = ? and message_seq is not null
		limit 1`, string(b.id), ext, string(b.id), ext).Scan(&seq)
	if err != nil || !seq.Valid {
		return nil
	}
	if chat := b.c.site.State().Chat; chat != nil {
		for _, m := range chat.Messages {
			if m.Seq == seq.Int64 {
				return &m.Conversation
			}
		}
	}
	return nil
}

func (b *voiceBridge) saveReplyContext(reply string) {
	now := base.NowMs()
	b.exec(`update connector_accounts set reply_context = ?, reply_at = ?, last_inbound = ? where connector = ?`, voiceNullable(reply), now, now, string(b.id))
}

func (b *voiceBridge) got(ctx context.Context, m voiceInbound) {
	a := b.accountNow()
	if a == nil {
		return
	}
	if m.ID != "" {
		var seen string
		if b.c.db.QueryRow(`select ext_id from connector_inbound where connector = ? and ext_id = ?`, string(b.id), m.ID).Scan(&seen) == nil {
			return
		}
		b.exec(`insert into connector_inbound (connector, ext_id, message_seq, created_at) values (?, ?, null, ?) on conflict (connector, ext_id) do nothing`,
			string(b.id), m.ID, base.NowMs())
	}
	// Nobody paired yet: the first who sends the code becomes the owner; anyone else is not heard.
	if a.owner == "" {
		if a.pairCode == "" || !protocol.IsPairing(m.Text, a.pairCode) {
			log.Printf("vibevalley: %s: a message before pairing was not let in", b.id)
			return
		}
		b.exec(`update connector_accounts set owner_id = ?, pair_code = null where connector = ?`, m.From, string(b.id))
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
	if b.c.site.Call() != protocol.CallStateLive {
		b.c.site.SetCall(protocol.CallStateLive, "")
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
			if !base.Sleep(ctx, time.Duration(a.pausedUntil-base.NowMs())*time.Millisecond) {
				return
			}
			b.exec(`update connector_accounts set paused_until = null where connector = ?`, string(b.id))
			b.mustReload()
			continue
		}
		io := voiceReceiving{
			Cursor: a.cursor,
			SaveCursor: func(cursor string) {
				b.exec(`update connector_accounts set cursor = ? where connector = ?`, cursor, string(b.id))
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
		if !base.Sleep(ctx, wait) {
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
		for base.Sleep(ctx, wait) {
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
	b.exec(`update connector_outbox set state = 'dropped', error = ? where connector = ? and state = 'pending'`, "换了账号", string(b.id))
	secrets, _ := json.Marshal(linked.Secrets)
	pair := ""
	if linked.Owner == "" {
		pair = voicePairCode()
	}
	b.exec(`insert into connector_accounts (connector, secrets, owner_id, pair_code, connected_at) values (?, ?, ?, ?, ?)
		on conflict (connector) do update set secrets = excluded.secrets, owner_id = excluded.owner_id, pair_code = excluded.pair_code,
		cursor = '', reply_context = null, reply_at = null, last_inbound = null, paused_until = null, connected_at = excluded.connected_at`,
		string(b.id), string(secrets), voiceNullable(linked.Owner), voiceNullable(pair), base.NowMs())
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
	b.exec(`delete from connector_accounts where connector = ?`, string(b.id))
	b.exec(`update connector_outbox set state = 'dropped', error = ? where connector = ? and state = 'pending'`, "断开了", string(b.id))
	b.mu.Lock()
	b.account, b.progress, b.err = nil, nil, ""
	b.attempt++
	b.mu.Unlock()
	return b.status()
}

func (b *voiceBridge) setChannel(channel *int64) (protocol.ConnectorStatus, error) {
	var to any
	if channel != nil {
		to = *channel
	}
	if _, err := b.c.db.Exec(`update connector_accounts set channel_id = ? where connector = ?`, to, string(b.id)); err != nil {
		return protocol.ConnectorStatus{}, err
	}
	b.mustReload()
	return b.status(), nil
}

package connector

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
)

type connectionCommand uint8

const (
	connectionResume connectionCommand = iota
	connectionLogin
	connectionLogout
	connectionOffer
)

type connectionRequest struct {
	kind    connectionCommand
	login   protocol.ConnectorLogin
	message protocol.ChatMessage
	state   *protocol.CoreState
	answer  chan connectionAnswer
}
type connectionAnswer struct {
	attempt int
	err     error
}
type connectionGeneration struct {
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
}
type connectionLoginResult struct {
	generation *connectionGeneration
	linked     voiceLinked
	err        error
}

// The coordinator is never a member of the generation it cancels and joins.
// Only it replaces durable account identity, after all work of the old identity has ended.
type voiceConnection struct {
	bridge   *voiceBridge
	ctx      context.Context
	requests chan connectionRequest
	results  chan connectionLoginResult
	done     chan struct{}
}

func newVoiceConnection(b *voiceBridge) *voiceConnection {
	return &voiceConnection{bridge: b, requests: make(chan connectionRequest), results: make(chan connectionLoginResult, 1), done: make(chan struct{})}
}
func (c *voiceConnection) start(ctx context.Context) { c.ctx = ctx; go c.run() }
func (c *voiceConnection) ask(r connectionRequest) connectionAnswer {
	if c.ctx == nil {
		return connectionAnswer{err: errors.New("连接器还没有启动")}
	}
	r.answer = make(chan connectionAnswer, 1)
	select {
	case c.requests <- r:
	case <-c.done:
		return connectionAnswer{err: context.Canceled}
	}
	select {
	case answer := <-r.answer:
		return answer
	case <-c.done:
		return connectionAnswer{err: context.Canceled}
	}
}
func (c *voiceConnection) resume() { c.ask(connectionRequest{kind: connectionResume}) }
func (c *voiceConnection) login(in protocol.ConnectorLogin) (int, error) {
	a := c.ask(connectionRequest{kind: connectionLogin, login: in})
	return a.attempt, a.err
}
func (c *voiceConnection) logout() error { return c.ask(connectionRequest{kind: connectionLogout}).err }
func (c *voiceConnection) offer(m protocol.ChatMessage, state *protocol.CoreState) {
	c.ask(connectionRequest{kind: connectionOffer, message: m, state: state})
}
func (c *voiceConnection) stop() {
	if c.ctx != nil {
		<-c.done
	}
}

func stopGeneration(g *connectionGeneration) {
	if g != nil {
		g.cancel()
		<-g.done
	}
}
func (c *voiceConnection) generation() *connectionGeneration {
	ctx, cancel := context.WithCancel(c.ctx)
	return &connectionGeneration{ctx: ctx, cancel: cancel, done: make(chan struct{})}
}
func (c *voiceConnection) connected() *connectionGeneration {
	if c.bridge.accountNow() == nil || c.ctx.Err() != nil {
		return nil
	}
	g := c.generation()
	go func() {
		defer close(g.done)
		var workers sync.WaitGroup
		workers.Go(func() { c.bridge.receiving(g.ctx) })
		workers.Go(func() { c.bridge.inbox.run(g.ctx) })
		workers.Go(func() { c.bridge.outbox.run(g.ctx) })
		workers.Wait()
	}()
	return g
}
func (c *voiceConnection) loggingIn(in protocol.ConnectorLogin) *connectionGeneration {
	b := c.bridge
	g := c.generation()
	go func() {
		defer close(g.done)
		progress := func(p voiceProgress) {
			b.mu.Lock()
			if g.ctx.Err() == nil {
				b.progress = &p
			}
			b.mu.Unlock()
			b.signal()
		}
		verify := func() string { b.mu.Lock(); defer b.mu.Unlock(); return b.verifyCode }
		linked, err := b.adapter.Login(g.ctx, in, progress, verify)
		select {
		case c.results <- connectionLoginResult{g, linked, err}:
		case <-g.ctx.Done():
		}
	}()
	return g
}
func (c *voiceConnection) resetProgress() {
	b := c.bridge
	b.mu.Lock()
	b.progress = nil
	b.verifyCode = ""
	b.mu.Unlock()
	b.signal()
}
func (c *voiceConnection) run() {
	defer close(c.done)
	b := c.bridge
	var current *connectionGeneration
	defer func() { stopGeneration(current) }()
	for {
		select {
		case <-c.ctx.Done():
			return
		case result := <-c.results:
			if result.generation != current {
				continue
			}
			stopGeneration(current)
			current = nil
			if result.err == nil && c.ctx.Err() == nil {
				secrets, err := json.Marshal(result.linked.Secrets)
				if err == nil {
					pair := ""
					if result.linked.Owner == "" {
						pair = voicePairCode()
					}
					err = b.accountChange(c.ctx, func(q *generated.Queries) error {
						if err := q.ConnectAccount(c.ctx, generated.ConnectAccountParams{Connector: string(b.id), Secrets: string(secrets), OwnerID: voiceNullable(result.linked.Owner), PairCode: voiceNullable(pair), ConnectedAt: clock.NowMs()}); err != nil {
							return err
						}
						if err := q.ClearInbound(c.ctx, string(b.id)); err != nil {
							return err
						}
						return b.outbox.retire(c.ctx, q, "换了账号")
					})
				}
				result.err = err
				if err == nil {
					result.err = b.reload()
				}
			}
			if result.err != nil {
				b.setErr(result.err.Error())
			} else {
				b.setErr("")
			}
			c.resetProgress()
			current = c.connected()
		case r := <-c.requests:
			answer := connectionAnswer{}
			switch r.kind {
			case connectionOffer:
				if c.ctx.Err() == nil {
					b.outbox.offer(r.message, r.state)
				}
			case connectionResume:
				if current == nil {
					current = c.connected()
				}
			case connectionLogin:
				b.mu.Lock()
				busy := b.progress != nil
				answer.attempt = b.attempt
				b.mu.Unlock()
				if busy && (r.login.Force == nil || !*r.login.Force) {
					break
				}
				stopGeneration(current)
				current = nil
				if c.ctx.Err() != nil {
					answer.err = c.ctx.Err()
					break
				}
				b.mu.Lock()
				b.attempt++
				answer.attempt = b.attempt
				b.err = ""
				b.verifyCode = ""
				b.progress = &voiceProgress{State: protocol.ConnectorStateWaiting}
				b.mu.Unlock()
				current = c.loggingIn(r.login)
			case connectionLogout:
				stopGeneration(current)
				current = nil
				answer.err = b.accountChange(c.ctx, func(q *generated.Queries) error {
					if err := q.DisconnectAccount(c.ctx, string(b.id)); err != nil {
						return err
					}
					if err := q.ClearInbound(c.ctx, string(b.id)); err != nil {
						return err
					}
					return b.outbox.retire(c.ctx, q, "断开了")
				})
				c.resetProgress()
				b.mu.Lock()
				b.attempt++
				b.mu.Unlock()
				if answer.err != nil {
					b.setErr(answer.err.Error())
					current = c.connected()
				} else {
					b.mu.Lock()
					b.account = nil
					b.err = ""
					b.mu.Unlock()
				}
			}
			r.answer <- answer
		}
	}
}

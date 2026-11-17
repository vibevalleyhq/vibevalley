package link

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/chord/delta"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/watch"
)

const (
	// DefaultHeartbeatInterval is the keepalive ping cadence for an active Link.
	DefaultHeartbeatInterval = 15 * time.Second

	// DefaultHeartbeatTimeout cancels all in-flight RPC contexts and closes the Link
	// if no frame is received from the peer within this duration.
	DefaultHeartbeatTimeout = 45 * time.Second
)

// RPCHandler handles an incoming rpc_req frame and returns a JSON-serializable result or error.
type RPCHandler func(ctx context.Context, params json.RawMessage) (any, error)

// Authenticator validates the peer Principal received during the Link handshake.
type Authenticator func(ctx context.Context, peer Principal) error

// WatchResolver dynamically resolves watch_open targets not statically registered via HandleWatch.
type WatchResolver func(ctx context.Context, target string) (watch.RawSource, error)

// Options configures a Link over a FrameTransport.
type Options struct {
	Principal         Principal
	Authenticate      Authenticator
	WatchResolver     WatchResolver
	HeartbeatInterval time.Duration
	HeartbeatTimeout  time.Duration
	MaxFrameBytes     int
	MaxMessageBytes   int
	Now               func() time.Time
	SidePrefix        string
	OnClose           func(error)
}

type outboundStream struct {
	chunks [][]byte
	idx    int
}

type rpcOutcome struct {
	result json.RawMessage
	err    error
}

type inboundWatch struct {
	cancel context.CancelFunc
	handle watch.RawHandle
}

// WatchEvent is a single delta/snapshot update delivered by Link.OpenWatch.
type WatchEvent struct {
	Rev      int64
	Snapshot *delta.Snapshot
	Ops      []delta.Op
	Retired  bool
	Overflow bool
}

// WatchSubscription represents an active watch_open subscription on a single Link.
type WatchSubscription struct {
	id       string
	link     *Link
	handle   *watch.WatchHandle[*delta.Snapshot]
	onEnd    func(error)
	stopCtx  func() bool
	subClear context.CancelFunc

	mu   sync.Mutex
	rev  int64
	snap *delta.Snapshot
	done bool
}

// Stop sends watch_stop to the peer and stops the local single-flight handle idempotently.
func (s *WatchSubscription) Stop() {
	s.mu.Lock()
	if s.done {
		s.mu.Unlock()
		return
	}
	s.done = true
	stopCtx := s.stopCtx
	s.stopCtx = nil
	subClear := s.subClear
	s.subClear = nil
	s.mu.Unlock()

	if stopCtx != nil {
		stopCtx()
	}
	s.link.removeOutboundWatch(s.id, true)
	s.handle.Stop()
	if subClear != nil {
		subClear()
	}
}

// Done closes when the underlying WatchHandle exits.
func (s *WatchSubscription) Done() <-chan struct{} {
	return s.handle.Done()
}

// Rev returns the latest applied revision on this subscription.
func (s *WatchSubscription) Rev() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rev
}

// Link multiplexes bidirectional deadline-bound RPCs and delta Watch subscriptions
// over a single FrameTransport with >64KB chunking and heartbeat supervision.
type Link struct {
	transport  FrameTransport
	opts       Options
	sidePrefix string
	now        func() time.Time

	ctx    context.Context
	cancel context.CancelFunc

	started      atomic.Bool
	closed       atomic.Bool
	closeErrMu   sync.Mutex
	closedErr    error
	doneCh       chan struct{}
	wg           sync.WaitGroup
	lastActivity atomic.Int64

	peerMu        sync.RWMutex
	peerPrincipal Principal

	rpcSeq    atomic.Uint64
	watchSeq  atomic.Uint64
	streamSeq atomic.Uint64

	handlerMu    sync.RWMutex
	rpcHandlers  map[string]RPCHandler
	watchSources map[string]watch.RawSource

	rpcMu        sync.Mutex
	outboundRPCs map[string]chan rpcOutcome
	inboundRPCs  map[string]context.CancelFunc

	watchMu         sync.Mutex
	outboundWatches map[string]*WatchSubscription
	inboundWatches  map[string]inboundWatch

	sendMu       sync.Mutex
	sendClosed   bool
	highQ        [][]byte
	smallQ       [][]byte
	chunkStreams []*outboundStream
	writeNotify  chan struct{}

	reassembler *chunkReassembler
}

var linkCounter atomic.Uint64

// NewLink creates an unstarted Link bound to transport. Register handlers/sources
// and call Start(ctx) to execute the Principal handshake and start multiplexing.
func NewLink(transport FrameTransport, opts Options) *Link {
	if opts.HeartbeatInterval == 0 {
		opts.HeartbeatInterval = DefaultHeartbeatInterval
	}
	if opts.HeartbeatTimeout == 0 {
		opts.HeartbeatTimeout = DefaultHeartbeatTimeout
	}
	if opts.MaxFrameBytes <= 0 {
		opts.MaxFrameBytes = MaxFrameBytes
	}
	if opts.MaxMessageBytes <= 0 {
		opts.MaxMessageBytes = DefaultMaxMessageBytes
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	prefix := opts.SidePrefix
	if prefix == "" {
		prefix = fmt.Sprintf("n%d", linkCounter.Add(1))
	}

	ctx, cancel := context.WithCancel(context.Background())
	return &Link{
		transport:       transport,
		opts:            opts,
		sidePrefix:      prefix,
		now:             opts.Now,
		ctx:             ctx,
		cancel:          cancel,
		doneCh:          make(chan struct{}),
		rpcHandlers:     make(map[string]RPCHandler),
		watchSources:    make(map[string]watch.RawSource),
		outboundRPCs:    make(map[string]chan rpcOutcome),
		inboundRPCs:     make(map[string]context.CancelFunc),
		outboundWatches: make(map[string]*WatchSubscription),
		inboundWatches:  make(map[string]inboundWatch),
		writeNotify:     make(chan struct{}, 1),
		reassembler:     newChunkReassembler(opts.MaxMessageBytes),
	}
}

// HandleRPC registers a handler for incoming rpc_req frames naming method.
func (l *Link) HandleRPC(method string, fn RPCHandler) {
	l.handlerMu.Lock()
	l.rpcHandlers[method] = fn
	l.handlerMu.Unlock()
}

// PublishDocument exposes a watch.RawSource (such as *watch.Document[T]) at target.
func (l *Link) PublishDocument(target string, source watch.RawSource) {
	l.handlerMu.Lock()
	l.watchSources[target] = source
	l.handlerMu.Unlock()
}

// PeerPrincipal returns the authenticated Principal presented by the peer during handshake.
func (l *Link) PeerPrincipal() Principal {
	l.peerMu.RLock()
	defer l.peerMu.RUnlock()
	return l.peerPrincipal.clone()
}

// Start executes the Principal handshake over transport and launches the read,
// write, and heartbeat loops.
func (l *Link) Start(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if !l.started.CompareAndSwap(false, true) {
		return errors.New("link: already started")
	}
	if err := l.opts.Principal.Validate(l.now()); err != nil {
		_ = l.transport.Close()
		l.closeWithErr(err)
		close(l.doneCh)
		return err
	}

	localPrincipal := l.opts.Principal.clone()
	helloBytes, err := json.Marshal(Frame{
		Kind:      FrameHello,
		Principal: &localPrincipal,
	})
	if err != nil {
		_ = l.transport.Close()
		l.closeWithErr(err)
		close(l.doneCh)
		return err
	}
	if err := l.transport.Send(ctx, helloBytes); err != nil {
		_ = l.transport.Close()
		l.closeWithErr(err)
		close(l.doneCh)
		return err
	}

	var peerPrincipal Principal
	gotHello := false
	gotAck := false

	for !gotHello || !gotAck {
		raw, err := l.transport.Recv(ctx)
		if err != nil {
			_ = l.transport.Close()
			l.closeWithErr(err)
			close(l.doneCh)
			return fmt.Errorf("%w: %v", ErrHandshakeFailed, err)
		}
		var f Frame
		if err := json.Unmarshal(raw, &f); err != nil {
			_ = l.transport.Close()
			l.closeWithErr(err)
			close(l.doneCh)
			return fmt.Errorf("%w: invalid handshake frame: %v", ErrHandshakeFailed, err)
		}

		switch f.Kind {
		case FrameHello:
			if f.Principal == nil {
				l.sendHandshakeAckErr(ctx, "unauthorized", "missing principal")
				_ = l.transport.Close()
				l.closeWithErr(ErrUnauthorized)
				close(l.doneCh)
				return ErrUnauthorized
			}
			peer := f.Principal.clone()
			authErr := l.validatePeerPrincipal(ctx, peer)
			if authErr != nil {
				l.sendHandshakeAckErr(ctx, "unauthorized", authErr.Error())
				_ = l.transport.Close()
				l.closeWithErr(authErr)
				close(l.doneCh)
				return authErr
			}
			ackBytes, err := json.Marshal(Frame{Kind: FrameHelloAck})
			if err != nil {
				_ = l.transport.Close()
				l.closeWithErr(err)
				close(l.doneCh)
				return err
			}
			if err := l.transport.Send(ctx, ackBytes); err != nil {
				_ = l.transport.Close()
				l.closeWithErr(err)
				close(l.doneCh)
				return err
			}
			peerPrincipal = peer
			gotHello = true

		case FrameHelloAck:
			if f.Error != nil {
				err := fmt.Errorf("%w: %s", ErrHandshakeFailed, f.Error.Error())
				_ = l.transport.Close()
				l.closeWithErr(err)
				close(l.doneCh)
				return err
			}
			gotAck = true

		default:
			err := fmt.Errorf("%w: unexpected frame %q during handshake", ErrHandshakeFailed, f.Kind)
			_ = l.transport.Close()
			l.closeWithErr(err)
			close(l.doneCh)
			return err
		}
	}

	l.peerMu.Lock()
	l.peerPrincipal = peerPrincipal
	l.peerMu.Unlock()
	l.lastActivity.Store(l.now().UnixNano())

	writeDone := make(chan struct{})
	hbDone := make(chan struct{})
	go l.writeLoop(writeDone)
	go l.heartbeatLoop(hbDone)
	go l.readLoop(writeDone, hbDone)
	return nil
}

func (l *Link) validatePeerPrincipal(ctx context.Context, peer Principal) error {
	if err := peer.Validate(l.now()); err != nil {
		return err
	}
	if l.opts.Authenticate != nil {
		return l.opts.Authenticate(ctx, peer)
	}
	return nil
}

func (l *Link) sendHandshakeAckErr(ctx context.Context, code, msg string) {
	ackBytes, err := json.Marshal(Frame{
		Kind:  FrameHelloAck,
		Error: &RPCError{Code: code, Message: msg},
	})
	if err == nil {
		_ = l.transport.Send(ctx, ackBytes)
	}
}

// Call invokes a remote RPC method respecting ctx cancellation and deadlines.
func (l *Link) Call(ctx context.Context, method string, params any, resultOut any) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := l.ctx.Err(); err != nil {
		return l.closeErr()
	}

	var paramsRaw json.RawMessage
	switch v := params.(type) {
	case nil:
	case json.RawMessage:
		paramsRaw = v
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return fmt.Errorf("link: marshal params: %w", err)
		}
		paramsRaw = b
	}

	var timeoutMs int64
	if deadline, ok := ctx.Deadline(); ok {
		rem := time.Until(deadline).Milliseconds()
		if rem <= 0 {
			return context.DeadlineExceeded
		}
		timeoutMs = rem
	}

	reqID := fmt.Sprintf("%s-%d", l.sidePrefix, l.rpcSeq.Add(1))
	ch := make(chan rpcOutcome, 1)

	l.rpcMu.Lock()
	if l.ctx.Err() != nil {
		l.rpcMu.Unlock()
		return l.closeErr()
	}
	l.outboundRPCs[reqID] = ch
	l.rpcMu.Unlock()

	if err := l.enqueueFrame(Frame{
		Kind:      FrameRPCReq,
		ID:        reqID,
		Method:    method,
		Params:    paramsRaw,
		TimeoutMs: timeoutMs,
	}); err != nil {
		l.rpcMu.Lock()
		delete(l.outboundRPCs, reqID)
		l.rpcMu.Unlock()
		return err
	}

	select {
	case out := <-ch:
		if out.err != nil {
			return out.err
		}
		if resultOut != nil && len(out.result) > 0 {
			return json.Unmarshal(out.result, resultOut)
		}
		return nil
	case <-ctx.Done():
		l.cancelOutboundRPC(reqID)
		return ctx.Err()
	case <-l.ctx.Done():
		return l.closeErr()
	}
}

func (l *Link) cancelOutboundRPC(reqID string) {
	l.rpcMu.Lock()
	_, exists := l.outboundRPCs[reqID]
	if exists {
		delete(l.outboundRPCs, reqID)
	}
	l.rpcMu.Unlock()
	if exists && l.ctx.Err() == nil {
		_ = l.enqueueFrame(Frame{
			Kind: FrameRPCCancel,
			ID:   reqID,
		})
	}
}

// OpenWatch opens a multiplexed watch stream on target starting at fromRev (0 for initial snapshot).
func (l *Link) OpenWatch(
	ctx context.Context,
	target string,
	fromRev int64,
	initialSnap *delta.Snapshot,
	fn func(context.Context, WatchEvent),
	onEnd func(error),
) (*WatchSubscription, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := l.ctx.Err(); err != nil {
		return nil, l.closeErr()
	}

	watchID := fmt.Sprintf("w-%s-%d", l.sidePrefix, l.watchSeq.Add(1))
	subCtx, subCancel := context.WithCancel(l.ctx)

	var sub *WatchSubscription
	h := watch.NewHandle[*delta.Snapshot](subCtx, func(cbCtx context.Context, ev watch.Event[*delta.Snapshot]) {
		if fn != nil {
			fn(cbCtx, WatchEvent{
				Rev:      ev.Rev,
				Snapshot: ev.Value,
				Ops:      ev.Ops,
				Retired:  ev.Retired,
				Overflow: ev.Overflow,
			})
		}
	})
	if initialSnap != nil {
		h.Seed(initialSnap)
	}

	sub = &WatchSubscription{
		id:       watchID,
		link:     l,
		handle:   h,
		onEnd:    onEnd,
		subClear: subCancel,
		rev:      fromRev,
		snap:     initialSnap,
	}
	if ctx.Done() != nil {
		sub.mu.Lock()
		sub.stopCtx = context.AfterFunc(ctx, sub.Stop)
		sub.mu.Unlock()
	}

	l.watchMu.Lock()
	if l.ctx.Err() != nil {
		l.watchMu.Unlock()
		if sub.stopCtx != nil {
			sub.stopCtx()
		}
		subCancel()
		h.Stop()
		return nil, l.closeErr()
	}
	l.outboundWatches[watchID] = sub
	l.watchMu.Unlock()

	if err := l.enqueueFrame(Frame{
		Kind:    FrameWatchOpen,
		ID:      watchID,
		Target:  target,
		FromRev: fromRev,
	}); err != nil {
		l.removeOutboundWatch(watchID, false)
		if sub.stopCtx != nil {
			sub.stopCtx()
		}
		subCancel()
		h.Stop()
		return nil, err
	}
	return sub, nil
}

func (l *Link) removeOutboundWatch(watchID string, sendStop bool) {
	l.watchMu.Lock()
	sub, ok := l.outboundWatches[watchID]
	if ok {
		delete(l.outboundWatches, watchID)
	}
	l.watchMu.Unlock()
	if ok {
		sub.mu.Lock()
		sub.done = true
		sub.mu.Unlock()
		if sendStop && l.ctx.Err() == nil {
			_ = l.enqueueFrame(Frame{
				Kind: FrameWatchStop,
				ID:   watchID,
			})
		}
	}
}

// Close closes the Link and cancels all in-flight RPCs and Watch subscriptions.
// Safe to call multiple times or from inside callbacks.
func (l *Link) Close() error {
	l.closeWithErr(ErrLinkClosed)
	if !l.started.Load() {
		// Unstarted links have no background readLoop to close doneCh.
		select {
		case <-l.doneCh:
		default:
			close(l.doneCh)
		}
	}
	return nil
}

// Done returns a channel that closes after all Link loops and active RPC handlers exit.
func (l *Link) Done() <-chan struct{} {
	return l.doneCh
}

// Wait blocks until all Link loops and spawned goroutines have exited.
func (l *Link) Wait() {
	<-l.doneCh
}

func (l *Link) closeErr() error {
	l.closeErrMu.Lock()
	defer l.closeErrMu.Unlock()
	if l.closedErr != nil {
		return l.closedErr
	}
	return ErrLinkClosed
}

func (l *Link) closeWithErr(err error) {
	if !l.closed.CompareAndSwap(false, true) {
		return
	}

	l.closeErrMu.Lock()
	l.closedErr = err
	l.closeErrMu.Unlock()

	l.cancel()

	l.sendMu.Lock()
	l.sendClosed = true
	l.highQ = nil
	l.smallQ = nil
	l.chunkStreams = nil
	l.sendMu.Unlock()

	_ = l.transport.Close()

	l.rpcMu.Lock()
	for id, ch := range l.outboundRPCs {
		select {
		case ch <- rpcOutcome{err: err}:
		default:
		}
		delete(l.outboundRPCs, id)
	}
	for id, cancel := range l.inboundRPCs {
		cancel()
		delete(l.inboundRPCs, id)
	}
	l.rpcMu.Unlock()

	l.watchMu.Lock()
	outWatches := make([]*WatchSubscription, 0, len(l.outboundWatches))
	for id, sub := range l.outboundWatches {
		outWatches = append(outWatches, sub)
		delete(l.outboundWatches, id)
	}
	inWatches := make([]inboundWatch, 0, len(l.inboundWatches))
	for id, iw := range l.inboundWatches {
		inWatches = append(inWatches, iw)
		delete(l.inboundWatches, id)
	}
	l.watchMu.Unlock()

	for _, sub := range outWatches {
		sub.mu.Lock()
		sub.done = true
		stopCtx := sub.stopCtx
		sub.stopCtx = nil
		subClear := sub.subClear
		sub.subClear = nil
		sub.mu.Unlock()
		if stopCtx != nil {
			stopCtx()
		}
		sub.handle.Stop()
		if subClear != nil {
			subClear()
		}
		if sub.onEnd != nil {
			sub.onEnd(err)
		}
	}
	for _, iw := range inWatches {
		iw.cancel()
		iw.handle.Stop()
	}

	if l.opts.OnClose != nil {
		l.opts.OnClose(err)
	}
}

func (l *Link) enqueueFrame(f Frame) error {
	raw, err := json.Marshal(f)
	if err != nil {
		return err
	}

	if len(raw) <= l.opts.MaxFrameBytes {
		l.sendMu.Lock()
		if l.sendClosed {
			l.sendMu.Unlock()
			return l.closeErr()
		}
		if f.isControlPriority() {
			l.highQ = append(l.highQ, raw)
		} else {
			l.smallQ = append(l.smallQ, raw)
		}
		l.sendMu.Unlock()
	} else {
		streamID := fmt.Sprintf("s-%s-%d", l.sidePrefix, l.streamSeq.Add(1))
		chunks, err := splitFrameChunks(streamID, raw, l.opts.MaxFrameBytes)
		if err != nil {
			return err
		}
		l.sendMu.Lock()
		if l.sendClosed {
			l.sendMu.Unlock()
			return l.closeErr()
		}
		l.chunkStreams = append(l.chunkStreams, &outboundStream{chunks: chunks})
		l.sendMu.Unlock()
	}

	select {
	case l.writeNotify <- struct{}{}:
	default:
	}
	return nil
}

func (l *Link) nextWireFrame(turn uint64) ([]byte, bool) {
	l.sendMu.Lock()
	defer l.sendMu.Unlock()

	if l.sendClosed {
		return nil, false
	}
	if len(l.highQ) > 0 {
		pkt := l.highQ[0]
		l.highQ[0] = nil
		l.highQ = l.highQ[1:]
		if len(l.highQ) == 0 {
			l.highQ = nil
		}
		return pkt, true
	}

	preferSmall := len(l.smallQ) > 0 && (len(l.chunkStreams) == 0 || turn%2 == 0)
	if preferSmall {
		pkt := l.smallQ[0]
		l.smallQ[0] = nil
		l.smallQ = l.smallQ[1:]
		if len(l.smallQ) == 0 {
			l.smallQ = nil
		}
		return pkt, true
	}

	if len(l.chunkStreams) > 0 {
		st := l.chunkStreams[0]
		pkt := st.chunks[st.idx]
		st.chunks[st.idx] = nil
		st.idx++
		if st.idx >= len(st.chunks) {
			copy(l.chunkStreams, l.chunkStreams[1:])
			l.chunkStreams[len(l.chunkStreams)-1] = nil
			l.chunkStreams = l.chunkStreams[:len(l.chunkStreams)-1]
		} else {
			// Round-robin chunks across concurrent streams to avoid HoL blocking.
			copy(l.chunkStreams, l.chunkStreams[1:])
			l.chunkStreams[len(l.chunkStreams)-1] = st
		}
		return pkt, true
	}

	if len(l.smallQ) > 0 {
		pkt := l.smallQ[0]
		l.smallQ[0] = nil
		l.smallQ = l.smallQ[1:]
		if len(l.smallQ) == 0 {
			l.smallQ = nil
		}
		return pkt, true
	}
	return nil, false
}

func (l *Link) writeLoop(done chan struct{}) {
	defer close(done)
	var turn uint64
	for {
		pkt, ok := l.nextWireFrame(turn)
		if !ok {
			select {
			case <-l.ctx.Done():
				return
			case <-l.writeNotify:
				continue
			}
		}
		turn++
		if err := l.transport.Send(l.ctx, pkt); err != nil {
			l.closeWithErr(err)
			return
		}
	}
}

func (l *Link) heartbeatLoop(done chan struct{}) {
	defer close(done)
	interval := l.opts.HeartbeatInterval
	timeout := l.opts.HeartbeatTimeout
	if interval <= 0 {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-l.ctx.Done():
			return
		case <-ticker.C:
			last := time.Unix(0, l.lastActivity.Load())
			if timeout > 0 && l.now().Sub(last) > timeout {
				l.closeWithErr(ErrHeartbeatTimeout)
				return
			}
			_ = l.enqueueFrame(Frame{Kind: FramePing})
		}
	}
}

func (l *Link) readLoop(writeDone, hbDone chan struct{}) {
	defer func() {
		l.closeWithErr(ErrLinkClosed)
		l.reassembler.clear()
		<-writeDone
		<-hbDone
		l.wg.Wait()
		close(l.doneCh)
	}()

	for {
		raw, err := l.transport.Recv(l.ctx)
		if err != nil {
			l.closeWithErr(err)
			return
		}
		l.lastActivity.Store(l.now().UnixNano())

		var f Frame
		if err := json.Unmarshal(raw, &f); err != nil {
			l.closeWithErr(fmt.Errorf("%w: %v", ErrInvalidFrame, err))
			return
		}
		if f.Kind == FrameChunk {
			assembled, err := l.reassembler.push(f)
			if err != nil {
				l.closeWithErr(err)
				return
			}
			if assembled == nil {
				continue
			}
			f = *assembled
		}
		l.dispatchFrame(f)
	}
}

func (l *Link) dispatchFrame(f Frame) {
	switch f.Kind {
	case FramePing:
		_ = l.enqueueFrame(Frame{Kind: FramePong})
	case FramePong:
		// Activity timestamp already updated on frame receipt.
	case FrameRPCReq:
		l.handleRPCReq(f)
	case FrameRPCRes:
		l.handleRPCRes(f)
	case FrameRPCCancel:
		l.handleRPCCancel(f)
	case FrameWatchOpen:
		l.handleWatchOpen(f)
	case FrameWatchPush:
		l.handleWatchPush(f)
	case FrameWatchStop:
		l.handleWatchStop(f)
	case FrameWatchEnd:
		l.handleWatchEnd(f)
	}
}

func (l *Link) handleRPCReq(f Frame) {
	l.handlerMu.RLock()
	handler := l.rpcHandlers[f.Method]
	l.handlerMu.RUnlock()

	if handler == nil {
		_ = l.enqueueFrame(Frame{
			Kind: FrameRPCRes,
			ID:   f.ID,
			Error: &RPCError{
				Code:    "not_found",
				Message: fmt.Sprintf("unknown method %q", f.Method),
			},
		})
		return
	}

	baseCtx := WithPrincipal(l.ctx, l.PeerPrincipal())
	var reqCtx context.Context
	var cancel context.CancelFunc
	if f.TimeoutMs > 0 {
		reqCtx, cancel = context.WithTimeout(baseCtx, time.Duration(f.TimeoutMs)*time.Millisecond)
	} else {
		reqCtx, cancel = context.WithCancel(baseCtx)
	}

	l.rpcMu.Lock()
	if l.ctx.Err() != nil {
		l.rpcMu.Unlock()
		cancel()
		return
	}
	l.inboundRPCs[f.ID] = cancel
	l.rpcMu.Unlock()

	l.wg.Add(1)
	go func() {
		defer l.wg.Done()
		defer cancel()
		defer func() {
			l.rpcMu.Lock()
			delete(l.inboundRPCs, f.ID)
			l.rpcMu.Unlock()
		}()

		res, err := handler(reqCtx, f.Params)
		if l.ctx.Err() != nil {
			return
		}
		if errors.Is(reqCtx.Err(), context.Canceled) {
			return
		}

		if err != nil {
			var rpcErr *RPCError
			if !errors.As(err, &rpcErr) {
				code := "internal"
				if errors.Is(err, context.DeadlineExceeded) {
					code = "deadline_exceeded"
				}
				rpcErr = &RPCError{Code: code, Message: err.Error()}
			}
			_ = l.enqueueFrame(Frame{
				Kind:  FrameRPCRes,
				ID:    f.ID,
				Error: rpcErr,
			})
			return
		}

		var resRaw json.RawMessage
		if res != nil {
			if raw, ok := res.(json.RawMessage); ok {
				resRaw = raw
			} else {
				encoded, err := json.Marshal(res)
				if err != nil {
					_ = l.enqueueFrame(Frame{
						Kind:  FrameRPCRes,
						ID:    f.ID,
						Error: &RPCError{Code: "internal", Message: err.Error()},
					})
					return
				}
				resRaw = encoded
			}
		}
		_ = l.enqueueFrame(Frame{
			Kind:   FrameRPCRes,
			ID:     f.ID,
			Result: resRaw,
		})
	}()
}

func (l *Link) handleRPCRes(f Frame) {
	l.rpcMu.Lock()
	ch, ok := l.outboundRPCs[f.ID]
	if ok {
		delete(l.outboundRPCs, f.ID)
	}
	l.rpcMu.Unlock()
	if !ok {
		return
	}
	var out rpcOutcome
	if f.Error != nil {
		out.err = f.Error
	} else {
		out.result = f.Result
	}
	select {
	case ch <- out:
	default:
	}
}

func (l *Link) handleRPCCancel(f Frame) {
	l.rpcMu.Lock()
	cancel, ok := l.inboundRPCs[f.ID]
	if ok {
		delete(l.inboundRPCs, f.ID)
	}
	l.rpcMu.Unlock()
	if ok {
		cancel()
	}
}

func (l *Link) handleWatchOpen(f Frame) {
	l.handlerMu.RLock()
	src := l.watchSources[f.Target]
	resolver := l.opts.WatchResolver
	l.handlerMu.RUnlock()

	if src == nil && resolver != nil {
		resolved, err := resolver(WithPrincipal(l.ctx, l.PeerPrincipal()), f.Target)
		if err != nil {
			_ = l.enqueueFrame(Frame{
				Kind:  FrameWatchEnd,
				ID:    f.ID,
				Error: &RPCError{Code: "unauthorized", Message: err.Error()},
			})
			return
		}
		src = resolved
	}
	if src == nil {
		_ = l.enqueueFrame(Frame{
			Kind:  FrameWatchEnd,
			ID:    f.ID,
			Error: &RPCError{Code: "not_found", Message: fmt.Sprintf("unknown watch target %q", f.Target)},
		})
		return
	}

	subCtx, cancel := context.WithCancel(WithPrincipal(l.ctx, l.PeerPrincipal()))
	rawHandle, err := src.WatchRaw(subCtx, f.FromRev, func(cbCtx context.Context, ev watch.RawEvent) {
		if cbCtx.Err() != nil {
			return
		}
		if !ev.Retired && len(ev.Ops) == 0 {
			return
		}
		_ = l.enqueueFrame(Frame{
			Kind:     FrameWatchPush,
			ID:       f.ID,
			Rev:      ev.Rev,
			Ops:      ev.Ops,
			Retired:  ev.Retired,
			Overflow: ev.Overflow,
		})
	})
	if err != nil {
		cancel()
		_ = l.enqueueFrame(Frame{
			Kind:  FrameWatchEnd,
			ID:    f.ID,
			Error: &RPCError{Code: "internal", Message: err.Error()},
		})
		return
	}

	l.watchMu.Lock()
	if l.ctx.Err() != nil {
		l.watchMu.Unlock()
		cancel()
		rawHandle.Stop()
		return
	}
	if prev, dup := l.inboundWatches[f.ID]; dup {
		prev.cancel()
		prev.handle.Stop()
	}
	l.inboundWatches[f.ID] = inboundWatch{cancel: cancel, handle: rawHandle}
	l.watchMu.Unlock()
}

func (l *Link) handleWatchPush(f Frame) {
	l.watchMu.Lock()
	sub := l.outboundWatches[f.ID]
	l.watchMu.Unlock()
	if sub == nil {
		return
	}

	sub.mu.Lock()
	if sub.done {
		sub.mu.Unlock()
		return
	}
	if f.Retired {
		sub.rev = f.Rev
		sub.mu.Unlock()
		sub.handle.Retire(f.Rev)
		return
	}

	nextSnap, err := sub.snap.Apply(f.Ops...)
	if err != nil {
		sub.mu.Unlock()
		_ = l.enqueueFrame(Frame{Kind: FrameWatchStop, ID: f.ID})
		sub.Stop()
		if sub.onEnd != nil {
			sub.onEnd(err)
		}
		return
	}
	sub.snap = nextSnap
	sub.rev = f.Rev
	sub.mu.Unlock()

	_ = sub.handle.Push(f.Rev, nextSnap, nextSnap, f.Ops...)
}

func (l *Link) handleWatchStop(f Frame) {
	l.watchMu.Lock()
	iw, ok := l.inboundWatches[f.ID]
	if ok {
		delete(l.inboundWatches, f.ID)
	}
	l.watchMu.Unlock()
	if ok {
		iw.cancel()
		iw.handle.Stop()
	}
}

func (l *Link) handleWatchEnd(f Frame) {
	l.watchMu.Lock()
	sub, ok := l.outboundWatches[f.ID]
	if ok {
		delete(l.outboundWatches, f.ID)
	}
	l.watchMu.Unlock()
	if !ok {
		return
	}

	sub.mu.Lock()
	sub.done = true
	stopCtx := sub.stopCtx
	sub.stopCtx = nil
	subClear := sub.subClear
	sub.subClear = nil
	sub.mu.Unlock()
	if stopCtx != nil {
		stopCtx()
	}
	sub.handle.Stop()
	if subClear != nil {
		subClear()
	}
	if sub.onEnd != nil {
		var err error
		if f.Error != nil {
			err = f.Error
		}
		sub.onEnd(err)
	}
}

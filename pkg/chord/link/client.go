package link

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/chord/delta"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/watch"
)

// DialFunc establishes a fresh FrameTransport for initial connect and reconnects.
type DialFunc func(ctx context.Context) (FrameTransport, error)

// ClientOptions configures a reconnecting ChordClient / Client.
type ClientOptions struct {
	LinkOptions       Options
	ReconnectMinDelay time.Duration
	ReconnectMaxDelay time.Duration
	OnConnect         func(*Link)
	OnDisconnect      func(error)
}

// Client manages a reconnecting Link with persistent RPC handlers and cursor-resuming Watches.
type Client struct {
	dial DialFunc
	opts ClientOptions

	ctx       context.Context
	cancel    context.CancelFunc
	connected atomic.Bool
	doneCh    chan struct{}

	mu         sync.Mutex
	closed     bool
	activeLink *Link
	readyCh    chan struct{}

	regMu        sync.RWMutex
	rpcHandlers  map[string]RPCHandler
	watchSources map[string]watch.RawSource

	watchSeq atomic.Uint64
	watches  map[uint64]*ClientWatch
}

// ChordClient aliases Client for readability across frontend and desktop integrations.
type ChordClient = Client

// ClientWatch represents a cursor-preserving Watch across Link reconnects.
type ClientWatch struct {
	id       uint64
	client   *Client
	target   string
	handle   *watch.WatchHandle[*delta.Snapshot]
	stopCtx  func() bool
	subClear context.CancelFunc

	mu          sync.Mutex
	stopped     bool
	gen         uint64
	lastRev     int64
	lastSnap    *delta.Snapshot
	lastRetired bool
	curSub      *WatchSubscription
}

// Stop stops the persistent watch and notifies the current server connection if active.
func (w *ClientWatch) Stop() {
	w.mu.Lock()
	if w.stopped {
		w.mu.Unlock()
		return
	}
	w.stopped = true
	stopCtx := w.stopCtx
	w.stopCtx = nil
	subClear := w.subClear
	w.subClear = nil
	curSub := w.curSub
	w.curSub = nil
	w.mu.Unlock()

	if stopCtx != nil {
		stopCtx()
	}
	w.client.removeWatch(w.id)
	if curSub != nil {
		curSub.Stop()
	}
	w.handle.Stop()
	if subClear != nil {
		subClear()
	}
}

// Done closes when the underlying single-flight WatchHandle exits.
func (w *ClientWatch) Done() <-chan struct{} {
	return w.handle.Done()
}

// LastRev returns the latest confirmed revision received by this watch.
func (w *ClientWatch) LastRev() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.lastRev
}

// NewClient constructs a reconnecting Client using dial. Call Connect(ctx) to start.
func NewClient(dial DialFunc, opts ClientOptions) *Client {
	if opts.ReconnectMinDelay <= 0 {
		opts.ReconnectMinDelay = 20 * time.Millisecond
	}
	if opts.ReconnectMaxDelay <= 0 {
		opts.ReconnectMaxDelay = 500 * time.Millisecond
	}
	if opts.ReconnectMaxDelay < opts.ReconnectMinDelay {
		opts.ReconnectMaxDelay = opts.ReconnectMinDelay
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{
		dial:         dial,
		opts:         opts,
		ctx:          ctx,
		cancel:       cancel,
		doneCh:       make(chan struct{}),
		readyCh:      make(chan struct{}),
		rpcHandlers:  make(map[string]RPCHandler),
		watchSources: make(map[string]watch.RawSource),
		watches:      make(map[uint64]*ClientWatch),
	}
}

// HandleRPC registers a handler installed on the current and every reconnected Link.
func (c *Client) HandleRPC(method string, fn RPCHandler) {
	c.regMu.Lock()
	c.rpcHandlers[method] = fn
	c.regMu.Unlock()

	c.mu.Lock()
	lnk := c.activeLink
	c.mu.Unlock()
	if lnk != nil {
		lnk.HandleRPC(method, fn)
	}
}

// PublishDocument exposes a watch.RawSource on the current and every reconnected Link.
func (c *Client) PublishDocument(target string, src watch.RawSource) {
	c.regMu.Lock()
	c.watchSources[target] = src
	c.regMu.Unlock()

	c.mu.Lock()
	lnk := c.activeLink
	c.mu.Unlock()
	if lnk != nil {
		lnk.PublishDocument(target, src)
	}
}

// Connect establishes the initial Link and handshake synchronously, then maintains
// the connection across disconnects until Close is called.
func (c *Client) Connect(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if !c.connected.CompareAndSwap(false, true) {
		return errors.New("link: client already connected")
	}

	lnk, err := c.dialAndStart(ctx)
	if err != nil {
		c.cancel()
		close(c.doneCh)
		return err
	}

	if !c.setActiveLink(lnk) {
		_ = lnk.Close()
		lnk.Wait()
		close(c.doneCh)
		return ErrLinkClosed
	}
	c.attachAllWatches(lnk)
	if c.opts.OnConnect != nil {
		c.opts.OnConnect(lnk)
	}

	go c.supervise(lnk)
	return nil
}

// ActiveLink returns the current live Link, or nil while disconnected.
func (c *Client) ActiveLink() *Link {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.activeLink
}

// Call invokes a remote RPC over the current Link, waiting briefly if reconnecting until ctx cancels.
func (c *Client) Call(ctx context.Context, method string, params any, resultOut any) error {
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return ErrLinkClosed
		}
		lnk := c.activeLink
		ready := c.readyCh
		c.mu.Unlock()

		if lnk != nil {
			return lnk.Call(ctx, method, params, resultOut)
		}

		select {
		case <-ready:
		case <-ctx.Done():
			return ctx.Err()
		case <-c.ctx.Done():
			return ErrLinkClosed
		}
	}
}

// Watch opens a persistent single-flight Watch across reconnects carrying fromRev.
func (c *Client) Watch(ctx context.Context, target string, fn func(context.Context, WatchEvent)) (*ClientWatch, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	subCtx, subCancel := context.WithCancel(c.ctx)
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

	cw := &ClientWatch{
		id:       c.watchSeq.Add(1),
		client:   c,
		target:   target,
		handle:   h,
		subClear: subCancel,
	}
	if ctx.Done() != nil {
		cw.mu.Lock()
		cw.stopCtx = context.AfterFunc(ctx, cw.Stop)
		cw.mu.Unlock()
	}

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		if cw.stopCtx != nil {
			cw.stopCtx()
		}
		subCancel()
		h.Stop()
		return nil, ErrLinkClosed
	}
	c.watches[cw.id] = cw
	lnk := c.activeLink
	c.mu.Unlock()

	if lnk != nil {
		c.attachWatchToLink(cw, lnk)
	}
	return cw, nil
}

// Close shuts down the Client, stops all persistent watches, and waits for all loops to exit.
func (c *Client) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		if c.connected.Load() {
			<-c.doneCh
		}
		return nil
	}
	c.closed = true
	lnk := c.activeLink
	c.activeLink = nil
	watches := make([]*ClientWatch, 0, len(c.watches))
	for id, cw := range c.watches {
		watches = append(watches, cw)
		delete(c.watches, id)
	}
	c.mu.Unlock()

	c.cancel()
	for _, cw := range watches {
		cw.Stop()
	}
	if lnk != nil {
		_ = lnk.Close()
		lnk.Wait()
	}
	if c.connected.Load() {
		<-c.doneCh
	}
	return nil
}

func (c *Client) removeWatch(id uint64) {
	c.mu.Lock()
	delete(c.watches, id)
	c.mu.Unlock()
}

func (c *Client) dialAndStart(ctx context.Context) (*Link, error) {
	tr, err := c.dial(ctx)
	if err != nil {
		return nil, err
	}
	lnk := NewLink(tr, c.opts.LinkOptions)

	c.regMu.RLock()
	for m, fn := range c.rpcHandlers {
		lnk.HandleRPC(m, fn)
	}
	for tgt, src := range c.watchSources {
		lnk.PublishDocument(tgt, src)
	}
	c.regMu.RUnlock()

	if err := lnk.Start(ctx); err != nil {
		_ = tr.Close()
		return nil, err
	}
	return lnk, nil
}

func (c *Client) setActiveLink(lnk *Link) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return false
	}
	c.activeLink = lnk
	select {
	case <-c.readyCh:
	default:
		close(c.readyCh)
	}
	return true
}

func (c *Client) clearActiveLink(lnk *Link) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.activeLink == lnk {
		c.activeLink = nil
		c.readyCh = make(chan struct{})
	}
}

func (c *Client) attachAllWatches(lnk *Link) {
	c.mu.Lock()
	watches := make([]*ClientWatch, 0, len(c.watches))
	for _, cw := range c.watches {
		watches = append(watches, cw)
	}
	c.mu.Unlock()

	for _, cw := range watches {
		c.attachWatchToLink(cw, lnk)
	}
}

func (c *Client) attachWatchToLink(cw *ClientWatch, lnk *Link) {
	cw.mu.Lock()
	if cw.stopped {
		cw.mu.Unlock()
		return
	}
	cw.gen++
	gen := cw.gen
	fromRev := cw.lastRev
	initialSnap := cw.lastSnap
	prevSub := cw.curSub
	cw.curSub = nil
	cw.mu.Unlock()

	if prevSub != nil {
		prevSub.Stop()
	}

	sub, err := lnk.OpenWatch(c.ctx, cw.target, fromRev, initialSnap, func(_ context.Context, ev WatchEvent) {
		cw.mu.Lock()
		if cw.stopped || cw.gen != gen {
			cw.mu.Unlock()
			return
		}
		if ev.Retired {
			cw.lastRev = ev.Rev
			cw.lastRetired = true
			cw.mu.Unlock()
			cw.handle.Retire(ev.Rev)
			return
		}
		if ev.Rev <= cw.lastRev && !cw.lastRetired {
			cw.mu.Unlock()
			return
		}
		cw.lastRev = ev.Rev
		cw.lastSnap = ev.Snapshot
		cw.lastRetired = false
		cw.mu.Unlock()

		_ = cw.handle.Push(ev.Rev, ev.Snapshot, ev.Snapshot, ev.Ops...)
	}, nil)
	if err != nil {
		return
	}

	cw.mu.Lock()
	if cw.stopped || cw.gen != gen {
		cw.mu.Unlock()
		sub.Stop()
		return
	}
	cw.curSub = sub
	cw.mu.Unlock()
}

func (c *Client) supervise(current *Link) {
	defer close(c.doneCh)

	lnk := current
	for {
		<-lnk.Done()
		c.clearActiveLink(lnk)
		if c.opts.OnDisconnect != nil {
			c.opts.OnDisconnect(lnk.closeErr())
		}

		if c.ctx.Err() != nil {
			return
		}

		delay := c.opts.ReconnectMinDelay
		for {
			if c.ctx.Err() != nil {
				return
			}
			nextLink, err := c.dialAndStart(c.ctx)
			if err == nil {
				if !c.setActiveLink(nextLink) {
					_ = nextLink.Close()
					nextLink.Wait()
					return
				}
				lnk = nextLink
				c.attachAllWatches(lnk)
				if c.opts.OnConnect != nil {
					c.opts.OnConnect(lnk)
				}
				break
			}

			timer := time.NewTimer(delay)
			select {
			case <-c.ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			delay = min(delay*2, c.opts.ReconnectMaxDelay)
		}
	}
}

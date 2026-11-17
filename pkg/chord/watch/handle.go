package watch

import (
	"context"
	"sync"

	"github.com/vibevalleyhq/vibevalley/pkg/chord/delta"
)

// Event represents one coalesced single-flight delivery to a WatchHandle consumer.
type Event[T any] struct {
	Rev      int64      `json:"rev"`
	Value    T          `json:"value"`
	Ops      []delta.Op `json:"ops,omitempty"`
	Retired  bool       `json:"retired,omitempty"`
	Overflow bool       `json:"overflow,omitempty"`
}

// HandleOption configures a WatchHandle.
type HandleOption func(*handleConfig)

type handleConfig struct {
	maxPendingOps int
	fromRev       int64
}

// WithMaxPendingOps overrides the 10,000-op overflow threshold on the handle's PendingOps queue.
func WithMaxPendingOps(n int) HandleOption {
	return func(c *handleConfig) {
		if n > 0 {
			c.maxPendingOps = n
		}
	}
}

// WithFromRev sets the last revision already known by the consumer when attaching to a Document.
func WithFromRev(rev int64) HandleOption {
	return func(c *handleConfig) {
		c.fromRev = rev
	}
}

// WatchHandle delivers state updates sequentially to a single consumer callback.
// Callbacks never overlap concurrently; mutations arriving while a callback is
// executing coalesce inside PendingOps and deliver together at the latest rev.
type WatchHandle[T any] struct {
	ctx        context.Context
	cancel     context.CancelFunc
	stopCtxCb  func() bool
	fn         func(context.Context, Event[T])
	notifyCh   chan struct{}
	doneCh     chan struct{}
	unregOnce  sync.Once
	unregister func()

	mu             sync.Mutex
	stopped        bool
	hasPending     bool
	pendingRetired bool
	latestRev      int64
	latestVal      T
	latestSnap     *delta.Snapshot
	decodeSnap     func(*delta.Snapshot) (T, error)
	pending        *delta.PendingOps
}

// NewHandle creates and starts a standalone single-flight WatchHandle[T].
func NewHandle[T any](ctx context.Context, fn func(context.Context, Event[T]), opts ...HandleOption) *WatchHandle[T] {
	if ctx == nil {
		ctx = context.Background()
	}
	cfg := handleConfig{maxPendingOps: delta.DefaultMaxPendingOps}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	hCtx, cancel := context.WithCancel(ctx)
	h := &WatchHandle[T]{
		ctx:      hCtx,
		cancel:   cancel,
		fn:       fn,
		notifyCh: make(chan struct{}, 1),
		doneCh:   make(chan struct{}),
		pending:  delta.NewPendingOps(cfg.maxPendingOps),
	}
	h.stopCtxCb = context.AfterFunc(ctx, h.Stop)
	go h.run()
	return h
}

func (h *WatchHandle[T]) setDecodeSnap(fn func(*delta.Snapshot) (T, error)) {
	h.mu.Lock()
	h.decodeSnap = fn
	h.mu.Unlock()
}

// Seed sets the preserved last value on a handle without triggering a delivery.
func (h *WatchHandle[T]) Seed(val T) {
	h.mu.Lock()
	if !h.stopped {
		h.latestVal = val
	}
	h.mu.Unlock()
}

func (h *WatchHandle[T]) pushSnapshot(rev int64, snap *delta.Snapshot, ops ...delta.Op) error {
	h.mu.Lock()
	if h.stopped {
		h.mu.Unlock()
		return nil
	}
	if len(ops) > 0 {
		if err := h.pending.PushSnapshot(ops, snap); err != nil {
			h.mu.Unlock()
			return err
		}
	} else if snap != nil && h.pending.Overflowed() {
		if err := h.pending.PushSnapshot(nil, snap); err != nil {
			h.mu.Unlock()
			return err
		}
	}
	h.pendingRetired = false
	h.latestRev = rev
	h.latestSnap = snap
	h.hasPending = true
	h.mu.Unlock()

	select {
	case h.notifyCh <- struct{}{}:
	default:
	}
	return nil
}

func (h *WatchHandle[T]) setUnregister(fn func()) {
	h.mu.Lock()
	stopped := h.stopped
	h.unregister = fn
	h.mu.Unlock()
	if stopped && fn != nil {
		h.unregOnce.Do(fn)
	}
}

// Push enqueues a committed update and wakes the delivery loop without blocking the caller.
func (h *WatchHandle[T]) Push(rev int64, val T, snap *delta.Snapshot, ops ...delta.Op) error {
	h.mu.Lock()
	if h.stopped {
		h.mu.Unlock()
		return nil
	}
	if len(ops) > 0 {
		if err := h.pending.PushSnapshot(ops, snap); err != nil {
			h.mu.Unlock()
			return err
		}
	} else if snap != nil && h.pending.Overflowed() {
		if err := h.pending.PushSnapshot(nil, snap); err != nil {
			h.mu.Unlock()
			return err
		}
	}
	h.pendingRetired = false
	h.latestRev = rev
	h.latestVal = val
	h.latestSnap = nil
	h.hasPending = true
	h.mu.Unlock()

	select {
	case h.notifyCh <- struct{}{}:
	default:
	}
	return nil
}

// Retire marks the upstream document as recycled while preserving the last value
// and clearing any stale queued ops so the consumer receives retired: true without disconnecting.
func (h *WatchHandle[T]) Retire(rev int64) {
	h.mu.Lock()
	if h.stopped {
		h.mu.Unlock()
		return
	}
	if rev > h.latestRev {
		h.latestRev = rev
	}
	if h.pending != nil {
		h.pending.Clear()
	}
	h.pendingRetired = true
	h.hasPending = true
	h.mu.Unlock()

	select {
	case h.notifyCh <- struct{}{}:
	default:
	}
}

// Rebuild clears retired state and resumes delivery with a root replacement.
func (h *WatchHandle[T]) Rebuild(rev int64, val T, snap *delta.Snapshot) error {
	h.mu.Lock()
	if h.stopped {
		h.mu.Unlock()
		return nil
	}
	if h.pending != nil {
		h.pending.Clear()
	}
	if snap != nil {
		if err := h.pending.PushSnapshot([]delta.Op{delta.ReplaceRoot(snap.Value())}, snap); err != nil {
			h.mu.Unlock()
			return err
		}
	}
	h.pendingRetired = false
	h.latestRev = rev
	h.latestVal = val
	h.latestSnap = nil
	h.hasPending = true
	h.mu.Unlock()

	select {
	case h.notifyCh <- struct{}{}:
	default:
	}
	return nil
}

// Stop idempotently cancels delivery, discards buffered operations, and detaches
// references to the upstream state tree. Safe to call from inside the callback.
func (h *WatchHandle[T]) Stop() {
	h.mu.Lock()
	if h.stopped {
		h.mu.Unlock()
		return
	}
	h.stopped = true
	h.hasPending = false
	h.pendingRetired = false
	if h.pending != nil {
		h.pending.Clear()
		h.pending = nil
	}
	var zero T
	h.latestVal = zero
	h.latestSnap = nil
	unreg := h.unregister
	h.unregister = nil
	h.mu.Unlock()

	if h.stopCtxCb != nil {
		h.stopCtxCb()
	}
	h.cancel()
	if unreg != nil {
		h.unregOnce.Do(unreg)
	}
}

// Done returns a channel that closes when the single-flight worker exits.
func (h *WatchHandle[T]) Done() <-chan struct{} {
	return h.doneCh
}

// Wait blocks until the single-flight worker exits. Do not call from inside the callback.
func (h *WatchHandle[T]) Wait() {
	<-h.doneCh
}

func (h *WatchHandle[T]) run() {
	defer func() {
		h.Stop()
		close(h.doneCh)
	}()

	for {
		select {
		case <-h.ctx.Done():
			return
		case <-h.notifyCh:
		}

		for {
			h.mu.Lock()
			if h.stopped || h.ctx.Err() != nil {
				h.mu.Unlock()
				return
			}
			if !h.hasPending {
				h.mu.Unlock()
				break
			}
			h.hasPending = false
			snapToDecode := h.latestSnap
			decodeFn := h.decodeSnap
			val := h.latestVal
			rev := h.latestRev
			isRetired := h.pendingRetired
			h.pendingRetired = false

			var ops []delta.Op
			var overflow bool
			if !isRetired {
				ops, overflow = h.pending.Drain()
			}
			h.mu.Unlock()

			if snapToDecode != nil && decodeFn != nil {
				if decoded, err := decodeFn(snapToDecode); err == nil {
					val = decoded
					h.mu.Lock()
					if !h.stopped && h.latestSnap == snapToDecode {
						h.latestVal = decoded
						h.latestSnap = nil
					}
					h.mu.Unlock()
				}
			}

			ev := Event[T]{
				Rev:      rev,
				Value:    val,
				Ops:      ops,
				Retired:  isRetired,
				Overflow: overflow,
			}

			if h.fn != nil {
				h.fn(h.ctx, ev)
			}
		}
	}
}

package watch

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/vibevalleyhq/vibevalley/pkg/chord/delta"
)

// DefaultHistorySize is the number of revisions retained in a Document's ring buffer
// for incremental fromRev reconnect catchup before falling back to root replace.
const DefaultHistorySize = 1024

// RawEvent is the type-erased Watch delivery used by transport bridges such as pkg/chord/link.
type RawEvent struct {
	Rev      int64
	Snapshot *delta.Snapshot
	Ops      []delta.Op
	Retired  bool
	Overflow bool
}

// RawHandle abstracts a running WatchHandle for non-generic callers.
type RawHandle interface {
	Stop()
	Done() <-chan struct{}
}

// RawSource exposes a Document or custom observable resource to pkg/chord/link.
type RawSource interface {
	WatchRaw(ctx context.Context, fromRev int64, fn func(context.Context, RawEvent)) (RawHandle, error)
}

// DocumentOption configures a Document[T].
type DocumentOption[T any] func(*documentConfig[T])

type documentConfig[T any] struct {
	historySize   int
	maxPendingOps int
	encode        func(T) (*delta.Snapshot, error)
	decode        func(*delta.Snapshot) (T, error)
}

// WithHistorySize sets the revision ring buffer capacity for incremental reconnects.
func WithHistorySize[T any](n int) DocumentOption[T] {
	return func(c *documentConfig[T]) {
		if n >= 0 {
			c.historySize = n
		}
	}
}

// WithMaxPendingOpsPerWatch sets the default PendingOps overflow threshold for handles
// created on this document.
func WithMaxPendingOpsPerWatch[T any](n int) DocumentOption[T] {
	return func(c *documentConfig[T]) {
		if n > 0 {
			c.maxPendingOps = n
		}
	}
}

// WithSnapshotCodec provides custom conversion between T and *delta.Snapshot.
func WithSnapshotCodec[T any](encode func(T) (*delta.Snapshot, error), decode func(*delta.Snapshot) (T, error)) DocumentOption[T] {
	return func(c *documentConfig[T]) {
		c.encode = encode
		c.decode = decode
	}
}

type revRecord struct {
	rev int64
	ops []delta.Op
}

// Document holds a versioned observable state T backed by an immutable *delta.Snapshot,
// a revision ring buffer for flicker-free fromRev reconnects, and registered WatchHandles.
type Document[T any] struct {
	mu            sync.RWMutex
	rev           int64
	baseRev       int64
	val           T
	snap          *delta.Snapshot
	retired       bool
	historySize   int
	maxPendingOps int
	encode        func(T) (*delta.Snapshot, error)
	decode        func(*delta.Snapshot) (T, error)

	ring     []revRecord
	ringHead int
	ringLen  int

	nextSubID uint64
	subs      map[uint64]*WatchHandle[T]
	rawSubs   map[uint64]*WatchHandle[*delta.Snapshot]
}

// NewDocument creates a Document initialized at rev 1 with initial value.
func NewDocument[T any](initial T, opts ...DocumentOption[T]) (*Document[T], error) {
	cfg := documentConfig[T]{
		historySize:   DefaultHistorySize,
		maxPendingOps: delta.DefaultMaxPendingOps,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	if cfg.encode == nil {
		cfg.encode = defaultEncode[T]
	}
	if cfg.decode == nil {
		cfg.decode = defaultDecode[T]
	}
	snap, err := cfg.encode(initial)
	if err != nil {
		return nil, err
	}
	val, err := cfg.decode(snap)
	if err != nil {
		return nil, err
	}
	var ring []revRecord
	if cfg.historySize > 0 {
		ring = make([]revRecord, cfg.historySize)
	}
	return &Document[T]{
		rev:           1,
		baseRev:       1,
		val:           val,
		snap:          snap,
		historySize:   cfg.historySize,
		maxPendingOps: cfg.maxPendingOps,
		encode:        cfg.encode,
		decode:        cfg.decode,
		ring:          ring,
		subs:          make(map[uint64]*WatchHandle[T]),
		rawSubs:       make(map[uint64]*WatchHandle[*delta.Snapshot]),
	}, nil
}

// State returns the current revision, value copy, and retired flag.
func (d *Document[T]) State() (rev int64, val T, retired bool) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	if snap, err := d.decode(d.snap); err == nil {
		return d.rev, snap, d.retired
	}
	return d.rev, d.val, d.retired
}

// Snapshot returns the current revision, immutable snapshot, and retired flag.
func (d *Document[T]) Snapshot() (rev int64, snap *delta.Snapshot, retired bool) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.rev, d.snap, d.retired
}

// Mutate runs fn against a Copy-on-Write draft of the current snapshot, commits
// any emitted delta operations, increments rev, and notifies all active watches.
func (d *Document[T]) Mutate(fn func(*delta.Draft) error) (int64, error) {
	d.mu.Lock()
	draft := d.snap.Draft()
	if err := fn(draft); err != nil {
		rev := d.rev
		d.mu.Unlock()
		return rev, err
	}
	nextSnap, ops, err := draft.Commit()
	if err != nil {
		rev := d.rev
		d.mu.Unlock()
		return rev, err
	}
	if len(ops) == 0 && !d.retired {
		rev := d.rev
		d.mu.Unlock()
		return rev, nil
	}
	var zero T
	rev, subs, rawSubs := d.applyCommitLocked(zero, nextSnap, ops)
	d.mu.Unlock()

	d.broadcastSnapshotCommit(rev, nextSnap, ops, subs, rawSubs)
	return rev, nil
}

// Commit publishes a new value and optional explicit delta operations.
// If ops is omitted, a root replacement operation is recorded.
func (d *Document[T]) Commit(next T, ops ...delta.Op) (int64, error) {
	nextSnap, err := d.encode(next)
	if err != nil {
		return 0, err
	}
	safeVal, err := d.decode(nextSnap)
	if err != nil {
		return 0, err
	}
	var clonedOps []delta.Op
	if len(ops) == 0 {
		clonedOps = []delta.Op{delta.ReplaceRoot(nextSnap.Value())}
	} else {
		clonedOps = make([]delta.Op, len(ops))
		for i, op := range ops {
			c, err := op.Clone()
			if err != nil {
				return 0, fmt.Errorf("op %d: %w", i, err)
			}
			clonedOps[i] = c
		}
	}

	d.mu.Lock()
	rev, subs, rawSubs := d.applyCommitLocked(safeVal, nextSnap, clonedOps)
	d.mu.Unlock()

	d.broadcastCommit(rev, safeVal, nextSnap, clonedOps, subs, rawSubs)
	return rev, nil
}

// Retire marks the document as recycled while preserving its last value and notifying
// active watches with retired: true (and no ops) without disconnecting them.
func (d *Document[T]) Retire() int64 {
	d.mu.Lock()
	if d.retired {
		rev := d.rev
		d.mu.Unlock()
		return rev
	}
	d.retired = true
	rev := d.rev
	subs := make([]*WatchHandle[T], 0, len(d.subs))
	for _, h := range d.subs {
		subs = append(subs, h)
	}
	rawSubs := make([]*WatchHandle[*delta.Snapshot], 0, len(d.rawSubs))
	for _, h := range d.rawSubs {
		rawSubs = append(rawSubs, h)
	}
	d.mu.Unlock()

	for _, h := range subs {
		h.Retire(rev)
	}
	for _, h := range rawSubs {
		h.Retire(rev)
	}
	return rev
}

// Rebuild restores a retired or existing document with a fresh value and resumes
// active watches via root replacement without requiring re-subscription.
func (d *Document[T]) Rebuild(next T) (int64, error) {
	nextSnap, err := d.encode(next)
	if err != nil {
		return 0, err
	}
	safeVal, err := d.decode(nextSnap)
	if err != nil {
		return 0, err
	}
	rootOps := []delta.Op{delta.ReplaceRoot(nextSnap.Value())}

	d.mu.Lock()
	d.retired = false
	d.rev++
	d.val = safeVal
	d.snap = nextSnap
	d.appendRingLocked(d.rev, rootOps)
	rev := d.rev
	subs := make([]*WatchHandle[T], 0, len(d.subs))
	for _, h := range d.subs {
		subs = append(subs, h)
	}
	rawSubs := make([]*WatchHandle[*delta.Snapshot], 0, len(d.rawSubs))
	for _, h := range d.rawSubs {
		rawSubs = append(rawSubs, h)
	}
	d.mu.Unlock()

	for _, h := range subs {
		_ = h.Rebuild(rev, safeVal, nextSnap)
	}
	for _, h := range rawSubs {
		_ = h.Rebuild(rev, nextSnap, nextSnap)
	}
	return rev, nil
}

// Watch subscribes a single-flight WatchHandle[T] to this document.
func (d *Document[T]) Watch(ctx context.Context, fn func(context.Context, Event[T]), opts ...HandleOption) (*WatchHandle[T], error) {
	cfg := handleConfig{maxPendingOps: d.maxPendingOps}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	h := NewHandle(ctx, fn, WithMaxPendingOps(cfg.maxPendingOps))
	h.setDecodeSnap(d.decode)

	d.mu.Lock()
	d.nextSubID++
	subID := d.nextSubID
	d.subs[subID] = h
	rev, _, snap, ops, retired, hasInitial := d.catchupLocked(cfg.fromRev, cfg.maxPendingOps)
	d.mu.Unlock()

	h.setUnregister(func() {
		d.mu.Lock()
		delete(d.subs, subID)
		d.mu.Unlock()
	})

	if hasInitial {
		if retired {
			if decoded, err := d.decode(snap); err == nil {
				h.mu.Lock()
				h.latestVal = decoded
				h.mu.Unlock()
			}
			h.Retire(rev)
		} else {
			_ = h.pushSnapshot(rev, snap, ops...)
		}
	}
	return h, nil
}

// WatchRaw implements RawSource for transport bridges such as pkg/chord/link.
func (d *Document[T]) WatchRaw(ctx context.Context, fromRev int64, fn func(context.Context, RawEvent)) (RawHandle, error) {
	h := NewHandle[*delta.Snapshot](ctx, func(cbCtx context.Context, ev Event[*delta.Snapshot]) {
		if fn != nil {
			fn(cbCtx, RawEvent{
				Rev:      ev.Rev,
				Snapshot: ev.Value,
				Ops:      ev.Ops,
				Retired:  ev.Retired,
				Overflow: ev.Overflow,
			})
		}
	}, WithMaxPendingOps(d.maxPendingOps))

	d.mu.Lock()
	d.nextSubID++
	subID := d.nextSubID
	d.rawSubs[subID] = h
	rev, _, snap, ops, retired, hasInitial := d.catchupLocked(fromRev, d.maxPendingOps)
	d.mu.Unlock()

	h.setUnregister(func() {
		d.mu.Lock()
		delete(d.rawSubs, subID)
		d.mu.Unlock()
	})

	if hasInitial {
		if retired {
			h.Retire(rev)
		} else {
			_ = h.Push(rev, snap, snap, ops...)
		}
	}
	return h, nil
}

func (d *Document[T]) applyCommitLocked(val T, snap *delta.Snapshot, ops []delta.Op) (int64, []*WatchHandle[T], []*WatchHandle[*delta.Snapshot]) {
	d.retired = false
	d.rev++
	d.val = val
	d.snap = snap
	d.appendRingLocked(d.rev, ops)
	subs := make([]*WatchHandle[T], 0, len(d.subs))
	for _, h := range d.subs {
		subs = append(subs, h)
	}
	rawSubs := make([]*WatchHandle[*delta.Snapshot], 0, len(d.rawSubs))
	for _, h := range d.rawSubs {
		rawSubs = append(rawSubs, h)
	}
	return d.rev, subs, rawSubs
}

func (d *Document[T]) broadcastCommit(rev int64, val T, snap *delta.Snapshot, ops []delta.Op, subs []*WatchHandle[T], rawSubs []*WatchHandle[*delta.Snapshot]) {
	for _, h := range subs {
		_ = h.Push(rev, val, snap, ops...)
	}
	for _, h := range rawSubs {
		_ = h.Push(rev, snap, snap, ops...)
	}
}

func (d *Document[T]) broadcastSnapshotCommit(rev int64, snap *delta.Snapshot, ops []delta.Op, subs []*WatchHandle[T], rawSubs []*WatchHandle[*delta.Snapshot]) {
	for _, h := range subs {
		_ = h.pushSnapshot(rev, snap, ops...)
	}
	for _, h := range rawSubs {
		_ = h.Push(rev, snap, snap, ops...)
	}
}

func (d *Document[T]) appendRingLocked(rev int64, ops []delta.Op) {
	if d.historySize <= 0 {
		d.baseRev = rev
		return
	}
	if d.ringLen == len(d.ring) {
		evicted := d.ring[d.ringHead]
		d.baseRev = evicted.rev
		d.ringHead = (d.ringHead + 1) % len(d.ring)
		d.ringLen--
	}
	idx := (d.ringHead + d.ringLen) % len(d.ring)
	d.ring[idx] = revRecord{rev: rev, ops: ops}
	d.ringLen++
}

func (d *Document[T]) catchupLocked(fromRev int64, maxPending int) (rev int64, val T, snap *delta.Snapshot, ops []delta.Op, retired bool, hasInitial bool) {
	if d.retired {
		return d.rev, d.val, d.snap, nil, true, true
	}
	if fromRev == d.rev {
		return d.rev, d.val, d.snap, nil, false, false
	}
	if fromRev <= 0 || fromRev > d.rev || fromRev < d.baseRev || d.historySize <= 0 {
		return d.rev, d.val, d.snap, []delta.Op{delta.ReplaceRoot(d.snap.Value())}, false, true
	}

	q := delta.NewPendingOps(maxPending)
	for i := range d.ringLen {
		rec := d.ring[(d.ringHead+i)%len(d.ring)]
		if rec.rev > fromRev {
			_ = q.PushSnapshot(rec.ops, d.snap)
		}
	}
	coalesced, _ := q.Drain()
	if len(coalesced) == 0 {
		coalesced = []delta.Op{delta.ReplaceRoot(d.snap.Value())}
	}
	return d.rev, d.val, d.snap, coalesced, false, true
}

func defaultEncode[T any](v T) (*delta.Snapshot, error) {
	if snap, ok := any(v).(*delta.Snapshot); ok {
		if snap == nil {
			return delta.NewSnapshot(nil)
		}
		return snap, nil
	}
	if err := delta.ValidateValue(any(v)); err == nil {
		return delta.NewSnapshot(any(v))
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("watch: encode %T: %w", v, err)
	}
	val, err := delta.UnmarshalValue(raw)
	if err != nil {
		return nil, fmt.Errorf("watch: decode strict JSON for %T: %w", v, err)
	}
	return delta.NewSnapshot(val)
}

func defaultDecode[T any](snap *delta.Snapshot) (T, error) {
	var zero T
	switch any(zero).(type) {
	case *delta.Snapshot:
		return any(snap).(T), nil
	case any:
		// Check if T is literally interface{}/any vs concrete type.
		v := snap.Value()
		if typed, ok := v.(T); ok {
			return typed, nil
		}
	}
	raw, err := snap.MarshalJSON()
	if err != nil {
		return zero, err
	}
	var out T
	if err := json.Unmarshal(raw, &out); err != nil {
		return zero, fmt.Errorf("watch: decode %T: %w", out, err)
	}
	return out, nil
}

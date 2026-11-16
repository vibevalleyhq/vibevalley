package delta

import (
	"slices"
	"strconv"
	"strings"
)

// DefaultMaxPendingOps is the queue threshold above which PendingOps collapses
// all queued operations into a single root replacement [["r", latestRoot]].
const DefaultMaxPendingOps = 10_000

// PendingOps coalesces delta batches while a consumer or transport is busy.
type PendingOps struct {
	maxOps       int
	ops          []Op
	prefixCounts map[string]int
	overflow     bool
	latestRoot   any // *Snapshot or strict JSON value
}

// NewPendingOps creates a PendingOps queue. Non-positive maxOps defaults to 10,000.
func NewPendingOps(maxOps int) *PendingOps {
	if maxOps <= 0 {
		maxOps = DefaultMaxPendingOps
	}
	return &PendingOps{maxOps: maxOps}
}

// Len returns the number of currently queued operations (1 when overflowed).
func (p *PendingOps) Len() int {
	if p.overflow {
		return 1
	}
	return len(p.ops)
}

// Overflowed reports whether the queue exceeded maxOps and collapsed to a root replacement.
func (p *PendingOps) Overflowed() bool {
	return p.overflow
}

// Empty reports whether no pending operations or overflow snapshot are queued.
func (p *PendingOps) Empty() bool {
	return !p.overflow && len(p.ops) == 0
}

// Clear drops all queued operations and references to the latest snapshot.
func (p *PendingOps) Clear() {
	p.ops = nil
	p.prefixCounts = nil
	p.overflow = false
	p.latestRoot = nil
}

// PushSnapshot records ops committed to produce snap.
func (p *PendingOps) PushSnapshot(ops []Op, snap *Snapshot) error {
	return p.Push(ops, snap)
}

// Push appends ops with online coalescing and updates the fallback latestRoot
// (either a *Snapshot or a strict JSON value).
func (p *PendingOps) Push(ops []Op, latestRoot any) error {
	if snap, ok := latestRoot.(*Snapshot); ok {
		p.latestRoot = snap
	} else if latestRoot != nil || len(ops) > 0 {
		if err := ValidateValue(latestRoot); err != nil {
			return err
		}
		p.latestRoot = latestRoot
	}

	if p.overflow {
		// Once overflowed, retain only the latest root snapshot in O(1) memory.
		return nil
	}

	for _, rawOp := range ops {
		op, err := rawOp.Clone()
		if err != nil {
			return err
		}
		p.pushOne(op)
		if len(p.ops) > p.maxOps {
			p.ops = nil
			p.prefixCounts = nil
			p.overflow = true
			return nil
		}
	}
	return nil
}

func (p *PendingOps) pushOne(op Op) {
	switch op.Kind {
	case OpAppendText:
		if op.Suffix == "" {
			return
		}
		key := encodePathKey(op.Path)
		if p.prefixCounts[key] > 0 {
			for i := len(p.ops) - 1; i >= 0; i-- {
				prev := &p.ops[i]
				if slices.Equal(prev.Path, op.Path) {
					if prev.Kind == OpAppendText {
						// Rule 1: coalesce adjacent appends on the same path.
						prev.Suffix += op.Suffix
						return
					}
					if prev.Kind == OpReplace {
						if str, ok := prev.Value.(string); ok {
							// Rule 3: merge create+append in place.
							prev.Value = str + op.Suffix
							return
						}
					}
					break
				}
				if pathsOverlap(prev.Path, op.Path) {
					break
				}
			}
		}
		p.appendOp(op)

	case OpReplace, OpDelete:
		key := encodePathKey(op.Path)
		if p.prefixCounts[key] > 0 {
			// Rule 2: prune prior operations on path and any subpath path/*,
			// stopping before any intervening splice on a strict ancestor array.
			stopIdx := -1
			for i := len(p.ops) - 1; i >= 0; i-- {
				if p.ops[i].Kind == OpSpliceArray && hasStrictPathPrefix(op.Path, p.ops[i].Path) {
					stopIdx = i
					break
				}
			}
			write := stopIdx + 1
			for i := stopIdx + 1; i < len(p.ops); i++ {
				if hasPathPrefix(p.ops[i].Path, op.Path) {
					p.unindexPath(p.ops[i].Path)
					continue
				}
				p.ops[write] = p.ops[i]
				write++
			}
			clear(p.ops[write:])
			p.ops = p.ops[:write]
		}
		p.appendOp(op)

	case OpSpliceArray:
		p.appendOp(op)
	}
}

func (p *PendingOps) appendOp(op Op) {
	p.indexPath(op.Path)
	p.ops = append(p.ops, op)
}

func (p *PendingOps) indexPath(path []string) {
	if p.prefixCounts == nil {
		p.prefixCounts = make(map[string]int)
	}
	p.prefixCounts[""]++
	if len(path) == 0 {
		return
	}
	var b strings.Builder
	for _, seg := range path {
		b.WriteString(strconv.Itoa(len(seg)))
		b.WriteByte(':')
		b.WriteString(seg)
		p.prefixCounts[b.String()]++
	}
}

func (p *PendingOps) unindexPath(path []string) {
	if p.prefixCounts == nil {
		return
	}
	dec := func(key string) {
		n := p.prefixCounts[key] - 1
		if n <= 0 {
			delete(p.prefixCounts, key)
		} else {
			p.prefixCounts[key] = n
		}
	}
	dec("")
	if len(path) == 0 {
		return
	}
	var b strings.Builder
	for _, seg := range path {
		b.WriteString(strconv.Itoa(len(seg)))
		b.WriteByte(':')
		b.WriteString(seg)
		dec(b.String())
	}
}

func encodePathKey(path []string) string {
	if len(path) == 0 {
		return ""
	}
	var b strings.Builder
	for _, seg := range path {
		b.WriteString(strconv.Itoa(len(seg)))
		b.WriteByte(':')
		b.WriteString(seg)
	}
	return b.String()
}

// Drain returns the coalesced operations (or a single [["r", latestRoot]] if
// the queue overflowed) and resets the queue.
func (p *PendingOps) Drain() (ops []Op, overflowed bool) {
	if p.overflow {
		var rootVal any
		if snap, ok := p.latestRoot.(*Snapshot); ok {
			rootVal = snap.Value()
		} else {
			rootVal = cloneTrustedValue(p.latestRoot)
		}
		p.Clear()
		return []Op{ReplaceRoot(rootVal)}, true
	}
	if len(p.ops) == 0 {
		p.prefixCounts = nil
		p.latestRoot = nil
		return nil, false
	}
	ops = p.ops
	p.ops = nil
	p.prefixCounts = nil
	p.latestRoot = nil
	return ops, false
}

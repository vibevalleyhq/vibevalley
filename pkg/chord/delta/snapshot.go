package delta

import (
	"encoding/json"
	"fmt"
	"slices"
)

// Snapshot holds an immutable strict-JSON state tree.
type Snapshot struct {
	root   any
	hash   [32]byte
	sealed bool
}

// NewSnapshot validates and deep-clones root into an immutable Snapshot.
func NewSnapshot(root any) (*Snapshot, error) {
	cloned, err := CloneValue(root)
	if err != nil {
		return nil, err
	}
	return &Snapshot{root: cloned}, nil
}

// Seal computes and caches the canonical SHA-256 digest on s so subsequent
// Verify calls detect accidental out-of-band mutations.
func (s *Snapshot) Seal() *Snapshot {
	if s == nil {
		return nil
	}
	if !s.sealed {
		sum, err := HashValue(s.root)
		if err == nil {
			s.hash = sum
			s.sealed = true
		}
	}
	return s
}

// Verify checks s's canonical digest if s was sealed.
func (s *Snapshot) Verify() error {
	if s == nil || !s.sealed {
		return nil
	}
	sum, err := HashValue(s.root)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrIntegrity, err)
	}
	if sum != s.hash {
		return ErrIntegrity
	}
	return nil
}

// Hash returns the canonical SHA-256 digest of s's state tree.
func (s *Snapshot) Hash() ([32]byte, error) {
	if s == nil {
		return HashValue(nil)
	}
	if s.sealed {
		return s.hash, nil
	}
	return HashValue(s.root)
}

// Value returns a deep copy of s's root value so callers cannot mutate s.
func (s *Snapshot) Value() any {
	if s == nil {
		return nil
	}
	return cloneTrustedValue(s.root)
}

// Get looks up the value at path and returns a deep copy if found.
func (s *Snapshot) Get(path ...string) (any, bool) {
	if s == nil {
		return nil, false
	}
	cur := s.root
	for _, seg := range path {
		switch node := cur.(type) {
		case map[string]any:
			next, exists := node[seg]
			if !exists {
				return nil, false
			}
			cur = next
		case []any:
			idx, ok := parseArrayIndex(seg)
			if !ok || idx >= len(node) {
				return nil, false
			}
			cur = node[idx]
		default:
			return nil, false
		}
	}
	return cloneTrustedValue(cur), true
}

func (s *Snapshot) MarshalJSON() ([]byte, error) {
	if s == nil {
		return []byte("null"), nil
	}
	return json.Marshal(s.root)
}

// Draft opens a Copy-on-Write mutable draft backed by s.
func (s *Snapshot) Draft() *Draft {
	var root any
	if s != nil {
		root = s.root
	}
	return &Draft{
		base:  s,
		root:  root,
		owned: &cowNode{},
	}
}

// Apply returns a new immutable Snapshot obtained by applying ops sequentially onto s.
func (s *Snapshot) Apply(ops ...Op) (*Snapshot, error) {
	if len(ops) == 0 {
		if s == nil {
			return &Snapshot{}, nil
		}
		return s, nil
	}
	d := s.Draft()
	for i, op := range ops {
		if err := d.applyOp(op); err != nil {
			return nil, fmt.Errorf("op %d (%s): %w", i, op.Kind, err)
		}
	}
	next, _, err := d.Commit()
	return next, err
}

// Apply applies ops onto a strict JSON value root and returns a new independent value.
func Apply(root any, ops ...Op) (any, error) {
	snap, err := NewSnapshot(root)
	if err != nil {
		return nil, err
	}
	next, err := snap.Apply(ops...)
	if err != nil {
		return nil, err
	}
	return next.Value(), nil
}

type cowNode struct {
	cloned   bool
	children map[string]*cowNode
}

func (n *cowNode) child(seg string) *cowNode {
	if n.children == nil {
		n.children = make(map[string]*cowNode)
	}
	c, ok := n.children[seg]
	if !ok {
		c = &cowNode{}
		n.children[seg] = c
	}
	return c
}

// Draft records mutations using structural Copy-on-Write against a base Snapshot.
type Draft struct {
	base  *Snapshot
	root  any
	owned *cowNode
	ops   []Op
}

// Value returns a deep copy of the draft's current state.
func (d *Draft) Value() any {
	return cloneTrustedValue(d.root)
}

// Ops returns a cloned slice of operations recorded by this draft so far.
func (d *Draft) Ops() []Op {
	if len(d.ops) == 0 {
		return nil
	}
	out := make([]Op, len(d.ops))
	for i, op := range d.ops {
		out[i] = op.cloneTrusted()
	}
	return out
}

// ReplaceRoot replaces the entire document root with value.
func (d *Draft) ReplaceRoot(value any) error {
	return d.Set(nil, value)
}

// Set replaces or inserts value at path. An empty path replaces the root.
func (d *Draft) Set(path []string, value any) error {
	cloned, err := CloneValue(value)
	if err != nil {
		return err
	}
	if len(path) == 0 {
		d.root = cloned
		d.owned = &cowNode{cloned: true}
		d.ops = append(d.ops, ReplaceRoot(cloned))
		return nil
	}
	parent, parentNode, lastSeg, err := d.ensureParent(path)
	if err != nil {
		return err
	}
	switch container := parent.(type) {
	case map[string]any:
		container[lastSeg] = cloned
	case []any:
		idx, ok := parseArrayIndex(lastSeg)
		if !ok {
			return fmt.Errorf("%w: non-numeric array index %q", ErrInvalidPath, lastSeg)
		}
		if idx >= len(container) {
			return fmt.Errorf("%w: index %d >= len %d", ErrOutOfBounds, idx, len(container))
		}
		container[idx] = cloned
	default:
		return fmt.Errorf("%w: %T", ErrNotContainer, parent)
	}
	if parentNode.children != nil {
		delete(parentNode.children, lastSeg)
	}
	d.ops = append(d.ops, Op{
		Kind:  OpReplace,
		Path:  slices.Clone(path),
		Value: cloned,
	})
	return nil
}

// Delete removes the map field at path. Deleting an absent key on an existing map is a no-op.
func (d *Draft) Delete(path []string) error {
	if len(path) == 0 {
		return fmt.Errorf("%w: delete requires non-empty path", ErrInvalidPath)
	}
	// Check existence before cloning along path when key is already missing.
	parentVal, err := traverseRead(d.root, path[:len(path)-1])
	if err != nil {
		return err
	}
	m, ok := parentVal.(map[string]any)
	if !ok {
		return fmt.Errorf("%w: delete parent is %T, want map[string]any", ErrTypeMismatch, parentVal)
	}
	lastSeg := path[len(path)-1]
	if _, exists := m[lastSeg]; !exists {
		return nil
	}

	parent, parentNode, _, err := d.ensureParent(path)
	if err != nil {
		return err
	}
	ownedMap := parent.(map[string]any)
	delete(ownedMap, lastSeg)
	if parentNode.children != nil {
		delete(parentNode.children, lastSeg)
	}
	d.ops = append(d.ops, Op{
		Kind: OpDelete,
		Path: slices.Clone(path),
	})
	return nil
}

// AppendText appends suffix onto an existing string value at path.
func (d *Draft) AppendText(path []string, suffix string) error {
	if len(path) == 0 {
		str, ok := d.root.(string)
		if !ok {
			return fmt.Errorf("%w: append target is %T, want string", ErrTypeMismatch, d.root)
		}
		if suffix == "" {
			return nil
		}
		d.root = str + suffix
		d.ops = append(d.ops, Op{Kind: OpAppendText, Suffix: suffix})
		return nil
	}
	parentVal, err := traverseRead(d.root, path[:len(path)-1])
	if err != nil {
		return err
	}
	lastSeg := path[len(path)-1]
	curVal, err := readChild(parentVal, lastSeg)
	if err != nil {
		return err
	}
	str, ok := curVal.(string)
	if !ok {
		return fmt.Errorf("%w: append target is %T, want string", ErrTypeMismatch, curVal)
	}
	if suffix == "" {
		return nil
	}

	parent, parentNode, _, err := d.ensureParent(path)
	if err != nil {
		return err
	}
	nextStr := str + suffix
	switch container := parent.(type) {
	case map[string]any:
		container[lastSeg] = nextStr
	case []any:
		idx, _ := parseArrayIndex(lastSeg)
		container[idx] = nextStr
	}
	if parentNode.children != nil {
		delete(parentNode.children, lastSeg)
	}
	d.ops = append(d.ops, Op{
		Kind:   OpAppendText,
		Path:   slices.Clone(path),
		Suffix: suffix,
	})
	return nil
}

// SpliceArray deletes deleteCount items starting at index and inserts items into the array at path.
func (d *Draft) SpliceArray(path []string, index, deleteCount int, items ...any) error {
	if index < 0 {
		return fmt.Errorf("%w: negative index %d", ErrOutOfBounds, index)
	}
	if deleteCount < 0 {
		return fmt.Errorf("%w: negative deleteCount %d", ErrOutOfBounds, deleteCount)
	}
	var clonedItems []any
	if len(items) > 0 {
		clonedItems = make([]any, len(items))
		for i, item := range items {
			c, err := CloneValue(item)
			if err != nil {
				return fmt.Errorf("splice item %d: %w", i, err)
			}
			clonedItems[i] = c
		}
	}

	if len(path) == 0 {
		arr, ok := d.root.([]any)
		if !ok {
			return fmt.Errorf("%w: splice target is %T, want []any", ErrTypeMismatch, d.root)
		}
		if index > len(arr) {
			return fmt.Errorf("%w: index %d > len %d", ErrOutOfBounds, index, len(arr))
		}
		del := min(deleteCount, len(arr)-index)
		d.root = spliceSlice(arr, index, del, clonedItems)
		d.owned = &cowNode{cloned: true}
		d.ops = append(d.ops, Op{
			Kind:        OpSpliceArray,
			Index:       index,
			DeleteCount: del,
			Items:       clonedItems,
		})
		return nil
	}

	parentVal, err := traverseRead(d.root, path[:len(path)-1])
	if err != nil {
		return err
	}
	lastSeg := path[len(path)-1]
	targetVal, err := readChild(parentVal, lastSeg)
	if err != nil {
		return err
	}
	arr, ok := targetVal.([]any)
	if !ok {
		return fmt.Errorf("%w: splice target is %T, want []any", ErrTypeMismatch, targetVal)
	}
	if index > len(arr) {
		return fmt.Errorf("%w: index %d > len %d", ErrOutOfBounds, index, len(arr))
	}
	del := min(deleteCount, len(arr)-index)

	parent, parentNode, _, err := d.ensureParent(path)
	if err != nil {
		return err
	}
	nextArr := spliceSlice(arr, index, del, clonedItems)
	switch container := parent.(type) {
	case map[string]any:
		container[lastSeg] = nextArr
	case []any:
		idx, _ := parseArrayIndex(lastSeg)
		container[idx] = nextArr
	}
	// Reset child CoW tracking at path because splice shifts subsequent element indices.
	cNode := parentNode.child(lastSeg)
	cNode.cloned = true
	cNode.children = nil

	d.ops = append(d.ops, Op{
		Kind:        OpSpliceArray,
		Path:        slices.Clone(path),
		Index:       index,
		DeleteCount: del,
		Items:       clonedItems,
	})
	return nil
}

// Commit seals the current draft state into an immutable Snapshot and returns
// the recorded delta operations.
func (d *Draft) Commit() (*Snapshot, []Op, error) {
	if d.base != nil {
		if err := d.base.Verify(); err != nil {
			return nil, nil, err
		}
	}
	if len(d.ops) == 0 && d.base != nil {
		return d.base, nil, nil
	}
	next := &Snapshot{root: d.root}
	if d.base != nil && d.base.sealed {
		next.Seal()
	}
	ops := d.ops
	d.base = next
	d.owned = &cowNode{}
	d.ops = nil
	return next, ops, nil
}

func (d *Draft) applyOp(op Op) error {
	switch op.Kind {
	case OpReplace:
		return d.Set(op.Path, op.Value)
	case OpDelete:
		return d.Delete(op.Path)
	case OpAppendText:
		return d.AppendText(op.Path, op.Suffix)
	case OpSpliceArray:
		return d.SpliceArray(op.Path, op.Index, op.DeleteCount, op.Items...)
	default:
		return fmt.Errorf("%w: unknown kind %q", ErrInvalidOp, op.Kind)
	}
}

func (d *Draft) ensureParent(path []string) (parent any, parentNode *cowNode, lastSeg string, err error) {
	if !d.owned.cloned {
		cloned, ok := shallowCloneContainer(d.root)
		if !ok {
			return nil, nil, "", fmt.Errorf("%w: root is %T", ErrNotContainer, d.root)
		}
		d.root = cloned
		d.owned.cloned = true
	}

	cur := d.root
	node := d.owned
	for i := 0; i < len(path)-1; i++ {
		seg := path[i]
		childVal, err := readChild(cur, seg)
		if err != nil {
			return nil, nil, "", err
		}
		cNode := node.child(seg)
		if !cNode.cloned {
			cloned, ok := shallowCloneContainer(childVal)
			if !ok {
				return nil, nil, "", fmt.Errorf("%w: segment %q is %T", ErrNotContainer, seg, childVal)
			}
			writeChild(cur, seg, cloned)
			childVal = cloned
			cNode.cloned = true
		}
		cur = childVal
		node = cNode
	}

	switch cur.(type) {
	case map[string]any, []any:
		return cur, node, path[len(path)-1], nil
	default:
		return nil, nil, "", fmt.Errorf("%w: %T", ErrNotContainer, cur)
	}
}

func shallowCloneContainer(v any) (any, bool) {
	switch c := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(c))
		for k, val := range c {
			out[k] = val
		}
		return out, true
	case []any:
		// Allocate exact capacity so later writes never alias a shared slice tail.
		out := make([]any, len(c))
		copy(out, c)
		return out, true
	default:
		return nil, false
	}
}

func traverseRead(root any, path []string) (any, error) {
	cur := root
	for _, seg := range path {
		next, err := readChild(cur, seg)
		if err != nil {
			return nil, err
		}
		cur = next
	}
	return cur, nil
}

func readChild(container any, seg string) (any, error) {
	switch c := container.(type) {
	case map[string]any:
		val, exists := c[seg]
		if !exists {
			return nil, fmt.Errorf("%w: missing key %q", ErrInvalidPath, seg)
		}
		return val, nil
	case []any:
		idx, ok := parseArrayIndex(seg)
		if !ok {
			return nil, fmt.Errorf("%w: invalid array index %q", ErrInvalidPath, seg)
		}
		if idx >= len(c) {
			return nil, fmt.Errorf("%w: index %d >= len %d", ErrOutOfBounds, idx, len(c))
		}
		return c[idx], nil
	default:
		return nil, fmt.Errorf("%w: %T", ErrNotContainer, container)
	}
}

func writeChild(container any, seg string, val any) {
	switch c := container.(type) {
	case map[string]any:
		c[seg] = val
	case []any:
		idx, _ := parseArrayIndex(seg)
		c[idx] = val
	}
}

func spliceSlice(arr []any, index, del int, items []any) []any {
	out := make([]any, 0, len(arr)-del+len(items))
	out = append(out, arr[:index]...)
	out = append(out, items...)
	out = append(out, arr[index+del:]...)
	return out
}

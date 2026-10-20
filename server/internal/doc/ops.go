package doc

import (
	"cmp"
	"fmt"
	"slices"

	"vibevalley/internal/protocol"
)

// The op rules, over one document held in memory: Submit loads the page in a transaction, applies a batch's ops in order
// and writes back what changed. A stale update (BaseRev behind) is taken only when the block's text has not changed since
// BaseRev; otherwise it is a conflict and the block keeps what it has. Merging the two (three-way) is the next step.

var withText = map[string]bool{
	protocol.BlockParagraph: true, protocol.BlockHeading: true, protocol.BlockBulleted: true, protocol.BlockNumbered: true,
	protocol.BlockTodo: true, protocol.BlockQuote: true, protocol.BlockCode: true, protocol.BlockMemoryItem: true,
	protocol.BlockDivider: false, protocol.BlockImage: false, protocol.BlockIssueRef: false,
}

func knownType(t string) bool { _, ok := withText[t]; return ok }

type revision struct {
	block string
	rev   int64
	spans []protocol.DocSpan
	kind  string
}

type page struct {
	doc    string
	actor  string
	now    int64
	blocks map[string]*protocol.Block
	// The block's text at a rev, from its revisions; false when there is none.
	base func(block string, rev int64) ([]protocol.DocSpan, bool)
	// A block id another document has.
	taken func(id string) bool

	changed   []string
	revisions []revision
}

func newPage(doc, actor string, now int64, blocks []protocol.Block) *page {
	p := &page{doc: doc, actor: actor, now: now, blocks: map[string]*protocol.Block{},
		base:  func(string, int64) ([]protocol.DocSpan, bool) { return nil, false },
		taken: func(string) bool { return false },
	}
	for i := range blocks {
		b := blocks[i]
		p.blocks[b.ID] = &b
	}
	return p
}

// The changed blocks, in the order they were first changed.
func (p *page) changedBlocks() []protocol.Block {
	out := make([]protocol.Block, 0, len(p.changed))
	for _, id := range p.changed {
		out = append(out, *p.blocks[id])
	}
	return out
}

// touch marks a block changed by this op: one more rev, and its text at that rev kept.
func (p *page) touch(b *protocol.Block) {
	b.Rev++
	b.UpdatedBy, b.Updated = p.actor, p.now
	if !slices.Contains(p.changed, b.ID) {
		p.changed = append(p.changed, b.ID)
	}
	p.revisions = append(p.revisions, revision{block: b.ID, rev: b.Rev, spans: b.Text, kind: "normal"})
}

func applied(b *protocol.Block) protocol.DocOpResult {
	return protocol.DocOpResult{Status: protocol.DocOpStatusApplied, BlockID: b.ID, Rev: b.Rev}
}

func rejected(id, reason string) protocol.DocOpResult {
	return protocol.DocOpResult{Status: protocol.DocOpStatusRejected, BlockID: id, Reason: reason}
}

func gone(b *protocol.Block) protocol.DocOpResult {
	return protocol.DocOpResult{Status: protocol.DocOpStatusConflict, BlockID: b.ID, Rev: b.Rev, Reason: "这一块已经删掉了"}
}

func (p *page) find(id string) *protocol.Block { return p.blocks[id] }

// children of parent ("" is the top), tombstones included, in order.
func (p *page) children(parent string) []*protocol.Block {
	var out []*protocol.Block
	for _, b := range p.blocks {
		if parentOf(b) == parent {
			out = append(out, b)
		}
	}
	slices.SortFunc(out, func(a, b *protocol.Block) int {
		return cmp.Or(cmp.Compare(a.OrderKey, b.OrderKey), cmp.Compare(a.ID, b.ID))
	})
	return out
}

func parentOf(b *protocol.Block) string {
	if b.ParentID == nil {
		return ""
	}
	return *b.ParentID
}

// liveParent is where a block goes under parent: a deleted parent hands it to the level that parent was at.
func (p *page) liveParent(parent string) (*string, error) {
	for parent != "" {
		b := p.find(parent)
		if b == nil {
			return nil, fmt.Errorf("没有块 %s", parent)
		}
		if !b.Deleted {
			return &b.ID, nil
		}
		parent = parentOf(b)
	}
	return nil, nil
}

// fresh checks a block the client made, and fills in what the server decides.
func (p *page) fresh(b protocol.Block) (protocol.Block, string) {
	switch {
	case b.ID == "":
		return b, "新块没有 id"
	case p.find(b.ID) != nil || p.taken(b.ID):
		return b, "块 " + b.ID + " 已经有了"
	case !knownType(b.Type):
		return b, "不认识的块类型 " + b.Type
	case !validKey(b.OrderKey):
		return b, "不是有效的顺序键：" + b.OrderKey
	}
	parent, err := p.liveParent(ptrValue(b.ParentID))
	if err != nil {
		return b, err.Error()
	}
	b.ParentID, b.DocID, b.Rev, b.Deleted = parent, p.doc, 0, false
	b.Text = textFor(b.Type, b.Text)
	return b, ""
}

func textFor(typ string, spans []protocol.DocSpan) []protocol.DocSpan {
	switch {
	case !withText[typ]:
		return []protocol.DocSpan{}
	case typ == protocol.BlockCode:
		return unmarked(spans)
	}
	return normal(spans)
}

func ptrValue(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// unchangedSince: the block's text now is what it was at rev, so an edit made against rev loses nothing of anyone's.
func (p *page) unchangedSince(b *protocol.Block, rev int64) bool {
	if rev == b.Rev {
		return true
	}
	base, ok := p.base(b.ID, rev)
	return ok && sameText(base, b.Text)
}

func (p *page) apply(op protocol.DocOp) protocol.DocOpResult {
	switch o := op.Value.(type) {
	case protocol.DocOpInsertBlock:
		b, problem := p.fresh(o.Block)
		if problem != "" {
			return rejected(o.Block.ID, problem)
		}
		p.blocks[b.ID] = &b
		p.touch(&b)
		return applied(&b)
	case protocol.DocOpUpdateText:
		return p.updateText(o)
	case protocol.DocOpSetAttrs:
		b := p.find(o.BlockID)
		if b == nil {
			return rejected(o.BlockID, "没有这一块")
		}
		if b.Deleted {
			return gone(b)
		}
		attrs, err := patched(b.Attrs, o.Attrs, o.Unset)
		if err != nil {
			return rejected(b.ID, err.Error())
		}
		b.Attrs = attrs
		p.touch(b)
		return applied(b)
	case protocol.DocOpSetType:
		b := p.find(o.BlockID)
		switch {
		case b == nil:
			return rejected(o.BlockID, "没有这一块")
		case b.Deleted:
			return gone(b)
		case !knownType(o.Type):
			return rejected(b.ID, "不认识的块类型 "+o.Type)
		}
		b.Type, b.Attrs, b.Text = o.Type, o.Attrs, textFor(o.Type, b.Text)
		p.touch(b)
		return applied(b)
	case protocol.DocOpMoveBlock:
		return p.move(o)
	case protocol.DocOpDeleteBlock:
		b := p.find(o.BlockID)
		if b == nil {
			return rejected(o.BlockID, "没有这一块")
		}
		if b.Deleted {
			return protocol.DocOpResult{Status: protocol.DocOpStatusNoop, BlockID: b.ID, Rev: b.Rev}
		}
		p.setDeleted(b, true)
		return applied(b)
	case protocol.DocOpRestoreBlock:
		b := p.find(o.BlockID)
		if b == nil {
			return rejected(o.BlockID, "没有这一块")
		}
		if !b.Deleted {
			return protocol.DocOpResult{Status: protocol.DocOpStatusNoop, BlockID: b.ID, Rev: b.Rev}
		}
		parent, err := p.liveParent(parentOf(b))
		if err != nil {
			return rejected(b.ID, err.Error())
		}
		b.ParentID = parent
		p.setDeleted(b, false)
		return applied(b)
	case protocol.DocOpSplitBlock:
		return p.split(o)
	case protocol.DocOpMergeBlocks:
		return p.merge(o)
	}
	return rejected("", fmt.Sprintf("不认识的改动 %T", op.Value))
}

func (p *page) updateText(o protocol.DocOpUpdateText) protocol.DocOpResult {
	b := p.find(o.BlockID)
	switch {
	case b == nil:
		return rejected(o.BlockID, "没有这一块")
	case !withText[b.Type]:
		return rejected(b.ID, "这一块没有字")
	case o.BaseRev > b.Rev || o.BaseRev < 1:
		return rejected(b.ID, fmt.Sprintf("没有第 %d 版", o.BaseRev))
	}
	yours := textFor(b.Type, o.Text)
	if b.Deleted {
		p.lost(b, yours)
		return gone(b)
	}
	if !p.unchangedSince(b, o.BaseRev) {
		p.lost(b, yours)
		return protocol.DocOpResult{Status: protocol.DocOpStatusConflict, BlockID: b.ID, Rev: b.Rev, Yours: yours, Reason: "这一块刚被别人改过"}
	}
	if sameText(yours, b.Text) {
		return applied(b)
	}
	b.Text = yours
	p.touch(b)
	return applied(b)
}

// lost keeps a text that was not taken, at the rev it lost to.
func (p *page) lost(b *protocol.Block, yours []protocol.DocSpan) {
	p.revisions = append(p.revisions, revision{block: b.ID, rev: b.Rev, spans: yours, kind: "conflict"})
}

func (p *page) setDeleted(b *protocol.Block, deleted bool) {
	b.Deleted = deleted
	p.touch(b)
	for _, c := range p.children(b.ID) {
		if c.Deleted != deleted {
			p.setDeleted(c, deleted)
		}
	}
}

func (p *page) move(o protocol.DocOpMoveBlock) protocol.DocOpResult {
	b := p.find(o.BlockID)
	switch {
	case b == nil:
		return rejected(o.BlockID, "没有这一块")
	case b.Deleted:
		return gone(b)
	case !validKey(o.OrderKey):
		return rejected(b.ID, "不是有效的顺序键："+o.OrderKey)
	}
	parent, err := p.liveParent(ptrValue(o.ParentID))
	if err != nil {
		return rejected(b.ID, err.Error())
	}
	for at := ptrValue(parent); at != ""; at = parentOf(p.find(at)) {
		if at == b.ID {
			return rejected(b.ID, "不能挪到自己下面")
		}
	}
	b.ParentID, b.OrderKey = parent, o.OrderKey
	p.touch(b)
	return applied(b)
}

func (p *page) split(o protocol.DocOpSplitBlock) protocol.DocOpResult {
	b := p.find(o.BlockID)
	switch {
	case b == nil:
		return rejected(o.BlockID, "没有这一块")
	case !withText[b.Type]:
		return rejected(b.ID, "这一块没有字")
	case o.BaseRev > b.Rev || o.BaseRev < 1:
		return rejected(b.ID, fmt.Sprintf("没有第 %d 版", o.BaseRev))
	case b.Deleted:
		return gone(b)
	}
	nb, problem := p.fresh(o.NewBlock)
	if problem != "" {
		return rejected(b.ID, problem)
	}
	result := applied(b)
	at := int(o.Offset)
	if !p.unchangedSince(b, o.BaseRev) {
		// The offset was into a text that is no longer there: the block keeps all of its text and the new one starts empty.
		at = runeLen(b.Text)
		result = protocol.DocOpResult{Status: protocol.DocOpStatusConflict, Reason: "这一块刚被别人改过，从末尾拆开了"}
	} else if at < 0 || at > runeLen(b.Text) {
		return rejected(b.ID, fmt.Sprintf("拆分位置 %d 不在字里（%d 个字）", at, runeLen(b.Text)))
	}
	left, right := splitAt(b.Text, at)
	b.Text = left
	nb.Text = textFor(nb.Type, right)
	p.blocks[nb.ID] = &nb
	p.touch(b)
	p.touch(&nb)
	result.BlockID, result.Rev = b.ID, b.Rev
	return result
}

func (p *page) merge(o protocol.DocOpMergeBlocks) protocol.DocOpResult {
	target, source := p.find(o.TargetID), p.find(o.SourceID)
	switch {
	case target == nil:
		return rejected(o.TargetID, "没有这一块")
	case source == nil:
		return rejected(o.SourceID, "没有这一块")
	case target.ID == source.ID:
		return rejected(target.ID, "不能并进自己")
	case source.Deleted:
		return protocol.DocOpResult{Status: protocol.DocOpStatusNoop, BlockID: target.ID, Rev: target.Rev}
	case target.Deleted:
		return gone(target)
	case !withText[target.Type]:
		return rejected(target.ID, "这一块没有字")
	}
	// Both texts as they are now: there is nothing stale to conflict with.
	target.Text = textFor(target.Type, joined(target.Text, source.Text))
	last := ""
	if kids := p.children(target.ID); len(kids) > 0 {
		last = kids[len(kids)-1].OrderKey
	}
	for _, c := range p.children(source.ID) {
		key, err := keyBetween(last, "")
		if err != nil {
			return rejected(c.ID, err.Error())
		}
		c.ParentID, c.OrderKey, last = &target.ID, key, key
		p.touch(c)
	}
	p.touch(target)
	source.Deleted = true
	p.touch(source)
	return applied(target)
}

type attrField struct {
	name string
	set  func()
	del  func()
}

// patched lays a set_attrs patch over attrs: what the patch sets is written, the names in unset removed.
func patched(attrs, patch protocol.BlockAttrs, unset []string) (protocol.BlockAttrs, error) {
	fields := []attrField{
		{"level", func() { patchField(&attrs.Level, patch.Level) }, func() { attrs.Level = nil }},
		{"checked", func() { patchField(&attrs.Checked, patch.Checked) }, func() { attrs.Checked = nil }},
		{"language", func() { patchField(&attrs.Language, patch.Language) }, func() { attrs.Language = nil }},
		{"src", func() { patchField(&attrs.Src, patch.Src) }, func() { attrs.Src = nil }},
		{"width", func() { patchField(&attrs.Width, patch.Width) }, func() { attrs.Width = nil }},
		{"height", func() { patchField(&attrs.Height, patch.Height) }, func() { attrs.Height = nil }},
		{"alt", func() { patchField(&attrs.Alt, patch.Alt) }, func() { attrs.Alt = nil }},
		{"issueId", func() { patchField(&attrs.IssueID, patch.IssueID) }, func() { attrs.IssueID = nil }},
		{"memoryId", func() { patchField(&attrs.MemoryID, patch.MemoryID) }, func() { attrs.MemoryID = nil }},
	}
	for _, f := range fields {
		f.set()
	}
	for _, name := range unset {
		i := slices.IndexFunc(fields, func(f attrField) bool { return f.name == name })
		if i < 0 {
			return attrs, fmt.Errorf("没有属性 %s", name)
		}
		fields[i].del()
	}
	return attrs, nil
}

func patchField[T any](to **T, v *T) {
	if v != nil {
		c := *v
		*to = &c
	}
}

// ordered is the live blocks in document order: each block, then its children.
func ordered(blocks []protocol.Block) []protocol.Block {
	p := newPage("", "", 0, blocks)
	var out []protocol.Block
	var walk func(parent string)
	walk = func(parent string) {
		for _, b := range p.children(parent) {
			if b.Deleted {
				continue
			}
			out = append(out, *b)
			walk(b.ID)
		}
	}
	walk("")
	// A live block under a missing parent still shows, at the end.
	for _, b := range blocks {
		if !b.Deleted && b.ParentID != nil && p.find(*b.ParentID) == nil {
			out = append(out, b)
		}
	}
	return out
}

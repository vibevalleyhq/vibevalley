package artifact

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

// UserActor identifies the human workbench owner whose authored blocks are protected from silent agent overwrites.
const UserActor = "user"

// BlockType enumerates supported block types in a collaborative block document.
type BlockType string

const (
	BlockParagraph  BlockType = "paragraph"
	BlockHeading    BlockType = "heading"
	BlockBulleted   BlockType = "bulleted"
	BlockNumbered   BlockType = "numbered"
	BlockTodo       BlockType = "todo"
	BlockQuote      BlockType = "quote"
	BlockCode       BlockType = "code"
	BlockDivider    BlockType = "divider"
	BlockImage      BlockType = "image"
	BlockIssueRef   BlockType = "issue_ref"
	BlockMemoryItem BlockType = "memory_item"
)

var blockTypeSupportsText = map[BlockType]bool{
	BlockParagraph:  true,
	BlockHeading:    true,
	BlockBulleted:   true,
	BlockNumbered:   true,
	BlockTodo:       true,
	BlockQuote:      true,
	BlockCode:       true,
	BlockMemoryItem: true,
	BlockDivider:    false,
	BlockImage:      false,
	BlockIssueRef:   false,
}

func isKnownBlockType(t BlockType) bool {
	_, ok := blockTypeSupportsText[t]
	return ok
}

// SpanMarks describes inline rich-text formatting on a TextSpan.
type SpanMarks struct {
	Bold   bool   `json:"bold,omitempty"`
	Italic bool   `json:"italic,omitempty"`
	Code   bool   `json:"code,omitempty"`
	Strike bool   `json:"strike,omitempty"`
	Link   string `json:"link,omitempty"`
}

func (m SpanMarks) key() string {
	b := func(v bool) byte {
		if v {
			return '1'
		}
		return '0'
	}
	return string([]byte{b(m.Bold), b(m.Italic), b(m.Code), b(m.Strike)}) + "|" + m.Link
}

// TextSpan represents a contiguous slice of text with uniform inline marks.
type TextSpan struct {
	Text  string    `json:"t"`
	Marks SpanMarks `json:"marks"`
}

// NormalizeSpans drops empty spans and merges adjacent spans with identical marks.
func NormalizeSpans(spans []TextSpan) []TextSpan {
	if len(spans) == 0 {
		return nil
	}
	out := make([]TextSpan, 0, len(spans))
	for _, s := range spans {
		if s.Text == "" {
			continue
		}
		if n := len(out); n > 0 && out[n-1].Marks.key() == s.Marks.key() {
			out[n-1].Text += s.Text
			continue
		}
		out = append(out, s)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// PlainText concatenates the text of all spans without marks.
func PlainText(spans []TextSpan) string {
	if len(spans) == 0 {
		return ""
	}
	var sb strings.Builder
	for _, s := range spans {
		sb.WriteString(s.Text)
	}
	return sb.String()
}

// RuneLen returns the total Unicode code-point length across spans.
func RuneLen(spans []TextSpan) int {
	total := 0
	for _, s := range spans {
		total += len([]rune(s.Text))
	}
	return total
}

// SameText compares normalized spans for structural equality.
func SameText(a, b []TextSpan) bool {
	na := NormalizeSpans(a)
	nb := NormalizeSpans(b)
	if len(na) != len(nb) {
		return false
	}
	for i := range na {
		if na[i].Text != nb[i].Text || na[i].Marks.key() != nb[i].Marks.key() {
			return false
		}
	}
	return true
}

// SplitSpansAt cuts spans at code-point offset at (0 <= at <= RuneLen(spans)).
func SplitSpansAt(spans []TextSpan, at int) ([]TextSpan, []TextSpan) {
	var left, right []TextSpan
	rem := at
	for _, s := range spans {
		runes := []rune(s.Text)
		switch {
		case rem <= 0:
			right = append(right, s)
		case rem >= len(runes):
			left = append(left, s)
		default:
			left = append(left, TextSpan{Text: string(runes[:rem]), Marks: s.Marks})
			right = append(right, TextSpan{Text: string(runes[rem:]), Marks: s.Marks})
		}
		rem -= len(runes)
	}
	return NormalizeSpans(left), NormalizeSpans(right)
}

// TextForType canonicalizes spans for blockType (stripping marks for code, clearing for non-text blocks).
func TextForType(blockType BlockType, spans []TextSpan) []TextSpan {
	if !blockTypeSupportsText[blockType] {
		return nil
	}
	if blockType == BlockCode {
		plain := PlainText(spans)
		if plain == "" {
			return nil
		}
		return []TextSpan{{Text: plain}}
	}
	return NormalizeSpans(spans)
}

// BlockAttrs stores type-specific attributes for a block.
type BlockAttrs struct {
	Level    *int   `json:"level,omitempty"`
	Checked  *bool  `json:"checked,omitempty"`
	Language string `json:"language,omitempty"`
	Src      string `json:"src,omitempty"`
	Width    *int   `json:"width,omitempty"`
	Height   *int   `json:"height,omitempty"`
	Alt      string `json:"alt,omitempty"`
	IssueID  string `json:"issueId,omitempty"`
	MemoryID string `json:"memoryId,omitempty"`
}

func cloneAttrs(a BlockAttrs) BlockAttrs {
	out := a
	if a.Level != nil {
		v := *a.Level
		out.Level = &v
	}
	if a.Checked != nil {
		v := *a.Checked
		out.Checked = &v
	}
	if a.Width != nil {
		v := *a.Width
		out.Width = &v
	}
	if a.Height != nil {
		v := *a.Height
		out.Height = &v
	}
	return out
}

func patchAttrs(cur, patch BlockAttrs, unset []string) (BlockAttrs, error) {
	out := cloneAttrs(cur)
	if patch.Level != nil {
		v := *patch.Level
		out.Level = &v
	}
	if patch.Checked != nil {
		v := *patch.Checked
		out.Checked = &v
	}
	if patch.Language != "" {
		out.Language = patch.Language
	}
	if patch.Src != "" {
		out.Src = patch.Src
	}
	if patch.Width != nil {
		v := *patch.Width
		out.Width = &v
	}
	if patch.Height != nil {
		v := *patch.Height
		out.Height = &v
	}
	if patch.Alt != "" {
		out.Alt = patch.Alt
	}
	if patch.IssueID != "" {
		out.IssueID = patch.IssueID
	}
	if patch.MemoryID != "" {
		out.MemoryID = patch.MemoryID
	}
	for _, name := range unset {
		switch name {
		case "level":
			out.Level = nil
		case "checked":
			out.Checked = nil
		case "language":
			out.Language = ""
		case "src":
			out.Src = ""
		case "width":
			out.Width = nil
		case "height":
			out.Height = nil
		case "alt":
			out.Alt = ""
		case "issueId":
			out.IssueID = ""
		case "memoryId":
			out.MemoryID = ""
		default:
			return BlockAttrs{}, fmt.Errorf("%w: unknown attr %q", ErrInvalidBlockOp, name)
		}
	}
	return out, nil
}

// BlockInput specifies initial fields when inserting or splitting a block.
type BlockInput struct {
	ID       string     `json:"id"`
	ParentID string     `json:"parentId,omitempty"`
	OrderKey string     `json:"orderKey"`
	Type     BlockType  `json:"type"`
	Attrs    BlockAttrs `json:"attrs"`
	Text     []TextSpan `json:"text"`
}

// Block represents a persistent block node in a collaborative block document.
type Block struct {
	ID          string     `json:"id"`
	ArtifactID  string     `json:"artifactId"`
	ParentID    string     `json:"parentId,omitempty"`
	OrderKey    string     `json:"orderKey"`
	Type        BlockType  `json:"type"`
	Attrs       BlockAttrs `json:"attrs"`
	Text        []TextSpan `json:"text"`
	Rev         int64      `json:"rev"`
	Deleted     bool       `json:"deleted,omitempty"`
	UpdatedBy   string     `json:"updatedBy"`
	UpdatedAtMs int64      `json:"updatedAtMs"`
}

func cloneBlock(b Block) Block {
	out := b
	out.Attrs = cloneAttrs(b.Attrs)
	out.Text = slices.Clone(b.Text)
	return out
}

// BlockOpKind identifies an operation applied to a Page state machine.
type BlockOpKind string

const (
	OpInsertBlock  BlockOpKind = "insert_block"
	OpUpdateText   BlockOpKind = "update_text"
	OpSetAttrs     BlockOpKind = "set_attrs"
	OpSetType      BlockOpKind = "set_type"
	OpMoveBlock    BlockOpKind = "move_block"
	OpDeleteBlock  BlockOpKind = "delete_block"
	OpRestoreBlock BlockOpKind = "restore_block"
	OpSplitBlock   BlockOpKind = "split_block"
	OpMergeBlocks  BlockOpKind = "merge_blocks"
)

// BlockOp is a tagged block mutation command processed by Page.Apply.
type BlockOp struct {
	Op       BlockOpKind `json:"op"`
	Block    *BlockInput `json:"block,omitempty"`
	BlockID  string      `json:"blockId,omitempty"`
	BaseRev  int64       `json:"baseRev,omitempty"`
	Text     []TextSpan  `json:"text,omitempty"`
	Attrs    BlockAttrs  `json:"attrs,omitempty"`
	Unset    []string    `json:"unset,omitempty"`
	Type     BlockType   `json:"type,omitempty"`
	ParentID string      `json:"parentId,omitempty"`
	OrderKey string      `json:"orderKey,omitempty"`
	Offset   int         `json:"offset,omitempty"`
	NewBlock *BlockInput `json:"newBlock,omitempty"`
	TargetID string      `json:"targetId,omitempty"`
	SourceID string      `json:"sourceId,omitempty"`
}

// BlockOpStatus classifies the outcome of applying a single BlockOp.
type BlockOpStatus string

const (
	OpApplied  BlockOpStatus = "applied"
	OpConflict BlockOpStatus = "conflict"
	OpNoop     BlockOpStatus = "noop"
	OpRejected BlockOpStatus = "rejected"
)

// BlockOpResult reports the per-operation status, resulting revision, and optional suggestion diversion.
type BlockOpResult struct {
	Status       BlockOpStatus `json:"status"`
	BlockID      string        `json:"blockId"`
	Rev          int64         `json:"rev,omitempty"`
	Yours        []TextSpan    `json:"yours,omitempty"`
	Reason       string        `json:"reason,omitempty"`
	SuggestionID string        `json:"suggestion,omitempty"`
}

// BlockRevision records a historical or conflicted block text snapshot.
type BlockRevision struct {
	BlockID string     `json:"blockId"`
	Rev     int64      `json:"rev"`
	Spans   []TextSpan `json:"spans"`
	Kind    string     `json:"kind"` // "normal" or "conflict"
}

// Page is the deterministic block-document state machine handling ops, conflicts, and tree ordering.
type Page struct {
	ArtifactID string
	Actor      string
	NowMs      int64

	blocks    map[string]*Block
	changed   []string
	revisions []BlockRevision

	BaseLookup  func(blockID string, rev int64) ([]TextSpan, bool)
	TakenLookup func(blockID string) bool
}

// NewPage constructs a Page initialized with blocks for a single transactional batch.
func NewPage(artifactID, actor string, nowMs int64, blocks []Block) *Page {
	p := &Page{
		ArtifactID: artifactID,
		Actor:      actor,
		NowMs:      nowMs,
		blocks:     make(map[string]*Block, len(blocks)),
	}
	for _, b := range blocks {
		cp := cloneBlock(b)
		p.blocks[cp.ID] = &cp
	}
	return p
}

// Find returns a defensive copy of block id if present (including tombstones).
func (p *Page) Find(id string) (Block, bool) {
	b, ok := p.blocks[id]
	if !ok {
		return Block{}, false
	}
	return cloneBlock(*b), true
}

// Children returns all blocks (including tombstones) with ParentID == parent sorted by (OrderKey, ID).
func (p *Page) Children(parent string) []Block {
	var out []Block
	for _, b := range p.blocks {
		if b.ParentID == parent {
			out = append(out, cloneBlock(*b))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].OrderKey != out[j].OrderKey {
			return out[i].OrderKey < out[j].OrderKey
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// ChangedBlocks returns blocks touched during this Page batch in mutation order.
func (p *Page) ChangedBlocks() []Block {
	out := make([]Block, 0, len(p.changed))
	for _, id := range p.changed {
		if b, ok := p.blocks[id]; ok {
			out = append(out, cloneBlock(*b))
		}
	}
	return out
}

// Revisions returns all normal and conflict revisions emitted during this Page batch.
func (p *Page) Revisions() []BlockRevision {
	return slices.Clone(p.revisions)
}

// AllBlocks returns every block including tombstones sorted deterministically by ID.
func (p *Page) AllBlocks() []Block {
	out := make([]Block, 0, len(p.blocks))
	for _, b := range p.blocks {
		out = append(out, cloneBlock(*b))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Ordered returns all non-deleted blocks in depth-first document presentation order.
func (p *Page) Ordered() []Block {
	out := make([]Block, 0, len(p.blocks))
	var walk func(parent string)
	walk = func(parent string) {
		for _, b := range p.Children(parent) {
			if b.Deleted {
				continue
			}
			out = append(out, b)
			walk(b.ID)
		}
	}
	walk("")

	// Include orphaned live blocks whose parent was not found to avoid silent data loss.
	all := p.AllBlocks()
	for _, b := range all {
		if !b.Deleted && b.ParentID != "" {
			if _, ok := p.blocks[b.ParentID]; !ok {
				out = append(out, b)
			}
		}
	}
	return out
}

func (p *Page) touch(b *Block) {
	b.Rev++
	b.UpdatedBy = p.Actor
	b.UpdatedAtMs = p.NowMs
	if !slices.Contains(p.changed, b.ID) {
		p.changed = append(p.changed, b.ID)
	}
	p.revisions = append(p.revisions, BlockRevision{
		BlockID: b.ID,
		Rev:     b.Rev,
		Spans:   slices.Clone(b.Text),
		Kind:    "normal",
	})
}

func (p *Page) liveParent(parent string) (string, error) {
	cur := parent
	for cur != "" {
		b, ok := p.blocks[cur]
		if !ok {
			return "", fmt.Errorf("missing parent block %q", cur)
		}
		if !b.Deleted {
			return b.ID, nil
		}
		cur = b.ParentID
	}
	return "", nil
}

func (p *Page) freshBlock(in *BlockInput) (*Block, string) {
	if in == nil || strings.TrimSpace(in.ID) == "" {
		return nil, "block id is required"
	}
	if _, exists := p.blocks[in.ID]; exists || (p.TakenLookup != nil && p.TakenLookup(in.ID)) {
		return nil, fmt.Sprintf("block id %q already exists", in.ID)
	}
	if !isKnownBlockType(in.Type) {
		return nil, fmt.Sprintf("unknown block type %q", in.Type)
	}
	if !ValidOrderKey(in.OrderKey) {
		return nil, fmt.Sprintf("invalid orderKey %q", in.OrderKey)
	}
	parent, err := p.liveParent(in.ParentID)
	if err != nil {
		return nil, err.Error()
	}
	return &Block{
		ID:         in.ID,
		ArtifactID: p.ArtifactID,
		ParentID:   parent,
		OrderKey:   in.OrderKey,
		Type:       in.Type,
		Attrs:      cloneAttrs(in.Attrs),
		Text:       TextForType(in.Type, in.Text),
	}, ""
}

func (p *Page) unchangedSince(b *Block, baseRev int64) bool {
	if baseRev == b.Rev {
		return true
	}
	for i := len(p.revisions) - 1; i >= 0; i-- {
		r := p.revisions[i]
		if r.BlockID == b.ID && r.Rev == baseRev && r.Kind == "normal" {
			return SameText(r.Spans, b.Text)
		}
	}
	if p.BaseLookup != nil {
		if base, ok := p.BaseLookup(b.ID, baseRev); ok {
			return SameText(base, b.Text)
		}
	}
	return false
}

// Apply executes one BlockOp against the Page state machine.
func (p *Page) Apply(op BlockOp) BlockOpResult {
	switch op.Op {
	case OpInsertBlock:
		b, reason := p.freshBlock(op.Block)
		if reason != "" {
			id := ""
			if op.Block != nil {
				id = op.Block.ID
			}
			return BlockOpResult{Status: OpRejected, BlockID: id, Reason: reason}
		}
		p.blocks[b.ID] = b
		p.touch(b)
		return BlockOpResult{Status: OpApplied, BlockID: b.ID, Rev: b.Rev}

	case OpUpdateText:
		return p.applyUpdateText(op)

	case OpSetAttrs:
		b, ok := p.blocks[op.BlockID]
		if !ok {
			return BlockOpResult{Status: OpRejected, BlockID: op.BlockID, Reason: "block missing"}
		}
		if b.Deleted {
			return BlockOpResult{Status: OpConflict, BlockID: b.ID, Rev: b.Rev, Reason: "block deleted"}
		}
		next, err := patchAttrs(b.Attrs, op.Attrs, op.Unset)
		if err != nil {
			return BlockOpResult{Status: OpRejected, BlockID: b.ID, Reason: err.Error()}
		}
		b.Attrs = next
		p.touch(b)
		return BlockOpResult{Status: OpApplied, BlockID: b.ID, Rev: b.Rev}

	case OpSetType:
		b, ok := p.blocks[op.BlockID]
		if !ok {
			return BlockOpResult{Status: OpRejected, BlockID: op.BlockID, Reason: "block missing"}
		}
		if b.Deleted {
			return BlockOpResult{Status: OpConflict, BlockID: b.ID, Rev: b.Rev, Reason: "block deleted"}
		}
		if !isKnownBlockType(op.Type) {
			return BlockOpResult{Status: OpRejected, BlockID: b.ID, Reason: fmt.Sprintf("unknown block type %q", op.Type)}
		}
		b.Type = op.Type
		b.Attrs = cloneAttrs(op.Attrs)
		b.Text = TextForType(op.Type, b.Text)
		p.touch(b)
		return BlockOpResult{Status: OpApplied, BlockID: b.ID, Rev: b.Rev}

	case OpMoveBlock:
		return p.applyMove(op)

	case OpDeleteBlock:
		b, ok := p.blocks[op.BlockID]
		if !ok {
			return BlockOpResult{Status: OpRejected, BlockID: op.BlockID, Reason: "block missing"}
		}
		if b.Deleted {
			return BlockOpResult{Status: OpNoop, BlockID: b.ID, Rev: b.Rev}
		}
		p.setDeleted(b, true)
		return BlockOpResult{Status: OpApplied, BlockID: b.ID, Rev: b.Rev}

	case OpRestoreBlock:
		b, ok := p.blocks[op.BlockID]
		if !ok {
			return BlockOpResult{Status: OpRejected, BlockID: op.BlockID, Reason: "block missing"}
		}
		if !b.Deleted {
			return BlockOpResult{Status: OpNoop, BlockID: b.ID, Rev: b.Rev}
		}
		parent, err := p.liveParent(b.ParentID)
		if err != nil {
			return BlockOpResult{Status: OpRejected, BlockID: b.ID, Reason: err.Error()}
		}
		b.ParentID = parent
		p.setDeleted(b, false)
		return BlockOpResult{Status: OpApplied, BlockID: b.ID, Rev: b.Rev}

	case OpSplitBlock:
		return p.applySplit(op)

	case OpMergeBlocks:
		return p.applyMerge(op)

	default:
		return BlockOpResult{Status: OpRejected, BlockID: op.BlockID, Reason: fmt.Sprintf("unknown block op %q", op.Op)}
	}
}

func (p *Page) applyUpdateText(op BlockOp) BlockOpResult {
	b, ok := p.blocks[op.BlockID]
	if !ok {
		return BlockOpResult{Status: OpRejected, BlockID: op.BlockID, Reason: "block missing"}
	}
	if !blockTypeSupportsText[b.Type] {
		return BlockOpResult{Status: OpRejected, BlockID: b.ID, Reason: "block type has no text"}
	}
	if op.BaseRev < 1 || op.BaseRev > b.Rev {
		return BlockOpResult{Status: OpRejected, BlockID: b.ID, Reason: fmt.Sprintf("invalid baseRev %d (current %d)", op.BaseRev, b.Rev)}
	}
	yours := TextForType(b.Type, op.Text)
	if b.Deleted {
		p.revisions = append(p.revisions, BlockRevision{BlockID: b.ID, Rev: b.Rev, Spans: yours, Kind: "conflict"})
		return BlockOpResult{Status: OpConflict, BlockID: b.ID, Rev: b.Rev, Yours: yours, Reason: "block deleted"}
	}
	if !p.unchangedSince(b, op.BaseRev) {
		p.revisions = append(p.revisions, BlockRevision{BlockID: b.ID, Rev: b.Rev, Spans: yours, Kind: "conflict"})
		return BlockOpResult{Status: OpConflict, BlockID: b.ID, Rev: b.Rev, Yours: yours, Reason: "text changed concurrently"}
	}
	if SameText(yours, b.Text) {
		return BlockOpResult{Status: OpApplied, BlockID: b.ID, Rev: b.Rev}
	}
	b.Text = yours
	p.touch(b)
	return BlockOpResult{Status: OpApplied, BlockID: b.ID, Rev: b.Rev}
}

func (p *Page) setDeleted(b *Block, deleted bool) {
	b.Deleted = deleted
	p.touch(b)
	for _, c := range p.Children(b.ID) {
		child := p.blocks[c.ID]
		if child != nil && child.Deleted != deleted {
			p.setDeleted(child, deleted)
		}
	}
}

func (p *Page) applyMove(op BlockOp) BlockOpResult {
	b, ok := p.blocks[op.BlockID]
	if !ok {
		return BlockOpResult{Status: OpRejected, BlockID: op.BlockID, Reason: "block missing"}
	}
	if b.Deleted {
		return BlockOpResult{Status: OpConflict, BlockID: b.ID, Rev: b.Rev, Reason: "block deleted"}
	}
	if !ValidOrderKey(op.OrderKey) {
		return BlockOpResult{Status: OpRejected, BlockID: b.ID, Reason: fmt.Sprintf("invalid orderKey %q", op.OrderKey)}
	}
	parent, err := p.liveParent(op.ParentID)
	if err != nil {
		return BlockOpResult{Status: OpRejected, BlockID: b.ID, Reason: err.Error()}
	}
	for at := parent; at != ""; {
		if at == b.ID {
			return BlockOpResult{Status: OpRejected, BlockID: b.ID, Reason: "cannot move block under itself"}
		}
		up, ok := p.blocks[at]
		if !ok {
			break
		}
		at = up.ParentID
	}
	b.ParentID = parent
	b.OrderKey = op.OrderKey
	p.touch(b)
	return BlockOpResult{Status: OpApplied, BlockID: b.ID, Rev: b.Rev}
}

func (p *Page) applySplit(op BlockOp) BlockOpResult {
	b, ok := p.blocks[op.BlockID]
	if !ok {
		return BlockOpResult{Status: OpRejected, BlockID: op.BlockID, Reason: "block missing"}
	}
	if !blockTypeSupportsText[b.Type] {
		return BlockOpResult{Status: OpRejected, BlockID: b.ID, Reason: "block type has no text"}
	}
	if op.BaseRev < 1 || op.BaseRev > b.Rev {
		return BlockOpResult{Status: OpRejected, BlockID: b.ID, Reason: fmt.Sprintf("invalid baseRev %d", op.BaseRev)}
	}
	if b.Deleted {
		return BlockOpResult{Status: OpConflict, BlockID: b.ID, Rev: b.Rev, Reason: "block deleted"}
	}
	nb, reason := p.freshBlock(op.NewBlock)
	if reason != "" {
		return BlockOpResult{Status: OpRejected, BlockID: b.ID, Reason: reason}
	}

	status := OpApplied
	var splitReason string
	at := op.Offset
	textLen := RuneLen(b.Text)
	if !p.unchangedSince(b, op.BaseRev) {
		at = textLen
		status = OpConflict
		splitReason = "text changed concurrently; split at end"
	} else if at < 0 || at > textLen {
		return BlockOpResult{Status: OpRejected, BlockID: b.ID, Reason: fmt.Sprintf("split offset %d outside [0,%d]", at, textLen)}
	}

	left, right := SplitSpansAt(b.Text, at)
	b.Text = left
	nb.Text = TextForType(nb.Type, right)
	p.blocks[nb.ID] = nb
	p.touch(b)
	p.touch(nb)
	return BlockOpResult{Status: status, BlockID: b.ID, Rev: b.Rev, Reason: splitReason}
}

func (p *Page) applyMerge(op BlockOp) BlockOpResult {
	target, ok := p.blocks[op.TargetID]
	if !ok {
		return BlockOpResult{Status: OpRejected, BlockID: op.TargetID, Reason: "target block missing"}
	}
	source, ok := p.blocks[op.SourceID]
	if !ok {
		return BlockOpResult{Status: OpRejected, BlockID: op.SourceID, Reason: "source block missing"}
	}
	if target.ID == source.ID {
		return BlockOpResult{Status: OpRejected, BlockID: target.ID, Reason: "cannot merge block into itself"}
	}
	if source.Deleted {
		return BlockOpResult{Status: OpNoop, BlockID: target.ID, Rev: target.Rev}
	}
	if target.Deleted {
		return BlockOpResult{Status: OpConflict, BlockID: target.ID, Rev: target.Rev, Reason: "target block deleted"}
	}
	if !blockTypeSupportsText[target.Type] {
		return BlockOpResult{Status: OpRejected, BlockID: target.ID, Reason: "target block type has no text"}
	}

	joined := make([]TextSpan, 0, len(target.Text)+len(source.Text))
	joined = append(joined, target.Text...)
	joined = append(joined, source.Text...)
	target.Text = TextForType(target.Type, joined)

	children := p.Children(target.ID)
	lastKey := ""
	if len(children) > 0 {
		lastKey = children[len(children)-1].OrderKey
	}
	for _, c := range p.Children(source.ID) {
		key, err := KeyBetween(lastKey, "")
		if err != nil {
			return BlockOpResult{Status: OpRejected, BlockID: c.ID, Reason: err.Error()}
		}
		child := p.blocks[c.ID]
		child.ParentID = target.ID
		child.OrderKey = key
		lastKey = key
		p.touch(child)
	}
	p.touch(target)
	source.Deleted = true
	p.touch(source)
	return BlockOpResult{Status: OpApplied, BlockID: target.ID, Rev: target.Rev}
}

// SuggestionStatus tracks resolution of an agent rewrite proposal on a user-authored block.
type SuggestionStatus string

const (
	SuggestionOpen     SuggestionStatus = "open"
	SuggestionAccepted SuggestionStatus = "accepted"
	SuggestionRejected SuggestionStatus = "rejected"
)

// SuggestionChange specifies the proposed block edit or deletion.
type SuggestionChange struct {
	Text   []TextSpan  `json:"text,omitempty"`
	Type   *BlockType  `json:"type,omitempty"`
	Attrs  *BlockAttrs `json:"attrs,omitempty"`
	Unset  []string    `json:"unset,omitempty"`
	Delete bool        `json:"delete,omitempty"`
}

// Suggestion records an agent proposal awaiting explicit user acceptance or rejection.
type Suggestion struct {
	ID           string           `json:"id"`
	ArtifactID   string           `json:"artifactId"`
	BlockID      string           `json:"blockId"`
	Author       string           `json:"author"`
	BaseRev      int64            `json:"baseRev"`
	Change       SuggestionChange `json:"change"`
	Status       SuggestionStatus `json:"status"`
	CreatedAtMs  int64            `json:"createdAtMs"`
	ResolvedAtMs int64            `json:"resolvedAtMs,omitempty"`
	ResolvedBy   string           `json:"resolvedBy,omitempty"`
}

// SuggestionCreate specifies input to create a block rewrite suggestion.
type SuggestionCreate struct {
	BlockID string           `json:"blockId"`
	BaseRev int64            `json:"baseRev"`
	Change  SuggestionChange `json:"change"`
}

// BlockAck reports the committed sequence, per-op results, touched blocks, and CAS snapshot digests.
type BlockAck struct {
	BatchID       string          `json:"batchId"`
	Seq           int64           `json:"seq"`
	Results       []BlockOpResult `json:"results"`
	Blocks        []Block         `json:"blocks"`
	ContentSHA256 string          `json:"contentSha256"`
	StateSHA256   string          `json:"stateSha256"`
	Deduplicated  bool            `json:"deduplicated"`
}

// PageSnapshot captures the full state of a block document at a committed sequence number.
type PageSnapshot struct {
	ArtifactID    string       `json:"artifactId"`
	Title         string       `json:"title"`
	Seq           int64        `json:"seq"`
	Blocks        []Block      `json:"blocks"`
	Ordered       []Block      `json:"ordered"`
	Suggestions   []Suggestion `json:"suggestions"`
	ContentSHA256 string       `json:"contentSha256"`
	StateSHA256   string       `json:"stateSha256"`
	UpdatedAtMs   int64        `json:"updatedAtMs"`
}

// SubmitOptions controls user-block protection when submitting batches.
type SubmitOptions struct {
	// ProtectUserBlocks diverts agent updates/deletes against blocks with UpdatedBy == UserActor
	// into open Suggestions rather than mutating the user's block directly.
	ProtectUserBlocks bool
}

type blockDocRecord struct {
	mu          sync.Mutex
	artifactID  string
	title       string
	seq         int64
	updatedAtMs int64
	blocks      map[string]Block
	revisions   map[string]map[int64][]TextSpan
	batches     map[string]BlockAck
	suggestions map[string]Suggestion
	suggOrder   []string
	contentSHA  string
	stateSHA    string
}

// PageStoreConfig configures a concurrent block-document PageStore.
type PageStoreConfig struct {
	CAS *ContentStore
	Dir string
	Now func() int64
}

// PageStore manages concurrent block-document state machines with CAS snapshots and atomic suggestions.
type PageStore struct {
	cas *ContentStore
	dir string
	now func() int64

	mu   sync.RWMutex
	docs map[string]*blockDocRecord
}

// NewPageStore constructs a PageStore backed by cfg.CAS (creating an in-memory CAS if nil).
func NewPageStore(cfg PageStoreConfig) (*PageStore, error) {
	cas := cfg.CAS
	if cas == nil {
		if cfg.Dir != "" {
			var err error
			cas, err = NewDirCAS(cfg.Dir)
			if err != nil {
				return nil, err
			}
		} else {
			cas = NewMemoryCAS()
		}
	}
	now := cfg.Now
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	ps := &PageStore{
		cas:  cas,
		dir:  strings.TrimSpace(cfg.Dir),
		now:  now,
		docs: make(map[string]*blockDocRecord),
	}
	if ps.dir != "" {
		if err := ps.loadFromDisk(); err != nil {
			return nil, err
		}
	}
	return ps, nil
}

// CreateDocument initializes a new block document and stores its empty canonical snapshot in CAS.
func (s *PageStore) CreateDocument(_ context.Context, artifactID, title string) (PageSnapshot, error) {
	id := strings.TrimSpace(artifactID)
	if id == "" {
		return PageSnapshot{}, fmt.Errorf("%w: empty artifact id", ErrInvalidBlockOp)
	}
	if strings.TrimSpace(title) == "" {
		title = "Untitled"
	}

	s.mu.Lock()
	if _, exists := s.docs[id]; exists {
		s.mu.Unlock()
		return PageSnapshot{}, fmt.Errorf("%w: document %q already exists", ErrConflict, id)
	}
	rec := &blockDocRecord{
		artifactID:  id,
		title:       title,
		updatedAtMs: s.now(),
		blocks:      make(map[string]Block),
		revisions:   make(map[string]map[int64][]TextSpan),
		batches:     make(map[string]BlockAck),
		suggestions: make(map[string]Suggestion),
	}
	contentSHA, stateSHA, err := s.persistSnapshotLocked(rec)
	if err != nil {
		s.mu.Unlock()
		return PageSnapshot{}, err
	}
	rec.contentSHA = contentSHA
	rec.stateSHA = stateSHA
	if err := s.saveDocMetadata(rec); err != nil {
		s.mu.Unlock()
		return PageSnapshot{}, err
	}
	s.docs[id] = rec
	s.mu.Unlock()

	return s.snapshotOf(rec), nil
}

// SubmitBatch atomically applies ops under the document's single-writer lock with batchId idempotency.
func (s *PageStore) SubmitBatch(ctx context.Context, artifactID, actor, batchID string, ops []BlockOp) (BlockAck, error) {
	return s.SubmitBatchWithOptions(ctx, artifactID, actor, batchID, ops, SubmitOptions{})
}

// SubmitBatchWithOptions applies ops atomically with optional user-block protection into Suggestions.
func (s *PageStore) SubmitBatchWithOptions(_ context.Context, artifactID, actor, batchID string, ops []BlockOp, opts SubmitOptions) (BlockAck, error) {
	if strings.TrimSpace(batchID) == "" {
		return BlockAck{}, fmt.Errorf("%w: empty batchId", ErrInvalidBlockOp)
	}
	if strings.TrimSpace(actor) == "" {
		return BlockAck{}, fmt.Errorf("%w: empty actor", ErrInvalidBlockOp)
	}
	rec, err := s.getDoc(artifactID)
	if err != nil {
		return BlockAck{}, err
	}

	rec.mu.Lock()
	defer rec.mu.Unlock()

	if prev, seen := rec.batches[batchID]; seen {
		cp := prev
		cp.Deduplicated = true
		cp.Results = slices.Clone(prev.Results)
		cp.Blocks = cloneBlocks(prev.Blocks)
		return cp, nil
	}

	nowMs := s.now()
	allBlocks := mapValues(rec.blocks)
	page := NewPage(rec.artifactID, actor, nowMs, allBlocks)
	page.BaseLookup = func(blockID string, rev int64) ([]TextSpan, bool) {
		byRev, ok := rec.revisions[blockID]
		if !ok {
			return nil, false
		}
		spans, ok := byRev[rev]
		return slices.Clone(spans), ok
	}
	page.TakenLookup = func(blockID string) bool {
		// Also block ID collisions across all documents in this PageStore.
		return s.isBlockIDTakenElsewhere(rec.artifactID, blockID)
	}

	// Stage new suggestions in case ProtectUserBlocks diverts an agent op; commit only at the end.
	var pendingSuggestions []Suggestion
	results := make([]BlockOpResult, 0, len(ops))

	for _, op := range ops {
		if opts.ProtectUserBlocks && actor != UserActor {
			if diverted, ok := s.maybeDivertProtectedOp(rec, page, actor, nowMs, op); ok {
				if diverted.sugg != nil {
					pendingSuggestions = append(pendingSuggestions, *diverted.sugg)
				}
				results = append(results, diverted.res)
				continue
			}
		}
		results = append(results, page.Apply(op))
	}

	changed := page.ChangedBlocks()
	nextBlocks := cloneBlockMap(rec.blocks)
	for _, b := range changed {
		nextBlocks[b.ID] = b
	}
	nextRevs := cloneRevisionMap(rec.revisions)
	for _, r := range page.Revisions() {
		if r.Kind != "normal" {
			continue
		}
		byRev := nextRevs[r.BlockID]
		if byRev == nil {
			byRev = make(map[int64][]TextSpan)
			nextRevs[r.BlockID] = byRev
		}
		byRev[r.Rev] = slices.Clone(r.Spans)
	}

	nextSuggestions := make(map[string]Suggestion, len(rec.suggestions)+len(pendingSuggestions))
	for k, v := range rec.suggestions {
		nextSuggestions[k] = v
	}
	nextSuggOrder := slices.Clone(rec.suggOrder)
	for _, sg := range pendingSuggestions {
		nextSuggestions[sg.ID] = sg
		nextSuggOrder = append(nextSuggOrder, sg.ID)
	}

	candidate := &blockDocRecord{
		artifactID:  rec.artifactID,
		title:       rec.title,
		seq:         rec.seq + 1,
		updatedAtMs: nowMs,
		blocks:      nextBlocks,
		revisions:   nextRevs,
		batches:     rec.batches,
		suggestions: nextSuggestions,
		suggOrder:   nextSuggOrder,
	}

	contentSHA, stateSHA, err := s.persistSnapshotLocked(candidate)
	if err != nil {
		return BlockAck{}, err
	}

	ack := BlockAck{
		BatchID:       batchID,
		Seq:           candidate.seq,
		Results:       results,
		Blocks:        changed,
		ContentSHA256: contentSHA,
		StateSHA256:   stateSHA,
	}

	candidate.contentSHA = contentSHA
	candidate.stateSHA = stateSHA
	candidateBatches := make(map[string]BlockAck, len(rec.batches)+1)
	for k, v := range rec.batches {
		candidateBatches[k] = v
	}
	candidateBatches[batchID] = ack
	candidate.batches = candidateBatches

	if err := s.saveDocMetadata(candidate); err != nil {
		return BlockAck{}, err
	}

	rec.seq = candidate.seq
	rec.updatedAtMs = nowMs
	rec.blocks = nextBlocks
	rec.revisions = nextRevs
	rec.suggestions = nextSuggestions
	rec.suggOrder = nextSuggOrder
	rec.contentSHA = contentSHA
	rec.stateSHA = stateSHA
	rec.batches[batchID] = ack

	return ack, nil
}

type divertedResult struct {
	res  BlockOpResult
	sugg *Suggestion
}

func (s *PageStore) maybeDivertProtectedOp(rec *blockDocRecord, page *Page, actor string, nowMs int64, op BlockOp) (divertedResult, bool) {
	if op.Op != OpUpdateText && op.Op != OpDeleteBlock && op.Op != OpSetAttrs && op.Op != OpSetType {
		return divertedResult{}, false
	}
	blk, ok := page.Find(op.BlockID)
	if !ok || blk.Deleted || blk.UpdatedBy != UserActor {
		return divertedResult{}, false
	}

	var change SuggestionChange
	baseRev := blk.Rev
	switch op.Op {
	case OpDeleteBlock:
		change = SuggestionChange{Delete: true}
	case OpUpdateText:
		baseRev = op.BaseRev
		if baseRev < 1 || baseRev > blk.Rev {
			return divertedResult{
				res: BlockOpResult{Status: OpRejected, BlockID: blk.ID, Reason: fmt.Sprintf("invalid baseRev %d (current %d)", op.BaseRev, blk.Rev)},
			}, true
		}
		change = SuggestionChange{Text: TextForType(blk.Type, op.Text)}
	case OpSetAttrs:
		attrs := cloneAttrs(op.Attrs)
		change = SuggestionChange{Attrs: &attrs, Unset: slices.Clone(op.Unset)}
	case OpSetType:
		tp := op.Type
		attrs := cloneAttrs(op.Attrs)
		change = SuggestionChange{Type: &tp, Attrs: &attrs}
	}

	sugg := Suggestion{
		ID:          newHexID("sugg"),
		ArtifactID:  rec.artifactID,
		BlockID:     blk.ID,
		Author:      actor,
		BaseRev:     baseRev,
		Change:      change,
		Status:      SuggestionOpen,
		CreatedAtMs: nowMs,
	}
	return divertedResult{
		sugg: &sugg,
		res: BlockOpResult{
			Status:       OpRejected,
			BlockID:      blk.ID,
			Rev:          blk.Rev,
			Reason:       "block authored by user; diverted to suggestion",
			SuggestionID: sugg.ID,
		},
	}, true
}

// Suggest explicitly creates an agent Suggestion targeting a specific block revision.
func (s *PageStore) Suggest(_ context.Context, artifactID, actor string, req SuggestionCreate) (Suggestion, error) {
	if strings.TrimSpace(actor) == "" {
		return Suggestion{}, fmt.Errorf("%w: empty actor", ErrInvalidBlockOp)
	}
	if err := validateSuggestionChange(req.Change); err != nil {
		return Suggestion{}, err
	}

	rec, err := s.getDoc(artifactID)
	if err != nil {
		return Suggestion{}, err
	}

	rec.mu.Lock()
	defer rec.mu.Unlock()

	blk, ok := rec.blocks[req.BlockID]
	if !ok || blk.Deleted {
		return Suggestion{}, fmt.Errorf("%w: block %q missing or deleted", ErrNotFound, req.BlockID)
	}
	if req.BaseRev < 1 || req.BaseRev > blk.Rev {
		return Suggestion{}, fmt.Errorf("%w: baseRev %d out of range [1,%d]", ErrStaleSuggestion, req.BaseRev, blk.Rev)
	}

	nowMs := s.now()
	sugg := Suggestion{
		ID:          newHexID("sugg"),
		ArtifactID:  rec.artifactID,
		BlockID:     blk.ID,
		Author:      actor,
		BaseRev:     req.BaseRev,
		Change:      cloneSuggestionChange(req.Change),
		Status:      SuggestionOpen,
		CreatedAtMs: nowMs,
	}

	rec.suggestions[sugg.ID] = sugg
	rec.suggOrder = append(rec.suggOrder, sugg.ID)
	rec.updatedAtMs = nowMs

	contentSHA, stateSHA, err := s.persistSnapshotLocked(rec)
	if err != nil {
		delete(rec.suggestions, sugg.ID)
		rec.suggOrder = rec.suggOrder[:len(rec.suggOrder)-1]
		return Suggestion{}, err
	}
	rec.contentSHA = contentSHA
	rec.stateSHA = stateSHA

	if err := s.saveDocMetadata(rec); err != nil {
		return Suggestion{}, err
	}
	return sugg, nil
}

// AcceptSuggestion atomically applies an open suggestion iff the target block is still at BaseRev.
func (s *PageStore) AcceptSuggestion(_ context.Context, artifactID, suggestionID, actor string) (Suggestion, BlockAck, error) {
	if strings.TrimSpace(actor) == "" {
		actor = UserActor
	}
	rec, err := s.getDoc(artifactID)
	if err != nil {
		return Suggestion{}, BlockAck{}, err
	}

	rec.mu.Lock()
	defer rec.mu.Unlock()

	sugg, ok := rec.suggestions[suggestionID]
	if !ok || sugg.ArtifactID != artifactID {
		return Suggestion{}, BlockAck{}, fmt.Errorf("%w: %s", ErrSuggestionNotFound, suggestionID)
	}
	if sugg.Status == SuggestionAccepted {
		ack := rec.batches["suggestion:"+suggestionID]
		ack.Deduplicated = true
		return sugg, ack, nil
	}
	if sugg.Status == SuggestionRejected {
		return sugg, BlockAck{}, fmt.Errorf("%w: suggestion %s already rejected", ErrSuggestionConflict, suggestionID)
	}

	blk, ok := rec.blocks[sugg.BlockID]
	if !ok || blk.Deleted {
		return sugg, BlockAck{}, fmt.Errorf("%w: target block %q missing or deleted", ErrStaleSuggestion, sugg.BlockID)
	}
	if blk.Rev != sugg.BaseRev {
		return sugg, BlockAck{}, fmt.Errorf("%w: suggestion baseRev=%d != block rev=%d", ErrStaleSuggestion, sugg.BaseRev, blk.Rev)
	}

	var ops []BlockOp
	if sugg.Change.Delete {
		ops = append(ops, BlockOp{Op: OpDeleteBlock, BlockID: blk.ID})
	} else {
		if sugg.Change.Type != nil {
			var attrs BlockAttrs
			if sugg.Change.Attrs != nil {
				attrs = cloneAttrs(*sugg.Change.Attrs)
			}
			ops = append(ops, BlockOp{Op: OpSetType, BlockID: blk.ID, Type: *sugg.Change.Type, Attrs: attrs})
		} else if sugg.Change.Attrs != nil || len(sugg.Change.Unset) > 0 {
			var attrs BlockAttrs
			if sugg.Change.Attrs != nil {
				attrs = cloneAttrs(*sugg.Change.Attrs)
			}
			ops = append(ops, BlockOp{Op: OpSetAttrs, BlockID: blk.ID, Attrs: attrs, Unset: slices.Clone(sugg.Change.Unset)})
		}
		if sugg.Change.Text != nil {
			ops = append(ops, BlockOp{Op: OpUpdateText, BlockID: blk.ID, BaseRev: sugg.BaseRev, Text: slices.Clone(sugg.Change.Text)})
		}
	}

	nowMs := s.now()
	page := NewPage(rec.artifactID, actor, nowMs, mapValues(rec.blocks))
	page.BaseLookup = func(blockID string, rev int64) ([]TextSpan, bool) {
		byRev, ok := rec.revisions[blockID]
		if !ok {
			return nil, false
		}
		spans, ok := byRev[rev]
		return slices.Clone(spans), ok
	}

	results := make([]BlockOpResult, 0, len(ops))
	for _, op := range ops {
		r := page.Apply(op)
		results = append(results, r)
		if r.Status != OpApplied && r.Status != OpNoop {
			return sugg, BlockAck{}, fmt.Errorf("%w: %s", ErrConflict, r.Reason)
		}
	}

	changed := page.ChangedBlocks()
	nextBlocks := cloneBlockMap(rec.blocks)
	for _, b := range changed {
		nextBlocks[b.ID] = b
	}
	nextRevs := cloneRevisionMap(rec.revisions)
	for _, r := range page.Revisions() {
		if r.Kind != "normal" {
			continue
		}
		byRev := nextRevs[r.BlockID]
		if byRev == nil {
			byRev = make(map[int64][]TextSpan)
			nextRevs[r.BlockID] = byRev
		}
		byRev[r.Rev] = slices.Clone(r.Spans)
	}

	resolved := sugg
	resolved.Status = SuggestionAccepted
	resolved.ResolvedAtMs = nowMs
	resolved.ResolvedBy = actor

	nextSuggestions := make(map[string]Suggestion, len(rec.suggestions))
	for k, v := range rec.suggestions {
		nextSuggestions[k] = v
	}
	nextSuggestions[resolved.ID] = resolved

	candidate := &blockDocRecord{
		artifactID:  rec.artifactID,
		title:       rec.title,
		seq:         rec.seq + 1,
		updatedAtMs: nowMs,
		blocks:      nextBlocks,
		revisions:   nextRevs,
		batches:     rec.batches,
		suggestions: nextSuggestions,
		suggOrder:   rec.suggOrder,
	}

	contentSHA, stateSHA, err := s.persistSnapshotLocked(candidate)
	if err != nil {
		return sugg, BlockAck{}, err
	}

	batchID := "suggestion:" + suggestionID
	ack := BlockAck{
		BatchID:       batchID,
		Seq:           candidate.seq,
		Results:       results,
		Blocks:        changed,
		ContentSHA256: contentSHA,
		StateSHA256:   stateSHA,
	}

	rec.seq = candidate.seq
	rec.updatedAtMs = nowMs
	rec.blocks = nextBlocks
	rec.revisions = nextRevs
	rec.suggestions = nextSuggestions
	rec.contentSHA = contentSHA
	rec.stateSHA = stateSHA
	rec.batches[batchID] = ack

	if err := s.saveDocMetadata(rec); err != nil {
		return Suggestion{}, BlockAck{}, err
	}
	return resolved, ack, nil
}

// RejectSuggestion atomically marks an open suggestion rejected without mutating blocks.
func (s *PageStore) RejectSuggestion(_ context.Context, artifactID, suggestionID, actor string) (Suggestion, error) {
	if strings.TrimSpace(actor) == "" {
		actor = UserActor
	}
	rec, err := s.getDoc(artifactID)
	if err != nil {
		return Suggestion{}, err
	}

	rec.mu.Lock()
	defer rec.mu.Unlock()

	sugg, ok := rec.suggestions[suggestionID]
	if !ok || sugg.ArtifactID != artifactID {
		return Suggestion{}, fmt.Errorf("%w: %s", ErrSuggestionNotFound, suggestionID)
	}
	if sugg.Status == SuggestionRejected {
		return sugg, nil
	}
	if sugg.Status == SuggestionAccepted {
		return sugg, fmt.Errorf("%w: suggestion %s already accepted", ErrSuggestionConflict, suggestionID)
	}

	nowMs := s.now()
	resolved := sugg
	resolved.Status = SuggestionRejected
	resolved.ResolvedAtMs = nowMs
	resolved.ResolvedBy = actor

	nextSuggestions := make(map[string]Suggestion, len(rec.suggestions))
	for k, v := range rec.suggestions {
		nextSuggestions[k] = v
	}
	nextSuggestions[resolved.ID] = resolved

	candidate := &blockDocRecord{
		artifactID:  rec.artifactID,
		title:       rec.title,
		seq:         rec.seq,
		updatedAtMs: nowMs,
		blocks:      rec.blocks,
		revisions:   rec.revisions,
		batches:     rec.batches,
		suggestions: nextSuggestions,
		suggOrder:   rec.suggOrder,
	}
	contentSHA, stateSHA, err := s.persistSnapshotLocked(candidate)
	if err != nil {
		return sugg, err
	}

	rec.updatedAtMs = nowMs
	rec.suggestions = nextSuggestions
	rec.contentSHA = contentSHA
	rec.stateSHA = stateSHA

	if err := s.saveDocMetadata(rec); err != nil {
		return Suggestion{}, err
	}
	return resolved, nil
}

// Snapshot returns the current consistent snapshot of artifactID.
func (s *PageStore) Snapshot(_ context.Context, artifactID string) (PageSnapshot, error) {
	rec, err := s.getDoc(artifactID)
	if err != nil {
		return PageSnapshot{}, err
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return s.snapshotOf(rec), nil
}

// SnapshotBySHA256 retrieves a committed PageSnapshot directly from the SHA-256 content store.
func (s *PageStore) SnapshotBySHA256(_ context.Context, digest string) (PageSnapshot, error) {
	raw, err := s.cas.Get(digest)
	if err != nil {
		return PageSnapshot{}, err
	}
	var snap PageSnapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		return PageSnapshot{}, fmt.Errorf("%w: invalid page snapshot payload: %v", ErrCorruptedBlob, err)
	}
	return snap, nil
}

func (s *PageStore) getDoc(artifactID string) (*blockDocRecord, error) {
	s.mu.RLock()
	rec, ok := s.docs[artifactID]
	s.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("%w: block document %q", ErrNotFound, artifactID)
	}
	return rec, nil
}

func (s *PageStore) isBlockIDTakenElsewhere(currentArtifactID, blockID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for id, rec := range s.docs {
		if id == currentArtifactID {
			continue
		}
		rec.mu.Lock()
		_, exists := rec.blocks[blockID]
		rec.mu.Unlock()
		if exists {
			return true
		}
	}
	return false
}

func (s *PageStore) snapshotOf(rec *blockDocRecord) PageSnapshot {
	page := NewPage(rec.artifactID, "", 0, mapValues(rec.blocks))
	suggs := make([]Suggestion, 0, len(rec.suggOrder))
	for _, id := range rec.suggOrder {
		if sg, ok := rec.suggestions[id]; ok {
			suggs = append(suggs, sg)
		}
	}
	return PageSnapshot{
		ArtifactID:    rec.artifactID,
		Title:         rec.title,
		Seq:           rec.seq,
		Blocks:        page.AllBlocks(),
		Ordered:       page.Ordered(),
		Suggestions:   suggs,
		ContentSHA256: rec.contentSHA,
		StateSHA256:   rec.stateSHA,
		UpdatedAtMs:   rec.updatedAtMs,
	}
}

func (s *PageStore) persistSnapshotLocked(rec *blockDocRecord) (contentSHA string, stateSHA string, err error) {
	page := NewPage(rec.artifactID, "", 0, mapValues(rec.blocks))
	ordered := page.Ordered()

	// Canonical content payload excludes volatile timestamps and seq so identical document states deduplicate.
	type canonicalBlock struct {
		ID       string     `json:"id"`
		ParentID string     `json:"parentId,omitempty"`
		OrderKey string     `json:"orderKey"`
		Type     BlockType  `json:"type"`
		Attrs    BlockAttrs `json:"attrs"`
		Text     []TextSpan `json:"text"`
	}
	cBlocks := make([]canonicalBlock, 0, len(ordered))
	for _, b := range ordered {
		cBlocks = append(cBlocks, canonicalBlock{
			ID:       b.ID,
			ParentID: b.ParentID,
			OrderKey: b.OrderKey,
			Type:     b.Type,
			Attrs:    b.Attrs,
			Text:     b.Text,
		})
	}
	contentBytes, err := json.Marshal(cBlocks)
	if err != nil {
		return "", "", err
	}
	contentRef, err := s.cas.Put(contentBytes)
	if err != nil {
		return "", "", err
	}

	suggs := make([]Suggestion, 0, len(rec.suggOrder))
	for _, id := range rec.suggOrder {
		if sg, ok := rec.suggestions[id]; ok {
			suggs = append(suggs, sg)
		}
	}
	snap := PageSnapshot{
		ArtifactID:    rec.artifactID,
		Title:         rec.title,
		Seq:           rec.seq,
		Blocks:        page.AllBlocks(),
		Ordered:       ordered,
		Suggestions:   suggs,
		ContentSHA256: contentRef.SHA256,
		UpdatedAtMs:   rec.updatedAtMs,
	}
	stateBytes, err := json.Marshal(snap)
	if err != nil {
		return "", "", err
	}
	stateRef, err := s.cas.Put(stateBytes)
	if err != nil {
		return "", "", err
	}
	return contentRef.SHA256, stateRef.SHA256, nil
}

type persistedPageDoc struct {
	ArtifactID    string                          `json:"artifactId"`
	Title         string                          `json:"title"`
	Seq           int64                           `json:"seq"`
	UpdatedAtMs   int64                           `json:"updatedAtMs"`
	Blocks        []Block                         `json:"blocks"`
	Revisions     map[string]map[int64][]TextSpan `json:"revisions,omitempty"`
	Batches       map[string]BlockAck             `json:"batches,omitempty"`
	Suggestions   []Suggestion                    `json:"suggestions,omitempty"`
	ContentSHA256 string                          `json:"contentSha256"`
	StateSHA256   string                          `json:"stateSha256"`
}

func (s *PageStore) saveDocMetadata(rec *blockDocRecord) error {
	if s.dir == "" {
		return nil
	}
	suggs := make([]Suggestion, 0, len(rec.suggOrder))
	for _, id := range rec.suggOrder {
		if sg, ok := rec.suggestions[id]; ok {
			suggs = append(suggs, sg)
		}
	}
	payload := persistedPageDoc{
		ArtifactID:    rec.artifactID,
		Title:         rec.title,
		Seq:           rec.seq,
		UpdatedAtMs:   rec.updatedAtMs,
		Blocks:        mapValues(rec.blocks),
		Revisions:     rec.revisions,
		Batches:       rec.batches,
		Suggestions:   suggs,
		ContentSHA256: rec.contentSHA,
		StateSHA256:   rec.stateSHA,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	safeName := hex.EncodeToString([]byte(rec.artifactID))
	target := filepath.Join(s.dir, "pages", safeName+".json")
	return writeFileAtomic(target, raw, 0o644)
}

func (s *PageStore) loadFromDisk() error {
	pagesDir := filepath.Join(s.dir, "pages")
	entries, err := os.ReadDir(pagesDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read pages dir: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") || strings.HasPrefix(entry.Name(), ".tmp-") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(pagesDir, entry.Name()))
		if err != nil {
			return err
		}
		var pd persistedPageDoc
		if err := json.Unmarshal(raw, &pd); err != nil {
			return err
		}
		rec := &blockDocRecord{
			artifactID:  pd.ArtifactID,
			title:       pd.Title,
			seq:         pd.Seq,
			updatedAtMs: pd.UpdatedAtMs,
			blocks:      make(map[string]Block, len(pd.Blocks)),
			revisions:   pd.Revisions,
			batches:     pd.Batches,
			suggestions: make(map[string]Suggestion, len(pd.Suggestions)),
			suggOrder:   make([]string, 0, len(pd.Suggestions)),
			contentSHA:  pd.ContentSHA256,
			stateSHA:    pd.StateSHA256,
		}
		for _, b := range pd.Blocks {
			rec.blocks[b.ID] = cloneBlock(b)
		}
		if rec.revisions == nil {
			rec.revisions = make(map[string]map[int64][]TextSpan)
		}
		if rec.batches == nil {
			rec.batches = make(map[string]BlockAck)
		}
		for _, sg := range pd.Suggestions {
			rec.suggestions[sg.ID] = sg
			rec.suggOrder = append(rec.suggOrder, sg.ID)
		}
		s.docs[rec.artifactID] = rec
	}
	return nil
}

func validateSuggestionChange(ch SuggestionChange) error {
	hasField := ch.Text != nil || ch.Type != nil || ch.Attrs != nil || len(ch.Unset) > 0 || ch.Delete
	if !hasField {
		return fmt.Errorf("%w: empty suggestion change", ErrInvalidBlockOp)
	}
	if ch.Delete && (ch.Text != nil || ch.Type != nil || ch.Attrs != nil || len(ch.Unset) > 0) {
		return fmt.Errorf("%w: delete suggestion cannot combine other changes", ErrInvalidBlockOp)
	}
	if ch.Type != nil && !isKnownBlockType(*ch.Type) {
		return fmt.Errorf("%w: unknown block type %q", ErrInvalidBlockOp, *ch.Type)
	}
	return nil
}

func cloneSuggestionChange(ch SuggestionChange) SuggestionChange {
	out := SuggestionChange{
		Text:   slices.Clone(ch.Text),
		Unset:  slices.Clone(ch.Unset),
		Delete: ch.Delete,
	}
	if ch.Type != nil {
		tp := *ch.Type
		out.Type = &tp
	}
	if ch.Attrs != nil {
		a := cloneAttrs(*ch.Attrs)
		out.Attrs = &a
	}
	return out
}

func mapValues(m map[string]Block) []Block {
	out := make([]Block, 0, len(m))
	for _, b := range m {
		out = append(out, cloneBlock(b))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func cloneBlocks(in []Block) []Block {
	out := make([]Block, len(in))
	for i, b := range in {
		out[i] = cloneBlock(b)
	}
	return out
}

func cloneBlockMap(m map[string]Block) map[string]Block {
	out := make(map[string]Block, len(m))
	for k, v := range m {
		out[k] = cloneBlock(v)
	}
	return out
}

func cloneRevisionMap(m map[string]map[int64][]TextSpan) map[string]map[int64][]TextSpan {
	out := make(map[string]map[int64][]TextSpan, len(m))
	for id, byRev := range m {
		cp := make(map[int64][]TextSpan, len(byRev))
		for rev, spans := range byRev {
			cp[rev] = slices.Clone(spans)
		}
		out[id] = cp
	}
	return out
}

func newHexID(prefix string) string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return prefix + "_" + hex.EncodeToString(b[:])
}

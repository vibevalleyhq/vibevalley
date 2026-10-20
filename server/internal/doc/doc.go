package doc

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"sync"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
)

// The package's one service: documents, changed only by batches of ops (ops.go), from the owner over HTTP and from
// helpers through their tools, all down the same pipeline.
type Service struct {
	db *sql.DB
	q  *generated.Queries
	// One batch at a time, for every document: a document's batches are serial and its seq goes up in order.
	mu  sync.Mutex
	Now func() int64
}

func newService(db *sql.DB) (*Service, error) {
	return &Service{db: db, q: generated.New(db), Now: clock.NowMs}, nil
}

func (*Service) OnStart(context.Context) error { return nil }
func (*Service) OnStop()                       {}

func document(d generated.Doc) protocol.Document {
	return protocol.Document{ID: d.ID, Title: d.Title, Seq: d.Seq, Created: d.CreatedAt, Updated: d.UpdatedAt}
}

func missingDoc(id string) error { return protocol.Missing{What: "文档 " + id} }

func (s *Service) List(ctx context.Context) ([]protocol.Document, error) {
	rows, err := s.q.Docs(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]protocol.Document, 0, len(rows))
	for _, d := range rows {
		out = append(out, document(d))
	}
	return out, nil
}

func titleOf(title string) string {
	if t := strings.TrimSpace(title); t != "" {
		return t
	}
	return "没起名的文档"
}

func (s *Service) Create(ctx context.Context, title string) (protocol.DocSnapshot, error) {
	now := s.Now()
	id := base.NewID()
	if err := s.q.AddDoc(ctx, generated.AddDocParams{ID: id, Title: titleOf(title), CreatedAt: now, UpdatedAt: now}); err != nil {
		return protocol.DocSnapshot{}, err
	}
	return s.Get(ctx, id)
}

// Import makes a document from Markdown, its blocks inserted as one batch by actor.
func (s *Service) Import(ctx context.Context, title, markdown, actor string) (protocol.DocSnapshot, error) {
	created, err := s.Create(ctx, title)
	if err != nil {
		return created, err
	}
	var ops []protocol.DocOp
	parents := []string{}
	last := map[string]string{}
	for _, b := range blocksOfMarkdown(markdown) {
		parents = parents[:b.depth]
		var parent *string
		if b.depth > 0 {
			parent = new(parents[b.depth-1])
		}
		key, err := keyBetween(last[ptrValue(parent)], "")
		if err != nil {
			return created, err
		}
		last[ptrValue(parent)] = key
		id := base.NewID()
		parents = append(parents, id)
		ops = append(ops, protocol.DocOp{Value: protocol.DocOpInsertBlock{Block: protocol.Block{
			ID: id, ParentID: parent, OrderKey: key, Type: b.typ, Attrs: b.attrs, Text: b.text,
		}}})
	}
	if len(ops) > 0 {
		if _, err := s.Submit(ctx, created.Doc.ID, actor, protocol.DocSubmit{BatchID: base.NewID(), Ops: ops}); err != nil {
			return created, err
		}
	}
	return s.Get(ctx, created.Doc.ID)
}

func blockOf(row generated.DocBlock) (protocol.Block, error) {
	b := protocol.Block{ID: row.ID, DocID: row.DocID, OrderKey: row.OrderKey, Type: row.Type, Rev: row.Rev, Deleted: row.Deleted,
		UpdatedBy: row.UpdatedBy, Updated: row.UpdatedAt, Text: []protocol.DocSpan{}}
	if row.ParentID.Valid {
		b.ParentID = &row.ParentID.String
	}
	if err := json.Unmarshal([]byte(row.Attrs), &b.Attrs); err != nil {
		return b, err
	}
	if err := json.Unmarshal([]byte(row.Spans), &b.Text); err != nil {
		return b, err
	}
	return b, nil
}

func blocksOf(ctx context.Context, q *generated.Queries, doc string) ([]protocol.Block, error) {
	rows, err := q.DocBlocks(ctx, doc)
	if err != nil {
		return nil, err
	}
	out := make([]protocol.Block, 0, len(rows))
	for _, r := range rows {
		b, err := blockOf(r)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, nil
}

func (s *Service) Get(ctx context.Context, id string) (protocol.DocSnapshot, error) {
	d, err := s.q.Doc(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return protocol.DocSnapshot{}, missingDoc(id)
	}
	if err != nil {
		return protocol.DocSnapshot{}, err
	}
	blocks, err := blocksOf(ctx, s.q, id)
	if err != nil {
		return protocol.DocSnapshot{}, err
	}
	live := ordered(blocks)
	if live == nil {
		live = []protocol.Block{}
	}
	return protocol.DocSnapshot{Doc: document(d), Blocks: live}, nil
}

func (s *Service) Markdown(ctx context.Context, id string) (string, error) {
	snap, err := s.Get(ctx, id)
	if err != nil {
		return "", err
	}
	return markdownOf(snap.Blocks), nil
}

// Submit takes a batch of ops from actor (protocol.DocOwner, or a helper's profile id): in order, in one transaction. A
// batch id seen before is answered as it was, with its blocks as they are now.
func (s *Service) Submit(ctx context.Context, id, actor string, body protocol.DocSubmit) (protocol.DocAck, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.submit(ctx, id, actor, body)
}

func (s *Service) submit(ctx context.Context, id, actor string, body protocol.DocSubmit) (protocol.DocAck, error) {
	if strings.TrimSpace(body.BatchID) == "" {
		return protocol.DocAck{}, errors.New("这批改动没有 batchId")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return protocol.DocAck{}, err
	}
	defer tx.Rollback()
	q := s.q.WithTx(tx)
	d, err := q.Doc(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return protocol.DocAck{}, missingDoc(id)
	}
	if err != nil {
		return protocol.DocAck{}, err
	}
	if seen, err := q.DocChangeByBatch(ctx, body.BatchID); err == nil {
		return again(ctx, q, id, seen)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return protocol.DocAck{}, err
	}
	blocks, err := blocksOf(ctx, q, id)
	if err != nil {
		return protocol.DocAck{}, err
	}
	now := s.Now()
	p := newPage(id, actor, now, blocks)
	p.base = func(block string, rev int64) ([]protocol.DocSpan, bool) {
		raw, err := q.DocBlockRevision(ctx, generated.DocBlockRevisionParams{BlockID: block, Rev: rev})
		var spans []protocol.DocSpan
		if err != nil || json.Unmarshal([]byte(raw), &spans) != nil {
			return nil, false
		}
		return spans, true
	}
	p.taken = func(block string) bool {
		_, err := q.DocBlockDoc(ctx, block)
		return err == nil
	}
	results := make([]protocol.DocOpResult, 0, len(body.Ops))
	for _, op := range body.Ops {
		results = append(results, p.apply(op))
	}
	for _, b := range p.changedBlocks() {
		attrs, _ := json.Marshal(b.Attrs)
		spans, _ := json.Marshal(b.Text)
		if err := q.PutDocBlock(ctx, generated.PutDocBlockParams{
			ID: b.ID, DocID: id, ParentID: sql.NullString{String: ptrValue(b.ParentID), Valid: b.ParentID != nil}, OrderKey: b.OrderKey,
			Type: b.Type, Attrs: string(attrs), Spans: string(spans), Rev: b.Rev, Deleted: b.Deleted, UpdatedBy: b.UpdatedBy, UpdatedAt: b.Updated,
		}); err != nil {
			return protocol.DocAck{}, err
		}
	}
	for _, r := range p.revisions {
		spans, _ := json.Marshal(r.spans)
		if err := q.AddDocBlockRevision(ctx, generated.AddDocBlockRevisionParams{
			ID: base.NewID(), BlockID: r.block, Rev: r.rev, Spans: string(spans), Actor: actor, Kind: r.kind, CreatedAt: now,
		}); err != nil {
			return protocol.DocAck{}, err
		}
	}
	seq := d.Seq + 1
	ids, _ := json.Marshal(p.changed)
	stored, _ := json.Marshal(results)
	if err := q.AddDocChange(ctx, generated.AddDocChangeParams{
		DocID: id, Seq: seq, BatchID: body.BatchID, Actor: actor, BlockIds: string(ids), Results: string(stored), CreatedAt: now,
	}); err != nil {
		return protocol.DocAck{}, err
	}
	if err := q.DocAccepted(ctx, generated.DocAcceptedParams{ID: id, Seq: seq, UpdatedAt: now}); err != nil {
		return protocol.DocAck{}, err
	}
	if err := tx.Commit(); err != nil {
		return protocol.DocAck{}, err
	}
	return protocol.DocAck{BatchID: body.BatchID, Seq: seq, Results: results, Blocks: p.changedBlocks()}, nil
}

// again answers a batch already taken: its results then, its blocks now.
func again(ctx context.Context, q *generated.Queries, doc string, seen generated.DocChange) (protocol.DocAck, error) {
	if seen.DocID != doc {
		return protocol.DocAck{}, errors.New("这批改动（" + seen.BatchID + "）是另一篇文档的")
	}
	var results []protocol.DocOpResult
	var ids []string
	if err := json.Unmarshal([]byte(seen.Results), &results); err != nil {
		return protocol.DocAck{}, err
	}
	if err := json.Unmarshal([]byte(seen.BlockIds), &ids); err != nil {
		return protocol.DocAck{}, err
	}
	all, err := blocksOf(ctx, q, doc)
	if err != nil {
		return protocol.DocAck{}, err
	}
	blocks := []protocol.Block{}
	for _, id := range ids {
		for _, b := range all {
			if b.ID == id {
				blocks = append(blocks, b)
			}
		}
	}
	return protocol.DocAck{BatchID: seen.BatchID, Seq: seen.Seq, Results: results, Blocks: blocks}, nil
}

// Append puts a new block at the end of the document's top level, as actor; text is inline Markdown (code takes it as
// it is).
func (s *Service) Append(ctx context.Context, doc, actor, typ string, attrs protocol.BlockAttrs, text string) (protocol.Block, protocol.DocOpResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	blocks, err := blocksOf(ctx, s.q, doc)
	if err != nil {
		return protocol.Block{}, protocol.DocOpResult{}, err
	}
	last := ""
	for _, b := range newPage(doc, actor, 0, blocks).children("") {
		last = b.OrderKey
	}
	key, err := keyBetween(last, "")
	if err != nil {
		return protocol.Block{}, protocol.DocOpResult{}, err
	}
	b := protocol.Block{ID: base.NewID(), OrderKey: key, Type: typ, Attrs: attrs, Text: spansOf(typ, text)}
	ack, err := s.submit(ctx, doc, actor, protocol.DocSubmit{BatchID: base.NewID(), Ops: []protocol.DocOp{{Value: protocol.DocOpInsertBlock{Block: b}}}})
	return blockIn(ack, b.ID), resultOf(ack), err
}

// UpdateText writes a block's whole text against baseRev, as actor; text is inline Markdown (code takes it as it is).
func (s *Service) UpdateText(ctx context.Context, doc, actor, block string, baseRev int64, text string) (protocol.Block, protocol.DocOpResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	typ := protocol.BlockParagraph
	if row, err := s.q.DocBlocks(ctx, doc); err == nil {
		for _, r := range row {
			if r.ID == block {
				typ = r.Type
			}
		}
	}
	ack, err := s.submit(ctx, doc, actor, protocol.DocSubmit{BatchID: base.NewID(), Ops: []protocol.DocOp{{Value: protocol.DocOpUpdateText{
		BlockID: block, BaseRev: baseRev, Text: spansOf(typ, text),
	}}}})
	return blockIn(ack, block), resultOf(ack), err
}

func spansOf(typ, text string) []protocol.DocSpan {
	if typ == protocol.BlockCode {
		return unmarked([]protocol.DocSpan{{T: text}})
	}
	return inlineSpans(text)
}

func blockIn(ack protocol.DocAck, id string) protocol.Block {
	for _, b := range ack.Blocks {
		if b.ID == id {
			return b
		}
	}
	return protocol.Block{}
}

func resultOf(ack protocol.DocAck) protocol.DocOpResult {
	if len(ack.Results) == 0 {
		return protocol.DocOpResult{}
	}
	return ack.Results[0]
}

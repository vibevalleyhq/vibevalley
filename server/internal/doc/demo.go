package doc

import (
	"context"
	"errors"
	"math/rand/v2"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
)

// The demo: up to three helpers write one article at once, from a script, through the real op pipeline as their profiles,
// so the owner can watch several writers without paying for a model. Nothing of it is a helper's own output; every heading
// says 演示.

// One section of the demo script: its heading and the paragraphs its helper grows, a piece a tick.
type demoSection struct {
	heading    string
	paragraphs []string
}

var demoScript = []demoSection{
	{"背景 · 演示", []string{
		"（演示）这一节是脚本写的，不是帮工真的想出来的。我们的农场里有好几个帮工，以前一篇文章只能一个人从头写到尾，别人只能等着。",
		"现在文档按块存，每一块有自己的版本号。几个帮工各写各的一节，互不抢同一块，谁写的哪一块，左边的归属条一眼就能看出来。",
		"这篇演示就是想让主人亲眼看一下：三个帮工同时动笔，字一段一段长出来，最后拼成一篇完整的文章。",
	}},
	{"做法 · 演示", []string{
		"（演示）每个帮工先在自己那一节的末尾插一个空段落，然后每隔一秒左右把这一段整段换新，看起来就是一段话在慢慢长长。",
		"所有改动都走和主人一样的 op 管线：插入是 insert_block，长字是 update_text，带着上一版的版本号，服务端按顺序一批一批收下。",
		"如果主人在帮工正写着的那一段里改了字，帮工那一下就会冲突、写不进去；它不抢这一段，接着去写下一段。",
	}},
	{"下一步 · 演示", []string{
		"（演示）等广播做好以后，页面不用再一秒问一次服务端，帮工写一下，主人这边马上就能看到。",
		"再往后，帮工想改别人那一节的字，不直接改，而是挂一条建议，等主人点头；写完的一节在大纲里标成写完待看。",
		"演示到这里就结束了。这篇文档留着也行，删掉也行，它不会影响任何工单和记性。",
	}},
}

// The pacing of one helper: about a tick per piece, a bit more or less so the helpers interleave.
const (
	demoPieces = 6
	demoJitter = 0.3
)

// demo is the Service's part that runs the demo; at most one runs at a time on the farm.
type demo struct {
	// One piece of a paragraph a tick; tests make it short.
	tick time.Duration
	mu   sync.Mutex
	on   bool
	life context.Context
	stop context.CancelFunc
	wg   sync.WaitGroup
}

func (d *demo) init() {
	d.tick = time.Second
	d.life, d.stop = context.WithCancel(context.Background())
}

func (d *demo) close() {
	d.stop()
	d.wg.Wait()
}

func (d *demo) wait(ctx context.Context, ticks float64) error {
	t := time.NewTimer(time.Duration(ticks * (1 + demoJitter*(2*rand.Float64()-1)) * float64(d.tick)))
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Demo starts the demo on the document and returns at once: one heading per writer (the enabled profiles among
// helpers, up to three), then each writer grows paragraphs at the end of its own section. A demo already running is refused.
func (s *Service) Demo(ctx context.Context, id string, helpers []protocol.Agent) error {
	if _, err := s.q.Doc(ctx, id); err != nil {
		return missingDoc(id)
	}
	var writers []string
	for _, a := range helpers {
		if a.Enabled && len(writers) < len(demoScript) {
			writers = append(writers, a.ID)
		}
	}
	if len(writers) == 0 {
		return errors.New("没有能写的帮工：先在档案里打开一个")
	}
	s.demo.mu.Lock()
	defer s.demo.mu.Unlock()
	if s.demo.on {
		return errors.New("演示正在写，写完再点")
	}
	s.demo.on = true
	s.demo.wg.Go(func() {
		defer func() {
			s.demo.mu.Lock()
			s.demo.on = false
			s.demo.mu.Unlock()
		}()
		s.runDemo(s.demo.life, id, writers)
	})
	return nil
}

func (s *Service) runDemo(ctx context.Context, doc string, writers []string) {
	headings := make([]string, len(writers))
	for i, w := range writers {
		level := int64(2)
		b := protocol.Block{ID: base.NewID(), Type: protocol.BlockHeading, Attrs: protocol.BlockAttrs{Level: &level}, Text: spansOf(protocol.BlockHeading, demoScript[i].heading)}
		if _, err := s.demoInsert(ctx, doc, w, b, nil); err != nil {
			return
		}
		headings[i] = b.ID
		if s.demo.wait(ctx, 0.5) != nil {
			return
		}
	}
	var wg sync.WaitGroup
	for i, w := range writers {
		wg.Go(func() {
			if s.demo.wait(ctx, float64(i)/3) != nil {
				return
			}
			s.demoWrite(ctx, doc, w, headings, i)
		})
	}
	wg.Wait()
}

// demoWrite is one writer: each paragraph of its section, inserted empty at the section's end, then grown a piece a tick.
func (s *Service) demoWrite(ctx context.Context, doc, writer string, headings []string, section int) {
	for _, text := range demoScript[section].paragraphs {
		b := protocol.Block{ID: base.NewID(), Type: protocol.BlockParagraph, Text: []protocol.DocSpan{}}
		rev, err := s.demoInsert(ctx, doc, writer, b, &demoPlace{headings, section})
		if err != nil {
			return
		}
		runes := []rune(text)
		for n := 1; n <= demoPieces; n++ {
			if s.demo.wait(ctx, 1) != nil {
				return
			}
			_, r, err := s.UpdateText(ctx, doc, writer, b.ID, rev, string(runes[:len(runes)*n/demoPieces]))
			if err != nil {
				return
			}
			// The owner wrote in it (or removed it): the block is theirs now, the writer goes on to its next paragraph.
			if r.Status != protocol.DocOpStatusApplied {
				break
			}
			rev = r.Rev
		}
		if s.demo.wait(ctx, 0.8) != nil {
			return
		}
	}
}

// Where a demo block goes: at the end of its section, before the next section's heading.
type demoPlace struct {
	headings []string
	section  int
}

// demoInsert inserts b at the end of the document's top level, or at the end of a section; the key is picked under the
// batch lock, so two writers cannot pick the same place.
func (s *Service) demoInsert(ctx context.Context, doc, writer string, b protocol.Block, at *demoPlace) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	blocks, err := blocksOf(ctx, s.q, doc)
	if err != nil {
		return 0, err
	}
	// Tombstones too: their keys still hold their places.
	top := newPage(doc, writer, 0, blocks).children("")
	after, before := "", ""
	if len(top) > 0 {
		after = top[len(top)-1].OrderKey
	}
	if at != nil && at.section+1 < len(at.headings) {
		next := at.headings[at.section+1]
		for i, x := range top {
			if x.ID == next {
				before = x.OrderKey
				after = ""
				if i > 0 {
					after = top[i-1].OrderKey
				}
				break
			}
		}
	}
	if b.OrderKey, err = keyBetween(after, before); err != nil {
		return 0, err
	}
	ack, err := s.submit(ctx, doc, writer, protocol.DocSubmit{BatchID: base.NewID(), Ops: []protocol.DocOp{{Value: protocol.DocOpInsertBlock{Block: b}}}})
	if err != nil {
		return 0, err
	}
	if r := resultOf(ack); r.Status != protocol.DocOpStatusApplied {
		return 0, errors.New("演示的块没插进去：" + string(r.Status))
	}
	return blockIn(ack, b.ID).Rev, nil
}

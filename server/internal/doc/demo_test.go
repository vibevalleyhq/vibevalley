package doc

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"vibevalley/internal/protocol"
)

func waitDemo(t *testing.T, s *Service) {
	t.Helper()
	for range 2000 {
		s.demo.mu.Lock()
		on := s.demo.on
		s.demo.mu.Unlock()
		if !on {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the demo did not finish")
}

// The demo writes three sections at once, each by its own helper, through the op pipeline: a section's blocks stay
// together under its heading, a second start while it runs is refused, and the owner's words in a block it is growing win.
func TestTheDemoWritesThreeSections(t *testing.T) {
	ctx := context.Background()
	s := open(t, ":memory:")
	s.demo.tick = time.Millisecond
	d, _ := s.Create(ctx, "演示")
	id := d.Doc.ID
	submit(t, s, id, "mine", protocol.DocOpInsertBlock{Block: para("first", "V", "主人先写的")})
	helpers := []protocol.Agent{{ID: "off", Enabled: false}, {ID: "backend", Enabled: true}, {ID: "tester", Enabled: true}, {ID: "frontend", Enabled: true}, {ID: "docs", Enabled: true}}

	if err := s.Demo(ctx, id, helpers); err != nil {
		t.Fatal(err)
	}
	if err := s.Demo(ctx, id, helpers); err == nil || !strings.Contains(err.Error(), "演示正在写") {
		t.Fatalf("a second start: %v", err)
	}
	waitDemo(t, s)

	snap, _ := s.Get(ctx, id)
	if snap.Blocks[0].ID != "first" {
		t.Fatalf("the owner's block moved: %+v", snap.Blocks[0])
	}
	writers := []string{"backend", "tester", "frontend"}
	section := -1
	for _, b := range snap.Blocks[1:] {
		if b.Type == protocol.BlockHeading {
			section++
			if !strings.HasSuffix(plain(b.Text), "· 演示") || b.UpdatedBy != writers[section] {
				t.Fatalf("heading %d: %q by %s", section, plain(b.Text), b.UpdatedBy)
			}
			continue
		}
		if section < 0 || b.UpdatedBy != writers[section] {
			t.Fatalf("a paragraph by %s in section %d", b.UpdatedBy, section)
		}
		if want := demoScript[section].paragraphs; !strings.Contains(strings.Join(want, "|"), plain(b.Text)) || b.Rev != demoPieces+1 {
			t.Fatalf("section %d: %q rev %d", section, plain(b.Text), b.Rev)
		}
	}
	if section != 2 || len(snap.Blocks) != 1+3*4 {
		t.Fatalf("%d sections, %d blocks", section+1, len(snap.Blocks))
	}
	var full int
	for _, b := range snap.Blocks {
		for _, sec := range demoScript {
			for _, p := range sec.paragraphs {
				if plain(b.Text) == p {
					full++
				}
			}
		}
	}
	if full != 9 {
		t.Fatalf("%d paragraphs written out", full)
	}
	// Done, it can start again.
	if err := s.Demo(ctx, id, helpers); err != nil {
		t.Fatal(err)
	}
	waitDemo(t, s)

	if err := s.Demo(ctx, id, []protocol.Agent{{ID: "off"}}); err == nil {
		t.Fatal("a demo with no helper")
	}
	if err := s.Demo(ctx, "nope", helpers); !errors.As(err, new(protocol.Missing)) {
		t.Fatal(err)
	}
}

// The owner writing in a paragraph the demo is growing keeps it: the demo's next piece is a conflict and it moves on.
func TestTheDemoLeavesTheOwnersBlock(t *testing.T) {
	ctx := context.Background()
	s := open(t, ":memory:")
	s.demo.tick = 20 * time.Millisecond
	d, _ := s.Create(ctx, "演示")
	id := d.Doc.ID
	if err := s.Demo(ctx, id, []protocol.Agent{{ID: "backend", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	var taken string
	for range 500 {
		snap, _ := s.Get(ctx, id)
		if len(snap.Blocks) == 2 && snap.Blocks[1].Rev >= 2 {
			b := snap.Blocks[1]
			ack := submit(t, s, id, "owner", protocol.DocOpUpdateText{BlockID: b.ID, BaseRev: b.Rev, Text: []protocol.DocSpan{span("主人接手了")}})
			if ack.Results[0].Status == protocol.DocOpStatusApplied {
				taken = b.ID
				break
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	if taken == "" {
		t.Fatal("never caught the demo growing a paragraph")
	}
	waitDemo(t, s)
	snap, _ := s.Get(ctx, id)
	for _, b := range snap.Blocks {
		if b.ID == taken && (plain(b.Text) != "主人接手了" || b.UpdatedBy != protocol.DocOwner) {
			t.Fatalf("%q by %s", plain(b.Text), b.UpdatedBy)
		}
	}
	if len(snap.Blocks) != 4 {
		t.Fatalf("%d blocks", len(snap.Blocks))
	}
}

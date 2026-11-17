package artifact_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/vibevalleyhq/vibevalley/internal/domain/artifact"
)

func TestOrderKeysFractionalInvariants(t *testing.T) {
	keys := make([]string, 0, 200)
	cur := ""
	for range 100 {
		next, err := artifact.KeyBetween(cur, "")
		if err != nil {
			t.Fatalf("KeyBetween append failed: %v", err)
		}
		if !artifact.ValidOrderKey(next) {
			t.Fatalf("invalid order key %q", next)
		}
		keys = append(keys, next)
		cur = next
	}

	// Prepend 50 keys before keys[0].
	first := keys[0]
	for range 50 {
		prev, err := artifact.KeyBetween("", first)
		if err != nil {
			t.Fatalf("KeyBetween prepend failed: %v", err)
		}
		if prev >= first || !artifact.ValidOrderKey(prev) {
			t.Fatalf("invalid prepended key %q before %q", prev, first)
		}
		keys = append([]string{prev}, keys...)
		first = prev
	}

	// Split midpoint 50 times in the middle.
	left := keys[25]
	right := keys[26]
	for range 50 {
		mid, err := artifact.KeyBetween(left, right)
		if err != nil {
			t.Fatalf("KeyBetween midpoint(%q, %q) failed: %v", left, right, err)
		}
		if !(left < mid && mid < right) || !artifact.ValidOrderKey(mid) {
			t.Fatalf("broken midpoint ordering: %q < %q < %q", left, mid, right)
		}
		left = mid
	}
}

func TestPageStateMachineOpsAndUnicodeSplit(t *testing.T) {
	p := artifact.NewPage("art-1", artifact.UserActor, 1000, nil)

	k1, _ := artifact.KeyBetween("", "")
	k2, _ := artifact.KeyBetween(k1, "")
	k3, _ := artifact.KeyBetween(k2, "")

	r1 := p.Apply(artifact.BlockOp{
		Op: artifact.OpInsertBlock,
		Block: &artifact.BlockInput{
			ID:       "b1",
			OrderKey: k1,
			Type:     artifact.BlockParagraph,
			Text:     []artifact.TextSpan{{Text: "你好🚀世界", Marks: artifact.SpanMarks{Bold: true}}},
		},
	})
	if r1.Status != artifact.OpApplied || r1.Rev != 1 {
		t.Fatalf("insert b1 failed: %+v", r1)
	}

	// Split at rune offset 3 ("你好🚀" | "世界").
	rs := p.Apply(artifact.BlockOp{
		Op:      artifact.OpSplitBlock,
		BlockID: "b1",
		BaseRev: 1,
		Offset:  3,
		NewBlock: &artifact.BlockInput{
			ID:       "b2",
			OrderKey: k2,
			Type:     artifact.BlockParagraph,
		},
	})
	if rs.Status != artifact.OpApplied {
		t.Fatalf("split failed: %+v", rs)
	}
	b1, _ := p.Find("b1")
	b2, _ := p.Find("b2")
	if artifact.PlainText(b1.Text) != "你好🚀" || artifact.PlainText(b2.Text) != "世界" {
		t.Fatalf("unexpected unicode split result: b1=%q b2=%q", artifact.PlainText(b1.Text), artifact.PlainText(b2.Text))
	}

	// Insert child under b1 and test cycle rejection on move_block.
	ck, _ := artifact.KeyBetween("", "")
	_ = p.Apply(artifact.BlockOp{
		Op: artifact.OpInsertBlock,
		Block: &artifact.BlockInput{
			ID:       "child-1",
			ParentID: "b1",
			OrderKey: ck,
			Type:     artifact.BlockBulleted,
			Text:     []artifact.TextSpan{{Text: "nested"}},
		},
	})
	rm := p.Apply(artifact.BlockOp{
		Op:       artifact.OpMoveBlock,
		BlockID:  "b1",
		ParentID: "child-1",
		OrderKey: k3,
	})
	if rm.Status != artifact.OpRejected {
		t.Fatalf("expected cycle move rejected, got %+v", rm)
	}

	// Merge b2 back into b1.
	rmerge := p.Apply(artifact.BlockOp{
		Op:       artifact.OpMergeBlocks,
		TargetID: "b1",
		SourceID: "b2",
	})
	if rmerge.Status != artifact.OpApplied {
		t.Fatalf("merge failed: %+v", rmerge)
	}
	b1After, _ := p.Find("b1")
	if artifact.PlainText(b1After.Text) != "你好🚀世界" {
		t.Fatalf("expected merged text, got %q", artifact.PlainText(b1After.Text))
	}

	// Delete b1 cascades to child-1, then restore brings both back.
	_ = p.Apply(artifact.BlockOp{Op: artifact.OpDeleteBlock, BlockID: "b1"})
	if len(p.Ordered()) != 0 {
		t.Fatalf("expected 0 live blocks after cascade delete, got %d", len(p.Ordered()))
	}
	_ = p.Apply(artifact.BlockOp{Op: artifact.OpRestoreBlock, BlockID: "b1"})
	if len(p.Ordered()) != 2 {
		t.Fatalf("expected 2 live blocks after restore, got %d", len(p.Ordered()))
	}
}

func TestConcurrentBlockOpsAndSuggestionConvergence(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	var ts int64 = 10_000

	svc, err := artifact.NewService(artifact.ServiceConfig{
		Dir: dir,
		Now: func() int64 {
			ts++
			return ts
		},
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	docID := "doc-concurrent"
	if _, err := svc.Pages.CreateDocument(ctx, docID, "Spec Doc"); err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}

	k1, _ := artifact.KeyBetween("", "")
	k2, _ := artifact.KeyBetween(k1, "")

	// User creates two initial blocks.
	ack1, err := svc.Pages.SubmitBatch(ctx, docID, artifact.UserActor, "batch-init", []artifact.BlockOp{
		{
			Op: artifact.OpInsertBlock,
			Block: &artifact.BlockInput{
				ID:       "blk-user",
				OrderKey: k1,
				Type:     artifact.BlockParagraph,
				Text:     []artifact.TextSpan{{Text: "Original user sentence."}},
			},
		},
		{
			Op: artifact.OpInsertBlock,
			Block: &artifact.BlockInput{
				ID:       "blk-collab",
				OrderKey: k2,
				Type:     artifact.BlockTodo,
				Attrs:    artifact.BlockAttrs{Checked: boolPtr(false)},
				Text:     []artifact.TextSpan{{Text: "Shared todo"}},
			},
		},
	})
	if err != nil {
		t.Fatalf("SubmitBatch init: %v", err)
	}
	initContentSHA := ack1.ContentSHA256

	// Verify batchId idempotency.
	ackDup, err := svc.Pages.SubmitBatch(ctx, docID, artifact.UserActor, "batch-init", nil)
	if err != nil {
		t.Fatalf("SubmitBatch dup: %v", err)
	}
	if !ackDup.Deduplicated || ackDup.Seq != ack1.Seq || ackDup.StateSHA256 != ack1.StateSHA256 {
		t.Fatalf("expected idempotent batch ack, got %+v", ackDup)
	}

	// Verify attribute-only change preserves text equivalence for stale baseRev=1 updates.
	if _, err := svc.Pages.SubmitBatch(ctx, docID, artifact.UserActor, "batch-check", []artifact.BlockOp{
		{Op: artifact.OpSetAttrs, BlockID: "blk-collab", Attrs: artifact.BlockAttrs{Checked: boolPtr(true)}},
	}); err != nil {
		t.Fatalf("SubmitBatch set_attrs: %v", err)
	}

	// Concurrent text updates on blk-collab all referencing baseRev=1:
	// First writer wins (rev advances 2->3) because text hadn't changed at rev 2; others get OpConflict!
	const workers = 12
	var wg sync.WaitGroup
	var appliedCount, conflictCount atomic.Int32
	for i := range workers {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			ack, err := svc.Pages.SubmitBatch(ctx, docID, fmt.Sprintf("agent-%d", idx), fmt.Sprintf("race-upd-%d", idx), []artifact.BlockOp{
				{
					Op:      artifact.OpUpdateText,
					BlockID: "blk-collab",
					BaseRev: 1,
					Text:    []artifact.TextSpan{{Text: fmt.Sprintf("Shared todo won by %d", idx)}},
				},
			})
			if err != nil {
				t.Errorf("concurrent SubmitBatch err: %v", err)
				return
			}
			switch ack.Results[0].Status {
			case artifact.OpApplied:
				appliedCount.Add(1)
			case artifact.OpConflict:
				conflictCount.Add(1)
			default:
				t.Errorf("unexpected op status: %+v", ack.Results[0])
			}
		}(i)
	}
	wg.Wait()

	if appliedCount.Load() != 1 || conflictCount.Load() != workers-1 {
		t.Fatalf("expected 1 winner and %d conflicts, got applied=%d conflict=%d", workers-1, appliedCount.Load(), conflictCount.Load())
	}

	// Concurrent sibling insertions under blk-user by multiple goroutines.
	var insertWG sync.WaitGroup
	prevKey := ""
	sibKeys := make([]string, 10)
	for i := range 10 {
		k, _ := artifact.KeyBetween(prevKey, "")
		sibKeys[i] = k
		prevKey = k
	}
	for i := range 10 {
		insertWG.Add(1)
		go func(idx int) {
			defer insertWG.Done()
			_, err := svc.Pages.SubmitBatch(ctx, docID, fmt.Sprintf("helper-%d", idx), fmt.Sprintf("sib-%d", idx), []artifact.BlockOp{
				{
					Op: artifact.OpInsertBlock,
					Block: &artifact.BlockInput{
						ID:       fmt.Sprintf("child-%d", idx),
						ParentID: "blk-user",
						OrderKey: sibKeys[idx],
						Type:     artifact.BlockBulleted,
						Text:     []artifact.TextSpan{{Text: fmt.Sprintf("Item %d", idx)}},
					},
				},
			})
			if err != nil {
				t.Errorf("concurrent sibling insert %d err: %v", idx, err)
			}
		}(i)
	}
	insertWG.Wait()

	// Agent edits targeting user-authored blk-user with ProtectUserBlocks=true divert into Suggestions!
	divertAck, err := svc.Pages.SubmitBatchWithOptions(ctx, docID, "agent:writer", "agent-divert-1", []artifact.BlockOp{
		{
			Op:      artifact.OpUpdateText,
			BlockID: "blk-user",
			BaseRev: 1,
			Text:    []artifact.TextSpan{{Text: "Polished user sentence."}},
		},
	}, artifact.SubmitOptions{ProtectUserBlocks: true})
	if err != nil {
		t.Fatalf("SubmitBatchWithOptions: %v", err)
	}
	if divertAck.Results[0].Status != artifact.OpRejected || divertAck.Results[0].SuggestionID == "" {
		t.Fatalf("expected agent update on user block diverted to suggestion, got %+v", divertAck.Results[0])
	}
	sugg1ID := divertAck.Results[0].SuggestionID

	// Create a second independent suggestion on blk-user and verify explicit RejectSuggestion.
	sugg2, err := svc.Pages.Suggest(ctx, docID, "agent:reviewer", artifact.SuggestionCreate{
		BlockID: "blk-user",
		BaseRev: 1,
		Change: artifact.SuggestionChange{
			Text: []artifact.TextSpan{{Text: "Alternative polished sentence."}},
		},
	})
	if err != nil {
		t.Fatalf("Suggest 2: %v", err)
	}
	if rej2, err := svc.Pages.RejectSuggestion(ctx, docID, sugg2.ID, artifact.UserActor); err != nil || rej2.Status != artifact.SuggestionRejected {
		t.Fatalf("RejectSuggestion 2 failed: %+v err=%v", rej2, err)
	}

	// Race AcceptSuggestion vs RejectSuggestion on sugg1 across 16 goroutines -> strictly atomic convergence!
	var convWG sync.WaitGroup
	var acceptedWins, rejectedWins, conflicts atomic.Int32
	for i := range 16 {
		convWG.Add(1)
		go func(idx int) {
			defer convWG.Done()
			if idx%2 == 0 {
				sg, _, err := svc.Pages.AcceptSuggestion(ctx, docID, sugg1ID, artifact.UserActor)
				if err == nil && sg.Status == artifact.SuggestionAccepted {
					acceptedWins.Add(1)
				} else if errors.Is(err, artifact.ErrSuggestionConflict) {
					conflicts.Add(1)
				} else if err != nil {
					t.Errorf("unexpected AcceptSuggestion err: %v", err)
				}
			} else {
				sg, err := svc.Pages.RejectSuggestion(ctx, docID, sugg1ID, artifact.UserActor)
				if err == nil && sg.Status == artifact.SuggestionRejected {
					rejectedWins.Add(1)
				} else if errors.Is(err, artifact.ErrSuggestionConflict) {
					conflicts.Add(1)
				} else if err != nil {
					t.Errorf("unexpected RejectSuggestion err: %v", err)
				}
			}
		}(i)
	}
	convWG.Wait()

	// Exactly one outcome family can succeed; opposing transitions must hit ErrSuggestionConflict.
	if (acceptedWins.Load() > 0) == (rejectedWins.Load() > 0) {
		t.Fatalf("suggestion failed to converge atomically: accepted=%d rejected=%d conflicts=%d",
			acceptedWins.Load(), rejectedWins.Load(), conflicts.Load())
	}
	if acceptedWins.Load()+rejectedWins.Load()+conflicts.Load() != 16 {
		t.Fatalf("unexpected total resolution count")
	}

	snap, err := svc.Pages.Snapshot(ctx, docID)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if len(snap.Ordered) != 12 {
		t.Fatalf("expected 12 ordered blocks (2 root + 10 children), got %d", len(snap.Ordered))
	}

	// Deterministic stale suggestion check: create two suggestions on blk-collab at current rev,
	// accept the first (bumping rev), and confirm accepting the second fails with ErrStaleSuggestion.
	var collabRev int64
	for _, b := range snap.Ordered {
		if b.ID == "blk-collab" {
			collabRev = b.Rev
		}
	}
	sgA, err := svc.Pages.Suggest(ctx, docID, "agent:1", artifact.SuggestionCreate{
		BlockID: "blk-collab",
		BaseRev: collabRev,
		Change:  artifact.SuggestionChange{Text: []artifact.TextSpan{{Text: "Converged text A"}}},
	})
	if err != nil {
		t.Fatalf("Suggest A: %v", err)
	}
	sgB, err := svc.Pages.Suggest(ctx, docID, "agent:2", artifact.SuggestionCreate{
		BlockID: "blk-collab",
		BaseRev: collabRev,
		Change:  artifact.SuggestionChange{Text: []artifact.TextSpan{{Text: "Competing text B"}}},
	})
	if err != nil {
		t.Fatalf("Suggest B: %v", err)
	}
	if accA, _, err := svc.Pages.AcceptSuggestion(ctx, docID, sgA.ID, artifact.UserActor); err != nil || accA.Status != artifact.SuggestionAccepted {
		t.Fatalf("AcceptSuggestion A failed: sg=%+v err=%v", accA, err)
	}
	if _, _, err := svc.Pages.AcceptSuggestion(ctx, docID, sgB.ID, artifact.UserActor); !errors.Is(err, artifact.ErrStaleSuggestion) {
		t.Fatalf("expected ErrStaleSuggestion for sgB after sgA accepted, got %v", err)
	}

	// Reload snap after sgA acceptance for final persistence assertion.
	snap, err = svc.Pages.Snapshot(ctx, docID)
	if err != nil {
		t.Fatalf("Snapshot reload: %v", err)
	}

	// Also test protected delete suggestion -> accept removes the block cleanly.
	var userBlkRev int64
	for _, b := range snap.Ordered {
		if b.ID == "blk-user" {
			userBlkRev = b.Rev
		}
	}
	if userBlkRev > 0 {
		delDivert, err := svc.Pages.SubmitBatchWithOptions(ctx, docID, "agent:cleaner", "agent-del-1", []artifact.BlockOp{
			{Op: artifact.OpDeleteBlock, BlockID: "blk-user"},
		}, artifact.SubmitOptions{ProtectUserBlocks: true})
		if err != nil {
			t.Fatalf("SubmitBatchWithOptions delete: %v", err)
		}
		if delDivert.Results[0].SuggestionID == "" {
			// blk-user might have been mutated only if accepted earlier (which kept UpdatedBy = user).
			t.Fatalf("expected delete on user block diverted to suggestion, got %+v", delDivert.Results[0])
		}
		if accDel, _, err := svc.Pages.AcceptSuggestion(ctx, docID, delDivert.Results[0].SuggestionID, artifact.UserActor); err != nil || accDel.Status != artifact.SuggestionAccepted {
			t.Fatalf("AcceptSuggestion delete failed: %+v err=%v", accDel, err)
		}
		snap, err = svc.Pages.Snapshot(ctx, docID)
		if err != nil {
			t.Fatalf("Snapshot after delete accept: %v", err)
		}
		for _, b := range snap.Ordered {
			if b.ID == "blk-user" || b.ParentID == "blk-user" {
				t.Fatalf("expected blk-user and children deleted after delete suggestion accepted, still saw %+v", b)
			}
		}
	}

	// Verify snapshot can be loaded from SHA-256 CAS and survives reopening PageStore from disk.
	historical, err := svc.Pages.SnapshotBySHA256(ctx, ack1.StateSHA256)
	if err != nil {
		t.Fatalf("SnapshotBySHA256: %v", err)
	}
	if historical.ContentSHA256 != initContentSHA || len(historical.Ordered) != 2 {
		t.Fatalf("unexpected historical snapshot: %+v", historical)
	}

	// Verify content deduplication when an identical document is created and populated identically.
	if _, err := svc.Pages.CreateDocument(ctx, "doc-clone", "Spec Doc"); err != nil {
		t.Fatalf("CreateDocument clone: %v", err)
	}
	cloneAck, err := svc.Pages.SubmitBatch(ctx, "doc-clone", artifact.UserActor, "clone-init", []artifact.BlockOp{
		{
			Op: artifact.OpInsertBlock,
			Block: &artifact.BlockInput{
				ID:       "blk-user-c",
				OrderKey: k1,
				Type:     artifact.BlockParagraph,
				Text:     []artifact.TextSpan{{Text: "Original user sentence."}},
			},
		},
	})
	if err != nil {
		t.Fatalf("SubmitBatch clone: %v", err)
	}
	// Reverting text back to original in a third doc with matching block IDs deduplicates ContentSHA256.
	if _, err := svc.Pages.CreateDocument(ctx, "doc-revert", "Revert Doc"); err != nil {
		t.Fatalf("CreateDocument revert: %v", err)
	}
	rev1, _ := svc.Pages.SubmitBatch(ctx, "doc-revert", artifact.UserActor, "r1", []artifact.BlockOp{
		{
			Op: artifact.OpInsertBlock,
			Block: &artifact.BlockInput{
				ID:       "blk-r",
				OrderKey: k1,
				Type:     artifact.BlockParagraph,
				Text:     []artifact.TextSpan{{Text: "Alpha"}},
			},
		},
	})
	_, _ = svc.Pages.SubmitBatch(ctx, "doc-revert", artifact.UserActor, "r2", []artifact.BlockOp{
		{Op: artifact.OpUpdateText, BlockID: "blk-r", BaseRev: 1, Text: []artifact.TextSpan{{Text: "Beta"}}},
	})
	rev3, _ := svc.Pages.SubmitBatch(ctx, "doc-revert", artifact.UserActor, "r3", []artifact.BlockOp{
		{Op: artifact.OpUpdateText, BlockID: "blk-r", BaseRev: 2, Text: []artifact.TextSpan{{Text: "Alpha"}}},
	})
	if rev1.ContentSHA256 != rev3.ContentSHA256 {
		t.Fatalf("expected reverted block document content SHA-256 to match & deduplicate: %s != %s", rev1.ContentSHA256, rev3.ContentSHA256)
	}
	_ = cloneAck

	reopened, err := artifact.NewService(artifact.ServiceConfig{Dir: dir})
	if err != nil {
		t.Fatalf("reopen NewService: %v", err)
	}
	reSnap, err := reopened.Pages.Snapshot(ctx, docID)
	if err != nil {
		t.Fatalf("reopened Snapshot: %v", err)
	}
	if reSnap.Seq != snap.Seq || reSnap.StateSHA256 != snap.StateSHA256 || len(reSnap.Ordered) != len(snap.Ordered) || len(reSnap.Ordered) != 1 {
		t.Fatalf("reopened page snapshot mismatch: got=%+v want=%+v", reSnap, snap)
	}
}

func boolPtr(v bool) *bool { return &v }

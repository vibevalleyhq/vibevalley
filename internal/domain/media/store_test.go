package media_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/vibevalleyhq/vibevalley/internal/domain/media"
	"github.com/vibevalleyhq/vibevalley/internal/machine"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func TestHarvestOutputsDeduplicationAndContainerDestructionSurvival(t *testing.T) {
	ctx := context.Background()
	sandboxDir := t.TempDir()
	persistDir := t.TempDir()

	var clockMs int64 = 1_700_000_000_000
	store, err := media.NewStore(media.Config{
		Dir: persistDir,
		Now: func() int64 {
			clockMs += 50
			return clockMs
		},
	})
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	env, err := machine.NewLocalEnv(machine.LocalEnvConfig{
		EnvID:   "sandbox-ephemeral-1",
		WorkDir: sandboxDir,
	})
	if err != nil {
		t.Fatalf("NewLocalEnv: %v", err)
	}

	pngBytes := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRfake-chart-payload")
	slidesHTML := []byte("<!doctype html><section><h1>Q4 Deck</h1></section>")
	dashboardHTML := []byte("<!doctype html><div id='dash'>Revenue</div>")
	videoBytes := []byte("ftypisom-mock-mp4-video-stream")

	if err := env.WriteAtomic(ctx, ".vibe/outputs/charts/revenue.png", pngBytes, 0o644); err != nil {
		t.Fatalf("WriteAtomic revenue.png: %v", err)
	}
	// Identical binary output under a second filename must deduplicate in the SHA-256 store.
	if err := env.WriteAtomic(ctx, ".vibe/outputs/charts/revenue-copy.png", pngBytes, 0o644); err != nil {
		t.Fatalf("WriteAtomic revenue-copy.png: %v", err)
	}
	if err := env.WriteAtomic(ctx, ".vibe/outputs/decks/q4.slides.html", slidesHTML, 0o644); err != nil {
		t.Fatalf("WriteAtomic q4.slides.html: %v", err)
	}
	if err := env.WriteAtomic(ctx, ".vibe/outputs/dash.html", dashboardHTML, 0o644); err != nil {
		t.Fatalf("WriteAtomic dash.html: %v", err)
	}
	if err := env.WriteAtomic(ctx, ".vibe/outputs/renders/demo.mp4", videoBytes, 0o644); err != nil {
		t.Fatalf("WriteAtomic demo.mp4: %v", err)
	}

	// Harvest from `.vibe/outputs/` before container teardown.
	res, err := store.HarvestAndIngest(ctx, env, media.IngestMetadata{
		SessionID: "sess-1",
		IssueID:   "iss-42",
		ChannelID: "chan-general",
		DisplayOverrides: map[string]contract.ArtifactDisplayMode{
			"dash.html": contract.ArtifactDisplayDashboard,
		},
	})
	if err != nil {
		t.Fatalf("HarvestAndIngest: %v", err)
	}

	// Destroy the sandbox container directory completely.
	if err := env.Close(); err != nil {
		t.Fatalf("env.Close: %v", err)
	}
	if err := os.RemoveAll(sandboxDir); err != nil {
		t.Fatalf("RemoveAll sandboxDir: %v", err)
	}
	if _, statErr := os.Stat(sandboxDir); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("expected sandboxDir deleted, got %v", statErr)
	}

	// Verify deduplication counts and emitted ArtifactCardView metadata.
	if len(res.Items) != 5 {
		t.Fatalf("expected 5 harvested items, got %d", len(res.Items))
	}
	if res.NewBlobs != 4 {
		t.Fatalf("expected 4 unique blobs stored (1 deduplicated), got %d", res.NewBlobs)
	}
	if res.DeduplicatedCount != 1 {
		t.Fatalf("expected DeduplicatedCount=1, got %d", res.DeduplicatedCount)
	}
	if len(res.Assets) != 4 {
		t.Fatalf("expected 4 unique media assets, got %d", len(res.Assets))
	}
	if len(res.Cards) != 4 {
		t.Fatalf("expected 4 deduplicated ArtifactCardView cards, got %d", len(res.Cards))
	}

	sumPNG := shaSumHex(pngBytes)
	pngAsset, err := store.GetAsset(ctx, sumPNG)
	if err != nil {
		t.Fatalf("GetAsset PNG: %v", err)
	}
	if pngAsset.IngestCount != 2 || len(pngAsset.SourcePaths) != 2 {
		t.Fatalf("expected 2 source paths aliased to deduplicated PNG asset, got %+v", pngAsset)
	}

	// Verify card metadata details across display modes and body types.
	cardByTitle := make(map[string]contract.ArtifactCardView, len(res.Cards))
	for _, c := range res.Cards {
		cardByTitle[c.Title] = c
		if c.IssueID != "iss-42" || c.ChannelID != "chan-general" || c.Version != 1 || len(c.SHA256) != 64 {
			t.Fatalf("unexpected ArtifactCardView fields: %+v", c)
		}
	}
	if cardByTitle["q4.slides.html"].Display != contract.ArtifactDisplaySlides || cardByTitle["q4.slides.html"].Body != "html" {
		t.Fatalf("unexpected slides card: %+v", cardByTitle["q4.slides.html"])
	}
	if cardByTitle["dash.html"].Display != contract.ArtifactDisplayDashboard || cardByTitle["dash.html"].Body != "html" {
		t.Fatalf("unexpected dashboard card: %+v", cardByTitle["dash.html"])
	}
	if cardByTitle["demo.mp4"].Display != contract.ArtifactDisplayMotion || cardByTitle["demo.mp4"].Body != "media" {
		t.Fatalf("unexpected video card: %+v", cardByTitle["demo.mp4"])
	}

	// Reopen a brand-new Store from persistDir after sandbox destruction to prove disk survival!
	reopened, err := media.NewStore(media.Config{Dir: persistDir})
	if err != nil {
		t.Fatalf("reopen NewStore: %v", err)
	}
	stats := reopened.Stats()
	if stats.UniqueBlobs != 4 || stats.UniqueAssets != 4 || stats.TotalCards != 4 {
		t.Fatalf("unexpected reopened stats: %+v", stats)
	}

	gotPNG, err := reopened.ReadBytes(ctx, sumPNG)
	if err != nil || !bytes.Equal(gotPNG, pngBytes) {
		t.Fatalf("reopened PNG bytes mismatch: err=%v len=%d", err, len(gotPNG))
	}

	rc, meta, err := reopened.Open(ctx, shaSumHex(videoBytes))
	if err != nil {
		t.Fatalf("reopened Open video: %v", err)
	}
	gotVid, _ := io.ReadAll(rc)
	rc.Close()
	if !bytes.Equal(gotVid, videoBytes) || meta.Size != int64(len(videoBytes)) {
		t.Fatalf("reopened video stream mismatch: len=%d meta=%+v", len(gotVid), meta)
	}

	cards := reopened.ListCards(ctx, media.CardFilter{IssueID: "iss-42"})
	if len(cards) != 4 {
		t.Fatalf("expected 4 persisted cards for iss-42, got %d", len(cards))
	}
}

func TestMediaVersioningCrossIssueDedupAndValidation(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	st, err := media.NewStore(media.Config{Dir: dir, MaxAssetBytes: 1024})
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	v1Bytes := []byte("chart-v1-bytes")
	v2Bytes := []byte("chart-v2-bytes-longer")

	// Version 1 for issue-1.
	r1, err := st.IngestHarvested(ctx, media.IngestRequest{
		IssueID:   "issue-1",
		ChannelID: "chan-1",
		Outputs: []contract.HarvestedOutput{{
			RelPath: "out/chart.png",
			Data:    v1Bytes,
		}},
	})
	if err != nil {
		t.Fatalf("Ingest v1: %v", err)
	}
	if r1.Cards[0].Version != 1 || r1.DeduplicatedCount != 0 {
		t.Fatalf("unexpected v1 result: %+v", r1)
	}

	// Re-ingest exact same output -> idempotent deduplication, version stays 1.
	r1Dup, err := st.IngestHarvested(ctx, media.IngestRequest{
		IssueID:   "issue-1",
		ChannelID: "chan-1",
		Outputs: []contract.HarvestedOutput{{
			RelPath: "out/chart.png",
			Data:    v1Bytes,
		}},
	})
	if err != nil {
		t.Fatalf("Ingest v1 dup: %v", err)
	}
	if r1Dup.DeduplicatedCount != 1 || r1Dup.Cards[0].Version != 1 || r1Dup.Cards[0].ID != r1.Cards[0].ID {
		t.Fatalf("expected idempotent dedup on repeat ingest, got %+v", r1Dup)
	}

	// Update same relPath in issue-1 with new bytes -> same Card.ID, Version bumped to 2.
	r2, err := st.IngestHarvested(ctx, media.IngestRequest{
		IssueID:   "issue-1",
		ChannelID: "chan-1",
		Outputs: []contract.HarvestedOutput{{
			RelPath: "out/chart.png",
			Data:    v2Bytes,
		}},
	})
	if err != nil {
		t.Fatalf("Ingest v2: %v", err)
	}
	if r2.Cards[0].ID != r1.Cards[0].ID || r2.Cards[0].Version != 2 || r2.Cards[0].SHA256 != shaSumHex(v2Bytes) {
		t.Fatalf("expected version bump to 2 on same Card.ID, got %+v", r2.Cards[0])
	}

	// Different issue ingesting v1Bytes -> blob is deduplicated on disk, new card emitted for issue-2.
	rOther, err := st.IngestHarvested(ctx, media.IngestRequest{
		IssueID:   "issue-2",
		ChannelID: "chan-2",
		Outputs: []contract.HarvestedOutput{{
			RelPath: "out/chart.png",
			Data:    v1Bytes,
		}},
	})
	if err != nil {
		t.Fatalf("Ingest issue-2: %v", err)
	}
	if rOther.NewBlobs != 0 || !rOther.Items[0].BlobDeduplicated || rOther.Cards[0].IssueID != "issue-2" {
		t.Fatalf("expected blob deduplicated across issues with scoped card, got %+v", rOther)
	}

	// Stream ingestion check.
	streamItem, err := st.IngestStream(ctx, "logs/trace.json", "application/json", bytes.NewReader([]byte(`{"ok":true}`)), media.IngestMetadata{
		SessionID: "sess-stream",
		IssueID:   "issue-3",
	})
	if err != nil || streamItem.Card.Title != "trace.json" || streamItem.Size != 11 {
		t.Fatalf("IngestStream failed: item=%+v err=%v", streamItem, err)
	}

	// Validation error cases.
	if _, err := st.IngestHarvested(ctx, media.IngestRequest{
		Outputs: []contract.HarvestedOutput{{RelPath: "../escape.png", Data: v1Bytes}},
	}); !errors.Is(err, media.ErrInvalidRelPath) {
		t.Fatalf("expected ErrInvalidRelPath, got %v", err)
	}
	if _, err := st.IngestHarvested(ctx, media.IngestRequest{
		Outputs: []contract.HarvestedOutput{{RelPath: "a.png", SHA256: shaSumHex(v2Bytes), Data: v1Bytes}},
	}); !errors.Is(err, media.ErrChecksumMismatch) {
		t.Fatalf("expected ErrChecksumMismatch, got %v", err)
	}
	if _, err := st.IngestHarvested(ctx, media.IngestRequest{
		Outputs: []contract.HarvestedOutput{{RelPath: "a.png", Size: 99, Data: v1Bytes}},
	}); !errors.Is(err, media.ErrSizeMismatch) {
		t.Fatalf("expected ErrSizeMismatch, got %v", err)
	}
	if _, err := st.IngestHarvested(ctx, media.IngestRequest{
		Outputs: []contract.HarvestedOutput{{RelPath: "big.bin", Data: make([]byte, 2048)}},
	}); !errors.Is(err, media.ErrAssetTooLarge) {
		t.Fatalf("expected ErrAssetTooLarge, got %v", err)
	}

	// Disk tamper check.
	targetBlob := filepath.Join(dir, "blobs", shaSumHex(v1Bytes))
	if err := os.WriteFile(targetBlob, []byte("corrupted"), 0o644); err != nil {
		t.Fatalf("corrupt blob: %v", err)
	}
	if _, err := st.ReadBytes(ctx, shaSumHex(v1Bytes)); !errors.Is(err, media.ErrCorruptedAsset) {
		t.Fatalf("expected ErrCorruptedAsset after disk tamper, got %v", err)
	}
}

func TestMediaConcurrentIngestionRaceSafe(t *testing.T) {
	ctx := context.Background()
	st, err := media.NewStore(media.Config{})
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	shared := []byte("shared-binary-asset")
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			unique := []byte(fmt.Sprintf("worker-%d-output", idx))
			res, err := st.IngestHarvested(ctx, media.IngestRequest{
				SessionID: fmt.Sprintf("sess-%d", idx),
				IssueID:   "iss-race",
				ChannelID: "chan-race",
				Outputs: []contract.HarvestedOutput{
					{RelPath: fmt.Sprintf("shared-%d.bin", idx), Data: shared},
					{RelPath: fmt.Sprintf("unique-%d.bin", idx), Data: unique},
				},
			})
			if err != nil {
				t.Errorf("concurrent IngestHarvested %d: %v", idx, err)
				return
			}
			for _, item := range res.Items {
				got, err := st.ReadBytes(ctx, item.SHA256)
				if err != nil || len(got) == 0 {
					t.Errorf("concurrent ReadBytes %s failed: %v", item.SHA256, err)
				}
			}
		}(i)
	}
	wg.Wait()

	stats := st.Stats()
	if stats.UniqueBlobs != 21 {
		t.Fatalf("expected 21 unique blobs (1 shared + 20 unique), got %d", stats.UniqueBlobs)
	}
	if stats.TotalIngests != 40 {
		t.Fatalf("expected 40 total ingests, got %d", stats.TotalIngests)
	}
}

func shaSumHex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

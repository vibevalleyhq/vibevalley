package machine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func TestSkillsReadOnlyMaterialization(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	workDir := t.TempDir()

	env, err := NewLocalEnv(LocalEnvConfig{WorkDir: workDir})
	if err != nil {
		t.Fatalf("NewLocalEnv: %v", err)
	}
	defer env.Close()

	skillData := []byte("# Go Testing Skill\nAlways run go test -race.\n")
	res, err := env.SyncMounts(ctx, contract.MountSyncRequest{
		SessionID: "sess-skills",
		Skills: []contract.MountFile{
			{
				RelPath:  "go-test/SKILL.md",
				Version:  1,
				SHA256:   sha256Hex(skillData),
				Content:  skillData,
				ReadOnly: true,
			},
			{
				RelPath: ".vibe/skills/extra.md",
				Version: 1,
				Content: []byte("extra skill"),
			},
		},
	})
	if err != nil {
		t.Fatalf("SyncMounts skills: %v", err)
	}
	if res.Materialized != 2 {
		t.Fatalf("expected 2 materialized skills, got %d", res.Materialized)
	}

	skillPath := filepath.Join(workDir, ".vibe/skills/go-test/SKILL.md")
	info, err := os.Stat(skillPath)
	if err != nil {
		t.Fatalf("Stat skill: %v", err)
	}
	if info.Mode().Perm() != 0o444 {
		t.Fatalf("expected 0444 read-only mode, got %o", info.Mode().Perm())
	}

	// ExecutionEnv write/edit must refuse modifications inside .vibe/skills/.
	if err := env.WriteAtomic(ctx, ".vibe/skills/go-test/SKILL.md", []byte("tamper"), 0o644); !errors.Is(err, ErrReadOnlyMount) {
		t.Fatalf("expected ErrReadOnlyMount on WriteAtomic, got %v", err)
	}
	if err := env.EditPatch(ctx, ".vibe/skills/go-test/SKILL.md", "Always", "Never"); !errors.Is(err, ErrReadOnlyMount) {
		t.Fatalf("expected ErrReadOnlyMount on EditPatch, got %v", err)
	}

	// Memory-only sync (Skills == nil) keeps materialized skills intact.
	if _, err := env.SyncMounts(ctx, contract.MountSyncRequest{SessionID: "sess-skills"}); err != nil {
		t.Fatalf("memory-only SyncMounts: %v", err)
	}
	if got, err := env.ReadFile(ctx, ".vibe/skills/extra.md"); err != nil || string(got) != "extra skill" {
		t.Fatalf("expected extra.md preserved, got %q err=%v", string(got), err)
	}

	// Updated skill list prunes deleted skill.
	if _, err := env.SyncMounts(ctx, contract.MountSyncRequest{
		SessionID: "sess-skills",
		Skills: []contract.MountFile{
			{RelPath: "go-test/SKILL.md", Version: 1, Content: skillData},
		},
	}); err != nil {
		t.Fatalf("SyncMounts prune: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workDir, ".vibe/skills/extra.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected deleted skill extra.md to be pruned, stat err=%v", err)
	}

	// Checksum mismatch is rejected.
	if _, err := env.SyncMounts(ctx, contract.MountSyncRequest{
		SessionID: "sess-skills",
		Skills: []contract.MountFile{
			{RelPath: "bad.md", SHA256: "0000", Content: []byte("abc")},
		},
	}); !errors.Is(err, ErrChecksumMismatch) {
		t.Fatalf("expected ErrChecksumMismatch, got %v", err)
	}
}

func TestMemoryBidirectionalSyncConflictsAndThrottling(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	workDir := t.TempDir()

	env, err := NewLocalEnv(LocalEnvConfig{WorkDir: workDir})
	if err != nil {
		t.Fatalf("NewLocalEnv: %v", err)
	}
	defer env.Close()

	now := time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	fakeNow := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	advance := func(d time.Duration) {
		mu.Lock()
		now = now.Add(d)
		mu.Unlock()
	}

	syncer := NewMountSyncer(env, MountSyncerConfig{
		ThrottleInterval: DefaultMountSyncInterval, // 15s
		FlushTimeout:     DefaultMountFlushTimeout, // 30s
		Now:              fakeNow,
	})

	v1 := []byte("# Project Facts\n- Go 1.27\n")
	res1, throttled, err := syncer.SyncOnTurn(ctx, contract.MountSyncRequest{
		SessionID: "sess-mem",
		Memories: []contract.MountFile{
			{RelPath: "facts.md", Version: 1, SHA256: sha256Hex(v1), Content: v1},
		},
	})
	if err != nil || throttled || res1.Materialized != 1 {
		t.Fatalf("initial sync failed: res=%+v throttled=%v err=%v", res1, throttled, err)
	}

	localEdit := []byte("# Project Facts\n- Go 1.27\n- Local note\n")
	if err := env.WriteAtomic(ctx, ".vibe/memory/facts.md", localEdit, 0o644); err != nil {
		t.Fatalf("local edit: %v", err)
	}
	advance(5 * time.Second)
	if _, throttled, err := syncer.SyncOnTurn(ctx, contract.MountSyncRequest{
		SessionID: "sess-mem",
		Memories: []contract.MountFile{
			{RelPath: "facts.md", Version: 1, SHA256: sha256Hex(v1), Content: v1},
		},
	}); err != nil || !throttled {
		t.Fatalf("expected sync at +5s to be throttled, throttled=%v err=%v", throttled, err)
	}

	advance(10 * time.Second)
	res2, throttled, err := syncer.SyncOnTurn(ctx, contract.MountSyncRequest{
		SessionID: "sess-mem",
		Memories: []contract.MountFile{
			{RelPath: "facts.md", Version: 1, SHA256: sha256Hex(v1), Content: v1},
		},
	})
	if err != nil || throttled {
		t.Fatalf("expected sync at +15s to execute, throttled=%v err=%v", throttled, err)
	}
	if len(res2.Uploaded) != 1 || res2.Uploaded[0].BaseVersion != 1 || res2.Uploaded[0].SHA256 != sha256Hex(localEdit) {
		t.Fatalf("unexpected uploaded list: %+v", res2.Uploaded)
	}

	serverV2 := []byte("# Project Facts\n- Go 1.27\n- Server concurrent edit\n")
	res3, err := syncer.Flush(ctx, contract.MountSyncRequest{
		SessionID: "sess-mem",
		Memories: []contract.MountFile{
			{RelPath: "facts.md", Version: 2, SHA256: sha256Hex(serverV2), Content: serverV2},
		},
	})
	if err != nil {
		t.Fatalf("Flush conflict sync: %v", err)
	}
	if len(res3.Conflicts) != 1 {
		t.Fatalf("expected 1 MountConflict, got %+v", res3.Conflicts)
	}
	c := res3.Conflicts[0]
	if c.RelPath != "facts.md" || c.BaseVersion != 1 || c.ServerVersion != 2 || c.UploadedSHA256 != sha256Hex(localEdit) {
		t.Fatalf("unexpected conflict metadata: %+v", c)
	}

	preserved, err := env.ReadFile(ctx, c.ConflictRelPath)
	if err != nil {
		t.Fatalf("ReadFile(%s): %v", c.ConflictRelPath, err)
	}
	if !bytes.Equal(preserved, localEdit) {
		t.Fatalf("conflict file content mismatch: got %q want %q", preserved, localEdit)
	}
	current, err := env.ReadFile(ctx, ".vibe/memory/facts.md")
	if err != nil || !bytes.Equal(current, serverV2) {
		t.Fatalf("expected facts.md updated to server v2 after preserving conflict, got %q err=%v", current, err)
	}

	res4, err := syncer.Flush(ctx, contract.MountSyncRequest{
		SessionID: "sess-mem",
		Memories: []contract.MountFile{
			{RelPath: "facts.md", Version: 2, SHA256: sha256Hex(serverV2), Content: serverV2},
		},
	})
	if err != nil {
		t.Fatalf("post-conflict Flush: %v", err)
	}
	if len(res4.Uploaded) != 0 || len(res4.Conflicts) != 0 {
		t.Fatalf("expected steady state after conflict preservation, got %+v", res4)
	}
}

type fakeOutputSink struct {
	mu    sync.Mutex
	items map[string][]byte
	metas map[string]OutputMeta
}

func (s *fakeOutputSink) UploadOutput(_ context.Context, _ string, meta OutputMeta, r io.Reader) error {
	data, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.items == nil {
		s.items = make(map[string][]byte)
		s.metas = make(map[string]OutputMeta)
	}
	s.items[meta.RelPath] = data
	s.metas[meta.RelPath] = meta
	return nil
}

func TestHarvestOutputsSHA256AndStreaming(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	outsideFile := filepath.Join(t.TempDir(), "host-secret.txt")
	if err := os.WriteFile(outsideFile, []byte("forbidden"), 0o644); err != nil {
		t.Fatalf("write outside: %v", err)
	}

	workDir := t.TempDir()
	env, err := NewLocalEnv(LocalEnvConfig{WorkDir: workDir})
	if err != nil {
		t.Fatalf("NewLocalEnv: %v", err)
	}
	defer env.Close()

	// Empty outputs dir yields empty slice, no error.
	empty, err := env.HarvestOutputs(ctx)
	if err != nil || len(empty) != 0 {
		t.Fatalf("expected empty harvest, got %+v err=%v", empty, err)
	}

	chartPayload := bytes.Repeat([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n', 1, 2, 3, 4}, 9000) // > 100 KB multi-chunk
	reportPayload := []byte(`{"status":"ok","count":42}`)

	if err := env.WriteAtomic(ctx, ".vibe/outputs/charts/perf.png", chartPayload, 0o644); err != nil {
		t.Fatalf("write chart: %v", err)
	}
	if err := env.WriteAtomic(ctx, ".vibe/outputs/summary.json", reportPayload, 0o644); err != nil {
		t.Fatalf("write report: %v", err)
	}
	// Symlink inside .vibe/outputs/ pointing outside workspace must be ignored.
	if err := os.Symlink(outsideFile, filepath.Join(workDir, ".vibe/outputs/leak.txt")); err != nil {
		t.Fatalf("symlink output: %v", err)
	}

	harvested, err := env.HarvestOutputs(ctx)
	if err != nil {
		t.Fatalf("HarvestOutputs: %v", err)
	}
	if len(harvested) != 2 {
		t.Fatalf("expected 2 harvested outputs (symlink excluded), got %d: %+v", len(harvested), harvested)
	}

	// Sorted order: charts/perf.png then summary.json.
	if harvested[0].RelPath != "charts/perf.png" || harvested[1].RelPath != "summary.json" {
		t.Fatalf("unexpected RelPaths: %+v", []string{harvested[0].RelPath, harvested[1].RelPath})
	}

	wantChartSum := sha256.Sum256(chartPayload)
	if harvested[0].SHA256 != hex.EncodeToString(wantChartSum[:]) ||
		harvested[0].Size != int64(len(chartPayload)) ||
		harvested[0].MimeType != "image/png" ||
		!bytes.Equal(harvested[0].Data, chartPayload) {
		t.Fatalf("chart harvest mismatch: sha=%s size=%d mime=%s", harvested[0].SHA256, harvested[0].Size, harvested[0].MimeType)
	}

	wantReportSum := sha256.Sum256(reportPayload)
	if harvested[1].SHA256 != hex.EncodeToString(wantReportSum[:]) ||
		harvested[1].Size != int64(len(reportPayload)) ||
		!bytes.Equal(harvested[1].Data, reportPayload) {
		t.Fatalf("report harvest mismatch: %+v", harvested[1])
	}

	// Streaming harvest delivers identical SHA-256 and bytes via io.Reader.
	sink := &fakeOutputSink{}
	metas, err := env.HarvestStream(ctx, "sess-out", sink)
	if err != nil {
		t.Fatalf("HarvestStream: %v", err)
	}
	if len(metas) != 2 {
		t.Fatalf("expected 2 streamed metas, got %d", len(metas))
	}
	if !bytes.Equal(sink.items["charts/perf.png"], chartPayload) || sink.metas["charts/perf.png"].SHA256 != harvested[0].SHA256 {
		t.Fatal("streamed chart payload or hash mismatch")
	}
}

type blockingMountRemote struct {
	ack   MountPushAck
	err   error
	delay time.Duration
}

func (b *blockingMountRemote) PushMemories(ctx context.Context, _ string, _ []contract.MountFile) (MountPushAck, error) {
	if b.delay > 0 {
		timer := time.NewTimer(b.delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return MountPushAck{}, ctx.Err()
		case <-timer.C:
		}
	}
	return b.ack, b.err
}

func TestMountRemotePushConflictAndFlushTimeout(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	serverV2 := []byte("server-v2-winner")
	remote := &blockingMountRemote{
		ack: MountPushAck{
			Conflicts: []contract.MountConflict{
				{
					RelPath:       "shared.md",
					BaseVersion:   1,
					ServerVersion: 2,
				},
			},
			Latest: []contract.MountFile{
				{RelPath: "shared.md", Version: 2, SHA256: sha256Hex(serverV2), Content: serverV2},
			},
		},
	}

	env, err := NewLocalEnv(LocalEnvConfig{
		WorkDir:     t.TempDir(),
		MountRemote: remote,
	})
	if err != nil {
		t.Fatalf("NewLocalEnv: %v", err)
	}
	defer env.Close()

	v1 := []byte("v1-shared")
	if _, err := env.SyncMounts(ctx, contract.MountSyncRequest{
		SessionID: "sess-remote",
		Memories: []contract.MountFile{
			{RelPath: "shared.md", Version: 1, SHA256: sha256Hex(v1), Content: v1},
		},
	}); err != nil {
		t.Fatalf("seed SyncMounts: %v", err)
	}

	localV2 := []byte("local-v2-concurrent")
	if err := env.WriteAtomic(ctx, ".vibe/memory/shared.md", localV2, 0o644); err != nil {
		t.Fatalf("local edit: %v", err)
	}
	res, err := env.SyncMounts(ctx, contract.MountSyncRequest{
		SessionID: "sess-remote",
		Memories: []contract.MountFile{
			{RelPath: "shared.md", Version: 1, SHA256: sha256Hex(v1), Content: v1},
		},
	})
	if err != nil {
		t.Fatalf("SyncMounts remote conflict: %v", err)
	}
	if len(res.Conflicts) != 1 {
		t.Fatalf("expected 1 remote conflict, got %+v", res.Conflicts)
	}
	preserved, err := env.ReadFile(ctx, res.Conflicts[0].ConflictRelPath)
	if err != nil || !bytes.Equal(preserved, localV2) {
		t.Fatalf("expected preserved local edit %q, got %q err=%v", localV2, preserved, err)
	}
	winner, err := env.ReadFile(ctx, ".vibe/memory/shared.md")
	if err != nil || !bytes.Equal(winner, serverV2) {
		t.Fatalf("expected server winner %q, got %q err=%v", serverV2, winner, err)
	}

	slowEnv, err := NewLocalEnv(LocalEnvConfig{
		WorkDir:     t.TempDir(),
		MountRemote: &blockingMountRemote{delay: 2 * time.Second},
	})
	if err != nil {
		t.Fatalf("NewLocalEnv slow: %v", err)
	}
	defer slowEnv.Close()
	if err := slowEnv.WriteAtomic(ctx, ".vibe/memory/new.md", []byte("pending"), 0o644); err != nil {
		t.Fatalf("write new.md: %v", err)
	}
	syncer := NewMountSyncer(slowEnv, MountSyncerConfig{
		ThrottleInterval: DefaultMountSyncInterval,
		FlushTimeout:     80 * time.Millisecond,
	})
	if _, err := syncer.Flush(ctx, contract.MountSyncRequest{SessionID: "sess-timeout"}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected context.DeadlineExceeded on Flush timeout, got %v", err)
	}
}

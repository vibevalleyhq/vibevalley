package machine

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func TestConcurrentEditPatchAndWriteAtomic(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	root := t.TempDir()

	env, err := NewLocalEnv(LocalEnvConfig{
		EnvID:   "env-concurrent",
		WorkDir: root,
	})
	if err != nil {
		t.Fatalf("NewLocalEnv: %v", err)
	}
	defer env.Close()

	// Seed a file with 24 distinct lines that concurrent goroutines will patch independently.
	const workers = 24
	var initLines strings.Builder
	for i := range workers {
		fmt.Fprintf(&initLines, "item-%02d=pending\n", i)
	}
	if err := env.WriteAtomic(ctx, "config/items.txt", []byte(initLines.String()), 0o640); err != nil {
		t.Fatalf("seed WriteAtomic: %v", err)
	}

	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for i := range workers {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			oldLine := fmt.Sprintf("item-%02d=pending", idx)
			newLine := fmt.Sprintf("item-%02d=done", idx)
			if err := env.EditPatch(ctx, "config/items.txt", oldLine, newLine); err != nil {
				errs <- err
			}
		}(i)
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		t.Fatalf("concurrent EditPatch failed: %v", err)
	}

	got, err := env.ReadFile(ctx, "config/items.txt")
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	for i := range workers {
		want := fmt.Sprintf("item-%02d=done", i)
		if !strings.Contains(string(got), want) {
			t.Fatalf("lost concurrent edit %q in:\n%s", want, string(got))
		}
	}

	info, err := os.Stat(filepath.Join(root, "config/items.txt"))
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if info.Mode().Perm() != 0o640 {
		t.Fatalf("expected perm 0640 preserved, got %o", info.Mode().Perm())
	}

	// Concurrent WriteAtomic + ReadFile on the same path must never yield partial reads.
	const writeRounds = 40
	payloadA := strings.Repeat("A", 4096)
	payloadB := strings.Repeat("B", 4096)
	if err := env.WriteAtomic(ctx, "blob.txt", []byte(payloadA), 0o644); err != nil {
		t.Fatalf("init blob: %v", err)
	}

	var rwWG sync.WaitGroup
	rwErrs := make(chan error, writeRounds*2)
	for i := range writeRounds {
		rwWG.Add(2)
		data := payloadA
		if i%2 == 1 {
			data = payloadB
		}
		go func(b string) {
			defer rwWG.Done()
			if err := env.WriteAtomic(ctx, "blob.txt", []byte(b), 0o644); err != nil {
				rwErrs <- err
			}
		}(data)
		go func() {
			defer rwWG.Done()
			b, err := env.ReadFile(ctx, "blob.txt")
			if err != nil {
				rwErrs <- err
				return
			}
			s := string(b)
			if s != payloadA && s != payloadB {
				rwErrs <- fmt.Errorf("torn read of length %d", len(s))
			}
		}()
	}
	rwWG.Wait()
	close(rwErrs)
	for err := range rwErrs {
		t.Fatalf("concurrent WriteAtomic/ReadFile error: %v", err)
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".vibe-tmp-") {
			t.Fatalf("leaked temp file: %s", entry.Name())
		}
	}
}

func TestPathTraversalAndSymlinkEscapeBlocked(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	outsideDir := t.TempDir()
	outsideFile := filepath.Join(outsideDir, "secret.txt")
	if err := os.WriteFile(outsideFile, []byte("top-secret"), 0o644); err != nil {
		t.Fatalf("write outside file: %v", err)
	}

	workDir := t.TempDir()
	env, err := NewLocalEnv(LocalEnvConfig{
		EnvID:   "env-security",
		WorkDir: workDir,
	})
	if err != nil {
		t.Fatalf("NewLocalEnv: %v", err)
	}
	defer env.Close()

	if err := os.Symlink(outsideDir, filepath.Join(workDir, "escape-dir")); err != nil {
		t.Fatalf("symlink dir: %v", err)
	}
	if err := os.Symlink(outsideFile, filepath.Join(workDir, "escape-file")); err != nil {
		t.Fatalf("symlink file: %v", err)
	}

	badPaths := []string{
		"",
		".",
		"../secret.txt",
		"sub/../../secret.txt",
		"/etc/passwd",
		"\\etc\\passwd",
		"bad\x00path",
		"escape-file",
		"escape-dir/secret.txt",
		"escape-dir/new.txt",
	}

	for _, p := range badPaths {
		if _, err := env.ReadFile(ctx, p); err == nil {
			t.Errorf("ReadFile(%q) unexpectedly succeeded", p)
		}
		if err := env.WriteAtomic(ctx, p, []byte("x"), 0o644); err == nil {
			t.Errorf("WriteAtomic(%q) unexpectedly succeeded", p)
		}
		if err := env.EditPatch(ctx, p, "a", "b"); err == nil {
			t.Errorf("EditPatch(%q) unexpectedly succeeded", p)
		}
	}
}

func TestEditPatchValidation(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	env, err := NewLocalEnv(LocalEnvConfig{WorkDir: t.TempDir()})
	if err != nil {
		t.Fatalf("NewLocalEnv: %v", err)
	}
	defer env.Close()

	if err := env.WriteAtomic(ctx, "dup.txt", []byte("dup\ndup\n"), 0o644); err != nil {
		t.Fatalf("WriteAtomic: %v", err)
	}
	if err := env.EditPatch(ctx, "dup.txt", "missing", "x"); !errors.Is(err, ErrPatchTargetNotFound) {
		t.Fatalf("expected ErrPatchTargetNotFound, got %v", err)
	}
	if err := env.EditPatch(ctx, "dup.txt", "dup", "x"); !errors.Is(err, ErrPatchTargetAmbiguous) {
		t.Fatalf("expected ErrPatchTargetAmbiguous, got %v", err)
	}
}

type countingAcquirer struct {
	inner        LeaseAcquirer
	acquireCalls atomic.Int32
	releaseCalls atomic.Int32
	blockOnce    chan struct{}
}

func (c *countingAcquirer) Acquire(ctx context.Context, req LeaseRequest) (Lease, contract.ExecutionEnv, error) {
	c.acquireCalls.Add(1)
	if c.blockOnce != nil {
		select {
		case <-c.blockOnce:
		case <-ctx.Done():
			return Lease{}, nil, ctx.Err()
		}
	}
	return c.inner.Acquire(ctx, req)
}

func (c *countingAcquirer) Release(ctx context.Context, lease Lease) error {
	c.releaseCalls.Add(1)
	return c.inner.Release(ctx, lease)
}

func TestLazyLeasePureChatZeroBlockingAndOnDemandProvisioning(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	workRoot := filepath.Join(t.TempDir(), "work-root")

	tracker, err := NewLeaseTracker(LeaseTrackerConfig{
		MachineID: "m-lazy",
		WorkRoot:  workRoot,
		Labels:    []string{"go", "linux"},
	})
	if err != nil {
		t.Fatalf("NewLeaseTracker: %v", err)
	}
	defer tracker.CloseAll()

	// Creating tracker and LazyEnv for pure chat must NOT create workRoot or acquire any lease.
	counter := &countingAcquirer{inner: tracker}
	chatOnlyEnv := NewLazyEnv(LeaseRequest{
		SessionID:      "sess-chat-only",
		RequiredLabels: []string{"go"},
	}, counter)

	if chatOnlyEnv.HasLease() {
		t.Fatal("pure chat LazyEnv acquired lease prematurely")
	}
	if _, ok := chatOnlyEnv.Lease(); ok {
		t.Fatal("pure chat LazyEnv exposed lease before first tool call")
	}
	if counter.acquireCalls.Load() != 0 {
		t.Fatalf("expected 0 acquire calls during pure chat, got %d", counter.acquireCalls.Load())
	}
	if _, err := os.Stat(workRoot); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("workRoot %s should not exist before first lease, stat err=%v", workRoot, err)
	}
	if err := chatOnlyEnv.Close(); err != nil {
		t.Fatalf("Close pure chat env: %v", err)
	}
	if counter.acquireCalls.Load() != 0 || counter.releaseCalls.Load() != 0 {
		t.Fatalf("pure chat close triggered acquire/release: %d/%d", counter.acquireCalls.Load(), counter.releaseCalls.Load())
	}

	// First concurrent tool calls share a single on-demand lease acquisition.
	gate := make(chan struct{})
	gatedCounter := &countingAcquirer{inner: tracker, blockOnce: gate}
	toolEnv := NewLazyEnv(LeaseRequest{
		SessionID:      "sess-tools",
		RequiredLabels: []string{"go", "linux"},
		TTL:            time.Minute,
	}, gatedCounter)

	const callers = 8
	var wg sync.WaitGroup
	errs := make(chan error, callers)
	for i := range callers {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			name := fmt.Sprintf("f-%d.txt", idx)
			if err := toolEnv.WriteAtomic(ctx, name, []byte(name), 0o644); err != nil {
				errs <- err
			}
		}(i)
	}
	close(gate)
	wg.Wait()
	close(errs)

	for err := range errs {
		t.Fatalf("concurrent lazy WriteAtomic: %v", err)
	}
	if got := gatedCounter.acquireCalls.Load(); got != 1 {
		t.Fatalf("expected exactly 1 lazy lease acquisition across concurrent calls, got %d", got)
	}
	lease, ok := toolEnv.Lease()
	if !ok || lease.SessionID != "sess-tools" || lease.MachineID != "m-lazy" {
		t.Fatalf("unexpected lease: ok=%v lease=%+v", ok, lease)
	}
	if err := toolEnv.Close(); err != nil {
		t.Fatalf("toolEnv.Close: %v", err)
	}
	if got := gatedCounter.releaseCalls.Load(); got != 1 {
		t.Fatalf("expected 1 release on close, got %d", got)
	}

	// Missing required label is rejected cleanly when tool call triggers Acquire.
	badLabelEnv := NewLazyEnv(LeaseRequest{
		SessionID:      "sess-gpu",
		RequiredLabels: []string{"gpu"},
	}, tracker)
	if err := badLabelEnv.WriteAtomic(ctx, "a.txt", []byte("a"), 0o644); !errors.Is(err, ErrNoMatchingTag) {
		t.Fatalf("expected ErrNoMatchingTag, got %v", err)
	}
}

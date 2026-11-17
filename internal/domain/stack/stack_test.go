package stack_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/agent"
	"github.com/vibevalleyhq/vibevalley/internal/domain/attachment"
	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/internal/domain/issue"
	"github.com/vibevalleyhq/vibevalley/internal/domain/media"
	"github.com/vibevalleyhq/vibevalley/internal/domain/memory"
	"github.com/vibevalleyhq/vibevalley/internal/domain/pkm"
	"github.com/vibevalleyhq/vibevalley/internal/domain/setting"
	"github.com/vibevalleyhq/vibevalley/internal/domain/stack"
	"github.com/vibevalleyhq/vibevalley/internal/durable"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
	"github.com/vibevalleyhq/vibevalley/internal/machine"
	"github.com/vibevalleyhq/vibevalley/internal/vault"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/delta"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/link"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func TestStackSQLitePersistenceAndRestart(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	dir := t.TempDir()
	dbPath := filepath.Join(dir, "platform.db")
	workRoot := filepath.Join(dir, "work")

	rawRoot := make([]byte, vault.RootKeySize)
	for i := range rawRoot {
		rawRoot[i] = byte(i + 1)
	}
	rk, err := vault.NewRootKey("test-rk-1", rawRoot)
	if err != nil {
		t.Fatal(err)
	}

	s1, err := stack.New(ctx, stack.Config{
		DBPath:       dbPath,
		WorkRoot:     workRoot,
		VaultRootKey: &rk,
	})
	if err != nil {
		t.Fatalf("stack.New(1): %v", err)
	}

	// Persist secret in Vault.
	secretPlain := "sk-super-secret-value-9988"
	if err := s1.Vault.Put(ctx, vault.Credential{
		ID:           "cred-openai",
		Kind:         vault.KindProviderAPIKey,
		Name:         "test-provider",
		TargetHosts:  []string{"api.example.com"},
		HeaderName:   "Authorization",
		HeaderPrefix: "Bearer ",
		Value:        vault.NewSecret(secretPlain),
	}); err != nil {
		t.Fatalf("Vault.Put: %v", err)
	}

	// Persist PKM note, Memory snapshot, Issue, and Channel event.
	if _, err := s1.PKM.UpsertNote(ctx, pkm.NoteInput{
		RelPath: "1_Projects/go-stack.md",
		Content: []byte("---\ntitle: Go Stack\n---\nDurable wiring with [[Architecture]].\n"),
	}); err != nil {
		t.Fatalf("PKM.UpsertNote: %v", err)
	}
	if _, err := s1.Memory.CommitFiles(ctx, memory.CommitRequest{
		ScopeID: memory.DefaultScopeID,
		Files: []memory.MemoryFileInput{
			{RelPath: "facts.md", Content: []byte("fact-1\n")},
		},
	}); err != nil {
		t.Fatalf("Memory.CommitFiles: %v", err)
	}
	if _, err := s1.Channels.CreateChannel(ctx, channel.Channel{
		ID:   "ch-main",
		Type: channel.TypePublic,
		Name: "main",
	}); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if _, _, err := s1.PostAndPumpChannel(ctx, channel.AppendRequest{
		ChannelID: "ch-main",
		Kind:      contract.ChannelEventMessage,
		AuthorID:  "owner",
		ActorKind: channel.ActorUser,
		Text:      "hello persisted channel",
	}); err != nil {
		t.Fatalf("PostAndPumpChannel: %v", err)
	}
	if _, err := s1.Issues.CreateIssue(ctx, issue.Issue{
		ID:          "iss-persist-1",
		Title:       "Persisted task",
		RepoID:      "repo-1",
		Description: "Verify SQLite WAL reload",
	}); err != nil {
		t.Fatalf("CreateIssue: %v", err)
	}

	if err := s1.Close(); err != nil {
		t.Fatalf("s1.Close: %v", err)
	}
	assertZeroSidecarDBFiles(t, dir, "platform")

	// Reopen Stack on the same DBPath & VaultRootKey.
	s2, err := stack.New(ctx, stack.Config{
		DBPath:       dbPath,
		WorkRoot:     workRoot,
		VaultRootKey: &rk,
	})
	if err != nil {
		t.Fatalf("stack.New(2): %v", err)
	}
	defer func() { _ = s2.Close() }()
	assertZeroSidecarDBFiles(t, dir, "platform")

	cred, err := s2.Vault.Get(ctx, "cred-openai")
	if err != nil || cred.Value.Reveal() != secretPlain {
		t.Fatalf("reopened Vault.Get: err=%v got=%q", err, cred.Value.Reveal())
	}

	hits, err := s2.PKM.Search(ctx, pkm.SearchQuery{Text: "Durable", Limit: 5})
	if err != nil || len(hits) == 0 {
		t.Fatalf("reopened PKM.Search: hits=%d err=%v", len(hits), err)
	}
	memFiles, err := s2.Memory.MaterializeFiles(ctx, memory.DefaultScopeID)
	if err != nil || len(memFiles) != 1 || string(memFiles[0].Content) != "fact-1\n" {
		t.Fatalf("reopened Memory.MaterializeFiles: files=%+v err=%v", memFiles, err)
	}
	evts, err := s2.Channels.ListEvents(ctx, "ch-main", 0, 10)
	if err != nil || len(evts) != 1 || evts[0].Text != "hello persisted channel" {
		t.Fatalf("reopened Channels.ListEvents: evts=%+v err=%v", evts, err)
	}
	iss, err := s2.Issues.GetIssue(ctx, "iss-persist-1")
	if err != nil || iss.Title != "Persisted task" {
		t.Fatalf("reopened Issues.GetIssue: iss=%+v err=%v", iss, err)
	}
}

type scriptStepModel struct {
	step int
}

func (m *scriptStepModel) Generate(_ context.Context, req durable.ModelRequest, _ func(string)) (durable.ModelResponse, error) {
	m.step++
	cost := int64(100)
	if strings.Contains(req.ConversationID, "perm") && m.step == 1 {
		args, _ := json.Marshal(map[string]any{"command": "rm -rf /tmp/sensitive"})
		return durable.ModelResponse{
			ToolCalls: []durable.ToolCall{
				{ID: "call-perm-1", ToolName: "bash", ArgsJSON: args},
			},
			Usage: &contract.UsageTotals{CostMicros: &cost},
		}, nil
	}
	return durable.ModelResponse{
		Text:  "completed safely",
		Usage: &contract.UsageTotals{CostMicros: &cost},
	}, nil
}

func TestStackClientLinkRPCWatchGovernanceAndMachines(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	permCfg := durable.DefaultPermissionConfig()
	permCfg.Overrides = map[string]contract.PermissionPolicy{
		"bash": contract.PolicyAlwaysAsk,
	}

	alertsCh := make(chan durable.Alert, 8)
	s, err := stack.New(ctx, stack.Config{
		PermissionConfig: &permCfg,
		Model:            &scriptStepModel{},
		Tools: durable.ToolExecutorFunc(func(_ context.Context, _ string, call durable.ToolCall) (json.RawMessage, error) {
			return json.RawMessage(`{"executed":true}`), nil
		}),
		AlertHandler: func(a durable.Alert) {
			alertsCh <- a
		},
	})
	if err != nil {
		t.Fatalf("stack.New: %v", err)
	}
	defer func() { _ = s.Close() }()

	// Connect a client Link over memory pipe and watch SpaceView.
	clientPipe, serverPipe := link.NewMemoryPipe()
	attachErr := make(chan error, 1)
	go func() {
		_, err := s.AttachClientLink(ctx, serverPipe)
		attachErr <- err
	}()
	clientLink := link.NewLink(clientPipe, link.Options{
		Principal:  link.Principal{Kind: link.PrincipalUserDevice, ID: "client-dev-1"},
		SidePrefix: "cli",
	})
	if err := clientLink.Start(ctx); err != nil {
		t.Fatalf("clientLink.Start: %v", err)
	}
	if err := <-attachErr; err != nil {
		t.Fatalf("AttachClientLink: %v", err)
	}
	defer func() { _ = clientLink.Close() }()

	// Watch "space" document deltas from rev 0.
	spaceDocCh := make(chan contract.SpaceView, 16)
	var curSnap *delta.Snapshot
	sub, err := clientLink.OpenWatch(ctx, "space", 0, nil, func(_ context.Context, ev link.WatchEvent) {
		if ev.Snapshot != nil {
			curSnap = ev.Snapshot
		} else if len(ev.Ops) > 0 && curSnap != nil {
			if next, err := curSnap.Apply(ev.Ops...); err == nil {
				curSnap = next
			}
		}
		if curSnap != nil {
			b, _ := json.Marshal(curSnap.Value())
			var sv contract.SpaceView
			if json.Unmarshal(b, &sv) == nil {
				spaceDocCh <- sv
			}
		}
	}, nil)
	if err != nil {
		t.Fatalf("OpenWatch: %v", err)
	}
	defer sub.Stop()

	// Test permission park + SpaceView approval projection + RPC approval.resolve.
	if _, err := s.Store.CreateConversation(ctx, store.Conversation{ID: "conv-perm-1"}); err != nil {
		t.Fatal(err)
	}
	cpBytes, _ := json.Marshal(durable.GenerationCheckpoint{
		ConversationID: "conv-perm-1",
		TaskPrompt:     "run bash",
		Tools:          []durable.ToolSpec{{Name: "bash"}},
	})
	if _, err := s.Scheduler.StartTask(ctx, store.Task{
		ID:             "task-perm-1",
		ConversationID: "conv-perm-1",
		Kind:           durable.TaskKindGeneration,
		PhaseName:      durable.PhaseGenerate,
		IsModelTask:    true,
		CheckpointJSON: cpBytes,
	}); err != nil {
		t.Fatal(err)
	}

	// Wait deterministically for permission alert + SpaceView approval.
	for {
		select {
		case sv := <-spaceDocCh:
			if len(sv.Approvals) == 1 && sv.Approvals[0].TaskID == "task-perm-1" {
				goto approvalSeen
			}
		case <-ctx.Done():
			t.Fatalf("timed out waiting for SpaceView approval")
		}
	}
approvalSeen:

	var ack map[string]bool
	if err := clientLink.Call(ctx, "approval.resolve", map[string]any{
		"taskId":   "task-perm-1",
		"approved": true,
		"reason":   "approved via client RPC",
	}, &ack); err != nil {
		t.Fatalf("approval.resolve RPC: %v", err)
	}

	doneTask, err := s.Scheduler.WaitTask(ctx, "task-perm-1")
	if err != nil || doneTask.Status != store.TaskTerminal || doneTask.TerminalReason != store.ReasonCompleted {
		t.Fatalf("expected task-perm-1 completed, got %+v err=%v", doneTask, err)
	}

	// Connect a mock remote vibe-machine over pipe, verify lazy lease, mount sync, and media harvest.
	mWork := t.TempDir()
	node, err := machine.NewNode(machine.NodeConfig{
		MachineID: "mach-1",
		WorkRoot:  mWork,
		Labels:    []string{"darwin"},
	})
	if err != nil {
		t.Fatalf("NewNode: %v", err)
	}
	defer func() { _ = node.Close() }()

	mClientPipe, mServerPipe := link.NewMemoryPipe()
	mLink := link.NewLink(mClientPipe, link.Options{
		Principal:  link.Principal{Kind: link.PrincipalMachineNode, ID: "mach-1"},
		SidePrefix: "mach",
	})
	mLink.HandleRPC("machine.info", func(_ context.Context, _ json.RawMessage) (any, error) {
		return stack.MachineInfo{MachineID: "mach-1", WorkRoot: mWork, Labels: []string{"darwin"}}, nil
	})
	mLink.HandleRPC("env.lease.acquire", func(rCtx context.Context, raw json.RawMessage) (any, error) {
		var req machine.LeaseRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, err
		}
		l, _, err := node.Leases().Acquire(rCtx, req)
		return l, err
	})
	mLink.HandleRPC("env.sync", func(rCtx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			LeaseID string                    `json:"leaseId"`
			Req     contract.MountSyncRequest `json:"req"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		_, env, ok := node.Leases().Get(p.LeaseID)
		if !ok {
			return nil, errors.New("lease not found")
		}
		return env.SyncMounts(rCtx, p.Req)
	})
	mLink.HandleRPC("env.write", func(rCtx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			LeaseID string `json:"leaseId"`
			RelPath string `json:"relPath"`
			Data    []byte `json:"data"`
			Perm    uint32 `json:"perm"`
		}
		_ = json.Unmarshal(raw, &p)
		_, env, _ := node.Leases().Get(p.LeaseID)
		return map[string]bool{"ok": true}, env.WriteAtomic(rCtx, p.RelPath, p.Data, p.Perm)
	})
	mLink.HandleRPC("env.harvest", func(rCtx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			LeaseID string `json:"leaseId"`
		}
		_ = json.Unmarshal(raw, &p)
		_, env, _ := node.Leases().Get(p.LeaseID)
		return env.HarvestOutputs(rCtx)
	})
	mLink.HandleRPC("env.lease.release", func(rCtx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			LeaseID string `json:"leaseId"`
		}
		_ = json.Unmarshal(raw, &p)
		return map[string]bool{"released": true}, node.Leases().Release(rCtx, machine.Lease{ID: p.LeaseID})
	})

	mStartErr := make(chan error, 1)
	go func() {
		mStartErr <- mLink.Start(ctx)
	}()

	if _, err := s.Machines.ServeTransport(ctx, mServerPipe); err != nil {
		t.Fatalf("ServeTransport: %v", err)
	}
	if err := <-mStartErr; err != nil {
		t.Fatalf("mLink.Start: %v", err)
	}
	defer func() { _ = mLink.Close() }()
	if ids, err := s.Machines.WaitOnline(ctx, 1); err != nil || len(ids) != 1 || ids[0] != "mach-1" {
		t.Fatalf("WaitOnline: ids=%v err=%v", ids, err)
	}

	// Lazy env acquires nothing until first use.
	if _, err := s.Agents.SaveProfile(ctx, agent.Profile{
		ID:      "coder",
		Name:    "Coder",
		Role:    agent.RoleWorker,
		Runtime: "claude",
		Skills:  []string{"vibevalley"},
	}); err != nil {
		t.Fatal(err)
	}
	lazy := s.Machines.NewLazyEnv(machine.LeaseRequest{SessionID: "sess-lazy-1", RequiredLabels: []string{"darwin"}})
	if len(s.Machines.ListLeases("sess-lazy-1")) != 0 {
		t.Fatalf("expected 0 leases before first tool use")
	}

	if _, err := s.Machines.SyncProfileMounts(ctx, lazy, memory.DefaultScopeID, "coder", "sess-lazy-1"); err != nil {
		t.Fatalf("SyncProfileMounts: %v", err)
	}
	if len(s.Machines.ListLeases("sess-lazy-1")) != 1 {
		t.Fatalf("expected 1 lease after first use")
	}
	if err := lazy.WriteAtomic(ctx, ".vibe/outputs/hello.txt", []byte("artifact-payload"), 0o644); err != nil {
		t.Fatalf("WriteAtomic output: %v", err)
	}
	ing, err := s.Machines.HarvestToMedia(ctx, lazy, media.IngestMetadata{SessionID: "sess-lazy-1"})
	if err != nil || len(ing.Items) != 1 {
		t.Fatalf("HarvestToMedia: ing=%+v err=%v", ing, err)
	}
	if err := lazy.Close(); err != nil {
		t.Fatalf("lazy.Close: %v", err)
	}
}

func TestStackWave1WiringEphemeralZeroNetwork(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	s, err := stack.New(ctx, stack.Config{
		DBPath:   ":memory:",
		WorkRoot: t.TempDir(),
		Version:  "0.1.0-test",
		Getenv:   func(string) string { return "" },
	})
	if err != nil {
		t.Fatalf("stack.New(:memory:): %v", err)
	}
	defer func() { _ = s.Close() }()

	if s.Setting == nil || s.User == nil || s.Attachments == nil || s.LAN == nil ||
		s.MCP == nil || s.Connectors == nil || s.Voice == nil || s.Provider == nil ||
		s.DomainTools == nil || s.Orchestrator == nil {
		t.Fatalf("expected all Wave 1 modules wired on Stack")
	}
	if s.HomeDir() != "" {
		t.Fatalf("expected empty HomeDir for ephemeral :memory: stack, got %q", s.HomeDir())
	}
	if s.Version() != "0.1.0-test" {
		t.Fatalf("Version() = %q", s.Version())
	}

	gotCh := make(chan int64, 4)
	unsub := s.SubscribeStateChange(func(seq int64) {
		gotCh <- seq
	})
	defer unsub()

	seq := s.NotifyStateChange()
	if seq <= 0 || s.StateSeq() != seq {
		t.Fatalf("expected positive monotonic StateSeq, got %d vs %d", seq, s.StateSeq())
	}
	select {
	case notified := <-gotCh:
		if notified != seq {
			t.Fatalf("expected notified seq %d, got %d", seq, notified)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for StateChange notification")
	}

	// Verify DomainTools list non-empty specs and Attachment/Setting work with zero network.
	if specs := s.DomainTools.Specs(); len(specs) == 0 {
		t.Fatal("expected registered domain tools on DomainToolRegistry")
	}
	localeEn := "en"
	if _, err := s.Setting.Update(ctx, setting.SettingsUpdate{Locale: &localeEn}); err != nil {
		t.Fatalf("Setting.Update: %v", err)
	}
	if _, err := s.Attachments.CreateFromBase64(ctx, attachment.AttachmentUpload{
		Name: "note.txt",
		Type: "text/plain",
		Data: base64.StdEncoding.EncodeToString([]byte("hello wave2")),
	}); err != nil {
		t.Fatalf("Attachments.CreateFromBase64: %v", err)
	}
}

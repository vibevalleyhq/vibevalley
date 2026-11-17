package stack_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/agent"
	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/internal/domain/stack"
	domainwatch "github.com/vibevalleyhq/vibevalley/internal/domain/watch"
	"github.com/vibevalleyhq/vibevalley/internal/durable"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
	"github.com/vibevalleyhq/vibevalley/internal/machine"
	"github.com/vibevalleyhq/vibevalley/internal/provider"
	"github.com/vibevalleyhq/vibevalley/internal/vault"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/link"
)

func TestDomainToolRegistryAllToolsAndGojaCodeMode(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	s, err := stack.New(ctx, stack.Config{
		DisableIssueAuto: true,
	})
	if err != nil {
		t.Fatalf("stack.New: %v", err)
	}
	defer func() { _ = s.Close() }()

	reg := stack.NewDomainToolRegistry(s)
	specs := reg.Specs()

	expectedTools := []string{
		"agent_list",
		"artifact_list",
		"artifact_publish",
		"channel_list",
		"channel_messages",
		"channel_post",
		"issue_create",
		"issue_dispatch",
		"issue_get",
		"issue_list",
		"issue_transition",
		"issue_update",
		"machine_list",
		"memory_recall",
		"memory_remember",
		"pkm_list",
		"pkm_read",
		"pkm_search",
		"pkm_write",
		"repo_list",
		"repo_register",
		"watch_report",
	}
	gotNames := make([]string, len(specs))
	for i, sp := range specs {
		gotNames[i] = sp.Name
	}
	for _, want := range expectedTools {
		if !slices.Contains(gotNames, want) {
			t.Fatalf("missing tool spec %q in %v", want, gotNames)
		}
	}

	exec := reg.Executor()
	callTool := func(name string, args any) map[string]any {
		t.Helper()
		b, err := json.Marshal(args)
		if err != nil {
			t.Fatalf("marshal %s args: %v", name, err)
		}
		raw, err := exec.Execute(ctx, "conv-test", durable.ToolCall{
			ID:       "tc-" + name,
			ToolName: name,
			ArgsJSON: b,
		})
		if err != nil {
			t.Fatalf("tool %s failed: %v", name, err)
		}
		var out map[string]any
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatalf("unmarshal %s output (%s): %v", name, string(raw), err)
		}
		return out
	}

	// Unknown tool check.
	if _, err := exec.Execute(ctx, "conv-test", durable.ToolCall{ToolName: "nonexistent_tool"}); !errors.Is(err, durable.ErrUnknownTool) {
		t.Fatalf("expected ErrUnknownTool, got %v", err)
	}

	// 1. repo_register (init=true) & repo_register (existing path) & repo_list.
	regOut := callTool("repo_register", map[string]any{
		"name": "farm-core",
		"init": true,
	})
	if regOut["repo"] == nil {
		t.Fatalf("expected repo in repo_register output: %+v", regOut)
	}
	existingDir := filepath.Join(t.TempDir(), "ext-repo")
	if err := os.MkdirAll(existingDir, 0o755); err != nil {
		t.Fatal(err)
	}
	callTool("repo_register", map[string]any{
		"id":       "ext",
		"name":     "ext-repo",
		"rootPath": existingDir,
	})
	reposOut := callTool("repo_list", map[string]any{})
	if int(reposOut["total"].(float64)) != 2 {
		t.Fatalf("expected 2 repos, got %+v", reposOut)
	}

	// 2. agent_list.
	if _, err := s.Agents.SaveProfile(ctx, agent.Profile{
		ID:      "go-coder",
		Name:    "Go Coder",
		Role:    agent.RoleWorker,
		Duty:    "Write Go code",
		Runtime: "vibevalley",
	}); err != nil {
		t.Fatal(err)
	}
	agentsOut := callTool("agent_list", map[string]any{"role": "worker"})
	if int(agentsOut["total"].(float64)) < 1 {
		t.Fatalf("expected at least 1 worker agent, got %+v", agentsOut)
	}

	// 3. issue_create, issue_list, issue_get, issue_update, issue_dispatch, issue_transition.
	createdIss := callTool("issue_create", map[string]any{
		"id":          "iss-tool-1",
		"title":       "Implement streaming SSE",
		"description": "Initial description",
		"repoId":      "farm-core",
	})
	if createdIss["dispatched"].(bool) {
		t.Fatalf("expected dispatched=false")
	}

	callTool("issue_update", map[string]any{
		"id":         "iss-tool-1",
		"title":      "Implement streaming SSE v2",
		"assigneeId": "go-coder",
		"rubric":     map[string]any{"markdown": "- passes tests", "maxIterations": 2},
	})
	gotIss := callTool("issue_get", map[string]any{"id": "iss-tool-1"})
	issObj := gotIss["issue"].(map[string]any)
	if issObj["title"] != "Implement streaming SSE v2" || issObj["assigneeId"] != "go-coder" {
		t.Fatalf("unexpected updated issue: %+v", issObj)
	}

	callTool("issue_dispatch", map[string]any{"id": "iss-tool-1"})
	listInProg := callTool("issue_list", map[string]any{"status": "in_progress", "text": "streaming"})
	if int(listInProg["total"].(float64)) != 1 {
		t.Fatalf("expected 1 in_progress issue, got %+v", listInProg)
	}

	callTool("issue_transition", map[string]any{
		"id":      "iss-tool-1",
		"status":  "review",
		"summary": "PR waiting",
	})
	gotReview := callTool("issue_get", map[string]any{"id": "iss-tool-1"})
	if gotReview["issue"].(map[string]any)["status"] != "review" {
		t.Fatalf("expected review status, got %+v", gotReview)
	}
	callTool("issue_transition", map[string]any{
		"id":      "iss-tool-1",
		"status":  "done",
		"summary": "merged cleanly",
	})
	gotDone := callTool("issue_get", map[string]any{"id": "iss-tool-1"})
	if gotDone["issue"].(map[string]any)["status"] != "done" {
		t.Fatalf("expected done status, got %+v", gotDone)
	}

	// 4. channel_list, channel_post, channel_messages, watch_report.
	if _, err := s.Channels.CreateChannel(ctx, channel.Channel{
		ID:        "general",
		Type:      channel.TypePublic,
		Name:      "general",
		IsDefault: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.Watch.SeatAgent(ctx, stackWatchSeat("general", "go-coder")); err != nil {
		t.Fatal(err)
	}
	chList := callTool("channel_list", map[string]any{"type": "channel"})
	if int(chList["total"].(float64)) != 1 {
		t.Fatalf("expected 1 channel, got %+v", chList)
	}
	postOut := callTool("channel_post", map[string]any{
		"channelId": "general",
		"authorId":  "owner",
		"actorKind": "user",
		"text":      "你好 @go-coder 请看下工单",
		"mentions":  []string{"go-coder"},
	})
	if postOut["event"] == nil {
		t.Fatalf("expected event from channel_post")
	}
	msgsOut := callTool("channel_messages", map[string]any{"channelId": "general"})
	if int(msgsOut["total"].(float64)) != 1 {
		t.Fatalf("expected 1 channel message, got %+v", msgsOut)
	}
	watchOut := callTool("watch_report", map[string]any{
		"channelId": "general",
		"agentId":   "go-coder",
		"issueId":   "iss-tool-1",
		"summary":   "已完成 SSE 验证",
		"outcome":   "completed",
	})
	if watchOut["postedEvent"] == nil {
		t.Fatalf("expected postedEvent in watch_report: %+v", watchOut)
	}

	// 5. pkm_write, pkm_list, pkm_read, pkm_search.
	callTool("pkm_write", map[string]any{
		"relPath": "01_Projects/streaming-design.md",
		"content": "---\ntitle: Streaming Design\ntags: [llm, sse]\n---\nUses pure net/http SSE and links to [[Architecture]].\n",
	})
	pkmList := callTool("pkm_list", map[string]any{"tier": "project"})
	if int(pkmList["total"].(float64)) != 1 {
		t.Fatalf("expected 1 project note, got %+v", pkmList)
	}
	pkmRead := callTool("pkm_read", map[string]any{"path": "01_Projects/streaming-design.md"})
	if pkmRead["note"].(map[string]any)["title"] != "Streaming Design" {
		t.Fatalf("unexpected pkm_read note: %+v", pkmRead)
	}
	pkmSearch := callTool("pkm_search", map[string]any{"text": "SSE"})
	if int(pkmSearch["total"].(float64)) != 1 {
		t.Fatalf("expected 1 pkm search hit, got %+v", pkmSearch)
	}

	// 6. memory_remember & memory_recall.
	callTool("memory_remember", map[string]any{
		"content": "Always run gofmt before go vet",
	})
	callTool("memory_remember", map[string]any{
		"content": "CGO_ENABLED=0 is required in CI",
	})
	memRecall := callTool("memory_recall", map[string]any{"query": "CGO_ENABLED"})
	matches := memRecall["matches"].([]any)
	if len(matches) != 1 {
		t.Fatalf("expected 1 memory match, got %+v", memRecall)
	}

	// 7. artifact_publish & artifact_list.
	artPub := callTool("artifact_publish", map[string]any{
		"id":        "art-dash-1",
		"title":     "Farm Status",
		"display":   "dashboard",
		"channelId": "general",
		"issueId":   "iss-tool-1",
		"rawHtml":   "<!doctype html><html><body><h1>Farm OK</h1></body></html>",
	})
	if int(artPub["version"].(float64)) != 1 {
		t.Fatalf("expected artifact version 1, got %+v", artPub)
	}
	artList := callTool("artifact_list", map[string]any{"issueId": "iss-tool-1"})
	if int(artList["total"].(float64)) != 1 {
		t.Fatalf("expected 1 artifact card, got %+v", artList)
	}

	// 8. machine_list (connect a real mock machine over memory pipe).
	mNode, err := machine.NewNode(machine.NodeConfig{
		MachineID: "mach-tools-1",
		WorkRoot:  t.TempDir(),
		Labels:    []string{"linux"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = mNode.Close() }()
	mClientPipe, mServerPipe := link.NewMemoryPipe()
	mLink := link.NewLink(mClientPipe, link.Options{
		Principal:  link.Principal{Kind: link.PrincipalMachineNode, ID: "mach-tools-1"},
		SidePrefix: "mach",
	})
	mLink.HandleRPC("machine.info", func(_ context.Context, _ json.RawMessage) (any, error) {
		return stack.MachineInfo{MachineID: "mach-tools-1", Labels: []string{"linux"}}, nil
	})
	startErrCh := make(chan error, 1)
	go func() { startErrCh <- mLink.Start(ctx) }()
	if _, err := s.Machines.ServeTransport(ctx, mServerPipe); err != nil {
		t.Fatalf("ServeTransport: %v", err)
	}
	if err := <-startErrCh; err != nil {
		t.Fatalf("mLink.Start: %v", err)
	}
	defer func() { _ = mLink.Close() }()
	machOut := callTool("machine_list", map[string]any{})
	if int(machOut["count"].(float64)) != 1 {
		t.Fatalf("expected 1 online machine, got %+v", machOut)
	}

	// 9. Goja CodeMode sandbox invoking real domain tools via CodeToolFunc!
	durable.RegisterCodeModePhases(s.Scheduler, reg.CodeToolFunc())
	cmSpec, _ := json.Marshal(durable.CodeModeSpec{
		Script: `
			const created = call("issue_create", { id: "iss-goja-1", title: "From Goja", repoId: "farm-core" });
			const mem = call("memory_remember", { content: "goja-sandbox-fact" });
			const recalled = call("memory_recall", { query: "goja-sandbox-fact" });
			const repos = call("repo_list", {});
			return {
				issueId: created.issue.id,
				memVer: mem.version,
				recallCount: recalled.matches.length,
				repoCount: repos.total
			};
		`,
		Seed:        7,
		StartTimeMs: 1_700_000_000_000,
	})
	cmRes, err := s.Scheduler.StartTask(ctx, store.Task{
		ID:             "cm-domain-1",
		Kind:           durable.TaskKindCodeMode,
		PhaseName:      durable.PhaseCodeExec,
		IsModelTask:    true,
		CheckpointJSON: cmSpec,
	})
	if err != nil {
		t.Fatalf("StartTask codemode: %v", err)
	}
	cmDone, err := s.Scheduler.WaitTask(ctx, cmRes.Task.ID)
	if err != nil || cmDone.TerminalReason != store.ReasonCompleted {
		t.Fatalf("codemode failed: %+v err=%v", cmDone, err)
	}
	var cmOut durable.CodeModeResult
	if err := json.Unmarshal(cmDone.ResultJSON, &cmOut); err != nil {
		t.Fatal(err)
	}
	valMap := cmOut.Value.(map[string]any)
	if valMap["issueId"] != "iss-goja-1" || int(valMap["recallCount"].(float64)) != 1 || int(valMap["repoCount"].(float64)) != 2 {
		t.Fatalf("unexpected Goja CodeMode result: %+v", valMap)
	}
}

func TestLLMAdapterKeyPrecedenceStreamingAndOverflowCompaction(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	var capturedAuthHeader string
	var callNum atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedAuthHeader = r.Header.Get("Authorization")
		n := callNum.Add(1)
		var reqBody map[string]any
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &reqBody)

		// On request #2 (overflow retry test), return 400 context_length_exceeded first, then succeed.
		msgs, _ := reqBody["messages"].([]any)
		for _, m := range msgs {
			mm, _ := m.(map[string]any)
			if txt, _ := mm["content"].(string); strings.Contains(txt, "OVERFLOW_TRIGGER") && n == 2 {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":{"message":"This model's maximum context length is 128000 tokens","code":"context_length_exceeded"}}`))
				return
			}
		}

		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		_, _ = fmt.Fprint(w, "data: {\"id\":\"chat-1\",\"model\":\"deepseek-chat\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好\"}}]}\n\n")
		if flusher != nil {
			flusher.Flush()
		}
		_, _ = fmt.Fprint(w, "data: {\"id\":\"chat-1\",\"model\":\"deepseek-chat\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"，已收到\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":30,\"completion_tokens\":10,\"total_tokens\":40}}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		if flusher != nil {
			flusher.Flush()
		}
	}))
	defer srv.Close()

	// Test key resolution precedence: Vault -> Env -> SettingsLookup.
	rk, err := vault.GenerateRootKey("test-rk")
	if err != nil {
		t.Fatal(err)
	}
	kr, err := vault.NewKeyRing(rk)
	if err != nil {
		t.Fatal(err)
	}
	vStore, err := vault.NewStore(kr, vault.NewMemoryBackend())
	if err != nil {
		t.Fatal(err)
	}

	settingsCalled := false
	envMap := map[string]string{
		"DEEPSEEK_API_KEY":  "env-ds-key",
		"DEEPSEEK_BASE_URL": srv.URL + "/v1",
	}
	clientFromSettings := stack.NewModelClient(stack.ModelClientDeps{
		HTTPClient: srv.Client(),
		Getenv:     func(string) string { return "" },
		SettingsLookup: func(_ context.Context, prov provider.ProviderKind) (string, string, error) {
			settingsCalled = true
			return "settings-key-" + string(prov), srv.URL + "/v1", nil
		},
	})
	var chunks []string
	resp, err := clientFromSettings.Generate(ctx, durable.ModelRequest{
		ConversationID:   "c-settings",
		ProviderAffinity: "deepseek:deepseek-chat",
		Transcript: durable.Transcript{
			Entries: []durable.TranscriptEntry{
				{Seq: 1, Kind: store.EntrySystem, PayloadJSON: []byte(`{"text":"sys"}`)},
				{Seq: 2, Kind: store.EntryUser, PayloadJSON: []byte(`{"text":"hello"}`)},
			},
		},
	}, func(c string) { chunks = append(chunks, c) })
	if err != nil {
		t.Fatalf("Generate via settings failed: %v", err)
	}
	if !settingsCalled || capturedAuthHeader != "Bearer settings-key-deepseek" {
		t.Fatalf("expected settings key fallback, called=%v auth=%q", settingsCalled, capturedAuthHeader)
	}
	if resp.Text != "你好，已收到" || strings.Join(chunks, "") != "你好，已收到" {
		t.Fatalf("unexpected response/chunks: resp=%+v chunks=%v", resp, chunks)
	}
	if resp.Usage == nil || resp.Usage.InputTokens != 30 || resp.Usage.OutputTokens != 10 {
		t.Fatalf("unexpected usage totals: %+v", resp.Usage)
	}

	// Put credential into Vault and verify Vault beats env AND settings!
	if err := vStore.Put(ctx, vault.Credential{
		ID:          "cred-deepseek",
		Kind:        vault.KindProviderAPIKey,
		Name:        "deepseek",
		Provider:    "deepseek",
		TargetHosts: []string{"api.deepseek.com"},
		Value:       vault.NewSecret("vault-ds-key"),
	}); err != nil {
		t.Fatal(err)
	}

	vaultModel := stack.NewModelClient(stack.ModelClientDeps{
		Vault:      vStore,
		HTTPClient: srv.Client(),
		Getenv:     func(k string) string { return envMap[k] },
		SettingsLookup: func(_ context.Context, _ provider.ProviderKind) (string, string, error) {
			return "settings-should-lose", srv.URL + "/v1", nil
		},
	})

	// Run through durable Scheduler + Compactor to verify overflow triggers Level 4 compaction & retry.
	st := store.NewMemory()
	defer func() { _ = st.Close() }()
	sched := durable.NewScheduler(st)
	defer sched.Close()

	comp := durable.NewCompactor(st, durable.SummarizerFunc(func(_ context.Context, level durable.CompactionLevel, entries []store.Entry) (string, int64, error) {
		return "compacted-" + string(level), 10, nil
	}), durable.CompactionThresholds{SoftTokens: 10_000, HardTokens: 20_000, KeepRecentEntries: 1})
	durable.RegisterGenerationPhases(sched, durable.GenerationDeps{
		Store:     st,
		Model:     vaultModel,
		Compactor: comp,
	})

	if _, err := st.CreateConversation(ctx, store.Conversation{
		ID:               "conv-overflow",
		ProviderAffinity: "deepseek:deepseek-chat",
	}); err != nil {
		t.Fatal(err)
	}
	_, _ = st.AppendEntry(ctx, "conv-overflow", store.EntrySystem, []byte(`{"text":"system"}`))
	_, _ = st.AppendEntry(ctx, "conv-overflow", store.EntryUser, []byte(`{"text":"OVERFLOW_TRIGGER old message"}`))
	_, _ = st.AppendEntry(ctx, "conv-overflow", store.EntryAssistant, []byte(`{"text":"old reply"}`))
	_, _ = st.AppendEntry(ctx, "conv-overflow", store.EntryUser, []byte(`{"text":"final question"}`))

	cpBytes, _ := json.Marshal(durable.GenerationCheckpoint{ConversationID: "conv-overflow"})
	tkRes, err := sched.StartTask(ctx, store.Task{
		ID:             "task-overflow-1",
		ConversationID: "conv-overflow",
		Kind:           durable.TaskKindGeneration,
		PhaseName:      durable.PhaseGenerate,
		IsModelTask:    true,
		CheckpointJSON: cpBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	done, err := sched.WaitTask(ctx, tkRes.Task.ID)
	if err != nil || done.TerminalReason != store.ReasonCompleted {
		t.Fatalf("expected overflow recovery to complete, got %+v err=%v", done, err)
	}
	if capturedAuthHeader != "Bearer vault-ds-key" {
		t.Fatalf("expected Vault key priority, got Authorization=%q", capturedAuthHeader)
	}
	if callNum.Load() != 3 {
		t.Fatalf("expected 3 total server calls (1 settings + 1 overflow + 1 compacted retry), got %d", callNum.Load())
	}
}

func TestOrchestratorLifecycleToolLoopStopAndOpenAIHTTP(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	var turnCount atomic.Int32
	slowStarted := make(chan struct{})
	releaseSlow := make(chan struct{})
	defer close(releaseSlow)

	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.Unmarshal(raw, &body)

		lastUser := ""
		hasToolResult := false
		for _, m := range body.Messages {
			if m.Role == "user" {
				lastUser = m.Content
			}
			if m.Role == "tool" {
				hasToolResult = true
			}
		}

		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)

		if strings.Contains(lastUser, "BLOCK_FOR_STOP") {
			close(slowStarted)
			_, _ = fmt.Fprint(w, "data: {\"id\":\"c-slow\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"开始处理\"}}]}\n\n")
			if flusher != nil {
				flusher.Flush()
			}
			select {
			case <-r.Context().Done():
				return
			case <-releaseSlow:
				return
			}
		}

		// When user asks to create a repo+issue and we haven't executed tool yet, emit tool_calls!
		if strings.Contains(lastUser, "新建任务") && !hasToolResult {
			turnCount.Add(1)
			_, _ = fmt.Fprint(w, "data: {\"id\":\"c-tc\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_issue_1\",\"type\":\"function\",\"function\":{\"name\":\"issue_create\",\"arguments\":\"{\\\"id\\\":\\\"iss-orch-1\\\",\\\"title\\\":\\\"修复首页白屏\\\",\\\"repoId\\\":\\\"web-app\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":50,\"completion_tokens\":20,\"total_tokens\":70}}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
			return
		}

		if strings.Contains(lastUser, "新建任务") && hasToolResult {
			turnCount.Add(1)
			_, _ = fmt.Fprint(w, "data: {\"id\":\"c-done\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"已记下工单\"}}]}\n\n")
			_, _ = fmt.Fprint(w, "data: {\"id\":\"c-done\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" #iss-orch-1。\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":80,\"completion_tokens\":12,\"total_tokens\":92}}\n\n")
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
			return
		}

		// Default chat completion answer.
		_, _ = fmt.Fprint(w, "data: {\"id\":\"c-chat\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"农场\"}}]}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"id\":\"c-chat\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"运行正常\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":8,\"total_tokens\":28}}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer mockLLM.Close()

	s, err := stack.New(ctx, stack.Config{DisableIssueAuto: true})
	if err != nil {
		t.Fatalf("stack.New: %v", err)
	}
	defer func() { _ = s.Close() }()

	orch, err := stack.NewOrchestrator(s, stack.OrchestratorConfig{
		HTTPClient: mockLLM.Client(),
		Getenv: func(k string) string {
			switch k {
			case "DEEPSEEK_API_KEY":
				return "ds-test-key"
			case "DEEPSEEK_BASE_URL":
				return mockLLM.URL + "/v1"
			default:
				return ""
			}
		},
	})
	if err != nil {
		t.Fatalf("NewOrchestrator: %v", err)
	}

	// 1. Open & Status.
	st, err := orch.Open(ctx, stack.OpenOptions{})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if !st.Exists || st.ConversationID != orch.DefaultConversationID() || st.EntryCount != 1 {
		t.Fatalf("unexpected initial status: %+v", st)
	}

	// 2. Answer with tool loop creating an issue in Stack!
	var streamed []string
	res, err := orch.Answer(ctx, "", "帮我新建任务：修复首页白屏", func(chunk string) {
		streamed = append(streamed, chunk)
	})
	if err != nil {
		t.Fatalf("Answer failed: %v", err)
	}
	if res.Output != "已记下工单 #iss-orch-1。" || strings.Join(streamed, "") != "已记下工单 #iss-orch-1。" {
		t.Fatalf("unexpected output=%q streamed=%v", res.Output, streamed)
	}
	if turnCount.Load() != 2 {
		t.Fatalf("expected 2 LLM turns (tool call + final answer), got %d", turnCount.Load())
	}
	createdIss, err := s.Issues.GetIssue(ctx, "iss-orch-1")
	if err != nil || createdIss.Title != "修复首页白屏" {
		t.Fatalf("expected issue created via orchestrator tool loop, got %+v err=%v", createdIss, err)
	}

	// 3. Prompts check.
	p := stack.BuildOrchestratorPrompt(stack.OrchestratorPromptOptions{Name: "牧羊人", Language: "中文"})
	if !strings.Contains(p, "issue_create") || !strings.Contains(p, "machine_list") || !strings.Contains(p, "牧羊人") {
		t.Fatalf("unexpected orchestrator prompt: %q", p)
	}
	wp := stack.BuildWorkerPrompt(stack.WorkerPromptOptions{Name: "老周", RepoID: "web-app", IssueID: "iss-orch-1"})
	if !strings.Contains(wp, "memory_remember") || !strings.Contains(wp, "老周") {
		t.Fatalf("unexpected worker prompt: %q", wp)
	}

	// 4. OpenAI HTTP /v1/chat/completions (non-streaming JSON & streaming SSE).
	nonStreamReq := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{
		"model": "vibevalley-orchestrator",
		"stream": false,
		"messages": [{"role":"user","content":"现在农场怎么样？"}]
	}`))
	rec1 := httptest.NewRecorder()
	orch.ChatCompletionsOpenAI(rec1, nonStreamReq)
	if rec1.Code != http.StatusOK {
		t.Fatalf("non-stream status=%d body=%s", rec1.Code, rec1.Body.String())
	}
	var cmpl map[string]any
	if err := json.Unmarshal(rec1.Body.Bytes(), &cmpl); err != nil {
		t.Fatal(err)
	}
	choices := cmpl["choices"].([]any)
	msg := choices[0].(map[string]any)["message"].(map[string]any)
	if msg["content"] != "农场运行正常" {
		t.Fatalf("unexpected non-stream OpenAI response: %+v", cmpl)
	}

	streamReq := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{
		"model": "deepseek-chat",
		"stream": true,
		"messages": [{"role":"user","content":[{"type":"text","text":"再查一次"}]}]
	}`))
	rec2 := httptest.NewRecorder()
	orch.ChatCompletionsOpenAI(rec2, streamReq)
	if rec2.Code != http.StatusOK {
		t.Fatalf("stream status=%d body=%s", rec2.Code, rec2.Body.String())
	}
	if !strings.Contains(rec2.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatalf("expected text/event-stream, got %q", rec2.Header().Get("Content-Type"))
	}
	var sseContent strings.Builder
	var sawDone bool
	sc := bufio.NewScanner(rec2.Body)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		payload := strings.TrimPrefix(line, "data: ")
		if payload == "[DONE]" {
			sawDone = true
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(payload), &chunk) == nil && len(chunk.Choices) > 0 {
			sseContent.WriteString(chunk.Choices[0].Delta.Content)
		}
	}
	if !sawDone || sseContent.String() != "农场运行正常" {
		t.Fatalf("unexpected OpenAI SSE output: sawDone=%v content=%q raw=%s", sawDone, sseContent.String(), rec2.Body.String())
	}

	// Unknown model returns 404.
	badModelReq := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"unknown-xyz","messages":[{"role":"user","content":"hi"}]}`))
	rec3 := httptest.NewRecorder()
	orch.ChatCompletionsOpenAI(rec3, badModelReq)
	if rec3.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown model, got %d", rec3.Code)
	}

	// 5. Async Send + Stop abort.
	stopConv := "orch-stop-test"
	sendRes, err := orch.Send(ctx, stack.SendRequest{
		ConversationID: stopConv,
		Text:           "BLOCK_FOR_STOP",
		IncludeContext: true,
		Wait:           false,
	})
	if err != nil {
		t.Fatalf("async Send: %v", err)
	}
	select {
	case <-slowStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for slow generation to start")
	}
	if err := orch.Stop(ctx, stopConv); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	abortedTask, err := s.Scheduler.WaitTask(ctx, sendRes.TaskID)
	if err != nil {
		t.Fatalf("WaitTask after Stop: %v", err)
	}
	if abortedTask.Status != store.TaskTerminal || abortedTask.TerminalReason != store.ReasonAborted {
		t.Fatalf("expected aborted terminal task, got %+v", abortedTask)
	}
	afterStatus, err := orch.Status(ctx, stopConv)
	if err != nil || afterStatus.Active {
		t.Fatalf("expected inactive status after Stop, got %+v err=%v", afterStatus, err)
	}
}

func stackWatchSeat(channelID, agentID string) domainwatch.Seat {
	return domainwatch.Seat{
		ChannelID:      channelID,
		AgentID:        agentID,
		Role:           channel.RoleWorker,
		ConversationID: "conv-" + agentID,
		Active:         true,
	}
}

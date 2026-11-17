package oar_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/oar"
	"github.com/vibevalleyhq/vibevalley/pkg/oar/replaytest"
)

func TestClaudeDriverResumeAttributionAndControls(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	t.Run("resume_baseline_subtraction_and_subagent_agentPath", func(t *testing.T) {
		cost := 0.065
		launcher := replaytest.NewLauncher(replaytest.ClaudeFixtureHandler(replaytest.ClaudeFixtureConfig{
			SessionID:      "claude-resumed-1",
			IncludePartial: true,
			EmitSubagent:   true,
			NestedSubagent: true,
			BaselineUsage: map[string]any{
				"claude-sonnet-4-5": map[string]any{
					"input_tokens":                1000,
					"output_tokens":               500,
					"cache_read_input_tokens":     400,
					"cache_creation_input_tokens": 100,
					"cost_usd":                    0.050,
				},
			},
			TurnResultUsage: map[string]any{
				"claude-sonnet-4-5": map[string]any{
					"inputTokens":              1250,
					"outputTokens":             580,
					"cacheReadInputTokens":     650,
					"cacheCreationInputTokens": 140,
					"costUSD":                  cost,
				},
			},
		}))

		sess, err := oar.NewClaudeDriver().Open(ctx, oar.SessionOptions{
			CWD:             t.TempDir(),
			Launcher:        launcher,
			ResumeSessionID: "claude-resumed-1",
			MCPServers: []oar.MCPServer{
				{Type: oar.MCPHTTP, Name: "vv", URL: "http://127.0.0.1:8787/mcp", Headers: map[string]string{"Authorization": "Bearer tok-123"}},
			},
		})
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer sess.Dispose(context.Background())

		launch, _ := launcher.LastLaunch()
		replaytest.AssertCleanArgv(t, launch, "tok-123", "Bearer")
		mcpSnap := replaytest.AssertSecretFile(t, launch, "--mcp-config", 0o700, 0o600, "tok-123")

		if out, err := sess.Prompt(ctx, "continue"); err != nil || !out.Accepted() {
			t.Fatalf("Prompt = (%+v, %v)", out, err)
		}
		waitTurnCount(t, sess, 1)

		// Verify incremental subtraction: 1250-1000, 580-500, 650-400, 140-100, 0.065-0.050=0.015.
		wantCost := int64(15000)
		replaytest.AssertUsageEquals(t, sess.Usage(), oar.TokenTotals{
			InputTokens:      250,
			OutputTokens:     80,
			CacheReadTokens:  250,
			CacheWriteTokens: 40,
			CostMicros:       &wantCost,
		})

		// Verify parent_tool_use_id -> agentPath attribution & no partial/assistant text duplication.
		var rootText strings.Builder
		sawLevel1 := false
		sawLevel2 := false
		for _, rec := range sess.Records() {
			if slices.Equal(rec.AgentPath, []string{"toolu_sub1"}) {
				sawLevel1 = true
			}
			if slices.Equal(rec.AgentPath, []string{"toolu_sub1", "toolu_nested2"}) {
				sawLevel2 = true
			}
			if rec.IsRoot() {
				for _, ev := range rec.Events {
					if ev.Kind == oar.EventTextDelta {
						rootText.WriteString(ev.Text)
					}
				}
			}
		}
		if !sawLevel1 || !sawLevel2 {
			t.Fatalf("missing subagent agentPaths: level1=%v level2=%v", sawLevel1, sawLevel2)
		}
		if got := rootText.String(); got != "Hello " {
			t.Fatalf("root streamed text duplicated or mismatched: %q", got)
		}

		// Verify StopTask & Compact work.
		if out, err := sess.StopTask(ctx, "task-sub-1"); err != nil || !out.Accepted() {
			t.Fatalf("StopTask = (%+v, %v)", out, err)
		}
		if out, err := sess.Compact(ctx); err != nil || !out.Accepted() {
			t.Fatalf("Compact = (%+v, %v)", out, err)
		}
		waitUntil(t, func() bool {
			for _, rec := range sess.Records() {
				for _, ev := range rec.Events {
					if ev.Kind == oar.EventCompactionEnded && ev.CompactionOutcome == "completed" {
						return true
					}
				}
			}
			return false
		})

		if err := sess.Dispose(ctx); err != nil {
			t.Fatalf("Dispose: %v", err)
		}
		replaytest.AssertPathRemoved(t, mcpSnap.DirPath)
	})

	t.Run("resume_get_usage_timeout_sets_totals_nil", func(t *testing.T) {
		cost := 9.99
		launcher := replaytest.NewLauncher(replaytest.ClaudeFixtureHandler(replaytest.ClaudeFixtureConfig{
			SessionID:        "claude-timeout",
			TimeoutGetUsage:  true,
			TurnTotalCostUSD: &cost,
			TurnResultUsage: map[string]any{
				"claude-sonnet-4-5": map[string]any{
					"inputTokens":  50000,
					"outputTokens": 10000,
					"costUSD":      cost,
				},
			},
		}))

		sess, err := oar.NewClaudeDriver().Open(ctx, oar.SessionOptions{
			CWD:             t.TempDir(),
			Launcher:        launcher,
			ResumeSessionID: "claude-timeout",
			BaselineTimeout: 25 * time.Millisecond,
		})
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer sess.Dispose(context.Background())

		if out, err := sess.Prompt(ctx, "hello"); err != nil || !out.Accepted() {
			t.Fatalf("Prompt = (%+v, %v)", out, err)
		}
		waitTurnCount(t, sess, 1)
		replaytest.AssertUsageNil(t, sess)
	})

	t.Run("resume_get_usage_error_sets_totals_nil", func(t *testing.T) {
		launcher := replaytest.NewLauncher(replaytest.ClaudeFixtureHandler(replaytest.ClaudeFixtureConfig{
			SessionID:    "claude-err",
			FailGetUsage: true,
			TurnResultUsage: map[string]any{
				"claude-sonnet-4-5": map[string]any{"inputTokens": 999, "outputTokens": 111},
			},
		}))
		sess, err := oar.NewClaudeDriver().Open(ctx, oar.SessionOptions{
			CWD:             t.TempDir(),
			Launcher:        launcher,
			ResumeSessionID: "claude-err",
		})
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer sess.Dispose(context.Background())

		if _, err := sess.Prompt(ctx, "hi"); err != nil {
			t.Fatalf("Prompt: %v", err)
		}
		waitTurnCount(t, sess, 1)
		replaytest.AssertUsageNil(t, sess)
	})

	t.Run("steer_and_abort_active_turn", func(t *testing.T) {
		launcher := replaytest.NewLauncher(replaytest.ClaudeFixtureHandler(replaytest.ClaudeFixtureConfig{}))
		sess, err := oar.NewClaudeDriver().Open(ctx, oar.SessionOptions{CWD: t.TempDir(), Launcher: launcher})
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer sess.Dispose(context.Background())

		if _, err := sess.Prompt(ctx, "abort_wait"); err != nil {
			t.Fatalf("Prompt: %v", err)
		}
		if out, err := sess.Steer(ctx, "abort_wait steer"); err != nil || !out.Accepted() {
			t.Fatalf("Steer = (%+v, %v)", out, err)
		}
		if out, err := sess.Abort(ctx); err != nil || !out.Accepted() {
			t.Fatalf("Abort = (%+v, %v)", out, err)
		}
		waitTurnCount(t, sess, 1)
	})
}

func TestCodexDriverResumeCompactionAndChildThreads(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	t.Run("resume_baseline_subtraction_cache_and_reasoning_plus_child_thread", func(t *testing.T) {
		h, _ := replaytest.CodexFixtureHandler(replaytest.CodexFixtureConfig{
			ThreadID:      "thread-root-9",
			ChildThreadID: "thread-child-9",
			ResumeBaseline: map[string]any{
				"inputTokens":              1000,
				"outputTokens":             400,
				"cachedInputTokens":        500,
				"cacheCreationInputTokens": 200,
				"reasoningOutputTokens":    150,
			},
			TurnTotalUsage: map[string]any{
				"inputTokens":              1300,
				"outputTokens":             520,
				"cachedInputTokens":        800,
				"cacheCreationInputTokens": 250,
				"reasoningOutputTokens":    240,
			},
			ChildTurnUsage: map[string]any{
				"inputTokens":  20,
				"outputTokens": 10,
			},
		})
		launcher := replaytest.NewLauncher(h)
		sess, err := oar.NewCodexDriver().Open(ctx, oar.SessionOptions{
			CWD:             t.TempDir(),
			Launcher:        launcher,
			ResumeSessionID: "thread-root-9",
		})
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer sess.Dispose(context.Background())

		if out, err := sess.Prompt(ctx, "finish feature"); err != nil || !out.Accepted() {
			t.Fatalf("Prompt = (%+v, %v)", out, err)
		}
		waitTurnCount(t, sess, 1)

		// Root incremental (300, 120, 300, 50, 90) + Child incremental (20, 10) = (320, 130, 300, 50, 90).
		replaytest.AssertUsageEquals(t, sess.Usage(), oar.TokenTotals{
			InputTokens:      320,
			OutputTokens:     130,
			CacheReadTokens:  300,
			CacheWriteTokens: 50,
			ReasoningTokens:  90,
		})

		// Verify child thread events carry agentPath ["thread-child-9"] and root mcpServer frame kept lossless Raw.
		sawChildDelta := false
		sawMCPStatus := false
		for _, rec := range sess.Records() {
			if slices.Equal(rec.AgentPath, []string{"thread-child-9"}) {
				for _, ev := range rec.Events {
					if ev.Kind == oar.EventTextDelta && ev.Text == "child output" {
						sawChildDelta = true
					}
				}
			}
			if rec.IsRoot() && rec.FrameType == "mcpServer/startupStatus/updated" && len(rec.Raw) > 0 {
				sawMCPStatus = true
			}
		}
		if !sawChildDelta || !sawMCPStatus {
			t.Fatalf("sawChildDelta=%v sawMCPStatus=%v", sawChildDelta, sawMCPStatus)
		}
	})

	t.Run("resume_in_response_baseline_subtraction", func(t *testing.T) {
		h, _ := replaytest.CodexFixtureHandler(replaytest.CodexFixtureConfig{
			ThreadID:         "thread-resp-base",
			ResumeInResponse: true,
			ChildThreadID:    "",
			ResumeBaseline: map[string]any{
				"inputTokens":      500,
				"outputTokens":     100,
				"cacheReadTokens":  200,
				"cacheWriteTokens": 80,
				"reasoningTokens":  40,
			},
			TurnTotalUsage: map[string]any{
				"inputTokens":      650,
				"outputTokens":     155,
				"cacheReadTokens":  290,
				"cacheWriteTokens": 105,
				"reasoningTokens":  75,
			},
		})
		launcher := replaytest.NewLauncher(h)
		sess, err := oar.NewCodexDriver().Open(ctx, oar.SessionOptions{
			CWD:             t.TempDir(),
			Launcher:        launcher,
			ResumeSessionID: "thread-resp-base",
		})
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer sess.Dispose(context.Background())

		if _, err := sess.Prompt(ctx, "next"); err != nil {
			t.Fatalf("Prompt: %v", err)
		}
		waitTurnCount(t, sess, 1)
		replaytest.AssertUsageEquals(t, sess.Usage(), oar.TokenTotals{
			InputTokens:      150,
			OutputTokens:     55,
			CacheReadTokens:  90,
			CacheWriteTokens: 25,
			ReasoningTokens:  35,
		})
	})

	t.Run("resume_missing_baseline_sets_totals_nil", func(t *testing.T) {
		h, _ := replaytest.CodexFixtureHandler(replaytest.CodexFixtureConfig{
			ThreadID:           "thread-no-base",
			OmitResumeBaseline: true,
			ChildThreadID:      "",
			TurnTotalUsage: map[string]any{
				"inputTokens":  9000,
				"outputTokens": 2000,
			},
		})
		launcher := replaytest.NewLauncher(h)
		sess, err := oar.NewCodexDriver().Open(ctx, oar.SessionOptions{
			CWD:             t.TempDir(),
			Launcher:        launcher,
			ResumeSessionID: "thread-no-base",
			BaselineTimeout: 15 * time.Millisecond,
		})
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer sess.Dispose(context.Background())

		if _, err := sess.Prompt(ctx, "run"); err != nil {
			t.Fatalf("Prompt: %v", err)
		}
		waitTurnCount(t, sess, 1)
		replaytest.AssertUsageNil(t, sess)
	})

	t.Run("rejects_queue_during_active_manual_compaction", func(t *testing.T) {
		h, finishCompact := replaytest.CodexFixtureHandler(replaytest.CodexFixtureConfig{
			ThreadID:       "thread-cmp",
			HoldCompaction: true,
		})
		launcher := replaytest.NewLauncher(h)
		sess, err := oar.NewCodexDriver().Open(ctx, oar.SessionOptions{
			CWD:      t.TempDir(),
			Launcher: launcher,
		})
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer sess.Dispose(context.Background())

		out, err := sess.Compact(ctx)
		if err != nil || !out.Accepted() {
			t.Fatalf("Compact = (%+v, %v)", out, err)
		}

		// Queue MUST be rejected while manual compaction is active.
		qOut, err := sess.Queue(ctx, "do not queue while compacting", oar.WithInputID("q-1"))
		if err != nil || qOut.Status != oar.ControlRejected || qOut.Code != "compacting" {
			t.Fatalf("Queue during compaction = (%+v, %v), want rejected/compacting", qOut, err)
		}
		pOut, err := sess.Prompt(ctx, "also blocked")
		if err != nil || pOut.Status != oar.ControlRejected || pOut.Code != "compacting" {
			t.Fatalf("Prompt during compaction = (%+v, %v), want rejected/compacting", pOut, err)
		}

		// Finish compaction and verify Queue is accepted again.
		proc := launcher.Processes()[0]
		finishCompact(proc)
		waitUntil(t, func() bool {
			for _, rec := range sess.Records() {
				for _, ev := range rec.Events {
					if ev.Kind == oar.EventCompactionEnded && ev.CompactionOutcome == "completed" {
						return true
					}
				}
			}
			return false
		})

		qAfter, err := sess.Queue(ctx, "runs after compact")
		if err != nil || !qAfter.Accepted() {
			t.Fatalf("Queue after compaction = (%+v, %v), want accepted", qAfter, err)
		}
		waitTurnCount(t, sess, 1)
	})
}

func TestACPDriversAndProfiles(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	t.Run("opencode_child_session_meta_and_steer", func(t *testing.T) {
		launcher := replaytest.NewLauncher(replaytest.ACPFixtureHandler(replaytest.ACPFixtureConfig{
			SessionID:         "oc-root",
			ChildSessionID:    "oc-sub-42",
			OpenCodeChildMeta: true,
			SupportResume:     true,
			SupportClose:      true,
		}))
		sess, err := oar.NewACPDriver(oar.OpenCodeProfile()).Open(ctx, oar.SessionOptions{
			CWD:      t.TempDir(),
			Model:    "anthropic/claude-sonnet",
			Effort:   "high",
			Launcher: launcher,
		})
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer sess.Dispose(context.Background())

		launch, _ := launcher.LastLaunch()
		if launch.Spec.Command != "opencode" || !slices.Equal(launch.Spec.Args, []string{"acp"}) {
			t.Fatalf("opencode launch = %+v", launch.Spec)
		}

		if out, err := sess.Prompt(ctx, "work"); err != nil || !out.Accepted() {
			t.Fatalf("Prompt = (%+v, %v)", out, err)
		}
		waitTurnCount(t, sess, 1)

		sawChild := false
		for _, rec := range sess.Records() {
			if slices.Equal(rec.AgentPath, []string{"oc-sub-42"}) {
				for _, ev := range rec.Events {
					if ev.Kind == oar.EventTextDelta && ev.Text == "child chunk" {
						sawChild = true
					}
				}
			}
		}
		if !sawChild {
			t.Fatal("missing opencode child session record with agentPath [oc-sub-42]")
		}
	})

	t.Run("kimi_and_codebuddy_flags_and_unsupported_steer", func(t *testing.T) {
		kimiLauncher := replaytest.NewLauncher(replaytest.ACPFixtureHandler(replaytest.ACPFixtureConfig{}))
		kimiSess, err := oar.NewACPDriver(oar.KimiProfile()).Open(ctx, oar.SessionOptions{CWD: t.TempDir(), Launcher: kimiLauncher})
		if err != nil {
			t.Fatalf("Open kimi: %v", err)
		}
		defer kimiSess.Dispose(context.Background())

		kl, _ := kimiLauncher.LastLaunch()
		if kl.Spec.Command != "kimi" || !slices.Equal(kl.Spec.Args, []string{"acp"}) {
			t.Fatalf("kimi launch = %+v", kl.Spec)
		}
		if out, err := kimiSess.Steer(ctx, "mid"); err != nil || out.Status != oar.ControlUnsupported {
			t.Fatalf("kimi Steer = (%+v, %v), want unsupported", out, err)
		}

		cbLauncher := replaytest.NewLauncher(replaytest.ACPFixtureHandler(replaytest.ACPFixtureConfig{
			SupportResume:     false,
			EmitPermissionReq: true,
		}))
		cbSess, err := oar.NewACPDriver(oar.CodeBuddyProfile()).Open(ctx, oar.SessionOptions{
			CWD:             t.TempDir(),
			Launcher:        cbLauncher,
			ResumeSessionID: "cb-prev",
		})
		if err != nil {
			t.Fatalf("Open codebuddy resume: %v", err)
		}
		defer cbSess.Dispose(context.Background())

		cbl, _ := cbLauncher.LastLaunch()
		if cbl.Spec.Command != "codebuddy" || !slices.Equal(cbl.Spec.Args, []string{"--acp"}) {
			t.Fatalf("codebuddy launch = %+v", cbl.Spec)
		}
		if out, err := cbSess.Prompt(ctx, "go"); err != nil || !out.Accepted() {
			t.Fatalf("Prompt = (%+v, %v)", out, err)
		}
		waitTurnCount(t, cbSess, 1)
	})

	t.Run("grok_child_session_and_acp_honest_usage", func(t *testing.T) {
		grokLauncher := replaytest.NewLauncher(replaytest.ACPFixtureHandler(replaytest.ACPFixtureConfig{
			SessionID:      "grok-root",
			ChildSessionID: "grok-child-7",
			EmitUsage:      map[string]any{"inputTokens": 45, "outputTokens": 18},
		}))
		grokSess, err := oar.NewACPDriver(oar.GrokProfile()).Open(ctx, oar.SessionOptions{CWD: t.TempDir(), Launcher: grokLauncher})
		if err != nil {
			t.Fatalf("Open grok: %v", err)
		}
		defer grokSess.Dispose(context.Background())

		gl, _ := grokLauncher.LastLaunch()
		if gl.Spec.Command != "grok" || !slices.Equal(gl.Spec.Args, []string{"agent", "stdio"}) {
			t.Fatalf("grok launch = %+v", gl.Spec)
		}
		if _, err := grokSess.Prompt(ctx, "inspect"); err != nil {
			t.Fatalf("Prompt: %v", err)
		}
		waitTurnCount(t, grokSess, 1)

		sawChild := false
		for _, rec := range grokSess.Records() {
			if slices.Equal(rec.AgentPath, []string{"grok-child-7"}) {
				sawChild = true
			}
		}
		if !sawChild {
			t.Fatal("missing grok child session agentPath [grok-child-7]")
		}
		replaytest.AssertUsageEquals(t, grokSess.Usage(), oar.TokenTotals{InputTokens: 45, OutputTokens: 18})

		// Resuming an ACP session with cumulative usage but no baseline must keep Usage nil.
		resLauncher := replaytest.NewLauncher(replaytest.ACPFixtureHandler(replaytest.ACPFixtureConfig{
			SessionID: "grok-root",
			EmitUsage: map[string]any{"inputTokens": 5000, "outputTokens": 1000},
		}))
		resSess, err := oar.NewACPDriver(oar.GrokProfile()).Open(ctx, oar.SessionOptions{
			CWD:             t.TempDir(),
			Launcher:        resLauncher,
			ResumeSessionID: "grok-root",
		})
		if err != nil {
			t.Fatalf("Open resumed grok: %v", err)
		}
		defer resSess.Dispose(context.Background())
		if _, err := resSess.Prompt(ctx, "more"); err != nil {
			t.Fatalf("Prompt: %v", err)
		}
		waitTurnCount(t, resSess, 1)
		replaytest.AssertUsageNil(t, resSess)
	})
}

func TestQwenInitializeAndQoderSecurityInvariants(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	t.Run("qwen_initialize_is_first_stdin_frame", func(t *testing.T) {
		launcher := replaytest.NewLauncher(replaytest.SDKStreamFixtureHandler("qwen-s1", map[string]any{
			"input_tokens":  30,
			"output_tokens": 12,
		}))
		sess, err := oar.NewQwenDriver().Open(ctx, oar.SessionOptions{
			CWD:      t.TempDir(),
			Launcher: launcher,
		})
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer sess.Dispose(context.Background())

		if out, err := sess.Prompt(ctx, "hello qwen"); err != nil || !out.Accepted() {
			t.Fatalf("Prompt = (%+v, %v)", out, err)
		}
		waitTurnCount(t, sess, 1)

		lines := launcher.Processes()[0].StdinLines()
		if len(lines) < 2 {
			t.Fatalf("expected >= 2 stdin lines, got %d", len(lines))
		}
		var first map[string]any
		if err := json.Unmarshal(lines[0], &first); err != nil {
			t.Fatalf("unmarshal line 0: %v", err)
		}
		reqObj, _ := first["request"].(map[string]any)
		if first["type"] != "control_request" || reqObj["subtype"] != "initialize" {
			t.Fatalf("line 0 was %s, must be control_request initialize", string(lines[0]))
		}
		replaytest.AssertUsageEquals(t, sess.Usage(), oar.TokenTotals{InputTokens: 30, OutputTokens: 12})
	})

	t.Run("qoder_cleans_secret_dir_even_on_launch_error_and_hides_multiline_prompts", func(t *testing.T) {
		launcher := replaytest.NewLauncher(nil)
		launcher.LaunchErr = errors.New("binary missing")

		sysPrompt := "line1\nTOP_SECRET_SYSTEM_PROMPT"
		appendPrompt := "line1\nTOP_SECRET_APPEND_PROMPT"
		_, err := oar.NewQoderDriver().Open(ctx, oar.SessionOptions{
			CWD:                t.TempDir(),
			Launcher:           launcher,
			SystemPrompt:       sysPrompt,
			AppendSystemPrompt: appendPrompt,
			MCPServers: []oar.MCPServer{
				{Type: oar.MCPStdio, Name: "priv", Command: "mcp", Env: map[string]string{"API_KEY": "SECRET_KEY_999"}},
			},
		})
		if err == nil {
			t.Fatal("expected launch error")
		}
		launch, ok := launcher.LastLaunch()
		if !ok {
			t.Fatal("expected launch attempt recorded")
		}
		replaytest.AssertEnv(t, launch, oar.EnvQoderExposeTokenUsage, "1")
		replaytest.AssertCleanArgv(t, launch, "TOP_SECRET_SYSTEM_PROMPT", "TOP_SECRET_APPEND_PROMPT", "SECRET_KEY_999")
		snap := replaytest.AssertSecretFile(t, launch, "--system-prompt-file", 0o700, 0o600, sysPrompt)
		// Temp dir must already be cleaned up after failed Launch!
		replaytest.AssertPathRemoved(t, snap.DirPath)
	})

	t.Run("qoder_omitted_usage_stays_nil_and_multiline_prompt_never_in_argv", func(t *testing.T) {
		launcher := replaytest.NewLauncher(replaytest.SDKStreamFixtureHandler("qoder-no-usage", nil))
		sess, err := oar.NewQoderDriver().Open(ctx, oar.SessionOptions{
			CWD:                t.TempDir(),
			Launcher:           launcher,
			SystemPrompt:       "sys line 1\nsys line 2",
			AppendSystemPrompt: "app line 1\napp line 2",
		})
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer sess.Dispose(context.Background())

		launch, _ := launcher.LastLaunch()
		replaytest.AssertEnv(t, launch, oar.EnvQoderExposeTokenUsage, "1")
		replaytest.AssertCleanArgv(t, launch, "sys line 1", "app line 1")

		multiTurn := "turn line 1\nturn line 2\nTURN_SECRET"
		if out, err := sess.Prompt(ctx, multiTurn); err != nil || !out.Accepted() {
			t.Fatalf("Prompt = (%+v, %v)", out, err)
		}
		waitTurnCount(t, sess, 1)
		replaytest.AssertUsageNil(t, sess)
	})
}

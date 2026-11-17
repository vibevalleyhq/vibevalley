package replaytest_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/oar"
	"github.com/vibevalleyhq/vibevalley/pkg/oar/replaytest"
)

func TestReplayHarnessAllFamilies(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	t.Run("claude_offline_fixture_and_voyage", func(t *testing.T) {
		launcher := replaytest.NewLauncher(replaytest.ClaudeFixtureHandler(replaytest.ClaudeFixtureConfig{
			SessionID:      "c-1",
			IncludePartial: true,
			EmitSubagent:   true,
			NestedSubagent: true,
			TurnResultUsage: map[string]any{
				"claude-sonnet-4-5": map[string]any{
					"inputTokens":              120,
					"outputTokens":             45,
					"cacheReadInputTokens":     300,
					"cacheCreationInputTokens": 50,
					"costUSD":                  0.015,
				},
			},
		}))
		sess, err := oar.NewClaudeDriver().Open(ctx, oar.SessionOptions{
			CWD:      t.TempDir(),
			Launcher: launcher,
		})
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer sess.Dispose(context.Background())

		out, err := sess.Prompt(ctx, "hello")
		if err != nil || !out.Accepted() {
			t.Fatalf("Prompt = (%+v, %v)", out, err)
		}
		waitForTurnEnd(t, sess, 1)

		replaytest.AssertUsageEquals(t, sess.Usage(), oar.TokenTotals{
			InputTokens:      120,
			OutputTokens:     45,
			CacheReadTokens:  300,
			CacheWriteTokens: 50,
			CostMicros:       ptrInt64(15000),
		})
		replaytest.AssertVoyageRoundTrip(t, oar.VoyageHeader{Runtime: "claude", SessionID: sess.ID()}, sess.Records())
	})

	t.Run("codex_offline_fixture", func(t *testing.T) {
		h, _ := replaytest.CodexFixtureHandler(replaytest.CodexFixtureConfig{
			TurnTotalUsage: map[string]any{
				"inputTokens":           200,
				"outputTokens":          80,
				"cachedInputTokens":     40,
				"cacheCreationTokens":   0,
				"cacheWriteTokens":      15,
				"reasoningOutputTokens": 35,
			},
			ChildTurnUsage: map[string]any{
				"inputTokens":  10,
				"outputTokens": 5,
			},
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

		if out, err := sess.Prompt(ctx, "build it"); err != nil || !out.Accepted() {
			t.Fatalf("Prompt = (%+v, %v)", out, err)
		}
		waitForTurnEnd(t, sess, 1)
		replaytest.AssertUsageEquals(t, sess.Usage(), oar.TokenTotals{
			InputTokens:      210,
			OutputTokens:     85,
			CacheReadTokens:  40,
			CacheWriteTokens: 15,
			ReasoningTokens:  35,
		})
	})

	for _, tc := range []struct {
		name    string
		profile oar.ACPProfile
		cfg     replaytest.ACPFixtureConfig
	}{
		{
			name:    "opencode",
			profile: oar.OpenCodeProfile(),
			cfg:     replaytest.ACPFixtureConfig{ChildSessionID: "oc-child-1", OpenCodeChildMeta: true},
		},
		{
			name:    "grok",
			profile: oar.GrokProfile(),
			cfg:     replaytest.ACPFixtureConfig{ChildSessionID: "grok-child-1"},
		},
		{
			name:    "kimi",
			profile: oar.KimiProfile(),
			cfg:     replaytest.ACPFixtureConfig{},
		},
		{
			name:    "codebuddy",
			profile: oar.CodeBuddyProfile(),
			cfg:     replaytest.ACPFixtureConfig{EmitPermissionReq: true},
		},
	} {
		t.Run("acp_"+tc.name, func(t *testing.T) {
			launcher := replaytest.NewLauncher(replaytest.ACPFixtureHandler(tc.cfg))
			sess, err := oar.NewACPDriver(tc.profile).Open(ctx, oar.SessionOptions{
				CWD:      t.TempDir(),
				Launcher: launcher,
			})
			if err != nil {
				t.Fatalf("Open %s: %v", tc.name, err)
			}
			defer sess.Dispose(context.Background())

			if out, err := sess.Prompt(ctx, "hi"); err != nil || !out.Accepted() {
				t.Fatalf("Prompt = (%+v, %v)", out, err)
			}
			waitForTurnEnd(t, sess, 1)
			replaytest.AssertUsageNil(t, sess)
		})
	}

	t.Run("qwen_first_frame_initialize", func(t *testing.T) {
		launcher := replaytest.NewLauncher(replaytest.SDKStreamFixtureHandler("qwen-1", map[string]any{
			"input_tokens":  50,
			"output_tokens": 20,
		}))
		sess, err := oar.NewQwenDriver().Open(ctx, oar.SessionOptions{
			CWD:      t.TempDir(),
			Launcher: launcher,
			MCPServers: []oar.MCPServer{
				{Type: oar.MCPHTTP, Name: "local", URL: "http://127.0.0.1:9999/mcp", Headers: map[string]string{"Authorization": "Bearer qwen-tok"}},
			},
		})
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer sess.Dispose(context.Background())

		launch, _ := launcher.LastLaunch()
		replaytest.AssertCleanArgv(t, launch, "Bearer qwen-tok", "qwen-tok")

		proc := launcher.Processes()[0]
		lines := proc.StdinLines()
		if len(lines) == 0 {
			t.Fatal("expected initialize frame on stdin")
		}
		var first struct {
			Type    string `json:"type"`
			Request struct {
				Subtype string `json:"subtype"`
			} `json:"request"`
		}
		if err := json.Unmarshal(lines[0], &first); err != nil {
			t.Fatalf("parse first stdin line: %v", err)
		}
		if first.Type != "control_request" || first.Request.Subtype != "initialize" {
			t.Fatalf("first stdin frame = %s, want control_request initialize", string(lines[0]))
		}
	})

	t.Run("qoder_secret_files_and_env", func(t *testing.T) {
		launcher := replaytest.NewLauncher(replaytest.SDKStreamFixtureHandler("qoder-1", map[string]any{
			"input_tokens":  70,
			"output_tokens": 30,
		}))
		sysPrompt := "Line 1: obey policy\nLine 2: SECRET_PROMPT_TOKEN_XYZ"
		appendPrompt := "Line A\nLine B: APPEND_SECRET_ABC"
		sess, err := oar.NewQoderDriver().Open(ctx, oar.SessionOptions{
			CWD:                t.TempDir(),
			Launcher:           launcher,
			SystemPrompt:       sysPrompt,
			AppendSystemPrompt: appendPrompt,
			Env:                map[string]string{oar.EnvQoderExposeTokenUsage: "0"},
			MCPServers: []oar.MCPServer{
				{Type: oar.MCPHTTP, Name: "priv", URL: "http://127.0.0.1:8080", Headers: map[string]string{"Authorization": "Bearer super-secret-hdr"}},
			},
		})
		if err != nil {
			t.Fatalf("Open: %v", err)
		}

		launch, _ := launcher.LastLaunch()
		replaytest.AssertEnv(t, launch, oar.EnvQoderExposeTokenUsage, "1")
		replaytest.AssertCleanArgv(t, launch, "Line 1", "SECRET_PROMPT_TOKEN_XYZ", "APPEND_SECRET_ABC", "super-secret-hdr")
		s1 := replaytest.AssertSecretFile(t, launch, "--system-prompt-file", 0o700, 0o600, sysPrompt)
		s2 := replaytest.AssertSecretFile(t, launch, "--append-system-prompt-file", 0o700, 0o600, appendPrompt)
		s3 := replaytest.AssertSecretFile(t, launch, "--mcp-config", 0o700, 0o600, "super-secret-hdr")

		if err := sess.Dispose(context.Background()); err != nil {
			t.Fatalf("Dispose: %v", err)
		}
		replaytest.AssertPathRemoved(t, s1.DirPath)
		replaytest.AssertPathRemoved(t, s2.Path)
		replaytest.AssertPathRemoved(t, s3.Path)
	})

	t.Run("static_recorded_stream_preload_lossless_raw", func(t *testing.T) {
		recorded := []string{
			`{"type":"system","subtype":"init","session_id":"rec-1","model":"claude-sonnet-4-5"}`,
			`{"type":  "assistant",  "session_id":"rec-1", "message":{"id":"m1","content":[{"type":"text","text":"recorded reply"}]}}`,
			`{"type":"result","subtype":"success","session_id":"rec-1","modelUsage":{"claude-sonnet-4-5":{"inputTokens":42,"outputTokens":9}}}`,
		}
		launcher := replaytest.NewLauncher(nil)
		launcher.PreloadLines = recorded
		sess, err := oar.NewClaudeDriver().Open(ctx, oar.SessionOptions{
			CWD:      t.TempDir(),
			Launcher: launcher,
		})
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		defer sess.Dispose(context.Background())

		waitForTurnEnd(t, sess, 1)
		recs := sess.Records()
		if len(recs) < 3 {
			t.Fatalf("expected >= 3 records, got %d", len(recs))
		}
		// Second frame has intentional double spaces that must survive losslessly in Raw.
		if string(recs[1].Raw) != recorded[1] {
			t.Fatalf("lossless Raw mismatch:\ngot:  %q\nwant: %q", string(recs[1].Raw), recorded[1])
		}
		replaytest.AssertUsageEquals(t, sess.Usage(), oar.TokenTotals{InputTokens: 42, OutputTokens: 9})
	})
}

func waitForTurnEnd(t *testing.T, sess oar.Session, count int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		n := 0
		for _, rec := range sess.Records() {
			for _, ev := range rec.Events {
				if ev.Kind == oar.EventTurnEnded {
					n++
				}
			}
		}
		if n >= count {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d turn_ended events; records=%+v", count, sess.Records())
}

func ptrInt64(v int64) *int64 { return &v }

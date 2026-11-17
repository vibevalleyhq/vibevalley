package oar_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/oar"
	"github.com/vibevalleyhq/vibevalley/pkg/oar/replaytest"
)

func TestRecordEnvelopeAndVoyageCodec(t *testing.T) {
	rawWhitespace := []byte("{\"b\" : 2,  \"a\":\t1.00 }")
	rawBinary := []byte{0x00, 0xff, 0xfe, 'r', 'a', 'w', '\n'}
	largeRaw := bytes.Repeat([]byte("x"), 256*1024)

	records := []oar.RecordEnvelope{
		{
			Seq:        0,
			Kind:       oar.RecordFrame,
			SessionID:  "sess-1",
			SpanID:     "span-1",
			AgentPath:  []string{},
			ReceivedAt: 1700000000001,
			FrameType:  "assistant",
			Raw:        rawWhitespace,
			Events:     []oar.Event{{Kind: oar.EventTextDelta, Text: "hi"}},
		},
		{
			Seq:        1,
			Kind:       oar.RecordFrame,
			SessionID:  "sess-1",
			AgentPath:  []string{"toolu_sub1"},
			ReceivedAt: 1700000000002,
			FrameType:  "raw_blob",
			Raw:        rawBinary,
		},
		{
			Seq:        2,
			Kind:       oar.RecordMarker,
			SessionID:  "sess-1",
			AgentPath:  []string{},
			ReceivedAt: 1700000000003,
			Raw:        largeRaw,
			Marker:     &oar.MarkerRecord{Name: "large_frame"},
		},
	}

	// Verify direct JSON marshaling turns even a nil AgentPath into [] rather than null.
	marshaledNil, err := json.Marshal(oar.RecordEnvelope{
		Seq:       0,
		Kind:      oar.RecordFrame,
		SessionID: "sess-nil",
	})
	if err != nil {
		t.Fatalf("json.Marshal nil AgentPath: %v", err)
	}
	if !strings.Contains(string(marshaledNil), `"agentPath":[]`) {
		t.Fatalf("MarshalJSON emitted %s, want \"agentPath\":[]", string(marshaledNil))
	}

	var buf bytes.Buffer
	err = oar.EncodeVoyage(&buf, oar.VoyageHeader{
		Runtime:   "claude",
		SessionID: "sess-1",
		CreatedAt: 1700000000000,
	}, records)
	if err != nil {
		t.Fatalf("EncodeVoyage: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 4 {
		t.Fatalf("got %d lines, want 4", len(lines))
	}
	if !strings.Contains(lines[0], `"format":"oar-voyage/3"`) {
		t.Fatalf("header missing oar-voyage/3: %s", lines[0])
	}
	// Root records (seq 0 and seq 2) must explicitly encode "agentPath":[], never null.
	for _, idx := range []int{1, 3} {
		if !strings.Contains(lines[idx], `"agentPath":[]`) {
			t.Fatalf("line %d did not serialize root agentPath as []: %s", idx, lines[idx])
		}
	}

	hdr, decoded, err := oar.DecodeVoyage(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("DecodeVoyage: %v", err)
	}
	if hdr.Format != oar.VoyageFormat || hdr.Version != oar.VoyageVersion {
		t.Fatalf("unexpected decoded header: %+v", hdr)
	}
	if len(decoded) != 3 {
		t.Fatalf("decoded len = %d, want 3", len(decoded))
	}
	for i := range records {
		if !bytes.Equal(decoded[i].Raw, records[i].Raw) {
			t.Fatalf("record %d Raw mismatch: len %d vs %d", i, len(decoded[i].Raw), len(records[i].Raw))
		}
		if decoded[i].AgentPath == nil {
			t.Fatalf("record %d AgentPath is nil", i)
		}
	}
	if !decoded[0].IsRoot() || decoded[1].IsRoot() || !decoded[2].IsRoot() {
		t.Fatalf("unexpected IsRoot values: %v %v %v", decoded[0].IsRoot(), decoded[1].IsRoot(), decoded[2].IsRoot())
	}

	t.Run("rejects_invalid_headers_and_envelopes", func(t *testing.T) {
		badStreams := []string{
			"",
			`{"format":"oar-voyage/2","version":2}` + "\n",
			"{\"format\":\"oar-voyage/3\",\"version\":3}\n" + `{"seq":0,"kind":"frame","sessionId":"s","agentPath":null}` + "\n",
			"{\"format\":\"oar-voyage/3\",\"version\":3}\n" + `{"seq":-1,"kind":"frame","sessionId":"s","agentPath":[]}` + "\n",
			"{\"format\":\"oar-voyage/3\",\"version\":3}\n" + `{"seq":0,"kind":"frame","sessionId":"","agentPath":[]}` + "\n",
			"{\"format\":\"oar-voyage/3\",\"version\":3}\n" +
				`{"seq":2,"kind":"frame","sessionId":"s","agentPath":[]}` + "\n" +
				`{"seq":2,"kind":"frame","sessionId":"s","agentPath":[]}` + "\n",
		}
		for i, s := range badStreams {
			if _, _, err := oar.DecodeVoyage(strings.NewReader(s)); err == nil {
				t.Fatalf("case %d: expected error for malformed voyage stream", i)
			}
		}
	})
}

func TestPreSpawnUnsupportedOptionErrors(t *testing.T) {
	reg := oar.DefaultRegistry()
	ctx := context.Background()

	applyOption := func(opt oar.RefusableOption) oar.SessionOptions {
		o := oar.SessionOptions{CWD: t.TempDir()}
		switch opt {
		case oar.OptionSystemPrompt:
			o.SystemPrompt = "custom sys"
		case oar.OptionAppendSystemPrompt:
			o.AppendSystemPrompt = "append sys"
		case oar.OptionEffort:
			o.Effort = "high"
		case oar.OptionEnv:
			o.Env = map[string]string{"FOO": "bar"}
		case oar.OptionMCPServers:
			o.MCPServers = []oar.MCPServer{{Type: oar.MCPStdio, Name: "srv", Command: "echo"}}
		case oar.OptionMCPServerCredentials:
			o.MCPServers = []oar.MCPServer{{Type: oar.MCPHTTP, Name: "srv", URL: "http://127.0.0.1", Headers: map[string]string{"Authorization": "Bearer secret"}}}
		case oar.OptionDisallowedTools:
			o.DisallowedTools = []string{"bash"}
		case oar.OptionAllowedTools:
			o.AllowedTools = []string{"read"}
		case oar.OptionName:
			o.Name = "worker-1"
		case oar.OptionServiceTier:
			o.ServiceTier = "priority"
		case oar.OptionAdditionalDirectories:
			o.AdditionalDirectories = []string{"/tmp"}
		case oar.OptionOutputSchema:
			o.OutputSchema = []byte(`{"type":"object"}`)
		case oar.OptionLaunchArgs:
			o.LaunchArgs = []string{"--bad-flag"}
		}
		return o
	}

	for _, drv := range reg.List() {
		refused := drv.RefusedOptions()
		if len(refused) == 0 {
			t.Fatalf("driver %q declared empty RefusedOptions", drv.ID())
		}
		for opt := range refused {
			t.Run(drv.ID()+"/"+string(opt), func(t *testing.T) {
				launcher := replaytest.NewLauncher(nil)
				opts := applyOption(opt)
				opts.Launcher = launcher

				sess, err := drv.Open(ctx, opts)
				if err == nil {
					_ = sess.Dispose(ctx)
					t.Fatalf("expected UnsupportedOptionError for %s.%s", drv.ID(), opt)
				}
				var uerr *oar.UnsupportedOptionError
				if !errors.As(err, &uerr) {
					t.Fatalf("got error %T (%v), want *oar.UnsupportedOptionError", err, err)
				}
				if uerr.Runtime != drv.ID() || uerr.Option != opt {
					t.Fatalf("UnsupportedOptionError = %+v, want runtime=%q option=%q", uerr, drv.ID(), opt)
				}
				if launcher.LaunchCount() != 0 {
					t.Fatalf("process was spawned (%d times) despite refused option %s", launcher.LaunchCount(), opt)
				}
			})
		}
	}
}

func TestSubagentDepthLimitAndConcurrencyCap(t *testing.T) {
	ctx := context.Background()

	t.Run("default_depth_limit_1_blocks_recursion", func(t *testing.T) {
		t.Setenv(oar.EnvSubagentDepth, "")
		launcher := replaytest.NewLauncher(replaytest.ClaudeFixtureHandler(replaytest.ClaudeFixtureConfig{}))
		pool := oar.NewSubagentPool(oar.SubagentPoolConfig{})

		sess, err := pool.Spawn(ctx, oar.SubagentRequest{
			ID:      "child-1",
			Runtime: "claude",
			Options: oar.SessionOptions{
				CWD:      t.TempDir(),
				Launcher: launcher,
			},
		})
		if err != nil {
			t.Fatalf("depth 0 spawn failed: %v", err)
		}
		defer sess.Dispose(context.Background())

		launch, ok := launcher.LastLaunch()
		if !ok {
			t.Fatal("missing launch")
		}
		replaytest.AssertEnv(t, launch, oar.EnvSubagentDepth, "1")

		// Simulate execution inside depth-1 child process via OAR_SUBAGENT_DEPTH=1.
		t.Setenv(oar.EnvSubagentDepth, "1")
		_, err = pool.Spawn(ctx, oar.SubagentRequest{
			ID:      "grandchild",
			Runtime: "claude",
			Options: oar.SessionOptions{
				CWD:      t.TempDir(),
				Launcher: launcher,
			},
		})
		if !errors.Is(err, oar.ErrSubagentDepthExceeded) {
			t.Fatalf("got err = %v, want ErrSubagentDepthExceeded", err)
		}
		if launcher.LaunchCount() != 1 {
			t.Fatalf("expected LaunchCount=1 (blocked pre-spawn), got %d", launcher.LaunchCount())
		}
	})

	t.Run("custom_depth_2_and_malformed_depth", func(t *testing.T) {
		d := 1
		launcher := replaytest.NewLauncher(replaytest.ClaudeFixtureHandler(replaytest.ClaudeFixtureConfig{}))
		pool := oar.NewSubagentPool(oar.SubagentPoolConfig{MaxDepth: 2, CurrentDepth: &d})

		sess, err := pool.Spawn(ctx, oar.SubagentRequest{
			ID:      "nested-ok",
			Runtime: "claude",
			Options: oar.SessionOptions{CWD: t.TempDir(), Launcher: launcher},
		})
		if err != nil {
			t.Fatalf("depth 1 with maxDepth 2 failed: %v", err)
		}
		defer sess.Dispose(context.Background())
		launch, _ := launcher.LastLaunch()
		replaytest.AssertEnv(t, launch, oar.EnvSubagentDepth, "2")

		t.Setenv(oar.EnvSubagentDepth, "not-an-int")
		poolEnv := oar.NewSubagentPool(oar.SubagentPoolConfig{})
		_, err = poolEnv.Spawn(ctx, oar.SubagentRequest{
			ID:      "bad-depth",
			Runtime: "claude",
			Options: oar.SessionOptions{CWD: t.TempDir(), Launcher: launcher},
		})
		if !errors.Is(err, oar.ErrInvalidSubagentDepth) {
			t.Fatalf("got err=%v, want ErrInvalidSubagentDepth", err)
		}
	})

	t.Run("default_concurrency_cap_4_enforced_and_released", func(t *testing.T) {
		t.Setenv(oar.EnvSubagentDepth, "0")
		launcher := replaytest.NewLauncher(replaytest.ClaudeFixtureHandler(replaytest.ClaudeFixtureConfig{}))
		pool := oar.NewSubagentPool(oar.SubagentPoolConfig{})
		defer pool.Close(context.Background())

		sessions := make([]oar.Session, 0, 4)
		for i := range 4 {
			s, err := pool.Spawn(ctx, oar.SubagentRequest{
				ID:      fmt.Sprintf("w-%d", i),
				Runtime: "claude",
				Options: oar.SessionOptions{CWD: t.TempDir(), Launcher: launcher},
			})
			if err != nil {
				t.Fatalf("spawn %d failed: %v", i, err)
			}
			sessions = append(sessions, s)
		}

		stats, err := pool.Stats()
		if err != nil || stats.Active != 4 || stats.MaxConcurrent != 4 {
			t.Fatalf("stats = (%+v, %v)", stats, err)
		}

		if _, err := pool.Spawn(ctx, oar.SubagentRequest{
			ID:      "w-5",
			Runtime: "claude",
			Options: oar.SessionOptions{CWD: t.TempDir(), Launcher: launcher},
		}); !errors.Is(err, oar.ErrSubagentConcurrencyCap) {
			t.Fatalf("5th spawn err = %v, want ErrSubagentConcurrencyCap", err)
		}
		if launcher.LaunchCount() != 4 {
			t.Fatalf("LaunchCount = %d, want 4", launcher.LaunchCount())
		}

		// Dispose one slot -> 5th spawn must now succeed.
		if err := sessions[0].Dispose(ctx); err != nil {
			t.Fatalf("Dispose: %v", err)
		}
		s5, err := pool.Spawn(ctx, oar.SubagentRequest{
			ID:      "w-5",
			Runtime: "claude",
			Options: oar.SessionOptions{CWD: t.TempDir(), Launcher: launcher},
		})
		if err != nil {
			t.Fatalf("5th spawn after release failed: %v", err)
		}
		defer s5.Dispose(context.Background())

		// Failed Open must release the slot immediately.
		failLauncher := replaytest.NewLauncher(nil)
		failLauncher.LaunchErr = errors.New("boom")
		if err := sessions[1].Dispose(ctx); err != nil {
			t.Fatalf("Dispose: %v", err)
		}
		if _, err := pool.Spawn(ctx, oar.SubagentRequest{
			ID:      "w-fail",
			Runtime: "claude",
			Options: oar.SessionOptions{CWD: t.TempDir(), Launcher: failLauncher},
		}); err == nil {
			t.Fatal("expected launch failure")
		}
		stats, _ = pool.Stats()
		if stats.Active != 3 {
			t.Fatalf("Active after failed spawn = %d, want 3 (slot must not leak)", stats.Active)
		}
	})
}

func TestControlOutcomeQueueWithdrawAndConcurrency(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var mu sync.Mutex
	var prompts []string
	var activeProc *replaytest.ScriptedProcess

	launcher := replaytest.NewLauncher(func(p *replaytest.ScriptedProcess, line []byte) {
		mu.Lock()
		activeProc = p
		mu.Unlock()
		var msg struct {
			Type    string `json:"type"`
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &msg) != nil || msg.Type != "user" {
			return
		}
		mu.Lock()
		prompts = append(prompts, msg.Message.Content)
		mu.Unlock()
		if msg.Message.Content == "first" {
			// Hold first turn open until test explicitly emits result.
			return
		}
		p.EmitJSON(map[string]any{
			"type":       "result",
			"subtype":    "success",
			"session_id": "s-q",
		})
	})

	sess, err := oar.NewClaudeDriver().Open(ctx, oar.SessionOptions{CWD: t.TempDir(), Launcher: launcher})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer sess.Dispose(context.Background())

	// Subscribe concurrency & self-stop safety test.
	var subMu sync.Mutex
	var seqs []int64
	stop := sess.Subscribe(-1, func(env oar.RecordEnvelope) {
		subMu.Lock()
		seqs = append(seqs, env.Seq)
		subMu.Unlock()
		_ = sess.Records() // Must not deadlock when called inside callback.
	})
	defer stop()

	// Idle Steer / Abort / Withdraw must return ControlRejected.
	if out, err := sess.Steer(ctx, "early"); err != nil || out.Status != oar.ControlRejected || out.Code != "no_active_turn" {
		t.Fatalf("idle Steer = (%+v, %v)", out, err)
	}
	if out, err := sess.Abort(ctx); err != nil || out.Status != oar.ControlRejected || out.Code != "no_active_turn" {
		t.Fatalf("idle Abort = (%+v, %v)", out, err)
	}
	if out, err := sess.Withdraw(ctx, "missing"); err != nil || out.Status != oar.ControlRejected || out.Code != "not_found" {
		t.Fatalf("missing Withdraw = (%+v, %v)", out, err)
	}

	// Start active turn.
	if out, err := sess.Control(ctx, oar.ControlPrompt, "first"); err != nil || out.Status != oar.ControlAccepted {
		t.Fatalf("Prompt = (%+v, %v)", out, err)
	}

	// Busy Prompt & Compact rejected.
	if out, err := sess.Prompt(ctx, "second"); err != nil || out.Status != oar.ControlRejected || out.Code != "busy" {
		t.Fatalf("busy Prompt = (%+v, %v)", out, err)
	}
	if out, err := sess.Compact(ctx); err != nil || out.Status != oar.ControlRejected || out.Code != "busy" {
		t.Fatalf("busy Compact = (%+v, %v)", out, err)
	}

	// Queue two items and withdraw the first queued one before turn ends.
	if out, err := sess.Queue(ctx, "drop-me", oar.WithInputID("in-drop")); err != nil || out.Status != oar.ControlAccepted {
		t.Fatalf("Queue drop-me = (%+v, %v)", out, err)
	}
	if out, err := sess.Queue(ctx, "keep-me", oar.WithInputID("in-keep")); err != nil || out.Status != oar.ControlAccepted {
		t.Fatalf("Queue keep-me = (%+v, %v)", out, err)
	}
	if out, err := sess.Withdraw(ctx, "in-drop"); err != nil || out.Status != oar.ControlAccepted {
		t.Fatalf("Withdraw = (%+v, %v)", out, err)
	}

	// Complete the first turn -> "keep-me" should automatically drain, "drop-me" must never be sent!
	waitUntil(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return activeProc != nil && len(prompts) == 1
	})
	mu.Lock()
	p := activeProc
	mu.Unlock()
	p.EmitJSON(map[string]any{"type": "result", "subtype": "success", "session_id": "s-q"})

	waitUntil(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(prompts) >= 2
	})
	waitTurnCount(t, sess, 2)

	mu.Lock()
	gotPrompts := append([]string(nil), prompts...)
	mu.Unlock()
	if len(gotPrompts) != 2 || gotPrompts[0] != "first" || gotPrompts[1] != "keep-me" {
		t.Fatalf("dispatched prompts = %v, want [first keep-me]", gotPrompts)
	}

	// Verify monotonic seq observed by subscriber.
	subMu.Lock()
	for i := 1; i < len(seqs); i++ {
		if seqs[i] <= seqs[i-1] {
			t.Fatalf("non-monotonic subscriber seqs: %v", seqs)
		}
	}
	subMu.Unlock()

	if err := sess.Dispose(ctx); err != nil {
		t.Fatalf("Dispose: %v", err)
	}
	if out, err := sess.Prompt(ctx, "after-close"); err != nil || out.Status != oar.ControlNotRunning {
		t.Fatalf("post-dispose Prompt = (%+v, %v), want not_running", out, err)
	}
}

func TestExecLauncherProcessGroupCleanup(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Spawns a shell with a sleeping grandchild; Close() must kill the whole -pgid well under 3s.
	proc, err := (oar.ExecLauncher{}).Launch(ctx, oar.LaunchSpec{
		Command: "/bin/sh",
		Args:    []string{"-c", "echo ready; sleep 30 & wait"},
		Dir:     os.TempDir(),
	})
	if err != nil {
		t.Fatalf("Launch: %v", err)
	}

	buf := make([]byte, 64)
	n, err := proc.Stdout().Read(buf)
	if err != nil || !strings.Contains(string(buf[:n]), "ready") {
		t.Fatalf("Read stdout = (%q, %v)", string(buf[:n]), err)
	}

	start := time.Now()
	if err := proc.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	elapsed := time.Since(start)
	if elapsed > 3*time.Second {
		t.Fatalf("process group close took %v (> 3s)", elapsed)
	}
}

func waitUntil(t *testing.T, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out waiting for condition")
}

func waitTurnCount(t *testing.T, sess oar.Session, want int) {
	t.Helper()
	waitUntil(t, func() bool {
		n := 0
		for _, rec := range sess.Records() {
			for _, ev := range rec.Events {
				if ev.Kind == oar.EventTurnEnded {
					n++
				}
			}
		}
		return n >= want
	})
}

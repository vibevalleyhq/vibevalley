package artifact_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/artifact"
	"github.com/vibevalleyhq/vibevalley/internal/durable"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func TestCompilerMultiFileTSXBundleUnder10ms(t *testing.T) {
	// Warm up Go/esbuild package initialization once so steady-state compile latency is measured cleanly,
	// while also checking total duration stays strictly in the single-digit millisecond range.
	_, err := artifact.CompileBundle(artifact.CompileRequest{
		Entry: "warmup.ts",
		Files: map[string]string{"warmup.ts": "export const w = 1;"},
	})
	if err != nil {
		t.Fatalf("warmup compile failed: %v", err)
	}

	res, err := artifact.CompileBundle(artifact.CompileRequest{
		Entry:   "src/App.tsx",
		Title:   "Farm Overview",
		Display: contract.ArtifactDisplayDashboard,
		Files: map[string]string{
			"src/styles.css": `
.dashboard { display: grid; gap: 12px; padding: 16px; }
.card { border: 1px solid #ddd; border-radius: 8px; }
`,
			"src/data.json": `{"title":"Harvest Metrics","count":42}`,
			"src/components/MetricCard.tsx": `
import data from "../data.json";
export function MetricCard({ label }: { label: string }) {
  return (
    <section className="card">
      <h2>{label}</h2>
      <p>{data.title}: {data.count}</p>
    </section>
  );
}
`,
			"src/App.tsx": `
import "./styles.css";
import { createRoot } from "react-dom/client";
import { MetricCard } from "./components/MetricCard";

export function App() {
  return (
    <main className="dashboard">
      <MetricCard label="Daily Output" />
    </main>
  );
}

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
`,
		},
	})
	if err != nil {
		t.Fatalf("CompileBundle failed: %v", err)
	}
	if res.Duration >= 10*time.Millisecond {
		t.Fatalf("expected compile duration < 10ms, got %v", res.Duration)
	}
	if !strings.Contains(res.CSS, ".dashboard") || !strings.Contains(res.CSS, ".card") {
		t.Fatalf("expected CSS bundle output, got: %q", res.CSS)
	}
	if !strings.Contains(res.JS, "Daily Output") || !strings.Contains(res.JS, "Harvest Metrics") {
		t.Fatalf("expected bundled TSX/JSON output, got: %q", res.JS)
	}
	if !strings.Contains(res.HTML, `data-vv-display="dashboard"`) || !strings.Contains(res.HTML, "<style>") || !strings.Contains(res.HTML, "<script>") {
		t.Fatalf("expected wrapped HTML document, got: %s", res.HTML)
	}
	if len(res.SHA256) != 64 || len(res.SourceSHA256) != 64 {
		t.Fatalf("expected 64-hex SHA256 digests, got html=%q src=%q", res.SHA256, res.SourceSHA256)
	}
}

func TestCompilerSyntaxAndImportErrorsWithSelfHealing(t *testing.T) {
	ctx := context.Background()
	svc, err := artifact.NewService(artifact.ServiceConfig{})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	// Warm esbuild once before timing error turnaround.
	_, _ = artifact.CompileBundle(artifact.CompileRequest{
		Entry: "w.ts",
		Files: map[string]string{"w.ts": "export const ok = 1;"},
	})

	// 1. Multi-file syntax error on exact line 4, column 19 of src/components/Widget.tsx.
	brokenFiles := map[string]string{
		"src/App.tsx": `import { Widget } from "./components/Widget";
export const App = () => <Widget />;
`,
		"src/components/Widget.tsx": `export function Widget() {
  const title = "Panel";
  // syntax error on line 4 right after '='
  const broken = ;
  return <div>{title}{broken}</div>;
}
`,
	}

	t0 := time.Now()
	_, pubErr := svc.Deliverables.Publish(ctx, artifact.PublishRequest{
		ID:      "art-heal-1",
		Title:   "Self-Healing Widget",
		Display: contract.ArtifactDisplayDashboard,
		Bundle: &artifact.CompileRequest{
			Entry: "src/App.tsx",
			Files: brokenFiles,
		},
	})
	elapsed := time.Since(t0)
	if pubErr == nil {
		t.Fatal("expected compile error for syntax mistake, got nil")
	}
	if elapsed >= 10*time.Millisecond {
		t.Fatalf("expected compile failure returned in < 10ms, got %v", elapsed)
	}
	if !errors.Is(pubErr, artifact.ErrCompileFailed) {
		t.Fatalf("expected errors.Is(ErrCompileFailed), got %v", pubErr)
	}

	var ce *artifact.CompileError
	if !errors.As(pubErr, &ce) {
		t.Fatalf("expected *artifact.CompileError, got %T", pubErr)
	}
	if len(ce.Diagnostics) == 0 {
		t.Fatal("expected structured diagnostics")
	}
	d := ce.Diagnostics[0]
	if d.File != "src/components/Widget.tsx" {
		t.Fatalf("expected diagnostic file src/components/Widget.tsx, got %q", d.File)
	}
	if d.Line != 4 || d.Column != 18 {
		t.Fatalf("expected line=4 column=18, got line=%d column=%d (msg=%q)", d.Line, d.Column, d.Message)
	}
	if ce.Diagnostics[0].Message == "" {
		t.Fatal("expected non-empty error message")
	}
	var toolPayload struct {
		Code        string                `json:"code"`
		Retryable   bool                  `json:"retryable"`
		Diagnostics []artifact.Diagnostic `json:"diagnostics"`
	}
	if err := json.Unmarshal(ce.ToolErrorPayload(), &toolPayload); err != nil {
		t.Fatalf("ToolErrorPayload unmarshal failed: %v", err)
	}
	if toolPayload.Code != "artifact_compile_error" || !toolPayload.Retryable || len(toolPayload.Diagnostics) == 0 {
		t.Fatalf("unexpected ToolErrorPayload: %+v", toolPayload)
	}

	// Ensure nothing was persisted on failed compile.
	if cards := svc.Deliverables.ListCards(ctx, artifact.DeliverableFilter{}); len(cards) != 0 {
		t.Fatalf("expected 0 persisted cards after failed compile, got %d", len(cards))
	}
	if stats := svc.CAS.Stats(); stats.UniqueBlobs != 0 {
		t.Fatalf("expected 0 CAS blobs persisted after failed compile, got %d", stats.UniqueBlobs)
	}

	// 2. Missing import diagnostic check.
	_, importErr := svc.Deliverables.Publish(ctx, artifact.PublishRequest{
		ID: "art-heal-1",
		Bundle: &artifact.CompileRequest{
			Entry: "src/App.tsx",
			Files: map[string]string{
				"src/App.tsx": "import { Missing } from \"./NoSuchModule\";\nexport const App = () => <div>{Missing}</div>;\n",
			},
		},
	})
	var importCE *artifact.CompileError
	if !errors.As(importErr, &importCE) || len(importCE.Diagnostics) == 0 {
		t.Fatalf("expected *CompileError for missing import, got %v", importErr)
	}
	if importCE.Diagnostics[0].File != "src/App.tsx" || importCE.Diagnostics[0].Line != 1 {
		t.Fatalf("unexpected import diagnostic location: %+v", importCE.Diagnostics[0])
	}
	if !strings.Contains(importCE.Diagnostics[0].Message, "./NoSuchModule") {
		t.Fatalf("expected missing module path in diagnostic message, got %q", importCE.Diagnostics[0].Message)
	}

	// 3. Self-healing second compile succeeds and persists v1 cleanly.
	fixedFiles := map[string]string{
		"src/App.tsx": brokenFiles["src/App.tsx"],
		"src/components/Widget.tsx": `export function Widget() {
  const title = "Panel";
  const fixed = "Healthy";
  return <div>{title}: {fixed}</div>;
}
`,
	}
	t1 := time.Now()
	pubRes, err := svc.Deliverables.Publish(ctx, artifact.PublishRequest{
		ID:        "art-heal-1",
		Title:     "Self-Healing Widget",
		Display:   contract.ArtifactDisplayDashboard,
		ChannelID: "chan-1",
		IssueID:   "iss-1",
		Bundle: &artifact.CompileRequest{
			Entry: "src/App.tsx",
			Files: fixedFiles,
		},
	})
	if err != nil {
		t.Fatalf("self-healing second compile failed: %v", err)
	}
	if time.Since(t1) >= 10*time.Millisecond {
		t.Fatalf("expected second compile < 10ms, got %v", time.Since(t1))
	}
	if pubRes.Version.Version != 1 || pubRes.Card.Display != contract.ArtifactDisplayDashboard {
		t.Fatalf("unexpected published card/version: %+v", pubRes)
	}

	// 4. Multi-file JSX + CSS bundle also compiles in < 10ms.
	jsxRes, err := artifact.CompileBundle(artifact.CompileRequest{
		Entry:   "index.jsx",
		Display: contract.ArtifactDisplayWhiteboard,
		Files: map[string]string{
			"theme.css": ".board { background: var(--vv-page); }",
			"node.jsx":  `export function Node({ label }) { return <div className="node">{label}</div>; }`,
			"index.jsx": `import "./theme.css"; import { Node } from "./node"; export const App = () => <div className="board"><Node label="Idea" /></div>;`,
		},
	})
	if err != nil {
		t.Fatalf("JSX compile failed: %v", err)
	}
	if jsxRes.Duration >= 10*time.Millisecond || !strings.Contains(jsxRes.CSS, ".board") || !strings.Contains(jsxRes.JS, "Idea") {
		t.Fatalf("unexpected JSX compile output: dur=%v", jsxRes.Duration)
	}
}

type healingMockModel struct {
	turns         atomic.Int32
	seenToolError string
}

func (m *healingMockModel) Generate(_ context.Context, req durable.ModelRequest, _ func(string)) (durable.ModelResponse, error) {
	turn := m.turns.Add(1)
	if turn == 1 {
		args, _ := json.Marshal(artifact.PublishToolInput{
			ID:      "art-durable-heal",
			Title:   "Durable Dashboard",
			Display: string(contract.ArtifactDisplayDashboard),
			Entry:   "src/App.tsx",
			Files: map[string]string{
				"src/App.tsx": "import { Card } from \"./Card\";\nexport const App = () => <Card />;\n",
				"src/Card.tsx": `export function Card() {
  const label = "KPI";
  const broken = ;
  return <div>{label}{broken}</div>;
}
`,
			},
		})
		return durable.ModelResponse{
			Text: "Publishing dashboard artifact...",
			ToolCalls: []durable.ToolCall{{
				ID:       "call-1",
				ToolName: "artifact_publish",
				ArgsJSON: args,
			}},
		}, nil
	}

	if turn == 2 {
		// Verify durable fed the structured CompileError (with file:line:col) back into pi.tool_result.
		for _, entry := range req.Transcript.Entries {
			if entry.Kind == store.EntryToolResult {
				m.seenToolError = string(entry.PayloadJSON)
			}
		}
		args, _ := json.Marshal(artifact.PublishToolInput{
			ID:        "art-durable-heal",
			Title:     "Durable Dashboard",
			Display:   string(contract.ArtifactDisplayDashboard),
			ChannelID: "chan-durable",
			IssueID:   "iss-durable",
			Entry:     "src/App.tsx",
			Files: map[string]string{
				"src/App.tsx": "import { Card } from \"./Card\";\nexport const App = () => <Card />;\n",
				"src/Card.tsx": `export function Card() {
  const label = "KPI";
  const healthy = 99;
  return <div>{label}: {healthy}</div>;
}
`,
			},
		})
		return durable.ModelResponse{
			Text: "Fixed syntax error and re-publishing...",
			ToolCalls: []durable.ToolCall{{
				ID:       "call-2",
				ToolName: "artifact_publish",
				ArgsJSON: args,
			}},
		}, nil
	}

	return durable.ModelResponse{Text: "Artifact compiled and published cleanly."}, nil
}

func TestDurableSameTurnSelfHealingLoop(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	svc, err := artifact.NewService(artifact.ServiceConfig{})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	// Warm esbuild once so both turns stay well under 10ms.
	_, _ = artifact.CompileBundle(artifact.CompileRequest{
		Entry: "w.ts",
		Files: map[string]string{"w.ts": "export const w = 1;"},
	})

	st := store.NewMemory()
	defer st.Close()

	if _, err := st.CreateConversation(ctx, store.Conversation{
		ID:               "conv-heal",
		ProviderAffinity: "anthropic",
	}); err != nil {
		t.Fatalf("CreateConversation: %v", err)
	}
	userPayload, _ := json.Marshal(map[string]string{"text": "Build a KPI dashboard artifact"})
	if _, err := st.AppendEntry(ctx, "conv-heal", store.EntryUser, userPayload); err != nil {
		t.Fatalf("AppendEntry: %v", err)
	}

	model := &healingMockModel{}
	sched := durable.NewScheduler(st)
	defer sched.Close()

	var failedPrePersistCards int
	durable.RegisterGenerationPhases(sched, durable.GenerationDeps{
		Store: st,
		Model: model,
		Tools: durable.ToolExecutorFunc(func(ctx context.Context, _ string, call durable.ToolCall) (json.RawMessage, error) {
			if call.ToolName != "artifact_publish" {
				return nil, durable.ErrUnknownTool
			}
			out, execErr := svc.ExecutePublishTool(ctx, call.ArgsJSON)
			if execErr != nil {
				// Confirm nothing persisted when compile failed.
				failedPrePersistCards = len(svc.Deliverables.ListCards(ctx, artifact.DeliverableFilter{}))
			}
			return out, execErr
		}),
	})

	cpBytes, _ := json.Marshal(durable.GenerationCheckpoint{
		ConversationID: "conv-heal",
		TaskPrompt:     "Build KPI dashboard",
	})
	created, err := sched.StartTask(ctx, store.Task{
		ID:             "task-heal",
		ConversationID: "conv-heal",
		Kind:           durable.TaskKindGeneration,
		PhaseName:      durable.PhaseGenerate,
		CheckpointJSON: cpBytes,
	})
	if err != nil {
		t.Fatalf("StartTask: %v", err)
	}

	done, err := sched.WaitTask(ctx, created.Task.ID)
	if err != nil {
		t.Fatalf("WaitTask: %v", err)
	}
	if done.Status != store.TaskTerminal || done.TerminalReason != store.ReasonCompleted {
		t.Fatalf("expected completed durable task, got status=%s reason=%s err=%s", done.Status, done.TerminalReason, done.ErrorText)
	}
	if model.turns.Load() != 3 {
		t.Fatalf("expected 3 model turns (fail, heal, complete), got %d", model.turns.Load())
	}
	if !strings.Contains(model.seenToolError, "src/Card.tsx:3:18") {
		t.Fatalf("expected durable transcript tool_result to contain exact file:line:col, got: %s", model.seenToolError)
	}
	if failedPrePersistCards != 0 {
		t.Fatalf("expected 0 cards persisted on first failed compile, got %d", failedPrePersistCards)
	}

	cards := svc.Deliverables.ListCards(ctx, artifact.DeliverableFilter{IssueID: "iss-durable"})
	if len(cards) != 1 || cards[0].Version != 1 || cards[0].Display != contract.ArtifactDisplayDashboard {
		t.Fatalf("expected 1 healed ArtifactCardView v1, got %+v", cards)
	}
}

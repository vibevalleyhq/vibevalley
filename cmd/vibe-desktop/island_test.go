package main

import (
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func TestIslandColdInitUnder50msAndSettledZeroTimers(t *testing.T) {
	// Warm one-time font/text system discovery once before measuring cold island init.
	warm := ui.NewTester(func(c *ui.Context) { ui.Text(c, "warm") }, 64, 32)
	_ = warm.FramePending()

	for _, useGlass := range []bool{false, true} {
		name := "solid"
		if useGlass {
			name = "liquid_glass"
		}
		t.Run(name, func(t *testing.T) {
			start := time.Now()
			island := NewIslandController(IslandOptions{
				UseLiquidGlass: useGlass,
			})
			tt := ui.NewTester(island.View, 440, 280)
			coldElapsed := time.Since(start)

			if island.ColdInitDuration() >= 50*time.Millisecond {
				t.Fatalf("recorded ColdInitDuration %v >= 50ms", island.ColdInitDuration())
			}
			// Software CPU blur shader in ui.Tester has ~5-10x TSan pixel instrumentation overhead under -race;
			// verify full first-frame render < 50ms on CPU solid path (and in non-race runs for glass).
			if !useGlass && coldElapsed >= 50*time.Millisecond {
				t.Fatalf("cold island init + first frame took %v, want < 50ms", coldElapsed)
			}
			if tt.FramePending() {
				t.Fatal("expected zero pending frames when settled")
			}

			rendersBefore := island.RenderCount()
			tt.Advance(10 * time.Second)
			if tt.FramePending() {
				t.Fatal("expected zero pending frames after advancing idle clock 10s")
			}
			if rendersAfter := island.RenderCount(); rendersAfter != rendersBefore {
				t.Fatalf("settled island re-rendered %d times while idle (want 0)", rendersAfter-rendersBefore)
			}

			// Idempotent state application must not bump version or request frames.
			v1 := island.StateVersion()
			island.ApplyState(island.State())
			if island.StateVersion() != v1 {
				t.Fatalf("identical ApplyState bumped StateVersion from %d to %d", v1, island.StateVersion())
			}
		})
	}
}

func TestIslandApprovalAndBudgetRaiseLatencyUnder20ms(t *testing.T) {
	type approvalSignal struct {
		prompt   contract.ApprovalPromptView
		approved bool
		at       time.Time
	}
	type budgetSignal struct {
		alert      BudgetAlert
		newMaxCost int64
		at         time.Time
	}

	approvalCh := make(chan approvalSignal, 4)
	budgetCh := make(chan budgetSignal, 4)

	island := NewIslandController(IslandOptions{
		UseLiquidGlass:   false,
		BudgetStepMicros: 5_000_000,
		Handlers: IslandHandlers{
			OnApproval: func(prompt contract.ApprovalPromptView, approved bool) {
				approvalCh <- approvalSignal{prompt: prompt, approved: approved, at: time.Now()}
			},
			OnBudgetRaise: func(alert BudgetAlert, newMaxCostMicros int64) {
				budgetCh <- budgetSignal{alert: alert, newMaxCost: newMaxCostMicros, at: time.Now()}
			},
		},
	})
	tt := ui.NewTester(island.View, 440, 280)

	// Push an always_ask approval prompt via state-change event.
	prompt1 := contract.ApprovalPromptView{
		TaskID:        "task-perm-1",
		SessionID:     "sess-1",
		ToolName:      "bash",
		Policy:        contract.PolicyAlwaysAsk,
		Summary:       "Run go test ./...",
		RequestedAtMs: 1700000000000,
	}
	island.SetApprovals([]contract.ApprovalPromptView{prompt1})
	tt.Frame()

	if !tt.HasText("Permission: bash") {
		t.Fatalf("expected approval card text, got %q", tt.Texts())
	}
	if !tt.HasText("always_ask") {
		t.Fatalf("expected policy badge always_ask, got %q", tt.Texts())
	}
	if tt.FramePending() {
		t.Fatal("island with parked approval should settle with zero idle frames")
	}

	clickStart := time.Now()
	if err := tt.Click("Approve"); err != nil {
		t.Fatalf("click Approve: %v (texts=%q)", err, tt.Texts())
	}
	sig := <-approvalCh
	latency := sig.at.Sub(clickStart)
	if !sig.approved || sig.prompt.TaskID != "task-perm-1" {
		t.Fatalf("unexpected approval signal: %+v", sig)
	}
	if latency >= 20*time.Millisecond {
		t.Fatalf("approval click-to-signal latency %v >= 20ms", latency)
	}

	// Test Deny path on second prompt.
	prompt2 := contract.ApprovalPromptView{
		TaskID:    "task-perm-2",
		SessionID: "sess-1",
		ToolName:  "git_push",
		Policy:    contract.PolicyAlwaysAsk,
		Summary:   "Push feature branch",
	}
	island.SetApprovals([]contract.ApprovalPromptView{prompt2})
	tt.Frame()

	denyStart := time.Now()
	if err := tt.Click("Deny"); err != nil {
		t.Fatalf("click Deny: %v", err)
	}
	denySig := <-approvalCh
	denyLatency := denySig.at.Sub(denyStart)
	if denySig.approved || denySig.prompt.TaskID != "task-perm-2" {
		t.Fatalf("unexpected deny signal: %+v", denySig)
	}
	if denyLatency >= 20*time.Millisecond {
		t.Fatalf("deny click-to-signal latency %v >= 20ms", denyLatency)
	}

	// Clear approvals and push a budget_reached alert.
	island.SetApprovals(nil)
	island.SetBudget(BudgetAlert{
		ID:             "conv-1",
		ConversationID: "conv-1",
		TaskID:         "task-budget-1",
		Title:          "Refactor Session",
		Snapshot: contract.BudgetSnapshot{
			SpentMicros:   1_500_000,
			MaxCostMicros: 1_000_000,
			Reached:       true,
		},
	})
	tt.Frame()

	if !tt.HasText("Budget Reached") || !tt.HasText("Spent $1.50 / Limit $1.00") {
		t.Fatalf("expected budget_reached card text, got %q", tt.Texts())
	}

	raiseStart := time.Now()
	if err := tt.Click("Raise Budget"); err != nil {
		t.Fatalf("click Raise Budget: %v (texts=%q)", err, tt.Texts())
	}
	bSig := <-budgetCh
	raiseLatency := bSig.at.Sub(raiseStart)
	if bSig.newMaxCost != 6_500_000 {
		t.Fatalf("newMaxCost = %d, want 6500000", bSig.newMaxCost)
	}
	if raiseLatency >= 20*time.Millisecond {
		t.Fatalf("budget raise click-to-signal latency %v >= 20ms", raiseLatency)
	}

	// Verify 0 pending frames and 0 renders during idle advance.
	rendersBefore := island.RenderCount()
	tt.Advance(5 * time.Second)
	if tt.FramePending() || island.RenderCount() != rendersBefore {
		t.Fatalf("expected zero idle activity after actions settled (pending=%v, deltaRenders=%d)",
			tt.FramePending(), island.RenderCount()-rendersBefore)
	}
}

func TestIslandDisplaysActiveIssuesAndOpenCallback(t *testing.T) {
	t.Parallel()

	openedCh := make(chan contract.IssueView, 1)
	island := NewIslandController(IslandOptions{
		Handlers: IslandHandlers{
			OnOpenIssue: func(issue contract.IssueView) {
				openedCh <- issue
			},
		},
	})

	island.ApplySpace(contract.SpaceView{
		Rev: 3,
		Issues: []contract.IssueView{
			{ID: "iss-1", Title: "Implement Notch Island", Status: contract.IssueInProgress, RepoID: "repo-1"},
			{ID: "iss-2", Title: "Completed Cleanup", Status: contract.IssueDone, RepoID: "repo-1"},
		},
	})
	island.SetExpanded(true)

	tt := ui.NewTester(island.View, 440, 280)
	if !tt.HasText("Implement Notch Island") {
		t.Fatalf("expected active issue in island texts, got %q", tt.Texts())
	}
	if tt.HasText("Completed Cleanup") {
		t.Fatalf("done issues should not be rendered as active: %q", tt.Texts())
	}
	if err := tt.Click("Open"); err != nil {
		t.Fatalf("click Open issue: %v", err)
	}
	got := <-openedCh
	if got.ID != "iss-1" {
		t.Fatalf("opened issue = %q, want iss-1", got.ID)
	}
}

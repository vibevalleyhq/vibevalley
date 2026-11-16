package main

import (
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/plugins/glass"
	"github.com/egoist/mygo/ui"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

const defaultBudgetStepMicros int64 = 5_000_000 // +$5.00 USD

// BudgetAlert associates a Contract BudgetSnapshot with its owning conversation/task
// for display and one-click limit raising inside the Notch Island.
type BudgetAlert struct {
	ID             string                  `json:"id"`
	ConversationID string                  `json:"conversationId,omitempty"`
	TaskID         string                  `json:"taskId,omitempty"`
	Title          string                  `json:"title,omitempty"`
	Snapshot       contract.BudgetSnapshot `json:"snapshot"`
}

// IslandState holds the immutable UI state rendered by the GPU Notch Island.
type IslandState struct {
	Issues    []contract.IssueView          `json:"issues,omitempty"`
	Approvals []contract.ApprovalPromptView `json:"approvals,omitempty"`
	Budgets   []BudgetAlert                 `json:"budgets,omitempty"`
	Expanded  bool                          `json:"expanded"`
}

// IslandHandlers wires click actions from the Notch Island directly to in-process signals.
type IslandHandlers struct {
	OnApproval    func(prompt contract.ApprovalPromptView, approved bool)
	OnBudgetRaise func(alert BudgetAlert, newMaxCostMicros int64)
	OnOpenIssue   func(issue contract.IssueView)
	OnToggle      func(expanded bool)
}

// IslandOptions configures IslandController construction.
type IslandOptions struct {
	Handlers         IslandHandlers
	BudgetStepMicros int64
	UseLiquidGlass   bool
}

// IslandController renders VibeValley's Notch Island using github.com/egoist/mygo/ui.
// All redraws are strictly event-driven (zero background timers or animations when settled).
type IslandController struct {
	mu           sync.Mutex
	state        IslandState
	handlers     IslandHandlers
	budgetStep   int64
	liquidGlass  bool
	win          *mygo.Window
	coldInitDur  time.Duration
	stateVersion atomic.Uint64
	renderCount  atomic.Uint64
	notifyCh     chan struct{}
	subscribers  map[uint64]func(IslandState)
	nextSubID    uint64
}

// NewIslandController constructs an event-driven Notch Island controller.
func NewIslandController(opts IslandOptions) *IslandController {
	start := time.Now()
	step := opts.BudgetStepMicros
	if step <= 0 {
		step = defaultBudgetStepMicros
	}
	ctrl := &IslandController{
		handlers:    opts.Handlers,
		budgetStep:  step,
		liquidGlass: opts.UseLiquidGlass,
		notifyCh:    make(chan struct{}, 1),
		subscribers: make(map[uint64]func(IslandState)),
	}
	ctrl.coldInitDur = time.Since(start)
	return ctrl
}

// ColdInitDuration reports the time taken to initialize the controller.
func (ic *IslandController) ColdInitDuration() time.Duration {
	return ic.coldInitDur
}

// StateVersion returns a monotonically increasing counter bumped on each state mutation.
func (ic *IslandController) StateVersion() uint64 {
	return ic.stateVersion.Load()
}

// RenderCount returns the total number of UI frames built by View.
func (ic *IslandController) RenderCount() uint64 {
	return ic.renderCount.Load()
}

// NotifyChan returns a buffered wakeup channel pulsed on state changes.
func (ic *IslandController) NotifyChan() <-chan struct{} {
	return ic.notifyCh
}

// SetWindow attaches a native MyGo window so state changes invalidate its surface cleanly.
func (ic *IslandController) SetWindow(win *mygo.Window) {
	ic.mu.Lock()
	ic.win = win
	ic.mu.Unlock()
}

// SubscribeStateChange registers fn for state-change notifications and returns an unsubscribe closure.
func (ic *IslandController) SubscribeStateChange(fn func(IslandState)) func() {
	if fn == nil {
		return func() {}
	}
	ic.mu.Lock()
	id := ic.nextSubID + 1
	ic.nextSubID = id
	ic.subscribers[id] = fn
	ic.mu.Unlock()
	return func() {
		ic.mu.Lock()
		delete(ic.subscribers, id)
		ic.mu.Unlock()
	}
}

// State returns a snapshot copy of the current IslandState.
func (ic *IslandController) State() IslandState {
	ic.mu.Lock()
	defer ic.mu.Unlock()
	return cloneIslandState(ic.state)
}

// ApplyState replaces the island state if changed and triggers a single event-driven redraw.
func (ic *IslandController) ApplyState(next IslandState) {
	ic.mu.Lock()
	if !next.Expanded && hasUrgentAlert(next) {
		next.Expanded = true
	}
	cloned := cloneIslandState(next)
	if equalIslandState(ic.state, cloned) {
		ic.mu.Unlock()
		return
	}
	ic.state = cloned
	ic.mu.Unlock()
	ic.emitChanged(cloned)
}

// ApplySpace updates active issues and parked approvals from a Chord SpaceView snapshot.
func (ic *IslandController) ApplySpace(space contract.SpaceView) {
	ic.mu.Lock()
	next := cloneIslandState(ic.state)
	next.Issues = activeIssuesOnly(space.Issues)
	next.Approvals = slices.Clone(space.Approvals)
	if hasUrgentAlert(next) {
		next.Expanded = true
	}
	if equalIslandState(ic.state, next) {
		ic.mu.Unlock()
		return
	}
	ic.state = next
	ic.mu.Unlock()
	ic.emitChanged(next)
}

// SetIssues updates displayed issues without starting any polling or animation timers.
func (ic *IslandController) SetIssues(issues []contract.IssueView) {
	ic.mu.Lock()
	next := cloneIslandState(ic.state)
	next.Issues = activeIssuesOnly(issues)
	if equalIslandState(ic.state, next) {
		ic.mu.Unlock()
		return
	}
	ic.state = next
	ic.mu.Unlock()
	ic.emitChanged(next)
}

// SetApprovals updates parked always_ask approval prompts and auto-expands when non-empty.
func (ic *IslandController) SetApprovals(approvals []contract.ApprovalPromptView) {
	ic.mu.Lock()
	next := cloneIslandState(ic.state)
	next.Approvals = slices.Clone(approvals)
	if len(next.Approvals) > 0 {
		next.Expanded = true
	}
	if equalIslandState(ic.state, next) {
		ic.mu.Unlock()
		return
	}
	ic.state = next
	ic.mu.Unlock()
	ic.emitChanged(next)
}

// SetBudget upserts a budget alert snapshot and auto-expands if Reached is true.
func (ic *IslandController) SetBudget(alert BudgetAlert) {
	if alert.ID == "" {
		alert.ID = firstNonEmpty(alert.TaskID, alert.ConversationID, "session")
	}
	ic.mu.Lock()
	next := cloneIslandState(ic.state)
	replaced := false
	for i := range next.Budgets {
		if next.Budgets[i].ID == alert.ID {
			next.Budgets[i] = alert
			replaced = true
			break
		}
	}
	if !replaced {
		next.Budgets = append(next.Budgets, alert)
	}
	if alert.Snapshot.Reached {
		next.Expanded = true
	}
	if equalIslandState(ic.state, next) {
		ic.mu.Unlock()
		return
	}
	ic.state = next
	ic.mu.Unlock()
	ic.emitChanged(next)
}

// ClearBudget removes a budget alert by ID.
func (ic *IslandController) ClearBudget(id string) {
	ic.mu.Lock()
	next := cloneIslandState(ic.state)
	filtered := next.Budgets[:0]
	for _, b := range next.Budgets {
		if b.ID != id {
			filtered = append(filtered, b)
		}
	}
	next.Budgets = filtered
	if equalIslandState(ic.state, next) {
		ic.mu.Unlock()
		return
	}
	ic.state = next
	ic.mu.Unlock()
	ic.emitChanged(next)
}

// SetExpanded toggles the expanded card view manually.
func (ic *IslandController) SetExpanded(expanded bool) {
	ic.mu.Lock()
	if ic.state.Expanded == expanded {
		ic.mu.Unlock()
		return
	}
	next := cloneIslandState(ic.state)
	next.Expanded = expanded
	ic.state = next
	onToggle := ic.handlers.OnToggle
	ic.mu.Unlock()

	if onToggle != nil {
		onToggle(expanded)
	}
	ic.emitChanged(next)
}

func (ic *IslandController) emitChanged(snapshot IslandState) {
	ic.stateVersion.Add(1)
	select {
	case ic.notifyCh <- struct{}{}:
	default:
	}

	ic.mu.Lock()
	win := ic.win
	subs := make([]func(IslandState), 0, len(ic.subscribers))
	for _, fn := range ic.subscribers {
		subs = append(subs, fn)
	}
	ic.mu.Unlock()

	for _, fn := range subs {
		fn(cloneIslandState(snapshot))
	}
	if win != nil && !win.IsDestroyed() {
		win.Invalidate()
	}
}

// WindowOptions returns native MyGo WindowOptions for a frameless floating Notch Island panel.
func (ic *IslandController) WindowOptions(displayWidth int) mygo.WindowOptions {
	width := 440
	height := 280
	x := 0
	if displayWidth > width {
		x = (displayWidth - width) / 2
	}
	return mygo.WindowOptions{
		Title:           "VibeValley Island",
		Width:           width,
		Height:          height,
		X:               x,
		Y:               0,
		Frameless:       true,
		AlwaysOnTop:     true,
		Panel:           true,
		Transparent:     true,
		DisableResize:   true,
		DisableShadow:   true,
		SkipTaskbar:     true,
		CornerRadius:    18,
		BackgroundColor: "transparent",
		Content:         ui.View(ic.View),
	}
}

// View builds the native MyGo UI tree for one settled frame.
// It intentionally avoids timers, loops, spinners, or animations so idle CPU stays at 0%.
func (ic *IslandController) View(c *ui.Context) {
	ic.renderCount.Add(1)
	st := ic.State()
	handlers := ic.snapshotHandlers()
	t := c.Theme()

	waitingCount := len(st.Approvals) + countReachedBudgets(st.Budgets)
	workingCount := countIssuesByStatus(st.Issues, contract.IssueInProgress)
	surfaceBg := ui.RGBA(21, 20, 19, 0.94)
	cardBg := ui.RGBA(34, 32, 30, 0.96)
	cream := ui.RGB(238, 220, 178)
	muted := ui.RGB(169, 164, 158)
	leaf := ui.RGB(116, 160, 70)
	wheat := ui.RGB(229, 169, 60)
	berry := ui.RGB(200, 74, 58)
	if !t.Dark {
		// Island keeps high-contrast dark obsidian notch palette even on light desktops.
		surfaceBg = ui.RGBA(24, 23, 22, 0.94)
	}

	root := ui.Column(c).Fill().Padding(10, 12).Gap(8).Radius(16)
	if ic.liquidGlass {
		root.Material(glass.Glass{Style: glass.Regular, Tint: ui.RGBA(18, 17, 16, 0.55), Clarity: 0.25})
	} else {
		root.Background(surfaceBg).Border(1, ui.RGBA(255, 255, 255, 0.12))
	}

	root.Children(func() {
		// Top Notch strip summary
		ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
			dotColor := leaf
			if waitingCount > 0 {
				dotColor = wheat
			} else if len(st.Issues) == 0 {
				dotColor = muted
			}
			ui.Box(c).Width(8).Height(8).Radius(4).Background(dotColor)
			ui.Textf(c, "Active %d", workingCount).FontSize(12).Bold().TextColor(cream).SingleLine()
			if waitingCount > 0 {
				ui.Textf(c, "Waiting %d", waitingCount).FontSize(12).Bold().TextColor(wheat).SingleLine()
			} else if len(st.Issues) == 0 {
				ui.Text(c, "Idle").FontSize(12).TextColor(muted).SingleLine()
			}
			ui.Spacer(c)
			toggleLabel := "Expand"
			if st.Expanded {
				toggleLabel = "Collapse"
			}
			if ui.Button(c, toggleLabel).Key("island-toggle").Clicked() {
				ic.SetExpanded(!st.Expanded)
			}
		})

		if !st.Expanded {
			return
		}

		ui.Divider(c)

		// Urgent action cards stay pinned above the issue scroll area so buttons are never clipped.
		for _, prompt := range st.Approvals {
			p := prompt
			ui.Column(c).Key("approval-"+p.TaskID).FillWidth().Padding(8, 10).Gap(5).Radius(10).Background(cardBg).Border(1, wheat).Children(func() {
				ui.Row(c).FillWidth().Gap(6).AlignItems(ui.Center).Children(func() {
					ui.Badge(c, string(p.Policy)).TextColor(wheat)
					ui.Textf(c, "Permission: %s", p.ToolName).FontSize(12).Bold().TextColor(cream).SingleLine()
				})
				if p.Summary != "" {
					ui.Text(c, p.Summary).FontSize(11).TextColor(muted).MaxLines(2)
				}
				ui.Row(c).FillWidth().Gap(8).Children(func() {
					if ui.PrimaryButton(c, "Approve").Key("approve-" + p.TaskID).Description("Approve " + p.ToolName + " [approve:" + p.TaskID + "]").Clicked() {
						if handlers.OnApproval != nil {
							handlers.OnApproval(p, true)
						}
					}
					if ui.Button(c, "Deny").Key("deny-" + p.TaskID).Description("Deny " + p.ToolName + " [deny:" + p.TaskID + "]").Clicked() {
						if handlers.OnApproval != nil {
							handlers.OnApproval(p, false)
						}
					}
				})
			})
		}

		for _, alert := range st.Budgets {
			if !alert.Snapshot.Reached {
				continue
			}
			a := alert
			title := a.Title
			if title == "" {
				title = firstNonEmpty(a.TaskID, a.ConversationID, "Session Budget")
			}
			ui.Column(c).Key("budget-"+a.ID).FillWidth().Padding(8, 10).Gap(5).Radius(10).Background(cardBg).Border(1, berry).Children(func() {
				ui.Row(c).FillWidth().Gap(6).AlignItems(ui.Center).Children(func() {
					ui.Badge(c, "Budget Reached").TextColor(berry)
					ui.Text(c, title).FontSize(12).Bold().TextColor(cream).SingleLine()
				})
				ui.Textf(c, "Spent %s / Limit %s", formatMicrosUSD(a.Snapshot.SpentMicros), formatMicrosUSD(a.Snapshot.MaxCostMicros)).
					FontSize(11).TextColor(muted).SingleLine()
				nextMax := max(a.Snapshot.SpentMicros, a.Snapshot.MaxCostMicros) + ic.budgetStep
				if ui.PrimaryButton(c, "Raise Budget").Key("budget-raise-" + a.ID).Description("Raise budget for " + title + " [budget-raise:" + a.ID + "]").Clicked() {
					if handlers.OnBudgetRaise != nil {
						handlers.OnBudgetRaise(a, nextMax)
					}
				}
			})
		}

		ui.Scroll(c).Grow(1).FillWidth().Children(func() {
			ui.Column(c).FillWidth().Gap(6).Children(func() {
				for _, alert := range st.Budgets {
					if alert.Snapshot.Reached {
						continue
					}
					a := alert
					title := a.Title
					if title == "" {
						title = firstNonEmpty(a.TaskID, a.ConversationID, "Session Budget")
					}
					ui.Column(c).Key("budget-active-"+a.ID).FillWidth().Padding(6, 8).Gap(4).Radius(8).Background(cardBg).Border(1, leaf).Children(func() {
						ui.Row(c).FillWidth().Gap(6).AlignItems(ui.Center).Children(func() {
							ui.Badge(c, "Budget Active").TextColor(leaf)
							ui.Text(c, title).FontSize(12).Bold().TextColor(cream).SingleLine()
						})
						ui.Textf(c, "Spent %s / Limit %s", formatMicrosUSD(a.Snapshot.SpentMicros), formatMicrosUSD(a.Snapshot.MaxCostMicros)).
							FontSize(11).TextColor(muted).SingleLine()
					})
				}

				for _, issue := range st.Issues {
					iss := issue
					statusColor := leaf
					switch iss.Status {
					case contract.IssueReview:
						statusColor = wheat
					case contract.IssueQueued, contract.IssueDraft:
						statusColor = muted
					}
					ui.Row(c).Key("issue-"+iss.ID).FillWidth().Padding(6, 8).Gap(8).Radius(8).Background(cardBg).AlignItems(ui.Center).Children(func() {
						ui.Box(c).Width(7).Height(7).Radius(3).Background(statusColor)
						ui.Column(c).Grow(1).Shrink(1).Gap(2).Children(func() {
							ui.Text(c, iss.Title).FontSize(12).Bold().TextColor(cream).SingleLine()
							ui.Textf(c, "%s · %s", iss.ID, iss.Status).FontSize(10).TextColor(muted).SingleLine()
						})
						if ui.Button(c, "Open").Key("open-issue-" + iss.ID).Description("Open " + iss.Title + " [open-issue:" + iss.ID + "]").Clicked() {
							if handlers.OnOpenIssue != nil {
								handlers.OnOpenIssue(iss)
							}
						}
					})
				}

				if len(st.Approvals) == 0 && len(st.Budgets) == 0 && len(st.Issues) == 0 {
					ui.Text(c, "No active issues or pending approvals").FontSize(11).TextColor(muted)
				}
			})
		})
	})
}

func (ic *IslandController) snapshotHandlers() IslandHandlers {
	ic.mu.Lock()
	defer ic.mu.Unlock()
	return ic.handlers
}

// SetHandlers updates the island action handlers safely.
func (ic *IslandController) SetHandlers(h IslandHandlers) {
	ic.mu.Lock()
	ic.handlers = h
	ic.mu.Unlock()
}

func activeIssuesOnly(issues []contract.IssueView) []contract.IssueView {
	out := make([]contract.IssueView, 0, len(issues))
	for _, iss := range issues {
		if iss.Status != contract.IssueDone {
			out = append(out, iss)
		}
	}
	return out
}

func hasUrgentAlert(st IslandState) bool {
	if len(st.Approvals) > 0 {
		return true
	}
	for _, b := range st.Budgets {
		if b.Snapshot.Reached {
			return true
		}
	}
	return false
}

func countReachedBudgets(budgets []BudgetAlert) int {
	n := 0
	for _, b := range budgets {
		if b.Snapshot.Reached {
			n++
		}
	}
	return n
}

func countIssuesByStatus(issues []contract.IssueView, status contract.IssueStatus) int {
	n := 0
	for _, iss := range issues {
		if iss.Status == status {
			n++
		}
	}
	return n
}

func formatMicrosUSD(micros int64) string {
	neg := ""
	if micros < 0 {
		neg = "-"
		micros = -micros
	}
	cents := micros / 10_000
	dollars := cents / 100
	remCents := cents % 100
	return fmt.Sprintf("%s$%d.%02d", neg, dollars, remCents)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func cloneIslandState(st IslandState) IslandState {
	return IslandState{
		Issues:    slices.Clone(st.Issues),
		Approvals: slices.Clone(st.Approvals),
		Budgets:   slices.Clone(st.Budgets),
		Expanded:  st.Expanded,
	}
}

func equalIslandState(a, b IslandState) bool {
	if a.Expanded != b.Expanded ||
		len(a.Issues) != len(b.Issues) ||
		len(a.Approvals) != len(b.Approvals) ||
		len(a.Budgets) != len(b.Budgets) {
		return false
	}
	for i := range a.Issues {
		if a.Issues[i].ID != b.Issues[i].ID ||
			a.Issues[i].Title != b.Issues[i].Title ||
			a.Issues[i].Status != b.Issues[i].Status ||
			a.Issues[i].UpdatedAtMs != b.Issues[i].UpdatedAtMs {
			return false
		}
	}
	if !slices.Equal(a.Approvals, b.Approvals) {
		return false
	}
	if !slices.Equal(a.Budgets, b.Budgets) {
		return false
	}
	return true
}

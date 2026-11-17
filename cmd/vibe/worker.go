package main

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/spf13/cobra"
)

type workerSessionSummary struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Role      string `json:"role,omitempty"`
	Agent     string `json:"agent"`
	Runtime   string `json:"runtime"`
	Phase     string `json:"phase"`
	PhaseText string `json:"phaseText,omitempty"`
	Lane      string `json:"lane"`
	Station   *int   `json:"station,omitempty"`
	Scope     string `json:"scope,omitempty"`
	Repo      string `json:"repo,omitempty"`
	Machine   string `json:"machine,omitempty"`
}

type workerRuntimeSummary struct {
	ID           string `json:"id"`
	Label        string `json:"label,omitempty"`
	Status       string `json:"status"`
	Enabled      bool   `json:"enabled"`
	DefaultModel string `json:"defaultModel,omitempty"`
	Active       int    `json:"active"`
}

type workerMachineSummary struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Here   bool   `json:"here"`
	Online bool   `json:"online"`
}

type workerStatusSummary struct {
	ActiveSessions int                    `json:"activeSessions"`
	TotalSessions  int                    `json:"totalSessions"`
	Runtimes       []workerRuntimeSummary `json:"runtimes"`
	Sessions       []workerSessionSummary `json:"sessions"`
	Lanes          map[string]int         `json:"lanes"`
	Machines       []workerMachineSummary `json:"machines,omitempty"`
}

type stateSnapshotEnvelope struct {
	Rev   int64 `json:"rev"`
	Frame struct {
		Seq   int64 `json:"seq"`
		State struct {
			Sessions []sessionView          `json:"sessions"`
			Machines []workerMachineSummary `json:"machines"`
		} `json:"state"`
		View struct {
			Plays map[string]struct {
				Station int `json:"station"`
			} `json:"plays"`
		} `json:"view"`
	} `json:"frame"`
}

func isRouteNotFound(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.isNotFound()
}

func collectWorkerSummary(ctx context.Context, client *Client) (workerStatusSummary, error) {
	var (
		stateSnap stateSnapshotEnvelope
		haveState bool
		runtimes  []runtimeInfoView
		haveRT    bool
		sessions  []sessionView
		haveSess  bool
		lastErr   error
	)

	if _, err := client.GetJSON(ctx, "/api/v1/state", &stateSnap); err == nil {
		haveState = true
	} else if !isRouteNotFound(err) {
		lastErr = err
	}
	if _, err := client.Call(ctx, "runtime.list", nil, &runtimes); err == nil {
		haveRT = true
	} else if !isRouteNotFound(err) {
		lastErr = err
	}
	if _, err := client.Call(ctx, "session.list", nil, &sessions); err == nil {
		haveSess = true
	} else if !isRouteNotFound(err) {
		lastErr = err
	}

	if !haveState && !haveRT && !haveSess {
		if lastErr != nil {
			return workerStatusSummary{}, lastErr
		}
		return workerStatusSummary{}, errors.New("worker endpoints unavailable")
	}

	// Merge sessions: prefer session.list and enrich with /api/v1/state phaseText & plays/station.
	byID := make(map[string]sessionView)
	if haveState {
		for _, s := range stateSnap.Frame.State.Sessions {
			byID[s.ID] = s
		}
	}
	if haveSess {
		for _, s := range sessions {
			if prev, ok := byID[s.ID]; ok {
				if s.PhaseText == "" {
					s.PhaseText = prev.PhaseText
				}
			}
			byID[s.ID] = s
		}
	}

	mergedIDs := make([]string, 0, len(byID))
	for id := range byID {
		mergedIDs = append(mergedIDs, id)
	}
	sort.Strings(mergedIDs)

	lanes := map[string]int{}
	activeByRuntime := map[string]int{}
	sessSummaries := make([]workerSessionSummary, 0, len(mergedIDs))
	activeCount := 0

	for _, id := range mergedIDs {
		s := byID[id]
		phaseTag := s.Phase.Tag
		if phaseTag == "" {
			phaseTag = "unknown"
		}
		lane := phaseTag
		if s.Scope != nil && s.Scope.Kind != "" {
			lane = s.Scope.Kind + ":" + phaseTag
		}
		if phaseTag == "working" {
			activeCount++
			if s.Runtime != "" {
				activeByRuntime[s.Runtime]++
			}
		}
		lanes[lane]++

		var station *int
		if haveState {
			if pl, ok := stateSnap.Frame.View.Plays[s.ID]; ok {
				st := pl.Station
				station = &st
			}
		}
		scopeText := ""
		if s.Scope != nil && s.Scope.Kind != "" {
			scopeText = s.Scope.Kind + " " + s.Scope.ID
		}
		sessSummaries = append(sessSummaries, workerSessionSummary{
			ID:        s.ID,
			Name:      s.Name,
			Role:      s.Role,
			Agent:     s.Agent,
			Runtime:   s.Runtime,
			Phase:     phaseTag,
			PhaseText: s.PhaseText,
			Lane:      lane,
			Station:   station,
			Scope:     scopeText,
			Repo:      s.Repo,
			Machine:   s.Machine,
		})
	}

	rtSummaries := make([]workerRuntimeSummary, 0, len(runtimes))
	for _, r := range runtimes {
		rtSummaries = append(rtSummaries, workerRuntimeSummary{
			ID:           r.ID,
			Label:        r.Preset.Label,
			Status:       r.Installation.Status,
			Enabled:      r.Settings.Enabled,
			DefaultModel: r.Settings.DefaultModel,
			Active:       activeByRuntime[r.ID],
		})
	}

	return workerStatusSummary{
		ActiveSessions: activeCount,
		TotalSessions:  len(sessSummaries),
		Runtimes:       rtSummaries,
		Sessions:       sessSummaries,
		Lanes:          lanes,
		Machines:       stateSnap.Frame.State.Machines,
	}, nil
}

func formatWorkerSummaryText(sum workerStatusSummary) string {
	var b strings.Builder
	fmt.Fprintf(&b, "workers: %d active / %d total", sum.ActiveSessions, sum.TotalSessions)
	if len(sum.Lanes) > 0 {
		laneKeys := make([]string, 0, len(sum.Lanes))
		for k := range sum.Lanes {
			laneKeys = append(laneKeys, k)
		}
		sort.Strings(laneKeys)
		laneParts := make([]string, 0, len(laneKeys))
		for _, k := range laneKeys {
			laneParts = append(laneParts, fmt.Sprintf("%s=%d", k, sum.Lanes[k]))
		}
		fmt.Fprintf(&b, "  lanes: %s", strings.Join(laneParts, ", "))
	}
	if len(sum.Runtimes) > 0 {
		b.WriteString("\nruntimes:")
		for _, r := range sum.Runtimes {
			state := r.Status
			if !r.Enabled {
				state += ",disabled"
			}
			fmt.Fprintf(&b, "\n  %-12s %-12s active=%d", r.ID, state, r.Active)
			if r.DefaultModel != "" {
				fmt.Fprintf(&b, "  model=%s", r.DefaultModel)
			}
		}
	}
	if len(sum.Sessions) > 0 {
		b.WriteString("\nsessions:")
		for _, s := range sum.Sessions {
			parts := []string{"  " + s.ID, s.Name, "@" + s.Agent, s.Runtime, s.Lane}
			if s.Scope != "" {
				parts = append(parts, s.Scope)
			}
			if s.Repo != "" {
				parts = append(parts, "["+s.Repo+"]")
			}
			b.WriteByte('\n')
			b.WriteString(strings.Join(parts, "  "))
		}
	}
	return b.String()
}

func newWorkerCommand(rt *appRuntime) *cobra.Command {
	workerCmd := &cobra.Command{
		Use:   "worker",
		Short: "Summarize active worker sessions, runtimes, and lanes",
	}

	runSummary := func(cmd *cobra.Command, _ []string) error {
		client, _, err := rt.newClient()
		if err != nil {
			return err
		}
		sum, err := collectWorkerSummary(cmd.Context(), client)
		if err != nil {
			return err
		}
		return rt.writeOutput(sum, func() string {
			return formatWorkerSummaryText(sum)
		})
	}

	statusCmd := &cobra.Command{
		Use:   "status",
		Short: "Show active worker sessions, runtimes, and lane counts",
		Args:  cobra.NoArgs,
		RunE:  runSummary,
	}

	listCmd := &cobra.Command{
		Use:   "list",
		Short: "List worker sessions alongside runtime and lane summaries",
		Args:  cobra.NoArgs,
		RunE:  runSummary,
	}

	workerCmd.AddCommand(statusCmd, listCmd)
	return workerCmd
}

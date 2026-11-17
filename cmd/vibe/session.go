package main

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

type sessionPhaseView struct {
	Tag   string `json:"_tag"`
	Doing *struct {
		Action     string `json:"action"`
		Label      string `json:"label"`
		ActionText string `json:"actionText"`
	} `json:"doing,omitempty"`
	Closed string `json:"closed,omitempty"`
}

type sessionScopeView struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

type sessionView struct {
	ID        string            `json:"id"`
	Role      string            `json:"role"`
	Name      string            `json:"name"`
	Agent     string            `json:"agent"`
	Runtime   string            `json:"runtime"`
	Brief     string            `json:"brief"`
	Repo      string            `json:"repo"`
	Branch    string            `json:"branch"`
	Worktree  string            `json:"worktree"`
	Runs      int               `json:"runs"`
	Phase     sessionPhaseView  `json:"phase"`
	PhaseText string            `json:"phaseText,omitempty"`
	Scope     *sessionScopeView `json:"scope,omitempty"`
	Machine   string            `json:"machine,omitempty"`
	LastRun   *struct {
		Outcome string `json:"outcome"`
		Summary string `json:"summary"`
	} `json:"lastRun,omitempty"`
}

type sessionEventView struct {
	Seq        int64  `json:"seq"`
	Revision   int64  `json:"revision"`
	Time       int64  `json:"time"`
	Type       string `json:"type"`
	Run        string `json:"run,omitempty"`
	Text       string `json:"text"`
	Action     string `json:"action,omitempty"`
	ActionText string `json:"actionText,omitempty"`
	Tool       string `json:"tool,omitempty"`
	Input      string `json:"input,omitempty"`
	Output     string `json:"output,omitempty"`
	Ok         *bool  `json:"ok,omitempty"`
}

func formatSessionLine(s sessionView) string {
	parts := []string{s.ID}
	if s.Name != "" {
		parts = append(parts, s.Name)
	}
	if s.Agent != "" {
		parts = append(parts, "@"+s.Agent)
	}
	if s.Phase.Tag != "" {
		parts = append(parts, s.Phase.Tag)
	}
	if s.Scope != nil && s.Scope.Kind != "" {
		parts = append(parts, s.Scope.Kind+" "+s.Scope.ID)
	}
	if s.Repo != "" {
		parts = append(parts, "["+s.Repo+"]")
	}
	return strings.Join(parts, "  ")
}

func formatSessionDetail(s sessionView) string {
	var b strings.Builder
	b.WriteString(formatSessionLine(s))
	if s.Runtime != "" {
		fmt.Fprintf(&b, "\nruntime: %s  runs: %d", s.Runtime, s.Runs)
	}
	if s.Branch != "" {
		fmt.Fprintf(&b, "\nbranch: %s", s.Branch)
	}
	if s.Worktree != "" {
		fmt.Fprintf(&b, "\nworktree: %s", s.Worktree)
	}
	if s.Brief != "" {
		firstLine := strings.SplitN(strings.TrimSpace(s.Brief), "\n", 2)[0]
		fmt.Fprintf(&b, "\nbrief: %s", firstLine)
	}
	if s.LastRun != nil {
		fmt.Fprintf(&b, "\nlastRun: %s  %s", s.LastRun.Outcome, s.LastRun.Summary)
	}
	return b.String()
}

func formatSessionEventLine(ev sessionEventView) string {
	parts := []string{
		fmt.Sprintf("%d.%d", ev.Seq, ev.Revision),
		ev.Type,
	}
	for _, field := range []string{ev.Tool, ev.ActionText, ev.Text, ev.Input, ev.Output} {
		if strings.TrimSpace(field) != "" {
			parts = append(parts, strings.Join(strings.Fields(field), " "))
		}
	}
	if ev.Ok != nil {
		parts = append(parts, fmt.Sprintf("ok=%t", *ev.Ok))
	}
	return strings.Join(parts, "  ")
}

func newSessionCommand(rt *appRuntime) *cobra.Command {
	sessionCmd := &cobra.Command{
		Use:   "session",
		Short: "Inspect and control worker sessions",
	}

	var (
		listIssue string
		listAgent string
	)
	listCmd := &cobra.Command{
		Use:   "list",
		Short: "List sessions",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			req := map[string]any{}
			if strings.TrimSpace(listAgent) != "" {
				req["agent"] = strings.TrimSpace(listAgent)
			}
			issueRef := trimIssueRef(listIssue)
			if issueRef != "" {
				req["issue"] = issueRef
			}
			var sessions []sessionView
			raw, err := client.Call(cmd.Context(), "session.list", req, &sessions)
			if err != nil {
				return err
			}
			filtered := sessions
			var jsonOut any = rawOrValue(raw, sessions)
			if issueRef != "" {
				resolvedID := resolveIssueID(cmd.Context(), client, issueRef)
				filtered = make([]sessionView, 0, len(sessions))
				for _, s := range sessions {
					if s.Scope != nil && s.Scope.Kind == "issue" && (s.Scope.ID == issueRef || (resolvedID != "" && s.Scope.ID == resolvedID)) {
						filtered = append(filtered, s)
					}
				}
				jsonOut = filtered
			}
			return rt.writeOutput(jsonOut, func() string {
				if len(filtered) == 0 {
					return "no sessions"
				}
				lines := make([]string, 0, len(filtered))
				for _, s := range filtered {
					lines = append(lines, formatSessionLine(s))
				}
				return strings.Join(lines, "\n")
			})
		},
	}
	listCmd.Flags().StringVar(&listIssue, "issue", "", "filter sessions scoped to an issue id or number")
	listCmd.Flags().StringVar(&listAgent, "agent", "", "filter sessions by agent id")

	getCmd := &cobra.Command{
		Use:     "get <id>",
		Aliases: []string{"show"},
		Short:   "Show details for a session",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			var sess sessionView
			raw, err := client.Call(cmd.Context(), "session.get", map[string]string{"id": strings.TrimSpace(args[0])}, &sess)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, sess), func() string {
				return formatSessionDetail(sess)
			})
		},
	}

	stopCmd := &cobra.Command{
		Use:   "stop <id>",
		Short: "Stop an active session turn",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := strings.TrimSpace(args[0])
			raw, dry, err := rt.callMutate(cmd.Context(), "session.stop", map[string]string{"id": id}, nil)
			if err != nil || dry {
				return err
			}
			return rt.writeOutput(
				rawOrValue(raw, map[string]any{"stopped": true, "id": id}),
				func() string { return fmt.Sprintf("stopped session %s", id) },
			)
		},
	}

	var (
		eventsAfter int64
		eventsRun   string
	)
	eventsCmd := &cobra.Command{
		Use:   "events <id>",
		Short: "List recorded events for a session",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			req := map[string]any{"id": strings.TrimSpace(args[0])}
			if strings.TrimSpace(eventsRun) != "" {
				req["run"] = strings.TrimSpace(eventsRun)
			}
			afterSet := cmd.Flags().Changed("after")
			if afterSet {
				req["after"] = eventsAfter
			}
			var events []sessionEventView
			raw, err := client.Call(cmd.Context(), "session.event.list", req, &events)
			if err != nil {
				return err
			}
			filtered := events
			var jsonOut any = rawOrValue(raw, events)
			if afterSet {
				filtered = make([]sessionEventView, 0, len(events))
				for _, ev := range events {
					if ev.Seq > eventsAfter {
						filtered = append(filtered, ev)
					}
				}
				jsonOut = filtered
			}
			return rt.writeOutput(jsonOut, func() string {
				if len(filtered) == 0 {
					return "no events"
				}
				lines := make([]string, 0, len(filtered))
				for _, ev := range filtered {
					lines = append(lines, formatSessionEventLine(ev))
				}
				return strings.Join(lines, "\n")
			})
		},
	}
	eventsCmd.Flags().Int64Var(&eventsAfter, "after", 0, "only return events with seq > after")
	eventsCmd.Flags().StringVar(&eventsRun, "run", "", "filter events to a single run id")

	sessionCmd.AddCommand(listCmd, getCmd, stopCmd, eventsCmd)
	return sessionCmd
}

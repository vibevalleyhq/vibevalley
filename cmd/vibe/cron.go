package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

type cronWhenView struct {
	Kind    string `json:"kind"`
	Expr    string `json:"expr,omitempty"`
	Minutes int    `json:"minutes,omitempty"`
	Time    string `json:"time,omitempty"`
	At      int64  `json:"at,omitempty"`
	Days    []int  `json:"days,omitempty"`
}

type cronView struct {
	ID      string       `json:"id"`
	Name    string       `json:"name"`
	Text    string       `json:"text"`
	Channel string       `json:"channel"`
	Agent   string       `json:"agent,omitempty"`
	Repo    string       `json:"repo,omitempty"`
	When    cronWhenView `json:"when"`
	TZ      string       `json:"tz"`
	Enabled bool         `json:"enabled"`
	Created int64        `json:"created"`
	LastRun *int64       `json:"lastRun,omitempty"`
}

func formatCronWhen(w cronWhenView) string {
	switch w.Kind {
	case "once":
		return "once " + time.UnixMilli(w.At).UTC().Format(time.RFC3339)
	case "every":
		return fmt.Sprintf("every %dm", w.Minutes)
	case "daily":
		return "daily " + w.Time
	case "weekly":
		return fmt.Sprintf("weekly %v %s", w.Days, w.Time)
	case "cron":
		return "cron " + w.Expr
	default:
		return w.Kind
	}
}

func formatCronLine(c cronView) string {
	parts := []string{c.ID, c.Name, formatCronWhen(c.When)}
	if !c.Enabled {
		parts = append(parts, "off")
	}
	if c.Text != "" {
		parts = append(parts, strings.Join(strings.Fields(c.Text), " "))
	}
	filtered := make([]string, 0, len(parts))
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			filtered = append(filtered, p)
		}
	}
	return strings.Join(filtered, "  ")
}

func parseScheduleWhen(schedule, daily, atStr string, everyMins int) (map[string]any, error) {
	var candidates []map[string]any
	if s := strings.TrimSpace(schedule); s != "" {
		low := strings.ToLower(s)
		switch {
		case strings.HasPrefix(low, "every "):
			rawDur := strings.TrimSpace(low[len("every "):])
			rawDur = strings.TrimSuffix(rawDur, "m")
			mins, err := strconv.Atoi(strings.TrimSpace(rawDur))
			if err != nil || mins < 1 {
				return nil, fmt.Errorf("invalid --schedule interval %q", schedule)
			}
			candidates = append(candidates, map[string]any{"kind": "every", "minutes": mins})
		case strings.HasPrefix(low, "daily "):
			tStr := strings.TrimSpace(s[len("daily "):])
			candidates = append(candidates, map[string]any{"kind": "daily", "time": tStr})
		default:
			candidates = append(candidates, map[string]any{"kind": "cron", "expr": s})
		}
	}
	if everyMins > 0 {
		candidates = append(candidates, map[string]any{"kind": "every", "minutes": everyMins})
	}
	if d := strings.TrimSpace(daily); d != "" {
		candidates = append(candidates, map[string]any{"kind": "daily", "time": d})
	}
	if a := strings.TrimSpace(atStr); a != "" {
		t, err := time.Parse(time.RFC3339, a)
		if err != nil {
			return nil, fmt.Errorf("invalid --at timestamp %q: %w", a, err)
		}
		candidates = append(candidates, map[string]any{"kind": "once", "at": t.UnixMilli()})
	}
	if len(candidates) != 1 {
		return nil, errors.New("specify exactly one schedule via --schedule (or --every / --daily / --at)")
	}
	return candidates[0], nil
}

func newCronCommand(rt *appRuntime) *cobra.Command {
	cronCmd := &cobra.Command{
		Use:   "cron",
		Short: "Manage scheduled cron tasks",
	}

	listCmd := &cobra.Command{
		Use:   "list",
		Short: "List scheduled crons",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			var crons []cronView
			raw, err := client.Call(cmd.Context(), "cron.list", nil, &crons)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, crons), func() string {
				if len(crons) == 0 {
					return "no crons"
				}
				lines := make([]string, 0, len(crons))
				for _, c := range crons {
					lines = append(lines, formatCronLine(c))
				}
				return strings.Join(lines, "\n")
			})
		},
	}

	var (
		createName     string
		createSchedule string
		createEvery    int
		createDaily    string
		createAt       string
		createTZ       string
		createPrompt   string
		createText     string
		createChannel  string
		createAgent    string
		createRepo     string
	)
	createCmd := &cobra.Command{
		Use:   "create [name]",
		Short: "Create a scheduled cron task",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := strings.TrimSpace(createName)
			if name == "" && len(args) > 0 {
				name = strings.TrimSpace(args[0])
			}
			if name == "" {
				return errors.New("cron --name is required")
			}
			prompt := createPrompt
			if prompt == "-" {
				var err error
				prompt, err = rt.readAllStdin()
				if err != nil {
					return err
				}
			}
			prompt = strings.TrimSpace(prompt)
			if prompt == "" {
				prompt = strings.TrimSpace(createText)
			}
			if prompt == "" {
				return errors.New("cron --prompt is required")
			}
			when, err := parseScheduleWhen(createSchedule, createDaily, createAt, createEvery)
			if err != nil {
				return err
			}
			tz := strings.TrimSpace(createTZ)
			if tz == "" {
				tz = "UTC"
			}
			req := map[string]any{
				"name": name,
				"text": prompt,
				"when": when,
				"tz":   tz,
			}
			if strings.TrimSpace(createChannel) != "" {
				req["channel"] = strings.TrimSpace(createChannel)
			}
			if strings.TrimSpace(createAgent) != "" {
				req["agent"] = strings.TrimSpace(createAgent)
			}
			if strings.TrimSpace(createRepo) != "" {
				req["repo"] = strings.TrimSpace(createRepo)
			}
			var created cronView
			raw, dry, err := rt.callMutate(cmd.Context(), "cron.create", req, &created)
			if err != nil || dry {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, created), func() string {
				return formatCronLine(created)
			})
		},
	}
	createCmd.Flags().StringVar(&createName, "name", "", "cron task name")
	createCmd.Flags().StringVar(&createSchedule, "schedule", "", "5-field cron expression (or 'every Nm' / 'daily HH:MM')")
	createCmd.Flags().IntVar(&createEvery, "every", 0, "run every N minutes")
	createCmd.Flags().StringVar(&createDaily, "daily", "", "run daily at HH:MM")
	createCmd.Flags().StringVar(&createAt, "at", "", "run once at RFC3339 timestamp")
	createCmd.Flags().StringVar(&createTZ, "timezone", "UTC", "IANA timezone (e.g. UTC, Asia/Shanghai)")
	createCmd.Flags().StringVar(&createTZ, "tz", "UTC", "timezone (alias for --timezone)")
	createCmd.Flags().StringVar(&createPrompt, "prompt", "", "prompt executed when cron fires (use '-' for stdin)")
	createCmd.Flags().StringVar(&createText, "text", "", "prompt text (alias for --prompt)")
	createCmd.Flags().StringVar(&createChannel, "channel", "", "target channel id or name")
	createCmd.Flags().StringVar(&createAgent, "agent", "", "target agent profile")
	createCmd.Flags().StringVar(&createRepo, "repo", "", "target repository")

	var (
		updEnabled  bool
		updEnable   bool
		updDisable  bool
		updName     string
		updPrompt   string
		updSchedule string
		updTZ       string
	)
	updateCmd := &cobra.Command{
		Use:   "update <id>",
		Short: "Update a scheduled cron task",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if updEnable && updDisable {
				return errors.New("cannot specify both --enable and --disable")
			}
			id := strings.TrimSpace(args[0])
			req := map[string]any{"id": id}
			if cmd.Flags().Changed("enabled") {
				req["enabled"] = updEnabled
			} else if updEnable {
				req["enabled"] = true
			} else if updDisable {
				req["enabled"] = false
			}
			if cmd.Flags().Changed("name") {
				req["name"] = updName
			}
			if cmd.Flags().Changed("prompt") {
				req["text"] = updPrompt
			}
			if cmd.Flags().Changed("schedule") {
				when, err := parseScheduleWhen(updSchedule, "", "", 0)
				if err != nil {
					return err
				}
				req["when"] = when
			}
			if cmd.Flags().Changed("timezone") {
				req["tz"] = updTZ
			}
			raw, dry, err := rt.callMutate(cmd.Context(), "cron.update", req, nil)
			if err != nil || dry {
				return err
			}
			return rt.writeOutput(
				rawOrValue(raw, map[string]any{"updated": true, "id": id}),
				func() string { return fmt.Sprintf("updated cron %s", id) },
			)
		},
	}
	updateCmd.Flags().BoolVar(&updEnabled, "enabled", true, "enable or disable cron")
	updateCmd.Flags().BoolVar(&updEnable, "enable", false, "enable cron")
	updateCmd.Flags().BoolVar(&updDisable, "disable", false, "disable cron")
	updateCmd.Flags().StringVar(&updName, "name", "", "updated cron name")
	updateCmd.Flags().StringVar(&updPrompt, "prompt", "", "updated cron prompt")
	updateCmd.Flags().StringVar(&updSchedule, "schedule", "", "updated cron schedule")
	updateCmd.Flags().StringVar(&updTZ, "timezone", "", "updated timezone")

	deleteCmd := &cobra.Command{
		Use:   "delete <id>",
		Short: "Delete a scheduled cron task",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := strings.TrimSpace(args[0])
			raw, dry, err := rt.callMutate(cmd.Context(), "cron.delete", map[string]string{"id": id}, nil)
			if err != nil || dry {
				return err
			}
			return rt.writeOutput(
				rawOrValue(raw, map[string]any{"deleted": true, "id": id}),
				func() string { return fmt.Sprintf("deleted cron %s", id) },
			)
		},
	}

	runCmd := &cobra.Command{
		Use:   "run <id>",
		Short: "Trigger a scheduled cron task immediately",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := strings.TrimSpace(args[0])
			req := map[string]any{"id": id}
			if rt.dryRun {
				return rt.writeDryRun(http.MethodPost, opPath("cron.run"), req)
			}

			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			raw, err := client.CallRaw(cmd.Context(), "cron.run", req)
			if err == nil {
				var parsed any
				if len(raw) > 0 {
					_ = json.Unmarshal(raw, &parsed)
				}
				return rt.writeOutput(
					rawOrValue(raw, map[string]any{"ran": true, "id": id}),
					func() string { return fmt.Sprintf("ran cron %s", id) },
				)
			}
			var apiErr *APIError
			if !errors.As(err, &apiErr) || !apiErr.isNotFound() {
				return err
			}

			// Fallback when server has no direct cron.run route: verify cron exists and dispatch an issue run.
			var crons []cronView
			if _, lErr := client.Call(cmd.Context(), "cron.list", nil, &crons); lErr != nil {
				return lErr
			}
			var target *cronView
			for i := range crons {
				if crons[i].ID == id {
					target = &crons[i]
					break
				}
			}
			if target == nil {
				return &APIError{
					Op:         "cron.run",
					HTTPStatus: http.StatusNotFound,
					BizCode:    500004,
					Message:    fmt.Sprintf("cron %q not found", id),
				}
			}
			issReq := map[string]any{
				"title":       target.Name,
				"description": target.Text,
			}
			if target.Repo != "" {
				issReq["repo"] = target.Repo
			}
			if target.Agent != "" {
				issReq["agent"] = target.Agent
			}
			var created issueView
			if _, cErr := client.Call(cmd.Context(), "issue.create", issReq, &created); cErr != nil {
				return cErr
			}
			_, _ = client.CallWithFallback(cmd.Context(), "issue.status.update", "issue.status",
				map[string]any{"id": created.ID, "status": "todo"},
				map[string]any{"id": created.ID, "status": "todo"},
				nil,
			)
			payload := map[string]any{
				"ran":     true,
				"id":      id,
				"issueId": created.ID,
			}
			return rt.writeOutput(payload, func() string {
				return fmt.Sprintf("ran cron %s -> issue %s", id, created.ID)
			})
		},
	}

	cronCmd.AddCommand(listCmd, createCmd, updateCmd, deleteCmd, runCmd)
	return cronCmd
}

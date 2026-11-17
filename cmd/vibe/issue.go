package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

type issueView struct {
	ID          string `json:"id"`
	Number      int    `json:"number"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Repo        string `json:"repo"`
	RepoID      string `json:"repoId"`
	AssigneeID  string `json:"assigneeId"`
	Priority    string `json:"priority"`
	Status      string `json:"status"`
	Assignments []struct {
		Agent string `json:"agent"`
	} `json:"assignments"`
	Criteria  []string `json:"criteria"`
	Questions []struct {
		Question string   `json:"question"`
		Options  []string `json:"options"`
	} `json:"questions"`
	Stage struct {
		State string `json:"state"`
		Stuck string `json:"stuck"`
	} `json:"stage"`
}

func trimIssueRef(raw string) string {
	return strings.TrimPrefix(strings.TrimSpace(raw), "#")
}

func issueAgent(v issueView) string {
	if len(v.Assignments) > 0 {
		if a := strings.TrimSpace(v.Assignments[len(v.Assignments)-1].Agent); a != "" {
			return a
		}
	}
	return strings.TrimSpace(v.AssigneeID)
}

func issueRepo(v issueView) string {
	if strings.TrimSpace(v.Repo) != "" {
		return v.Repo
	}
	return v.RepoID
}

func formatIssueLine(v issueView) string {
	label := v.ID
	if v.Number > 0 {
		label = fmt.Sprintf("#%d", v.Number)
	}
	parts := []string{label, v.Status, v.Title}
	if a := issueAgent(v); a != "" {
		parts = append(parts, "@"+a)
	}
	if r := issueRepo(v); r != "" {
		parts = append(parts, "["+r+"]")
	}
	return strings.Join(parts, "  ")
}

func formatIssueDetail(v issueView) string {
	var b strings.Builder
	label := v.ID
	if v.Number > 0 {
		label = fmt.Sprintf("#%d", v.Number)
	}
	fmt.Fprintf(&b, "%s  %s\n", label, v.Title)
	meta := []string{v.Status}
	if v.Priority != "" {
		meta = append(meta, v.Priority)
	}
	if r := issueRepo(v); r != "" {
		meta = append(meta, "["+r+"]")
	}
	if a := issueAgent(v); a != "" {
		meta = append(meta, "@"+a)
	}
	b.WriteString(strings.Join(meta, "  "))
	if v.Stage.State != "" {
		b.WriteString("\nstage: ")
		b.WriteString(v.Stage.State)
		if v.Stage.Stuck != "" {
			fmt.Fprintf(&b, " (%s)", v.Stage.Stuck)
		}
	}
	if desc := strings.TrimSpace(v.Description); desc != "" {
		b.WriteString("\n\n")
		b.WriteString(desc)
	}
	if len(v.Criteria) > 0 {
		b.WriteString("\n\ncriteria:")
		for i, c := range v.Criteria {
			fmt.Fprintf(&b, "\n  %d. %s", i+1, c)
		}
	}
	if len(v.Questions) > 0 {
		b.WriteString("\n\nquestions:")
		for _, q := range v.Questions {
			fmt.Fprintf(&b, "\n  ? %s", q.Question)
			if len(q.Options) > 0 {
				fmt.Fprintf(&b, "  (%s)", strings.Join(q.Options, " | "))
			}
		}
	}
	return b.String()
}

func newIssueCommand(rt *appRuntime) *cobra.Command {
	issueCmd := &cobra.Command{
		Use:   "issue",
		Short: "Manage VibeValley issues",
	}

	var (
		listStatus    string
		listRepo      string
		listText      string
		listWantsUser bool
		listClosed    bool
		listLimit     int
	)
	listCmd := &cobra.Command{
		Use:   "list",
		Short: "List issues",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			req := map[string]any{}
			if listStatus != "" {
				req["status"] = listStatus
			}
			if listRepo != "" {
				req["repo"] = listRepo
			}
			if listText != "" {
				req["text"] = listText
			}
			if listWantsUser {
				req["wantsUser"] = true
			}
			if listClosed {
				req["closed"] = true
			}
			if listLimit > 0 {
				req["limit"] = listLimit
			}
			var items []issueView
			raw, err := client.Call(cmd.Context(), "issue.list", req, &items)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, items), func() string {
				if len(items) == 0 {
					return "no issues"
				}
				lines := make([]string, 0, len(items))
				for _, item := range items {
					lines = append(lines, formatIssueLine(item))
				}
				return strings.Join(lines, "\n")
			})
		},
	}
	listCmd.Flags().StringVar(&listStatus, "status", "", "filter by issue status")
	listCmd.Flags().StringVar(&listRepo, "repo", "", "filter by repository id or name")
	listCmd.Flags().StringVar(&listText, "text", "", "filter by text")
	listCmd.Flags().BoolVar(&listWantsUser, "wants-user", false, "filter issues waiting on user input")
	listCmd.Flags().BoolVar(&listClosed, "closed", false, "include closed issues")
	listCmd.Flags().IntVar(&listLimit, "limit", 20, "maximum number of issues to return")

	getCmd := &cobra.Command{
		Use:     "get <id>",
		Aliases: []string{"show"},
		Short:   "Show details for an issue",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			var item issueView
			raw, err := client.Call(cmd.Context(), "issue.get", map[string]string{"id": trimIssueRef(args[0])}, &item)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, item), func() string {
				return formatIssueDetail(item)
			})
		},
	}

	var (
		createTitle    string
		createDesc     string
		createRepo     string
		createAgent    string
		createPriority string
		createCriteria []string
		createDeliver  string
		createKey      string
	)
	createCmd := &cobra.Command{
		Use:   "create [title...]",
		Short: "Create a new issue",
		RunE: func(cmd *cobra.Command, args []string) error {
			title := strings.TrimSpace(createTitle)
			if len(args) > 0 {
				title = strings.TrimSpace(strings.Join(args, " "))
			}
			if title == "" {
				return errors.New("issue title is required")
			}
			desc := createDesc
			if desc == "-" {
				var err error
				desc, err = rt.readAllStdin()
				if err != nil {
					return err
				}
			}
			req := map[string]any{"title": title}
			if desc != "" {
				req["description"] = desc
			}
			if createRepo != "" {
				req["repo"] = createRepo
			}
			if createAgent != "" {
				req["agent"] = createAgent
			}
			if createPriority != "" {
				req["priority"] = createPriority
			}
			if len(createCriteria) > 0 {
				req["criteria"] = createCriteria
			}
			if createDeliver != "" {
				req["deliver"] = createDeliver
			}
			if createKey != "" {
				req["requestKey"] = createKey
			}

			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			var created issueView
			raw, err := client.Call(cmd.Context(), "issue.create", req, &created)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, created), func() string {
				return formatIssueLine(created)
			})
		},
	}
	createCmd.Flags().StringVar(&createTitle, "title", "", "issue title (alternative to positional args)")
	createCmd.Flags().StringVar(&createDesc, "description", "", "issue description (use '-' to read stdin)")
	createCmd.Flags().StringVar(&createRepo, "repo", "", "target repository id or name")
	createCmd.Flags().StringVar(&createAgent, "agent", "", "assigned agent profile")
	createCmd.Flags().StringVar(&createPriority, "priority", "", "priority (urgent|high|medium|low)")
	createCmd.Flags().StringArrayVar(&createCriteria, "criterion", nil, "acceptance criterion (repeatable)")
	createCmd.Flags().StringVar(&createDeliver, "deliver", "", "deliverable kind (change|branch|answer|pull_request)")
	createCmd.Flags().StringVar(&createKey, "key", "", "idempotency requestKey")

	var (
		statusComment string
		statusAgent   string
		statusKey     string
	)
	statusCmd := &cobra.Command{
		Use:   "status <id> <status>",
		Short: "Transition an issue to a new status",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			req := map[string]any{
				"id":     trimIssueRef(args[0]),
				"status": strings.TrimSpace(args[1]),
			}
			if statusComment != "" {
				req["text"] = statusComment
			}
			if statusAgent != "" {
				req["agent"] = statusAgent
			}
			if statusKey != "" {
				req["requestKey"] = statusKey
			}
			var updated issueView
			raw, err := client.CallWithFallback(cmd.Context(), "issue.status.update", "issue.status", req, req, &updated)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, updated), func() string {
				return formatIssueLine(updated)
			})
		},
	}
	statusCmd.Flags().StringVar(&statusComment, "comment", "", "status transition comment or findings")
	statusCmd.Flags().StringVar(&statusAgent, "agent", "", "agent profile for dispatch")
	statusCmd.Flags().StringVar(&statusKey, "key", "", "idempotency requestKey")

	deleteCmd := &cobra.Command{
		Use:   "delete <id>",
		Short: "Delete an issue",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			id := trimIssueRef(args[0])
			raw, err := client.Call(cmd.Context(), "issue.delete", map[string]string{"id": id}, nil)
			if err != nil {
				return err
			}
			return rt.writeOutput(
				rawOrValue(raw, map[string]any{"deleted": true, "id": id}),
				func() string { return fmt.Sprintf("deleted issue #%s", id) },
			)
		},
	}

	issueCmd.AddCommand(listCmd, getCmd, createCmd, statusCmd, deleteCmd)
	return issueCmd
}

func rawOrValue(raw json.RawMessage, fallback any) any {
	if len(strings.TrimSpace(string(raw))) > 0 {
		return raw
	}
	return fallback
}

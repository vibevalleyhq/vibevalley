package main

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/spf13/cobra"
)

type memoryItemView struct {
	ID       string  `json:"id"`
	Agent    string  `json:"agent"`
	Kind     string  `json:"kind"`
	Text     string  `json:"text"`
	Author   string  `json:"author"`
	Repo     string  `json:"repo,omitempty"`
	At       int64   `json:"at"`
	Recalled int     `json:"recalled"`
	Fading   bool    `json:"fading"`
	Source   string  `json:"source,omitempty"`
	Score    float64 `json:"score,omitempty"`
}

type memoryListView struct {
	Memories []memoryItemView `json:"memories"`
	Sources  []any            `json:"sources"`
}

type memorySearchView struct {
	Found    []memoryItemView `json:"found"`
	Coverage []string         `json:"coverage"`
}

func formatMemoryLine(m memoryItemView) string {
	parts := []string{m.ID}
	if m.Agent != "" {
		parts = append(parts, "@"+m.Agent)
	}
	if m.Kind != "" {
		parts = append(parts, m.Kind)
	}
	if m.Repo != "" {
		parts = append(parts, "["+m.Repo+"]")
	}
	if m.Text != "" {
		parts = append(parts, strings.Join(strings.Fields(m.Text), " "))
	}
	return strings.Join(parts, "  ")
}

func resolveMemoryScope(scopeFlag, agentFlag string) string {
	if s := strings.TrimSpace(scopeFlag); s != "" {
		return s
	}
	if a := strings.TrimSpace(agentFlag); a != "" {
		return a
	}
	return "default"
}

func newMemoryCommand(rt *appRuntime) *cobra.Command {
	memoryCmd := &cobra.Command{
		Use:   "memory",
		Short: "Browse, search, and manage persistent agent memories",
	}

	var (
		listScope string
		listAgent string
	)
	listCmd := &cobra.Command{
		Use:   "list",
		Short: "List memories in a scope",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			scope := resolveMemoryScope(listScope, listAgent)
			var res memoryListView
			raw, err := client.Call(cmd.Context(), "memory.list", map[string]string{"agent": scope}, &res)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, res), func() string {
				if len(res.Memories) == 0 {
					return "no memories"
				}
				lines := make([]string, 0, len(res.Memories))
				for _, m := range res.Memories {
					lines = append(lines, formatMemoryLine(m))
				}
				return strings.Join(lines, "\n")
			})
		},
	}
	listCmd.Flags().StringVar(&listScope, "scope", "", "memory scope or agent id (default 'default')")
	listCmd.Flags().StringVar(&listAgent, "agent", "", "agent id (alias for --scope)")

	var (
		searchScope string
		searchAgent string
		searchRepo  string
	)
	searchCmd := &cobra.Command{
		Use:   "search <query...>",
		Short: "Search persistent memories",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			req := map[string]any{
				"text": strings.Join(args, " "),
			}
			scope := strings.TrimSpace(searchScope)
			if scope == "" {
				scope = strings.TrimSpace(searchAgent)
			}
			if scope != "" {
				req["agent"] = scope
			}
			if strings.TrimSpace(searchRepo) != "" {
				req["repo"] = strings.TrimSpace(searchRepo)
			}
			var res memorySearchView
			raw, err := client.Call(cmd.Context(), "memory.search", req, &res)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, res), func() string {
				if len(res.Found) == 0 {
					return "no memories found"
				}
				lines := make([]string, 0, len(res.Found))
				for _, m := range res.Found {
					lines = append(lines, formatMemoryLine(m))
				}
				return strings.Join(lines, "\n")
			})
		},
	}
	searchCmd.Flags().StringVar(&searchScope, "scope", "", "filter by scope or agent id")
	searchCmd.Flags().StringVar(&searchAgent, "agent", "", "filter by agent id (alias for --scope)")
	searchCmd.Flags().StringVar(&searchRepo, "repo", "", "filter by repository")

	var (
		createPath  string
		createBody  string
		createText  string
		createScope string
		createAgent string
		createRepo  string
		createKey   string
	)
	createCmd := &cobra.Command{
		Use:   "create [body...]",
		Short: "Create a persistent memory entry",
		RunE: func(cmd *cobra.Command, args []string) error {
			body := createBody
			if body == "-" {
				var err error
				body, err = rt.readAllStdin()
				if err != nil {
					return err
				}
			}
			body = strings.TrimSpace(body)
			if body == "" {
				body = strings.TrimSpace(createText)
			}
			if body == "" && len(args) > 0 {
				body = strings.TrimSpace(strings.Join(args, " "))
			}
			if body == "" {
				return errors.New("memory --body is required")
			}

			scope := resolveMemoryScope(createScope, createAgent)
			req := map[string]any{
				"agent": scope,
				"text":  body,
			}
			if strings.TrimSpace(createPath) != "" {
				req["path"] = strings.TrimSpace(createPath)
			}
			if strings.TrimSpace(createRepo) != "" {
				req["repo"] = strings.TrimSpace(createRepo)
			}
			if strings.TrimSpace(createKey) != "" {
				req["requestKey"] = strings.TrimSpace(createKey)
			}
			var created memoryItemView
			raw, dry, err := rt.callMutate(cmd.Context(), "memory.create", req, &created)
			if err != nil || dry {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, created), func() string {
				return formatMemoryLine(created)
			})
		},
	}
	createCmd.Flags().StringVar(&createPath, "path", "", "memory file path hint (e.g. notes.md)")
	createCmd.Flags().StringVar(&createBody, "body", "", "memory content (use '-' to read stdin)")
	createCmd.Flags().StringVar(&createText, "text", "", "memory content (alias for --body)")
	createCmd.Flags().StringVar(&createScope, "scope", "", "target scope or agent id (default 'default')")
	createCmd.Flags().StringVar(&createAgent, "agent", "", "target agent id (alias for --scope)")
	createCmd.Flags().StringVar(&createRepo, "repo", "", "optional repository scope")
	createCmd.Flags().StringVar(&createKey, "key", "", "idempotency requestKey")

	var (
		updBody  string
		updScope string
		updAgent string
	)
	updateCmd := &cobra.Command{
		Use:   "update <id>",
		Short: "Update a memory entry",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := strings.TrimSpace(args[0])
			body := updBody
			if body == "-" {
				var err error
				body, err = rt.readAllStdin()
				if err != nil {
					return err
				}
			}
			body = strings.TrimSpace(body)
			if body == "" {
				return errors.New("memory --body is required")
			}
			scope := resolveMemoryScope(updScope, updAgent)
			req := map[string]any{
				"id":     id,
				"memory": id,
				"agent":  scope,
				"text":   body,
			}
			if rt.dryRun {
				return rt.writeDryRun(http.MethodPost, opPath("memory.update"), req)
			}

			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			var updated memoryItemView
			raw, err := client.Call(cmd.Context(), "memory.update", req, &updated)
			if err == nil {
				return rt.writeOutput(rawOrValue(raw, updated), func() string {
					return formatMemoryLine(updated)
				})
			}
			var apiErr *APIError
			if !errors.As(err, &apiErr) || !apiErr.isNotFound() {
				return err
			}

			// Gateway stores line-addressed notes without a direct memory.update route:
			// verify target exists, delete old line while version matches, then create replacement.
			var list memoryListView
			if _, lErr := client.Call(cmd.Context(), "memory.list", map[string]string{"agent": scope}, &list); lErr != nil {
				return lErr
			}
			exists := false
			for _, m := range list.Memories {
				if m.ID == id {
					exists = true
					break
				}
			}
			if !exists {
				return &APIError{
					Op:         "memory.update",
					HTTPStatus: http.StatusNotFound,
					BizCode:    600005,
					Message:    fmt.Sprintf("memory %q not found", id),
				}
			}
			if _, dErr := client.Call(cmd.Context(), "memory.delete", map[string]string{"agent": scope, "memory": id}, nil); dErr != nil {
				return dErr
			}
			raw, cErr := client.Call(cmd.Context(), "memory.create", map[string]any{"agent": scope, "text": body}, &updated)
			if cErr != nil {
				return cErr
			}
			return rt.writeOutput(rawOrValue(raw, updated), func() string {
				return formatMemoryLine(updated)
			})
		},
	}
	updateCmd.Flags().StringVar(&updBody, "body", "", "updated memory text (use '-' to read stdin)")
	updateCmd.Flags().StringVar(&updScope, "scope", "", "scope or agent id (default 'default')")
	updateCmd.Flags().StringVar(&updAgent, "agent", "", "agent id (alias for --scope)")

	var (
		delScope string
		delAgent string
	)
	deleteCmd := &cobra.Command{
		Use:   "delete <id>",
		Short: "Delete a memory entry",
		Args:  cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			scope := resolveMemoryScope(delScope, delAgent)
			memID := strings.TrimSpace(args[0])
			if len(args) == 2 {
				scope = strings.TrimSpace(args[0])
				memID = strings.TrimSpace(args[1])
			}
			raw, dry, err := rt.callMutate(cmd.Context(), "memory.delete", map[string]string{
				"agent":  scope,
				"memory": memID,
			}, nil)
			if err != nil || dry {
				return err
			}
			return rt.writeOutput(
				rawOrValue(raw, map[string]any{"deleted": true, "agent": scope, "memory": memID}),
				func() string { return fmt.Sprintf("deleted memory %s", memID) },
			)
		},
	}
	deleteCmd.Flags().StringVar(&delScope, "scope", "", "scope or agent id (default 'default')")
	deleteCmd.Flags().StringVar(&delAgent, "agent", "", "agent id (alias for --scope)")

	memoryCmd.AddCommand(listCmd, searchCmd, createCmd, updateCmd, deleteCmd)
	return memoryCmd
}

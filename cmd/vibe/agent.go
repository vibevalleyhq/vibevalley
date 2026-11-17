package main

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/spf13/cobra"
)

type agentLookView struct {
	Species      *string `json:"species"`
	Outfit       *string `json:"outfit"`
	Orchestrator *string `json:"orchestrator"`
	Build        string  `json:"build"`
	Head         string  `json:"head"`
	Body         string  `json:"body"`
	Trim         string  `json:"trim"`
	Hat          string  `json:"hat"`
	Eye          string  `json:"eye"`
}

type agentView struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	Role            string            `json:"role"`
	Duty            string            `json:"duty"`
	Enabled         bool              `json:"enabled"`
	Runtime         string            `json:"runtime"`
	Model           string            `json:"model"`
	Effort          string            `json:"effort"`
	Persona         string            `json:"persona"`
	PersonaMode     string            `json:"personaMode"`
	Skills          []string          `json:"skills"`
	MCPServers      []any             `json:"mcpServers"`
	DisallowedTools []string          `json:"disallowedTools"`
	Env             map[string]string `json:"env"`
	Workdir         string            `json:"workdir"`
	Worktree        bool              `json:"worktree"`
	Tags            []string          `json:"tags"`
	Look            agentLookView     `json:"look"`
}

type agentTemplateView struct {
	ID        string   `json:"id"`
	Version   int      `json:"version"`
	Role      string   `json:"role"`
	Name      string   `json:"name"`
	Duty      string   `json:"duty"`
	Runtime   string   `json:"runtime"`
	Model     string   `json:"model"`
	Source    string   `json:"source"`
	Installed []string `json:"installed"`
}

func defaultAgentLook() agentLookView {
	species := "fox"
	outfit := "farmer"
	return agentLookView{
		Species: &species,
		Outfit:  &outfit,
		Build:   "biped",
		Head:    "rounded",
		Body:    "#f3e9da",
		Trim:    "#4f9a5a",
		Hat:     "#e8804f",
		Eye:     "#a6f4ff",
	}
}

func normalizeAgentPayload(a agentView) agentView {
	if a.Role == "" {
		a.Role = "worker"
	}
	if a.Runtime == "" {
		a.Runtime = "claude"
	}
	if a.PersonaMode == "" {
		a.PersonaMode = "append"
	}
	if a.Skills == nil {
		a.Skills = []string{}
	}
	if a.MCPServers == nil {
		a.MCPServers = []any{}
	}
	if a.DisallowedTools == nil {
		a.DisallowedTools = []string{}
	}
	if a.Env == nil {
		a.Env = map[string]string{}
	}
	if a.Tags == nil {
		a.Tags = []string{}
	}
	if a.Look.Build == "" {
		a.Look = defaultAgentLook()
	}
	return a
}

func formatAgentLine(a agentView) string {
	parts := []string{a.ID, a.Name, a.Role, a.Runtime}
	if a.Model != "" {
		parts = append(parts, a.Model)
	}
	if !a.Enabled {
		parts = append(parts, "off")
	}
	filtered := make([]string, 0, len(parts))
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			filtered = append(filtered, p)
		}
	}
	return strings.Join(filtered, "  ")
}

func formatAgentDetail(a agentView) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s  %s", a.ID, a.Name)
	fmt.Fprintf(&b, "\nrole: %s  runtime: %s  enabled: %t  worktree: %t", a.Role, a.Runtime, a.Enabled, a.Worktree)
	if a.Model != "" {
		fmt.Fprintf(&b, "\nmodel: %s", a.Model)
	}
	if a.Duty != "" {
		fmt.Fprintf(&b, "\nduty: %s", a.Duty)
	}
	if strings.TrimSpace(a.Persona) != "" {
		fmt.Fprintf(&b, "\n\n%s", strings.TrimSpace(a.Persona))
	}
	return b.String()
}

func findAgentInList(list []agentView, target string) (agentView, bool) {
	for _, a := range list {
		if a.ID == target {
			return a, true
		}
	}
	for _, a := range list {
		if strings.EqualFold(a.Name, target) {
			return a, true
		}
	}
	return agentView{}, false
}

func newAgentCommand(rt *appRuntime) *cobra.Command {
	agentCmd := &cobra.Command{
		Use:   "agent",
		Short: "Manage agent profiles and templates",
	}

	listCmd := &cobra.Command{
		Use:   "list",
		Short: "List configured agents",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			var agents []agentView
			raw, err := client.Call(cmd.Context(), "agent.list", nil, &agents)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, agents), func() string {
				if len(agents) == 0 {
					return "no agents"
				}
				lines := make([]string, 0, len(agents))
				for _, a := range agents {
					lines = append(lines, formatAgentLine(a))
				}
				return strings.Join(lines, "\n")
			})
		},
	}

	getCmd := &cobra.Command{
		Use:     "get <id>",
		Aliases: []string{"show"},
		Short:   "Show details for an agent profile",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			target := strings.TrimSpace(args[0])
			var agents []agentView
			_, listErr := client.Call(cmd.Context(), "agent.list", nil, &agents)
			if listErr == nil {
				found, ok := findAgentInList(agents, target)
				if !ok {
					return &APIError{
						Op:         "agent.get",
						HTTPStatus: http.StatusNotFound,
						BizCode:    400003,
						Message:    fmt.Sprintf("agent %q not found", target),
					}
				}
				return rt.writeOutput(found, func() string {
					return formatAgentDetail(found)
				})
			}
			var apiErr *APIError
			if !errors.As(listErr, &apiErr) || !apiErr.isNotFound() {
				return listErr
			}
			var item agentView
			raw, err := client.Call(cmd.Context(), "agent.get", map[string]string{"id": target}, &item)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, item), func() string {
				return formatAgentDetail(item)
			})
		},
	}

	var (
		createID         string
		createName       string
		createRuntime    string
		createModel      string
		createPrompt     string
		createPersona    string
		createRole       string
		createDuty       string
		createEffort     string
		createDisabled   bool
		createNoWorktree bool
	)
	createCmd := &cobra.Command{
		Use:   "create [name]",
		Short: "Create a new agent profile",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := strings.TrimSpace(createName)
			if name == "" && len(args) > 0 {
				name = strings.TrimSpace(args[0])
			}
			if name == "" {
				return errors.New("agent --name is required")
			}
			prompt := createPrompt
			if prompt == "-" {
				var err error
				prompt, err = rt.readAllStdin()
				if err != nil {
					return err
				}
			}
			if strings.TrimSpace(prompt) == "" {
				prompt = createPersona
			}
			payload := normalizeAgentPayload(agentView{
				ID:       strings.TrimSpace(createID),
				Name:     name,
				Role:     strings.TrimSpace(createRole),
				Duty:     strings.TrimSpace(createDuty),
				Enabled:  !createDisabled,
				Runtime:  strings.TrimSpace(createRuntime),
				Model:    strings.TrimSpace(createModel),
				Effort:   strings.TrimSpace(createEffort),
				Persona:  prompt,
				Worktree: !createNoWorktree,
			})
			var created agentView
			raw, dry, err := rt.callMutate(cmd.Context(), "agent.create", payload, &created)
			if err != nil || dry {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, created), func() string {
				return formatAgentLine(created)
			})
		},
	}
	createCmd.Flags().StringVar(&createID, "id", "", "optional explicit agent ID")
	createCmd.Flags().StringVar(&createName, "name", "", "agent display name")
	createCmd.Flags().StringVar(&createRuntime, "runtime", "claude", "agent runtime (claude|codex|gemini|opencode|pi|...)")
	createCmd.Flags().StringVar(&createModel, "model", "", "default model identifier")
	createCmd.Flags().StringVar(&createPrompt, "prompt", "", "system prompt / persona instructions (use '-' for stdin)")
	createCmd.Flags().StringVar(&createPersona, "persona", "", "persona instructions (alias for --prompt)")
	createCmd.Flags().StringVar(&createRole, "role", "worker", "agent role (worker|orchestrator)")
	createCmd.Flags().StringVar(&createDuty, "duty", "", "short role description")
	createCmd.Flags().StringVar(&createEffort, "effort", "", "reasoning effort level")
	createCmd.Flags().BoolVar(&createDisabled, "disabled", false, "create agent in disabled state")
	createCmd.Flags().BoolVar(&createNoWorktree, "no-worktree", false, "run directly in repo root without worktree isolation")

	var (
		updName     string
		updRuntime  string
		updModel    string
		updPrompt   string
		updPersona  string
		updRole     string
		updDuty     string
		updEffort   string
		updEnabled  bool
		updWorktree bool
	)
	updateCmd := &cobra.Command{
		Use:   "update <id>",
		Short: "Update an existing agent profile",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := strings.TrimSpace(args[0])
			prompt := updPrompt
			if prompt == "-" {
				var err error
				prompt, err = rt.readAllStdin()
				if err != nil {
					return err
				}
			}
			if !cmd.Flags().Changed("prompt") && cmd.Flags().Changed("persona") {
				prompt = updPersona
			}
			promptChanged := cmd.Flags().Changed("prompt") || cmd.Flags().Changed("persona")

			if rt.dryRun {
				req := map[string]any{"id": id}
				if cmd.Flags().Changed("name") {
					req["name"] = updName
				}
				if cmd.Flags().Changed("runtime") {
					req["runtime"] = updRuntime
				}
				if cmd.Flags().Changed("model") {
					req["model"] = updModel
				}
				if promptChanged {
					req["persona"] = prompt
				}
				if cmd.Flags().Changed("role") {
					req["role"] = updRole
				}
				if cmd.Flags().Changed("duty") {
					req["duty"] = updDuty
				}
				if cmd.Flags().Changed("effort") {
					req["effort"] = updEffort
				}
				if cmd.Flags().Changed("enabled") {
					req["enabled"] = updEnabled
				}
				if cmd.Flags().Changed("worktree") {
					req["worktree"] = updWorktree
				}
				return rt.writeDryRun(http.MethodPost, opPath("agent.update"), req)
			}

			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			base := agentView{ID: id, Enabled: true, Worktree: true}
			var agents []agentView
			if _, listErr := client.Call(cmd.Context(), "agent.list", nil, &agents); listErr == nil {
				found, ok := findAgentInList(agents, id)
				if !ok {
					return &APIError{
						Op:         "agent.update",
						HTTPStatus: http.StatusNotFound,
						BizCode:    400003,
						Message:    fmt.Sprintf("agent %q not found", id),
					}
				}
				base = found
			} else {
				var apiErr *APIError
				if !errors.As(listErr, &apiErr) || !apiErr.isNotFound() {
					return listErr
				}
			}

			if cmd.Flags().Changed("name") {
				base.Name = updName
			}
			if cmd.Flags().Changed("runtime") {
				base.Runtime = updRuntime
			}
			if cmd.Flags().Changed("model") {
				base.Model = updModel
			}
			if promptChanged {
				base.Persona = prompt
			}
			if cmd.Flags().Changed("role") {
				base.Role = updRole
			}
			if cmd.Flags().Changed("duty") {
				base.Duty = updDuty
			}
			if cmd.Flags().Changed("effort") {
				base.Effort = updEffort
			}
			if cmd.Flags().Changed("enabled") {
				base.Enabled = updEnabled
			}
			if cmd.Flags().Changed("worktree") {
				base.Worktree = updWorktree
			}
			payload := normalizeAgentPayload(base)
			var updated agentView
			raw, err := client.Call(cmd.Context(), "agent.update", payload, &updated)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, updated), func() string {
				return formatAgentLine(updated)
			})
		},
	}
	updateCmd.Flags().StringVar(&updName, "name", "", "updated agent name")
	updateCmd.Flags().StringVar(&updRuntime, "runtime", "", "updated runtime")
	updateCmd.Flags().StringVar(&updModel, "model", "", "updated model")
	updateCmd.Flags().StringVar(&updPrompt, "prompt", "", "updated prompt / persona (use '-' for stdin)")
	updateCmd.Flags().StringVar(&updPersona, "persona", "", "updated persona (alias for --prompt)")
	updateCmd.Flags().StringVar(&updRole, "role", "", "updated role")
	updateCmd.Flags().StringVar(&updDuty, "duty", "", "updated duty")
	updateCmd.Flags().StringVar(&updEffort, "effort", "", "updated effort")
	updateCmd.Flags().BoolVar(&updEnabled, "enabled", true, "enable or disable agent")
	updateCmd.Flags().BoolVar(&updWorktree, "worktree", true, "enable or disable worktree isolation")

	deleteCmd := &cobra.Command{
		Use:   "delete <id>",
		Short: "Delete an agent profile",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := strings.TrimSpace(args[0])
			raw, dry, err := rt.callMutate(cmd.Context(), "agent.delete", map[string]string{"id": id}, nil)
			if err != nil || dry {
				return err
			}
			return rt.writeOutput(
				rawOrValue(raw, map[string]any{"deleted": true, "id": id}),
				func() string { return fmt.Sprintf("deleted agent %s", id) },
			)
		},
	}

	templatesCmd := &cobra.Command{
		Use:   "templates",
		Short: "List available agent templates",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			var tpls []agentTemplateView
			raw, err := client.Call(cmd.Context(), "agent.template.list", nil, &tpls)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, tpls), func() string {
				if len(tpls) == 0 {
					return "no templates"
				}
				lines := make([]string, 0, len(tpls))
				for _, tp := range tpls {
					parts := []string{tp.ID, tp.Name, tp.Role, tp.Runtime}
					if tp.Source != "" {
						parts = append(parts, "["+tp.Source+"]")
					}
					if len(tp.Installed) > 0 {
						parts = append(parts, "installed:"+strings.Join(tp.Installed, ","))
					}
					lines = append(lines, strings.Join(parts, "  "))
				}
				return strings.Join(lines, "\n")
			})
		},
	}

	agentCmd.AddCommand(listCmd, getCmd, createCmd, updateCmd, deleteCmd, templatesCmd)
	return agentCmd
}

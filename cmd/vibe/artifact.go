package main

import (
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

type artifactView struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Body    string `json:"body"`
	Display string `json:"display,omitempty"`
	Channel string `json:"channel,omitempty"`
	Issue   string `json:"issue,omitempty"`
	By      string `json:"by"`
	ByName  string `json:"byName"`
	Version int    `json:"version"`
	Seq     int64  `json:"seq"`
	At      int64  `json:"at"`
	Updated int64  `json:"updated"`
}

func formatArtifactLine(a artifactView) string {
	parts := []string{a.ID, a.Title, a.Body}
	if a.ByName != "" {
		parts = append(parts, "@"+a.ByName)
	}
	if a.Issue != "" {
		parts = append(parts, "issue "+a.Issue)
	}
	filtered := make([]string, 0, len(parts))
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			filtered = append(filtered, p)
		}
	}
	return strings.Join(filtered, "  ")
}

func mapArtifactCreateKind(rawKind, rawDisplay, content string) (kind string, display string, err error) {
	k := strings.ToLower(strings.TrimSpace(rawKind))
	disp := strings.ToLower(strings.TrimSpace(rawDisplay))
	switch k {
	case "", "document", "markdown", "canvas", "sheet":
		kind = "markdown"
	case "deck":
		if disp == "slides" || strings.HasPrefix(strings.TrimSpace(content), "<") {
			kind = "html"
			if disp == "" {
				disp = "slides"
			}
		} else {
			kind = "markdown"
		}
	case "html":
		kind = "html"
	default:
		return "", "", fmt.Errorf("unsupported artifact --kind %q (expected document|canvas|sheet|deck|markdown|html)", rawKind)
	}
	return kind, disp, nil
}

func newArtifactCommand(rt *appRuntime) *cobra.Command {
	artifactCmd := &cobra.Command{
		Use:   "artifact",
		Short: "Browse, inspect, create, and delete artifacts",
	}

	var (
		listChannel string
		listIssue   string
	)
	listCmd := &cobra.Command{
		Use:   "list",
		Short: "List artifacts",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			req := map[string]any{}
			if strings.TrimSpace(listChannel) != "" {
				req["channel"] = strings.TrimSpace(listChannel)
			}
			if iss := trimIssueRef(listIssue); iss != "" {
				req["issue"] = iss
			}
			var items []artifactView
			raw, err := client.Call(cmd.Context(), "artifact.list", req, &items)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, items), func() string {
				if len(items) == 0 {
					return "no artifacts"
				}
				lines := make([]string, 0, len(items))
				for _, a := range items {
					lines = append(lines, formatArtifactLine(a))
				}
				return strings.Join(lines, "\n")
			})
		},
	}
	listCmd.Flags().StringVar(&listChannel, "channel", "", "filter artifacts by channel id")
	listCmd.Flags().StringVar(&listIssue, "issue", "", "filter artifacts by issue id")

	getCmd := &cobra.Command{
		Use:     "get <id>",
		Aliases: []string{"show"},
		Short:   "Show metadata for an artifact",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			var item artifactView
			raw, err := client.Call(cmd.Context(), "artifact.get", map[string]string{"id": strings.TrimSpace(args[0])}, &item)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, item), func() string {
				var b strings.Builder
				b.WriteString(formatArtifactLine(item))
				if item.Display != "" {
					fmt.Fprintf(&b, "\ndisplay: %s", item.Display)
				}
				if item.Channel != "" {
					fmt.Fprintf(&b, "\nchannel: %s", item.Channel)
				}
				fmt.Fprintf(&b, "\nversion: %d  seq: %d", item.Version, item.Seq)
				return b.String()
			})
		},
	}

	markdownCmd := &cobra.Command{
		Use:     "markdown <id>",
		Aliases: []string{"read"},
		Short:   "Read Markdown (or content) of an artifact",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			id := strings.TrimSpace(args[0])
			var mdRes struct {
				Markdown string `json:"markdown"`
			}
			raw, err := client.Call(cmd.Context(), "artifact.markdown.get", map[string]string{"id": id}, &mdRes)
			if err == nil {
				return rt.writeOutput(rawOrValue(raw, mdRes), func() string {
					return mdRes.Markdown
				})
			}
			var apiErr *APIError
			if !errors.As(err, &apiErr) || !apiErr.isNotFound() {
				return err
			}
			var contentRes struct {
				Version int    `json:"version"`
				Content string `json:"content"`
			}
			raw, cErr := client.Call(cmd.Context(), "artifact.content.get", map[string]string{"id": id}, &contentRes)
			if cErr != nil {
				return cErr
			}
			return rt.writeOutput(rawOrValue(raw, contentRes), func() string {
				return contentRes.Content
			})
		},
	}

	var (
		createTitle    string
		createKind     string
		createMarkdown string
		createContent  string
		createDisplay  string
		createChannel  string
		createIssue    string
		createNote     string
	)
	createCmd := &cobra.Command{
		Use:   "create",
		Short: "Create a new artifact",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			title := strings.TrimSpace(createTitle)
			if title == "" {
				return errors.New("artifact --title is required")
			}
			content := createMarkdown
			hasContent := cmd.Flags().Changed("markdown")
			if !hasContent && cmd.Flags().Changed("content") {
				content = createContent
				hasContent = true
			}
			if hasContent && content == "-" {
				var err error
				content, err = rt.readAllStdin()
				if err != nil {
					return err
				}
			}
			kind, display, err := mapArtifactCreateKind(createKind, createDisplay, content)
			if err != nil {
				return err
			}

			req := map[string]any{
				"title": title,
				"kind":  kind,
			}
			if kind == "html" && display != "" {
				req["display"] = display
			}
			if hasContent {
				req["content"] = content
			}
			if strings.TrimSpace(createNote) != "" {
				req["note"] = strings.TrimSpace(createNote)
			}
			if strings.TrimSpace(createChannel) != "" {
				req["channel"] = strings.TrimSpace(createChannel)
			}
			if iss := trimIssueRef(createIssue); iss != "" {
				req["issue"] = iss
			}

			var created artifactView
			raw, dry, err := rt.callMutate(cmd.Context(), "artifact.create", req, &created)
			if err != nil || dry {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, created), func() string {
				return formatArtifactLine(created)
			})
		},
	}
	createCmd.Flags().StringVar(&createTitle, "title", "", "artifact title")
	createCmd.Flags().StringVar(&createKind, "kind", "document", "artifact kind (document|canvas|sheet|deck|markdown|html)")
	createCmd.Flags().StringVar(&createMarkdown, "markdown", "", "initial Markdown content (use '-' to read stdin)")
	createCmd.Flags().StringVar(&createContent, "content", "", "initial artifact content (alias for --markdown)")
	createCmd.Flags().StringVar(&createDisplay, "display", "", "HTML display mode (page|slides|motion)")
	createCmd.Flags().StringVar(&createChannel, "channel", "", "channel id to announce the artifact")
	createCmd.Flags().StringVar(&createIssue, "issue", "", "associated issue id")
	createCmd.Flags().StringVar(&createNote, "note", "", "announcement note")

	deleteCmd := &cobra.Command{
		Use:   "delete <id>",
		Short: "Delete an artifact",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := strings.TrimSpace(args[0])
			raw, dry, err := rt.callMutate(cmd.Context(), "artifact.delete", map[string]string{"id": id}, nil)
			if err != nil || dry {
				return err
			}
			return rt.writeOutput(
				rawOrValue(raw, map[string]any{"deleted": true, "id": id}),
				func() string { return fmt.Sprintf("deleted artifact %s", id) },
			)
		},
	}

	artifactCmd.AddCommand(listCmd, getCmd, markdownCmd, createCmd, deleteCmd)
	return artifactCmd
}

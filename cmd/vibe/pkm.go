package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

type pkmPageSummary struct {
	Slug    string `json:"slug"`
	Title   string `json:"title"`
	Tier    string `json:"tier"`
	File    string `json:"file"`
	RelPath string `json:"relPath"`
	Open    int    `json:"open"`
}

type pkmVaultView struct {
	Root  string           `json:"root"`
	Pages []pkmPageSummary `json:"pages"`
}

type pkmBlock struct {
	Depth    int    `json:"depth"`
	Marker   string `json:"marker"`
	Priority string `json:"priority"`
	Body     string `json:"body"`
}

type pkmPageDetail struct {
	Slug   string     `json:"slug"`
	Title  string     `json:"title"`
	Tier   string     `json:"tier"`
	File   string     `json:"file"`
	Body   string     `json:"body"`
	Blocks []pkmBlock `json:"blocks"`
}

type pkmPageViewEnvelope struct {
	Page *pkmPageDetail `json:"page"`
}

type pkmSearchHit struct {
	Page      string  `json:"page"`
	PageTitle string  `json:"pageTitle"`
	Title     string  `json:"title"`
	RelPath   string  `json:"relPath"`
	Path      string  `json:"path"`
	Plain     string  `json:"plain"`
	Body      string  `json:"body"`
	Snippet   string  `json:"snippet"`
	Score     float64 `json:"score"`
}

func formatPKMOutline(p pkmPageDetail) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s", p.Title)
	if len(p.Blocks) > 0 {
		b.WriteByte('\n')
		for _, blk := range p.Blocks {
			b.WriteByte('\n')
			b.WriteString(strings.Repeat("  ", max(blk.Depth, 0)))
			b.WriteString("- ")
			var parts []string
			if blk.Marker != "" {
				parts = append(parts, blk.Marker)
			}
			if blk.Priority != "" {
				parts = append(parts, fmt.Sprintf("[#%s]", blk.Priority))
			}
			parts = append(parts, strings.ReplaceAll(blk.Body, "\n", " "))
			b.WriteString(strings.Join(parts, " "))
		}
		return b.String()
	}
	if body := strings.TrimSpace(p.Body); body != "" {
		b.WriteString("\n\n")
		b.WriteString(body)
	}
	return b.String()
}

func newPKMCommand(rt *appRuntime) *cobra.Command {
	pkmCmd := &cobra.Command{
		Use:   "pkm",
		Short: "Browse, search, and capture PKM notes",
	}

	var listLimit int
	listCmd := &cobra.Command{
		Use:   "list",
		Short: "List PKM pages",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			raw, err := client.CallWithFallback(cmd.Context(), "pkm.page.list", "pkm.list", nil, nil, nil)
			if err != nil {
				return err
			}
			var pages []pkmPageSummary
			trimmed := bytes.TrimSpace(raw)
			if bytes.HasPrefix(trimmed, []byte("[")) {
				if err := json.Unmarshal(trimmed, &pages); err != nil {
					return err
				}
			} else if len(trimmed) > 0 {
				var vault pkmVaultView
				if err := json.Unmarshal(trimmed, &vault); err != nil {
					return err
				}
				pages = vault.Pages
			}
			if listLimit > 0 && len(pages) > listLimit {
				pages = pages[:listLimit]
			}
			return rt.writeOutput(rawOrValue(raw, pages), func() string {
				if len(pages) == 0 {
					return "no pages"
				}
				lines := make([]string, 0, len(pages))
				for _, p := range pages {
					file := p.File
					if file == "" {
						file = p.RelPath
					}
					parts := []string{p.Title, p.Tier}
					if file != "" {
						parts = append(parts, file)
					}
					if p.Open > 0 {
						parts = append(parts, fmt.Sprintf("open %d", p.Open))
					}
					lines = append(lines, strings.Join(parts, "  "))
				}
				return strings.Join(lines, "\n")
			})
		},
	}
	listCmd.Flags().IntVar(&listLimit, "limit", 20, "maximum number of pages to display")

	getCmd := &cobra.Command{
		Use:     "get <path>",
		Aliases: []string{"read", "show"},
		Short:   "Read a PKM page by slug or path",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			target := args[0]
			raw, err := client.CallWithFallback(
				cmd.Context(),
				"pkm.page.get",
				"pkm.read",
				map[string]string{"page": target},
				map[string]string{"path": target, "page": target},
				nil,
			)
			if err != nil {
				return err
			}
			var page pkmPageDetail
			if len(bytes.TrimSpace(raw)) > 0 {
				var env pkmPageViewEnvelope
				if err := json.Unmarshal(raw, &env); err == nil && env.Page != nil {
					page = *env.Page
				} else if err := json.Unmarshal(raw, &page); err != nil {
					return err
				}
			}
			return rt.writeOutput(rawOrValue(raw, page), func() string {
				return formatPKMOutline(page)
			})
		},
	}

	var (
		searchTier   string
		searchMarker string
		searchLimit  int
	)
	searchCmd := &cobra.Command{
		Use:   "search <query...>",
		Short: "Search PKM notes",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			query := strings.Join(args, " ")
			req := map[string]any{"text": query}
			if searchTier != "" {
				req["tier"] = searchTier
			}
			if searchMarker != "" {
				req["marker"] = searchMarker
			}
			if searchLimit > 0 {
				req["limit"] = searchLimit
			}
			var hits []pkmSearchHit
			raw, err := client.Call(cmd.Context(), "pkm.search", req, &hits)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, hits), func() string {
				if len(hits) == 0 {
					return "no hits"
				}
				lines := make([]string, 0, len(hits))
				for _, h := range hits {
					title := h.PageTitle
					if title == "" {
						title = h.Title
					}
					if title == "" {
						title = h.Page
					}
					excerpt := h.Plain
					if excerpt == "" {
						excerpt = h.Snippet
					}
					if excerpt == "" {
						excerpt = h.Body
					}
					where := h.Path
					if where == "" {
						where = h.RelPath
					}
					if where != "" {
						lines = append(lines, fmt.Sprintf("%s › %s: %s", title, where, excerpt))
					} else {
						lines = append(lines, fmt.Sprintf("%s: %s", title, excerpt))
					}
				}
				return strings.Join(lines, "\n")
			})
		},
	}
	searchCmd.Flags().StringVar(&searchTier, "tier", "", "filter by PARA tier")
	searchCmd.Flags().StringVar(&searchMarker, "marker", "", "filter by task marker")
	searchCmd.Flags().IntVar(&searchLimit, "limit", 10, "maximum number of search hits")

	var capturePage string
	captureCmd := &cobra.Command{
		Use:   "capture [text...]",
		Short: "Capture a note into today's journal or a target page",
		RunE: func(cmd *cobra.Command, args []string) error {
			text := strings.TrimSpace(strings.Join(args, " "))
			if text == "" {
				stdinText, err := rt.readAllStdin()
				if err != nil {
					return err
				}
				text = strings.TrimSpace(stdinText)
			}
			if text == "" {
				return errors.New("capture text is required")
			}
			req := map[string]any{"text": text}
			if capturePage != "" {
				req["page"] = capturePage
			}
			var page pkmPageDetail
			raw, dry, err := rt.callMutate(cmd.Context(), "pkm.capture", req, &page)
			if err != nil || dry {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, page), func() string {
				if page.Title != "" {
					return fmt.Sprintf("captured in %s", page.Title)
				}
				return "captured"
			})
		},
	}
	captureCmd.Flags().StringVar(&capturePage, "page", "", "target page title or slug")

	pkmCmd.AddCommand(listCmd, getCmd, searchCmd, captureCmd)
	return pkmCmd
}

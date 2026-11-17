package main

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

type repoSummaryView struct {
	ID          string `json:"id,omitempty"`
	Name        string `json:"name"`
	Path        string `json:"path"`
	Git         bool   `json:"git"`
	Last        *int64 `json:"last,omitempty"`
	MaxSessions int    `json:"maxSessions"`
	PullRequest struct {
		Available bool   `json:"available"`
		Reason    string `json:"reason"`
	} `json:"pullRequest"`
}

type repoLanguagesView struct {
	Repo      string `json:"repo"`
	At        int64  `json:"at"`
	Languages []struct {
		Name     string `json:"name"`
		Files    int    `json:"files"`
		Code     int    `json:"code"`
		Comments int    `json:"comments"`
		Blanks   int    `json:"blanks"`
	} `json:"languages"`
}

type repoActivityView struct {
	Repo string `json:"repo"`
	At   int64  `json:"at"`
	Days []struct {
		Day     string `json:"day"`
		Commits int    `json:"commits"`
	} `json:"days"`
	Authors []struct {
		Name    string `json:"name"`
		Commits int    `json:"commits"`
	} `json:"authors"`
	Total int `json:"total"`
}

type repoPRResultView struct {
	Platform   string `json:"platform"`
	Repository string `json:"repository"`
	Branch     string `json:"branch"`
	SHA        string `json:"sha"`
	Base       string `json:"base"`
	Check      string `json:"check"`
	Pushed     bool   `json:"pushed"`
	URL        string `json:"url,omitempty"`
	Number     int    `json:"number,omitempty"`
	State      string `json:"state,omitempty"`
}

type issueDiffView struct {
	Repo    string `json:"repo"`
	Base    string `json:"base"`
	Branch  string `json:"branch"`
	Commits []struct {
		Hash    string `json:"hash"`
		Subject string `json:"subject"`
	} `json:"commits"`
}

func formatRepoLine(r repoSummaryView) string {
	parts := []string{r.Name, r.Path}
	if r.Git {
		parts = append(parts, "git")
	}
	if r.PullRequest.Available {
		parts = append(parts, "pr")
	}
	filtered := make([]string, 0, len(parts))
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			filtered = append(filtered, p)
		}
	}
	return strings.Join(filtered, "  ")
}

func deriveRepoName(pathArg, nameFlag string) string {
	if n := strings.TrimSpace(nameFlag); n != "" {
		return n
	}
	cleaned := strings.TrimSpace(pathArg)
	if cleaned == "" {
		return ""
	}
	if cleaned == "." || cleaned == ".." || strings.ContainsAny(cleaned, "/\\") {
		if abs, err := filepath.Abs(cleaned); err == nil {
			return filepath.Base(abs)
		}
		return filepath.Base(filepath.Clean(cleaned))
	}
	return cleaned
}

func newRepoCommand(rt *appRuntime) *cobra.Command {
	repoCmd := &cobra.Command{
		Use:   "repo",
		Short: "Manage repositories, language/activity stats, and pull requests",
	}

	listCmd := &cobra.Command{
		Use:   "list",
		Short: "List registered repositories",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			var repos []repoSummaryView
			raw, err := client.Call(cmd.Context(), "repo.list", nil, &repos)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, repos), func() string {
				if len(repos) == 0 {
					return "no repositories"
				}
				lines := make([]string, 0, len(repos))
				for _, r := range repos {
					lines = append(lines, formatRepoLine(r))
				}
				return strings.Join(lines, "\n")
			})
		},
	}

	var (
		createName   string
		createGitHub string
	)
	createCmd := &cobra.Command{
		Use:   "create <path>",
		Short: "Register or initialize a repository",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			pathArg := strings.TrimSpace(args[0])
			name := deriveRepoName(pathArg, createName)
			if name == "" {
				return errors.New("repository name or path is required")
			}
			req := map[string]any{"name": name}
			if pathArg != name || strings.ContainsAny(pathArg, "/\\") {
				req["path"] = pathArg
			}
			if strings.TrimSpace(createGitHub) != "" {
				req["github"] = strings.TrimSpace(createGitHub)
			}
			var created repoSummaryView
			raw, dry, err := rt.callMutate(cmd.Context(), "repo.create", req, &created)
			if err != nil || dry {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, created), func() string {
				return formatRepoLine(created)
			})
		},
	}
	createCmd.Flags().StringVar(&createName, "name", "", "repository name (defaults to basename of path)")
	createCmd.Flags().StringVar(&createGitHub, "github", "", "remote GitHub repository URL or owner/repo")
	createCmd.Flags().StringVar(&createGitHub, "repo", "", "remote GitHub repository URL (alias for --github)")

	var (
		validateName   string
		validateGitHub string
	)
	validateCmd := &cobra.Command{
		Use:   "validate <path>",
		Short: "Validate a repository name or path before creating",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			pathArg := strings.TrimSpace(args[0])
			name := deriveRepoName(pathArg, validateName)
			if name == "" {
				return errors.New("repository name or path is required")
			}
			req := map[string]any{"name": name}
			if pathArg != name || strings.ContainsAny(pathArg, "/\\") {
				req["path"] = pathArg
			}
			if strings.TrimSpace(validateGitHub) != "" {
				req["github"] = strings.TrimSpace(validateGitHub)
			}
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			var res struct {
				Problem string `json:"problem"`
			}
			raw, err := client.Call(cmd.Context(), "repo.validate", req, &res)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, res), func() string {
				if strings.TrimSpace(res.Problem) == "" {
					return fmt.Sprintf("valid: %s", name)
				}
				return fmt.Sprintf("invalid: %s", res.Problem)
			})
		},
	}
	validateCmd.Flags().StringVar(&validateName, "name", "", "repository name (defaults to basename of path)")
	validateCmd.Flags().StringVar(&validateGitHub, "github", "", "remote GitHub repository URL")

	languagesCmd := &cobra.Command{
		Use:   "languages <repoId>",
		Short: "List language breakdown for a repository",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			var res repoLanguagesView
			raw, err := client.Call(cmd.Context(), "repo.language.list", map[string]string{"id": strings.TrimSpace(args[0])}, &res)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, res), func() string {
				if len(res.Languages) == 0 {
					return fmt.Sprintf("%s: no languages", res.Repo)
				}
				lines := []string{res.Repo + ":"}
				for _, l := range res.Languages {
					lines = append(lines, fmt.Sprintf("  %-14s %4d files  %6d code  %5d comments  %5d blanks",
						l.Name, l.Files, l.Code, l.Comments, l.Blanks))
				}
				return strings.Join(lines, "\n")
			})
		},
	}

	var activityDays int
	activityCmd := &cobra.Command{
		Use:   "activity <repoId>",
		Short: "Show recent commit activity for a repository",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			req := map[string]any{"id": strings.TrimSpace(args[0])}
			if activityDays > 0 {
				req["days"] = activityDays
			}
			var res repoActivityView
			raw, err := client.Call(cmd.Context(), "repo.activity.get", req, &res)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, res), func() string {
				var b strings.Builder
				fmt.Fprintf(&b, "%s  total=%d commits  days=%d  authors=%d", res.Repo, res.Total, len(res.Days), len(res.Authors))
				for _, a := range res.Authors {
					fmt.Fprintf(&b, "\n  %s  %d", a.Name, a.Commits)
				}
				return b.String()
			})
		},
	}
	activityCmd.Flags().IntVar(&activityDays, "days", 30, "number of trailing days to include")

	var (
		prTitle  string
		prBody   string
		prBase   string
		prDraft  bool
		prCwd    string
		prBranch string
		prSHA    string
	)
	prCmd := &cobra.Command{
		Use:   "pr <issueId>",
		Short: "Submit (or dry-run preview) a pull request for an issue",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			target := strings.TrimSpace(args[0])
			issueID := ""
			if target != "submit" {
				issueID = trimIssueRef(target)
			}

			title := strings.TrimSpace(prTitle)
			body := prBody
			if body == "-" {
				body, err = rt.readAllStdin()
				if err != nil {
					return err
				}
			}
			base := strings.TrimSpace(prBase)
			cwd := strings.TrimSpace(prCwd)
			branch := strings.TrimSpace(prBranch)
			sha := strings.TrimSpace(prSHA)

			if issueID != "" {
				var iss issueView
				_, gErr := client.Call(cmd.Context(), "issue.get", map[string]string{"id": issueID}, &iss)
				if gErr == nil {
					if iss.ID != "" {
						issueID = iss.ID
					}
					if title == "" {
						title = iss.Title
					}
					if body == "" {
						body = iss.Description
					}
					var diff issueDiffView
					if _, dErr := client.Call(cmd.Context(), "issue.diff.get", map[string]string{"id": issueID}, &diff); dErr == nil {
						if branch == "" {
							branch = diff.Branch
						}
						if base == "" {
							base = diff.Base
						}
						if sha == "" && len(diff.Commits) > 0 {
							sha = diff.Commits[0].Hash
						}
					}
					if cwd == "" {
						var sessions []sessionView
						if _, sErr := client.Call(cmd.Context(), "session.list", nil, &sessions); sErr == nil {
							for _, s := range sessions {
								if s.Scope != nil && s.Scope.Kind == "issue" && s.Scope.ID == issueID && s.Worktree != "" {
									cwd = s.Worktree
									break
								}
							}
						}
					}
					if cwd == "" && issueRepo(iss) != "" {
						var repos []repoSummaryView
						if _, rErr := client.Call(cmd.Context(), "repo.list", nil, &repos); rErr == nil {
							repoRef := issueRepo(iss)
							for _, rp := range repos {
								if rp.Name == repoRef || rp.ID == repoRef {
									cwd = rp.Path
									break
								}
							}
						}
					}
				} else {
					var apiErr *APIError
					if !errors.As(gErr, &apiErr) || !apiErr.isNotFound() || apiErr.BizCode == 300001 {
						return gErr
					}
				}
			}

			if base == "" {
				base = "main"
			}
			req := map[string]any{
				"cwd":    cwd,
				"branch": branch,
				"sha":    sha,
				"base":   base,
				"title":  title,
				"body":   body,
				"dryRun": rt.dryRun,
			}
			if issueID != "" {
				req["issueId"] = issueID
			}
			if prDraft {
				req["draft"] = true
			}

			var res repoPRResultView
			raw, err := client.Call(cmd.Context(), "repo.pr.submit", req, &res)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, res), func() string {
				if res.URL != "" {
					return fmt.Sprintf("%s  (%s)", res.URL, res.Check)
				}
				return fmt.Sprintf("pr %s -> %s  branch=%s  check=%s  pushed=%t", res.Repository, res.Base, res.Branch, res.Check, res.Pushed)
			})
		},
	}
	prCmd.Flags().StringVar(&prTitle, "title", "", "pull request title")
	prCmd.Flags().StringVar(&prBody, "body", "", "pull request body (use '-' to read stdin)")
	prCmd.Flags().StringVar(&prBase, "base", "", "target base branch (default main)")
	prCmd.Flags().BoolVar(&prDraft, "draft", false, "create pull request as a draft")
	prCmd.Flags().StringVar(&prCwd, "cwd", "", "override repository or worktree directory")
	prCmd.Flags().StringVar(&prBranch, "branch", "", "override source branch")
	prCmd.Flags().StringVar(&prSHA, "sha", "", "override commit SHA")

	repoCmd.AddCommand(listCmd, createCmd, validateCmd, languagesCmd, activityCmd, prCmd)
	return repoCmd
}

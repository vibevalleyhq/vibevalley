package main

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/spf13/cobra"
)

type runtimeSettingsView struct {
	Enabled       bool              `json:"enabled"`
	BinPath       string            `json:"binPath"`
	DefaultModel  string            `json:"defaultModel"`
	DefaultEffort string            `json:"defaultEffort"`
	Env           map[string]string `json:"env"`
	DailyBudget   *float64          `json:"dailyBudget,omitempty"`
	MaxWorking    *int              `json:"maxWorking,omitempty"`
}

type runtimeInfoView struct {
	ID     string `json:"id"`
	Preset struct {
		ID    string `json:"id"`
		Label string `json:"label"`
	} `json:"preset"`
	Installation struct {
		Status  string  `json:"status"`
		Via     string  `json:"via,omitempty"`
		Command string  `json:"command,omitempty"`
		Version *string `json:"version,omitempty"`
	} `json:"installation"`
	Settings runtimeSettingsView `json:"settings"`
}

func formatRuntimeLine(r runtimeInfoView) string {
	status := r.Installation.Status
	if status == "available" {
		cmdParts := []string{}
		if r.Installation.Version != nil && strings.TrimSpace(*r.Installation.Version) != "" {
			cmdParts = append(cmdParts, *r.Installation.Version)
		}
		if r.Installation.Command != "" {
			cmdParts = append(cmdParts, r.Installation.Command)
		}
		if len(cmdParts) > 0 {
			status = strings.Join(cmdParts, " ")
		}
	}
	parts := []string{r.ID, status}
	if !r.Settings.Enabled {
		parts = append(parts, "disabled")
	}
	if r.Settings.DefaultModel != "" {
		parts = append(parts, "model="+r.Settings.DefaultModel)
	}
	if r.Settings.BinPath != "" {
		parts = append(parts, "bin="+r.Settings.BinPath)
	}
	return strings.Join(parts, "  ")
}

func newRuntimeCommand(rt *appRuntime) *cobra.Command {
	runtimeCmd := &cobra.Command{
		Use:   "runtime",
		Short: "Inspect and configure coding agent runtimes",
	}

	listCmd := &cobra.Command{
		Use:   "list",
		Short: "List available coding agent runtimes",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			var runtimes []runtimeInfoView
			raw, err := client.Call(cmd.Context(), "runtime.list", nil, &runtimes)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, runtimes), func() string {
				if len(runtimes) == 0 {
					return "no runtimes"
				}
				lines := make([]string, 0, len(runtimes))
				for _, r := range runtimes {
					lines = append(lines, formatRuntimeLine(r))
				}
				return strings.Join(lines, "\n")
			})
		},
	}

	refreshCmd := &cobra.Command{
		Use:   "refresh [id]",
		Short: "Refresh runtime discovery status",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			if len(args) == 1 {
				id := strings.TrimSpace(args[0])
				var item runtimeInfoView
				raw, err := client.Call(cmd.Context(), "runtime.refresh", map[string]string{"id": id}, &item)
				if err != nil {
					return err
				}
				return rt.writeOutput(rawOrValue(raw, item), func() string {
					return formatRuntimeLine(item)
				})
			}

			var listed []runtimeInfoView
			_, listErr := client.Call(cmd.Context(), "runtime.list", nil, &listed)
			if listErr != nil {
				var apiErr *APIError
				if !errors.As(listErr, &apiErr) || !apiErr.isNotFound() {
					return listErr
				}
				var refreshed []runtimeInfoView
				raw, err := client.Call(cmd.Context(), "runtime.refresh", map[string]any{}, &refreshed)
				if err != nil {
					return err
				}
				return rt.writeOutput(rawOrValue(raw, refreshed), func() string {
					lines := make([]string, 0, len(refreshed))
					for _, r := range refreshed {
						lines = append(lines, formatRuntimeLine(r))
					}
					return strings.Join(lines, "\n")
				})
			}

			refreshed := make([]runtimeInfoView, 0, len(listed))
			for _, cur := range listed {
				var one runtimeInfoView
				if _, err := client.Call(cmd.Context(), "runtime.refresh", map[string]string{"id": cur.ID}, &one); err != nil {
					return err
				}
				refreshed = append(refreshed, one)
			}
			return rt.writeOutput(refreshed, func() string {
				if len(refreshed) == 0 {
					return "no runtimes"
				}
				lines := make([]string, 0, len(refreshed))
				for _, r := range refreshed {
					lines = append(lines, formatRuntimeLine(r))
				}
				return strings.Join(lines, "\n")
			})
		},
	}

	var (
		updBin           string
		updDefaultModel  string
		updDefaultEffort string
		updEnabled       bool
	)
	updateCmd := &cobra.Command{
		Use:   "update <id>",
		Short: "Update settings for a runtime",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := strings.TrimSpace(args[0])
			if rt.dryRun {
				req := map[string]any{"id": id}
				if cmd.Flags().Changed("bin") {
					req["binPath"] = updBin
				}
				if cmd.Flags().Changed("default-model") {
					req["defaultModel"] = updDefaultModel
				}
				if cmd.Flags().Changed("default-effort") {
					req["defaultEffort"] = updDefaultEffort
				}
				if cmd.Flags().Changed("enabled") {
					req["enabled"] = updEnabled
				}
				return rt.writeDryRun(http.MethodPost, opPath("runtime.setting.update"), req)
			}

			client, _, err := rt.newClient()
			if err != nil {
				return err
			}
			settings := runtimeSettingsView{
				Enabled: true,
				Env:     map[string]string{},
			}
			var list []runtimeInfoView
			if _, listErr := client.Call(cmd.Context(), "runtime.list", nil, &list); listErr == nil {
				found := false
				for _, r := range list {
					if r.ID == id {
						settings = r.Settings
						if settings.Env == nil {
							settings.Env = map[string]string{}
						}
						found = true
						break
					}
				}
				if !found {
					return &APIError{
						Op:         "runtime.setting.update",
						HTTPStatus: http.StatusNotFound,
						BizCode:    400005,
						Message:    fmt.Sprintf("runtime %q not found", id),
					}
				}
			} else {
				var apiErr *APIError
				if !errors.As(listErr, &apiErr) || !apiErr.isNotFound() {
					return listErr
				}
			}

			if cmd.Flags().Changed("bin") {
				settings.BinPath = updBin
			}
			if cmd.Flags().Changed("default-model") {
				settings.DefaultModel = updDefaultModel
			}
			if cmd.Flags().Changed("default-effort") {
				settings.DefaultEffort = updDefaultEffort
			}
			if cmd.Flags().Changed("enabled") {
				settings.Enabled = updEnabled
			}

			req := map[string]any{
				"id":            id,
				"enabled":       settings.Enabled,
				"binPath":       settings.BinPath,
				"defaultModel":  settings.DefaultModel,
				"defaultEffort": settings.DefaultEffort,
				"env":           settings.Env,
			}
			if settings.DailyBudget != nil {
				req["dailyBudget"] = *settings.DailyBudget
			}
			if settings.MaxWorking != nil {
				req["maxWorking"] = *settings.MaxWorking
			}

			var updated runtimeInfoView
			raw, err := client.Call(cmd.Context(), "runtime.setting.update", req, &updated)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, updated), func() string {
				return formatRuntimeLine(updated)
			})
		},
	}
	updateCmd.Flags().StringVar(&updBin, "bin", "", "override runtime binary path")
	updateCmd.Flags().StringVar(&updDefaultModel, "default-model", "", "default model for this runtime")
	updateCmd.Flags().StringVar(&updDefaultEffort, "default-effort", "", "default reasoning effort")
	updateCmd.Flags().BoolVar(&updEnabled, "enabled", true, "enable or disable runtime")

	runtimeCmd.AddCommand(listCmd, refreshCmd, updateCmd)
	return runtimeCmd
}

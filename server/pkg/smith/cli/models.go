package cli

import (
	"context"
	"fmt"
	"strings"
	"time"

	"vibevalley/pkg/smith/oar"
)

func millis(ms int64) time.Duration { return time.Duration(ms) * time.Millisecond }

// modelsReport is one `oar models` row.
type modelsReport struct {
	RuntimeID string `json:"runtimeId"`
	// Present only when the runtime is installed but not available.
	Installation *oar.InstallationSnapshot `json:"installation,omitempty"`
	// nil when installation state made listing impossible.
	Models *oar.ListModelsResult `json:"models"`
}

func readModels(ctx context.Context, runtime oar.Runtime, options oar.ListModelsOptions) (modelsReport, error) {
	if runtime.ListModels == nil || runtime.Installation == nil {
		reason := runtime.ID + " exposes no listModels capability"
		if runtime.ListModels != nil {
			reason = runtime.ID + " exposes no installation probe"
		}
		return modelsReport{RuntimeID: runtime.ID, Models: &oar.ListModelsResult{Kind: "unsupported", Reason: reason}}, nil
	}
	installation, err := runtime.Installation(ctx)
	if err != nil {
		return modelsReport{}, err
	}
	if installation.Kind != "available" {
		return modelsReport{RuntimeID: runtime.ID, Installation: &installation}, nil
	}
	models, err := runtime.ListModels(ctx, installation.Available, options)
	if err != nil {
		return modelsReport{}, err
	}
	return modelsReport{RuntimeID: runtime.ID, Models: &models}, nil
}

// renderModels is the human table for one report.
func renderModels(report modelsReport) []string {
	runtimeID, models := report.RuntimeID, report.Models
	if models == nil {
		kind := "unknown"
		if report.Installation != nil {
			kind = report.Installation.Kind
		}
		return []string{fmt.Sprintf("%s: not available (%s)", runtimeID, kind)}
	}
	switch models.Kind {
	case "unauthenticated":
		if models.Detail == "" {
			return []string{runtimeID + ": not logged in"}
		}
		return []string{fmt.Sprintf("%s: not logged in (%s)", runtimeID, models.Detail)}
	case "unsupported":
		return []string{fmt.Sprintf("%s: unsupported (%s)", runtimeID, models.Reason)}
	}
	if len(models.Models) == 0 {
		return []string{runtimeID + ": no models"}
	}
	lines := make([]string, 0, len(models.Models))
	for _, model := range models.Models {
		parts := []string{runtimeID + "\t" + model.ID}
		if model.ResolvedID != "" && model.ResolvedID != model.ID {
			parts = append(parts, "-> "+model.ResolvedID)
		}
		if model.DisplayName != "" && model.DisplayName != model.ID {
			parts = append(parts, `"`+model.DisplayName+`"`)
		}
		if len(model.EffortLevels) > 0 {
			marked := make([]string, 0, len(model.EffortLevels))
			for _, level := range model.EffortLevels {
				if level == model.DefaultEffort {
					level += "*"
				}
				marked = append(marked, level)
			}
			parts = append(parts, "["+strings.Join(marked, ",")+"]")
		}
		if len(model.ServiceTiers) > 0 {
			marked := make([]string, 0, len(model.ServiceTiers))
			for _, tier := range model.ServiceTiers {
				if tier == model.DefaultServiceTier {
					tier += "*"
				}
				marked = append(marked, tier)
			}
			parts = append(parts, "tiers ["+strings.Join(marked, ",")+"]")
		}
		if model.Default {
			parts = append(parts, "(default)")
		}
		if model.Disabled != nil {
			parts = append(parts, "(disabled: "+model.Disabled.Reason+")")
		}
		lines = append(lines, strings.Join(parts, " "))
	}
	return lines
}

func (c *cli) models(ctx context.Context, raw []string) error {
	parsed, err := parseArgs(raw, []string{"cwd", "timeout"}, []string{"json"})
	if err != nil {
		return err
	}
	timeout, _, err := parsed.positiveMs("timeout")
	if err != nil {
		fmt.Fprintln(c.stderr, err.Error())
		c.exitCode = 1
		return nil
	}
	cwd, _ := parsed.value("cwd")
	options := oar.ListModelsOptions{Cwd: cwd, Timeout: millis(timeout)}
	id, _ := parsed.arg(0)
	runtimes, err := c.selected(id)
	if err != nil {
		return err
	}
	reports := readEach(runtimes, func(runtime oar.Runtime) (any, error) {
		return readModels(ctx, runtime, options)
	})
	if parsed.flag("json") {
		c.printEach(reports)
		return nil
	}
	for _, report := range reports {
		if failed, ok := report.(failure); ok {
			c.exitCode = 1
			fmt.Fprintf(c.stdout, "%s: error: %s\n", failed.RuntimeID, failed.Error)
			continue
		}
		for _, line := range renderModels(report.(modelsReport)) {
			fmt.Fprintln(c.stdout, line)
		}
	}
	return nil
}

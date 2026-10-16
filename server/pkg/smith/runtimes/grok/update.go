package grok

import (
	"context"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

const updateSource = "grok update --check --json"

// ProjectUpdateCheck reads grok 1.0.46's `update --check --json`:
// `currentVersion`, `latestVersion`, `updateAvailable`, `installer`,
// `channel` and `error`. It always exits 0: a failed lookup shows only in
// `error`. The check never passes `--alpha`/`--stable`, which would persist
// a channel switch.
func ProjectUpdateCheck(installed string, report any) oar.UpdateCheck {
	fields := jsonx.AsRecord(report)
	if fields == nil {
		return oar.UpdateCheck{Kind: "unavailable", Reason: "lookup_failed", Detail: "grok update --check --json printed no JSON", Source: updateSource}
	}
	if failure, ok := fields["error"].(string); ok && failure != "" {
		return oar.UpdateCheck{Kind: "unavailable", Reason: "lookup_failed", Detail: failure, Source: updateSource}
	}
	latest, ok := fields["latestVersion"].(string)
	if !ok {
		return oar.UpdateCheck{Kind: "unavailable", Reason: "lookup_failed", Detail: "grok reported no latest version", Source: updateSource}
	}
	channel, _ := fields["channel"].(string)
	check := shared.ComparedCheck(installed, latest, updateSource, channel)
	if available, ok := fields["updateAvailable"].(bool); ok && check.Kind == "ok" {
		check.UpdateAvailable = available
	}
	return check
}

// CheckUpdate runs `grok update --check --json` (grokCheckUpdate).
func CheckUpdate(ctx context.Context, installation oar.AvailableInstallation, options oar.UpdateCheckOptions) (oar.UpdateCheck, error) {
	update := shared.ExecutableUpdateOf(installation)
	if update.Kind == "unavailable" {
		return update.Check, nil
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = shared.CheckTimeout
	}
	_, report := shared.RunCheckCommand(ctx, update.Installation.Command, []string{"update", "--check", "--json"}, timeout)
	return ProjectUpdateCheck(update.Installed, report), nil
}

// Upgrade runs `grok update` (grokUpgrade).
func Upgrade(ctx context.Context, installation oar.AvailableInstallation, options oar.UpgradeOptions) (oar.UpgradeResult, error) {
	return shared.UpgradeExecutable(ctx, installation, shared.NativeUpdater{Check: CheckUpdate, Args: []string{"update"}}, options)
}

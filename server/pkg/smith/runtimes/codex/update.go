package codex

import (
	"context"
	"strings"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

const updateSource = "codex doctor --json"

// projectCodexUpdateStatus reads codex's own check (update.ts): the
// `updates.status` row of `codex doctor --json` (codex 0.158.0): `latest
// version` and a `latest version status` verdict. doctor exits 1 whenever any
// other row fails (no login, for one), so the JSON decides, not the exit
// code. Its `update action` is `manual or unknown` for a copy `codex update`
// cannot update (a copied binary, an app bundle).
func projectCodexUpdateStatus(installed string, doctor any) oar.UpdateCheck {
	checks := jsonx.AsRecord(jsonx.AsRecord(doctor)["checks"])
	details := jsonx.AsRecord(jsonx.AsRecord(checks["updates.status"])["details"])
	latest, ok := details["latest version"].(string)
	if !ok {
		return oar.UpdateCheck{Kind: "unavailable", Reason: "lookup_failed", Detail: "codex doctor --json reports no latest version", Source: updateSource}
	}
	if details["update action"] == "manual or unknown" {
		return oar.UpdateCheck{Kind: "unavailable", Reason: "unmanaged_installation", Detail: "codex update cannot update this copy", Source: updateSource}
	}
	check := shared.ComparedCheck(installed, latest, updateSource, "")
	status, ok := details["latest version status"].(string)
	if check.Kind != "ok" || !ok {
		return check
	}
	if strings.Contains(status, "newer version is available") {
		check.UpdateAvailable = true
		return check
	}
	if strings.Contains(status, "not older") {
		check.UpdateAvailable = false
	}
	return check
}

// CheckUpdate is codex's update check (codexCheckUpdate).
func CheckUpdate(ctx context.Context, installation oar.AvailableInstallation, options oar.UpdateCheckOptions) (oar.UpdateCheck, error) {
	update := shared.ExecutableUpdateOf(installation)
	if update.Kind == "unavailable" {
		return update.Check, nil
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = shared.CheckTimeout
	}
	_, doctor := shared.RunCheckCommand(ctx, update.Installation.Command, []string{"doctor", "--json"}, timeout)
	if doctor == nil {
		return oar.UpdateCheck{Kind: "unavailable", Reason: "lookup_failed", Detail: "codex doctor --json printed no JSON", Source: updateSource}, nil
	}
	return projectCodexUpdateStatus(update.Installed, doctor), nil
}

// Upgrade runs `codex update` (codexUpgrade). It never checks and reports
// success even when its download failed, hence the version read-back.
func Upgrade(ctx context.Context, installation oar.AvailableInstallation, options oar.UpgradeOptions) (oar.UpgradeResult, error) {
	return shared.UpgradeExecutable(ctx, installation, shared.NativeUpdater{Check: CheckUpdate, Args: []string{"update"}}, options)
}

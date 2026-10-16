package kimi

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// UpdateSources is where a check reads. Kimi has no check-only command;
// `kimi upgrade` (2.1.1) reads `code.kimi.com/kimi-code/latest`, or
// `code.kimi.ai` when the recorded region is `global`, and ignores the
// staged rollout, so that pointer is the version it installs, and only when
// it is newer. A Homebrew copy only prints `brew upgrade kimi-code`.
type UpdateSources struct {
	Mainland string
	Global   string
	Home     func() string
}

var sources = UpdateSources{
	Mainland: "https://code.kimi.com/kimi-code/latest",
	Global:   "https://code.kimi.ai/kimi-code/latest",
	Home: func() string {
		if home, ok := os.LookupEnv("KIMI_CODE_HOME"); ok {
			return home
		}
		userHome, _ := os.UserHomeDir()
		return filepath.Join(userHome, ".kimi-code")
	},
}

// nonInteractiveUpgrade: `upgrade -y` arrived in kimi 0.43.0; before it the
// upgrade only runs from a terminal prompt.
const nonInteractiveUpgrade = "0.43.0"

func region(home string) string {
	data, err := os.ReadFile(filepath.Join(home, "region"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// UpdateCheck is the checker over these sources (kimiUpdateCheck).
func UpdateCheck(from UpdateSources) oar.UpdateChecker {
	return func(ctx context.Context, installation oar.AvailableInstallation, options oar.UpdateCheckOptions) (oar.UpdateCheck, error) {
		update := shared.ExecutableUpdateOf(installation)
		if update.Kind == "unavailable" {
			return update.Check, nil
		}
		if strings.Contains(shared.InstalledPath(update.Installation.Command), "/Cellar/") {
			return oar.UpdateCheck{Kind: "unavailable", Reason: "package_manager", Detail: "this copy updates through Homebrew"}, nil
		}
		url := from.Mainland
		if region(from.Home()) == "global" {
			url = from.Global
		}
		timeout := options.Timeout
		if timeout <= 0 {
			timeout = shared.CheckTimeout
		}
		text, failed := shared.ReadReleaseSource(ctx, url, timeout)
		if failed != nil {
			return *failed, nil
		}
		// kimi upgrade acts only on a newer release.
		check := shared.ComparedCheck(update.Installed, strings.TrimSpace(text), url, "")
		if check.Kind == "ok" {
			check.UpdateAvailable = !shared.VersionAtLeast(check.Installed, check.Latest)
		}
		return check, nil
	}
}

// CheckUpdate is kimi's update check (kimiCheckUpdate).
var CheckUpdate = UpdateCheck(sources)

// Upgrader runs `kimi upgrade -y` (kimiUpgrader). A native install stages
// the new binary; the version read-back starts kimi, which swaps it in.
func Upgrader(check oar.UpdateChecker) oar.Upgrader {
	return func(ctx context.Context, installation oar.AvailableInstallation, options oar.UpgradeOptions) (oar.UpgradeResult, error) {
		update := shared.ExecutableUpdateOf(installation)
		if update.Kind == "executable" && !shared.VersionAtLeast(update.Installed, nonInteractiveUpgrade) {
			return oar.UpgradeResult{
				Kind:   "unsupported",
				Reason: "requires_terminal",
				Detail: "kimi " + update.Installed + " has no non-interactive upgrade (added in " + nonInteractiveUpgrade + "); run kimi upgrade in a terminal",
			}, nil
		}
		return shared.UpgradeExecutable(ctx, installation, shared.NativeUpdater{Check: check, Args: []string{"upgrade", "-y"}}, options)
	}
}

// Upgrade is kimi's upgrader (kimiUpgrade).
var Upgrade = Upgrader(CheckUpdate)

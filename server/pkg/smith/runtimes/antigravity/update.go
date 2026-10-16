package antigravity

import (
	"context"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// DefaultRegistry is the ACP registry entry, the only release listing.
const DefaultRegistry = "https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json"

// UpdateCheck: agy_acp_server has no updater and Google publishes no latest
// pointer; the ACP registry entry is the only release listing, and it trails
// Google's own downloads (1.2.1 listed while 1.3.0 was downloadable on
// 2026-10-01). So this check names the registry as its source, counts only a
// newer registry version as an update, and there is no upgrade.
func UpdateCheck(registry string) oar.UpdateChecker {
	return func(ctx context.Context, installation oar.AvailableInstallation, options oar.UpdateCheckOptions) (oar.UpdateCheck, error) {
		update := shared.ExecutableUpdateOf(installation)
		if update.Kind == "unavailable" {
			return update.Check, nil
		}
		timeout := options.Timeout
		if timeout <= 0 {
			timeout = shared.CheckTimeout
		}
		text, failed := shared.ReadReleaseSource(ctx, registry, timeout)
		if failed != nil {
			return *failed, nil
		}
		version, _ := jsonx.ParseRecord([]byte(text))["version"].(string)
		check := shared.ComparedCheck(update.Installed, version, registry, "")
		if check.Kind == "ok" && check.UpdateAvailable {
			check.UpdateAvailable = !shared.VersionAtLeast(check.Installed, check.Latest)
		}
		return check, nil
	}
}

// CheckUpdate checks the ACP registry.
var CheckUpdate = UpdateCheck(DefaultRegistry)

package claude

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// claude has no check-only command, so the check reads what `claude update`
// reads (claude 2.1.286, update.ts): the native build follows
// downloads.claude.ai/claude-code-releases/<channel>, an npm copy the npm
// dist-tag of the same channel; the channel is settings autoUpdatesChannel
// (latest unless stable), and a minimumVersion above that channel keeps the
// installed version. Package-manager copies update through their package
// manager, and DISABLE_UPDATES turns every update path off. Managed
// (administrator) settings are not read.

// claudeUpdateSources are where a check reads.
type claudeUpdateSources struct {
	Releases  string
	Npm       string
	ConfigDir func() string
	// .claude.json, where claude records its installMethod.
	GlobalConfig func() string
}

var updateSources = claudeUpdateSources{
	Releases: "https://downloads.claude.ai/claude-code-releases",
	Npm:      "https://registry.npmjs.org/@anthropic-ai/claude-code",
	ConfigDir: func() string {
		if dir, ok := os.LookupEnv("CLAUDE_CONFIG_DIR"); ok {
			return dir
		}
		return filepath.Join(homeDir(), ".claude")
	},
	GlobalConfig: func() string {
		dir, ok := os.LookupEnv("CLAUDE_CONFIG_DIR")
		if !ok {
			dir = homeDir()
		}
		return filepath.Join(dir, ".claude.json")
	},
}

var packageManaged = []string{"/Caskroom/", "/Cellar/", "/mise/", "/asdf/", "/WinGet/", "/winget/"}

// claudeInstallKind is how a copy was installed: "native", "npm" or
// "package_manager". The layout decides where it is unambiguous (the native
// versions directory, an npm package, a package manager's tree). A shim the
// path does not explain (a pnpm bin, a Windows claude.cmd) falls back to the
// installMethod claude recorded: global is its npm method.
func claudeInstallKind(realPath string, recorded any) string {
	if strings.Contains(realPath, "/claude/versions/") {
		return "native"
	}
	if strings.Contains(realPath, "/node_modules/@anthropic-ai/claude-code/") {
		return "npm"
	}
	for _, segment := range packageManaged {
		if strings.Contains(realPath, segment) {
			return "package_manager"
		}
	}
	if recorded == "global" {
		return "npm"
	}
	return "native"
}

func readJSONRecord(file string) jsonx.Record {
	data, err := os.ReadFile(file)
	if err != nil {
		return jsonx.Record{}
	}
	record := jsonx.ParseRecord(data)
	if record == nil {
		return jsonx.Record{}
	}
	return record
}

func updatesDisabled(settings jsonx.Record) bool {
	var flag any = os.Getenv("DISABLE_UPDATES")
	if flag == "" {
		value, ok := jsonx.AsRecord(settings["env"])["DISABLE_UPDATES"]
		if !ok {
			return false
		}
		flag = value
	}
	// A JSON null is set, as TS reads it.
	return flag != "" && flag != "0" && flag != false
}

// withMinimum: claude stays on its version when the channel is below settings minimumVersion.
func withMinimum(check oar.UpdateCheck, minimum any) oar.UpdateCheck {
	if floor, ok := minimum.(string); ok && check.Kind == "ok" && !shared.VersionAtLeast(check.Latest, floor) {
		check.UpdateAvailable = false
	}
	return check
}

func npmCheck(ctx context.Context, installed, channel, url string, options oar.UpdateCheckOptions) oar.UpdateCheck {
	text, failed := shared.ReadReleaseSource(ctx, url, checkTimeout(options))
	if failed != nil {
		return *failed
	}
	version, _ := jsonx.ParseRecord([]byte(text))["version"].(string)
	return shared.ComparedCheck(installed, version, url, channel)
}

func checkTimeout(options oar.UpdateCheckOptions) time.Duration {
	if options.Timeout > 0 {
		return options.Timeout
	}
	return shared.CheckTimeout
}

// claudeUpdateCheck is the checker over these sources.
func claudeUpdateCheck(from claudeUpdateSources) oar.UpdateChecker {
	return func(ctx context.Context, installation oar.AvailableInstallation, options oar.UpdateCheckOptions) (oar.UpdateCheck, error) {
		update := shared.ExecutableUpdateOf(installation)
		if update.Kind == "unavailable" {
			return update.Check, nil
		}
		recorded := readJSONRecord(from.GlobalConfig())["installMethod"]
		method := claudeInstallKind(shared.InstalledPath(update.Installation.Command), recorded)
		if method == "package_manager" {
			return oar.UpdateCheck{Kind: "unavailable", Reason: "package_manager", Detail: "this copy updates through its package manager"}, nil
		}
		settings := readJSONRecord(filepath.Join(from.ConfigDir(), "settings.json"))
		if updatesDisabled(settings) {
			return oar.UpdateCheck{Kind: "unavailable", Reason: "updates_disabled", Detail: "DISABLE_UPDATES is set"}, nil
		}
		channel := "latest"
		if settings["autoUpdatesChannel"] == "stable" {
			channel = "stable"
		}
		if method == "npm" {
			return withMinimum(npmCheck(ctx, update.Installed, channel, from.Npm+"/"+channel, options), settings["minimumVersion"]), nil
		}
		url := from.Releases + "/" + channel
		text, failed := shared.ReadReleaseSource(ctx, url, checkTimeout(options))
		if failed != nil {
			return *failed, nil
		}
		return withMinimum(shared.ComparedCheck(update.Installed, strings.TrimSpace(text), url, channel), settings["minimumVersion"]), nil
	}
}

// CheckUpdate is claude's update check (claudeCheckUpdate).
var CheckUpdate = claudeUpdateCheck(updateSources)

// Upgrade runs `claude update` without the parent Claude Code session's
// markers, as every other claude OAR starts (environment.go).
func Upgrade(ctx context.Context, installation oar.AvailableInstallation, options oar.UpgradeOptions) (oar.UpgradeResult, error) {
	return shared.UpgradeExecutable(ctx, installation, shared.NativeUpdater{Check: CheckUpdate, Args: []string{"update"}, Env: claudeEnv}, options)
}

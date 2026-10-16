package shared

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// CheckTimeout bounds an update check when the caller gives none.
const CheckTimeout = 20 * time.Second

// DefaultUpgradeTimeout bounds an updater run when the caller gives none.
const DefaultUpgradeTimeout = 600 * time.Second

// versionTimeout: the slowest installation probe (kimi) allows 30 s for
// --version; a kimi start after an upgrade also swaps the staged binary in.
const versionTimeout = 30 * time.Second

var releaseVersionPattern = regexp.MustCompile(`\bv?(\d+\.\d+\.\d+(?:-[\w.]+)?)\b`)

// ReleaseVersion is the release version inside a --version line or release
// pointer: a semver, after a v or not (opencode v2.0.26). "" when there is none.
func ReleaseVersion(text string) string {
	if match := releaseVersionPattern.FindStringSubmatch(text); match != nil {
		return match[1]
	}
	return ""
}

// jsNumber is Number(text) for the decimal texts a version part holds.
func jsNumber(text string) float64 {
	text = jsTrim(text)
	if text == "" {
		return 0
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return math.NaN()
	}
	return value
}

func numericParts(value string) []float64 {
	release, _, _ := strings.Cut(value, "-")
	var parts []float64
	for _, part := range strings.Split(release, ".") {
		parts = append(parts, jsNumber(part))
	}
	return parts
}

// VersionAtLeast compares in numeric major.minor.patch order; prerelease tags are ignored.
func VersionAtLeast(version, floor string) bool {
	left, right := numericParts(version), numericParts(floor)
	at := func(parts []float64, index int) float64 {
		if index < len(parts) {
			return parts[index]
		}
		return 0
	}
	for index := 0; index < max(len(left), len(right)); index++ {
		difference := at(left, index) - at(right, index)
		if difference != 0 {
			// NaN differs too, and is not greater: a part that is no number fails.
			return difference > 0
		}
	}
	return true
}

var scriptContext = regexp.MustCompile(`(?i)^npm_(?:config_user_agent|lifecycle_|package_|execpath$|node_execpath$|command$)`)

// UpdaterEnv is env ("NAME=value" entries) without the markers a package
// script run (npm run, pnpm run) adds: given npm_config_user_agent, grok
// 1.0.46 treats a script install as npm-managed and installs a second copy.
// npm configuration itself (such as the prefix) stays: npm-method updaters
// should honor it, and the version read-back catches an update that went to
// another prefix.
func UpdaterEnv(env []string) []string {
	kept := make([]string, 0, len(env))
	for _, entry := range env {
		name, _, _ := strings.Cut(entry, "=")
		if !scriptContext.MatchString(name) {
			kept = append(kept, entry)
		}
	}
	return kept
}

// ExecutableUpdate is "executable" (Installation, Installed: its release
// version) or "unavailable" (Check: why a check cannot start).
type ExecutableUpdate struct {
	Kind         string
	Installation oar.AvailableInstallation
	Installed    string
	Check        oar.UpdateCheck
}

// ExecutableUpdateOf is the executable and its installed release version, or why a check cannot start.
func ExecutableUpdateOf(installation oar.AvailableInstallation) ExecutableUpdate {
	if installation.Via != "executable" {
		return ExecutableUpdate{Kind: "unavailable", Check: oar.UpdateCheck{Kind: "unavailable", Reason: "unsupported_installation", Detail: "an in-process SDK; it moves with the package that carries it"}}
	}
	installed := ReleaseVersion(installation.Version)
	if installed == "" {
		return ExecutableUpdate{Kind: "unavailable", Check: oar.UpdateCheck{Kind: "unavailable", Reason: "version_unreadable", Detail: installation.Command + " --version gave no release version"}}
	}
	return ExecutableUpdate{Kind: "executable", Installation: installation, Installed: installed}
}

// InstalledPath is the executable's real path with / separators, for install-layout tests.
func InstalledPath(command string) string {
	if resolved, err := filepath.EvalSymlinks(command); err == nil {
		if absolute, err := filepath.Abs(resolved); err == nil {
			resolved = absolute
		}
		return strings.ReplaceAll(resolved, `\`, "/")
	}
	return strings.ReplaceAll(command, `\`, "/")
}

// headUTF16 is text.slice(0, units) in UTF-16 code units, never splitting a character.
func headUTF16(text string, units int) string {
	count := 0
	for index, r := range text {
		width := 1
		if r > 0xFFFF {
			width = 2
		}
		if count+width > units {
			return text[:index]
		}
		count += width
	}
	return text
}

// ComparedCheck is a check from an installed and a released version, when
// the runtime gives no verdict of its own. channel "" is none.
func ComparedCheck(installed, released, source, channel string) oar.UpdateCheck {
	latest := ReleaseVersion(released)
	if latest == "" {
		return oar.UpdateCheck{Kind: "unavailable", Reason: "version_unreadable", Detail: "no release version in " + jsonText(headUTF16(released, 80)), Source: source}
	}
	return oar.UpdateCheck{Kind: "ok", Installed: installed, Latest: latest, UpdateAvailable: latest != installed, Channel: channel, Source: source}
}

// ReadReleaseSource GETs one release source. A failure comes back as the
// check's lookup_failed (check non-nil), never as an error.
func ReadReleaseSource(ctx context.Context, url string, timeout time.Duration) (text string, check *oar.UpdateCheck) {
	failed := func(detail string) (string, *oar.UpdateCheck) {
		return "", &oar.UpdateCheck{Kind: "unavailable", Reason: "lookup_failed", Detail: detail, Source: url}
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return failed(err.Error())
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return failed("The operation was aborted due to timeout")
		}
		return failed(err.Error())
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return failed(fmt.Sprintf("HTTP %d", response.StatusCode))
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return failed(err.Error())
	}
	if !utf8.Valid(body) {
		body = []byte(strings.ToValidUTF8(string(body), "�"))
	}
	return string(body), nil
}

// RunCheckCommand runs one of the runtime's own check commands, read only,
// with the updater environment; JSON is its stdout parsed (nil when not JSON).
func RunCheckCommand(ctx context.Context, command string, args []string, timeout time.Duration) (result executable.IsolatedResult, json any) {
	result = executable.RunIsolated(ctx, command, args, UpdaterEnv(os.Environ()), timeout)
	json, _ = jsonx.Parse([]byte(result.Stdout))
	return result, json
}

func versionNow(ctx context.Context, command string) string {
	raw, err := executable.ReadVersion(ctx, command, versionTimeout, nil)
	if err != nil || raw == "" {
		return ""
	}
	return ReleaseVersion(raw)
}

// NativeUpdater is a runtime's own update mechanism.
type NativeUpdater struct {
	Check oar.UpdateChecker
	// The runtime's own non-interactive update command.
	Args []string
	// The environment to start from, before the script-context filter; the host's when nil.
	Env func() []string
}

// UpgradeExecutable reads the executable's version, checks, then runs the
// runtime's own updater on the same executable and judges the outcome by
// the version it reports afterwards. The updater runs only when the check
// does not already say the installation is current. The installation's own
// version is what its probe read, and the runtime may have updated itself
// since (claude's native install does in the background), so the check and
// the comparison start from what the executable says now.
func UpgradeExecutable(ctx context.Context, installation oar.AvailableInstallation, updater NativeUpdater, options oar.UpgradeOptions) (oar.UpgradeResult, error) {
	if installation.Via != "executable" {
		return oar.UpgradeResult{Kind: "unsupported", Reason: "unsupported_installation", Detail: "an in-process SDK; it moves with the package that carries it"}, nil
	}
	now := versionNow(ctx, installation.Command)
	current := installation
	if now != "" {
		current.Version = now
	}
	check, err := updater.Check(ctx, current, oar.UpdateCheckOptions{Timeout: options.Timeout})
	if err != nil {
		return oar.UpgradeResult{}, err
	}
	if check.Kind == "ok" && !check.UpdateAvailable {
		return oar.UpgradeResult{Kind: "current", Version: check.Installed, Check: &check}, nil
	}
	before := now
	if before == "" && check.Kind == "ok" {
		before = check.Installed
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = DefaultUpgradeTimeout
	}
	env := os.Environ()
	if updater.Env != nil {
		env = updater.Env()
	}
	run := executable.RunIsolated(ctx, installation.Command, updater.Args, UpdaterEnv(env), timeout)
	output := executable.IsolatedOutput(run, timeout, "updater")
	after := versionNow(ctx, installation.Command)
	if before != "" && after != "" && after != before {
		return oar.UpgradeResult{Kind: "upgraded", From: before, To: after, Output: &output}, nil
	}
	if run.ExitCode == nil || *run.ExitCode != 0 || after == "" {
		exitCode := oar.NullOf()
		if run.ExitCode != nil {
			exitCode = oar.IntOf(*run.ExitCode)
		}
		return oar.UpgradeResult{Kind: "failed", ExitCode: exitCode, Output: &output}, nil
	}
	return oar.UpgradeResult{Kind: "unchanged", Version: after, Output: &output}, nil
}

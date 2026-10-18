package shared

import (
	"context"
	"os"
	"path/filepath"
	goruntime "runtime"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/oar"
)

// DefaultInstallTimeout bounds every step of an install together when the caller gives none.
const DefaultInstallTimeout = 600 * time.Second

// ScriptInstallMethod is a vendor's documented `curl … | sh` installer for
// macOS and Linux. Every built-in one installs per user, under the home
// directory, into the layout the runtime's own updater recognizes.
type ScriptInstallMethod struct {
	// The vendor's page that documents the method: the plan's Source.
	Source string
	// The command line as the vendor documents it (with its own
	// non-interactive switch, if any), run by `sh -c`.
	Line string
	// The programs the line runs, which must be on PATH.
	Tools []string
	// The directories the installer writes, honoring the installer's own location variables.
	Writes func() []string
	// How the vendor installs on Windows, which oar does not run, as a
	// sentence for the platform detail.
	Windows string
}

// InstallDir is an installer's location variable when it is set and not empty, otherwise its default.
func InstallDir(variable, fallback string) string {
	if variable == "" {
		return fallback
	}
	return variable
}

// InstallHost is what a plan reads about this machine. Platform and Arch
// use Node's names (darwin, linux, win32; x64, arm64, ia32), as the plans'
// details do.
type InstallHost struct {
	Platform string
	Arch     string
	// The tool's path on PATH, or "".
	Locate func(tool string) string
	// The existing directory at or above dir that this user cannot write,
	// or "" when the installer could create dir.
	Unwritable func(dir string) string
}

func nearestExisting(dir string) string {
	current, err := filepath.Abs(dir)
	if err != nil {
		current = filepath.Clean(dir)
	}
	for !exists(current) {
		parent := filepath.Dir(current)
		if parent == current {
			return current
		}
		current = parent
	}
	return current
}

// UnwritableAncestor is the nearest existing directory at or above dir when
// this user cannot write it; "" when dir can be created or written.
func UnwritableAncestor(dir string) string {
	existing := nearestExisting(dir)
	if writable(existing) {
		return ""
	}
	return existing
}

// NodePlatform is process.platform for a GOOS.
func NodePlatform(goos string) string {
	if goos == "windows" {
		return "win32"
	}
	return goos
}

// NodeArch is process.arch for a GOARCH.
func NodeArch(goarch string) string {
	switch goarch {
	case "amd64":
		return "x64"
	case "386":
		return "ia32"
	}
	return goarch
}

// ThisMachine is the host oar runs on.
var ThisMachine = InstallHost{
	Platform:   NodePlatform(goruntime.GOOS),
	Arch:       NodeArch(goruntime.GOARCH),
	Locate:     executable.Resolve,
	Unwritable: UnwritableAncestor,
}

var (
	scriptPlatforms = map[string]bool{"darwin": true, "linux": true}
	scriptArches    = map[string]bool{"x64": true, "arm64": true}
)

// ScriptInstallPlanOn is the plan for a script installer on host: platform
// off macOS and Linux (the vendors' Windows installers are PowerShell
// scripts oar has not verified, so their command is only named),
// missing_tool when the line's programs are not on PATH,
// requires_privileges when a directory it writes is not this user's to
// write (an install location variable pointing at /usr/local, say), which
// the installer would otherwise discover midway. Those two still carry the
// plan's Steps and Source, for a person to run once they have the tool or
// the rights.
func ScriptInstallPlanOn(method ScriptInstallMethod, host InstallHost) oar.InstallPlan {
	steps := []oar.InstallStep{{Command: []string{"sh", "-c", method.Line}, Display: method.Line}}
	if !scriptPlatforms[host.Platform] {
		detail := "the installer supports macOS and Linux, not " + host.Platform
		if host.Platform == "win32" {
			detail = "oar runs this installer on macOS and Linux only. On Windows, " + method.Windows
		}
		return oar.InstallPlan{Kind: "unsupported", Reason: "platform", Detail: detail}
	}
	if !scriptArches[host.Arch] {
		return oar.InstallPlan{Kind: "unsupported", Reason: "platform", Detail: "the installer has no build for " + host.Arch}
	}
	for _, tool := range append([]string{"sh"}, method.Tools...) {
		if host.Locate(tool) == "" {
			return oar.InstallPlan{Kind: "unsupported", Reason: "missing_tool", Detail: tool, Steps: steps, Source: method.Source}
		}
	}
	if method.Writes != nil {
		for _, dir := range method.Writes() {
			if blocked := host.Unwritable(dir); blocked != "" {
				return oar.InstallPlan{Kind: "unsupported", Reason: "requires_privileges", Detail: "the installer writes " + dir + ", and " + blocked + " is not writable by this user", Steps: steps, Source: method.Source}
			}
		}
	}
	return oar.InstallPlan{Kind: "plan", Steps: steps, Source: method.Source}
}

// ScriptInstallPlan is the planner of a runtime with one release line: a
// line is refused, never ignored. host is usually ThisMachine.
func ScriptInstallPlan(method ScriptInstallMethod, host InstallHost) oar.InstallPlanner {
	return func(_ context.Context, options oar.InstallOptions) (oar.InstallPlan, error) {
		if options.Line != "" {
			return oar.InstallPlan{Kind: "unsupported", Reason: "unknown_line", Detail: "this runtime ships one release line; leave line " + jsonText(options.Line) + " out"}, nil
		}
		return ScriptInstallPlanOn(method, host), nil
	}
}

// LinedInstallMethods is a runtime's parallel release lines, each with its own script installer.
type LinedInstallMethods struct {
	Lines   []oar.InstallLine
	Methods map[string]ScriptInstallMethod
}

// LinedInstallPlan is the plan for the line options.Line names:
// line_required without one (oar does not choose a line for the person),
// unknown_line for a line the runtime does not ship.
func LinedInstallPlan(lined LinedInstallMethods, host InstallHost) oar.InstallPlanner {
	names := ""
	for index, entry := range lined.Lines {
		if index > 0 {
			names += ", "
		}
		names += entry.Line
	}
	return func(_ context.Context, options oar.InstallOptions) (oar.InstallPlan, error) {
		if options.Line == "" {
			return oar.InstallPlan{Kind: "unsupported", Reason: "line_required", Detail: "choose a release line: " + names}, nil
		}
		method, ok := lined.Methods[options.Line]
		if !ok {
			return oar.InstallPlan{Kind: "unsupported", Reason: "unknown_line", Detail: jsonText(options.Line) + " is not one of " + names}, nil
		}
		return ScriptInstallPlanOn(method, host), nil
	}
}

// UnsupportedInstallPlan is the planner of a runtime whose vendor offers
// nothing oar can run: its plan and its install give this answer.
func UnsupportedInstallPlan(unsupported oar.InstallPlan) oar.InstallPlanner {
	return func(context.Context, oar.InstallOptions) (oar.InstallPlan, error) {
		return unsupported, nil
	}
}

// runSteps runs the steps in order, without stdin or a terminal, stopping at
// the first that fails; one deadline bounds them all.
func runSteps(ctx context.Context, steps []oar.InstallStep, timeout time.Duration) (exitCode *int, output string) {
	deadline := time.Now().Add(timeout)
	zero := 0
	exitCode = &zero
	for _, step := range steps {
		if len(step.Command) == 0 {
			continue
		}
		remaining := max(time.Until(deadline), time.Millisecond)
		run := executable.RunIsolated(ctx, step.Command[0], step.Command[1:], UpdaterEnv(os.Environ()), remaining)
		output += executable.IsolatedOutput(run, timeout, "installer")
		exitCode = run.ExitCode
		if run.TimedOut || exitCode == nil || *exitCode != 0 {
			break
		}
	}
	return exitCode, output
}

// InstallLineOf names the release line an installation belongs to, read
// from its version; "" when it does not tell.
type InstallLineOf func(installation oar.AvailableInstallation) string

// PlanInstaller is an installer from the runtime's installation probe and
// its plan. The probe decides both ends: an installation it already finds
// means nothing runs (already_installed, whichever line was asked for, so a
// copy of one line is never replaced by another), and after the plan's
// steps ran, only an available installation it finds is installed,
// whatever the installer exited with: what the probe finds is what a
// session would run, and a copy the installer put where the probe does not
// look is a probe to fix. lineOf (may be nil) names the line of what the
// probe found, for a runtime with lines.
func PlanInstaller(probe oar.InstallationProbe, plan oar.InstallPlanner, lineOf InstallLineOf) oar.Installer {
	line := func(installation oar.AvailableInstallation) string {
		if lineOf == nil {
			return ""
		}
		return lineOf(installation)
	}
	return func(ctx context.Context, options oar.InstallOptions) (oar.InstallResult, error) {
		before, err := probe(ctx, oar.InstallationOptions{})
		if err != nil {
			return oar.InstallResult{}, err
		}
		if before.Kind == "available" {
			return oar.InstallResult{Kind: "already_installed", Installation: before.Available, Line: line(before.Available)}, nil
		}
		planned, err := plan(ctx, options)
		if err != nil {
			return oar.InstallResult{}, err
		}
		if planned.Kind == "unsupported" {
			return oar.InstallResult{Kind: "unsupported", Unsupported: planned}, nil
		}
		timeout := options.Timeout
		if timeout <= 0 {
			timeout = DefaultInstallTimeout
		}
		exitCode, output := runSteps(ctx, planned.Steps, timeout)
		after, err := probe(ctx, oar.InstallationOptions{})
		note := ""
		if err != nil {
			note = "\n[oar: the installation probe after the installer failed: " + err.Error() + "]\n"
		} else if after.Kind == "available" {
			return oar.InstallResult{Kind: "installed", Installation: after.Available, Line: line(after.Available), Output: output}, nil
		}
		return oar.InstallResult{Kind: "failed", ExitCode: exitCode, Output: output + note}, nil
	}
}

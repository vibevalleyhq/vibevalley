package opencode

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// Runner runs a one-shot command (TS ExecutableRunner): the seam the
// prompt-config and release-line readers take their native queries through.
type Runner func(ctx context.Context, command string, args []string, options executable.RunOptions) executable.Result

// runExecutable is the runner the package's readers use (tests replace it,
// as the TS tests mock runExecutable).
var runExecutable Runner = executable.Run

var releaseLine = regexp.MustCompile(`^(?:opencode\s+)?v?([12])\.\d+\.\d+(?:\S*)$`)

func failureOf(context string, result executable.Result) error {
	if result.Diagnostics != nil {
		return executable.ProcessFailure(context, *result.Diagnostics)
	}
	return executable.ProcessFailure(context, executable.Diagnostics{ExitCode: result.ExitCode, Stderr: result.Stderr})
}

// Major is the installation's release line, 1 or 2: the two independently
// maintained native lines share one command name (version.ts). An
// installation without a version is probed (`--version`), in the session's
// cwd and environment when options is given; an unknown line is an error,
// never a fallback to v1.
func Major(ctx context.Context, installation oar.AvailableInstallation, options *oar.SessionOptions) (int, error) {
	version := installation.Version
	if version == "" {
		runOptions := executable.RunOptions{Timeout: 15 * time.Second}
		if options != nil {
			runOptions.Dir = options.Cwd
			runOptions.Env = shared.Environment(options.Env)
		}
		result := runExecutable(ctx, installation.Command, []string{"--version"}, runOptions)
		if !result.OK {
			return 0, failureOf("Failed to identify the opencode release line", result)
		}
		version = strings.TrimSpace(result.Stdout)
	}
	if match := releaseLine.FindStringSubmatch(strings.TrimSpace(version)); match != nil {
		if match[1] == "1" {
			return 1, nil
		}
		return 2, nil
	}
	return 0, errors.New("Unrecognized opencode release line: " + jsonText(version))
}

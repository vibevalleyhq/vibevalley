package shared

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/oar"
)

// An entry with a path separator is a pinned path: it must exist as given and
// never silently falls back to a different binary. A bare name resolves on PATH.

// ExecutableInstallationOptions tunes an executable probe; zero values are
// the readers' own defaults.
type ExecutableInstallationOptions struct {
	ReadinessTimeout time.Duration
	VersionTimeout   time.Duration
	// For executables whose --version does not lead with the version.
	ReadVersion executable.VersionReader
}

// Fallbacks is a fixed fallback list, for ExecutableInstallation.
func Fallbacks(entries ...string) func() []string {
	return func() []string { return entries }
}

func isPinnedPath(entry string) bool {
	return strings.ContainsAny(entry, `/\`)
}

func exists(file string) bool {
	_, err := os.Stat(file)
	return err == nil
}

// LocateExecutable finds an installation entry without spawning anything: a
// pinned path must exist as given, a bare name resolves on PATH (and PATHEXT
// on Windows). "" when it is not there.
func LocateExecutable(entry string) string {
	if isPinnedPath(entry) {
		if exists(entry) {
			return entry
		}
		return ""
	}
	return executable.Resolve(entry)
}

// LocatedExecutable is an executable found for an entry, and the copies on
// PATH it shadows (none for a pinned path).
type LocatedExecutable struct {
	Command  string
	Shadowed []string
}

// LocateOnPath is a bare command on PATH, like `which -a`: the copy that
// runs and the ones after it. nil when there is none.
func LocateOnPath(name string) *LocatedExecutable {
	matches := executable.ResolveAll(name)
	if len(matches) == 0 {
		return nil
	}
	return &LocatedExecutable{Command: matches[0], Shadowed: ShadowedCopies(matches)}
}

func realPath(file string) string {
	if resolved, err := filepath.EvalSymlinks(file); err == nil {
		if absolute, err := filepath.Abs(resolved); err == nil {
			return absolute
		}
		return resolved
	}
	if absolute, err := filepath.Abs(file); err == nil {
		return absolute
	}
	return file
}

// ShadowedCopies is the copies PATH lists after the first of matches (which
// runs), in PATH order, each once and as PATH spells it. Paths that resolve
// to one file are one copy: a folder listed twice, /bin and /usr/bin on
// merged-usr Linux, a symlink to the running copy. A folder holds one copy,
// the first match there: Windows runs the first PATHEXT extension it finds,
// and the other launchers beside it (npm writes codex.cmd and codex.ps1
// together) are the same installation.
func ShadowedCopies(matches []string) []string {
	folders := map[string]bool{}
	files := map[string]bool{}
	shadowed := []string{}
	for _, match := range matches {
		folder := realPath(filepath.Dir(match))
		if folders[folder] {
			continue
		}
		folders[folder] = true
		file := realPath(match)
		if files[file] {
			continue
		}
		if len(files) > 0 {
			shadowed = append(shadowed, match)
		}
		files[file] = true
	}
	return shadowed
}

func locateCandidate(entry string) *LocatedExecutable {
	if isPinnedPath(entry) {
		if exists(entry) {
			return &LocatedExecutable{Command: entry}
		}
		return nil
	}
	return LocateOnPath(entry)
}

func versionSnapshot(ctx context.Context, located LocatedExecutable, options ExecutableInstallationOptions) (oar.InstallationSnapshot, error) {
	version, err := executable.ReadVersion(ctx, located.Command, options.VersionTimeout, options.ReadVersion)
	if err != nil {
		return oar.InstallationSnapshot{}, err
	}
	installation := oar.AvailableInstallation{Via: "executable", Command: located.Command, Version: version}
	if len(located.Shadowed) > 0 {
		installation.Shadowed = located.Shadowed
	}
	return oar.Available(installation), nil
}

// ExecutableInstallation is an installation probed from an executable: the
// env var pins one candidate exclusively; otherwise the command name and
// fallbacks (evaluated at probe time; nil for none) are tried in order and
// the first usable candidate wins. When readiness args are given (non-nil),
// a candidate must run them successfully or the probe moves on to the next
// one. The copies a winner found on PATH shadows are reported, never for a
// pinned env var. A readiness or version run that never ran to an exit code
// of its own (a spawn failure, a timeout) is an error.
func ExecutableInstallation(envVar, command string, fallbacks func() []string, readiness []string, options ExecutableInstallationOptions) oar.InstallationProbe {
	return func(ctx context.Context, request oar.InstallationOptions) (oar.InstallationSnapshot, error) {
		var found []LocatedExecutable
		pinned := os.Getenv(envVar)
		if request.Binary != nil {
			pinned = strings.TrimSpace(*request.Binary)
		}
		if pinned != "" {
			if located := LocateExecutable(pinned); located != "" {
				found = append(found, LocatedExecutable{Command: located})
			}
		} else {
			entries := []string{command}
			if fallbacks != nil {
				entries = append(entries, fallbacks()...)
			}
			for _, entry := range entries {
				candidate := locateCandidate(entry)
				if candidate == nil {
					continue
				}
				duplicate := false
				for _, other := range found {
					if other.Command == candidate.Command {
						duplicate = true
						break
					}
				}
				if !duplicate {
					found = append(found, *candidate)
				}
			}
		}
		if len(found) == 0 {
			return oar.InstallationSnapshot{Kind: "not_found"}, nil
		}
		if readiness == nil {
			return versionSnapshot(ctx, found[0], options)
		}
		for _, candidate := range found {
			result := executable.Run(ctx, candidate.Command, readiness, executable.RunOptions{Timeout: options.ReadinessTimeout})
			if err := executable.AssertRan(result, "Failed to run "+candidate.Command+" "+strings.Join(readiness, " ")); err != nil {
				return oar.InstallationSnapshot{}, err
			}
			if result.OK {
				return versionSnapshot(ctx, candidate, options)
			}
		}
		return oar.InstallationSnapshot{Kind: "unsupported", Reason: strings.Join(readiness, " ") + " failed"}, nil
	}
}

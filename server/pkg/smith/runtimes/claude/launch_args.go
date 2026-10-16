package claude

import (
	"strings"

	"vibevalley/pkg/smith/oar"
)

// managedLaunchArgs are the claude flags OAR sets itself, which a host's
// launchArgs would contradict (#336, launch-args.ts): with --continue claude
// exits next to OAR's --session-id; after --fork-session claude runs under a
// new id while Session.ID keeps the old one; --dangerously-skip-permissions
// overrides --permission-mode. Each maps to the reason the open is refused.
// A short alias is checked as a whole argument, a long flag also in its
// --flag=value form.
var managedLaunchArgs = map[string]string{
	"--continue":        "OAR assigns the session id; use SessionOptions.resume with the id to continue",
	"-c":                "OAR assigns the session id; use SessionOptions.resume with the id to continue",
	"--resume":          "use SessionOptions.resume",
	"-r":                "use SessionOptions.resume",
	"--session-id":      "OAR assigns the session id",
	"--fork-session":    "a fork runs under a new native id that Session.id would not report",
	"--permission-mode": "OAR runs claude with --dangerously-skip-permissions, which overrides it",
	"--print":           "OAR drives claude in print mode over stream-json already",
	"-p":                "OAR drives claude in print mode over stream-json already",
	"--input-format":    "OAR drives claude over stream-json",
	"--output-format":   "OAR drives claude over stream-json",
	"--json-schema":     "use SessionOptions.outputSchema",
}

// refuseManagedLaunchArgs refuses, before claude starts, a launchArgs entry
// that collides with a flag OAR manages.
func refuseManagedLaunchArgs(launchArgs []string) error {
	for _, arg := range launchArgs {
		flag := arg
		if strings.HasPrefix(arg, "--") {
			flag, _, _ = strings.Cut(arg, "=")
		}
		if reason, ok := managedLaunchArgs[flag]; ok {
			return &oar.UnsupportedOptionError{Option: "launchArgs", Message: "claude launchArgs cannot include " + flag + ": " + reason}
		}
	}
	return nil
}

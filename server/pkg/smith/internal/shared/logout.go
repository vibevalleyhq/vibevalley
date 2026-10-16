package shared

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/oar"
)

// Mechanisms every logout driver shares: running the runtime's own logout
// command as a login runs (its own process group, nothing it prints
// forwarded), and the rule that the runtime's status query decides
// (shared/logout.ts).

// NativeLogout is how the runtime's own logout ended, before its status is
// read: "done" (an exit 0, a call that resolved) or "failed" (Reason
// "timed_out", "rejected" or "process_failed", and Detail): it ran, but
// failed or did not finish; reported as it is unless the status reads logged out.
type NativeLogout struct {
	Kind   string
	Reason string
	Detail string
}

// LogoutCommandEnd is "exit" (ExitCode, Signal, Stderr: its last lines,
// escapes stripped, where a logout command reports a failure), "timed_out",
// or "not_started" (Detail: the command could not start, so nothing ran and
// no status is read).
type LogoutCommandEnd struct {
	Kind     string
	ExitCode *int
	Signal   string
	Stderr   []string
	Detail   string
}

const keptLines = 20

// RunLogoutCommand runs a logout command with its stdin closed, in its own
// process group on POSIX; nothing it prints is logged or forwarded. Past
// timeout it is stopped with everything it started (its group, its tree on
// Windows). env is the whole environment (nil: the host's).
//
// Go: it runs through executable.Run, which reads stderr whole and bounds
// it at 2 MiB; the last 20 non-blank lines are kept as TS keeps them. A
// cancelled ctx stops the command as the deadline does and also reports
// timed_out (TS takes no abort signal here).
func RunLogoutCommand(ctx context.Context, command string, args []string, env []string, timeout time.Duration) LogoutCommandEnd {
	result := executable.Run(ctx, command, args, executable.RunOptions{Env: env, Timeout: timeout})
	diagnostics := result.Diagnostics
	if diagnostics != nil && diagnostics.Timeout > 0 {
		return LogoutCommandEnd{Kind: "timed_out"}
	}
	if ctx.Err() != nil && result.ExitCode == nil {
		return LogoutCommandEnd{Kind: "timed_out"}
	}
	if diagnostics != nil && result.ExitCode == nil && diagnostics.Signal == "" && strings.HasPrefix(diagnostics.Error, "spawn ") {
		return LogoutCommandEnd{Kind: "not_started", Detail: (&LoginSecrets{}).Line(diagnostics.Error)}
	}
	var stderr []string
	for _, raw := range lineBreaks.Split(result.Stderr, -1) {
		if line := jsTrim(StripTerminalEscapes(raw)); line != "" {
			stderr = append(stderr, line)
		}
	}
	if len(stderr) > keptLines {
		stderr = stderr[len(stderr)-keptLines:]
	}
	if stderr == nil {
		stderr = []string{}
	}
	end := LogoutCommandEnd{Kind: "exit", ExitCode: result.ExitCode, Stderr: stderr}
	if diagnostics != nil {
		end.Signal = diagnostics.Signal
	}
	return end
}

// LogoutTimedOut is a logout that did not finish within the deadline.
func LogoutTimedOut(command string, timeout time.Duration) NativeLogout {
	return NativeLogout{Kind: "failed", Reason: "timed_out", Detail: fmt.Sprintf("%s did not finish within %d ms", command, timeout.Milliseconds())}
}

// CommandLogout reads a logout command's end ("exit" or "timed_out"): exit
// 0 is the runtime's success. Exit 1 with a stderr line is its reported
// failure, in its words (the first capture of failure when a line matches
// it, else its last stderr line); any other end is process_failed. failure
// may be nil.
func CommandLogout(end LogoutCommandEnd, command string, timeout time.Duration, failure *regexp.Regexp) NativeLogout {
	if end.Kind == "timed_out" {
		return LogoutTimedOut(command, timeout)
	}
	if end.ExitCode != nil && *end.ExitCode == 0 {
		return NativeLogout{Kind: "done"}
	}
	secrets := &LoginSecrets{}
	words, found := "", false
	if failure != nil {
		for index := len(end.Stderr) - 1; index >= 0 && !found; index-- {
			match := failure.FindStringSubmatchIndex(end.Stderr[index])
			if len(match) >= 4 && match[2] >= 0 {
				words, found = end.Stderr[index][match[2]:match[3]], true
			}
		}
	}
	if !found && len(end.Stderr) > 0 {
		words, found = end.Stderr[len(end.Stderr)-1], true
	}
	if end.ExitCode != nil && *end.ExitCode == 1 && found {
		return NativeLogout{Kind: "failed", Reason: "rejected", Detail: secrets.Line(words)}
	}
	if found {
		return NativeLogout{Kind: "failed", Reason: "process_failed", Detail: secrets.Line(words)}
	}
	how := ""
	if end.ExitCode == nil {
		signal := end.Signal
		if signal == "" {
			signal = "unknown"
		}
		how = "signal " + signal
	} else {
		how = fmt.Sprintf("code %d", *end.ExitCode)
	}
	return NativeLogout{Kind: "failed", Reason: "process_failed", Detail: command + " exited with " + how}
}

// readsAs is what a logged-in status names: the method and the email, then
// notes (claude's API key source).
func readsAs(status oar.AuthStatus, notes []string) string {
	var words []string
	if status.Account != nil {
		for _, word := range []string{status.Account.Method, status.Account.Email} {
			if word != "" {
				words = append(words, word)
			}
		}
	}
	words = append(words, notes...)
	if len(words) == 0 {
		return ""
	}
	return " (" + strings.Join(words, ", ") + ")"
}

// ConfirmedLogout decides a logout by the status read after the runtime's
// logout ran: logged out is logged_out, whatever the logout answered.
// Otherwise a failed logout is its own failure, and one that succeeded is
// still_logged_in when the status reads logged in (credentials from the
// environment or another source), never logged_out. When the status cannot
// tell (it failed or gave an answer oar cannot read), a logout that
// succeeded is logged_out on the runtime's own report, as a login's success
// is logged_in.
func ConfirmedLogout(native NativeLogout, status oar.AuthStatus, command string, notes []string) oar.LogoutResult {
	if status.Kind == "logged_out" {
		return oar.LogoutResult{Kind: "logged_out"}
	}
	if native.Kind == "failed" {
		return oar.LogoutResult{Kind: "failed", Reason: native.Reason, Detail: native.Detail}
	}
	if status.Kind == "unknown" {
		return oar.LogoutResult{Kind: "logged_out"}
	}
	return oar.LogoutResult{
		Kind:   "failed",
		Reason: "still_logged_in",
		Detail: (&LoginSecrets{}).Redact(command + " succeeded, yet " + status.Source + " still reads logged in" + readsAs(status, notes)),
	}
}

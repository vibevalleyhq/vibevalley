package claude

import (
	"context"
	"regexp"
	"time"

	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// `claude auth logout` (2.1.292, logout.ts): it revokes the stored claude.ai
// OAuth refresh token (best effort), then deletes the stored credentials
// (~/.claude/.credentials.json, the macOS Keychain) and the account in
// ~/.claude.json. It prints `Successfully logged out from your Anthropic
// account.` and exits 0, also when nothing was stored; a failure is
// `Logout failed: <message>` on stderr with exit 1. Credentials from the
// environment (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN) are not its to
// remove: the status still reads logged in with them. `auth logout`
// arrived in 2.1.41, with `auth login` and `auth status`.
const (
	logoutFloor   = "2.1.41"
	logoutCommand = "claude auth logout"
	// The revoke has 5 s; telemetry is flushed before and after.
	logoutTimeout = 60 * time.Second
)

var logoutFailure = regexp.MustCompile(`^Logout failed:\s*(.*)$`)

// Logout signs claude out with `claude auth logout`; `claude auth status --json` decides.
func Logout(ctx context.Context, installation oar.AvailableInstallation, options oar.LogoutOptions) (oar.LogoutResult, error) {
	target := shared.LoginExecutableOf(installation, "claude", logoutFloor)
	if target.Kind == "settled" {
		return target.Result.LogoutResult(), nil
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = logoutTimeout
	}
	end := shared.RunLogoutCommand(ctx, target.Installation.Command, []string{"auth", "logout"}, claudeEnv(), timeout)
	if end.Kind == "not_started" {
		return oar.LogoutResult{Kind: "failed", Reason: "process_failed", Detail: end.Detail}, nil
	}
	native := shared.CommandLogout(end, logoutCommand, timeout, logoutFailure)
	read := readClaudeAuthStatus(context.WithoutCancel(ctx), installation, oar.AuthStatusOptions{})
	var notes []string
	if read.APIKeySource != "" {
		notes = []string{"from " + read.APIKeySource}
	}
	return shared.ConfirmedLogout(native, read.Status, logoutCommand, notes), nil
}

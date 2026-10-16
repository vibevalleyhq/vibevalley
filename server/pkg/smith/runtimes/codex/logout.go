package codex

import (
	"context"
	"os"
	"time"

	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// `codex logout` (0.160.1, read in openai/codex `rust-v0.160.1`:
// `cli/src/login.rs` `run_logout`, `login/src/auth/manager.rs`
// `logout_with_revoke`, `login/src/auth/revoke.rs`; logout.ts): it revokes a
// stored ChatGPT login's refresh token (or its access token) at
// `https://auth.openai.com/oauth/revoke`, 10 s and best effort (a failed
// revoke is logged and the local logout goes on; since 0.122.0), then
// deletes the credential store, `$CODEX_HOME/auth.json` and the keyring
// entry. A stored API key is only deleted. It prints to stderr and exits 0
// with `Successfully logged out`, or `Not logged in` when nothing was
// stored; a failure is `Error logging out: <error>` (or an unreadable
// configuration's error) with exit 1. `OPENAI_API_KEY` and `CODEX_API_KEY`
// are untouched; `codex login status` does not read them either. `codex
// logout` arrived in 0.15.0.
const (
	logoutFloor   = "0.15.0"
	logoutCommand = "codex logout"
	// The revoke has 10 s.
	logoutTimeout = 60 * time.Second
)

// Logout signs codex out with `codex logout`; `codex login status` decides (codexLogout).
func Logout(ctx context.Context, installation oar.AvailableInstallation, options oar.LogoutOptions) (oar.LogoutResult, error) {
	target := shared.LoginExecutableOf(installation, "codex", logoutFloor)
	if target.Kind == "settled" {
		return target.Result.LogoutResult(), nil
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = logoutTimeout
	}
	end := shared.RunLogoutCommand(ctx, target.Installation.Command, []string{"logout"}, os.Environ(), timeout)
	if end.Kind == "not_started" {
		return oar.LogoutResult{Kind: "failed", Reason: "process_failed", Detail: end.Detail}, nil
	}
	native := shared.CommandLogout(end, logoutCommand, timeout, nil)
	status, _ := AuthStatus(context.WithoutCancel(ctx), installation, oar.AuthStatusOptions{})
	return shared.ConfirmedLogout(native, status, logoutCommand, nil), nil
}

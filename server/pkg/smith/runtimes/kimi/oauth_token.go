package kimi

import (
	"os"

	"vibevalley/pkg/smith/internal/jsonx"
)

// ReauthError says the stored credential is unusable; the account needs `kimi` re-auth.
type ReauthError struct{ Message string }

func (e *ReauthError) Error() string { return e.Message }

// StoredAccessToken reads kimi's stored OAuth access token as-is. The
// credential store belongs to the Kimi CLI, so OAR never refreshes or
// rewrites it; a stale token surfaces as the usage endpoint's 401/403,
// which callers map to reauth_required.
func StoredAccessToken(auth AuthContext) (string, error) {
	data, err := os.ReadFile(auth.CredentialPath)
	if err == nil {
		if token := text(jsonx.ParseRecord(data)["access_token"]); token != "" {
			return token, nil
		}
	}
	return "", &ReauthError{Message: "No Kimi OAuth token is stored"}
}

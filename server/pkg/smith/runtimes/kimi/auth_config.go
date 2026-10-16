package kimi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
)

const (
	managedProvider = "managed:kimi-code"
	defaultBaseURL  = "https://api.kimi.com/coding/v1"
	defaultOAuth    = "https://auth.kimi.com"
	defaultOAuthKey = "oauth/kimi-code"
)

// AuthContext is kimi's own managed provider, environment and credential slot.
type AuthContext struct {
	BaseURL   string
	OAuthHost string
	// "file" | "other"
	Storage        string
	StorageName    string
	Home           string
	CredentialPath string
}

func text(value any) string {
	if s, ok := value.(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

var trailingSlashes = regexp.MustCompile(`/+$`)

func normalizedEndpoint(value string) string {
	return trailingSlashes.ReplaceAllString(strings.TrimSpace(value), "")
}

func oauthKey(oauthHost, baseURL string) string {
	host, base := normalizedEndpoint(oauthHost), normalizedEndpoint(baseURL)
	if host == defaultOAuth && base == defaultBaseURL {
		return defaultOAuthKey
	}
	// JSON.stringify({oauthHost, baseUrl}), in that key order.
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(struct {
		OAuthHost string `json:"oauthHost"`
		BaseURL   string `json:"baseUrl"`
	}{host, base})
	digest := sha256.Sum256(bytes.TrimSuffix(buffer.Bytes(), []byte("\n")))
	return "oauth/kimi-code-env-" + hex.EncodeToString(digest[:])[:16]
}

func storageName(key string) (string, error) {
	candidate := strings.TrimPrefix(key, "oauth/")
	if candidate == "" || strings.HasPrefix(candidate, ".") || filepath.Base(candidate) != candidate || strings.ContainsAny(candidate, `/\`) {
		return "", errors.New("Kimi returned an invalid OAuth credential key")
	}
	return candidate, nil
}

// usageName names the account-usage read in deadline errors.
const usageName = "Kimi account usage"

func envText(names ...string) string {
	for _, name := range names {
		if value, ok := os.LookupEnv(name); ok {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func remainingMs(deadline time.Time) (time.Duration, error) {
	remaining, err := shared.Remaining(deadline, usageName)
	if err != nil {
		return 0, err
	}
	// Whole milliseconds, rounded up (the runner takes whole milliseconds).
	return (remaining + time.Millisecond - 1).Truncate(time.Millisecond), nil
}

// ResolveAuth resolves kimi's own managed provider, environment and
// credential slot through `kimi provider list --json` (its public JSON
// command, so OAR reads the resolved TOML without a TOML dialect of its
// own). nil when kimi answers without one; a run that timed out or never
// ran is an error.
func ResolveAuth(ctx context.Context, command string, deadline time.Time) (*AuthContext, error) {
	timeout, err := remainingMs(deadline)
	if err != nil {
		return nil, err
	}
	result := runExecutable(ctx, command, []string{"provider", "list", "--json"}, executable.RunOptions{Timeout: timeout})
	if err := executable.AssertRan(result, "Failed to run "+command+" provider list --json"); err != nil {
		return nil, err
	}
	if !result.OK {
		return nil, nil
	}
	root := jsonx.ParseRecord([]byte(result.Stdout))
	provider := jsonx.AsRecord(jsonx.Get(root, "providers", managedProvider))
	if provider == nil || provider["type"] != "kimi" {
		return nil, nil
	}
	configuredOAuth := jsonx.AsRecord(provider["oauth"])
	// KIMI_CODE_OAUTH_HOST ?? KIMI_OAUTH_HOST: the first one set, even when blank.
	envBaseURL := envText("KIMI_CODE_BASE_URL")
	envOAuthHost := envText("KIMI_CODE_OAUTH_HOST", "KIMI_OAUTH_HOST")
	override := envBaseURL != "" || envOAuthHost != ""
	baseURL := firstText(envBaseURL, text(provider["baseUrl"]), defaultBaseURL)
	oauthHost := firstText(envOAuthHost, text(configuredOAuth["oauthHost"]), defaultOAuth)
	baseURL, oauthHost = normalizedEndpoint(baseURL), normalizedEndpoint(oauthHost)
	expectedKey := oauthKey(oauthHost, baseURL)
	configuredKey := text(configuredOAuth["key"])
	selectedKey := expectedKey
	storage := "file"
	if !override && configuredKey == expectedKey {
		selectedKey = configuredKey
		if configured := text(configuredOAuth["storage"]); configured != "" && configured != "file" {
			storage = "other"
		}
	}
	home := envText("KIMI_CODE_HOME")
	if home == "" {
		userHome, _ := os.UserHomeDir()
		home = filepath.Join(userHome, ".kimi-code")
	}
	name, err := storageName(selectedKey)
	if err != nil {
		return nil, err
	}
	return &AuthContext{BaseURL: baseURL, OAuthHost: oauthHost, Storage: storage, StorageName: name, Home: home, CredentialPath: filepath.Join(home, "credentials", name+".json")}, nil
}

func firstText(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// runExecutable runs a one-shot command; tests replace it (TS: vi.mock of runExecutable).
var runExecutable = executable.Run

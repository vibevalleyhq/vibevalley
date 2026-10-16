package kimi

// Ported from tests/kimi/kimi-account-usage-reader.test.ts. TS mocks
// runExecutable and stubs fetch; here the package's runner seam
// (runExecutable) and the HTTP client's transport are replaced.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/oar"
)

var defaultProviderList = map[string]any{
	"providers": map[string]any{
		"managed:kimi-code": map[string]any{
			"type":    "kimi",
			"baseUrl": "https://api.kimi.com/coding/v1",
			"oauth":   map[string]any{"storage": "file", "key": "oauth/kimi-code"},
		},
	},
}

var kimiInstallation = oar.AvailableInstallation{Via: "executable", Command: "kimi", Version: "0.38.0"}

func temporaryKimiHome(t *testing.T) string {
	home := t.TempDir()
	t.Setenv("KIMI_CODE_HOME", home)
	return home
}

func writeToken(t *testing.T, home string, expiresAt int64) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(home, "credentials"), 0o700); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]any{
		"access_token": "old-access", "refresh_token": "old-refresh", "expires_at": expiresAt,
		"expires_in": 3600, "scope": "openid", "token_type": "Bearer",
	})
	if err := os.WriteFile(filepath.Join(home, "credentials", "kimi-code.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// runner is the shape of the package's runner seam.
type runner = func(ctx context.Context, command string, args []string, options executable.RunOptions) executable.Result

// useRunner replaces the package's runner for this test.
func useRunner(t *testing.T, run runner) {
	previous := runExecutable
	runExecutable = run
	t.Cleanup(func() { runExecutable = previous })
}

func mockDefaultProviderList(t *testing.T) {
	useRunner(t, func(_ context.Context, command string, args []string, options executable.RunOptions) executable.Result {
		if command != "kimi" || strings.Join(args, " ") != "provider list --json" || options.Timeout <= 0 {
			t.Errorf("ran %q %q with timeout %v", command, args, options.Timeout)
		}
		stdout, _ := json.Marshal(defaultProviderList)
		zero := 0
		return executable.Result{OK: true, Stdout: string(stdout), ExitCode: &zero}
	})
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

type fetches struct {
	mu   sync.Mutex
	urls []string
}

func (f *fetches) list() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.urls...)
}

// stubFetch answers every request with answer, recording its URL.
func stubFetch(t *testing.T, answer func(*http.Request) (int, string)) *fetches {
	calls := &fetches{}
	previous := httpClient
	httpClient = &http.Client{Transport: roundTrip(func(request *http.Request) (*http.Response, error) {
		calls.mu.Lock()
		calls.urls = append(calls.urls, request.URL.String())
		calls.mu.Unlock()
		status, body := answer(request)
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}, Request: request}, nil
	})}
	t.Cleanup(func() { httpClient = previous })
	return calls
}

func jsonBody(value any) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func TestReaderFollowsTheCLIsResolvedProviderAndStoredToken(t *testing.T) {
	home := temporaryKimiHome(t)
	writeToken(t, home, time.Now().Unix()+3600)
	mockDefaultProviderList(t)
	calls := stubFetch(t, func(request *http.Request) (int, string) {
		if got := request.Header.Get("Authorization"); got != "Bearer old-access" {
			t.Errorf("authorization %q", got)
		}
		if request.URL.String() == "https://api.kimi.com/coding/v1/me" {
			return 200, jsonBody(map[string]any{"user_id": "user-1", "email": "person@example.com", "user_level_name": "Vivace"})
		}
		return 200, jsonBody(map[string]any{"usage": map[string]any{"used": "25", "limit": "100", "resetTime": "2030-01-01T00:00:00Z"}})
	})
	snapshot, err := AccountUsage(context.Background(), kimiInstallation, oar.AccountUsageReadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Kind != "available" || snapshot.Email != "person@example.com" || snapshot.Plan != "Vivace" || snapshot.RateLimited ||
		len(snapshot.Windows) != 1 || snapshot.Windows[0].Label != "Weekly limit" || snapshot.Windows[0].UsedRatio != 0.25 {
		t.Fatalf("%+v", snapshot)
	}
	// TS issues the usage request, then the identity request, as Promise.all
	// starts them; Go runs both concurrently, so only the set is fixed.
	urls := calls.list()
	slices.Sort(urls)
	if strings.Join(urls, " ") != "https://api.kimi.com/coding/v1/me https://api.kimi.com/coding/v1/usages" {
		t.Fatalf("%q", urls)
	}
}

func TestReaderIdentifiesAPhoneSignInAccountByNicknameWhenMeHasNoEmail(t *testing.T) {
	home := temporaryKimiHome(t)
	writeToken(t, home, time.Now().Unix()+3600)
	mockDefaultProviderList(t)
	// Shape of a real CN phone sign-in profile: no email field at all.
	stubFetch(t, func(request *http.Request) (int, string) {
		if strings.HasSuffix(request.URL.String(), "/me") {
			return 200, jsonBody(map[string]any{"user_id": "user-1", "nickname": "登月者8387", "phone": map[string]any{"country_code": "86", "number": "156****8387"}, "user_level_name": "Max"})
		}
		return 200, jsonBody(map[string]any{"usage": map[string]any{"used": "25", "limit": "100"}})
	})
	snapshot, err := AccountUsage(context.Background(), kimiInstallation, oar.AccountUsageReadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Kind != "available" || snapshot.Plan != "Max" || snapshot.DisplayName != "登月者8387" || snapshot.Email != "" {
		t.Fatalf("%+v", snapshot)
	}
	encoded, _ := json.Marshal(snapshot)
	if strings.Contains(string(encoded), `"email"`) {
		t.Fatal(string(encoded))
	}
}

func TestReaderKeepsUsageWhenTheOptionalIdentityEndpointFails(t *testing.T) {
	home := temporaryKimiHome(t)
	writeToken(t, home, time.Now().Unix()+3600)
	mockDefaultProviderList(t)
	stubFetch(t, func(request *http.Request) (int, string) {
		if strings.HasSuffix(request.URL.String(), "/me") {
			return 503, "unavailable"
		}
		return 200, jsonBody(map[string]any{"usage": map[string]any{"used": "25", "limit": "100"}})
	})
	snapshot, err := AccountUsage(context.Background(), kimiInstallation, oar.AccountUsageReadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, snapshot, map[string]any{"kind": "available", "rateLimited": false, "windows": []any{map[string]any{"label": "Weekly limit", "usedRatio": 0.25}}})
}

func TestAuthResolutionScopesEnvironmentOverridesToTheirOwnCredential(t *testing.T) {
	home := temporaryKimiHome(t)
	t.Setenv("KIMI_CODE_BASE_URL", "https://api.example.test/coding/v1/")
	t.Setenv("KIMI_CODE_OAUTH_HOST", "https://auth.example.test/")
	mockDefaultProviderList(t)
	auth, err := ResolveAuth(context.Background(), "kimi", time.Now().Add(5*time.Second))
	if err != nil || auth == nil {
		t.Fatalf("%v %v", auth, err)
	}
	if auth.BaseURL != "https://api.example.test/coding/v1" || auth.OAuthHost != "https://auth.example.test" || auth.Storage != "file" || auth.Home != home {
		t.Fatalf("%+v", auth)
	}
	if !regexp.MustCompile(`^kimi-code-env-[0-9a-f]{16}$`).MatchString(auth.StorageName) {
		t.Fatal(auth.StorageName)
	}
	if auth.CredentialPath != filepath.Join(home, "credentials", auth.StorageName+".json") {
		t.Fatal(auth.CredentialPath)
	}
}

func TestReaderSendsTheStoredTokenAsIsAndMapsAStale401ToReauth(t *testing.T) {
	home := temporaryKimiHome(t)
	writeToken(t, home, time.Now().Unix()-60)
	mockDefaultProviderList(t)
	stubFetch(t, func(request *http.Request) (int, string) {
		if request.URL.Scheme+"://"+request.URL.Host != "https://api.kimi.com" {
			t.Errorf("origin %s", request.URL)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer old-access" {
			t.Errorf("authorization %q", got)
		}
		return 401, "expired"
	})
	snapshot, err := AccountUsage(context.Background(), kimiInstallation, oar.AccountUsageReadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, snapshot, map[string]any{"kind": "reauth_required", "reason": "credentials_rejected"})
}

func TestReaderReportsReauthWithoutAnyRequestWhenNoTokenIsStored(t *testing.T) {
	temporaryKimiHome(t)
	mockDefaultProviderList(t)
	calls := stubFetch(t, func(*http.Request) (int, string) { return 200, "{}" })
	snapshot, err := AccountUsage(context.Background(), kimiInstallation, oar.AccountUsageReadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, snapshot, map[string]any{"kind": "reauth_required", "reason": "credentials_missing"})
	if len(calls.list()) != 0 {
		t.Fatal(calls.list())
	}
}

func TestReaderReportsAnUnresolvedProviderWhenProviderListAnswersWithoutOne(t *testing.T) {
	two := 2
	useRunner(t, func(context.Context, string, []string, executable.RunOptions) executable.Result {
		return executable.Result{Stderr: "no such command", ExitCode: &two}
	})
	calls := stubFetch(t, func(*http.Request) (int, string) { return 200, "{}" })
	snapshot, err := AccountUsage(context.Background(), kimiInstallation, oar.AccountUsageReadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, snapshot, map[string]any{"kind": "unsupported", "reason": "auth_configuration_unavailable"})
	if len(calls.list()) != 0 {
		t.Fatal(calls.list())
	}
}

// A timeout is an operational failure, which rejects (docs/spec/account-usage.md),
// not an auth configuration kimi lacks.
func TestReaderRejectsWhenProviderListTimedOut(t *testing.T) {
	useRunner(t, func(context.Context, string, []string, executable.RunOptions) executable.Result {
		return executable.Result{Diagnostics: &executable.Diagnostics{Signal: "SIGTERM", Timeout: 2 * time.Second}}
	})
	calls := stubFetch(t, func(*http.Request) (int, string) { return 200, "{}" })
	_, err := AccountUsage(context.Background(), kimiInstallation, oar.AccountUsageReadOptions{Timeout: 2 * time.Second})
	if err == nil || !regexp.MustCompile(`kimi provider list --json.*timeout after 2000 ms`).MatchString(err.Error()) {
		t.Fatalf("%v", err)
	}
	if len(calls.list()) != 0 {
		t.Fatal(calls.list())
	}
}

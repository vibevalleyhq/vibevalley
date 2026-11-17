package setting

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/config"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

const (
	testAgoraID   = "11111111111111111111111111111111"
	testAgoraCert = "22222222222222222222222222222222"
)

func strPtr(s string) *string { return &s }
func intPtr(n int) *int       { return &n }

func TestSettingsPriorityAndMasking(t *testing.T) {
	t.Parallel()

	home := t.TempDir()
	appCfg := &config.AppConfig{
		HomeDir:  home,
		WorkRoot: filepath.Join(home, "cfg-work"),
		DeepSeek: config.DeepSeekSection{APIKey: "sk-cfg-ds-1111"},
		Secrets: map[string]string{
			"anthropic_api_key":     "sk-ant-cfg-2222",
			"openai_api_key":        "sk-oai-cfg-3333",
			"agora_app_id":          "33333333333333333333333333333333",
			"agora_app_certificate": "44444444444444444444444444444444",
		},
	}

	env := map[string]string{}
	getenv := func(k string) string { return env[k] }

	svc, err := NewService(Options{
		HomeDir:   home,
		AppConfig: appCfg,
		Getenv:    getenv,
		Version:   "0.2.0",
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	// Config beats defaults.
	st := svc.Get()
	if st.DeepseekAPIKey.Source == nil || *st.DeepseekAPIKey.Source != "config" || st.DeepseekAPIKey.Hint != "…1111" {
		t.Fatalf("unexpected deepseek key status from config: %+v", st.DeepseekAPIKey)
	}
	if st.AnthropicAPIKey.Hint != "…2222" || st.OpenAIAPIKey.Hint != "…3333" {
		t.Fatalf("unexpected anthropic/openai hints: %+v / %+v", st.AnthropicAPIKey, st.OpenAIAPIKey)
	}
	if st.WorkRoot != filepath.Join(home, "cfg-work") {
		t.Fatalf("expected config workroot, got %q", st.WorkRoot)
	}

	// settings.json beats AppConfig and writes atomically with 0600 permissions.
	updated, err := svc.Update(context.Background(), SettingsUpdate{
		DeepseekAPIKey:      strPtr("sk-settings-ds-9876"),
		AnthropicAPIKey:     strPtr("sk-ant-settings-8765"),
		OpenAIAPIKey:        strPtr("sk-oai-settings-7654"),
		AgoraAppID:          strPtr(testAgoraID),
		AgoraAppCertificate: strPtr(testAgoraCert),
		WorkRoot:            strPtr(filepath.Join(home, "saved-work")),
	})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.DeepseekAPIKey.Source == nil || *updated.DeepseekAPIKey.Source != "settings" || updated.DeepseekAPIKey.Hint != "…9876" {
		t.Fatalf("expected settings deepseek override, got %+v", updated.DeepseekAPIKey)
	}
	if updated.WorkRoot != filepath.Join(home, "saved-work") {
		t.Fatalf("expected saved workroot, got %q", updated.WorkRoot)
	}

	rawJSON, _ := json.Marshal(updated)
	for _, secret := range []string{"sk-settings-ds-9876", "sk-ant-settings-8765", "sk-oai-settings-7654", testAgoraCert, "sk-cfg-ds-1111"} {
		if strings.Contains(string(rawJSON), secret) {
			t.Fatalf("SettingsStatus leaked raw secret %q: %s", secret, string(rawJSON))
		}
	}

	info, err := os.Stat(filepath.Join(home, settingsFileName))
	if err != nil {
		t.Fatalf("stat settings.json: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("expected settings.json mode 0600, got %o", info.Mode().Perm())
	}

	// Reload from disk verifies persistence.
	reloaded, err := NewService(Options{HomeDir: home, AppConfig: appCfg, Getenv: getenv})
	if err != nil {
		t.Fatalf("reload NewService: %v", err)
	}
	if key, origin, ok := reloaded.ResolveAPIKey("deepseek"); !ok || origin != "settings" || key != "sk-settings-ds-9876" {
		t.Fatalf("expected persisted settings key, got ok=%v origin=%q key=%q", ok, origin, key)
	}

	// Env vars beat settings.json and AppConfig.
	env["DEEPSEEK_API_KEY"] = "sk-env-ds-5555"
	env["ANTHROPIC_API_KEY"] = "sk-ant-env-6666"
	env["OPENAI_API_KEY"] = "sk-oai-env-7777"
	env["AGORA_APP_ID"] = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	env["AGORA_APP_CERTIFICATE"] = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	env["VIBEVALLEY_WORK_ROOT"] = filepath.Join(home, "env-work")

	envStatus := reloaded.Status()
	if envStatus.DeepseekAPIKey.Source == nil || *envStatus.DeepseekAPIKey.Source != "config" || envStatus.DeepseekAPIKey.Hint != "…5555" {
		t.Fatalf("expected env deepseek override, got %+v", envStatus.DeepseekAPIKey)
	}
	if envStatus.AnthropicAPIKey.Hint != "…6666" || envStatus.OpenAIAPIKey.Hint != "…7777" {
		t.Fatalf("expected env anthropic/openai hints, got %+v / %+v", envStatus.AnthropicAPIKey, envStatus.OpenAIAPIKey)
	}
	if envStatus.AgoraAppID.Value != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" || envStatus.AgoraAppCertificate.Hint != "…bbbb" {
		t.Fatalf("expected env agora override, got %+v / %+v", envStatus.AgoraAppID, envStatus.AgoraAppCertificate)
	}
	if envStatus.WorkRoot != filepath.Join(home, "env-work") {
		t.Fatalf("expected env workroot, got %q", envStatus.WorkRoot)
	}
	if key, origin, ok := reloaded.ResolveAPIKey("deepseek"); !ok || origin != "env" || key != "sk-env-ds-5555" {
		t.Fatalf("ResolveAPIKey env failed: ok=%v origin=%q key=%q", ok, origin, key)
	}

	// Clearing settings.json falls back to AppConfig once env is removed.
	delete(env, "DEEPSEEK_API_KEY")
	cleared, err := reloaded.Update(context.Background(), SettingsUpdate{DeepseekAPIKey: strPtr("")})
	if err != nil {
		t.Fatalf("clear Update: %v", err)
	}
	if cleared.DeepseekAPIKey.Hint != "…1111" {
		t.Fatalf("expected fallback to config hint …1111, got %+v", cleared.DeepseekAPIKey)
	}
}

func TestSettingsInMemoryAndCorruptFileRecovery(t *testing.T) {
	t.Parallel()

	// In-memory mode when homeDir == "".
	memSvc, err := NewService(Options{Getenv: func(string) string { return "" }})
	if err != nil {
		t.Fatalf("in-memory NewService: %v", err)
	}
	if memSvc.FilePath() != "" {
		t.Fatalf("expected empty filePath in memory mode, got %q", memSvc.FilePath())
	}
	st, err := memSvc.Update(context.Background(), SettingsUpdate{DeepseekAPIKey: strPtr("sk-mem-only-4321")})
	if err != nil {
		t.Fatalf("in-memory Update: %v", err)
	}
	if st.DeepseekAPIKey.Hint != "…4321" || !st.Readiness["orchestrator"].Ready {
		t.Fatalf("unexpected in-memory status: %+v", st)
	}

	// Corrupted settings.json is moved aside cleanly without losing raw bytes.
	home := t.TempDir()
	corruptPath := filepath.Join(home, settingsFileName)
	if err := os.WriteFile(corruptPath, []byte("{not valid json"), 0o600); err != nil {
		t.Fatal(err)
	}
	clk := store.NewFakeClock(time.Unix(1_700_000_123, 0))
	svc, err := NewService(Options{HomeDir: home, Clock: clk, Getenv: func(string) string { return "" }})
	if err != nil {
		t.Fatalf("NewService on corrupt file: %v", err)
	}
	if svc.Status().DeepseekAPIKey.Source != nil {
		t.Fatalf("expected empty settings after corrupt file backup")
	}
	asidePath := filepath.Join(home, "settings.json.unreadable-1700000123000")
	if got, err := os.ReadFile(asidePath); err != nil || string(got) != "{not valid json" {
		t.Fatalf("expected backup at %s, got err=%v content=%q", asidePath, err, string(got))
	}
}

func TestSettingsValidationAndKeyCheckHook(t *testing.T) {
	t.Parallel()

	checked := make(map[string]string)
	svc, err := NewService(Options{
		Getenv: func(string) string { return "" },
		KeyChecker: func(_ context.Context, provider, apiKey string) error {
			checked[provider] = apiKey
			if strings.HasPrefix(apiKey, "sk-bad") {
				return errors.New("rejected by upstream provider")
			}
			return nil
		},
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	if v := svc.Validate(context.Background(), SettingsUpdate{AgoraAppID: strPtr("bad")}); v.Problem == "" {
		t.Fatalf("expected Agora AppID validation problem")
	}
	if v := svc.Validate(context.Background(), SettingsUpdate{Voice: &VoicePatch{SilenceMs: intPtr(50)}}); v.Problem == "" {
		t.Fatalf("expected voice silenceMs range problem")
	}
	if v := svc.Validate(context.Background(), SettingsUpdate{DeepseekAPIKey: strPtr("sk-bad-123456")}); !strings.Contains(v.Problem, "rejected") {
		t.Fatalf("expected keyChecker failure, got %+v", v)
	}
	if checked["deepseek"] != "sk-bad-123456" {
		t.Fatalf("expected keyChecker invocation")
	}
	if v := svc.Validate(context.Background(), SettingsUpdate{DeepseekAPIKey: strPtr("sk-good-123456")}); v.Problem != "" {
		t.Fatalf("unexpected validation problem: %+v", v)
	}
}

func TestProviderUpdatesCatalogAndRemoteLists(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer moss-secret-9999" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/v1/models":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"object": "list",
				"data": []map[string]any{
					{"id": "moss-live-1.0", "owned_by": "moss"},
				},
			})
		case "/v1/voices":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"voices": []map[string]any{
					{"id": "v1", "name": "Warm Voice", "created_at": 1700000000},
				},
				"has_more":    false,
				"next_cursor": nil,
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	home := t.TempDir()
	svc, err := NewService(Options{
		HomeDir:    home,
		Getenv:     func(string) string { return "" },
		HTTPClient: srv.Client(),
		MOSSBase:   srv.URL + "/v1",
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	if len(svc.ListProviders()) < 4 || len(svc.ListVoiceProviders()) < 8 {
		t.Fatalf("expected populated catalogs")
	}
	catModels, err := svc.ListModels(context.Background(), nil)
	if err != nil || len(catModels.Models) == 0 {
		t.Fatalf("catalog ListModels failed: %v", err)
	}

	ps, err := svc.UpdateProviders(context.Background(), ProviderUpdate{
		Revision: 0,
		Connections: []ProviderConnectionUpdate{
			{ID: "moss-main", Name: "MOSS", Adapter: "moss", Enabled: true, Key: strPtr("moss-secret-9999")},
		},
		Live:      &ProviderBinding{Connection: "moss-main", Model: "moss-live-1.0"},
		Dictation: &ProviderBinding{Connection: "moss-main", Model: "moss-transcribe-1.0"},
	})
	if err != nil {
		t.Fatalf("UpdateProviders: %v", err)
	}
	if ps.Revision != 1 || ps.Connections[0].Key.Hint != "…9999" {
		t.Fatalf("unexpected provider status: %+v", ps)
	}
	if raw, _ := json.Marshal(ps); strings.Contains(string(raw), "moss-secret-9999") {
		t.Fatalf("ProviderStatus leaked raw secret: %s", string(raw))
	}

	// Stale revision fails CAS.
	if _, err := svc.UpdateProviders(context.Background(), ProviderUpdate{Revision: 0}); !errors.Is(err, ErrProviderRefused) {
		t.Fatalf("expected ErrProviderRefused on stale revision, got %v", err)
	}

	// Preserving key on omitted key field works.
	ps2, err := svc.UpdateProviders(context.Background(), ProviderUpdate{
		Revision: 1,
		Connections: []ProviderConnectionUpdate{
			{ID: "moss-main", Name: "MOSS", Adapter: "moss", Enabled: true},
		},
		Live: &ProviderBinding{Connection: "moss-main", Model: "moss-live-1.0"},
	})
	if err != nil || ps2.Connections[0].Key.Hint != "…9999" {
		t.Fatalf("expected preserved key hint, got err=%v ps=%+v", err, ps2)
	}

	models, err := svc.ListModels(context.Background(), &ProviderModelRequest{Connection: "moss-main", Revision: 2})
	if err != nil || len(models.Models) != 1 || models.Models[0].ID != "moss-live-1.0" {
		t.Fatalf("ListModels failed: err=%v models=%+v", err, models)
	}
	voices, err := svc.ListProviderVoices(context.Background(), ProviderVoiceRequest{Connection: "moss-main", Revision: 2})
	if err != nil || len(voices.Voices) != 1 || voices.Voices[0].Name != "Warm Voice" {
		t.Fatalf("ListProviderVoices failed: err=%v voices=%+v", err, voices)
	}

	if !svc.Status().Readiness["live"].Ready {
		t.Fatalf("expected live feature ready after binding")
	}
}

package runs

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"vibevalley/internal/farmtest"
	"vibevalley/internal/protocol"
)

func crewPiHome(t *testing.T, models, auth string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("OAR_PI_AGENT_DIR", dir)
	write := func(name, body string) {
		if body != "" {
			if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	write("settings.json", `{"defaultProvider":"deepseek","defaultModel":"deepseek-chat"}`)
	write("models.json", models)
	write("auth.json", auth)
}

func crewBalanceServer(t *testing.T, key string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/user/balance" || r.Header.Get("authorization") != "Bearer "+key {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Write([]byte(`{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"12.50"}]}`))
	}))
	t.Cleanup(server.Close)
	return server
}

func TestRuntimesPiBalanceAsPiConfiguresDeepseek(t *testing.T) {
	want := protocol.AccountUsage{Value: protocol.AccountUsageBalance{Provider: "DeepSeek", Available: true, Balances: []protocol.Balance{{Currency: "CNY", Amount: 12.5}}}}

	server := crewBalanceServer(t, "sk-from-env")
	t.Setenv("DEEPSEEK_API_KEY", "")
	t.Setenv("MY_DEEPSEEK", "sk-from-env")
	crewPiHome(t, `{"providers":{"deepseek":{"apiKey":"$MY_DEEPSEEK","baseUrl":"`+server.URL+`/v1/"}}}`, "")
	farmtest.Eq(t, crewPiBalance(context.Background(), protocol.RuntimeSettings{}), want, "models.json's key and base URL")

	server = crewBalanceServer(t, "sk-auth")
	t.Setenv("DEEPSEEK_API_KEY", "sk-env")
	crewPiHome(t, `{"providers":{"deepseek":{"apiKey":"sk-models","baseUrl":"`+server.URL+`"}}}`, `{"deepseek":{"type":"api_key","key":"sk-auth"}}`)
	farmtest.Eq(t, crewPiBalance(context.Background(), protocol.RuntimeSettings{}), want, "auth.json's key")

	server = crewBalanceServer(t, "sk-env")
	crewPiHome(t, `{"providers":{"deepseek":{"apiKey":"sk-models","baseUrl":"`+server.URL+`"}}}`, "")
	farmtest.Eq(t, crewPiBalance(context.Background(), protocol.RuntimeSettings{}), want, "DEEPSEEK_API_KEY")

	t.Setenv("DEEPSEEK_API_KEY", "")
	crewPiHome(t, `{"providers":{"deepseek":{"baseUrl":"`+server.URL+`"}}}`, "")
	farmtest.Eq(t, crewPiBalance(context.Background(), protocol.RuntimeSettings{}), protocol.AccountUsage{Value: protocol.AccountUsageLoginRequired{}}, "no key")

	farmtest.Eq(t, crewPiBalance(context.Background(), protocol.RuntimeSettings{DefaultModel: "anthropic/claude"}), crewUnavailable("anthropic 不报余额"), "another provider")
}

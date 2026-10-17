package runtime

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
)

func piHome(t *testing.T, models, auth string) {
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

func balanceServer(t *testing.T, key string) *httptest.Server {
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

	server := balanceServer(t, "sk-from-env")
	t.Setenv("DEEPSEEK_API_KEY", "")
	t.Setenv("MY_DEEPSEEK", "sk-from-env")
	piHome(t, `{"providers":{"deepseek":{"apiKey":"$MY_DEEPSEEK","baseUrl":"`+server.URL+`/v1/"}}}`, "")
	testkit.Eq(t, piBalance(context.Background(), protocol.RuntimeSettings{}), want, "models.json's key and base URL")

	server = balanceServer(t, "sk-auth")
	t.Setenv("DEEPSEEK_API_KEY", "sk-env")
	piHome(t, `{"providers":{"deepseek":{"apiKey":"sk-models","baseUrl":"`+server.URL+`"}}}`, `{"deepseek":{"type":"api_key","key":"sk-auth"}}`)
	testkit.Eq(t, piBalance(context.Background(), protocol.RuntimeSettings{}), want, "auth.json's key")

	server = balanceServer(t, "sk-env")
	piHome(t, `{"providers":{"deepseek":{"apiKey":"sk-models","baseUrl":"`+server.URL+`"}}}`, "")
	testkit.Eq(t, piBalance(context.Background(), protocol.RuntimeSettings{}), want, "DEEPSEEK_API_KEY")

	t.Setenv("DEEPSEEK_API_KEY", "")
	piHome(t, `{"providers":{"deepseek":{"baseUrl":"`+server.URL+`"}}}`, "")
	testkit.Eq(t, piBalance(context.Background(), protocol.RuntimeSettings{}), protocol.AccountUsage{Value: protocol.AccountUsageLoginRequired{}}, "no key")

	testkit.Eq(t, piBalance(context.Background(), protocol.RuntimeSettings{DefaultModel: "anthropic/claude"}), unavailable("anthropic 不报余额"), "another provider")
}

func TestDshPricesDeepSeeksOwnModels(t *testing.T) {
	r := &Service{}
	if p := r.Price("dsh", "deepseek-official/deepseek-flash"); p == nil || p.Input != 0.14 {
		t.Fatalf("deepseek-flash price %+v", p)
	}
	if p := r.Price("dsh", "deepseek-official/deepseek-v4-flash"); p == nil || p.Input != 0.14 {
		t.Fatalf("deepseek-v4-flash price %+v", p)
	}
	if p := r.Price("dsh", "openrouter/deepseek-flash"); p != nil {
		t.Fatalf("another provider's model priced %+v", p)
	}
}

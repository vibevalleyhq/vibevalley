package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/gateway"
	"github.com/vibevalleyhq/vibevalley/internal/domain/stack"
)

type recordedRequest struct {
	Method string
	Path   string
	Auth   string
	Body   json.RawMessage
}

func testEnvFunc(vars map[string]string) func(string) string {
	return func(k string) string {
		if k == "PATH" {
			if v, ok := vars["PATH"]; ok {
				return v
			}
			return os.Getenv("PATH")
		}
		return vars[k]
	}
}

func runVibe(t *testing.T, vars map[string]string, stdin string, client *http.Client, args ...string) (string, string, error) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	var in io.Reader
	if stdin != "" {
		in = strings.NewReader(stdin)
	}
	err := run(context.Background(), args, in, &stdout, &stderr, testEnvFunc(vars), client)
	return stdout.String(), stderr.String(), err
}

func writeFakeServerJSON(t *testing.T, homeDir string, info ServerReadyInfo) {
	t.Helper()
	if err := os.MkdirAll(homeDir, 0o700); err != nil {
		t.Fatalf("mkdir homeDir: %v", err)
	}
	b, err := json.Marshal(info)
	if err != nil {
		t.Fatalf("marshal server.json: %v", err)
	}
	if err := os.WriteFile(filepath.Join(homeDir, "server.json"), b, 0o600); err != nil {
		t.Fatalf("write server.json: %v", err)
	}
}

func decodeJSONObject(t *testing.T, raw string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("decode JSON output: %v\nraw:\n%s", err, raw)
	}
	return out
}

func TestDiscoveryPrecedenceServerAndToken(t *testing.T) {
	homeDir := filepath.Join(t.TempDir(), "vibevalley-home")
	userHome := t.TempDir()

	// Default when nothing configured.
	gotURL, src := discoverServerURL("", testEnvFunc(map[string]string{}), homeDir, nil)
	if gotURL != defaultServerURL || src != "default" {
		t.Fatalf("default discovery = (%q, %q), want (%q, default)", gotURL, src, defaultServerURL)
	}

	// Home server.json overrides default.
	writeFakeServerJSON(t, homeDir, ServerReadyInfo{URL: "http://127.0.0.1:9901/", PID: 123})
	gotURL, src = discoverServerURL("", testEnvFunc(map[string]string{}), homeDir, nil)
	if gotURL != "http://127.0.0.1:9901" || src != "server.json" {
		t.Fatalf("server.json discovery = (%q, %q), want (http://127.0.0.1:9901, server.json)", gotURL, src)
	}

	// ~/.vibevalley/server.json also resolves via config.Load when VIBEVALLEY_HOME is unset.
	dotHome := filepath.Join(userHome, ".vibevalley")
	writeFakeServerJSON(t, dotHome, ServerReadyInfo{URL: "http://127.0.0.1:9902", PID: 456})
	rt := &appRuntime{getenv: testEnvFunc(map[string]string{"HOME": userHome})}
	env, err := rt.resolve()
	if err != nil {
		t.Fatalf("resolve default ~/.vibevalley failed: %v", err)
	}
	if env.ServerURL != "http://127.0.0.1:9902" || env.ServerSource != "server.json" {
		t.Fatalf("~/.vibevalley discovery = (%q, %q), want (http://127.0.0.1:9902, server.json)", env.ServerURL, env.ServerSource)
	}

	// VIBEVALLEY_SERVER_URL overrides server.json.
	gotURL, src = discoverServerURL("", testEnvFunc(map[string]string{
		"VIBEVALLEY_SERVER_URL": "http://127.0.0.1:9903/",
	}), homeDir, nil)
	if gotURL != "http://127.0.0.1:9903" || src != "VIBEVALLEY_SERVER_URL" {
		t.Fatalf("env discovery = (%q, %q), want (http://127.0.0.1:9903, VIBEVALLEY_SERVER_URL)", gotURL, src)
	}

	// --server flag overrides VIBEVALLEY_SERVER_URL and server.json.
	gotURL, src = discoverServerURL("127.0.0.1:9904/", testEnvFunc(map[string]string{
		"VIBEVALLEY_SERVER_URL": "http://127.0.0.1:9903",
	}), homeDir, nil)
	if gotURL != "http://127.0.0.1:9904" || src != "flag" {
		t.Fatalf("flag discovery = (%q, %q), want (http://127.0.0.1:9904, flag)", gotURL, src)
	}

	// Token precedence: --token > VIBEVALLEY_TOKEN > cli-auth.json (origin matched).
	if err := writeCLIAuth(homeDir, CLIAuthState{
		Server: "http://127.0.0.1:9901",
		Token:  "file-tok",
	}); err != nil {
		t.Fatalf("writeCLIAuth: %v", err)
	}

	tok, tsrc := discoverToken("", testEnvFunc(map[string]string{}), homeDir, "http://127.0.0.1:9999")
	if tok != "" || tsrc != "none" {
		t.Fatalf("mismatched server origin returned token (%q, %q), want empty", tok, tsrc)
	}

	tok, tsrc = discoverToken("", testEnvFunc(map[string]string{}), homeDir, "http://127.0.0.1:9901")
	if tok != "file-tok" || tsrc != "cli-auth.json" {
		t.Fatalf("cli-auth token = (%q, %q), want (file-tok, cli-auth.json)", tok, tsrc)
	}

	tok, tsrc = discoverToken("", testEnvFunc(map[string]string{"VIBEVALLEY_TOKEN": "env-tok"}), homeDir, "http://127.0.0.1:9901")
	if tok != "env-tok" || tsrc != "VIBEVALLEY_TOKEN" {
		t.Fatalf("env token = (%q, %q), want (env-tok, VIBEVALLEY_TOKEN)", tok, tsrc)
	}

	tok, tsrc = discoverToken("flag-tok", testEnvFunc(map[string]string{"VIBEVALLEY_TOKEN": "env-tok"}), homeDir, "http://127.0.0.1:9901")
	if tok != "flag-tok" || tsrc != "flag" {
		t.Fatalf("flag token = (%q, %q), want (flag-tok, flag)", tok, tsrc)
	}
}

func TestBizCodeErrorsAndJSONOutput(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/issue/list":
			// Non-zero bizCode even with HTTP 200.
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 100007,
				"message": "database offline",
				"error": map[string]any{
					"next": []map[string]any{
						{"say": "inspect local setup", "run": []string{"doctor"}},
					},
				},
			})
		case "/api/v1/issue/get":
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 100001,
				"message": "device token missing",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	homeDir := t.TempDir()
	writeFakeServerJSON(t, homeDir, ServerReadyInfo{URL: srv.URL, PID: 1})
	vars := map[string]string{"VIBEVALLEY_HOME": homeDir}

	_, _, err := runVibe(t, vars, "", srv.Client(), "issue", "list")
	if err == nil {
		t.Fatal("expected error for non-zero bizCode")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.BizCode != 100007 {
		t.Fatalf("unexpected error: %#v", err)
	}
	if !strings.Contains(err.Error(), "database offline") || !strings.Contains(err.Error(), "vibe doctor") {
		t.Fatalf("error message missing detail/remediation: %q", err.Error())
	}

	stdout, stderr, err := runVibe(t, vars, "", srv.Client(), "--json", "issue", "get", "42")
	if err == nil {
		t.Fatal("expected error for HTTP 401 non-zero bizCode")
	}
	if strings.TrimSpace(stdout) != "" {
		t.Fatalf("expected empty stdout on error, got %q", stdout)
	}
	errObj := decodeJSONObject(t, stderr)
	inner, ok := errObj["error"].(map[string]any)
	if !ok {
		t.Fatalf("stderr JSON missing error object: %#v", errObj)
	}
	if inner["bizCode"] != float64(100001) || inner["message"] != "device token missing" {
		t.Fatalf("unexpected JSON error payload: %#v", inner)
	}
}

func TestIssueCommandsAndStatusFallback(t *testing.T) {
	var (
		mu   sync.Mutex
		reqs []recordedRequest
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		reqs = append(reqs, recordedRequest{
			Method: r.Method,
			Path:   r.URL.Path,
			Auth:   r.Header.Get("Authorization"),
			Body:   append(json.RawMessage(nil), body...),
		})
		mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/issue/list":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": []map[string]any{
					{
						"id":         "iss-1",
						"number":     7,
						"title":      "Ship Go CLI",
						"status":     "queued",
						"repo":       "vibevalley",
						"assigneeId": "codex",
					},
				},
			})
		case "/api/v1/issue/get":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": map[string]any{
					"id":          "iss-1",
					"number":      7,
					"title":       "Ship Go CLI",
					"description": "Implement cmd/vibe",
					"status":      "in_progress",
					"priority":    "high",
					"criteria":    []string{"tests pass"},
				},
			})
		case "/api/v1/issue/create":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": map[string]any{
					"id":     "iss-2",
					"number": 8,
					"title":  "New Task",
					"status": "draft",
				},
			})
		case "/api/v1/issue/status/update":
			// Simulate server exposing the shorthand alias /api/v1/issue/status.
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 100005,
				"message": "route not found",
			})
		case "/api/v1/issue/status":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": map[string]any{
					"id":     "iss-2",
					"number": 8,
					"title":  "New Task",
					"status": "done",
				},
			})
		case "/api/v1/issue/delete":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data":    map[string]any{"deleted": true},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	homeDir := t.TempDir()
	writeFakeServerJSON(t, homeDir, ServerReadyInfo{URL: srv.URL, PID: 1})
	vars := map[string]string{
		"VIBEVALLEY_HOME":  homeDir,
		"VIBEVALLEY_TOKEN": "tok-issue",
	}

	// issue list (text)
	out, _, err := runVibe(t, vars, "", srv.Client(), "issue", "list", "--status", "queued")
	if err != nil {
		t.Fatalf("issue list: %v", err)
	}
	if !strings.Contains(out, "#7") || !strings.Contains(out, "Ship Go CLI") || !strings.Contains(out, "@codex") {
		t.Fatalf("unexpected issue list output: %q", out)
	}

	// issue list (--json)
	outJSON, _, err := runVibe(t, vars, "", srv.Client(), "--json", "issue", "list")
	if err != nil {
		t.Fatalf("issue list --json: %v", err)
	}
	var listed []issueView
	if err := json.Unmarshal([]byte(outJSON), &listed); err != nil || len(listed) != 1 || listed[0].Number != 7 {
		t.Fatalf("unexpected issue list JSON: %v %q", err, outJSON)
	}

	// issue get #7 -> trims leading #
	out, _, err = runVibe(t, vars, "", srv.Client(), "issue", "get", "#7")
	if err != nil {
		t.Fatalf("issue get: %v", err)
	}
	if !strings.Contains(out, "Implement cmd/vibe") || !strings.Contains(out, "tests pass") {
		t.Fatalf("unexpected issue get output: %q", out)
	}

	// issue create (reads stdin description via --description -)
	out, _, err = runVibe(t, vars, "desc from stdin\n", srv.Client(), "issue", "create", "--repo", "vibevalley", "--description", "-", "New Task")
	if err != nil {
		t.Fatalf("issue create: %v", err)
	}
	if !strings.Contains(out, "#8") || !strings.Contains(out, "New Task") {
		t.Fatalf("unexpected issue create output: %q", out)
	}

	// issue status -> tests canonical + shorthand fallback
	out, _, err = runVibe(t, vars, "", srv.Client(), "issue", "status", "#8", "done", "--comment", "verified")
	if err != nil {
		t.Fatalf("issue status: %v", err)
	}
	if !strings.Contains(out, "done") {
		t.Fatalf("unexpected issue status output: %q", out)
	}

	// issue delete
	out, _, err = runVibe(t, vars, "", srv.Client(), "issue", "delete", "8")
	if err != nil {
		t.Fatalf("issue delete: %v", err)
	}
	if !strings.Contains(out, "deleted issue #8") {
		t.Fatalf("unexpected issue delete output: %q", out)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(reqs) != 7 {
		t.Fatalf("expected 7 HTTP requests (with status fallback), got %d", len(reqs))
	}
	for _, r := range reqs {
		if r.Auth != "Bearer tok-issue" {
			t.Fatalf("missing bearer header on %s: %q", r.Path, r.Auth)
		}
	}
	if reqs[2].Path != "/api/v1/issue/get" || !strings.Contains(string(reqs[2].Body), `"id":"7"`) {
		t.Fatalf("expected trimmed issue id 7 in issue/get body, got %s", string(reqs[2].Body))
	}
	if reqs[3].Path != "/api/v1/issue/create" || !strings.Contains(string(reqs[3].Body), "desc from stdin") {
		t.Fatalf("expected stdin description in issue/create body, got %s", string(reqs[3].Body))
	}
	if reqs[4].Path != "/api/v1/issue/status/update" || reqs[5].Path != "/api/v1/issue/status" {
		t.Fatalf("expected canonical then fallback status paths, got %q -> %q", reqs[4].Path, reqs[5].Path)
	}
}

func TestChannelAndPKMCommands(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/channel/list":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": []map[string]any{
					{"id": "main", "name": "general", "type": "team", "default": true, "unread": 2},
				},
			})
		case "/api/v1/channel/message/list":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": []map[string]any{
					{"id": "m1", "number": 3, "name": "alice", "text": "hello\nworld"},
				},
			})
		case "/api/v1/channel/message/send":
			// Exercise fallback to /api/v1/channel/send
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{"bizCode": 100005, "message": "not found"})
		case "/api/v1/channel/send":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data":    map[string]any{"id": "m2", "number": 4},
			})
		case "/api/v1/pkm/page/list":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": map[string]any{
					"root": "/vault",
					"pages": []map[string]any{
						{"slug": "projects/vibe", "title": "VibeValley", "tier": "projects", "relPath": "1-Projects/VibeValley.md", "open": 3},
					},
				},
			})
		case "/api/v1/pkm/page/get":
			// Exercise fallback to /api/v1/pkm/read
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{"bizCode": 100005, "message": "not found"})
		case "/api/v1/pkm/read":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": map[string]any{
					"page": map[string]any{
						"slug":  "projects/vibe",
						"title": "VibeValley",
						"tier":  "projects",
						"blocks": []map[string]any{
							{"depth": 0, "marker": "TODO", "priority": "A", "body": "Ship host bridge"},
						},
					},
				},
			})
		case "/api/v1/pkm/search":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": []map[string]any{
					{"page": "projects/vibe", "pageTitle": "VibeValley", "relPath": "1-Projects/VibeValley.md", "plain": "Ship host bridge", "score": 1.0},
				},
			})
		case "/api/v1/pkm/capture":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data":    map[string]any{"slug": "journals/2026-11-17", "title": "2026-11-17"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	vars := map[string]string{
		"VIBEVALLEY_HOME":       t.TempDir(),
		"VIBEVALLEY_SERVER_URL": srv.URL,
	}

	out, _, err := runVibe(t, vars, "", srv.Client(), "channel", "list")
	if err != nil || !strings.Contains(out, "#general") || !strings.Contains(out, "unread 2") {
		t.Fatalf("channel list = (%q, %v)", out, err)
	}

	out, _, err = runVibe(t, vars, "", srv.Client(), "channel", "messages", "main")
	if err != nil || !strings.Contains(out, "#3  alice: hello world") {
		t.Fatalf("channel messages = (%q, %v)", out, err)
	}

	out, _, err = runVibe(t, vars, "", srv.Client(), "--json", "channel", "send", "main", "hi", "there")
	if err != nil || !strings.Contains(out, `"number": 4`) {
		t.Fatalf("channel send --json = (%q, %v)", out, err)
	}

	out, _, err = runVibe(t, vars, "", srv.Client(), "pkm", "list")
	if err != nil || !strings.Contains(out, "VibeValley") || !strings.Contains(out, "open 3") {
		t.Fatalf("pkm list = (%q, %v)", out, err)
	}

	out, _, err = runVibe(t, vars, "", srv.Client(), "pkm", "get", "projects/vibe")
	if err != nil || !strings.Contains(out, "- TODO [#A] Ship host bridge") {
		t.Fatalf("pkm get = (%q, %v)", out, err)
	}

	out, _, err = runVibe(t, vars, "", srv.Client(), "pkm", "search", "host", "bridge")
	if err != nil || !strings.Contains(out, "VibeValley") || !strings.Contains(out, "Ship host bridge") {
		t.Fatalf("pkm search = (%q, %v)", out, err)
	}

	out, _, err = runVibe(t, vars, "captured from stdin", srv.Client(), "pkm", "capture")
	if err != nil || !strings.Contains(out, "captured in 2026-11-17") {
		t.Fatalf("pkm capture = (%q, %v)", out, err)
	}
}

func TestAuthLifecycleCommands(t *testing.T) {
	var (
		mu          sync.Mutex
		collectHits int
		loggedOut   bool
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/user/get":
			if r.Header.Get("Authorization") == "Bearer tok-approved" {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"bizCode": 0,
					"message": "ok",
					"data": map[string]any{
						"name":          "lucas",
						"authenticated": true,
						"device":        map[string]any{"id": "dev-1", "name": "mbp"},
					},
				})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data":    map[string]any{"name": "lucas", "password": true, "here": false},
			})
		case "/api/v1/user/approval/create":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": map[string]any{
					"code":      "ABCD-1234",
					"claim":     "claim-1",
					"expiresAt": time.Now().Add(time.Minute).UnixMilli(),
					"every":     0.005,
				},
			})
		case "/api/v1/user/approval/collect":
			mu.Lock()
			collectHits++
			hit := collectHits
			mu.Unlock()
			if hit == 1 {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"bizCode": 0,
					"message": "ok",
					"data":    map[string]any{"every": 0.005},
				})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": map[string]any{
					"login": map[string]any{"device": "dev-1", "key": "tok-approved"},
				},
			})
		case "/api/v1/user/login":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data":    map[string]any{"device": "dev-pw", "token": "tok-pw"},
			})
		case "/api/v1/user/logout":
			mu.Lock()
			loggedOut = true
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data":    map[string]any{},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	homeDir := t.TempDir()
	writeFakeServerJSON(t, homeDir, ServerReadyInfo{URL: srv.URL, PID: 1})
	vars := map[string]string{"VIBEVALLEY_HOME": homeDir}

	// Initially signed out.
	out, _, err := runVibe(t, vars, "", srv.Client(), "--json", "auth", "status")
	if err != nil {
		t.Fatalf("auth status signed out: %v", err)
	}
	if signedIn, _ := decodeJSONObject(t, out)["signedIn"].(bool); signedIn {
		t.Fatalf("expected signedIn=false, got %s", out)
	}

	// Approval login flow polls collect and writes cli-auth.json.
	out, stderr, err := runVibe(t, vars, "", srv.Client(), "--json", "auth", "login", "--device", "mbp")
	if err != nil {
		t.Fatalf("auth login approval: %v", err)
	}
	if !strings.Contains(stderr, "ABCD-1234") {
		t.Fatalf("expected approval code in stderr, got %q", stderr)
	}
	loginObj := decodeJSONObject(t, out)
	if loginObj["signedIn"] != true || loginObj["device"] != "dev-1" {
		t.Fatalf("unexpected auth login output: %#v", loginObj)
	}

	saved, ok, err := readCLIAuth(homeDir)
	if err != nil || !ok || saved.Token != "tok-approved" || saved.Server != srv.URL {
		t.Fatalf("unexpected saved cli-auth.json: %#v ok=%v err=%v", saved, ok, err)
	}

	// Status now uses cli-auth.json bearer token.
	out, _, err = runVibe(t, vars, "", srv.Client(), "auth", "status")
	if err != nil || !strings.Contains(out, "signed in") || !strings.Contains(out, "lucas") {
		t.Fatalf("auth status signed in = (%q, %v)", out, err)
	}

	// Logout calls user.logout and removes cli-auth.json.
	out, _, err = runVibe(t, vars, "", srv.Client(), "auth", "logout")
	if err != nil || !strings.Contains(out, "signed out") {
		t.Fatalf("auth logout = (%q, %v)", out, err)
	}
	if !loggedOut {
		t.Fatal("expected user.logout RPC call")
	}
	if _, exists, _ := readCLIAuth(homeDir); exists {
		t.Fatal("cli-auth.json should be removed after logout")
	}

	// Password login stores new token.
	_, _, err = runVibe(t, vars, "", srv.Client(), "auth", "login", "--password", "secret", "--device", "dev-pw")
	if err != nil {
		t.Fatalf("auth login --password: %v", err)
	}
	saved, ok, err = readCLIAuth(homeDir)
	if err != nil || !ok || saved.Token != "tok-pw" {
		t.Fatalf("password login cli-auth.json = (%#v, %v, %v)", saved, ok, err)
	}
}

func TestDoctorCommand(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"ok":true}`)
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	homeDir := t.TempDir()
	writeFakeServerJSON(t, homeDir, ServerReadyInfo{URL: srv.URL, PID: 42})

	binDir := t.TempDir()
	for _, name := range []string{"git", "claude"} {
		bin := filepath.Join(binDir, name)
		if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
			t.Fatalf("write fake %s: %v", name, err)
		}
	}

	vars := map[string]string{
		"VIBEVALLEY_HOME": homeDir,
		"PATH":            binDir,
	}

	out, _, err := runVibe(t, vars, "", srv.Client(), "--json", "doctor")
	if err != nil {
		t.Fatalf("doctor healthy: %v\nout=%s", err, out)
	}
	report := decodeJSONObject(t, out)
	if report["ok"] != true {
		t.Fatalf("expected ok=true in doctor report, got %s", out)
	}

	// Unreachable server causes doctor to return error and ok=false.
	srv.Close()
	outFail, _, err := runVibe(t, vars, "", srv.Client(), "--json", "doctor")
	if err == nil {
		t.Fatalf("expected doctor error when server closed, got out=%s", outFail)
	}
	failReport := decodeJSONObject(t, outFail)
	if failReport["ok"] != false {
		t.Fatalf("expected ok=false when server unreachable, got %s", outFail)
	}
}

func TestAppSocketCommands(t *testing.T) {
	sockDir, err := os.MkdirTemp("", "vvapp-*")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(sockDir) })
	sockPath := filepath.Join(sockDir, "desktop.sock")

	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listen unix %s: %v", sockPath, err)
	}
	defer ln.Close()

	var (
		mu        sync.Mutex
		calls     []bridgeSocketRequest
		serveDone = make(chan struct{})
	)
	go func() {
		defer close(serveDone)
		for {
			conn, aErr := ln.Accept()
			if aErr != nil {
				return
			}
			line, rErr := bufio.NewReader(conn).ReadBytes('\n')
			if rErr == nil {
				var req bridgeSocketRequest
				if json.Unmarshal(line, &req) == nil {
					mu.Lock()
					calls = append(calls, req)
					mu.Unlock()
					var resp bridgeSocketResponse
					switch req.Call {
					case "status":
						out, _ := json.Marshal(desktopStatusView{
							Name:    "VibeValley",
							Version: "0.9.0",
							Channel: "dev",
							Server:  "http://127.0.0.1:8787",
						})
						resp = bridgeSocketResponse{ID: req.ID, OK: true, Output: out}
					case "open":
						resp = bridgeSocketResponse{ID: req.ID, OK: true}
					default:
						resp = bridgeSocketResponse{ID: req.ID, OK: false, Error: "unknown"}
					}
					b, _ := json.Marshal(resp)
					_, _ = conn.Write(append(b, '\n'))
				}
			}
			_ = conn.Close()
		}
	}()

	vars := map[string]string{
		"VIBEVALLEY_HOME":           t.TempDir(),
		"VIBEVALLEY_DESKTOP_SOCKET": sockPath,
	}

	out, _, err := runVibe(t, vars, "", nil, "app", "status")
	if err != nil || !strings.Contains(out, "VibeValley 0.9.0 (dev)") {
		t.Fatalf("app status = (%q, %v)", out, err)
	}

	out, _, err = runVibe(t, vars, "", nil, "--json", "app", "open", "repos")
	if err != nil || !strings.Contains(out, `"/repos"`) {
		t.Fatalf("app open --json = (%q, %v)", out, err)
	}

	_ = ln.Close()
	<-serveDone

	mu.Lock()
	defer mu.Unlock()
	if len(calls) != 2 || calls[0].Call != "status" || calls[1].Call != "open" || calls[1].Input != "/repos" {
		t.Fatalf("unexpected socket calls: %#v", calls)
	}
}

func TestChatAndVersionCommands(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/orchestrator/send":
			body, _ := io.ReadAll(r.Body)
			if strings.Contains(string(body), "fallback-trigger") {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusNotFound)
				_ = json.NewEncoder(w).Encode(map[string]any{"bizCode": 100005, "message": "missing"})
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data":    map[string]any{"content": "orchestrator reply"},
			})
		case "/v1/chat/completions":
			var req ChatCompletionRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			if req.Stream {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\n")
				_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"VibeValley!\"}}]}\n\n")
				_, _ = io.WriteString(w, "data: [DONE]\n\n")
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"choices": []map[string]any{
					{"message": map[string]any{"content": "completions fallback"}},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	vars := map[string]string{
		"VIBEVALLEY_HOME":       t.TempDir(),
		"VIBEVALLEY_SERVER_URL": srv.URL,
	}

	// Version command.
	out, _, err := runVibe(t, vars, "", srv.Client(), "--json", "version")
	if err != nil || decodeJSONObject(t, out)["version"] != vibeVersion {
		t.Fatalf("version --json = (%q, %v)", out, err)
	}

	// Non-streaming orchestrator RPC.
	out, _, err = runVibe(t, vars, "", srv.Client(), "chat", "hello")
	if err != nil || strings.TrimSpace(out) != "orchestrator reply" {
		t.Fatalf("chat rpc = (%q, %v)", out, err)
	}

	// Non-streaming fallback to /v1/chat/completions when orchestrator.send is 404.
	out, _, err = runVibe(t, vars, "", srv.Client(), "chat", "fallback-trigger")
	if err != nil || strings.TrimSpace(out) != "completions fallback" {
		t.Fatalf("chat fallback = (%q, %v)", out, err)
	}

	// Streaming SSE mode (plain & --json).
	out, _, err = runVibe(t, vars, "", srv.Client(), "chat", "--stream", "hi")
	if err != nil || strings.TrimSpace(out) != "Hello VibeValley!" {
		t.Fatalf("chat --stream = (%q, %v)", out, err)
	}

	out, _, err = runVibe(t, vars, "", srv.Client(), "--json", "chat", "--stream", "hi")
	if err != nil || decodeJSONObject(t, out)["content"] != "Hello VibeValley!" {
		t.Fatalf("chat --stream --json = (%q, %v)", out, err)
	}
}

func runVibeCtx(t *testing.T, ctx context.Context, vars map[string]string, stdin string, client *http.Client, args ...string) (string, string, error) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	var in io.Reader
	if stdin != "" {
		in = strings.NewReader(stdin)
	}
	err := run(ctx, args, in, &stdout, &stderr, testEnvFunc(vars), client)
	return stdout.String(), stderr.String(), err
}

func decodeJSONArray(t *testing.T, raw string) []map[string]any {
	t.Helper()
	var out []map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("decode JSON array: %v\nraw:\n%s", err, raw)
	}
	return out
}

func TestGlobalFlagsDryRunAndFormat(t *testing.T) {
	var (
		mu   sync.Mutex
		hits int
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"bizCode": 100005,
			"message": "not found",
		})
	}))
	defer srv.Close()

	vars := map[string]string{
		"VIBEVALLEY_HOME":       t.TempDir(),
		"VIBEVALLEY_SERVER_URL": srv.URL,
	}

	// Invalid --format rejected.
	if _, _, err := runVibe(t, vars, "", srv.Client(), "--format", "xml", "version"); err == nil {
		t.Fatal("expected error for invalid --format xml")
	}

	// --json overrides --format text.
	out, _, err := runVibe(t, vars, "", srv.Client(), "--format", "text", "--json", "version")
	if err != nil || decodeJSONObject(t, out)["version"] != vibeVersion {
		t.Fatalf("--json should override --format text, got (%q, %v)", out, err)
	}

	// --format json emits structured JSON error on stderr when server refuses.
	stdout, stderr, err := runVibe(t, vars, "", srv.Client(), "--format", "json", "issue", "get", "missing")
	if err == nil {
		t.Fatal("expected error on 404")
	}
	if strings.TrimSpace(stdout) != "" {
		t.Fatalf("expected empty stdout on error, got %q", stdout)
	}
	errObj := decodeJSONObject(t, stderr)
	if inner, ok := errObj["error"].(map[string]any); !ok || inner["bizCode"] != float64(100005) {
		t.Fatalf("expected structured JSON error on stderr, got %q", stderr)
	}

	mu.Lock()
	hits = 0
	mu.Unlock()

	dryCases := []struct {
		args     []string
		wantPath string
		wantKey  string
	}{
		{[]string{"--dry-run", "repo", "create", "/tmp/work/demo-repo"}, "/api/v1/repo/create", "demo-repo"},
		{[]string{"--dry-run", "--format", "json", "agent", "create", "--name", "fox", "--runtime", "claude", "--prompt", "hi"}, "/api/v1/agent/create", "fox"},
		{[]string{"--dry-run", "--format", "json", "agent", "update", "a1", "--model", "opus"}, "/api/v1/agent/update", "opus"},
		{[]string{"--dry-run", "agent", "delete", "a1"}, "/api/v1/agent/delete", "a1"},
		{[]string{"--dry-run", "session", "stop", "s1"}, "/api/v1/session/stop", "s1"},
		{[]string{"--dry-run", "--format", "json", "runtime", "update", "claude", "--bin", "/usr/bin/claude", "--default-model", "sonnet"}, "/api/v1/runtime/setting/update", "/usr/bin/claude"},
		{[]string{"--dry-run", "memory", "create", "--path", "notes.md", "--body", "remember this", "--scope", "fox"}, "/api/v1/memory/create", "remember this"},
		{[]string{"--dry-run", "memory", "update", "m1", "--body", "updated mem"}, "/api/v1/memory/update", "updated mem"},
		{[]string{"--dry-run", "memory", "delete", "m1", "--scope", "fox"}, "/api/v1/memory/delete", "m1"},
		{[]string{"--dry-run", "--format", "json", "cron", "create", "--name", "nightly", "--schedule", "0 9 * * *", "--timezone", "UTC", "--prompt", "audit"}, "/api/v1/cron/create", "0 9 * * *"},
		{[]string{"--dry-run", "cron", "update", "c1", "--enabled=false"}, "/api/v1/cron/update", "c1"},
		{[]string{"--dry-run", "cron", "delete", "c1"}, "/api/v1/cron/delete", "c1"},
		{[]string{"--dry-run", "cron", "run", "c1"}, "/api/v1/cron/run", "c1"},
		{[]string{"--dry-run", "--format", "json", "artifact", "create", "--title", "Spec", "--kind", "document", "--markdown", "# Hi"}, "/api/v1/artifact/create", "Spec"},
		{[]string{"--dry-run", "artifact", "delete", "art1"}, "/api/v1/artifact/delete", "art1"},
		{[]string{"--dry-run", "issue", "assign", "iss-1", "fox"}, "/api/v1/issue/update", "fox"},
		{[]string{"--dry-run", "issue", "act", "iss-1", "start"}, "/api/v1/issue/status/update", "todo"},
		{[]string{"--dry-run", "issue", "refine", "iss-1", "--instruction", "tighten scope"}, "/api/v1/issue/refine", "tighten scope"},
		{[]string{"--dry-run", "issue", "create", "Demo"}, "/api/v1/issue/create", "Demo"},
		{[]string{"--dry-run", "issue", "status", "iss-1", "done"}, "/api/v1/issue/status/update", "done"},
		{[]string{"--dry-run", "issue", "delete", "iss-1"}, "/api/v1/issue/delete", "iss-1"},
		{[]string{"--dry-run", "channel", "send", "general", "hello"}, "/api/v1/channel/message/send", "hello"},
		{[]string{"--dry-run", "pkm", "capture", "note"}, "/api/v1/pkm/capture", "note"},
	}

	for _, tc := range dryCases {
		out, _, err := runVibe(t, vars, "", srv.Client(), tc.args...)
		if err != nil {
			t.Fatalf("dry-run %v failed: %v", tc.args, err)
		}
		if !strings.Contains(out, tc.wantPath) || !strings.Contains(out, tc.wantKey) {
			t.Fatalf("dry-run %v output missing %q / %q:\n%s", tc.args, tc.wantPath, tc.wantKey, out)
		}
		for i, a := range tc.args {
			if a == "--format" && i+1 < len(tc.args) && tc.args[i+1] == "json" {
				plan := decodeJSONObject(t, out)
				if plan["dryRun"] != true || plan["method"] != "POST" || plan["path"] != tc.wantPath {
					t.Fatalf("unexpected dry-run JSON plan for %v: %#v", tc.args, plan)
				}
			}
		}
	}

	mu.Lock()
	defer mu.Unlock()
	if hits != 0 {
		t.Fatalf("expected 0 HTTP requests during client-side --dry-run tests, got %d", hits)
	}
}

func TestSessionRuntimeWorkerRepoPRAndFallbacks(t *testing.T) {
	var (
		mu   sync.Mutex
		reqs []recordedRequest
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		reqs = append(reqs, recordedRequest{
			Method: r.Method,
			Path:   r.URL.Path,
			Body:   append(json.RawMessage(nil), body...),
		})
		mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/state":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"rev": 3,
				"frame": map[string]any{
					"seq": 3,
					"state": map[string]any{
						"sessions": []map[string]any{
							{
								"id":        "s-1",
								"role":      "worker",
								"name":      "fox-1",
								"agent":     "fox",
								"runtime":   "claude",
								"phase":     map[string]any{"_tag": "working"},
								"phaseText": "running tests",
								"scope":     map[string]any{"kind": "issue", "id": "iss-1"},
								"repo":      "demo",
							},
						},
						"machines": []map[string]any{
							{"id": "local", "name": "mac", "here": true, "online": true},
						},
					},
					"view": map[string]any{
						"plays": map[string]any{
							"s-1": map[string]any{"station": 2},
						},
					},
				},
			})
		case "/api/v1/session/list":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": []map[string]any{
					{
						"id":      "s-1",
						"role":    "worker",
						"name":    "fox-1",
						"agent":   "fox",
						"runtime": "claude",
						"brief":   "Fix bug",
						"repo":    "demo",
						"phase":   map[string]any{"_tag": "working"},
						"scope":   map[string]any{"kind": "issue", "id": "iss-1"},
					},
					{
						"id":      "s-2",
						"role":    "worker",
						"name":    "owl-1",
						"agent":   "owl",
						"runtime": "codex",
						"brief":   "Other task",
						"phase":   map[string]any{"_tag": "resting"},
						"scope":   map[string]any{"kind": "issue", "id": "iss-2"},
					},
				},
			})
		case "/api/v1/session/get":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": map[string]any{
					"id":       "s-1",
					"role":     "worker",
					"name":     "fox-1",
					"agent":    "fox",
					"runtime":  "claude",
					"brief":    "Fix bug\nMore details",
					"branch":   "feat/fix",
					"worktree": "/tmp/wt/1",
					"runs":     2,
					"phase":    map[string]any{"_tag": "working"},
				},
			})
		case "/api/v1/session/stop":
			_ = json.NewEncoder(w).Encode(map[string]any{"bizCode": 0, "message": "ok"})
		case "/api/v1/session/event/list":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": []map[string]any{
					{"seq": 1, "revision": 1, "time": 100, "type": "run/start", "text": ""},
					{"seq": 2, "revision": 1, "time": 101, "type": "tool/call", "tool": "bash", "input": "go test"},
					{"seq": 3, "revision": 1, "time": 102, "type": "assistant/message", "text": "all green"},
				},
			})
		case "/api/v1/runtime/list":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": []map[string]any{
					{
						"id":           "claude",
						"preset":       map[string]any{"id": "claude", "label": "Claude Code"},
						"installation": map[string]any{"status": "available", "via": "executable", "command": "claude", "version": "1.2.0"},
						"settings":     map[string]any{"enabled": true, "binPath": "/usr/local/bin/claude", "defaultModel": "claude-sonnet", "defaultEffort": "high", "env": map[string]any{}},
					},
					{
						"id":           "codex",
						"preset":       map[string]any{"id": "codex", "label": "Codex CLI"},
						"installation": map[string]any{"status": "not_found"},
						"settings":     map[string]any{"enabled": false, "binPath": "", "defaultModel": "", "defaultEffort": "", "env": map[string]any{}},
					},
				},
			})
		case "/api/v1/runtime/refresh":
			var req struct {
				ID string `json:"id"`
			}
			_ = json.Unmarshal(body, &req)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": map[string]any{
					"id":           req.ID,
					"installation": map[string]any{"status": "available", "command": req.ID},
					"settings":     map[string]any{"enabled": true, "env": map[string]any{}},
				},
			})
		case "/api/v1/runtime/setting/update":
			var req map[string]any
			_ = json.Unmarshal(body, &req)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": map[string]any{
					"id":           req["id"],
					"installation": map[string]any{"status": "available", "command": "claude"},
					"settings":     req,
				},
			})
		case "/api/v1/repo/pr/submit":
			var req map[string]any
			_ = json.Unmarshal(body, &req)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": map[string]any{
					"platform":   "github",
					"repository": "demo",
					"branch":     "vibevalley/issue-iss-1",
					"sha":        "abc123",
					"base":       req["base"],
					"check":      "preview",
					"pushed":     false,
					"state":      "open",
				},
			})
		case "/api/v1/memory/update":
			var req map[string]any
			_ = json.Unmarshal(body, &req)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data": map[string]any{
					"id":     req["id"],
					"agent":  req["agent"],
					"kind":   "note",
					"text":   req["text"],
					"author": "user",
				},
			})
		case "/api/v1/cron/run":
			var req map[string]any
			_ = json.Unmarshal(body, &req)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bizCode": 0,
				"message": "ok",
				"data":    map[string]any{"ran": true, "id": req["id"], "issueId": "iss-cron-1"},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{"bizCode": 100005, "message": "route not found"})
		}
	}))
	defer srv.Close()

	vars := map[string]string{
		"VIBEVALLEY_HOME":       t.TempDir(),
		"VIBEVALLEY_SERVER_URL": srv.URL,
	}

	// session list --issue iss-1 --format json
	out, _, err := runVibe(t, vars, "", srv.Client(), "--format", "json", "session", "list", "--issue", "iss-1")
	if err != nil {
		t.Fatalf("session list --issue: %v", err)
	}
	sessArr := decodeJSONArray(t, out)
	if len(sessArr) != 1 || sessArr[0]["id"] != "s-1" {
		t.Fatalf("expected only s-1 for issue iss-1, got %s", out)
	}

	// session get s-1
	out, _, err = runVibe(t, vars, "", srv.Client(), "session", "get", "s-1")
	if err != nil || !strings.Contains(out, "branch: feat/fix") || !strings.Contains(out, "/tmp/wt/1") {
		t.Fatalf("session get = (%q, %v)", out, err)
	}

	// session events s-1 --after 1
	out, _, err = runVibe(t, vars, "", srv.Client(), "--format", "json", "session", "events", "s-1", "--after", "1")
	if err != nil {
		t.Fatalf("session events: %v", err)
	}
	evArr := decodeJSONArray(t, out)
	if len(evArr) != 2 || evArr[0]["seq"] != float64(2) || evArr[1]["seq"] != float64(3) {
		t.Fatalf("expected events seq 2 and 3 after seq 1, got %s", out)
	}

	// session stop s-1
	out, _, err = runVibe(t, vars, "", srv.Client(), "session", "stop", "s-1")
	if err != nil || !strings.Contains(out, "stopped session s-1") {
		t.Fatalf("session stop = (%q, %v)", out, err)
	}

	// runtime list, refresh (all), update
	out, _, err = runVibe(t, vars, "", srv.Client(), "runtime", "list")
	if err != nil || !strings.Contains(out, "claude") || !strings.Contains(out, "model=claude-sonnet") {
		t.Fatalf("runtime list = (%q, %v)", out, err)
	}
	out, _, err = runVibe(t, vars, "", srv.Client(), "--format", "json", "runtime", "refresh")
	if err != nil {
		t.Fatalf("runtime refresh: %v", err)
	}
	rtArr := decodeJSONArray(t, out)
	if len(rtArr) != 2 {
		t.Fatalf("expected 2 refreshed runtimes, got %s", out)
	}
	out, _, err = runVibe(t, vars, "", srv.Client(), "--format", "json", "runtime", "update", "claude", "--bin", "/opt/claude", "--default-model", "claude-opus-4")
	if err != nil {
		t.Fatalf("runtime update: %v", err)
	}
	rtUpd := decodeJSONObject(t, out)
	settingsMap, _ := rtUpd["settings"].(map[string]any)
	if settingsMap["binPath"] != "/opt/claude" || settingsMap["defaultModel"] != "claude-opus-4" || settingsMap["enabled"] != true {
		t.Fatalf("unexpected runtime update response: %#v", rtUpd)
	}

	// worker status & worker list
	out, _, err = runVibe(t, vars, "", srv.Client(), "--format", "json", "worker", "status")
	if err != nil {
		t.Fatalf("worker status: %v", err)
	}
	wObj := decodeJSONObject(t, out)
	if wObj["activeSessions"] != float64(1) || wObj["totalSessions"] != float64(2) {
		t.Fatalf("unexpected worker status summary: %#v", wObj)
	}
	outText, _, err := runVibe(t, vars, "", srv.Client(), "worker", "list")
	if err != nil || !strings.Contains(outText, "workers: 1 active / 2 total") || !strings.Contains(outText, "issue:working=1") {
		t.Fatalf("worker list = (%q, %v)", outText, err)
	}

	// repo pr <issueId> --dry-run forwards dryRun=true to /api/v1/repo/pr/submit
	out, _, err = runVibe(t, vars, "", srv.Client(), "--dry-run", "--format", "json", "repo", "pr", "iss-1", "--title", "Fix bug", "--body", "Body", "--base", "main", "--draft")
	if err != nil {
		t.Fatalf("repo pr --dry-run: %v", err)
	}
	prObj := decodeJSONObject(t, out)
	if prObj["check"] != "preview" || prObj["pushed"] != false {
		t.Fatalf("unexpected repo pr --dry-run output: %#v", prObj)
	}

	// direct /api/v1/memory/update and /api/v1/cron/run
	out, _, err = runVibe(t, vars, "", srv.Client(), "--format", "json", "memory", "update", "m-9", "--body", "direct edit", "--scope", "fox")
	if err != nil || decodeJSONObject(t, out)["text"] != "direct edit" {
		t.Fatalf("memory update direct = (%q, %v)", out, err)
	}
	out, _, err = runVibe(t, vars, "", srv.Client(), "--format", "json", "cron", "run", "c-9")
	if err != nil || decodeJSONObject(t, out)["issueId"] != "iss-cron-1" {
		t.Fatalf("cron run direct = (%q, %v)", out, err)
	}

	mu.Lock()
	defer mu.Unlock()
	var seenPRSubmit bool
	for _, rq := range reqs {
		if rq.Path == "/api/v1/repo/pr/submit" {
			seenPRSubmit = true
			var bodyMap map[string]any
			if err := json.Unmarshal(rq.Body, &bodyMap); err != nil {
				t.Fatal(err)
			}
			if bodyMap["dryRun"] != true || bodyMap["draft"] != true || bodyMap["issueId"] != "iss-1" || bodyMap["title"] != "Fix bug" {
				t.Fatalf("unexpected repo/pr/submit payload: %#v", bodyMap)
			}
		}
	}
	if !seenPRSubmit {
		t.Fatal("expected /api/v1/repo/pr/submit request")
	}
}

func TestIssueWatchSSETerminalAndCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/issue/watch/iss-done":
			w.Header().Set("Content-Type", "text/event-stream")
			flusher, _ := w.(http.Flusher)
			_, _ = io.WriteString(w, ": ping\n\n")
			_, _ = io.WriteString(w, `data: {"kind":"history","session":"s-1","events":[{"seq":1,"revision":1,"time":10,"type":"run/start","text":""},{"seq":2,"revision":1,"time":11,"type":"tool/call","tool":"bash","input":"echo ok"}]}`+"\n\n")
			_, _ = io.WriteString(w, `data: {"kind":"event","session":"s-1","event":{"seq":2,"revision":1,"time":11,"type":"tool/call","tool":"bash","input":"echo ok"}}`+"\n\n")
			_, _ = io.WriteString(w, `data: {"kind":"state","issue":{"id":"iss-done","number":12,"title":"Ship CLI","status":"in_progress","stage":{"state":"working"}},"sessions":[],"sessionIds":["s-1"],"settled":false}`+"\n\n")
			_, _ = io.WriteString(w, `data: {"kind":"state","issue":{"id":"iss-done","number":12,"title":"Ship CLI","status":"done","stage":{"state":"done"}},"sessions":[],"sessionIds":["s-1"],"settled":true}`+"\n\n")
			if flusher != nil {
				flusher.Flush()
			}
		case "/api/v1/issue/watch/iss-live":
			w.Header().Set("Content-Type", "text/event-stream")
			flusher, _ := w.(http.Flusher)
			_, _ = io.WriteString(w, `data: {"kind":"state","issue":{"id":"iss-live","number":13,"title":"Live task","status":"in_progress","stage":{"state":"working"}},"sessions":[],"sessionIds":[],"settled":false}`+"\n\n")
			if flusher != nil {
				flusher.Flush()
			}
			<-r.Context().Done()
		default:
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{"bizCode": 100005, "message": "route not found"})
		}
	}))
	defer srv.Close()

	vars := map[string]string{
		"VIBEVALLEY_HOME":       t.TempDir(),
		"VIBEVALLEY_SERVER_URL": srv.URL,
	}

	// Terminal settled event ends watch cleanly, deduplicating replayed event 2.1.
	out, _, err := runVibe(t, vars, "", srv.Client(), "--format", "json", "issue", "watch", "iss-done")
	if err != nil {
		t.Fatalf("issue watch terminal: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 4 {
		t.Fatalf("expected 4 deduplicated watch lines (2 history events + 2 states), got %d:\n%s", len(lines), out)
	}
	for _, line := range lines {
		_ = decodeJSONObject(t, line)
	}

	// Context cancellation stops streaming cleanly.
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(60 * time.Millisecond)
		cancel()
	}()
	outLive, _, err := runVibeCtx(t, ctx, vars, "", srv.Client(), "issue", "watch", "iss-live")
	if err != nil {
		t.Fatalf("issue watch cancel returned error: %v", err)
	}
	if !strings.Contains(outLive, "#13") || !strings.Contains(outLive, "stage=working") {
		t.Fatalf("expected live issue state line before cancel, got %q", outLive)
	}
}

func TestLiveGatewayParityAllCommands(t *testing.T) {
	ctx := context.Background()
	homeDir := filepath.Join(t.TempDir(), "home")
	workRoot := filepath.Join(t.TempDir(), "work")
	st, err := stack.New(ctx, stack.Config{
		DBPath:   ":memory:",
		WorkRoot: workRoot,
		HomeDir:  homeDir,
		Version:  "0.1.0-test",
		Getenv:   func(string) string { return "" },
	})
	if err != nil {
		t.Fatalf("stack.New: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	gw := gateway.NewHandler(st)
	ts := httptest.NewServer(gw)
	t.Cleanup(ts.Close)

	vars := map[string]string{
		"VIBEVALLEY_HOME":       homeDir,
		"VIBEVALLEY_SERVER_URL": ts.URL,
	}

	// 1. repo validate, create, list, languages, activity, pr (--dry-run)
	out, _, err := runVibe(t, vars, "", ts.Client(), "--format", "json", "repo", "validate", "/tmp/repos/sample-app")
	if err != nil || decodeJSONObject(t, out)["problem"] != "" {
		t.Fatalf("repo validate = (%q, %v)", out, err)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "repo", "create", "/tmp/repos/sample-app")
	if err != nil || decodeJSONObject(t, out)["name"] != "sample-app" {
		t.Fatalf("repo create = (%q, %v)", out, err)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "repo", "list")
	if err != nil || len(decodeJSONArray(t, out)) != 1 {
		t.Fatalf("repo list = (%q, %v)", out, err)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "repo", "languages", "sample-app")
	if err != nil || decodeJSONObject(t, out)["repo"] != "sample-app" {
		t.Fatalf("repo languages = (%q, %v)", out, err)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "repo", "activity", "sample-app", "--days", "14")
	if err != nil || decodeJSONObject(t, out)["repo"] != "sample-app" {
		t.Fatalf("repo activity = (%q, %v)", out, err)
	}

	// 2. agent templates, create, list, get, update, delete
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "agent", "templates")
	if err != nil || len(decodeJSONArray(t, out)) == 0 {
		t.Fatalf("agent templates = (%q, %v)", out, err)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "agent", "create", "--name", "CLI Fox", "--runtime", "claude", "--model", "claude-sonnet", "--prompt", "Verify carefully")
	if err != nil {
		t.Fatalf("agent create: %v", err)
	}
	createdAgent := decodeJSONObject(t, out)
	agentID, _ := createdAgent["id"].(string)
	if agentID == "" || createdAgent["name"] != "CLI Fox" || createdAgent["persona"] != "Verify carefully" {
		t.Fatalf("unexpected agent create response: %#v", createdAgent)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "agent", "get", agentID)
	if err != nil || decodeJSONObject(t, out)["id"] != agentID {
		t.Fatalf("agent get = (%q, %v)", out, err)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "agent", "update", agentID, "--model", "claude-opus")
	if err != nil {
		t.Fatalf("agent update: %v", err)
	}
	updatedAgent := decodeJSONObject(t, out)
	if updatedAgent["model"] != "claude-opus" || updatedAgent["name"] != "CLI Fox" || updatedAgent["enabled"] != true {
		t.Fatalf("agent update did not preserve fields: %#v", updatedAgent)
	}

	// 3. issue create, assign, refine, act (start, tell, close), watch, repo pr
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "issue", "create", "Live Gateway Task", "--repo", "sample-app")
	if err != nil {
		t.Fatalf("issue create: %v", err)
	}
	issID, _ := decodeJSONObject(t, out)["id"].(string)
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "issue", "assign", issID, agentID)
	if err != nil {
		t.Fatalf("issue assign: %v", err)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "issue", "refine", issID, "--instruction", "Add acceptance checks")
	if err != nil || decodeJSONObject(t, out)["id"] != issID {
		t.Fatalf("issue refine = (%q, %v)", out, err)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "repo", "pr", issID, "--title", "Live PR", "--body", "Body", "--base", "main", "--draft", "--dry-run")
	if err != nil || decodeJSONObject(t, out)["check"] != "preview" {
		t.Fatalf("repo pr dry-run against gateway = (%q, %v)", out, err)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "issue", "act", issID, "start")
	if err != nil {
		t.Fatalf("issue act start: %v", err)
	}
	startedStatus, _ := decodeJSONObject(t, out)["status"].(string)
	if startedStatus != "todo" && startedStatus != "in_progress" {
		t.Fatalf("issue act start status = %q, want todo or in_progress", startedStatus)
	}
	if _, _, err := runVibe(t, vars, "", ts.Client(), "issue", "act", issID, "tell", "--text", "Checking progress"); err != nil {
		t.Fatalf("issue act tell: %v", err)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "issue", "act", issID, "close")
	if err != nil {
		t.Fatalf("issue act close: %v", err)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "issue", "watch", issID)
	if err != nil || !strings.Contains(out, `"settled":true`) {
		t.Fatalf("issue watch on settled issue = (%q, %v)", out, err)
	}

	// 4. runtime list, refresh, update
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "runtime", "list")
	if err != nil || len(decodeJSONArray(t, out)) == 0 {
		t.Fatalf("runtime list = (%q, %v)", out, err)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "runtime", "refresh")
	if err != nil || len(decodeJSONArray(t, out)) == 0 {
		t.Fatalf("runtime refresh = (%q, %v)", out, err)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "runtime", "update", "claude", "--bin", "/usr/local/bin/claude", "--default-model", "claude-sonnet")
	if err != nil {
		t.Fatalf("runtime update: %v", err)
	}
	rtSettings, _ := decodeJSONObject(t, out)["settings"].(map[string]any)
	if rtSettings["binPath"] != "/usr/local/bin/claude" || rtSettings["defaultModel"] != "claude-sonnet" {
		t.Fatalf("unexpected runtime update settings: %#v", rtSettings)
	}

	// 5. memory create, list, search, update (gateway fallback), delete
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "memory", "create", "--path", "notes.md", "--body", "Prefer Go stdlib", "--scope", agentID)
	if err != nil {
		t.Fatalf("memory create: %v", err)
	}
	memID, _ := decodeJSONObject(t, out)["id"].(string)
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "memory", "list", "--scope", agentID)
	if err != nil {
		t.Fatalf("memory list: %v", err)
	}
	if mems, ok := decodeJSONObject(t, out)["memories"].([]any); !ok || len(mems) != 1 {
		t.Fatalf("unexpected memory list: %s", out)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "memory", "search", "stdlib", "--scope", agentID)
	if err != nil {
		t.Fatalf("memory search: %v", err)
	}
	if found, ok := decodeJSONObject(t, out)["found"].([]any); !ok || len(found) != 1 {
		t.Fatalf("unexpected memory search: %s", out)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "memory", "update", memID, "--body", "Prefer Go stdlib and sqlc", "--scope", agentID)
	if err != nil {
		t.Fatalf("memory update: %v", err)
	}
	updatedMem := decodeJSONObject(t, out)
	newMemID, _ := updatedMem["id"].(string)
	if updatedMem["text"] != "Prefer Go stdlib and sqlc" || newMemID == "" {
		t.Fatalf("unexpected memory update result: %#v", updatedMem)
	}
	if _, _, err := runVibe(t, vars, "", ts.Client(), "memory", "delete", newMemID, "--scope", agentID); err != nil {
		t.Fatalf("memory delete: %v", err)
	}

	// 6. cron create, list, update, run (gateway fallback), delete
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "cron", "create", "--name", "DailyCheck", "--schedule", "0 9 * * *", "--timezone", "UTC", "--prompt", "Check status", "--agent", agentID)
	if err != nil {
		t.Fatalf("cron create: %v", err)
	}
	cronID, _ := decodeJSONObject(t, out)["id"].(string)
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "cron", "list")
	if err != nil || len(decodeJSONArray(t, out)) != 1 {
		t.Fatalf("cron list = (%q, %v)", out, err)
	}
	if _, _, err := runVibe(t, vars, "", ts.Client(), "cron", "update", cronID, "--enabled=false"); err != nil {
		t.Fatalf("cron update: %v", err)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "cron", "run", cronID)
	if err != nil || decodeJSONObject(t, out)["ran"] != true {
		t.Fatalf("cron run = (%q, %v)", out, err)
	}
	if _, _, err := runVibe(t, vars, "", ts.Client(), "cron", "delete", cronID); err != nil {
		t.Fatalf("cron delete: %v", err)
	}

	// 7. artifact create (document & deck), list, get, markdown, delete
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "artifact", "create", "--title", "CLI Spec", "--kind", "document", "--markdown", "# Overview\n\nAll commands")
	if err != nil {
		t.Fatalf("artifact create: %v", err)
	}
	artID, _ := decodeJSONObject(t, out)["id"].(string)
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "artifact", "list")
	if err != nil || len(decodeJSONArray(t, out)) != 1 {
		t.Fatalf("artifact list = (%q, %v)", out, err)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "artifact", "get", artID)
	if err != nil || decodeJSONObject(t, out)["title"] != "CLI Spec" {
		t.Fatalf("artifact get = (%q, %v)", out, err)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "artifact", "markdown", artID)
	if err != nil || !strings.Contains(out, "Overview") || !strings.Contains(out, "All commands") {
		t.Fatalf("artifact markdown = (%q, %v)", out, err)
	}
	if _, _, err := runVibe(t, vars, "", ts.Client(), "artifact", "delete", artID); err != nil {
		t.Fatalf("artifact delete: %v", err)
	}
	for _, kindCase := range []struct {
		title string
		args  []string
	}{
		{"Canvas Board", []string{"--format", "json", "artifact", "create", "--title", "Canvas Board", "--kind", "canvas"}},
		{"Budget Sheet", []string{"--format", "json", "artifact", "create", "--title", "Budget Sheet", "--kind", "sheet"}},
		{"Pitch Deck", []string{"--format", "json", "artifact", "create", "--title", "Pitch Deck", "--kind", "deck", "--content", "<h1>Deck</h1>"}},
	} {
		out, _, err = runVibe(t, vars, "", ts.Client(), kindCase.args...)
		if err != nil {
			t.Fatalf("artifact create %s: %v", kindCase.title, err)
		}
		id, _ := decodeJSONObject(t, out)["id"].(string)
		if id == "" {
			t.Fatalf("artifact create %s missing id: %s", kindCase.title, out)
		}
		if _, _, err := runVibe(t, vars, "", ts.Client(), "artifact", "delete", id); err != nil {
			t.Fatalf("artifact delete %s: %v", id, err)
		}
	}

	// 8. worker status / list and session list / agent delete
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "worker", "status")
	if err != nil || decodeJSONObject(t, out)["totalSessions"] == nil {
		t.Fatalf("worker status = (%q, %v)", out, err)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "worker", "list")
	if err != nil || !strings.Contains(out, fmt.Sprintf("workers:")) {
		t.Fatalf("worker list = (%q, %v)", out, err)
	}
	out, _, err = runVibe(t, vars, "", ts.Client(), "--format", "json", "session", "list")
	if err != nil {
		t.Fatalf("session list = (%q, %v)", out, err)
	}
	if _, _, err := runVibe(t, vars, "", ts.Client(), "agent", "delete", agentID); err != nil {
		t.Fatalf("agent delete: %v", err)
	}
}

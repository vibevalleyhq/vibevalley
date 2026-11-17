package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
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

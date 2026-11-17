package lan

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

func TestLanServiceDefaultOffUpdateAndPairingFlow(t *testing.T) {
	t.Parallel()

	clk := store.NewFakeClock(time.Unix(1_700_000_000, 0))
	home := t.TempDir()

	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":      true,
			"outside": r.Header.Get(HeaderOutside),
			"device":  r.Header.Get(HeaderLANDevice),
			"path":    r.URL.Path,
		})
	})

	svc, err := NewService(Options{
		HomeDir:  home,
		Port:     0,
		BindHost: "127.0.0.1",
		Clock:    clk,
		Upstream: upstream,
		DeviceMinter: func(_ context.Context, name string) (DeviceMinted, error) {
			return DeviceMinted{Device: "dev-1", Key: "vvk_paired_secret"}, nil
		},
		TokenVerifier: func(token string) (AuthenticatedDevice, bool) {
			if token == "vvk_paired_secret" {
				return AuthenticatedDevice{ID: "dev-1", Name: "Phone", Came: "paired"}, true
			}
			return AuthenticatedDevice{}, false
		},
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	defer func() { _ = svc.Close() }()

	// Must start off by default.
	if st := svc.Get(); st.Open || st.URL != "" {
		t.Fatalf("expected LAN off by default, got %+v", st)
	}
	if _, err := svc.StartPairing(); !errors.Is(err, ErrLanForbidden) {
		t.Fatalf("expected ErrLanForbidden when starting pairing while closed, got %v", err)
	}

	// Enable with custom label & ephemeral port.
	open := true
	port0 := 0
	label := "MacStudio"
	st, err := svc.Update(context.Background(), UpdateRequest{Open: &open, Port: &port0, Label: &label})
	if err != nil {
		t.Fatalf("Update open: %v", err)
	}
	if !st.Open || st.HostName != "MacStudio" || st.URL == "" {
		t.Fatalf("unexpected open status: %+v", st)
	}

	// StartPairing emits 6-digit code, 2-min TTL, and QR pairing URI.
	pst, err := svc.StartPairing()
	if err != nil || pst.Pairing == nil {
		t.Fatalf("StartPairing: err=%v status=%+v", err, pst)
	}
	if !regexp.MustCompile(`^\d{6}$`).MatchString(pst.Pairing.Code) {
		t.Fatalf("expected 6-digit pairing code, got %q", pst.Pairing.Code)
	}
	parsedLink, err := url.Parse(pst.Pairing.Link)
	if err != nil || parsedLink.Path != "/pair" || parsedLink.Query().Get("c") != pst.Pairing.Code {
		t.Fatalf("unexpected pairing QR link: %q (err=%v)", pst.Pairing.Link, err)
	}
	if pst.Pairing.ExpiresAt-clk.NowMs() != int64((2*time.Minute)/time.Millisecond) {
		t.Fatalf("expected 2-min TTL, got %d ms", pst.Pairing.ExpiresAt-clk.NowMs())
	}

	if prev := svc.PreviewStop(); len(prev.Does) == 0 {
		t.Fatalf("expected PreviewStop steps")
	}

	// 5 wrong attempts invalidate the pairing code.
	for i := range 5 {
		_, err := svc.PairWithCode(context.Background(), "000000"+string(rune('x')), "Attacker")
		if !errors.Is(err, ErrLanForbidden) {
			t.Fatalf("wrong attempt %d: expected ErrLanForbidden, got %v", i, err)
		}
	}
	if svc.Get().Pairing != nil {
		t.Fatalf("expected pairing cleared after 5 failed attempts")
	}

	// Start fresh pairing and approve via AnswerPairing.
	pst2, err := svc.StartPairing()
	if err != nil || pst2.Pairing == nil {
		t.Fatalf("second StartPairing failed: %v", err)
	}
	type pairRes struct {
		paired LanPaired
		err    error
	}
	resCh := make(chan pairRes, 1)
	go func() {
		p, e := svc.PairWithCode(context.Background(), pst2.Pairing.Code, "  iPhone 16 ")
		resCh <- pairRes{paired: p, err: e}
	}()

	// Wait until asking is visible.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cur := svc.Get(); cur.Pairing != nil && cur.Pairing.Asking == "iPhone 16" {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if cur := svc.Get(); cur.Pairing == nil || cur.Pairing.Asking != "iPhone 16" {
		t.Fatalf("expected asking=iPhone 16, got %+v", cur.Pairing)
	}

	// Second concurrent PairWithCode must be rejected.
	if _, err := svc.PairWithCode(context.Background(), pst2.Pairing.Code, "Second"); !errors.Is(err, ErrLanForbidden) {
		t.Fatalf("expected concurrent pairing refusal, got %v", err)
	}

	if _, err := svc.AnswerPairing(true); err != nil {
		t.Fatalf("AnswerPairing: %v", err)
	}
	got := <-resCh
	if got.err != nil || got.paired.Key != "vvk_paired_secret" || got.paired.HostName != "MacStudio" {
		t.Fatalf("PairWithCode failed: err=%v paired=%+v", got.err, got.paired)
	}

	// Real HTTP call over the bound isolated listener verifies middleware + auth + header stripping.
	req, _ := http.NewRequest(http.MethodPost, st.URL+"/api/v1/issue/list", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer "+got.paired.Key)
	req.Header.Set(HeaderOutside, "spoofed")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("LAN HTTP request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200 over LAN listener, got %d: %s", resp.StatusCode, string(body))
	}
	var payload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload["outside"] != "1" || payload["device"] != "dev-1" {
		t.Fatalf("expected verified LAN headers, got %+v", payload)
	}

	// Close listener and verify port closes.
	closed := false
	stClosed, err := svc.Update(context.Background(), UpdateRequest{Open: &closed})
	if err != nil || stClosed.Open || stClosed.URL != "" {
		t.Fatalf("expected closed status, got err=%v st=%+v", err, stClosed)
	}
}

func TestLANMiddlewareRouteWhitelistAndBlockedRoutes(t *testing.T) {
	t.Parallel()

	upstreamCalled := 0
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalled++
		body, _ := io.ReadAll(r.Body)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"path": r.URL.Path,
			"body": string(body),
		})
	})

	verifier := func(token string) (AuthenticatedDevice, bool) {
		switch token {
		case "vvk_paired":
			return AuthenticatedDevice{ID: "dev-paired", Name: "Phone", Came: "paired"}, true
		case "vvk_login":
			return AuthenticatedDevice{ID: "dev-login", Name: "Laptop", Came: "login"}, true
		default:
			return AuthenticatedDevice{}, false
		}
	}

	mw := LANMiddleware(verifier, upstream)

	cases := []struct {
		name       string
		method     string
		target     string
		token      string
		cookie     string
		origin     string
		body       string
		wantStatus int
	}{
		{name: "unauth state blocked", method: http.MethodGet, target: "/api/v1/state", wantStatus: http.StatusUnauthorized},
		{name: "keyless pair page allowed", method: http.MethodGet, target: "/pair", wantStatus: http.StatusOK},
		{name: "keyless user.get allowed", method: http.MethodPost, target: "/api/v1/user/get", wantStatus: http.StatusOK},
		{name: "paired state allowed", method: http.MethodGet, target: "/api/v1/state", token: "vvk_paired", wantStatus: http.StatusOK},
		{name: "paired cookie attachment GET allowed", method: http.MethodGet, target: "/api/v1/attachment/" + strings.Repeat("a", 64), cookie: "vvk_paired", wantStatus: http.StatusOK},
		{name: "paired issue list allowed", method: http.MethodPost, target: "/api/v1/issue/list", token: "vvk_paired", wantStatus: http.StatusOK},
		{name: "paired library url add allowed", method: http.MethodPost, target: "/api/v1/library/item/add", token: "vvk_paired", body: `{"url":"https://example.com/a.png"}`, wantStatus: http.StatusOK},
		{name: "paired setting update forbidden", method: http.MethodPost, target: "/api/v1/setting/update", token: "vvk_paired", wantStatus: http.StatusForbidden},
		{name: "paired lan update forbidden", method: http.MethodPost, target: "/api/v1/lan/update", token: "vvk_paired", wantStatus: http.StatusForbidden},
		{name: "login setting update allowed", method: http.MethodPost, target: "/api/v1/setting/update", token: "vvk_login", wantStatus: http.StatusOK},
		{name: "login password set always forbidden over LAN", method: http.MethodPost, target: "/api/v1/user/password/set", token: "vvk_login", wantStatus: http.StatusForbidden},
		{name: "block mcp even with login token", method: http.MethodPost, target: "/mcp", token: "vvk_login", wantStatus: http.StatusForbidden},
		{name: "block mcp subpath", method: http.MethodGet, target: "/mcp/tools", token: "vvk_login", wantStatus: http.StatusForbidden},
		{name: "block chat completions", method: http.MethodPost, target: "/v1/chat/completions", token: "vvk_login", wantStatus: http.StatusForbidden},
		{name: "block machine ws", method: http.MethodGet, target: "/machine/ws", token: "vvk_login", wantStatus: http.StatusForbidden},
		{name: "block egress", method: http.MethodPost, target: "/egress/openai", token: "vvk_login", wantStatus: http.StatusForbidden},
		{name: "block path traversal to mcp", method: http.MethodPost, target: "/api/v1/../../mcp", token: "vvk_login", wantStatus: http.StatusForbidden},
		{name: "block local-path media import on library add", method: http.MethodPost, target: "/api/v1/library/item/add", token: "vvk_login", body: `{"path":"/etc/passwd"}`, wantStatus: http.StatusForbidden},
		{name: "block media.input.create over LAN", method: http.MethodPost, target: "/api/v1/media/input/create", token: "vvk_login", body: `{}`, wantStatus: http.StatusForbidden},
		{name: "block cross-origin API request", method: http.MethodPost, target: "/api/v1/issue/list", token: "vvk_paired", origin: "https://evil.example", wantStatus: http.StatusForbidden},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var bodyReader io.Reader
			if tc.body != "" {
				bodyReader = strings.NewReader(tc.body)
			}
			req := httptest.NewRequest(tc.method, "http://192.168.1.10:8790"+tc.target, bodyReader)
			if tc.token != "" {
				req.Header.Set("Authorization", "Bearer "+tc.token)
			}
			if tc.cookie != "" {
				req.Header.Set("Cookie", DeviceKeyCookie+"="+tc.cookie)
			}
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			rec := httptest.NewRecorder()
			mw.ServeHTTP(rec, req)
			if rec.Code != tc.wantStatus {
				t.Fatalf("%s: expected HTTP %d, got %d (body=%s)", tc.name, tc.wantStatus, rec.Code, rec.Body.String())
			}
		})
	}

	// Verify AllowRemoteRequest helper directly as well.
	blockedReq := httptest.NewRequest(http.MethodPost, "http://lan/mcp", nil)
	if allowed, _ := AllowRemoteRequest(blockedReq, "login"); allowed {
		t.Fatalf("AllowRemoteRequest should block /mcp")
	}
	okReq := httptest.NewRequest(http.MethodGet, "http://lan/api/v1/state", nil)
	if allowed, reason := AllowRemoteRequest(okReq, "paired"); !allowed {
		t.Fatalf("AllowRemoteRequest should allow /api/v1/state for paired device: %s", reason)
	}
	if upstreamCalled == 0 {
		t.Fatalf("expected allowed cases to reach upstream")
	}
}

func TestLanPairingDenialStopAndTTLExpiry(t *testing.T) {
	t.Parallel()

	clk := store.NewFakeClock(time.Unix(1_700_000_000, 0))
	svc, err := NewService(Options{
		BindHost: "127.0.0.1",
		Port:     0,
		Clock:    clk,
		DeviceMinter: func(_ context.Context, name string) (DeviceMinted, error) {
			return DeviceMinted{Device: "d", Key: "k"}, nil
		},
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	defer func() { _ = svc.Close() }()

	if _, err := svc.SetOpen(context.Background(), true); err != nil {
		t.Fatalf("SetOpen: %v", err)
	}

	// AnswerPairing(false) denies PairWithCode cleanly.
	pst, err := svc.StartPairing()
	if err != nil || pst.Pairing == nil {
		t.Fatalf("StartPairing: %v", err)
	}
	errCh := make(chan error, 1)
	go func() {
		_, e := svc.PairWithCode(context.Background(), pst.Pairing.Code, "Stranger")
		errCh <- e
	}()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cur := svc.Get(); cur.Pairing != nil && cur.Pairing.Asking == "Stranger" {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, err := svc.AnswerPairing(false); err != nil {
		t.Fatalf("AnswerPairing(false): %v", err)
	}
	if gotErr := <-errCh; !errors.Is(gotErr, ErrLanForbidden) {
		t.Fatalf("expected ErrLanForbidden on denied pairing, got %v", gotErr)
	}

	// Pairing expires past 2 minutes TTL, and StopPairing clears active pairing.
	pst2, err := svc.StartPairing()
	if err != nil || pst2.Pairing == nil {
		t.Fatalf("StartPairing 2: %v", err)
	}
	clk.Advance(2*time.Minute + time.Second)
	if _, err := svc.PairWithCode(context.Background(), pst2.Pairing.Code, "Late"); !errors.Is(err, ErrLanForbidden) {
		t.Fatalf("expected ErrLanForbidden after 2-min TTL, got %v", err)
	}
	if _, err := svc.StartPairing(); err != nil {
		t.Fatalf("StartPairing 3: %v", err)
	}
	if st := svc.StopPairing(); st.Pairing != nil {
		t.Fatalf("expected pairing cleared after StopPairing, got %+v", st.Pairing)
	}
}

package lan_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibevalley/internal/handler"
	"vibevalley/internal/lan"
	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/internal/workspace"
)

// Its lan listener is on loopback and calls 127.0.0.1 its network address.
func lanTestWorkspace(t *testing.T, db string) *workspace.Workspace {
	t.Helper()
	cfg := fixture.Config(t.TempDir(), t.TempDir(), db)
	cfg.Voice.Line.Port, cfg.Lan.Port = 0, 0
	f, err := workspace.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	f.Project.GitHubProbe = fixture.NoGitHub
	handler.New(f)
	lan.LanOnLoopback(f.Lan)
	if err := f.Lan.OnStart(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	return f
}

func lanOpen(t *testing.T, f *workspace.Workspace) string {
	t.Helper()
	s, err := f.Lan.SetOpen(true)
	if err != nil {
		t.Fatal(err)
	}
	if !s.Open || s.URL == nil || s.Problem != nil {
		t.Fatalf("opened: %+v", s)
	}
	return *s.URL
}

func lanRequest(t *testing.T, method, url, key string, body any) (int, []byte) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, url, reader)
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	return res.StatusCode, out
}

func lanAsk(t *testing.T, addr, code, name string) <-chan []byte {
	t.Helper()
	got := make(chan []byte, 1)
	go func() {
		raw, _ := json.Marshal(protocol.LanPairRequest{Code: code, Name: name})
		res, err := http.Post(addr+"/api/v1/lan/pair", "application/json", bytes.NewReader(raw))
		if err != nil {
			got <- []byte(err.Error())
			return
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		got <- body
	}()
	return got
}

func lanWaitAsking(t *testing.T, f *workspace.Workspace, name string) {
	t.Helper()
	testkit.Until(t, name+" asks", func() bool {
		p := f.Lan.Status().Pairing
		return p != nil && p.Asking != nil && *p.Asking == name
	})
}

func lanPair(t *testing.T, f *workspace.Workspace, addr, name string) protocol.LanPaired {
	t.Helper()
	s, err := f.Lan.StartPairing()
	if err != nil {
		t.Fatal(err)
	}
	link, _ := url.Parse(s.Pairing.Link)
	if link.Scheme != "vibevalley" || link.Host != "pair" || link.Query().Get("u") != addr || link.Query().Get("c") != s.Pairing.Code {
		t.Fatalf("link: %s", s.Pairing.Link)
	}
	got := lanAsk(t, addr, strings.ToLower(s.Pairing.Code), name)
	lanWaitAsking(t, f, lan.LanDeviceName(name))
	if _, err := f.Lan.Answer(true); err != nil {
		t.Fatal(err)
	}
	var paired protocol.LanPaired
	if err := json.Unmarshal(<-got, &paired); err != nil || paired.Key == "" || paired.Device == "" {
		t.Fatalf("paired: %+v %v", paired, err)
	}
	return paired
}

func TestLanShutUntilOpened(t *testing.T) {
	f := lanTestWorkspace(t, ":memory:")
	if s := f.Lan.Status(); s.Open || s.URL != nil || len(s.Devices) != 0 {
		t.Fatalf("a new workspace's lan access: %+v", s)
	}
	var refused protocol.LanRefused
	if _, err := f.Lan.StartPairing(); !errors.As(err, &refused) {
		t.Fatalf("pairing with lan access shut: %v", err)
	}
	addr := lanOpen(t, f)
	if code, _ := lanRequest(t, "GET", addr+"/api/v1/health", "", nil); code != http.StatusUnauthorized {
		t.Fatalf("health without a key: %d", code)
	}
	if _, err := f.Lan.SetOpen(false); err != nil {
		t.Fatal(err)
	}
	if _, err := http.Get(addr + "/api/v1/health"); err == nil {
		t.Fatal("the lan listener still answers once shut")
	}
}

func TestLanPairedDeviceUsesTheWorkspace(t *testing.T) {
	f := lanTestWorkspace(t, ":memory:")
	addr := lanOpen(t, f)
	paired := lanPair(t, f, addr, "  小明的\niPhone ")
	if s := f.Lan.Status(); s.Pairing != nil || len(s.Devices) != 1 || s.Devices[0].Name != "小明的 iPhone" {
		t.Fatalf("after pairing: %+v", s)
	}

	if code, body := lanRequest(t, "GET", addr+"/api/v1/health", paired.Key, nil); code != 200 || !strings.Contains(string(body), `"ok":true`) {
		t.Fatalf("health: %d %s", code, body)
	}
	code, body := lanRequest(t, "GET", addr+"/api/v1/lan/me", paired.Key, nil)
	var me protocol.LanDevice
	if json.Unmarshal(body, &me); code != 200 || me.ID != paired.Device || me.LastSeen == nil {
		t.Fatalf("me: %d %s", code, body)
	}
	for _, path := range []string{"/mcp", "/", "/index.html"} {
		if code, _ := lanRequest(t, "GET", addr+path, paired.Key, nil); code != http.StatusNotFound {
			t.Fatalf("%s: %d", path, code)
		}
	}
	for _, c := range []struct{ method, path string }{{"GET", "/api/v1/lan"}, {"PUT", "/api/v1/lan"}, {"POST", "/api/v1/lan/pairing"}, {"DELETE", "/api/v1/lan/devices/" + paired.Device},
		// What configures the farm stays on this computer: keys, a runtime's command, profiles, skills, chat accounts.
		{"PUT", "/api/v1/settings"}, {"PUT", "/api/v1/runtimes/codex/settings"}, {"POST", "/api/v1/agents"}, {"PUT", "/api/v1/skills/s1"},
		{"POST", "/api/v1/connectors/weixin/login"}} {
		if code, body := lanRequest(t, c.method, addr+c.path, paired.Key, map[string]bool{"open": false}); code != http.StatusForbidden || !strings.Contains(string(body), "LanRefused") {
			t.Fatalf("%s %s: %d %s", c.method, c.path, code, body)
		}
	}
	if code, _ := lanRequest(t, "GET", addr+"/api/v1/health", paired.Key+"x", nil); code != http.StatusUnauthorized {
		t.Fatalf("a wrong key: %d", code)
	}
	if _, err := f.Lan.Me(context.Background()); err == nil {
		t.Fatal("me on this machine")
	}
}

func TestLanOwnerRefuses(t *testing.T) {
	f := lanTestWorkspace(t, ":memory:")
	addr := lanOpen(t, f)
	s, _ := f.Lan.StartPairing()
	got := lanAsk(t, addr, s.Pairing.Code, "陌生人")
	lanWaitAsking(t, f, "陌生人")
	if body := <-lanAsk(t, addr, s.Pairing.Code, "又一个"); !strings.Contains(string(body), "另一台设备") {
		t.Fatalf("a second device: %s", body)
	}
	if _, err := f.Lan.Answer(false); err != nil {
		t.Fatal(err)
	}
	if body := <-got; !strings.Contains(string(body), "LanRefused") || !strings.Contains(string(body), "没让") {
		t.Fatalf("refused: %s", body)
	}
	if s := f.Lan.Status(); s.Pairing != nil || len(s.Devices) != 0 {
		t.Fatalf("after refusing: %+v", s)
	}
}

func TestLanWrongCodesCallItOff(t *testing.T) {
	f := lanTestWorkspace(t, ":memory:")
	addr := lanOpen(t, f)
	s, _ := f.Lan.StartPairing()
	for range lan.LanWrongTries {
		if body := <-lanAsk(t, addr, "WRONGCODE", "猜码的"); !strings.Contains(string(body), "配对码不对") {
			t.Fatalf("a wrong code: %s", body)
		}
	}
	if body := <-lanAsk(t, addr, s.Pairing.Code, "猜码的"); !strings.Contains(string(body), "过期") {
		t.Fatalf("the right code after too many wrong ones: %s", body)
	}
}

func TestLanCodeExpires(t *testing.T) {
	f := lanTestWorkspace(t, ":memory:")
	lanOpen(t, f)
	s, _ := f.Lan.StartPairing()
	start := time.Now()
	lan.LanAt(f.Lan, func() time.Time { return start.Add(lan.LanPairingFor + time.Second) })
	if got := f.Lan.Status(); got.Pairing != nil {
		t.Fatalf("an expired code is still shown: %+v", got.Pairing)
	}
	var refused protocol.LanRefused
	if _, err := f.Lan.Pair(context.Background(), s.Pairing.Code, "晚了"); !errors.As(err, &refused) || !strings.Contains(refused.Reason, "过期") {
		t.Fatalf("pairing late: %v", err)
	}
}

func TestLanForgetEndsTheDevicesStreams(t *testing.T) {
	f := lanTestWorkspace(t, ":memory:")
	addr := lanOpen(t, f)
	paired := lanPair(t, f, addr, "旧手机")
	req, _ := http.NewRequest("GET", addr+"/api/v1/state", nil)
	req.Header.Set("Authorization", "Bearer "+paired.Key)
	res, err := http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("the state stream: %v %v", res, err)
	}
	defer res.Body.Close()
	lines := bufio.NewReader(res.Body)
	if line, err := lines.ReadString('\n'); err != nil || !strings.HasPrefix(line, "data:") {
		t.Fatalf("the first frame: %q %v", line, err)
	}
	ended := make(chan struct{})
	go func() {
		io.Copy(io.Discard, lines)
		close(ended)
	}()
	if s, err := f.Lan.Forget(paired.Device); err != nil || len(s.Devices) != 0 {
		t.Fatalf("forget: %+v %v", s, err)
	}
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("the stream outlived its device")
	}
	if code, _ := lanRequest(t, "GET", addr+"/api/v1/health", paired.Key, nil); code != http.StatusUnauthorized {
		t.Fatalf("a forgotten key: %d", code)
	}
}

func TestLanRemembersAcrossRestarts(t *testing.T) {
	db := filepath.Join(t.TempDir(), "vibevalley.db")
	f := lanTestWorkspace(t, db)
	paired := lanPair(t, f, lanOpen(t, f), "平板")

	again := lanTestWorkspace(t, db)
	s := again.Lan.Status()
	if !s.Open || s.URL == nil || len(s.Devices) != 1 || s.Devices[0].ID != paired.Device {
		t.Fatalf("after a restart: %+v", s)
	}
	if code, _ := lanRequest(t, "GET", *s.URL+"/api/v1/health", paired.Key, nil); code != 200 {
		t.Fatalf("the old key after a restart: %d", code)
	}
}

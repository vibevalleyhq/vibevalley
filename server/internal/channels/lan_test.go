package channels_test

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

	"vibevalley/internal/base"
	"vibevalley/internal/channels"
	"vibevalley/internal/farm"
	"vibevalley/internal/handler"
	"vibevalley/internal/protocol"
)

// lanTestFarm is a farm whose gate answers the farm's API (handler.New hands it over), listens on loopback, on any port, and calls 127.0.0.1 its network address.
func lanTestFarm(t *testing.T, db string) *farm.Farm {
	t.Helper()
	t.Setenv("VIBEVALLEY_VOICE_LINE_PORT", "0")
	t.Setenv("VIBEVALLEY_LAN_PORT", "0")
	f, err := farm.New(base.Config{Home: t.TempDir(), WorkRoot: t.TempDir(), DBPath: db})
	if err != nil {
		t.Fatal(err)
	}
	handler.New(f)
	channels.LanOnLoopback(f.Lan)
	if err := f.Lan.OnStart(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	return f
}

func lanOpen(t *testing.T, f *farm.Farm) string {
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

// lanAsk sends the code from a device and returns what it gets once the owner answers.
func lanAsk(t *testing.T, gate, code, name string) <-chan []byte {
	t.Helper()
	got := make(chan []byte, 1)
	go func() {
		raw, _ := json.Marshal(protocol.LanPairRequest{Code: code, Name: name})
		res, err := http.Post(gate+"/api/lan/pair", "application/json", bytes.NewReader(raw))
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

func lanWaitAsking(t *testing.T, f *farm.Farm, name string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if p := f.Lan.Status().Pairing; p != nil && p.Asking != nil && *p.Asking == name {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s never asked", name)
}

// lanPair pairs a device through the gate and returns its key.
func lanPair(t *testing.T, f *farm.Farm, gate, name string) protocol.LanPaired {
	t.Helper()
	s, err := f.Lan.StartPairing()
	if err != nil {
		t.Fatal(err)
	}
	link, _ := url.Parse(s.Pairing.Link)
	if link.Scheme != "vibevalley" || link.Host != "pair" || link.Query().Get("u") != gate || link.Query().Get("c") != s.Pairing.Code {
		t.Fatalf("link: %s", s.Pairing.Link)
	}
	got := lanAsk(t, gate, strings.ToLower(s.Pairing.Code), name)
	lanWaitAsking(t, f, channels.LanDeviceName(name))
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
	f := lanTestFarm(t, ":memory:")
	if s := f.Lan.Status(); s.Open || s.URL != nil || len(s.Devices) != 0 {
		t.Fatalf("a new farm's gate: %+v", s)
	}
	var refused protocol.LanRefused
	if _, err := f.Lan.StartPairing(); !errors.As(err, &refused) {
		t.Fatalf("pairing with the gate shut: %v", err)
	}
	gate := lanOpen(t, f)
	if code, _ := lanRequest(t, "GET", gate+"/api/health", "", nil); code != http.StatusUnauthorized {
		t.Fatalf("health without a key: %d", code)
	}
	if _, err := f.Lan.SetOpen(false); err != nil {
		t.Fatal(err)
	}
	if _, err := http.Get(gate + "/api/health"); err == nil {
		t.Fatal("the gate still answers once shut")
	}
}

func TestLanPairedDeviceUsesTheFarm(t *testing.T) {
	f := lanTestFarm(t, ":memory:")
	gate := lanOpen(t, f)
	paired := lanPair(t, f, gate, "  小明的\niPhone ")
	if s := f.Lan.Status(); s.Pairing != nil || len(s.Devices) != 1 || s.Devices[0].Name != "小明的 iPhone" {
		t.Fatalf("after pairing: %+v", s)
	}

	if code, body := lanRequest(t, "GET", gate+"/api/health", paired.Key, nil); code != 200 || !strings.Contains(string(body), `"ok":true`) {
		t.Fatalf("health: %d %s", code, body)
	}
	code, body := lanRequest(t, "GET", gate+"/api/lan/me", paired.Key, nil)
	var me protocol.LanDevice
	if json.Unmarshal(body, &me); code != 200 || me.ID != paired.Device || me.LastSeen == nil {
		t.Fatalf("me: %d %s", code, body)
	}
	// Not through the gate: the helpers' tools, the page, the gate's own settings.
	for _, path := range []string{"/mcp", "/", "/index.html"} {
		if code, _ := lanRequest(t, "GET", gate+path, paired.Key, nil); code != http.StatusNotFound {
			t.Fatalf("%s: %d", path, code)
		}
	}
	for _, c := range []struct{ method, path string }{{"GET", "/api/lan"}, {"PUT", "/api/lan"}, {"POST", "/api/lan/pairing"}, {"DELETE", "/api/lan/devices/" + paired.Device}} {
		if code, body := lanRequest(t, c.method, gate+c.path, paired.Key, map[string]bool{"open": false}); code != http.StatusForbidden || !strings.Contains(string(body), "LanRefused") {
			t.Fatalf("%s %s: %d %s", c.method, c.path, code, body)
		}
	}
	if code, _ := lanRequest(t, "GET", gate+"/api/health", paired.Key+"x", nil); code != http.StatusUnauthorized {
		t.Fatalf("a wrong key: %d", code)
	}
	if _, err := f.Lan.Me(context.Background()); err == nil {
		t.Fatal("me on this machine")
	}
}

func TestLanOwnerRefuses(t *testing.T) {
	f := lanTestFarm(t, ":memory:")
	gate := lanOpen(t, f)
	s, _ := f.Lan.StartPairing()
	got := lanAsk(t, gate, s.Pairing.Code, "陌生人")
	lanWaitAsking(t, f, "陌生人")
	// One device at a time.
	if body := <-lanAsk(t, gate, s.Pairing.Code, "又一个"); !strings.Contains(string(body), "另一台设备") {
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
	f := lanTestFarm(t, ":memory:")
	gate := lanOpen(t, f)
	s, _ := f.Lan.StartPairing()
	for range channels.LanWrongTries {
		if body := <-lanAsk(t, gate, "WRONGCODE", "猜码的"); !strings.Contains(string(body), "配对码不对") {
			t.Fatalf("a wrong code: %s", body)
		}
	}
	if body := <-lanAsk(t, gate, s.Pairing.Code, "猜码的"); !strings.Contains(string(body), "过期") {
		t.Fatalf("the right code after too many wrong ones: %s", body)
	}
}

func TestLanCodeExpires(t *testing.T) {
	f := lanTestFarm(t, ":memory:")
	lanOpen(t, f)
	s, _ := f.Lan.StartPairing()
	start := time.Now()
	channels.LanAt(f.Lan, func() time.Time { return start.Add(channels.LanPairingFor + time.Second) })
	if got := f.Lan.Status(); got.Pairing != nil {
		t.Fatalf("an expired code is still shown: %+v", got.Pairing)
	}
	var refused protocol.LanRefused
	if _, err := f.Lan.Pair(context.Background(), s.Pairing.Code, "晚了"); !errors.As(err, &refused) || !strings.Contains(refused.Reason, "过期") {
		t.Fatalf("pairing late: %v", err)
	}
}

func TestLanForgetEndsTheDevicesStreams(t *testing.T) {
	f := lanTestFarm(t, ":memory:")
	gate := lanOpen(t, f)
	paired := lanPair(t, f, gate, "旧手机")
	req, _ := http.NewRequest("GET", gate+"/api/site/state", nil)
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
	if code, _ := lanRequest(t, "GET", gate+"/api/health", paired.Key, nil); code != http.StatusUnauthorized {
		t.Fatalf("a forgotten key: %d", code)
	}
}

func TestLanRemembersAcrossRestarts(t *testing.T) {
	db := filepath.Join(t.TempDir(), "farm.db")
	f := lanTestFarm(t, db)
	paired := lanPair(t, f, lanOpen(t, f), "平板")

	again := lanTestFarm(t, db)
	s := again.Lan.Status()
	if !s.Open || s.URL == nil || len(s.Devices) != 1 || s.Devices[0].ID != paired.Device {
		t.Fatalf("after a restart: %+v", s)
	}
	if code, _ := lanRequest(t, "GET", *s.URL+"/api/health", paired.Key, nil); code != 200 {
		t.Fatalf("the old key after a restart: %d", code)
	}
}

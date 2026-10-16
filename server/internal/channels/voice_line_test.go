package channels

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func voiceServeLine(t *testing.T, call func(ctx context.Context, text string) <-chan string) string {
	t.Helper()
	keyOf := func(id string) string {
		if id == "c1" {
			return "k1"
		}
		return ""
	}
	server := httptest.NewServer(voiceLineAnswer(keyOf, call, nil))
	t.Cleanup(server.Close)
	return server.URL
}

func voiceAsk(t *testing.T, ctx context.Context, baseURL, path, key string, messages any) *http.Response {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"model": "x", "stream": true, "messages": messages})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+path, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func voiceWords(words ...string) <-chan string {
	out := make(chan string, len(words))
	for _, w := range words {
		out <- w
	}
	close(out)
	return out
}

func TestVoiceLineTakesTheNewestThingSaid(t *testing.T) {
	var body any
	json.Unmarshal([]byte(`{"messages":[{"role":"system","content":"你是管家"},{"role":"user","content":"旧的"},{"role":"assistant","content":"好"},{"role":"user","content":" 让老周跑测试 "}]}`), &body)
	if got := voiceLastUserText(body); got != "让老周跑测试" {
		t.Fatal(got)
	}
	json.Unmarshal([]byte(`{"messages":[{"role":"user","content":[{"type":"text","text":"看看"},{"type":"image_url"},{"type":"text","text":"进度"}]}]}`), &body)
	if got := voiceLastUserText(body); got != "看看进度" {
		t.Fatal(got)
	}
	json.Unmarshal([]byte(`{"messages":[{"role":"assistant","content":"好"}]}`), &body)
	if got := voiceLastUserText(body); got != "" {
		t.Fatal(got)
	}
	if got := voiceLastUserText(nil); got != "" {
		t.Fatal(got)
	}
}

func TestVoiceLineChunksAreOpenAIs(t *testing.T) {
	var first, stop any
	json.Unmarshal([]byte(strings.TrimPrefix(voiceSSEChunk("id1", 7, "好", false, true), "data: ")), &first)
	var want any
	json.Unmarshal([]byte(`{"id":"id1","object":"chat.completion.chunk","created":7,"model":"vibevalley-manager","choices":[{"index":0,"delta":{"role":"assistant","content":"好"},"finish_reason":null}]}`), &want)
	if !reflect.DeepEqual(first, want) {
		t.Fatalf("first: %v", first)
	}
	json.Unmarshal([]byte(strings.TrimPrefix(voiceSSEChunk("id1", 7, "", true, false), "data: ")), &stop)
	choice := stop.(map[string]any)["choices"].([]any)[0]
	if !reflect.DeepEqual(choice, map[string]any{"index": float64(0), "delta": map[string]any{}, "finish_reason": "stop"}) {
		t.Fatalf("stop: %v", choice)
	}
}

func TestVoiceLineLetsOnlyThisCallsKeyIn(t *testing.T) {
	var mu sync.Mutex
	var heard []string
	baseURL := voiceServeLine(t, func(_ context.Context, text string) <-chan string {
		mu.Lock()
		heard = append(heard, text)
		mu.Unlock()
		return voiceWords("好，", "让老周去跑。\n")
	})
	ctx := context.Background()
	for _, c := range []struct{ path, key string }{{"/llm/c1/chat/completions", ""}, {"/llm/c1/chat/completions", "k2"}, {"/llm/c9/chat/completions", "k1"}} {
		if res := voiceAsk(t, ctx, baseURL, c.path, c.key, []any{}); res.StatusCode != 401 {
			t.Fatalf("%s %s: %d", c.path, c.key, res.StatusCode)
		}
	}
	if res := voiceAsk(t, ctx, baseURL, "/api/settings", "k1", []any{}); res.StatusCode != 404 {
		t.Fatalf("nothing else of the farm is here: %d", res.StatusCode)
	}
	res := voiceAsk(t, ctx, baseURL, "/llm/c1/chat/completions", "k1", []any{
		map[string]any{"role": "user", "content": "旧的"},
		map[string]any{"role": "user", "content": "让老周跑测试"},
	})
	if res.StatusCode != 200 || !strings.Contains(res.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("%d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	raw, _ := io.ReadAll(res.Body)
	var events []string
	for _, e := range strings.Split(string(raw), "\n\n") {
		if e != "" {
			events = append(events, e)
		}
	}
	if events[len(events)-1] != "data: [DONE]" {
		t.Fatalf("last: %q", events[len(events)-1])
	}
	var contents []any
	var last map[string]any
	for _, e := range events[:len(events)-1] {
		var chunk map[string]any
		json.Unmarshal([]byte(strings.TrimPrefix(e, "data: ")), &chunk)
		last = chunk["choices"].([]any)[0].(map[string]any)
		contents = append(contents, last["delta"].(map[string]any)["content"])
	}
	if !reflect.DeepEqual(contents, []any{"好，", "让老周去跑。\n", nil}) || last["finish_reason"] != "stop" {
		t.Fatalf("words: %v %v", contents, last)
	}
	if !reflect.DeepEqual(heard, []string{"让老周跑测试"}) {
		t.Fatalf("heard: %v", heard)
	}
}

func TestVoiceLineDroppedRequestStopsItsWords(t *testing.T) {
	stopped := make(chan struct{})
	baseURL := voiceServeLine(t, func(ctx context.Context, _ string) <-chan string {
		out := make(chan string)
		go func() {
			defer close(stopped)
			out <- "我看一下"
			<-ctx.Done()
		}()
		return out
	})
	ctx, cancel := context.WithCancel(context.Background())
	res := voiceAsk(t, ctx, baseURL, "/llm/c1/chat/completions", "k1", []any{map[string]any{"role": "user", "content": "在吗"}})
	line, _ := bufio.NewReader(res.Body).ReadString('\n')
	if !strings.Contains(line, "我看一下") {
		t.Fatalf("first: %q", line)
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("the words go on")
	}
}

func TestVoiceLineOpensAndClosesCalls(t *testing.T) {
	f := voiceTestFarm(t)
	f.VoiceLine.call = func(context.Context, string) <-chan string { return voiceWords("在。") }
	if _, err := f.VoiceLine.Open(); err == nil {
		t.Fatal("not listening yet")
	}
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	line, err := f.VoiceLine.Open()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(line.URL, "https://line.example.com/llm/"+line.ID+"/") || line.Key == "" {
		t.Fatalf("line: %+v", line)
	}
	local := "http://127.0.0.1:" + strconv.Itoa(f.VoiceLine.port)
	res := voiceAsk(t, context.Background(), local, "/llm/"+line.ID+"/chat/completions", line.Key, []any{map[string]any{"role": "user", "content": "在吗"}})
	if body, _ := io.ReadAll(res.Body); res.StatusCode != 200 || !strings.Contains(string(body), "在。") {
		t.Fatalf("%d %s", res.StatusCode, body)
	}
	f.VoiceLine.Close(line.ID)
	if res := voiceAsk(t, context.Background(), local, "/llm/"+line.ID+"/chat/completions", line.Key, []any{}); res.StatusCode != 401 {
		t.Fatalf("a closed call's key: %d", res.StatusCode)
	}
}

func TestVoiceLineQuickTunnelLingersAfterTheLastCall(t *testing.T) {
	f := voiceTestFarm(t)
	f.VoiceLine.url = ""
	opened, closed := 0, 0
	f.VoiceLine.openTunnel = func(int) (*voiceTunnel, error) {
		opened++
		return &voiceTunnel{url: "https://quick.trycloudflare.com", close: func() { closed++ }}, nil
	}
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	a, err := f.VoiceLine.Open()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := f.VoiceLine.Open()
	if opened != 1 || !strings.HasPrefix(a.URL, "https://quick.trycloudflare.com/llm/") {
		t.Fatalf("one tunnel for both: %d %s", opened, a.URL)
	}
	f.VoiceLine.Close(a.ID)
	f.VoiceLine.tmu.Lock()
	lingering := f.VoiceLine.closing != nil
	f.VoiceLine.tmu.Unlock()
	if lingering {
		t.Fatal("a call is still on")
	}
	f.VoiceLine.Close(b.ID)
	f.VoiceLine.tmu.Lock()
	lingering = f.VoiceLine.closing != nil && f.VoiceLine.tunnel != nil
	f.VoiceLine.tmu.Unlock()
	if !lingering || closed != 0 {
		t.Fatal("the tunnel lingers after the last call")
	}
	if _, err := f.VoiceLine.Open(); err != nil || opened != 1 {
		t.Fatalf("reopened: %d %v", opened, err)
	}
}

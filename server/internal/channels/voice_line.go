package channels

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/manager"
)

// The voice line (ported from the TypeScript server's voice-line.ts, removed): Agora's Conversational AI asks the farm's own manager instead of a
// hosted LLM. A listener of its own (VIBEVALLEY_VOICE_LINE_PORT, default 8788, on 127.0.0.1) serves one thing only,
// OpenAI's chat completions at /llm/<call>/chat/completions, streamed; nothing else of the farm is reachable through
// it. Agora's cloud reaches it through a tunnel: VIBEVALLEY_VOICE_LINE_URL when you run your own, else a cloudflared quick
// tunnel opened for the first call (waited for until it answers) and closed ten minutes after the last. Each call has
// a key of its own, good until the call ends; a request without it is refused. Only the newest thing said is taken
// from the request: the manager keeps the conversation itself.
// Rationale: .agents/notes/implemented/feature/2026-10-10-voice-through-our-manager.md.

// voiceLineModel is the model name the line answers as.
const voiceLineModel = "vibevalley-manager"

const (
	// voiceLineReady: a new quick tunnel's address takes a while to answer (seen: about 25 s); this long at most is waited.
	voiceLineReady = 60 * time.Second
	// voiceLineLinger: the tunnel stays up this long after the last call, so calling again does not wait for a new one.
	voiceLineLinger = 10 * time.Minute
	// voiceLineMisheard is said when a request carries nothing the person said.
	voiceLineMisheard = "嗯？我没听清，你再说一遍？"
)

// voiceLastUserText is the newest thing the person said in an OpenAI chat request; empty when there is none.
func voiceLastUserText(body any) string {
	obj, _ := body.(map[string]any)
	messages, ok := obj["messages"].([]any)
	if !ok {
		return ""
	}
	for i := len(messages) - 1; i >= 0; i-- {
		m, _ := messages[i].(map[string]any)
		if m["role"] != "user" {
			continue
		}
		switch content := m["content"].(type) {
		case string:
			return strings.TrimSpace(content)
		case []any:
			var b strings.Builder
			for _, part := range content {
				p, _ := part.(map[string]any)
				if text, ok := p["text"].(string); ok && p["type"] == "text" {
					b.WriteString(text)
				}
			}
			return strings.TrimSpace(b.String())
		}
		return ""
	}
	return ""
}

// voiceSSEChunk is one server-sent chunk of a streamed chat completion: some words, or the end (stop).
func voiceSSEChunk(id string, created int64, content string, stop, first bool) string {
	delta := map[string]any{}
	var finish any
	if stop {
		finish = "stop"
	} else {
		if first {
			delta["role"] = "assistant"
		}
		delta["content"] = content
	}
	type choice struct {
		Index        int            `json:"index"`
		Delta        map[string]any `json:"delta"`
		FinishReason any            `json:"finish_reason"`
	}
	body, _ := json.Marshal(struct {
		ID      string   `json:"id"`
		Object  string   `json:"object"`
		Created int64    `json:"created"`
		Model   string   `json:"model"`
		Choices []choice `json:"choices"`
	}{id, "chat.completion.chunk", created, voiceLineModel, []choice{{0, delta, finish}}})
	return "data: " + string(body) + "\n\n"
}

var voiceLineRoute = regexp.MustCompile(`^/llm/([\w-]+)/chat/completions$`)

// voiceLineAnswer is the line's one handler: who may ask, what was said, the manager's words streamed back. call's
// words stop when its context ends: Agora hangs up on an answer when the person talks over it.
func voiceLineAnswer(keyOf func(call string) string, call func(ctx context.Context, text string) <-chan string, logf func(string, ...any)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := voiceLineRoute.FindStringSubmatch(r.URL.Path)
		if r.Method != http.MethodPost || route == nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if key := keyOf(route[1]); key == "" || r.Header.Get("Authorization") != "Bearer "+key {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			io.WriteString(w, `{"error":{"message":"unauthorized"}}`)
			return
		}
		asked := time.Now()
		var body any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		text := voiceLastUserText(body)
		flusher, _ := w.(http.Flusher)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		raw := make([]byte, 6)
		rand.Read(raw)
		id := "chatcmpl-" + hex.EncodeToString(raw)
		created := asked.Unix()
		send := func(s string) bool {
			if _, err := io.WriteString(w, s); err != nil {
				return false
			}
			if flusher != nil {
				flusher.Flush()
			}
			return true
		}
		var words <-chan string
		if text != "" {
			words = call(r.Context(), text)
		} else {
			misheard := make(chan string, 1)
			misheard <- voiceLineMisheard
			close(misheard)
			words = misheard
		}
		first := true
		for {
			select {
			case <-r.Context().Done():
				return
			case content, open := <-words:
				if !open {
					send(voiceSSEChunk(id, created, "", true, false))
					send("data: [DONE]\n\n")
					return
				}
				if first && logf != nil {
					logf("vibevalley: the voice line's first words %dms after it was asked", time.Since(asked).Milliseconds())
				}
				if !send(voiceSSEChunk(id, created, content, false, first)) {
					return
				}
				first = false
			}
		}
	})
}

// ── The tunnel ──────────────────────────────────────────────────────────────

var voiceQuickTunnel = regexp.MustCompile(`https://[a-z0-9-]+\.trycloudflare\.com`)

type voiceTunnel struct {
	url   string
	close func()
}

// voiceOpenQuickTunnel is a cloudflared quick tunnel to port: its public address once cloudflared says it.
func voiceOpenQuickTunnel(port int) (*voiceTunnel, error) {
	cmd := exec.Command("cloudflared", "tunnel", "--no-autoupdate", "--url", fmt.Sprintf("http://127.0.0.1:%d", port))
	// cloudflared says its address on either stream; both are read until it exits, so it never blocks on a write.
	out, in := io.Pipe()
	cmd.Stdout, cmd.Stderr = in, in
	if err := cmd.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("没有 cloudflared：先 brew install cloudflared，或者设 VIBEVALLEY_VOICE_LINE_URL 用你自己的隧道")
		}
		return nil, err
	}
	found := make(chan string, 1)
	go func() {
		scan := bufio.NewScanner(out)
		for scan.Scan() {
			if url := voiceQuickTunnel.FindString(scan.Text()); url != "" {
				select {
				case found <- url:
				default:
				}
			}
		}
		io.Copy(io.Discard, out)
	}()
	exited := make(chan struct{})
	go func() { cmd.Wait(); in.Close(); close(exited) }()
	kill := func() { cmd.Process.Kill() }
	select {
	case url := <-found:
		return &voiceTunnel{url: url, close: kill}, nil
	case <-exited:
		return nil, errors.New("cloudflared 退出了，没给出地址")
	case <-time.After(30 * time.Second):
		kill()
		return nil, errors.New("cloudflared 30 秒没给出地址")
	}
}

// voiceTunnelAnswers waits until the tunnel answers (the line refusing a keyless request is an answer), or
// voiceLineReady runs out.
func voiceTunnelAnswers(url string) bool {
	client := &http.Client{Timeout: 5 * time.Second}
	for deadline := time.Now().Add(voiceLineReady); time.Now().Before(deadline); {
		res, err := client.Post(url+"/llm/ready/chat/completions", "application/json", nil)
		if err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusUnauthorized {
				return true
			}
		}
		time.Sleep(2 * time.Second)
	}
	return false
}

// ── The service ─────────────────────────────────────────────────────────────

type VoiceLine struct {
	// port is where the line listens on 127.0.0.1 (0: any); url is a tunnel of your own, empty for cloudflared's.
	port int
	url  string
	// call is the manager answering; the Foreman's Call unless a test says otherwise.
	call func(ctx context.Context, text string) <-chan string
	// openTunnel opens the quick tunnel; tests replace it.
	openTunnel func(port int) (*voiceTunnel, error)

	server   *http.Server
	listener net.Listener
	// problem is why the line is not listening, when it is not.
	problem string

	mu   sync.Mutex
	keys map[string]string
	// tmu guards the tunnel apart from the keys: opening one waits for it to answer, through this very line.
	tmu     sync.Mutex
	tunnel  *voiceTunnel
	closing *time.Timer
}

func newVoiceLine(foreman *manager.Foreman) (*VoiceLine, error) {
	port := 8788
	if v := os.Getenv("VIBEVALLEY_VOICE_LINE_PORT"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 || n > 65535 {
			return nil, fmt.Errorf("VIBEVALLEY_VOICE_LINE_PORT 不是端口：%s", v)
		}
		port = n
	}
	l := &VoiceLine{port: port, url: strings.TrimRight(os.Getenv("VIBEVALLEY_VOICE_LINE_URL"), "/"), keys: map[string]string{}}
	l.call = func(ctx context.Context, text string) <-chan string { return foreman.Call(ctx, text) }
	l.openTunnel = func(port int) (*voiceTunnel, error) {
		t, err := voiceOpenQuickTunnel(port)
		if err != nil {
			return nil, err
		}
		if !voiceTunnelAnswers(t.url) {
			log.Printf("vibevalley: the voice line's tunnel %s does not answer yet; the call goes on", t.url)
		}
		return t, nil
	}
	return l, nil
}

// start listens, local only like the farm: the tunnel is the one way in from outside. A port taken leaves the farm
// running without the line; a call that wants it is told why.
func (l *VoiceLine) OnStart(ctx context.Context) error {
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", l.port))
	if err != nil {
		l.problem = "语音线路开不起来：" + err.Error()
		log.Printf("vibevalley: the voice line cannot listen on 127.0.0.1:%d: %v", l.port, err)
		return nil
	}
	l.listener = listener
	l.port = listener.Addr().(*net.TCPAddr).Port
	keyOf := func(call string) string {
		l.mu.Lock()
		defer l.mu.Unlock()
		return l.keys[call]
	}
	l.server = &http.Server{Handler: voiceLineAnswer(keyOf, l.call, log.Printf), ReadHeaderTimeout: 10 * time.Second}
	go l.server.Serve(listener)
	return nil
}

func (l *VoiceLine) OnStop() {
	l.tmu.Lock()
	if l.closing != nil {
		l.closing.Stop()
	}
	if l.tunnel != nil {
		l.tunnel.close()
		l.tunnel = nil
	}
	l.tmu.Unlock()
	if l.server != nil {
		l.server.Close()
	}
}

// base is where Agora reaches the line: your tunnel, else the quick tunnel, opened when there is none.
func (l *VoiceLine) base() (string, error) {
	if l.url != "" {
		return l.url, nil
	}
	l.tmu.Lock()
	defer l.tmu.Unlock()
	if l.closing != nil {
		l.closing.Stop()
		l.closing = nil
	}
	if l.tunnel == nil {
		t, err := l.openTunnel(l.port)
		if err != nil {
			return "", err
		}
		l.tunnel = t
	}
	return l.tunnel.url, nil
}

// Open is a line for a new call: the tunnel up, a key of its own. Refused with why not.
func (l *VoiceLine) Open() (base.CallLine, error) {
	if l.problem != "" {
		return base.CallLine{}, errors.New(l.problem)
	}
	if l.listener == nil {
		return base.CallLine{}, errors.New("语音线路还没开")
	}
	url, err := l.base()
	if err != nil {
		return base.CallLine{}, err
	}
	raw := make([]byte, 8)
	rand.Read(raw)
	id := hex.EncodeToString(raw)
	secret := make([]byte, 24)
	rand.Read(secret)
	key := base64.RawURLEncoding.EncodeToString(secret)
	l.mu.Lock()
	l.keys[id] = key
	l.mu.Unlock()
	return base.CallLine{ID: id, Key: key, URL: url + "/llm/" + id + "/chat/completions"}, nil
}

// Close: the call ended, its key no longer works; the tunnel closes a while after the last call.
func (l *VoiceLine) Close(id string) {
	l.mu.Lock()
	delete(l.keys, id)
	calls := len(l.keys)
	l.mu.Unlock()
	l.tmu.Lock()
	defer l.tmu.Unlock()
	if calls > 0 || l.tunnel == nil {
		return
	}
	if l.closing != nil {
		l.closing.Stop()
	}
	l.closing = time.AfterFunc(voiceLineLinger, func() {
		l.mu.Lock()
		calls := len(l.keys)
		l.mu.Unlock()
		l.tmu.Lock()
		defer l.tmu.Unlock()
		if calls > 0 || l.tunnel == nil {
			return
		}
		l.tunnel.close()
		l.tunnel = nil
	})
}

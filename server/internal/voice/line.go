package voice

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/manager"
	"vibevalley/internal/protocol"
	vvagent "vibevalley/pkg/agent"
)

// Only this one endpoint is reachable through the tunnel, and only with the call's own key.

const (
	// A new quick tunnel's address takes a while to answer (seen: about 25 s).
	voiceLineReady = 60 * time.Second
	// So calling again does not wait for a new tunnel.
	voiceLineLinger   = 10 * time.Minute
	voiceLineMisheard = "嗯？我没听清，你再说一遍？"
)

var voiceLineRoute = regexp.MustCompile(`^/llm/([\w-]+)/chat/completions$`)

// call's words stop when its context ends: Agora hangs up on an answer when the person talks over it.
func voiceLineAnswer(keyOf func(call string) string, call func(ctx context.Context, text string) <-chan string, logf func(string, ...any)) http.Handler {
	answer := vvagent.ChatCompletions{
		Answerer: func(model string) func(ctx context.Context, text string) <-chan string {
			if model != protocol.ManagerModel {
				return nil
			}
			return call
		},
		Misheard: voiceLineMisheard,
		Logf:     logf,
	}
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
		answer.ServeHTTP(w, r)
	})
}

var voiceQuickTunnel = regexp.MustCompile(`https://[a-z0-9-]+\.trycloudflare\.com`)

type voiceTunnel struct {
	url   string
	close func()
}

func voiceOpenQuickTunnel(port int) (*voiceTunnel, error) {
	cmd := exec.Command("cloudflared", "tunnel", "--no-autoupdate", "--url", fmt.Sprintf("http://127.0.0.1:%d", port))
	// cloudflared says its address on either stream; both are read until it exits, so it never blocks on a write.
	out, in := io.Pipe()
	cmd.Stdout, cmd.Stderr = in, in
	if err := cmd.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("没有 cloudflared：先 brew install cloudflared，或者在配置里设 voice.line.url，用你自己的隧道")
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

// The line refusing a keyless request counts as an answer.
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

type voiceLine struct {
	port       int
	url        string
	call       func(ctx context.Context, text string) <-chan string
	openTunnel func(port int) (*voiceTunnel, error)

	server   *http.Server
	listener net.Listener
	problem  string

	mu   sync.Mutex
	keys map[string]string
	// Apart from the keys: opening a tunnel waits for it to answer, through this very line.
	tmu        sync.Mutex
	tunnel     *voiceTunnel
	closing    *time.Timer
	stopped    bool
	generation uint64
}

func newVoiceLine(cfg base.Config, mgr *manager.Service) (*voiceLine, error) {
	l := &voiceLine{port: cfg.Voice.Line.Port, url: strings.TrimRight(cfg.Voice.Line.URL, "/"), keys: map[string]string{}}
	l.call = func(ctx context.Context, text string) <-chan string { return mgr.Call(ctx, text) }
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

// Local only, like the farm: the tunnel is the one way in from outside.
func (l *voiceLine) OnStart(ctx context.Context) error {
	l.tmu.Lock()
	defer l.tmu.Unlock()
	l.stopped = false
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

func (l *voiceLine) OnStop() {
	l.tmu.Lock()
	defer l.tmu.Unlock()
	l.stopped = true
	l.generation++
	l.mu.Lock()
	clear(l.keys)
	l.mu.Unlock()
	if l.closing != nil {
		l.closing.Stop()
	}
	if l.tunnel != nil {
		l.tunnel.close()
		l.tunnel = nil
	}
	if l.server != nil {
		l.server.Close()
	}
}

// Called with tmu held, through registration of the call key.
func (l *voiceLine) base() (string, error) {
	if l.url != "" {
		return l.url, nil
	}
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

func (l *voiceLine) Open() (CallLine, error) {
	l.tmu.Lock()
	defer l.tmu.Unlock()
	if l.stopped {
		return CallLine{}, errors.New("语音线路已经关闭")
	}
	l.generation++
	if l.problem != "" {
		return CallLine{}, errors.New(l.problem)
	}
	if l.listener == nil {
		return CallLine{}, errors.New("语音线路还没开")
	}
	url, err := l.base()
	if err != nil {
		return CallLine{}, err
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
	return CallLine{ID: id, Key: key, URL: url + "/llm/" + id + "/chat/completions"}, nil
}

func (l *voiceLine) Close(id string) {
	l.tmu.Lock()
	defer l.tmu.Unlock()
	l.mu.Lock()
	delete(l.keys, id)
	calls := len(l.keys)
	l.mu.Unlock()
	if calls > 0 || l.tunnel == nil {
		return
	}
	if l.closing != nil {
		l.closing.Stop()
	}
	l.generation++
	generation := l.generation
	l.closing = time.AfterFunc(voiceLineLinger, func() {
		l.expire(generation)
	})
}

func (l *voiceLine) expire(generation uint64) {
	l.tmu.Lock()
	defer l.tmu.Unlock()
	if generation != l.generation {
		return
	}
	l.mu.Lock()
	calls := len(l.keys)
	l.mu.Unlock()
	if calls > 0 || l.tunnel == nil {
		return
	}
	l.tunnel.close()
	l.tunnel = nil
}

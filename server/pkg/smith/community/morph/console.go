package morph

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
)

// A morph Console owns one state directory and publishes its loopback
// Runtime API endpoint and bearer token in <state>/console/runtime.json
// (console.ts). OAR attaches to a running Console, or starts one shared by
// every session of this process on the same directory and stopped when the
// last of them is released.

const (
	consoleStartTimeout = 60 * time.Second
	discoveryPoll       = 200 * time.Millisecond
	requestTimeout      = 15 * time.Second
)

// Endpoint is the Runtime API endpoint a running Console publishes.
type Endpoint struct {
	URL   string
	Token string
}

// Reply is a Runtime API answer: the status, and the body as JSON when it
// is JSON, otherwise its trimmed text (a JSON string).
type Reply struct {
	Status int
	Body   json.RawMessage
}

// Client talks to one Console. Its transport never follows a proxy off the
// loopback, since every request carries the bearer token.
type Client struct {
	Endpoint Endpoint
	http     *http.Client
}

// NewClient is a Client for an endpoint.
func NewClient(endpoint Endpoint) *Client {
	return &Client{Endpoint: endpoint, http: &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: requestTimeout}}
}

// Call sends one request.
func (c *Client) Call(ctx context.Context, method, route string, body any) (Reply, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return Reply{}, err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.Endpoint.URL+route, reader)
	if err != nil {
		return Reply{}, err
	}
	request.Header.Set("Authorization", "Bearer "+c.Endpoint.Token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return Reply{}, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return Reply{}, err
	}
	if strings.Contains(response.Header.Get("Content-Type"), "json") && json.Valid(data) {
		return Reply{Status: response.StatusCode, Body: data}, nil
	}
	return Reply{Status: response.StatusCode, Body: jsonx.Marshal(strings.TrimSpace(string(data)))}, nil
}

// Expect is a call whose non-2xx answer is an error carrying the Runtime API's message.
func (c *Client) Expect(ctx context.Context, method, route string, body any) (json.RawMessage, error) {
	reply, err := c.Call(ctx, method, route, body)
	if err != nil {
		return nil, err
	}
	if reply.Status < 200 || reply.Status > 299 {
		return nil, fmt.Errorf("morph %s %s answered %d: %s", method, route, reply.Status, ReplyMessage(reply))
	}
	return reply.Body, nil
}

// Stream follows one task's `/stream/ws` snapshots; the returned func closes it.
func (c *Client) Stream(taskID string, onFrame func(json.RawMessage), onClose func()) func() {
	target := strings.Replace(c.Endpoint.URL, "http", "ws", 1) + "/stream/ws?task_id=" + urlEscape(taskID)
	var once sync.Once
	var mu sync.Mutex
	var conn *wsConn
	closed := false
	go func() {
		ws, err := dialWebSocket(target, http.Header{"Authorization": {"Bearer " + c.Endpoint.Token}})
		if err != nil {
			once.Do(onClose)
			return
		}
		mu.Lock()
		if closed {
			mu.Unlock()
			ws.close()
			return
		}
		conn = ws
		mu.Unlock()
		for {
			message, err := ws.readMessage()
			if err != nil {
				break
			}
			if json.Valid(message) {
				onFrame(message)
			}
		}
		once.Do(onClose)
	}()
	return func() {
		mu.Lock()
		closed = true
		if conn != nil {
			conn.close()
		}
		mu.Unlock()
	}
}

func urlEscape(text string) string {
	return strings.NewReplacer("%", "%25", "&", "%26", "+", "%2B", " ", "%20", "#", "%23", "?", "%3F", "/", "%2F").Replace(text)
}

// ReplyMessage is the Runtime API's error text of an answer.
func ReplyMessage(reply Reply) string {
	if message, ok := jsonx.ParseRecord(reply.Body)["error"].(string); ok {
		return message
	}
	var text string
	if json.Unmarshal(reply.Body, &text) == nil {
		return text
	}
	return string(reply.Body)
}

var stateDirLine = regexp.MustCompile(`(?m)^file_state_dir:[ \t]*["']?([^"'#\r\n]*?)["']?[ \t]*(?:#.*)?$`)

// StateDir is the state directory morph resolves: MISTER_MORPH_FILE_STATE_DIR,
// else a top-level file_state_dir in its config file (MISTER_MORPH_CONFIG,
// else ~/.morph/config.yaml), else ~/.morph.
func StateDir(getenv func(string) string, home string) string {
	expand := func(dir string) string {
		if dir == "~" {
			return home
		}
		if strings.HasPrefix(dir, "~/") {
			return filepath.Join(home, dir[2:])
		}
		return dir
	}
	if fromEnv := strings.TrimSpace(getenv("MISTER_MORPH_FILE_STATE_DIR")); fromEnv != "" {
		return expand(fromEnv)
	}
	configPath := strings.TrimSpace(getenv("MISTER_MORPH_CONFIG"))
	if configPath == "" {
		configPath = filepath.Join(home, ".morph", "config.yaml")
	}
	if data, err := os.ReadFile(expand(configPath)); err == nil {
		if match := stateDirLine.FindStringSubmatch(string(data)); match != nil && strings.TrimSpace(match[1]) != "" {
			return expand(strings.TrimSpace(match[1]))
		}
	}
	return filepath.Join(home, ".morph")
}

// HostStateDir is StateDir for this process.
func HostStateDir() string {
	home, _ := os.UserHomeDir()
	return StateDir(os.Getenv, home)
}

func readEndpoint(stateDir string) *Endpoint {
	data, err := os.ReadFile(filepath.Join(stateDir, "console", "runtime.json"))
	if err != nil {
		return nil
	}
	record := jsonx.ParseRecord(data)
	url, urlOK := record["url"].(string)
	token, tokenOK := record["token"].(string)
	if !urlOK || !tokenOK {
		return nil
	}
	return &Endpoint{URL: strings.TrimRight(url, "/"), Token: token}
}

// Discover is the Console published for stateDir, when one answers as a Console.
func Discover(ctx context.Context, stateDir string) *Client {
	endpoint := readEndpoint(stateDir)
	if endpoint == nil {
		return nil
	}
	client := NewClient(*endpoint)
	health, err := client.Call(ctx, "GET", "/health", nil)
	if err != nil || health.Status != 200 || jsonx.ParseRecord(health.Body)["mode"] != "console" {
		return nil
	}
	return client
}

// Lease is a session's hold on a Console.
type Lease interface {
	Client() *Client
	// Owned: this process started the Console; it stops with the last lease.
	Owned() bool
	// OnExit fires when an owned Console exits while held.
	OnExit(listener func(code *int))
	// Release returns the Console's exit when this release stopped it.
	Release() (stopped bool, code *int)
}

type ownedConsole struct {
	process   *executable.LineProcess
	client    *Client
	mu        sync.Mutex
	listeners map[int]func(*int)
	next      int
	holders   int
}

var owned = struct {
	sync.Mutex
	consoles map[string]*ownedStart
}{consoles: map[string]*ownedStart{}}

type ownedStart struct {
	done    chan struct{}
	console *ownedConsole
	err     error
}

func startConsole(ctx context.Context, command, stateDir string) (*ownedConsole, error) {
	// An ephemeral port: the Runtime API is found through runtime.json.
	process, err := executable.Spawn(command, []string{"console", "serve", "--console-listen", "127.0.0.1:0"}, executable.LineOptions{Dir: stateDir})
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(consoleStartTimeout)
	for {
		if client := Discover(ctx, stateDir); client != nil {
			console := &ownedConsole{process: process, client: client, listeners: map[int]func(*int){}}
			process.OnExit(func(code *int) {
				owned.Lock()
				delete(owned.consoles, stateDir)
				owned.Unlock()
				console.mu.Lock()
				listeners := make([]func(*int), 0, len(console.listeners))
				for _, listener := range console.listeners {
					listeners = append(listeners, listener)
				}
				console.mu.Unlock()
				for _, listener := range listeners {
					listener(code)
				}
			})
			return console, nil
		}
		if process.HasEnded() {
			return nil, executable.ProcessFailure("morph console serve exited before publishing "+filepath.Join(stateDir, "console", "runtime.json"), process.Diagnostics())
		}
		if time.Now().After(deadline) {
			process.Kill()
			<-process.Exited()
			return nil, executable.ProcessFailure(fmt.Sprintf("morph console serve did not publish its Runtime API within %d ms", consoleStartTimeout.Milliseconds()), process.Diagnostics())
		}
		time.Sleep(discoveryPoll)
	}
}

type attachedLease struct{ client *Client }

func (l attachedLease) Client() *Client     { return l.client }
func (attachedLease) Owned() bool           { return false }
func (attachedLease) OnExit(func(*int))     {}
func (attachedLease) Release() (bool, *int) { return false, nil }

type ownedLease struct {
	console  *ownedConsole
	stateDir string
	mu       sync.Mutex
	released bool
	mine     []int
}

func (l *ownedLease) Client() *Client { return l.console.client }
func (l *ownedLease) Owned() bool     { return true }

func (l *ownedLease) OnExit(listener func(*int)) {
	l.console.mu.Lock()
	defer l.console.mu.Unlock()
	l.console.next++
	l.console.listeners[l.console.next] = listener
	l.mu.Lock()
	l.mine = append(l.mine, l.console.next)
	l.mu.Unlock()
}

func (l *ownedLease) Release() (bool, *int) {
	l.mu.Lock()
	if l.released {
		l.mu.Unlock()
		return false, nil
	}
	l.released = true
	mine := l.mine
	l.mu.Unlock()
	l.console.mu.Lock()
	for _, id := range mine {
		delete(l.console.listeners, id)
	}
	l.console.holders--
	last := l.console.holders == 0
	l.console.mu.Unlock()
	if !last {
		return false, nil
	}
	owned.Lock()
	delete(owned.consoles, l.stateDir)
	owned.Unlock()
	l.console.process.Kill()
	<-l.console.process.Exited()
	return true, l.console.process.ExitCode()
}

// Acquire holds the Console for stateDir: the one already running (attached,
// never stopped by OAR), or one this process starts and shares.
func Acquire(ctx context.Context, command, stateDir string) (Lease, error) {
	owned.Lock()
	start, pending := owned.consoles[stateDir]
	owned.Unlock()
	if !pending {
		if running := Discover(ctx, stateDir); running != nil {
			return attachedLease{running}, nil
		}
		owned.Lock()
		start, pending = owned.consoles[stateDir]
		if !pending {
			start = &ownedStart{done: make(chan struct{})}
			owned.consoles[stateDir] = start
			owned.Unlock()
			start.console, start.err = startConsole(ctx, command, stateDir)
			close(start.done)
		} else {
			owned.Unlock()
		}
	}
	<-start.done
	if start.err != nil {
		owned.Lock()
		if owned.consoles[stateDir] == start {
			delete(owned.consoles, stateDir)
		}
		owned.Unlock()
		// A Console the user started meanwhile wins the state directory lock.
		if running := Discover(ctx, stateDir); running != nil {
			return attachedLease{running}, nil
		}
		return nil, start.err
	}
	start.console.mu.Lock()
	start.console.holders++
	start.console.mu.Unlock()
	return &ownedLease{console: start.console, stateDir: stateDir}, nil
}

var errNoTopicID = errors.New("morph POST /topics answered without a topic id")

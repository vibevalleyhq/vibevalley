package qq

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func jsonBody(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	var body map[string]any
	raw, _ := io.ReadAll(r.Body)
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Errorf("body %q: %v", raw, err)
	}
	return body
}

func TestClientSpeaksQQsProtocol(t *testing.T) {
	var mu sync.Mutex
	tokens := 0
	var sends []map[string]any
	upgrader := websocket.Upgrader{}
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			body := jsonBody(t, r)
			if body["clientSecret"] != "right" {
				io.WriteString(w, `{"code":100016,"message":"invalid appid or secret"}`)
				return
			}
			mu.Lock()
			tokens++
			mu.Unlock()
			io.WriteString(w, `{"access_token":"T","expires_in":"7200"}`)
		case "/gateway":
			if r.Header.Get("Authorization") != "QQBot T" || r.Header.Get("X-Union-Appid") != "102" {
				t.Errorf("gateway auth: %v", r.Header)
			}
			io.WriteString(w, `{"url":"ws`+strings.TrimPrefix(server.URL, "http")+`/ws"}`)
		case "/ws":
			ws, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer ws.Close()
			ws.WriteJSON(map[string]any{"op": 10, "d": map[string]any{"heartbeat_interval": 20}})
			var identify map[string]any
			ws.ReadJSON(&identify)
			d := identify["d"].(map[string]any)
			if identify["op"] != float64(2) || d["token"] != "QQBot T" || d["intents"] != float64(1<<25) {
				t.Errorf("identify: %v", identify)
			}
			ws.WriteJSON(map[string]any{"op": 0, "s": 1, "t": "C2C_MESSAGE_CREATE", "d": map[string]any{"id": "m1", "content": " 你好 ", "author": map[string]any{"user_openid": "o1"}, "attachments": []any{map[string]any{}}}})
			var beat map[string]any
			ws.ReadJSON(&beat)
			if beat["op"] != float64(1) || beat["d"] != float64(1) {
				t.Errorf("heartbeat: %v", beat)
			}
			ws.WriteJSON(map[string]any{"op": 7})
			time.Sleep(100 * time.Millisecond)
		default:
			if strings.HasPrefix(r.URL.Path, "/v2/users/") {
				body := jsonBody(t, r)
				mu.Lock()
				sends = append(sends, body)
				mu.Unlock()
				if body["content"] == "late" {
					w.WriteHeader(400)
					io.WriteString(w, `{"code":40034,"message":"passive reply expired"}`)
					return
				}
				io.WriteString(w, `{"id":"r1"}`)
				return
			}
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	live := NewClient()
	live.api, live.tokenURL = server.URL, server.URL+"/token"
	ctx := context.Background()
	if err := live.Check(ctx, App{AppID: "9", Secret: "wrong"}); err == nil || !strings.Contains(err.Error(), "invalid appid") {
		t.Fatalf("wrong: %v", err)
	}
	app := App{AppID: "102", Secret: "right"}
	if err := live.Check(ctx, app); err != nil {
		t.Fatal(err)
	}
	var got []Message
	err := live.Listen(ctx, app, func(m Message) { got = append(got, m) })
	if err == nil || !strings.Contains(err.Error(), "QQ 让重新连接") {
		t.Fatalf("listen ends: %v", err)
	}
	stacks := make([]byte, 1<<20)
	n := runtime.Stack(stacks, true)
	if strings.Contains(string(stacks[:n]), "qq.(*Client).Listen.func") {
		t.Fatal("Listen returned with a heartbeat worker still running")
	}
	if len(got) != 1 || got[0] != (Message{ID: "m1", From: "o1", Content: " 你好 ", Attachments: 1}) {
		t.Fatalf("got: %+v", got)
	}
	if id, e := live.SendText(ctx, app, "o1", "好", "m1"); e != nil || id != "r1" {
		t.Fatalf("send: %q %v", id, e)
	}
	live.SendText(ctx, app, "o1", "再说", "m1")
	if _, e := live.SendText(ctx, app, "o1", "late", ""); e == nil || e.Status != 400 || !strings.Contains(e.Reason, "40034") {
		t.Fatalf("late: %+v", e)
	}
	mu.Lock()
	defer mu.Unlock()
	if tokens != 1 {
		t.Fatalf("the token is kept: %d fetched", tokens)
	}
	if sends[0]["msg_id"] != "m1" || sends[0]["msg_seq"] != float64(1) || sends[1]["msg_seq"] != float64(2) {
		t.Fatalf("each reply its own sequence number: %v", sends)
	}
	if _, ok := sends[2]["msg_id"]; ok {
		t.Fatalf("no reply, no msg_id: %v", sends[2])
	}
}

func TestChangedCredentialsCannotReuseToken(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if jsonBody(t, r)["clientSecret"] != "right" {
			io.WriteString(w, `{"message":"invalid secret"}`)
			return
		}
		io.WriteString(w, `{"access_token":"T","expires_in":7200}`)
	}))
	defer server.Close()
	client := NewClient()
	client.tokenURL = server.URL
	if err := client.Check(context.Background(), App{AppID: "same", Secret: "right"}); err != nil {
		t.Fatal(err)
	}
	if err := client.Check(context.Background(), App{AppID: "same", Secret: "wrong"}); err == nil {
		t.Fatal("changed credentials bypassed authentication")
	}
	if calls != 2 {
		t.Fatalf("calls: %d", calls)
	}
}

func TestMalformedSendResponseIsNotSuccess(t *testing.T) {
	for _, response := range []string{"broken", `{}`, `{"code":123,"message":"failed"}`} {
		t.Run(response, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, response) }))
			defer server.Close()
			client := NewClient()
			client.api = server.URL
			app := App{AppID: "app", Secret: "secret"}
			client.tokens[app] = cachedToken{token: "T", until: time.Now().Add(time.Hour)}
			if _, err := client.SendText(context.Background(), app, "owner", "text", "msg"); err == nil {
				t.Fatal("unconfirmed send reported success")
			}
		})
	}
}

type deadlineTransport struct{ t *testing.T }

func (d deadlineTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	d.t.Helper()
	deadline, ok := r.Context().Deadline()
	if !ok || time.Until(deadline) > 26*time.Second {
		d.t.Error("network request lacks bounded lifetime")
	}
	return nil, context.DeadlineExceeded
}
func TestRequestsHaveBoundedLifetime(t *testing.T) {
	client := NewClient()
	client.http.Transport = deadlineTransport{t}
	app := App{AppID: "app", Secret: "secret"}
	client.tokens[app] = cachedToken{token: "T", until: time.Now().Add(time.Hour)}
	if err := client.Listen(context.Background(), app, func(Message) {}); err == nil {
		t.Fatal("gateway failure hidden")
	}
	if _, err := client.SendText(context.Background(), app, "owner", "text", ""); err == nil {
		t.Fatal("send failure hidden")
	}
}

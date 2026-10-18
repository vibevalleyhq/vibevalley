package feishu

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
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

func TestClientRegistersAndSends(t *testing.T) {
	var mu sync.Mutex
	var polls int
	var message map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/oauth/v1/app/registration":
			r.ParseForm()
			switch r.Form.Get("action") {
			case "init":
				io.WriteString(w, `{"supported_auth_methods":["client_secret"]}`)
			case "begin":
				if r.Form.Get("archetype") != "PersonalAgent" || r.Form.Get("request_user_info") != "open_id" {
					t.Errorf("begin: %v", r.Form)
				}
				io.WriteString(w, `{"device_code":"dev","verification_uri_complete":"https://open.feishu.cn/page/launcher?user_code=AB&x=1","interval":1,"expires_in":300}`)
			case "poll":
				mu.Lock()
				polls++
				n := polls
				mu.Unlock()
				if n == 1 {
					w.WriteHeader(400)
					io.WriteString(w, `{"error":"authorization_pending","user_info":{"tenant_brand":"lark"}}`)
					return
				}
				if r.Form.Get("device_code") == "denied" {
					io.WriteString(w, `{"error":"access_denied"}`)
					return
				}
				io.WriteString(w, `{"client_id":"cli_1","client_secret":"s","user_info":{"open_id":"ou_owner"}}`)
			}
		case "/open-apis/auth/v3/tenant_access_token/internal":
			io.WriteString(w, `{"code":0,"msg":"ok","tenant_access_token":"t-1","expire":7200}`)
		case "/open-apis/im/v1/messages":
			if r.URL.Query().Get("receive_id_type") != "open_id" || r.Header.Get("Authorization") != "Bearer t-1" {
				t.Errorf("message: %s %v", r.URL, r.Header)
			}
			mu.Lock()
			message = jsonBody(t, r)
			mu.Unlock()
			io.WriteString(w, `{"code":0,"msg":"ok","data":{"message_id":"om_1"}}`)
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	live := NewClient()
	live.accounts = map[Domain]string{"feishu": server.URL, "lark": server.URL}
	live.open = map[Domain]string{"feishu": server.URL, "lark": server.URL}
	ctx := context.Background()
	reg, err := live.register(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if u, _ := url.Parse(reg.URL); u.Path != "/page/cli" || u.Query().Get("user_code") != "AB" || reg.Interval != 2*time.Second || reg.Expires != 300*time.Second {
		t.Fatalf("registration: %+v", reg)
	}
	if p := live.poll(ctx, "dev", "feishu"); p.Status != "pending" || p.Domain != "lark" {
		t.Fatalf("pending: %+v", p)
	}
	if p := live.poll(ctx, "dev", "lark"); p.Status != "succeeded" || p.AppID != "cli_1" || p.OpenID != "ou_owner" || p.Domain != "lark" {
		t.Fatalf("succeeded: %+v", p)
	}
	if p := live.poll(ctx, "denied", "feishu"); p.Status != "failed" || p.Reason != "在飞书里拒绝了。" {
		t.Fatalf("denied: %+v", p)
	}
	id, err := live.SendText(ctx, App{AppID: "cli_1", AppSecret: "s", Domain: "feishu"}, "ou_owner", "好")
	if err != nil || id != "om_1" {
		t.Fatalf("send: %q %v", id, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if message["receive_id"] != "ou_owner" || message["msg_type"] != "text" || message["content"] != `{"text":"好"}` {
		t.Fatalf("message: %v", message)
	}
	if got := Text(Message{MessageType: "text", Content: `{"text":" 你好 "}`}); got != "你好" {
		t.Fatal(got)
	}
	if got := Text(Message{MessageType: "image"}); got != "[图片]" {
		t.Fatal(got)
	}
}

func TestSendRequiresMessageID(t *testing.T) {
	for _, response := range []string{`{"code":0}`, `{"code":0,"data":{}}`, `{"code":0,"data":{"message_id":""}}`} {
		t.Run(response, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "tenant_access_token") {
					io.WriteString(w, `{"code":0,"tenant_access_token":"t","expire":7200}`)
					return
				}
				io.WriteString(w, response)
			}))
			defer server.Close()
			client := NewClient()
			client.open["feishu"] = server.URL
			if _, err := client.SendText(context.Background(), App{AppID: response, AppSecret: "secret", Domain: "feishu"}, "owner", "text"); err == nil {
				t.Fatal("missing message id accepted")
			}
		})
	}
}

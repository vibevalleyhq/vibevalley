package weixin

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
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

func TestClientSpeaksWeChatsProtocol(t *testing.T) {
	var mu sync.Mutex
	var sent map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("iLink-App-Id") != "bot" || r.Header.Get("iLink-App-ClientVersion") != "132106" {
			t.Errorf("headers: %v", r.Header)
		}
		switch r.URL.Path {
		case "/ilink/bot/get_bot_qrcode":
			io.WriteString(w, `{"qrcode":"q1","qrcode_img_content":"https://liteapp.weixin.qq.com/q/q1"}`)
		case "/ilink/bot/get_qrcode_status":
			if r.URL.Query().Get("verify_code") == "42" {
				io.WriteString(w, `{"status":"confirmed","bot_token":"tok","ilink_bot_id":"b","ilink_user_id":"u"}`)
				return
			}
			w.WriteHeader(500)
		case "/ilink/bot/getupdates":
			if r.Header.Get("Authorization") != "Bearer tok" || r.Header.Get("AuthorizationType") != "ilink_bot_token" || r.Header.Get("X-WECHAT-UIN") == "" {
				t.Errorf("auth: %v", r.Header)
			}
			body := jsonBody(t, r)
			if body["get_updates_buf"] == "slow" {
				time.Sleep(300 * time.Millisecond)
			}
			// A 64-bit id JSON would round.
			io.WriteString(w, `{"ret":0,"msgs":[{"message_id":7400000000000000123,"from_user_id":"u","message_type":1,"context_token":"c",
				"item_list":[{"type":1,"text_item":{"text":"看看"}},{"type":3,"voice_item":{"text":"语音的字"}},{"type":4,"file_item":{"file_name":"a.txt"}},
				{"type":1,"ref_msg":{"svr_id":9100000000000000001}}]}],"get_updates_buf":"b2"}`)
		case "/ilink/bot/sendmessage":
			body := jsonBody(t, r)
			mu.Lock()
			sent = body
			mu.Unlock()
			msg := body["msg"].(map[string]any)
			if msg["context_token"] == "stale" {
				io.WriteString(w, `{"ret":-14,"errmsg":"session timeout"}`)
				return
			}
			io.WriteString(w, `{"ret":0,"message_id":123}`)
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	ctx := context.Background()
	live := NewClient()
	live.base = server.URL
	code, show, err := live.qrCode(ctx)
	if err != nil || code != "q1" || show != "https://liteapp.weixin.qq.com/q/q1" {
		t.Fatalf("qr: %s %s %v", code, show, err)
	}
	if s := live.qrStatus(ctx, server.URL, "q1", ""); s.Status != "wait" {
		t.Fatalf("a hiccup reads as wait: %+v", s)
	}
	if s := live.qrStatus(ctx, server.URL, "q1", "42"); s.Status != "confirmed" || s.BotToken != "tok" {
		t.Fatalf("confirmed: %+v", s)
	}
	account := Account{BaseURL: server.URL, Token: "tok"}
	u, err := live.GetUpdates(ctx, account, "b1", 5*time.Second)
	if err != nil || len(u.Msgs) != 1 || u.GetUpdatesBuf != "b2" {
		t.Fatalf("updates: %+v %v", u, err)
	}
	m := u.Msgs[0]
	if m.MessageID != "7400000000000000123" || Quoted(m) != "9100000000000000001" {
		t.Fatalf("ids kept whole: %q %q", m.MessageID, Quoted(m))
	}
	if got := Text(m); got != "看看\n语音的字\n[文件：a.txt]" {
		t.Fatalf("text: %q", got)
	}
	quiet, err := live.GetUpdates(ctx, account, "slow", 50*time.Millisecond)
	if err != nil || len(quiet.Msgs) != 0 || quiet.GetUpdatesBuf != "slow" || Failed(quiet.Ret, quiet.Errcode) != nil {
		t.Fatalf("quiet: %+v %v", quiet, err)
	}
	id, err := live.SendText(ctx, account, "u", "好", "c")
	if err != nil || id != "123" {
		t.Fatalf("send: %q %v", id, err)
	}
	mu.Lock()
	msg := sent["msg"].(map[string]any)
	mu.Unlock()
	if msg["to_user_id"] != "u" || msg["context_token"] != "c" || !strings.HasPrefix(msg["client_id"].(string), "vibevalley-") ||
		msg["item_list"].([]any)[0].(map[string]any)["text_item"].(map[string]any)["text"] != "好" {
		t.Fatalf("sent: %v", msg)
	}
	_, err = live.SendText(ctx, account, "u", "好", "stale")
	var e *Error
	if !errors.As(err, &e) || e.Code != StaleToken || e.Reason != "sendmessage: session timeout" {
		t.Fatalf("stale: %v", err)
	}
}

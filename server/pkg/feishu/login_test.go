package feishu

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestLoginOwnsPollingLeaseAndDomainRedirect(t *testing.T) {
	var firstAt time.Time
	var redirectedPolls atomic.Int32
	lark := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.Form.Get("action") != "poll" || r.Form.Get("device_code") != "device" {
			t.Errorf("redirect poll: %v", r.Form)
		}
		redirectedPolls.Add(1)
		io.WriteString(w, `{"client_id":"app","client_secret":"secret","user_info":{"open_id":"owner"}}`)
	}))
	defer lark.Close()
	var feishuPolls atomic.Int32
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		switch r.Form.Get("action") {
		case "init":
			io.WriteString(w, `{"supported_auth_methods":["client_secret"]}`)
		case "begin":
			firstAt = time.Now()
			io.WriteString(w, `{"device_code":"device","verification_uri_complete":"https://open.feishu.cn/page/launcher?user_code=AB","interval":1,"expires_in":30}`)
		case "poll":
			if time.Since(firstAt) < 2*time.Second {
				t.Error("poll ignored the normalized interval")
			}
			feishuPolls.Add(1)
			io.WriteString(w, `{"error":"authorization_pending","user_info":{"tenant_brand":"lark"}}`)
		}
	}))
	defer first.Close()
	client := NewClient()
	client.accounts = map[Domain]string{"feishu": first.URL, "lark": lark.URL}
	var progress []LoginProgress
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	account, err := client.Login(ctx, func(p LoginProgress) { progress = append(progress, p) })
	if err != nil {
		t.Fatal(err)
	}
	if account.App != (App{AppID: "app", AppSecret: "secret", Domain: "lark"}) || account.Owner != "owner" {
		t.Fatalf("account: %+v", account)
	}
	if feishuPolls.Load() != 1 || redirectedPolls.Load() != 1 || len(progress) != 1 || !strings.Contains(progress[0].URL, "/page/cli?") {
		t.Fatalf("progress: %+v", progress)
	}
}

func TestLoginOwnsCancellationExpiryAndRejection(t *testing.T) {
	for _, mode := range []string{"cancel", "expires", "denied", "empty"} {
		t.Run(mode, func(t *testing.T) {
			var polls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				r.ParseForm()
				switch r.Form.Get("action") {
				case "init":
					io.WriteString(w, `{"supported_auth_methods":["client_secret"]}`)
				case "begin":
					expiry := 30.0
					if mode == "expires" {
						expiry = 0.01
					}
					fmt.Fprintf(w, `{"device_code":"device","verification_uri_complete":"https://example.test/qr","interval":1,"expires_in":%g}`, expiry)
				case "poll":
					polls.Add(1)
					if mode == "empty" {
						io.WriteString(w, `{"client_id":"","client_secret":"  ","user_info":{"open_id":""}}`)
					} else {
						io.WriteString(w, `{"error":"access_denied"}`)
					}
				}
			}))
			defer server.Close()
			client := NewClient()
			client.accounts = map[Domain]string{"feishu": server.URL}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			_, err := client.Login(ctx, func(LoginProgress) {
				if mode == "cancel" {
					cancel()
				}
			})
			switch mode {
			case "cancel":
				if !errors.Is(err, context.Canceled) || polls.Load() != 0 {
					t.Fatalf("canceled: %v polls=%d", err, polls.Load())
				}
			case "expires":
				if err == nil || !strings.Contains(err.Error(), "过期") || polls.Load() != 0 {
					t.Fatalf("expired: %v polls=%d", err, polls.Load())
				}
			case "empty":
				if err == nil || !strings.Contains(err.Error(), "没给齐登录信息") || polls.Load() != 1 {
					t.Fatalf("empty credentials accepted: %v polls=%d", err, polls.Load())
				}
			case "denied":
				if err == nil || !strings.Contains(err.Error(), "拒绝") || polls.Load() != 1 {
					t.Fatalf("denied: %v polls=%d", err, polls.Load())
				}
			}
		})
	}
}

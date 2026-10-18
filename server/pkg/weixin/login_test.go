package weixin

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestLoginOwnsRedirectVerificationAndRefresh(t *testing.T) {
	var codes atomic.Int32
	redirected := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("qrcode") {
		case "q1":
			if r.URL.Query().Get("verify_code") == "42" {
				io.WriteString(w, `{"status":"verify_code_blocked"}`)
			} else {
				io.WriteString(w, `{"status":"need_verifycode"}`)
			}
		case "q2":
			io.WriteString(w, `{"status":"expired"}`)
		case "q3":
			io.WriteString(w, `{"status":"confirmed","bot_token":"token","ilink_bot_id":"bot","ilink_user_id":"owner"}`)
		default:
			t.Errorf("unexpected code: %s", r.URL)
			w.WriteHeader(400)
		}
	}))
	defer redirected.Close()
	var polls atomic.Int32
	first := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ilink/bot/get_bot_qrcode" {
			n := codes.Add(1)
			fmt.Fprintf(w, `{"qrcode":"q%d","qrcode_img_content":"https://show/q%d"}`, n, n)
			return
		}
		if polls.Add(1) == 1 {
			io.WriteString(w, `{"status":"scaned"}`)
		} else {
			fmt.Fprintf(w, `{"status":"scaned_but_redirect","redirect_host":%q}`, strings.TrimPrefix(redirected.URL, "https://"))
		}
	}))
	defer first.Close()
	client := NewClient()
	client.base = first.URL
	client.http = first.Client()
	code := ""
	var states []LoginState
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	account, err := client.Login(ctx, func(p LoginProgress) {
		states = append(states, p.State)
		if p.State == LoginVerify {
			code = "42"
		}
	}, func() string { return code })
	if err != nil {
		t.Fatal(err)
	}
	if account.Owner != "owner" || account.BotID != "bot" || account.Account.Token != "token" || account.Account.BaseURL != redirected.URL {
		t.Fatalf("account: %+v", account)
	}
	if codes.Load() != 3 {
		t.Fatalf("code refresh count: %d", codes.Load())
	}
	if want := []LoginState{LoginWaiting, LoginScanned, LoginVerify, LoginWaiting, LoginWaiting}; !reflect.DeepEqual(states, want) {
		t.Fatalf("progress: %v", states)
	}
}

func TestLoginOwnsRefreshLimit(t *testing.T) {
	for _, status := range []string{"expired", "verify_code_blocked"} {
		t.Run(status, func(t *testing.T) {
			var codes atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/ilink/bot/get_bot_qrcode" {
					codes.Add(1)
					io.WriteString(w, `{"qrcode":"q","qrcode_img_content":"https://show"}`)
				} else {
					fmt.Fprintf(w, `{"status":%q}`, status)
				}
			}))
			defer server.Close()
			client := NewClient()
			client.base = server.URL
			_, err := client.Login(context.Background(), nil, nil)
			if err == nil || !strings.Contains(err.Error(), "几次") || codes.Load() != 3 {
				t.Fatalf("refreshes %d: %v", codes.Load(), err)
			}
		})
	}
}

func TestLoginCancellationInterruptsPoll(t *testing.T) {
	entered := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ilink/bot/get_bot_qrcode" {
			io.WriteString(w, `{"qrcode":"q","qrcode_img_content":"https://show"}`)
			return
		}
		close(entered)
		<-r.Context().Done()
	}))
	defer server.Close()
	client := NewClient()
	client.base = server.URL
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := client.Login(ctx, nil, nil); done <- err }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("poll never started")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("login outlived cancellation")
	}
}

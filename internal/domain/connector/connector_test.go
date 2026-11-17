package connector

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

func TestConnectorLifecyclePersistenceAndChannelBinding(t *testing.T) {
	t.Setenv("VIBEVALLEY_TEST_RUNTIMES", "1")

	home := t.TempDir()
	clk := store.NewFakeClock(time.Unix(1_700_000_000, 0))
	var events []ConnectorStatus

	svc, err := NewService(Options{
		HomeDir: home,
		Clock:   clk,
		ChannelValidator: func(_ context.Context, name string) (string, bool, error) {
			switch name {
			case "":
				return "", true, nil
			case "ops":
				return "chan-ops", false, nil
			default:
				return "", false, errors.New("unknown channel")
			}
		},
		OnChange: func(st ConnectorStatus) {
			events = append(events, st)
		},
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	// Default list contains built-in connectors all initially off.
	list := svc.List()
	if len(list) != len(DefaultConnectors) {
		t.Fatalf("expected %d default connectors, got %d", len(DefaultConnectors), len(list))
	}
	for _, st := range list {
		if st.State != StateOff {
			t.Fatalf("expected initial state off for %s, got %s", st.ID, st.State)
		}
	}

	// Telegram direct bot token login connects immediately and redacts secret from status.
	tgStatus, err := svc.Login(context.Background(), ConnectorTelegram, ConnectorLogin{BotToken: "12345:tg-secret-token"})
	if err != nil {
		t.Fatalf("telegram Login: %v", err)
	}
	if tgStatus.State != StateConnected || tgStatus.Since == nil {
		t.Fatalf("unexpected telegram status: %+v", tgStatus)
	}
	if raw, _ := json.Marshal(tgStatus); strings.Contains(string(raw), "tg-secret-token") {
		t.Fatalf("ConnectorStatus leaked bot token: %s", string(raw))
	}

	// Feishu AppID/Secret enters pairing with a 6-digit pairCode; Verify completes pairing.
	fsStatus, err := svc.Login(context.Background(), ConnectorFeishu, ConnectorLogin{AppID: "cli_123", Secret: "feishu-sec"})
	if err != nil {
		t.Fatalf("feishu Login: %v", err)
	}
	if fsStatus.State != StatePairing || len(fsStatus.PairCode) != 6 {
		t.Fatalf("expected pairing state with 6-digit pairCode, got %+v", fsStatus)
	}
	if _, err := svc.Verify(context.Background(), ConnectorFeishu, "000000"); !errors.Is(err, ErrConnectorRefused) && fsStatus.PairCode != "000000" {
		t.Fatalf("expected pairing code rejection, got err=%v", err)
	}
	verified, err := svc.Verify(context.Background(), ConnectorFeishu, fsStatus.PairCode)
	if err != nil || verified.State != StateConnected || verified.PairCode != "" {
		t.Fatalf("Verify pairing failed: err=%v st=%+v", err, verified)
	}

	// SetChannel validates and binds channel.
	if _, err := svc.SetChannel(context.Background(), ConnectorFeishu, "nonexistent"); !errors.Is(err, ErrConnectorRefused) {
		t.Fatalf("expected unknown channel error, got %v", err)
	}
	bound, err := svc.SetChannel(context.Background(), ConnectorFeishu, "ops")
	if err != nil || bound.Channel != "chan-ops" {
		t.Fatalf("SetChannel ops failed: err=%v st=%+v", err, bound)
	}

	// Persisted file uses 0600 permissions and survives reload.
	diskPath := filepath.Join(home, connectorsFileName)
	info, err := os.Stat(diskPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("expected 0600 file %s: err=%v info=%v", diskPath, err, info)
	}
	reloaded, err := NewService(Options{HomeDir: home, Clock: clk})
	if err != nil {
		t.Fatalf("reload NewService: %v", err)
	}
	gotFeishu, err := reloaded.Get(ConnectorFeishu)
	if err != nil || gotFeishu.State != StateConnected || gotFeishu.Channel != "chan-ops" {
		t.Fatalf("reloaded feishu mismatch: err=%v st=%+v", err, gotFeishu)
	}

	// Logout clears account state and persists.
	loggedOut, err := reloaded.Logout(context.Background(), ConnectorFeishu)
	if err != nil || loggedOut.State != StateOff || loggedOut.Channel != "" {
		t.Fatalf("Logout failed: err=%v st=%+v", err, loggedOut)
	}
	if len(events) < 4 {
		t.Fatalf("expected OnChange callbacks to fire, got %d", len(events))
	}
}

func TestConnectorWeixinQRAndVerificationFlow(t *testing.T) {
	t.Setenv("VIBEVALLEY_TEST_RUNTIMES", "1")

	svc, err := NewService(Options{})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	st, err := svc.Login(context.Background(), ConnectorWeixin, ConnectorLogin{})
	if err != nil {
		t.Fatalf("Weixin QR Login: %v", err)
	}
	if st.State != StateWaiting || st.QR == "" {
		t.Fatalf("expected waiting state with QR URI, got %+v", st)
	}

	verified, err := svc.Verify(context.Background(), ConnectorWeixin, "123456")
	if err != nil || verified.State != StateConnected {
		t.Fatalf("Weixin Verify failed: err=%v st=%+v", err, verified)
	}
}

func TestConnectorLiveAdaptersVerifyAndSendOutboundAllPlatforms(t *testing.T) {
	t.Parallel()

	type recordedReq struct {
		Method string
		Path   string
		Query  string
		Auth   string
		AppID  string
		Body   string
	}
	var (
		mu   sync.Mutex
		reqs []recordedReq
	)
	record := func(r *http.Request, body []byte) {
		mu.Lock()
		defer mu.Unlock()
		reqs = append(reqs, recordedReq{
			Method: r.Method,
			Path:   r.URL.Path,
			Query:  r.URL.RawQuery,
			Auth:   r.Header.Get("Authorization"),
			AppID:  r.Header.Get("X-Union-Appid"),
			Body:   string(body),
		})
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		record(r, raw)
		w.Header().Set("Content-Type", "application/json")

		switch r.URL.Path {
		// Telegram
		case "/botgood-tg-token/getMe":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":     true,
				"result": map[string]any{"id": 1001, "is_bot": true, "username": "vibe_tg_bot"},
			})
		case "/botbad-tg-token/getMe":
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "description": "Unauthorized"})
		case "/botgood-tg-token/sendMessage":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":     true,
				"result": map[string]any{"message_id": 777},
			})

		// Feishu
		case "/open-apis/auth/v3/tenant_access_token/internal":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code":                0,
				"msg":                 "ok",
				"tenant_access_token": "t-feishu-token",
				"expire":              7200,
			})
		case "/open-apis/im/v1/messages":
			if r.Header.Get("Authorization") != "Bearer t-feishu-token" {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"code": 0,
				"msg":  "success",
				"data": map[string]any{"message_id": "om_feishu_1"},
			})

		// Slack
		case "/api/auth.test":
			if r.Header.Get("Authorization") != "Bearer xoxb-good" {
				_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "invalid_auth"})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "user": "vibe-slack", "user_id": "U999"})
		case "/api/chat.postMessage":
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "channel": "C123", "ts": "1700000000.000200"})

		// Discord
		case "/api/v10/users/@me":
			if r.Header.Get("Authorization") != "Bot disc-good" {
				w.WriteHeader(http.StatusUnauthorized)
				_ = json.NewEncoder(w).Encode(map[string]any{"message": "401: Unauthorized"})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "d-bot-1", "username": "VibeDiscord"})
		case "/api/v10/channels/chan-99/messages":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "disc-msg-1"})

		// QQ
		case "/app/getAppAccessToken":
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "qq-acc-tok", "expires_in": "7200"})
		case "/channels/qq-chan-1/messages":
			if r.Header.Get("Authorization") != "QQBot qq-acc-tok" || r.Header.Get("X-Union-Appid") != "qq-app" {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "qq-msg-99", "code": 0})

		// Weixin
		case "/cgi-bin/token":
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "wx-tok-123", "expires_in": 7200, "errcode": 0})
		case "/cgi-bin/message/custom/send":
			if r.URL.Query().Get("access_token") != "wx-tok-123" {
				_ = json.NewEncoder(w).Encode(map[string]any{"errcode": 40001, "errmsg": "invalid credential"})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"errcode": 0, "errmsg": "ok"})

		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	svc, err := NewService(Options{
		HTTPClient: srv.Client(),
		APIBaseURL: srv.URL,
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	ctx := context.Background()

	// Rejected Telegram token fails VerifyCredentials and Login even if VIBEVALLEY_TEST_RUNTIMES=1 because custom apiBaseUrl is set.
	if _, err := svc.VerifyCredentials(ctx, ConnectorTelegram, ConnectorLogin{BotToken: "bad-tg-token"}); !errors.Is(err, ErrConnectorRefused) {
		t.Fatalf("expected ErrConnectorRefused for bad telegram token, got %v", err)
	}
	if _, err := svc.VerifyCredentials(ctx, ConnectorSlack, ConnectorLogin{BotToken: "xoxb-bad"}); !errors.Is(err, ErrConnectorRefused) {
		t.Fatalf("expected ErrConnectorRefused for bad slack token, got %v", err)
	}
	if _, err := svc.VerifyCredentials(ctx, ConnectorDiscord, ConnectorLogin{BotToken: "disc-bad"}); !errors.Is(err, ErrConnectorRefused) {
		t.Fatalf("expected ErrConnectorRefused for bad discord token, got %v", err)
	}

	// Live Login + SendOutbound across all 6 platforms.
	cases := []struct {
		id      ConnectorID
		login   ConnectorLogin
		chatID  string
		replyTo string
		wantMsg string
	}{
		{ConnectorTelegram, ConnectorLogin{BotToken: "good-tg-token"}, "98765", "12", "777"},
		{ConnectorFeishu, ConnectorLogin{AppID: "fs-app", Secret: "fs-sec"}, "ou_alice", "om_0", "om_feishu_1"},
		{ConnectorSlack, ConnectorLogin{BotToken: "xoxb-good"}, "C123", "1700000000.000100", "1700000000.000200"},
		{ConnectorDiscord, ConnectorLogin{BotToken: "disc-good"}, "chan-99", "ref-1", "disc-msg-1"},
		{ConnectorQQ, ConnectorLogin{AppID: "qq-app", Secret: "qq-sec"}, "qq-chan-1", "msg-prev", "qq-msg-99"},
		{ConnectorWeixin, ConnectorLogin{AppID: "wx-app", Secret: "wx-sec"}, "wx-open-1", "", "weixin:wx-open-1"},
	}

	for _, tc := range cases {
		check, err := svc.VerifyCredentials(ctx, tc.id, tc.login)
		if err != nil || !check.OK || check.Offline {
			t.Fatalf("%s VerifyCredentials failed: check=%+v err=%v", tc.id, check, err)
		}
		if _, err := svc.Login(ctx, tc.id, tc.login); err != nil {
			t.Fatalf("%s Login failed: %v", tc.id, err)
		}
		msgID, err := svc.SendOutbound(ctx, tc.id, tc.chatID, "hello "+string(tc.id), tc.replyTo)
		if err != nil {
			t.Fatalf("%s SendOutbound failed: %v", tc.id, err)
		}
		if msgID != tc.wantMsg {
			t.Fatalf("%s SendOutbound msgID = %q, want %q", tc.id, msgID, tc.wantMsg)
		}
	}

	// Verify key headers & paths observed by upstream server.
	mu.Lock()
	defer mu.Unlock()
	var sawDiscordAuth, sawSlackThread, sawTelegramReply bool
	for _, r := range reqs {
		if r.Path == "/api/v10/users/@me" && r.Auth == "Bot disc-good" {
			sawDiscordAuth = true
		}
		if r.Path == "/api/chat.postMessage" && strings.Contains(r.Body, `"thread_ts":"1700000000.000100"`) {
			sawSlackThread = true
		}
		if r.Path == "/botgood-tg-token/sendMessage" && strings.Contains(r.Body, `"reply_to_message_id":12`) {
			sawTelegramReply = true
		}
	}
	if !sawDiscordAuth || !sawSlackThread || !sawTelegramReply {
		t.Fatalf("missing expected upstream request assertions: discord=%v slack=%v tg=%v", sawDiscordAuth, sawSlackThread, sawTelegramReply)
	}
}

func TestConnectorParseWebhookPayloadsAndInboundCallback(t *testing.T) {
	t.Parallel()

	// Feishu URL verification challenge.
	fsCh, err := ParseWebhookPayload(ConnectorFeishu, []byte(`{"type":"url_verification","challenge":"fs-ch-123","token":"tok"}`))
	if err != nil || fsCh.Challenge != "fs-ch-123" || fsCh.ConnectorID != ConnectorFeishu {
		t.Fatalf("feishu challenge mismatch: %+v err=%v", fsCh, err)
	}
	// Slack URL verification challenge.
	slCh, err := ParseWebhookPayload(ConnectorSlack, []byte(`{"type":"url_verification","challenge":"sl-ch-456"}`))
	if err != nil || slCh.Challenge != "sl-ch-456" || slCh.ConnectorID != ConnectorSlack {
		t.Fatalf("slack challenge mismatch: %+v err=%v", slCh, err)
	}

	// Normalized message parsing across all 6 platforms.
	tests := []struct {
		kind     ConnectorID
		body     string
		wantChat string
		wantUser string
		wantName string
		wantText string
	}{
		{
			kind:     ConnectorTelegram,
			body:     `{"update_id":1,"message":{"message_id":9,"from":{"id":42,"username":"alice"},"chat":{"id":-1001},"text":"hi tg"}}`,
			wantChat: "-1001", wantUser: "42", wantName: "alice", wantText: "hi tg",
		},
		{
			kind:     ConnectorFeishu,
			body:     `{"schema":"2.0","header":{"event_type":"im.message.receive_v1"},"event":{"sender":{"sender_id":{"open_id":"ou_1"}},"message":{"message_id":"om_1","chat_id":"oc_9","message_type":"text","content":"{\"text\":\"hi feishu\"}"}}}`,
			wantChat: "oc_9", wantUser: "ou_1", wantName: "ou_1", wantText: "hi feishu",
		},
		{
			kind:     ConnectorSlack,
			body:     `{"type":"event_callback","event":{"type":"message","channel":"C99","user":"U77","username":"bob","text":"hi slack","ts":"1.2"}}`,
			wantChat: "C99", wantUser: "U77", wantName: "bob", wantText: "hi slack",
		},
		{
			kind:     ConnectorDiscord,
			body:     `{"t":"MESSAGE_CREATE","d":{"id":"m1","channel_id":"dc-1","content":"hi discord","author":{"id":"du-1","username":"carol","global_name":"Carol"}}}`,
			wantChat: "dc-1", wantUser: "du-1", wantName: "Carol", wantText: "hi discord",
		},
		{
			kind:     ConnectorQQ,
			body:     `{"op":0,"t":"GROUP_AT_MESSAGE_CREATE","d":{"id":"qm-1","channel_id":"qch-1","content":" hi qq ","author":{"user_openid":"qu-1","username":"dave"}}}`,
			wantChat: "qch-1", wantUser: "qu-1", wantName: "dave", wantText: "hi qq",
		},
		{
			kind:     ConnectorWeixin,
			body:     `<xml><ToUserName><![CDATA[gh_bot]]></ToUserName><FromUserName><![CDATA[wx_u1]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hi weixin]]></Content><MsgId>888</MsgId></xml>`,
			wantChat: "wx_u1", wantUser: "wx_u1", wantName: "wx_u1", wantText: "hi weixin",
		},
	}
	for _, tc := range tests {
		got, err := ParseWebhookPayload(tc.kind, []byte(tc.body))
		if err != nil {
			t.Fatalf("%s ParseWebhookPayload: %v", tc.kind, err)
		}
		if got.ConnectorID != tc.kind || got.Kind != string(tc.kind) ||
			got.ExternalChatID != tc.wantChat || got.ExternalUserID != tc.wantUser ||
			got.SenderName != tc.wantName || got.Text != tc.wantText {
			t.Fatalf("%s parsed mismatch: got=%+v", tc.kind, got)
		}
	}

	// HandleWebhook invokes registered callback.
	var received []InboundMessage
	svc, err := NewService(Options{
		OnInbound: func(_ context.Context, msg InboundMessage) error {
			received = append(received, msg)
			return nil
		},
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	// Pure challenge does not trigger message callback.
	if _, err := svc.HandleWebhook(context.Background(), ConnectorSlack, []byte(`{"type":"url_verification","challenge":"abc"}`)); err != nil {
		t.Fatalf("HandleWebhook challenge: %v", err)
	}
	if len(received) != 0 {
		t.Fatalf("expected 0 callbacks for challenge, got %d", len(received))
	}
	if _, err := svc.HandleWebhook(context.Background(), ConnectorSlack, []byte(`{"type":"event_callback","event":{"channel":"C1","user":"U1","text":"ping"}}`)); err != nil {
		t.Fatalf("HandleWebhook message: %v", err)
	}
	if len(received) != 1 || received[0].Text != "ping" {
		t.Fatalf("unexpected received callbacks: %+v", received)
	}
}

func TestConnectorPollTelegramUpdates(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/bottg-poll-tok/getMe":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":     true,
				"result": map[string]any{"id": 1, "username": "poll_bot"},
			})
		case "/bottg-poll-tok/getUpdates":
			if r.URL.Query().Get("offset") != "10" {
				http.Error(w, "unexpected offset", http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true,
				"result": []map[string]any{
					{
						"update_id": 10,
						"message": map[string]any{
							"message_id": 101,
							"from":       map[string]any{"id": 500, "username": "farmer"},
							"chat":       map[string]any{"id": 500},
							"text":       "status report",
						},
					},
					{
						"update_id": 11,
						"message": map[string]any{
							"message_id": 102,
							"from":       map[string]any{"id": 501, "first_name": "Lin"},
							"chat":       map[string]any{"id": -200},
							"text":       "check barn",
						},
					},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	clk := store.NewFakeClock(time.Unix(1_700_000_500, 0))
	var callbackMsgs []InboundMessage
	svc, err := NewService(Options{
		Clock:      clk,
		HTTPClient: srv.Client(),
		APIBaseURL: srv.URL,
		OnInbound: func(_ context.Context, msg InboundMessage) error {
			callbackMsgs = append(callbackMsgs, msg)
			return nil
		},
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	if _, err := svc.Login(context.Background(), ConnectorTelegram, ConnectorLogin{BotToken: "tg-poll-tok"}); err != nil {
		t.Fatalf("Login: %v", err)
	}

	msgs, nextOffset, err := svc.PollTelegramUpdates(context.Background(), 10, 0)
	if err != nil {
		t.Fatalf("PollTelegramUpdates: %v", err)
	}
	if nextOffset != 12 || len(msgs) != 2 || len(callbackMsgs) != 2 {
		t.Fatalf("unexpected poll output: next=%d msgs=%+v cb=%+v", nextOffset, msgs, callbackMsgs)
	}
	if msgs[0].Text != "status report" || msgs[1].SenderName != "Lin" {
		t.Fatalf("unexpected polled messages: %+v", msgs)
	}
	st, err := svc.Get(ConnectorTelegram)
	if err != nil || st.LastInbound == nil || *st.LastInbound != clk.NowMs() {
		t.Fatalf("expected LastInbound updated to %d, got %+v", clk.NowMs(), st)
	}
}

func TestConnectorWeixinJSONDiscordDirectAndOfflineSend(t *testing.T) {
	t.Setenv("VIBEVALLEY_TEST_RUNTIMES", "1")

	// Weixin JSON and iLink item_list webhook parsing.
	wxJSON, err := ParseWebhookPayload(ConnectorWeixin, []byte(`{"from_user_id":"wx_u2","message_id":"m9","context_token":"ctx-1","item_list":[{"type":1,"text_item":{"text":"hello wx json"}}]}`))
	if err != nil || wxJSON.ExternalUserID != "wx_u2" || wxJSON.Text != "hello wx json" || wxJSON.ReplyToID != "ctx-1" {
		t.Fatalf("unexpected weixin json parse: %+v err=%v", wxJSON, err)
	}

	// Discord direct message payload.
	dcDirect, err := ParseWebhookPayload(ConnectorDiscord, []byte(`{"id":"dm1","channel_id":"c7","content":"direct ping","author":{"id":"u7","username":"eva"}}`))
	if err != nil || dcDirect.ExternalChatID != "c7" || dcDirect.SenderName != "eva" || dcDirect.Text != "direct ping" {
		t.Fatalf("unexpected discord direct parse: %+v err=%v", dcDirect, err)
	}

	// Invalid/empty payload rejects cleanly.
	if _, err := ParseWebhookPayload(ConnectorTelegram, []byte{}); !errors.Is(err, ErrConnectorRefused) {
		t.Fatalf("expected ErrConnectorRefused on empty payload, got %v", err)
	}

	// Offline Send fallback when VIBEVALLEY_TEST_RUNTIMES=1 and no custom apiBaseUrl.
	svc, err := NewService(Options{})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	if _, err := svc.Login(context.Background(), ConnectorSlack, ConnectorLogin{BotToken: "xoxb-offline"}); err != nil {
		t.Fatalf("offline Slack Login: %v", err)
	}
	outID, err := svc.Send(context.Background(), ConnectorSlack, "C-off", "offline hello", "")
	if err != nil || outID != "slack:C-off" {
		t.Fatalf("offline Slack Send mismatch: id=%q err=%v", outID, err)
	}
}

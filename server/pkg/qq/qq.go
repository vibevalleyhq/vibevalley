// Package qq is an official QQ bot (q.qq.com), written from Tencent's botpy (the official Python SDK): the bot's
// AppID and AppSecret fetch its token; direct (C2C) messages come over QQ's WebSocket gateway, outbound only; a reply
// is a passive one on the user's message id, which QQ honours only for a while.
package qq

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	apiBase  = "https://api.sgroup.qq.com"
	tokenURL = "https://bots.qq.com/app/getAppAccessToken"
	// intents: group and direct (C2C) messages; Listen hands over the direct ones.
	intents = 1 << 25
)

type App struct {
	AppID  string
	Secret string
}

type Message struct {
	ID          string
	From        string
	Content     string
	Attachments int
}

// SendError is why QQ did not take a message: its HTTP status (0: none), and why.
type SendError struct {
	Status int
	Reason string
}

func (e *SendError) Error() string { return e.Reason }

// API is QQ's side; tests talk to a scripted one.
type API interface {
	// Check checks the credentials by fetching a token.
	Check(ctx context.Context, app App) error
	// Listen opens the gateway and hands each direct message to got until it fails, or ctx ends (nil then).
	Listen(ctx context.Context, app App, got func(Message)) error
	// SendText sends a text to a user, as a reply to msgID when there is one. Its answer is QQ's id for it.
	SendText(ctx context.Context, app App, openID, text, msgID string) (string, *SendError)
}

type cachedToken struct {
	token string
	until time.Time
}

type Client struct {
	api      string
	tokenURL string
	http     *http.Client
	dialer   *websocket.Dialer

	mu sync.Mutex
	// tokens last about two hours; one per app, renewed a minute early.
	tokens map[string]cachedToken
	// replySeq is a reply's sequence number per message replied to: QQ refuses the same (msg_id, msg_seq) twice.
	replySeq map[string]int
}

func NewClient() *Client {
	return &Client{api: apiBase, tokenURL: tokenURL, http: &http.Client{}, dialer: websocket.DefaultDialer,
		tokens: map[string]cachedToken{}, replySeq: map[string]int{}}
}

func (q *Client) token(ctx context.Context, app App) (string, error) {
	q.mu.Lock()
	cached, ok := q.tokens[app.AppID]
	q.mu.Unlock()
	if ok && cached.until.After(time.Now()) {
		return cached.token, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	payload, _ := json.Marshal(map[string]string{"appId": app.AppID, "clientSecret": app.Secret})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, q.tokenURL, bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("QQ 鉴权：%v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := q.http.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", errors.New("QQ 鉴权：超时了")
		}
		return "", fmt.Errorf("QQ 鉴权：%v", err)
	}
	defer res.Body.Close()
	var body struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   any    `json:"expires_in"`
		Message     string `json:"message"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return "", fmt.Errorf("QQ 鉴权：%v", err)
	}
	if body.AccessToken == "" {
		reason := body.Message
		if reason == "" {
			reason = "AppID 或 AppSecret 不对"
		}
		return "", errors.New("QQ 鉴权：" + reason)
	}
	seconds := 7200.0
	switch v := body.ExpiresIn.(type) {
	case float64:
		seconds = v
	case string:
		if n, err := strconv.ParseFloat(v, 64); err == nil {
			seconds = n
		}
	}
	q.mu.Lock()
	q.tokens[app.AppID] = cachedToken{body.AccessToken, time.Now().Add(time.Duration(seconds-60) * time.Second)}
	q.mu.Unlock()
	return body.AccessToken, nil
}

func headers(h http.Header, app App, token string) {
	h.Set("Authorization", "QQBot "+token)
	h.Set("X-Union-Appid", app.AppID)
	h.Set("Content-Type", "application/json")
}

func (q *Client) Check(ctx context.Context, app App) error {
	_, err := q.token(ctx, app)
	return err
}

func (q *Client) Listen(ctx context.Context, app App, got func(Message)) error {
	token, err := q.token(ctx, app)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, q.api+"/gateway", nil)
	if err != nil {
		return fmt.Errorf("QQ 网关：%v", err)
	}
	headers(req.Header, app, token)
	res, err := q.http.Do(req)
	if err != nil {
		return fmt.Errorf("QQ 网关：%v", err)
	}
	var gateway struct {
		URL string `json:"url"`
	}
	json.NewDecoder(res.Body).Decode(&gateway)
	res.Body.Close()
	if gateway.URL == "" {
		return errors.New("QQ 没给网关地址")
	}
	ws, _, err := q.dialer.DialContext(ctx, gateway.URL, nil)
	if err != nil {
		return errors.New("QQ 网关：连接出错")
	}
	defer ws.Close()
	// ctx ending closes the connection, which ends the reading below.
	stop := context.AfterFunc(ctx, func() { ws.Close() })
	defer stop()
	var (
		writing sync.Mutex
		seq     *int64
		beat    *time.Ticker
		seqMu   sync.Mutex
	)
	send := func(payload any) {
		writing.Lock()
		defer writing.Unlock()
		ws.WriteJSON(payload)
	}
	defer func() {
		if beat != nil {
			beat.Stop()
		}
	}()
	for {
		var msg struct {
			Op int             `json:"op"`
			S  *int64          `json:"s"`
			T  string          `json:"t"`
			D  json.RawMessage `json:"d"`
		}
		if err := ws.ReadJSON(&msg); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			var closed *websocket.CloseError
			if errors.As(err, &closed) {
				return fmt.Errorf("QQ 网关：连接关了（%d）", closed.Code)
			}
			return errors.New("QQ 网关：连接出错")
		}
		if msg.S != nil {
			seqMu.Lock()
			seq = msg.S
			seqMu.Unlock()
		}
		switch msg.Op {
		case 10:
			// Hello: say who this is, then keep the heartbeat.
			send(map[string]any{"op": 2, "d": map[string]any{"token": "QQBot " + token, "intents": intents, "shard": []int{0, 1}, "properties": map[string]any{}}})
			var hello struct {
				HeartbeatInterval int64 `json:"heartbeat_interval"`
			}
			json.Unmarshal(msg.D, &hello)
			every := time.Duration(hello.HeartbeatInterval) * time.Millisecond
			if every <= 0 {
				every = 30 * time.Second
			}
			if beat == nil {
				beat = time.NewTicker(every)
				go func(t *time.Ticker) {
					for {
						select {
						case <-ctx.Done():
							return
						case _, ok := <-t.C:
							if !ok {
								return
							}
							seqMu.Lock()
							s := seq
							seqMu.Unlock()
							send(map[string]any{"op": 1, "d": s})
						}
					}
				}(beat)
			}
		case 0:
			if msg.T != "C2C_MESSAGE_CREATE" {
				continue
			}
			var d struct {
				ID      string `json:"id"`
				Content string `json:"content"`
				Author  struct {
					UserOpenID string `json:"user_openid"`
				} `json:"author"`
				Attachments []any `json:"attachments"`
			}
			if json.Unmarshal(msg.D, &d) == nil && d.ID != "" && d.Author.UserOpenID != "" {
				got(Message{ID: d.ID, From: d.Author.UserOpenID, Content: d.Content, Attachments: len(d.Attachments)})
			}
		case 7:
			return errors.New("QQ 网关：QQ 让重新连接")
		case 9:
			return errors.New("QQ 网关：QQ 说会话无效")
		}
	}
}

func (q *Client) SendText(ctx context.Context, app App, openID, text, msgID string) (string, *SendError) {
	token, err := q.token(ctx, app)
	if err != nil {
		return "", &SendError{Status: 401, Reason: err.Error()}
	}
	payload := map[string]any{"content": text, "msg_type": 0}
	if msgID != "" {
		q.mu.Lock()
		q.replySeq[msgID]++
		payload["msg_id"], payload["msg_seq"] = msgID, q.replySeq[msgID]
		q.mu.Unlock()
	}
	encoded, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, q.api+"/v2/users/"+url.PathEscape(openID)+"/messages", bytes.NewReader(encoded))
	if err != nil {
		return "", &SendError{Reason: "QQ 发消息：" + err.Error()}
	}
	headers(req.Header, app, token)
	res, err := q.http.Do(req)
	if err != nil {
		return "", &SendError{Reason: "QQ 发消息：" + err.Error()}
	}
	defer res.Body.Close()
	var body struct {
		ID      string `json:"id"`
		Message string `json:"message"`
		Code    *int   `json:"code"`
	}
	json.NewDecoder(res.Body).Decode(&body)
	if res.StatusCode < 200 || res.StatusCode > 299 {
		code := strconv.Itoa(res.StatusCode)
		if body.Code != nil {
			code = strconv.Itoa(*body.Code)
		}
		return "", &SendError{Status: res.StatusCode, Reason: "QQ 发消息：" + strings.TrimSpace(code+" "+body.Message)}
	}
	return body.ID, nil
}

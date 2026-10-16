// Package weixin is written from the official client (@tencent-weixin/openclaw-weixin 2.4.10, MIT). Only text: pictures, voice and files arrive as a
// word in brackets (voice with WeChat's own transcript).
package weixin

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// A confirmed login may name another host for its account.
const BaseURL = "https://ilinkai.weixin.qq.com"

const Version = "2.4.10"

const (
	StaleToken = -14
	Restricted = -2
)

type Error struct {
	Reason string
	Code   int
}

func (e *Error) Error() string { return e.Reason }

type Account struct {
	BaseURL string
	Token   string
}

type QrStatus struct {
	Status       string `json:"status"` // wait, scaned, confirmed, expired, scaned_but_redirect, need_verifycode, verify_code_blocked, binded_redirect
	BotToken     string `json:"bot_token,omitempty"`
	IlinkBotID   string `json:"ilink_bot_id,omitempty"`
	BaseURL      string `json:"baseurl,omitempty"`
	IlinkUserID  string `json:"ilink_user_id,omitempty"`
	RedirectHost string `json:"redirect_host,omitempty"`
}

type Item struct {
	Type     int `json:"type,omitempty"`
	TextItem *struct {
		Text string `json:"text,omitempty"`
	} `json:"text_item,omitempty"`
	VoiceItem *struct {
		Text string `json:"text,omitempty"`
	} `json:"voice_item,omitempty"`
	FileItem *struct {
		FileName string `json:"file_name,omitempty"`
	} `json:"file_item,omitempty"`
	RefMsg *struct {
		SvrID       string `json:"svr_id,omitempty"`
		Title       string `json:"title,omitempty"`
		MessageItem *Item  `json:"message_item,omitempty"`
	} `json:"ref_msg,omitempty"`
}

type Message struct {
	MessageID    string `json:"message_id,omitempty"`
	FromUserID   string `json:"from_user_id,omitempty"`
	MessageType  int    `json:"message_type,omitempty"`
	ContextToken string `json:"context_token,omitempty"`
	GroupID      string `json:"group_id,omitempty"`
	ItemList     []Item `json:"item_list,omitempty"`
}

type Updates struct {
	Ret                  *int      `json:"ret,omitempty"`
	Errcode              *int      `json:"errcode,omitempty"`
	Errmsg               string    `json:"errmsg,omitempty"`
	Msgs                 []Message `json:"msgs,omitempty"`
	GetUpdatesBuf        string    `json:"get_updates_buf,omitempty"`
	LongpollingTimeoutMs int64     `json:"longpolling_timeout_ms,omitempty"`
}

type API interface {
	QrCode(ctx context.Context) (qrcode, url string, err error)
	// A network hiccup reads as wait.
	QrStatus(ctx context.Context, baseURL, qrcode, verifyCode string) QrStatus
	// Nothing within timeout reads as an empty answer.
	GetUpdates(ctx context.Context, account Account, buf string, timeout time.Duration) (Updates, error)
	// Rides on the context of the user's latest message.
	SendText(ctx context.Context, account Account, to, text, contextToken string) (string, error)
}

func Failed(ret, errcode *int) *int {
	if ret != nil && *ret != 0 {
		return ret
	}
	if errcode != nil && *errcode != 0 {
		return errcode
	}
	return nil
}

// Message ids are 64-bit numbers: kept as text before they are decoded.
var lossless = regexp.MustCompile(`"(message_id|msg_id|svr_id)"(\s*):(\s*)(-?\d+)`)

type Client struct {
	base string
	http *http.Client
}

func NewClient() *Client {
	return &Client{base: BaseURL, http: &http.Client{}}
}

func clientVersion(v string) int {
	parts := strings.Split(v, ".")
	n := [3]int{}
	for i := 0; i < 3 && i < len(parts); i++ {
		n[i], _ = strconv.Atoi(parts[i])
	}
	return (n[0]&0xff)<<16 | (n[1]&0xff)<<8 | n[2]&0xff
}

var baseInfo = map[string]string{"channel_version": Version, "bot_agent": "vibevalley/0.1.0"}

func headers(h http.Header, token string, auth bool) {
	h.Set("iLink-App-Id", "bot")
	h.Set("iLink-App-ClientVersion", strconv.Itoa(clientVersion(Version)))
	if !auth {
		return
	}
	h.Set("Content-Type", "application/json")
	h.Set("AuthorizationType", "ilink_bot_token")
	// A random number per request, as the official client sends it.
	raw := make([]byte, 4)
	rand.Read(raw)
	h.Set("X-WECHAT-UIN", base64.StdEncoding.EncodeToString([]byte(strconv.FormatUint(uint64(binary.BigEndian.Uint32(raw)), 10))))
	if token != "" {
		h.Set("Authorization", "Bearer "+token)
	}
}

func endpointURL(baseURL, endpoint string) string {
	if !strings.HasSuffix(baseURL, "/") {
		baseURL += "/"
	}
	return baseURL + endpoint
}

func (l *Client) request(ctx context.Context, label, method, target string, body any, token string, auth bool, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return &Error{Reason: label + ": " + err.Error()}
	}
	headers(req.Header, token, auth)
	res, err := l.http.Do(req)
	if err != nil {
		return &Error{Reason: label + ": " + err.Error()}
	}
	defer res.Body.Close()
	text, err := io.ReadAll(res.Body)
	if err != nil {
		return &Error{Reason: label + ": " + err.Error()}
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return &Error{Reason: fmt.Sprintf("%s: %d", label, res.StatusCode)}
	}
	if err := json.Unmarshal(lossless.ReplaceAll(text, []byte(`"$1"$2:$3"$4"`)), out); err != nil {
		return &Error{Reason: label + ": " + err.Error()}
	}
	return nil
}

func (l *Client) QrCode(ctx context.Context) (string, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var body struct {
		Qrcode           string `json:"qrcode"`
		QrcodeImgContent string `json:"qrcode_img_content"`
	}
	err := l.request(ctx, "get_bot_qrcode", http.MethodPost, endpointURL(l.base, "ilink/bot/get_bot_qrcode?bot_type=3"),
		map[string]any{"local_token_list": []string{}}, "", true, &body)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", "", &Error{Reason: "get_bot_qrcode: timed out"}
		}
		return "", "", err
	}
	if body.Qrcode == "" || body.QrcodeImgContent == "" {
		return "", "", &Error{Reason: "get_bot_qrcode: no code in the answer"}
	}
	return body.Qrcode, body.QrcodeImgContent, nil
}

func (l *Client) QrStatus(ctx context.Context, baseURL, qrcode, verifyCode string) QrStatus {
	ctx, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	q := "ilink/bot/get_qrcode_status?qrcode=" + url.QueryEscape(qrcode)
	if verifyCode != "" {
		q += "&verify_code=" + url.QueryEscape(verifyCode)
	}
	var s QrStatus
	if err := l.request(ctx, "get_qrcode_status", http.MethodGet, endpointURL(baseURL, q), nil, "", false, &s); err != nil || s.Status == "" {
		return QrStatus{Status: "wait"}
	}
	return s
}

func (l *Client) GetUpdates(ctx context.Context, account Account, buf string, timeout time.Duration) (Updates, error) {
	poll, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var u Updates
	err := l.request(poll, "getupdates", http.MethodPost, endpointURL(account.BaseURL, "ilink/bot/getupdates"),
		map[string]any{"get_updates_buf": buf, "base_info": baseInfo}, account.Token, true, &u)
	if err != nil && ctx.Err() == nil && errors.Is(poll.Err(), context.DeadlineExceeded) {
		zero := 0
		return Updates{Ret: &zero, GetUpdatesBuf: buf}, nil
	}
	return u, err
}

func (l *Client) SendText(ctx context.Context, account Account, to, text, contextToken string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	msg := map[string]any{
		"from_user_id":  "",
		"to_user_id":    to,
		"client_id":     "vibevalley-" + uuid.NewString(),
		"message_type":  2,
		"message_state": 2,
		"item_list":     []any{map[string]any{"type": 1, "text_item": map[string]string{"text": text}}},
	}
	if contextToken != "" {
		msg["context_token"] = contextToken
	}
	var body struct {
		Ret       *int   `json:"ret"`
		Errcode   *int   `json:"errcode"`
		Errmsg    string `json:"errmsg"`
		MessageID string `json:"message_id"`
	}
	err := l.request(ctx, "sendmessage", http.MethodPost, endpointURL(account.BaseURL, "ilink/bot/sendmessage"),
		map[string]any{"msg": msg, "base_info": baseInfo}, account.Token, true, &body)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", &Error{Reason: "sendmessage: timed out"}
		}
		return "", err
	}
	if code := Failed(body.Ret, body.Errcode); code != nil {
		reason := body.Errmsg
		if reason == "" {
			reason = strconv.Itoa(*code)
		}
		return "", &Error{Reason: "sendmessage: " + reason, Code: *code}
	}
	return body.MessageID, nil
}

func Text(m Message) string {
	var parts []string
	for _, item := range m.ItemList {
		part := ""
		switch item.Type {
		case 1:
			if item.TextItem != nil {
				part = item.TextItem.Text
			}
		case 3:
			part = "[语音]"
			if item.VoiceItem != nil && item.VoiceItem.Text != "" {
				part = item.VoiceItem.Text
			}
		case 2:
			part = "[图片]"
		case 4:
			part = "[文件]"
			if item.FileItem != nil && item.FileItem.FileName != "" {
				part = "[文件：" + item.FileItem.FileName + "]"
			}
		case 5:
			part = "[视频]"
		}
		if part != "" {
			parts = append(parts, part)
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

func Quoted(m Message) string {
	for _, item := range m.ItemList {
		if item.RefMsg != nil && item.RefMsg.SvrID != "" {
			return item.RefMsg.SvrID
		}
	}
	return ""
}

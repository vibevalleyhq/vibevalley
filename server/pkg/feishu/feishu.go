// Package feishu logs in by Feishu's scan-to-create flow: Feishu creates a personal bot app for the user and hands back its app id and secret (the
// device-code flow nanobot uses: accounts.feishu.cn/oauth/v1/app/registration).
package feishu

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	lark "github.com/larksuite/oapi-sdk-go/v3"

	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	"github.com/larksuite/oapi-sdk-go/v3/event/dispatcher"

	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"

	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"
)

type Domain = string // feishu, lark

type Registration struct {
	DeviceCode string
	URL        string
	Interval   time.Duration
	Expires    time.Duration
}

type RegistrationPoll struct {
	Status    string // pending, failed, succeeded
	Domain    Domain
	Reason    string
	AppID     string
	AppSecret string
	OpenID    string
}

type Message struct {
	MessageID   string
	From        string
	ChatType    string
	MessageType string
	// JSON, as Feishu sends it.
	Content  string
	ParentID string
}

type App struct {
	AppID     string
	AppSecret string
	Domain    Domain
}

type API interface {
	Register(ctx context.Context) (Registration, error)
	Poll(ctx context.Context, deviceCode string, domain Domain) RegistrationPoll
	Listen(ctx context.Context, app App, got func(Message)) error
	SendText(ctx context.Context, app App, openID, text string) (string, error)
}

type Client struct {
	accounts map[Domain]string
	open     map[Domain]string
	http     *http.Client
}

func NewClient() *Client {
	return &Client{
		accounts: map[Domain]string{"feishu": "https://accounts.feishu.cn", "lark": "https://accounts.larksuite.com"},
		open:     map[Domain]string{"feishu": lark.FeishuBaseUrl, "lark": lark.LarkBaseUrl},
		http:     &http.Client{},
	}
}

// The endpoint answers JSON even with an error status (a pending poll is a 400).
func (l *Client) form(ctx context.Context, domain Domain, body url.Values) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, l.accounts[domain]+"/oauth/v1/app/registration", strings.NewReader(body.Encode()))
	if err != nil {
		return nil, fmt.Errorf("飞书注册：%v", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := l.http.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, errors.New("飞书注册：超时了")
		}
		return nil, fmt.Errorf("飞书注册：%v", err)
	}
	defer res.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("飞书注册：%v", err)
	}
	return out, nil
}

func str(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

func (l *Client) Register(ctx context.Context) (Registration, error) {
	init, err := l.form(ctx, "feishu", url.Values{"action": {"init"}})
	if err != nil {
		return Registration{}, err
	}
	methods, _ := init["supported_auth_methods"].([]any)
	if !slices.Contains(methods, any("client_secret")) {
		return Registration{}, errors.New("飞书现在不支持扫码建应用，请稍后再试。")
	}
	begin, err := l.form(ctx, "feishu", url.Values{"action": {"begin"}, "archetype": {"PersonalAgent"}, "auth_method": {"client_secret"}, "request_user_info": {"open_id"}})
	if err != nil {
		return Registration{}, err
	}
	deviceCode, link := str(begin, "device_code"), str(begin, "verification_uri_complete")
	if deviceCode == "" || link == "" {
		return Registration{}, errors.New("飞书没给二维码，请重试。")
	}
	// Personal-agent codes land on /page/cli (as nanobot does it); keep the query as it is.
	if parsed, err := url.Parse(link); err == nil && (parsed.Host == "open.feishu.cn" || parsed.Host == "open.larksuite.com") && parsed.Path == "/page/launcher" {
		parsed.Path = "/page/cli"
		link = parsed.String()
	}
	interval := 5.0
	if n, ok := begin["interval"].(float64); ok {
		interval = n
	}
	expires := 600.0
	if n, ok := begin["expires_in"].(float64); ok {
		expires = n
	} else if n, ok := begin["expire_in"].(float64); ok {
		expires = n
	}
	return Registration{DeviceCode: deviceCode, URL: link, Interval: time.Duration(max(2, interval) * float64(time.Second)), Expires: time.Duration(expires * float64(time.Second))}, nil
}

func (l *Client) Poll(ctx context.Context, deviceCode string, domain Domain) RegistrationPoll {
	res, err := l.form(ctx, domain, url.Values{"action": {"poll"}, "device_code": {deviceCode}, "tp": {"ob_app"}})
	if err != nil {
		return RegistrationPoll{Status: "pending", Domain: domain}
	}
	user, _ := res["user_info"].(map[string]any)
	where := domain
	if str(user, "tenant_brand") == "lark" {
		where = "lark"
	}
	id, idOK := res["client_id"].(string)
	secret, secretOK := res["client_secret"].(string)
	if idOK && secretOK {
		return RegistrationPoll{Status: "succeeded", AppID: id, AppSecret: secret, Domain: where, OpenID: str(user, "open_id")}
	}
	switch str(res, "error") {
	case "access_denied":
		return RegistrationPoll{Status: "failed", Reason: "在飞书里拒绝了。"}
	case "expired_token":
		return RegistrationPoll{Status: "failed", Reason: "二维码过期了。"}
	}
	return RegistrationPoll{Status: "pending", Domain: where}
}

func (l *Client) Listen(ctx context.Context, app App, got func(Message)) error {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	handler := dispatcher.NewEventDispatcher("", "").OnP2MessageReceiveV1(func(_ context.Context, e *larkim.P2MessageReceiveV1) error {
		if e.Event == nil || e.Event.Sender == nil || e.Event.Message == nil {
			return nil
		}
		sender, m := e.Event.Sender, e.Event.Message
		from := ""
		if sender.SenderId != nil && sender.SenderId.OpenId != nil {
			from = *sender.SenderId.OpenId
		}
		if from == "" || sender.SenderType == nil || *sender.SenderType != "user" {
			return nil
		}
		deref := func(s *string) string {
			if s == nil {
				return ""
			}
			return *s
		}
		got(Message{MessageID: deref(m.MessageId), From: from, ChatType: deref(m.ChatType), MessageType: deref(m.MessageType),
			Content: deref(m.Content), ParentID: deref(m.ParentId)})
		return nil
	})
	client := larkws.NewClient(app.AppID, app.AppSecret,
		larkws.WithEventHandler(handler),
		larkws.WithDomain(l.open[app.Domain]),
		larkws.WithLogLevel(larkcore.LogLevelWarn),
		larkws.WithOnError(func(err error) { cancel(err) }),
	)
	err := client.Start(ctx)
	if cause := context.Cause(ctx); cause != nil && !errors.Is(cause, context.Canceled) {
		return fmt.Errorf("飞书长连接断了：%v", cause)
	}
	if ctx.Err() != nil {
		return nil
	}
	if err == nil {
		err = errors.New("连接停了")
	}
	return fmt.Errorf("飞书长连接断了：%v", err)
}

func (l *Client) SendText(ctx context.Context, app App, openID, text string) (string, error) {
	client := lark.NewClient(app.AppID, app.AppSecret, lark.WithOpenBaseUrl(l.open[app.Domain]), lark.WithLogLevel(larkcore.LogLevelWarn),
		lark.WithHttpClient(l.http))
	content, _ := json.Marshal(map[string]string{"text": text})
	res, err := client.Im.V1.Message.Create(ctx, larkim.NewCreateMessageReqBuilder().
		ReceiveIdType("open_id").
		Body(larkim.NewCreateMessageReqBodyBuilder().ReceiveId(openID).MsgType("text").Content(string(content)).Build()).
		Build())
	if err != nil {
		return "", fmt.Errorf("飞书发消息：%v", err)
	}
	if res.Code != 0 {
		return "", fmt.Errorf("飞书发消息：%d %s", res.Code, res.Msg)
	}
	if res.Data != nil && res.Data.MessageId != nil {
		return *res.Data.MessageId, nil
	}
	return "", nil
}

func Text(m Message) string {
	if m.MessageType != "text" {
		switch m.MessageType {
		case "image":
			return "[图片]"
		case "file":
			return "[文件]"
		case "audio":
			return "[语音]"
		case "media":
			return "[视频]"
		case "sticker":
			return "[表情]"
		}
		return "[消息]"
	}
	var parsed struct {
		Text string `json:"text"`
	}
	if json.Unmarshal([]byte(m.Content), &parsed) != nil {
		return ""
	}
	return strings.TrimSpace(parsed.Text)
}

package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
)

const (
	defaultTelegramBaseURL = "https://api.telegram.org"
	defaultFeishuBaseURL   = "https://open.feishu.cn"
	defaultLarkBaseURL     = "https://open.larksuite.com"
	defaultSlackBaseURL    = "https://slack.com"
	defaultDiscordBaseURL  = "https://discord.com"
	defaultQQTokenBaseURL  = "https://bots.qq.com"
	defaultQQAPIBaseURL    = "https://api.sgroup.qq.com"
	defaultWeixinBaseURL   = "https://api.weixin.qq.com"

	maxConnectorRespBytes = 2 << 20
)

// CredentialCheckResult reports the outcome of a live or offline connector credential verification.
type CredentialCheckResult struct {
	ConnectorID ConnectorID       `json:"connectorId"`
	OK          bool              `json:"ok"`
	Offline     bool              `json:"offline,omitempty"`
	User        string            `json:"user,omitempty"`
	Endpoint    string            `json:"endpoint,omitempty"`
	Secrets     map[string]string `json:"-"`
}

func isOfflineTestMode() bool {
	return os.Getenv("VIBEVALLEY_TEST_RUNTIMES") == "1"
}

func cleanBaseURL(raw string) string {
	return strings.TrimRight(strings.TrimSpace(raw), "/")
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func defaultPlatformBaseURL(id ConnectorID, domain string) string {
	switch id {
	case ConnectorTelegram:
		return defaultTelegramBaseURL
	case ConnectorFeishu:
		if strings.EqualFold(strings.TrimSpace(domain), "lark") {
			return defaultLarkBaseURL
		}
		return defaultFeishuBaseURL
	case ConnectorSlack:
		return defaultSlackBaseURL
	case ConnectorDiscord:
		return defaultDiscordBaseURL
	case ConnectorQQ:
		return defaultQQAPIBaseURL
	case ConnectorWeixin:
		return defaultWeixinBaseURL
	default:
		return ""
	}
}

func resolveTokenAndSecrets(id ConnectorID, input ConnectorLogin, stored map[string]string) (appID, secret, botToken, domain, customBase string) {
	appID = firstNonEmpty(input.AppID, stored["appId"])
	secret = firstNonEmpty(input.Secret, stored["secret"], stored["appSecret"])
	botToken = firstNonEmpty(input.BotToken, stored["botToken"], stored["accessToken"])
	if botToken == "" && (id == ConnectorTelegram || id == ConnectorDiscord || id == ConnectorSlack) {
		botToken = secret
	}
	domain = firstNonEmpty(input.Domain, stored["domain"])
	if id == ConnectorFeishu && domain == "" {
		domain = "feishu"
	}
	customBase = cleanBaseURL(firstNonEmpty(input.APIBaseURL, stored["apiBaseUrl"]))
	return appID, secret, botToken, domain, customBase
}

type liveAdapter struct {
	id         ConnectorID
	httpClient *http.Client
	baseURL    string

	qqMu       sync.Mutex
	qqReplySeq map[string]int
}

func newBuiltinAdapter(id ConnectorID, httpClient *http.Client, baseURL string) Adapter {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &liveAdapter{
		id:         id,
		httpClient: httpClient,
		baseURL:    cleanBaseURL(baseURL),
		qqReplySeq: make(map[string]int),
	}
}

func (a *liveAdapter) ID() ConnectorID { return a.id }

func (a *liveAdapter) customBaseURL(inputBase string, secrets map[string]string) string {
	return cleanBaseURL(firstNonEmpty(inputBase, secrets["apiBaseUrl"], a.baseURL))
}

func (a *liveAdapter) Login(ctx context.Context, input ConnectorLogin) (LoginOutcome, error) {
	if err := ctx.Err(); err != nil {
		return LoginOutcome{}, err
	}
	appID, secret, botToken, domain, customBase := resolveTokenAndSecrets(a.id, input, nil)
	effectiveCustomBase := cleanBaseURL(firstNonEmpty(customBase, a.baseURL))
	useLive := !isOfflineTestMode() || effectiveCustomBase != ""

	switch a.id {
	case ConnectorTelegram, ConnectorDiscord, ConnectorSlack:
		if botToken == "" {
			return LoginOutcome{}, fmt.Errorf("%s bot token or secret is required", a.id)
		}
		if !useLive {
			return LoginOutcome{
				State: StateConnected,
				User:  string(a.id) + "-bot",
				Secrets: withCustomBaseURL(map[string]string{
					"botToken": botToken,
					"appId":    appID,
				}, effectiveCustomBase),
			}, nil
		}
		res, err := a.VerifyCredentials(ctx, input, nil)
		if err != nil {
			return LoginOutcome{}, err
		}
		user := firstNonEmpty(res.User, string(a.id)+"-bot")
		return LoginOutcome{
			State:   StateConnected,
			User:    user,
			Secrets: res.Secrets,
		}, nil

	case ConnectorQQ:
		if appID == "" || secret == "" {
			return LoginOutcome{}, errors.New("qq requires appId and secret")
		}
		if !useLive {
			return LoginOutcome{
				State: StatePairing,
				Secrets: withCustomBaseURL(map[string]string{
					"appId":  appID,
					"secret": secret,
				}, effectiveCustomBase),
			}, nil
		}
		res, err := a.VerifyCredentials(ctx, input, nil)
		if err != nil {
			return LoginOutcome{}, err
		}
		return LoginOutcome{
			State:   StatePairing,
			Secrets: res.Secrets,
		}, nil

	case ConnectorFeishu:
		if appID != "" && secret != "" {
			if !useLive {
				return LoginOutcome{
					State: StatePairing,
					Secrets: withCustomBaseURL(map[string]string{
						"appId":     appID,
						"appSecret": secret,
						"domain":    domain,
					}, effectiveCustomBase),
				}, nil
			}
			res, err := a.VerifyCredentials(ctx, input, nil)
			if err != nil {
				return LoginOutcome{}, err
			}
			return LoginOutcome{
				State:   StatePairing,
				Secrets: res.Secrets,
			}, nil
		}
		return LoginOutcome{
			State:   StateWaiting,
			QR:      fmt.Sprintf("https://open.feishu.cn/page/cli?connector=%s", a.id),
			Secrets: withCustomBaseURL(map[string]string{}, effectiveCustomBase),
		}, nil

	case ConnectorWeixin:
		if appID != "" && secret != "" {
			if !useLive {
				return LoginOutcome{
					State: StateConnected,
					User:  "wx-" + appID,
					Secrets: withCustomBaseURL(map[string]string{
						"appId":  appID,
						"secret": secret,
					}, effectiveCustomBase),
				}, nil
			}
			res, err := a.VerifyCredentials(ctx, input, nil)
			if err != nil {
				return LoginOutcome{}, err
			}
			return LoginOutcome{
				State:   StateConnected,
				User:    firstNonEmpty(res.User, "wx-"+appID),
				Secrets: res.Secrets,
			}, nil
		}
		if botToken != "" {
			return LoginOutcome{
				State: StateConnected,
				User:  "wx-user",
				Secrets: withCustomBaseURL(map[string]string{
					"botToken": botToken,
				}, effectiveCustomBase),
			}, nil
		}
		return LoginOutcome{
			State:   StateWaiting,
			QR:      "https://liteapp.weixin.qq.com/q/vibevalley",
			Secrets: withCustomBaseURL(map[string]string{}, effectiveCustomBase),
		}, nil

	default:
		if appID == "" && secret == "" && botToken == "" {
			return LoginOutcome{
				State:   StateWaiting,
				QR:      fmt.Sprintf("vibevalley://connector/%s/login", a.id),
				Secrets: map[string]string{},
			}, nil
		}
		return LoginOutcome{
			State: StateConnected,
			User:  string(a.id) + "-account",
			Secrets: map[string]string{
				"appId":    appID,
				"secret":   secret,
				"botToken": botToken,
			},
		}, nil
	}
}

func (a *liveAdapter) Verify(_ context.Context, secrets map[string]string, code string) (LoginOutcome, error) {
	if strings.TrimSpace(code) == "" {
		return LoginOutcome{}, errors.New("verification code cannot be empty")
	}
	nextSecrets := cloneStringMap(secrets)
	nextSecrets["verifiedCode"] = code
	return LoginOutcome{
		State:   StateConnected,
		User:    string(a.id) + "-verified",
		Secrets: nextSecrets,
	}, nil
}

// VerifyCredentials checks connector credentials against the real platform API unless offline mode is active
// without a custom apiBaseUrl.
func (a *liveAdapter) VerifyCredentials(ctx context.Context, input ConnectorLogin, stored map[string]string) (CredentialCheckResult, error) {
	if err := ctx.Err(); err != nil {
		return CredentialCheckResult{}, err
	}
	appID, secret, botToken, domain, customBase := resolveTokenAndSecrets(a.id, input, stored)
	customBase = cleanBaseURL(firstNonEmpty(customBase, a.baseURL))

	if isOfflineTestMode() && customBase == "" {
		return a.verifyOffline(appID, secret, botToken, domain)
	}

	switch a.id {
	case ConnectorTelegram:
		if botToken == "" {
			return CredentialCheckResult{}, errors.New("telegram bot token is required")
		}
		base := firstNonEmpty(customBase, defaultTelegramBaseURL)
		endpoint := fmt.Sprintf("%s/bot%s/getMe", base, url.PathEscape(botToken))
		var resp struct {
			OK          bool   `json:"ok"`
			Description string `json:"description"`
			Result      struct {
				ID        int64  `json:"id"`
				Username  string `json:"username"`
				FirstName string `json:"first_name"`
			} `json:"result"`
		}
		status, raw, err := a.doJSON(ctx, http.MethodGet, endpoint, nil, nil)
		if err != nil {
			return CredentialCheckResult{}, fmt.Errorf("telegram getMe: %w", err)
		}
		if err := decodeCheckedJSON(status, raw, &resp); err != nil || !resp.OK {
			msg := firstNonEmpty(resp.Description, errString(err), fmt.Sprintf("HTTP %d", status))
			return CredentialCheckResult{}, fmt.Errorf("telegram getMe failed: %s", msg)
		}
		user := firstNonEmpty(resp.Result.Username, resp.Result.FirstName)
		if user == "" && resp.Result.ID != 0 {
			user = fmt.Sprintf("tg-%d", resp.Result.ID)
		}
		secrets := withCustomBaseURL(map[string]string{
			"botToken": botToken,
			"appId":    appID,
		}, customBase)
		return CredentialCheckResult{ConnectorID: a.id, OK: true, User: user, Endpoint: endpoint, Secrets: secrets}, nil

	case ConnectorFeishu:
		if appID == "" || secret == "" {
			return CredentialCheckResult{}, errors.New("feishu requires appId and secret")
		}
		base := firstNonEmpty(customBase, defaultPlatformBaseURL(ConnectorFeishu, domain))
		tok, endpoint, err := a.fetchFeishuToken(ctx, base, appID, secret)
		if err != nil {
			return CredentialCheckResult{}, err
		}
		secrets := withCustomBaseURL(map[string]string{
			"appId":             appID,
			"appSecret":         secret,
			"domain":            domain,
			"tenantAccessToken": tok,
		}, customBase)
		return CredentialCheckResult{ConnectorID: a.id, OK: true, User: "feishu-" + appID, Endpoint: endpoint, Secrets: secrets}, nil

	case ConnectorSlack:
		if botToken == "" {
			return CredentialCheckResult{}, errors.New("slack bot token is required")
		}
		base := firstNonEmpty(customBase, defaultSlackBaseURL)
		endpoint := base + "/api/auth.test"
		headers := map[string]string{"Authorization": "Bearer " + botToken}
		var resp struct {
			OK     bool   `json:"ok"`
			Error  string `json:"error"`
			User   string `json:"user"`
			UserID string `json:"user_id"`
			BotID  string `json:"bot_id"`
		}
		status, raw, err := a.doJSON(ctx, http.MethodPost, endpoint, headers, map[string]any{})
		if err != nil {
			return CredentialCheckResult{}, fmt.Errorf("slack auth.test: %w", err)
		}
		if err := decodeCheckedJSON(status, raw, &resp); err != nil || !resp.OK {
			msg := firstNonEmpty(resp.Error, errString(err), fmt.Sprintf("HTTP %d", status))
			return CredentialCheckResult{}, fmt.Errorf("slack auth.test failed: %s", msg)
		}
		user := firstNonEmpty(resp.User, resp.UserID, resp.BotID, "slack-bot")
		secrets := withCustomBaseURL(map[string]string{
			"botToken": botToken,
			"appId":    appID,
		}, customBase)
		return CredentialCheckResult{ConnectorID: a.id, OK: true, User: user, Endpoint: endpoint, Secrets: secrets}, nil

	case ConnectorDiscord:
		if botToken == "" {
			return CredentialCheckResult{}, errors.New("discord bot token is required")
		}
		tok := strings.TrimSpace(strings.TrimPrefix(botToken, "Bot "))
		base := firstNonEmpty(customBase, defaultDiscordBaseURL)
		endpoint := base + "/api/v10/users/@me"
		headers := map[string]string{"Authorization": "Bot " + tok}
		var resp struct {
			ID         string `json:"id"`
			Username   string `json:"username"`
			GlobalName string `json:"global_name"`
			Message    string `json:"message"`
		}
		status, raw, err := a.doJSON(ctx, http.MethodGet, endpoint, headers, nil)
		if err != nil {
			return CredentialCheckResult{}, fmt.Errorf("discord users/@me: %w", err)
		}
		if err := decodeCheckedJSON(status, raw, &resp); err != nil || (resp.ID == "" && resp.Username == "") {
			msg := firstNonEmpty(resp.Message, errString(err), fmt.Sprintf("HTTP %d", status))
			return CredentialCheckResult{}, fmt.Errorf("discord users/@me failed: %s", msg)
		}
		user := firstNonEmpty(resp.Username, resp.GlobalName, resp.ID, "discord-bot")
		secrets := withCustomBaseURL(map[string]string{
			"botToken": tok,
			"appId":    appID,
		}, customBase)
		return CredentialCheckResult{ConnectorID: a.id, OK: true, User: user, Endpoint: endpoint, Secrets: secrets}, nil

	case ConnectorQQ:
		if appID == "" || secret == "" {
			return CredentialCheckResult{}, errors.New("qq requires appId and secret")
		}
		tokenBase := firstNonEmpty(customBase, defaultQQTokenBaseURL)
		tok, endpoint, err := a.fetchQQToken(ctx, tokenBase, appID, secret)
		if err != nil {
			return CredentialCheckResult{}, err
		}
		secrets := withCustomBaseURL(map[string]string{
			"appId":       appID,
			"secret":      secret,
			"accessToken": tok,
		}, customBase)
		return CredentialCheckResult{ConnectorID: a.id, OK: true, User: "qq-" + appID, Endpoint: endpoint, Secrets: secrets}, nil

	case ConnectorWeixin:
		if appID == "" || secret == "" {
			return CredentialCheckResult{}, errors.New("weixin requires appId and secret")
		}
		base := firstNonEmpty(customBase, defaultWeixinBaseURL)
		tok, endpoint, err := a.fetchWeixinToken(ctx, base, appID, secret)
		if err != nil {
			return CredentialCheckResult{}, err
		}
		secrets := withCustomBaseURL(map[string]string{
			"appId":       appID,
			"secret":      secret,
			"accessToken": tok,
			"botToken":    tok,
		}, customBase)
		return CredentialCheckResult{ConnectorID: a.id, OK: true, User: "wx-" + appID, Endpoint: endpoint, Secrets: secrets}, nil

	default:
		return CredentialCheckResult{}, fmt.Errorf("unsupported connector %q", a.id)
	}
}

func (a *liveAdapter) verifyOffline(appID, secret, botToken, domain string) (CredentialCheckResult, error) {
	switch a.id {
	case ConnectorTelegram, ConnectorDiscord, ConnectorSlack:
		if botToken == "" {
			return CredentialCheckResult{}, fmt.Errorf("%s bot token or secret is required", a.id)
		}
		return CredentialCheckResult{
			ConnectorID: a.id,
			OK:          true,
			Offline:     true,
			User:        string(a.id) + "-bot",
			Secrets:     map[string]string{"botToken": botToken, "appId": appID},
		}, nil
	case ConnectorQQ:
		if appID == "" || secret == "" {
			return CredentialCheckResult{}, errors.New("qq requires appId and secret")
		}
		return CredentialCheckResult{
			ConnectorID: a.id,
			OK:          true,
			Offline:     true,
			Secrets:     map[string]string{"appId": appID, "secret": secret},
		}, nil
	case ConnectorFeishu:
		if appID == "" || secret == "" {
			return CredentialCheckResult{}, errors.New("feishu requires appId and secret")
		}
		return CredentialCheckResult{
			ConnectorID: a.id,
			OK:          true,
			Offline:     true,
			Secrets:     map[string]string{"appId": appID, "appSecret": secret, "domain": domain},
		}, nil
	case ConnectorWeixin:
		if (appID == "" || secret == "") && botToken == "" {
			return CredentialCheckResult{}, errors.New("weixin requires appId/secret or botToken")
		}
		sec := map[string]string{}
		if appID != "" {
			sec["appId"] = appID
		}
		if secret != "" {
			sec["secret"] = secret
		}
		if botToken != "" {
			sec["botToken"] = botToken
		}
		return CredentialCheckResult{
			ConnectorID: a.id,
			OK:          true,
			Offline:     true,
			User:        "wx-user",
			Secrets:     sec,
		}, nil
	default:
		return CredentialCheckResult{}, fmt.Errorf("unsupported connector %q", a.id)
	}
}

func (a *liveAdapter) Send(ctx context.Context, secrets map[string]string, to, text, replyCtx string) (string, error) {
	if len(secrets) == 0 {
		return "", errors.New("connector has no credentials")
	}
	if strings.TrimSpace(text) == "" {
		return "", errors.New("message text is empty")
	}
	customBase := a.customBaseURL("", secrets)
	if isOfflineTestMode() && customBase == "" {
		return fmt.Sprintf("%s:%s", a.id, to), nil
	}

	switch a.id {
	case ConnectorTelegram:
		return a.sendTelegram(ctx, secrets, customBase, to, text, replyCtx)
	case ConnectorFeishu:
		return a.sendFeishu(ctx, secrets, customBase, to, text, replyCtx)
	case ConnectorSlack:
		return a.sendSlack(ctx, secrets, customBase, to, text, replyCtx)
	case ConnectorDiscord:
		return a.sendDiscord(ctx, secrets, customBase, to, text, replyCtx)
	case ConnectorQQ:
		return a.sendQQ(ctx, secrets, customBase, to, text, replyCtx)
	case ConnectorWeixin:
		return a.sendWeixin(ctx, secrets, customBase, to, text)
	default:
		return fmt.Sprintf("%s:%s", a.id, to), nil
	}
}

func (a *liveAdapter) sendTelegram(ctx context.Context, secrets map[string]string, customBase, to, text, replyToID string) (string, error) {
	tok := firstNonEmpty(secrets["botToken"], secrets["secret"])
	if tok == "" {
		return "", errors.New("telegram botToken is missing")
	}
	base := firstNonEmpty(customBase, defaultTelegramBaseURL)
	endpoint := fmt.Sprintf("%s/bot%s/sendMessage", base, url.PathEscape(tok))
	payload := map[string]any{
		"chat_id": to,
		"text":    text,
	}
	if trimmed := strings.TrimSpace(replyToID); trimmed != "" {
		if msgNum, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
			payload["reply_to_message_id"] = msgNum
		} else {
			payload["reply_to_message_id"] = trimmed
		}
	}
	var resp struct {
		OK          bool   `json:"ok"`
		Description string `json:"description"`
		Result      struct {
			MessageID int64 `json:"message_id"`
		} `json:"result"`
	}
	status, raw, err := a.doJSON(ctx, http.MethodPost, endpoint, nil, payload)
	if err != nil {
		return "", fmt.Errorf("telegram sendMessage: %w", err)
	}
	if err := decodeCheckedJSON(status, raw, &resp); err != nil || !resp.OK {
		msg := firstNonEmpty(resp.Description, errString(err), fmt.Sprintf("HTTP %d", status))
		return "", fmt.Errorf("telegram sendMessage failed: %s", msg)
	}
	if resp.Result.MessageID != 0 {
		return strconv.FormatInt(resp.Result.MessageID, 10), nil
	}
	return fmt.Sprintf("telegram:%s", to), nil
}

func (a *liveAdapter) sendFeishu(ctx context.Context, secrets map[string]string, customBase, to, text, replyToID string) (string, error) {
	domain := firstNonEmpty(secrets["domain"], "feishu")
	base := firstNonEmpty(customBase, defaultPlatformBaseURL(ConnectorFeishu, domain))
	tok := strings.TrimSpace(secrets["tenantAccessToken"])
	if tok == "" {
		appID := firstNonEmpty(secrets["appId"])
		appSecret := firstNonEmpty(secrets["appSecret"], secrets["secret"])
		if appID == "" || appSecret == "" {
			return "", errors.New("feishu credentials are missing")
		}
		var err error
		tok, _, err = a.fetchFeishuToken(ctx, base, appID, appSecret)
		if err != nil {
			return "", err
		}
	}

	receiveIDType := "open_id"
	if strings.HasPrefix(to, "oc_") {
		receiveIDType = "chat_id"
	} else if strings.HasPrefix(to, "on_") {
		receiveIDType = "union_id"
	}
	contentJSON, err := json.Marshal(map[string]string{"text": text})
	if err != nil {
		return "", err
	}
	payload := map[string]any{
		"receive_id": to,
		"msg_type":   "text",
		"content":    string(contentJSON),
	}
	if strings.TrimSpace(replyToID) != "" {
		payload["root_id"] = strings.TrimSpace(replyToID)
	}
	endpoint := fmt.Sprintf("%s/open-apis/im/v1/messages?receive_id_type=%s", base, receiveIDType)
	headers := map[string]string{"Authorization": "Bearer " + tok}
	var resp struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			MessageID string `json:"message_id"`
		} `json:"data"`
	}
	status, raw, err := a.doJSON(ctx, http.MethodPost, endpoint, headers, payload)
	if err != nil {
		return "", fmt.Errorf("feishu sendMessage: %w", err)
	}
	if err := decodeCheckedJSON(status, raw, &resp); err != nil || resp.Code != 0 {
		msg := firstNonEmpty(resp.Msg, errString(err), fmt.Sprintf("code %d", resp.Code))
		return "", fmt.Errorf("feishu sendMessage failed: %s", msg)
	}
	return firstNonEmpty(resp.Data.MessageID, fmt.Sprintf("feishu:%s", to)), nil
}

func (a *liveAdapter) sendSlack(ctx context.Context, secrets map[string]string, customBase, to, text, replyToID string) (string, error) {
	tok := firstNonEmpty(secrets["botToken"], secrets["secret"])
	if tok == "" {
		return "", errors.New("slack botToken is missing")
	}
	base := firstNonEmpty(customBase, defaultSlackBaseURL)
	endpoint := base + "/api/chat.postMessage"
	payload := map[string]any{
		"channel": to,
		"text":    text,
	}
	if strings.TrimSpace(replyToID) != "" {
		payload["thread_ts"] = strings.TrimSpace(replyToID)
	}
	headers := map[string]string{"Authorization": "Bearer " + tok}
	var resp struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
		TS    string `json:"ts"`
	}
	status, raw, err := a.doJSON(ctx, http.MethodPost, endpoint, headers, payload)
	if err != nil {
		return "", fmt.Errorf("slack chat.postMessage: %w", err)
	}
	if err := decodeCheckedJSON(status, raw, &resp); err != nil || !resp.OK {
		msg := firstNonEmpty(resp.Error, errString(err), fmt.Sprintf("HTTP %d", status))
		return "", fmt.Errorf("slack chat.postMessage failed: %s", msg)
	}
	return firstNonEmpty(resp.TS, fmt.Sprintf("slack:%s", to)), nil
}

func (a *liveAdapter) sendDiscord(ctx context.Context, secrets map[string]string, customBase, to, text, replyToID string) (string, error) {
	tok := strings.TrimSpace(strings.TrimPrefix(firstNonEmpty(secrets["botToken"], secrets["secret"]), "Bot "))
	if tok == "" {
		return "", errors.New("discord botToken is missing")
	}
	base := firstNonEmpty(customBase, defaultDiscordBaseURL)
	endpoint := fmt.Sprintf("%s/api/v10/channels/%s/messages", base, url.PathEscape(to))
	payload := map[string]any{
		"content": text,
	}
	if strings.TrimSpace(replyToID) != "" {
		payload["message_reference"] = map[string]string{"message_id": strings.TrimSpace(replyToID)}
	}
	headers := map[string]string{"Authorization": "Bot " + tok}
	var resp struct {
		ID      string `json:"id"`
		Message string `json:"message"`
	}
	status, raw, err := a.doJSON(ctx, http.MethodPost, endpoint, headers, payload)
	if err != nil {
		return "", fmt.Errorf("discord sendMessage: %w", err)
	}
	if err := decodeCheckedJSON(status, raw, &resp); err != nil {
		msg := firstNonEmpty(resp.Message, errString(err), fmt.Sprintf("HTTP %d", status))
		return "", fmt.Errorf("discord sendMessage failed: %s", msg)
	}
	return firstNonEmpty(resp.ID, fmt.Sprintf("discord:%s", to)), nil
}

func (a *liveAdapter) sendQQ(ctx context.Context, secrets map[string]string, customBase, to, text, replyToID string) (string, error) {
	appID := strings.TrimSpace(secrets["appId"])
	secret := strings.TrimSpace(secrets["secret"])
	tok := strings.TrimSpace(secrets["accessToken"])
	if tok == "" {
		if appID == "" || secret == "" {
			return "", errors.New("qq credentials are missing")
		}
		tokenBase := firstNonEmpty(customBase, defaultQQTokenBaseURL)
		var err error
		tok, _, err = a.fetchQQToken(ctx, tokenBase, appID, secret)
		if err != nil {
			return "", err
		}
	}

	apiBase := firstNonEmpty(customBase, defaultQQAPIBaseURL)
	endpoint := fmt.Sprintf("%s/channels/%s/messages", apiBase, url.PathEscape(to))
	payload := map[string]any{
		"content": text,
	}
	if trimmed := strings.TrimSpace(replyToID); trimmed != "" {
		payload["msg_id"] = trimmed
		payload["msg_seq"] = a.nextQQReplySeq(trimmed)
	}
	headers := map[string]string{
		"Authorization": "QQBot " + tok,
	}
	if appID != "" {
		headers["X-Union-Appid"] = appID
	}
	var resp struct {
		ID      string `json:"id"`
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	status, raw, err := a.doJSON(ctx, http.MethodPost, endpoint, headers, payload)
	if err != nil {
		return "", fmt.Errorf("qq sendMessage: %w", err)
	}
	if err := decodeCheckedJSON(status, raw, &resp); err != nil || resp.Code != 0 {
		msg := firstNonEmpty(resp.Message, errString(err), fmt.Sprintf("HTTP %d", status))
		return "", fmt.Errorf("qq sendMessage failed: %s", msg)
	}
	return firstNonEmpty(resp.ID, fmt.Sprintf("qq:%s", to)), nil
}

func (a *liveAdapter) nextQQReplySeq(msgID string) int {
	a.qqMu.Lock()
	defer a.qqMu.Unlock()
	if len(a.qqReplySeq) > 256 {
		clear(a.qqReplySeq)
	}
	a.qqReplySeq[msgID]++
	return a.qqReplySeq[msgID]
}

func (a *liveAdapter) sendWeixin(ctx context.Context, secrets map[string]string, customBase, to, text string) (string, error) {
	base := firstNonEmpty(customBase, defaultWeixinBaseURL)
	tok := firstNonEmpty(secrets["accessToken"], secrets["botToken"])
	if tok == "" {
		appID := strings.TrimSpace(secrets["appId"])
		secret := strings.TrimSpace(secrets["secret"])
		if appID == "" || secret == "" {
			return "", errors.New("weixin credentials are missing")
		}
		var err error
		tok, _, err = a.fetchWeixinToken(ctx, base, appID, secret)
		if err != nil {
			return "", err
		}
	}

	endpoint := fmt.Sprintf("%s/cgi-bin/message/custom/send?access_token=%s", base, url.QueryEscape(tok))
	payload := map[string]any{
		"touser":  to,
		"msgtype": "text",
		"text": map[string]string{
			"content": text,
		},
	}
	var resp struct {
		ErrCode int    `json:"errcode"`
		ErrMsg  string `json:"errmsg"`
		MsgID   string `json:"msgid"`
	}
	status, raw, err := a.doJSON(ctx, http.MethodPost, endpoint, nil, payload)
	if err != nil {
		return "", fmt.Errorf("weixin sendMessage: %w", err)
	}
	if err := decodeCheckedJSON(status, raw, &resp); err != nil || resp.ErrCode != 0 {
		msg := firstNonEmpty(resp.ErrMsg, errString(err), fmt.Sprintf("errcode %d", resp.ErrCode))
		return "", fmt.Errorf("weixin sendMessage failed: %s", msg)
	}
	return firstNonEmpty(resp.MsgID, fmt.Sprintf("weixin:%s", to)), nil
}

func (a *liveAdapter) fetchFeishuToken(ctx context.Context, base, appID, secret string) (string, string, error) {
	endpoint := base + "/open-apis/auth/v3/tenant_access_token/internal"
	var resp struct {
		Code              int    `json:"code"`
		Msg               string `json:"msg"`
		TenantAccessToken string `json:"tenant_access_token"`
	}
	status, raw, err := a.doJSON(ctx, http.MethodPost, endpoint, nil, map[string]string{
		"app_id":     appID,
		"app_secret": secret,
	})
	if err != nil {
		return "", endpoint, fmt.Errorf("feishu tenant_access_token: %w", err)
	}
	if err := decodeCheckedJSON(status, raw, &resp); err != nil || resp.Code != 0 || resp.TenantAccessToken == "" {
		msg := firstNonEmpty(resp.Msg, errString(err), fmt.Sprintf("code %d", resp.Code))
		return "", endpoint, fmt.Errorf("feishu auth failed: %s", msg)
	}
	return resp.TenantAccessToken, endpoint, nil
}

func (a *liveAdapter) fetchQQToken(ctx context.Context, base, appID, secret string) (string, string, error) {
	endpoint := base + "/app/getAppAccessToken"
	var resp struct {
		AccessToken string `json:"access_token"`
		Message     string `json:"message"`
	}
	status, raw, err := a.doJSON(ctx, http.MethodPost, endpoint, nil, map[string]string{
		"appId":        appID,
		"clientSecret": secret,
	})
	if err != nil {
		return "", endpoint, fmt.Errorf("qq getAppAccessToken: %w", err)
	}
	if err := decodeCheckedJSON(status, raw, &resp); err != nil || resp.AccessToken == "" {
		msg := firstNonEmpty(resp.Message, errString(err), fmt.Sprintf("HTTP %d", status))
		return "", endpoint, fmt.Errorf("qq auth failed: %s", msg)
	}
	return resp.AccessToken, endpoint, nil
}

func (a *liveAdapter) fetchWeixinToken(ctx context.Context, base, appID, secret string) (string, string, error) {
	endpoint := fmt.Sprintf("%s/cgi-bin/token?grant_type=client_credential&appid=%s&secret=%s",
		base, url.QueryEscape(appID), url.QueryEscape(secret))
	var resp struct {
		AccessToken string `json:"access_token"`
		ErrCode     int    `json:"errcode"`
		ErrMsg      string `json:"errmsg"`
	}
	status, raw, err := a.doJSON(ctx, http.MethodGet, endpoint, nil, nil)
	if err != nil {
		return "", endpoint, fmt.Errorf("weixin token: %w", err)
	}
	if err := decodeCheckedJSON(status, raw, &resp); err != nil || resp.ErrCode != 0 || resp.AccessToken == "" {
		msg := firstNonEmpty(resp.ErrMsg, errString(err), fmt.Sprintf("errcode %d", resp.ErrCode))
		return "", endpoint, fmt.Errorf("weixin auth failed: %s", msg)
	}
	return resp.AccessToken, endpoint, nil
}

func (a *liveAdapter) doJSON(ctx context.Context, method, endpoint string, headers map[string]string, body any) (int, []byte, error) {
	var bodyReader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		bodyReader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bodyReader)
	if err != nil {
		return 0, nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	req.Header.Set("Accept", "application/json")
	for k, v := range headers {
		if strings.TrimSpace(k) != "" {
			req.Header.Set(k, v)
		}
	}
	client := a.httpClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxConnectorRespBytes))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, raw, nil
}

func decodeCheckedJSON(status int, raw []byte, out any) error {
	if len(bytes.TrimSpace(raw)) > 0 {
		_ = json.Unmarshal(raw, out)
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("HTTP %d: %s", status, strings.TrimSpace(string(raw)))
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	return json.Unmarshal(raw, out)
}

func withCustomBaseURL(secrets map[string]string, customBase string) map[string]string {
	if customBase != "" {
		secrets["apiBaseUrl"] = customBase
	}
	return secrets
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

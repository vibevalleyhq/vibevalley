package connector

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/weixin"
	"vibevalley/pkg/x/clock"
)

const (
	// voiceIlinkLoginFor is how long a login code is waited on; voiceIlinkRefreshes how often a new one is fetched
	// when it expires.
	voiceIlinkLoginFor  = 8 * time.Minute
	voiceIlinkRefreshes = 3
	// WeChat may say otherwise.
	voiceIlinkPoll = 35 * time.Second
)

func voiceIlinkAccountOf(secrets map[string]string) weixin.Account {
	baseURL := secrets["baseUrl"]
	if baseURL == "" {
		baseURL = weixin.BaseURL
	}
	return weixin.Account{BaseURL: baseURL, Token: secrets["token"]}
}

type voiceWeixinAdapter struct{ c *Service }

func (voiceWeixinAdapter) ID() protocol.ConnectorID { return protocol.ConnectorIDWeixin }

func (a voiceWeixinAdapter) Login(ctx context.Context, _ protocol.ConnectorLogin, progress func(voiceProgress), verifyCode func() string) (voiceLinked, error) {
	api := a.c.ilink
	code, show, err := api.QrCode(ctx)
	if err != nil {
		return voiceLinked{}, fmt.Errorf("拿不到登录二维码：%s", err.Error())
	}
	progress(voiceProgress{State: protocol.ConnectorStateWaiting, Qr: show})
	baseURL := weixin.BaseURL
	refreshes := 0
	for deadline := time.Now().Add(voiceIlinkLoginFor); time.Now().Before(deadline); {
		if ctx.Err() != nil {
			return voiceLinked{}, ctx.Err()
		}
		s := api.QrStatus(ctx, baseURL, code, verifyCode())
		switch s.Status {
		case "scaned":
			progress(voiceProgress{State: protocol.ConnectorStateScanned, Qr: show})
		case "need_verifycode":
			progress(voiceProgress{State: protocol.ConnectorStateVerify, Qr: show})
			// Ask again only once the page brought a number.
			clock.Sleep(ctx, time.Second)
		case "scaned_but_redirect":
			if s.RedirectHost != "" {
				baseURL = "https://" + s.RedirectHost
			}
		case "expired", "verify_code_blocked":
			if refreshes++; refreshes >= voiceIlinkRefreshes {
				if s.Status == "expired" {
					return voiceLinked{}, errors.New("二维码过期了几次，请重新开始。")
				}
				return voiceLinked{}, errors.New("数字输错了几次，请重新开始。")
			}
			code, show, err = api.QrCode(ctx)
			if err != nil {
				return voiceLinked{}, fmt.Errorf("拿不到登录二维码：%s", err.Error())
			}
			progress(voiceProgress{State: protocol.ConnectorStateWaiting, Qr: show})
		case "binded_redirect":
			return voiceLinked{}, errors.New("这个微信已经连过了：先在微信里删掉它，或者换一个微信扫。")
		case "confirmed":
			if s.BotToken == "" || s.IlinkBotID == "" || s.IlinkUserID == "" {
				return voiceLinked{}, errors.New("微信确认了，但没给齐登录信息，请重试。")
			}
			at := s.BaseURL
			if at == "" {
				at = baseURL
			}
			return voiceLinked{Secrets: map[string]string{"token": s.BotToken, "botId": s.IlinkBotID, "baseUrl": at}, Owner: s.IlinkUserID}, nil
		}
	}
	return voiceLinked{}, errors.New("等太久没扫，二维码过期了。")
}

func (a voiceWeixinAdapter) Receive(ctx context.Context, secrets map[string]string, io voiceReceiving) *voiceFailure {
	api := a.c.ilink
	account := voiceIlinkAccountOf(secrets)
	buf := io.Cursor
	timeout := voiceIlinkPoll
	for ctx.Err() == nil {
		updates, err := api.GetUpdates(ctx, account, buf, timeout)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			return &voiceFailure{Kind: "failed", Reason: err.Error()}
		}
		if code := weixin.Failed(updates.Ret, updates.Errcode); code != nil {
			if *code == weixin.StaleToken {
				return &voiceFailure{Kind: "stale", Reason: "微信说登录过期了"}
			}
			reason := updates.Errmsg
			if reason == "" {
				reason = strconv.Itoa(*code)
			}
			return &voiceFailure{Kind: "failed", Reason: "getupdates: " + reason}
		}
		if updates.LongpollingTimeoutMs > 0 {
			timeout = time.Duration(updates.LongpollingTimeoutMs) * time.Millisecond
		}
		for _, m := range updates.Msgs {
			// Its own messages echo back; groups are not for the farm.
			if m.MessageType == 2 || m.GroupID != "" || m.FromUserID == "" {
				continue
			}
			io.Got(voiceInbound{ID: m.MessageID, From: m.FromUserID, Text: weixin.Text(m), Reply: m.ContextToken, Quoted: weixin.Quoted(m)})
		}
		if updates.GetUpdatesBuf != "" && updates.GetUpdatesBuf != buf {
			buf = updates.GetUpdatesBuf
			io.SaveCursor(buf)
		}
	}
	return nil
}

func (a voiceWeixinAdapter) Send(ctx context.Context, secrets map[string]string, to, text, reply string) (string, *voiceFailure) {
	id, err := a.c.ilink.SendText(ctx, voiceIlinkAccountOf(secrets), to, text, reply)
	if err == nil {
		return id, nil
	}
	kind := "failed"
	var e *weixin.Error
	if errors.As(err, &e) {
		switch e.Code {
		case weixin.StaleToken:
			kind = "stale"
		case weixin.Restricted:
			kind = "restricted"
		}
	}
	return "", &voiceFailure{Kind: kind, Reason: err.Error()}
}

package connector

import (
	"context"
	"errors"
	"strconv"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/weixin"
)

const (
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
	linked, err := a.c.ilink.Login(ctx, func(p weixin.LoginProgress) {
		state := map[weixin.LoginState]protocol.ConnectorState{
			weixin.LoginWaiting: protocol.ConnectorStateWaiting,
			weixin.LoginScanned: protocol.ConnectorStateScanned,
			weixin.LoginVerify:  protocol.ConnectorStateVerify,
		}[p.State]
		progress(voiceProgress{State: state, Qr: p.URL})
	}, verifyCode)
	if err != nil {
		return voiceLinked{}, err
	}
	return voiceLinked{Secrets: map[string]string{"token": linked.Account.Token, "botId": linked.BotID, "baseUrl": linked.Account.BaseURL}, Owner: linked.Owner}, nil
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
		messages := make([]voiceInbound, 0, len(updates.Msgs))
		for _, m := range updates.Msgs {
			// Its own messages echo back; groups are not for the farm.
			if m.MessageType == 2 || m.GroupID != "" || m.FromUserID == "" {
				continue
			}
			messages = append(messages, voiceInbound{ID: m.MessageID, From: m.FromUserID, Text: weixin.Text(m), Reply: m.ContextToken, Quoted: weixin.Quoted(m)})
		}
		if err := io.Accept(messages, updates.GetUpdatesBuf); err != nil {
			return &voiceFailure{Kind: "failed", Reason: err.Error()}
		}
		if updates.GetUpdatesBuf != "" {
			buf = updates.GetUpdatesBuf
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

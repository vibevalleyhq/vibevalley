package connector

import (
	"context"
	"errors"
	"strings"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/qq"
)

type voiceQQAdapter struct{ c *Service }

func (voiceQQAdapter) ID() protocol.ConnectorID { return protocol.ConnectorIDQq }

func voiceQQAppOf(secrets map[string]string) qq.App {
	return qq.App{AppID: secrets["appId"], Secret: secrets["secret"]}
}

func (a voiceQQAdapter) Login(ctx context.Context, in protocol.ConnectorLogin, _ func(voiceProgress), _ func() string) (voiceLinked, error) {
	var appID, secret string
	if in.AppID != nil {
		appID = strings.TrimSpace(*in.AppID)
	}
	if in.Secret != nil {
		secret = strings.TrimSpace(*in.Secret)
	}
	if appID == "" || secret == "" {
		return voiceLinked{}, errors.New("要填 QQ 机器人的 AppID 和 AppSecret（在 q.qq.com 的机器人管理页里）。")
	}
	if err := a.c.qq.Check(ctx, qq.App{AppID: appID, Secret: secret}); err != nil {
		return voiceLinked{}, err
	}
	return voiceLinked{Secrets: map[string]string{"appId": appID, "secret": secret}}, nil
}

func (a voiceQQAdapter) Receive(ctx context.Context, secrets map[string]string, io voiceReceiving) *voiceFailure {
	err := a.c.qq.Listen(ctx, voiceQQAppOf(secrets), func(m qq.Message) {
		var parts []string
		if t := strings.TrimSpace(m.Content); t != "" {
			parts = append(parts, t)
		}
		if m.Attachments > 0 {
			parts = append(parts, "[附件]")
		}
		io.take(ctx, voiceInbound{ID: m.ID, From: m.From, Text: strings.Join(parts, "\n"), Reply: m.ID})
	})
	if err == nil || ctx.Err() != nil {
		return nil
	}
	return &voiceFailure{Kind: "failed", Reason: err.Error()}
}

func (a voiceQQAdapter) Send(ctx context.Context, secrets map[string]string, to, text, reply string) (string, *voiceFailure) {
	id, err := a.c.qq.SendText(ctx, voiceQQAppOf(secrets), to, text, reply)
	if err == nil {
		return id, nil
	}
	// A refused passive reply (too late, too many) waits for the owner's next message; a bad login is stale.
	kind := "failed"
	switch {
	case err.Status == 401:
		kind = "stale"
	case err.Status >= 400 && err.Status < 500:
		kind = "restricted"
	}
	return "", &voiceFailure{Kind: kind, Reason: err.Reason}
}

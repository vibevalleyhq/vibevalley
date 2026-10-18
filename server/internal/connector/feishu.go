package connector

import (
	"context"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/feishu"
)

func voiceFeishuAppOf(secrets map[string]string) feishu.App {
	domain := "feishu"
	if secrets["domain"] == "lark" {
		domain = "lark"
	}
	return feishu.App{AppID: secrets["appId"], AppSecret: secrets["appSecret"], Domain: domain}
}

type voiceFeishuAdapter struct{ c *Service }

func (voiceFeishuAdapter) ID() protocol.ConnectorID { return protocol.ConnectorIDFeishu }

func (a voiceFeishuAdapter) Login(ctx context.Context, _ protocol.ConnectorLogin, progress func(voiceProgress), _ func() string) (voiceLinked, error) {
	linked, err := a.c.feishu.Login(ctx, func(p feishu.LoginProgress) {
		progress(voiceProgress{State: protocol.ConnectorStateWaiting, Qr: p.URL})
	})
	if err != nil {
		return voiceLinked{}, err
	}
	return voiceLinked{Secrets: map[string]string{"appId": linked.App.AppID, "appSecret": linked.App.AppSecret, "domain": linked.App.Domain}, Owner: linked.Owner}, nil
}

// Returning to the SDK acknowledges only a durable inbox write; manager work runs elsewhere.
func (a voiceFeishuAdapter) Receive(ctx context.Context, secrets map[string]string, io voiceReceiving) *voiceFailure {
	err := a.c.feishu.Listen(ctx, voiceFeishuAppOf(secrets), func(m feishu.Message) error {
		if m.ChatType != "p2p" {
			return nil
		}
		return io.Accept([]voiceInbound{{ID: m.MessageID, From: m.From, Text: feishu.Text(m), Quoted: m.ParentID}}, "")
	})
	if err == nil || ctx.Err() != nil {
		return nil
	}
	return &voiceFailure{Kind: "failed", Reason: err.Error()}
}

func (a voiceFeishuAdapter) Send(ctx context.Context, secrets map[string]string, to, text, _ string) (string, *voiceFailure) {
	id, err := a.c.feishu.SendText(ctx, voiceFeishuAppOf(secrets), to, text)
	if err != nil {
		return "", &voiceFailure{Kind: "failed", Reason: err.Error()}
	}
	return id, nil
}

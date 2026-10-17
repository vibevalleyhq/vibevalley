package connector

import (
	"context"
	"errors"
	"sync"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/feishu"
	"vibevalley/pkg/x/clock"
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
	api := a.c.feishu
	reg, err := api.Register(ctx)
	if err != nil {
		return voiceLinked{}, err
	}
	progress(voiceProgress{State: protocol.ConnectorStateWaiting, Qr: reg.URL})
	domain := "feishu"
	for deadline := time.Now().Add(reg.Expires); time.Now().Before(deadline); {
		if !clock.Sleep(ctx, reg.Interval) {
			return voiceLinked{}, ctx.Err()
		}
		p := api.Poll(ctx, reg.DeviceCode, domain)
		switch p.Status {
		case "succeeded":
			linked := voiceLinked{Secrets: map[string]string{"appId": p.AppID, "appSecret": p.AppSecret, "domain": p.Domain}, Owner: p.OpenID}
			return linked, nil
		case "failed":
			return voiceLinked{}, errors.New(p.Reason)
		}
		domain = p.Domain
	}
	return voiceLinked{}, errors.New("等太久没扫，二维码过期了。")
}

// The SDK acknowledges a message only once its handler returns, so the handler only queues: Feishu is answered at once, and a message Feishu sends
// again is still taken once.
func (a voiceFeishuAdapter) Receive(ctx context.Context, secrets map[string]string, io voiceReceiving) *voiceFailure {
	var (
		mu     sync.Mutex
		inbox  []voiceInbound
		wake   = make(chan struct{}, 1)
		listen = make(chan struct{})
		done   = make(chan struct{})
	)
	go func() {
		defer close(done)
		for {
			mu.Lock()
			if len(inbox) == 0 {
				mu.Unlock()
				select {
				case <-wake:
					continue
				case <-listen:
					return
				}
			}
			m := inbox[0]
			inbox = inbox[1:]
			mu.Unlock()
			io.take(ctx, m)
		}
	}()
	err := a.c.feishu.Listen(ctx, voiceFeishuAppOf(secrets), func(m feishu.Message) {
		if m.ChatType != "p2p" {
			return
		}
		mu.Lock()
		inbox = append(inbox, voiceInbound{ID: m.MessageID, From: m.From, Text: feishu.Text(m), Quoted: m.ParentID})
		mu.Unlock()
		select {
		case wake <- struct{}{}:
		default:
		}
	})
	// Receiving stopped: what was queued and not yet taken is let go, as the long connection is.
	close(listen)
	<-done
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

package channels

// Feishu (and Lark) as a connector (ported from the TypeScript server's feishu.ts, removed), over pkg/feishu: scanning
// creates the owner's bot; the owner is whoever sends it the pairing code; replies go to the owner's open_id, with no
// reply window. Outbound only, so the server keeps listening on 127.0.0.1 alone.

import (
	"context"
	"errors"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/pkg/feishu"

	// Feishu (and Lark) as a connector (ported from the TypeScript server's feishu.ts, removed). Logging in is Feishu's scan-to-create flow: the owner
	// scans a code with the Feishu app and Feishu creates a personal bot app for them, handing back its app id and secret
	// (the device-code flow nanobot uses: accounts.feishu.cn/oauth/v1/app/registration). Messages come over the official
	// SDK's long connection, outbound only, so the server keeps listening on 127.0.0.1 alone; replies go through the
	// message API to the owner's open_id, with no reply window. The owner is whoever sends the bot the pairing code.

	"vibevalley/internal/protocol"
)

func voiceFeishuAppOf(secrets map[string]string) feishu.App {
	domain := "feishu"
	if secrets["domain"] == "lark" {
		domain = "lark"
	}
	return feishu.App{AppID: secrets["appId"], AppSecret: secrets["appSecret"], Domain: domain}
}

// voiceFeishuAdapter is Feishu as a connector: scanning creates the bot; the owner pairs by sending the code.
type voiceFeishuAdapter struct{ c *Connectors }

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
		if !base.Sleep(ctx, reg.Interval) {
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

// Receive hands what comes in to the bridge one at a time, in the order it arrived. The SDK calls its handler on a
// goroutine per message and acknowledges a message only once the handler returns, so the handler only queues: Feishu
// is answered at once, and a message Feishu sends again is still taken once.
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
			io.Got(m)
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

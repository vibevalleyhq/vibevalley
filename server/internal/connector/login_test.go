package connector

import (
	"context"
	"reflect"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/weixin"
)

type completedWeixinLogin struct{ voiceScriptedIlink }

func (completedWeixinLogin) Login(_ context.Context, progress func(weixin.LoginProgress), verification func() string) (weixin.LoginAccount, error) {
	for _, state := range []weixin.LoginState{weixin.LoginWaiting, weixin.LoginScanned, weixin.LoginVerify} {
		progress(weixin.LoginProgress{State: state, URL: "qr"})
	}
	return weixin.LoginAccount{Account: weixin.Account{BaseURL: "https://account.test", Token: verification()}, BotID: "bot", Owner: "owner"}, nil
}
func TestWeixinAdapterOnlyMapsSDKProgressAndFinalAccount(t *testing.T) {
	adapter := voiceWeixinAdapter{c: &Service{ilink: completedWeixinLogin{}}}
	var states []protocol.ConnectorState
	linked, err := adapter.Login(context.Background(), protocol.ConnectorLogin{}, func(p voiceProgress) {
		states = append(states, p.State)
		if p.Qr != "qr" {
			t.Fatal(p)
		}
	}, func() string { return "entered-code" })
	if err != nil {
		t.Fatal(err)
	}
	if want := []protocol.ConnectorState{protocol.ConnectorStateWaiting, protocol.ConnectorStateScanned, protocol.ConnectorStateVerify}; !reflect.DeepEqual(states, want) {
		t.Fatalf("mapped states: %v", states)
	}
	if linked.Owner != "owner" || !reflect.DeepEqual(linked.Secrets, map[string]string{"token": "entered-code", "botId": "bot", "baseUrl": "https://account.test"}) {
		t.Fatalf("account: %+v", linked)
	}
}

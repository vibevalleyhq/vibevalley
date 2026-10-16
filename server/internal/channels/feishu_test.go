package channels

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/feishu"
)

type voiceSDKFeishu struct {
	voiceScriptedFeishu
	deliver  [][]feishu.Message
	returned chan time.Duration
	fail     error
}

func (a voiceSDKFeishu) Listen(ctx context.Context, _ feishu.App, got func(feishu.Message)) error {
	for _, wave := range a.deliver {
		var wg sync.WaitGroup
		for _, m := range wave {
			wg.Add(1)
			go func() {
				defer wg.Done()
				began := time.Now()
				got(m)
				a.returned <- time.Since(began)
			}()
		}
		wg.Wait()
	}
	if a.fail != nil {
		return a.fail
	}
	<-ctx.Done()
	return nil
}

func TestFeishuReceivingQueuesWhatTheSDKHandsOver(t *testing.T) {
	msg := func(id, text string) feishu.Message {
		content, _ := json.Marshal(map[string]string{"text": text})
		return feishu.Message{MessageID: id, From: "ou_owner", ChatType: "p2p", MessageType: "text", Content: string(content)}
	}
	first, second := msg("om1", "第一句"), msg("om2", "第二句")
	api := voiceSDKFeishu{
		deliver:  [][]feishu.Message{{first}, {second, second, second}},
		returned: make(chan time.Duration, 8),
	}
	adapter := voiceFeishuAdapter{c: &Connectors{feishu: api}}
	release := make(chan struct{})
	var (
		mu    sync.Mutex
		taken []voiceInbound
		busy  int
		worst int
	)
	io := voiceReceiving{Got: func(m voiceInbound) {
		mu.Lock()
		busy++
		worst = max(worst, busy)
		taken = append(taken, m)
		mu.Unlock()
		if m.ID == "om1" {
			<-release
		}
		mu.Lock()
		busy--
		mu.Unlock()
	}}
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan *voiceFailure)
	go func() { stopped <- adapter.Receive(ctx, map[string]string{"appId": "cli_1", "appSecret": "s"}, io) }()
	for range 4 {
		select {
		case took := <-api.returned:
			if took > time.Second {
				t.Fatalf("the handler waited %s for the bridge", took)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("the handler did not return while the bridge was busy")
		}
	}
	close(release)
	voiceUntil(t, "everything taken", func() (int, bool) {
		mu.Lock()
		defer mu.Unlock()
		return len(taken), len(taken) == 4
	})
	cancel()
	if failure := <-stopped; failure != nil {
		t.Fatalf("stopped with %+v", failure)
	}
	mu.Lock()
	defer mu.Unlock()
	if worst != 1 {
		t.Fatalf("the bridge took %d at once", worst)
	}
	ids := []string{}
	for _, m := range taken {
		ids = append(ids, m.ID)
	}
	if want := []string{"om1", "om2", "om2", "om2"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("taken: %v", ids)
	}
	if taken[0].Text != "第一句" || taken[1].Text != "第二句" {
		t.Fatalf("texts: %+v", taken)
	}
}

func TestFeishuReceivingFailsWhenTheConnectionDrops(t *testing.T) {
	api := voiceSDKFeishu{fail: errors.New("飞书长连接断了：bye"), returned: make(chan time.Duration, 1)}
	failure := voiceFeishuAdapter{c: &Connectors{feishu: api}}.Receive(context.Background(), map[string]string{}, voiceReceiving{Got: func(voiceInbound) {}})
	if failure == nil || failure.Kind != "failed" || failure.Reason != "飞书长连接断了：bye" {
		t.Fatalf("failure: %+v", failure)
	}
}

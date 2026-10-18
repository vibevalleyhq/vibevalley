package connector

import (
	"context"
	"errors"
	"testing"
	"time"

	"vibevalley/pkg/feishu"
)

type voiceSDKFeishu struct {
	voiceScriptedFeishu
	gotError chan error
}

func (a voiceSDKFeishu) Listen(ctx context.Context, _ feishu.App, got func(feishu.Message) error) error {
	err := got(feishu.Message{MessageID: "message", From: "owner", ChatType: "p2p", MessageType: "text", Content: `{"text":"hello"}`})
	a.gotError <- err
	if err != nil {
		return err
	}
	<-ctx.Done()
	return nil
}
func TestFeishuAcknowledgesOnlyAfterAcceptance(t *testing.T) {
	for _, fail := range []bool{false, true} {
		api := voiceSDKFeishu{gotError: make(chan error, 1)}
		entered, release := make(chan struct{}), make(chan struct{})
		adapter := voiceFeishuAdapter{c: &Service{feishu: api}}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan *voiceFailure, 1)
		go func() {
			done <- adapter.Receive(ctx, nil, voiceReceiving{Accept: func(ms []voiceInbound, cursor string) error {
				if len(ms) != 1 || ms[0].ID != "message" || cursor != "" {
					t.Error("adapter changed acceptance envelope")
				}
				close(entered)
				<-release
				if fail {
					return errors.New("disk unavailable")
				}
				return nil
			}})
		}()
		<-entered
		select {
		case <-api.gotError:
			t.Fatal("SDK acknowledged before durable acceptance")
		case <-time.After(20 * time.Millisecond):
		}
		close(release)
		err := <-api.gotError
		if (err != nil) != fail {
			t.Fatalf("SDK result %v; fail %v", err, fail)
		}
		if !fail {
			cancel()
		}
		result := <-done
		cancel()
		if (result != nil) != fail {
			t.Fatalf("receive result: %+v", result)
		}
	}
}

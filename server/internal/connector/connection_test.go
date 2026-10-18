package connector

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/ptr"
)

type generationAdapter struct {
	loginStarted     chan string
	oldCancelled     chan struct{}
	releaseOld       chan struct{}
	receiveStarted   chan string
	receiveCancelled chan struct{}
	releaseReceive   chan struct{}
	lateAccepted     chan error
	once             sync.Once
}

func (*generationAdapter) ID() protocol.ConnectorID { return protocol.ConnectorIDWeixin }
func (a *generationAdapter) Login(ctx context.Context, in protocol.ConnectorLogin, progress func(voiceProgress), _ func() string) (voiceLinked, error) {
	name := *in.AppID
	a.loginStarted <- name
	progress(voiceProgress{State: protocol.ConnectorStateWaiting, Qr: name})
	if name == "old" {
		<-ctx.Done()
		close(a.oldCancelled)
		<-a.releaseOld
		progress(voiceProgress{State: protocol.ConnectorStateScanned, Qr: "late-old"})
	}
	return voiceLinked{Secrets: map[string]string{"account": name}, Owner: voiceOwner}, nil
}
func (a *generationAdapter) Receive(ctx context.Context, secrets map[string]string, in voiceReceiving) *voiceFailure {
	a.receiveStarted <- secrets["account"]
	<-ctx.Done()
	if a.receiveCancelled != nil {
		a.once.Do(func() { close(a.receiveCancelled) })
		<-a.releaseReceive
		a.lateAccepted <- in.Accept([]voiceInbound{{ID: "late", From: voiceOwner, Text: "must not run"}}, "late-cursor")
	}
	return nil
}
func (*generationAdapter) Send(context.Context, map[string]string, string, string, string) (string, *voiceFailure) {
	return "sent", nil
}

func TestAccountOwnerJoinsOldLoginBeforeReplacement(t *testing.T) {
	f := connectorTestFarm(t)
	a := &generationAdapter{loginStarted: make(chan string, 4), oldCancelled: make(chan struct{}), releaseOld: make(chan struct{}), receiveStarted: make(chan string, 4)}
	b := f.Connector.bridges[protocol.ConnectorIDWeixin]
	b.adapter = a
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.Connector.Login(b.id, protocol.ConnectorLogin{AppID: ptr.To("old")})
	if name := <-a.loginStarted; name != "old" {
		t.Fatal(name)
	}
	replaced := make(chan protocol.ConnectorStatus, 1)
	go func() {
		replaced <- f.Connector.Login(b.id, protocol.ConnectorLogin{AppID: ptr.To("new"), Force: ptr.To(true)})
	}()
	<-a.oldCancelled
	select {
	case <-a.loginStarted:
		t.Fatal("replacement started while old login still running")
	case <-time.After(20 * time.Millisecond):
	}
	close(a.releaseOld)
	select {
	case <-replaced:
	case <-time.After(3 * time.Second):
		t.Fatal("replacement self-waited")
	}
	select {
	case name := <-a.receiveStarted:
		if name != "new" {
			t.Fatal("stale login committed", name)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("replacement never connected")
	}
	row, err := f.Connector.q.ConnectorAccount(context.Background(), string(b.id))
	if err != nil || !strings.Contains(row.Secrets, "new") {
		t.Fatalf("account %+v %v", row, err)
	}
	if b.status().Qr != nil {
		t.Fatal("late old callback overwrote current state")
	}
}

func TestAccountLogoutWaitsAndRejectsLateCallbacks(t *testing.T) {
	f := connectorTestFarm(t)
	a := &generationAdapter{loginStarted: make(chan string, 4), receiveStarted: make(chan string, 4), receiveCancelled: make(chan struct{}), releaseReceive: make(chan struct{}), lateAccepted: make(chan error, 4)}
	b := f.Connector.bridges[protocol.ConnectorIDWeixin]
	b.adapter = a
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.Connector.Login(b.id, protocol.ConnectorLogin{AppID: ptr.To("new")})
	select {
	case <-a.receiveStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("account never connected")
	}
	done := make(chan protocol.ConnectorStatus, 1)
	go func() { done <- f.Connector.Logout(b.id) }()
	<-a.receiveCancelled
	select {
	case <-done:
		t.Fatal("logout returned before old receiver finished")
	case <-time.After(20 * time.Millisecond):
	}
	close(a.releaseReceive)
	select {
	case status := <-done:
		if status.State != protocol.ConnectorStateOff {
			t.Fatalf("logout %+v", status)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("logout blocked")
	}
	if err := <-a.lateAccepted; !errors.Is(err, context.Canceled) {
		t.Fatalf("late callback: %v", err)
	}
	rows, err := f.Connector.q.PendingInbound(context.Background(), string(b.id))
	if err != nil || len(rows) != 0 {
		t.Fatalf("late rows %v %v", rows, err)
	}
	b.mu.Lock()
	problem := b.err
	b.mu.Unlock()
	if problem != "" {
		t.Fatalf("late callback changed stopped state: %s", problem)
	}
}

func TestConnectionShutdownWaitsForManagerDelivery(t *testing.T) {
	f, script := voiceConnectorsFarm(t)
	voiceWeixinConnected(t, f)
	entered, exited := make(chan struct{}), make(chan struct{})
	f.Connector.say = func(ctx context.Context, _ string, _ *string) error {
		close(entered)
		<-ctx.Done()
		close(exited)
		return ctx.Err()
	}
	script.weixin <- voiceWx(voiceOwner, "in flight", "")
	<-entered
	f.Connector.OnStop()
	select {
	case <-exited:
	default:
		t.Fatal("shutdown returned with manager delivery running")
	}
	rows, err := f.Connector.q.PendingInbound(context.Background(), string(protocol.ConnectorIDWeixin))
	if err != nil || len(rows) != 1 {
		t.Fatalf("cancelled delivery lost durable input: %v %v", rows, err)
	}
	testkit.Until(t, "connection coordinator stopped", func() bool {
		select {
		case <-f.Connector.bridges[protocol.ConnectorIDWeixin].connection.done:
			return true
		default:
			return false
		}
	})
}

type detachedCallbackAdapter struct {
	voiceAdapter
	accept func([]voiceInbound, string) error
}

func (a *detachedCallbackAdapter) Receive(_ context.Context, _ map[string]string, in voiceReceiving) *voiceFailure {
	a.accept = in.Accept
	return &voiceFailure{Kind: "failed", Reason: "transport ended"}
}
func TestReceiverSealsSDKCallbacksAfterListenReturns(t *testing.T) {
	f := connectorTestFarm(t)
	b := f.Connector.bridges[protocol.ConnectorIDWeixin]
	ctx := context.Background()
	if err := f.Connector.q.ConnectAccount(ctx, generated.ConnectAccountParams{Connector: string(b.id), Secrets: `{}`, OwnerID: voiceNullable(voiceOwner)}); err != nil {
		t.Fatal(err)
	}
	a := &detachedCallbackAdapter{voiceAdapter: b.adapter}
	b.adapter = a
	if failure := b.inbox.receive(ctx, nil); failure == nil {
		t.Fatal("transport failure hidden")
	}
	if err := a.accept([]voiceInbound{{ID: "detached", From: voiceOwner, Text: "too late"}}, "late"); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	rows, err := f.Connector.q.PendingInbound(ctx, string(b.id))
	if err != nil || len(rows) != 0 {
		t.Fatalf("late SDK write %v %v", rows, err)
	}
}

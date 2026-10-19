package voice

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/agora"
	"vibevalley/pkg/x/ptr"
)

func grantWorld(t *testing.T) (*world, *voiceCapture) {
	t.Helper()
	f := voiceTestWorld(t)
	if _, err := f.Setting.Save(protocol.SettingsUpdate{AgoraAppID: ptr.To(voiceTestAppID), AgoraAppCertificate: ptr.To(voiceTestCert)}); err != nil {
		t.Fatal(err)
	}
	capture := &voiceCapture{}
	f.Voice.http = capture
	return f, capture
}
func issueGrant(t *testing.T, f *world) protocol.AgoraGrant {
	t.Helper()
	grant, err := f.Voice.Session(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return grant
}

func TestRTCGrantKeepsItsApplicationAcrossSettingsChanges(t *testing.T) {
	f, capture := grantWorld(t)
	issued := issueGrant(t, f)
	nextApp := "33333333333333333333333333333333"
	if _, err := f.Setting.Save(protocol.SettingsUpdate{AgoraAppID: &nextApp}); err != nil {
		t.Fatal(err)
	}
	call, err := f.Voice.Start(context.Background(), issued.Channel, issued.UID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(capture.urls[0], issued.AppID) || capture.requests[0]["appid"] != issued.AppID {
		t.Fatalf("SDK switched application: %v %v", capture.urls, capture.requests)
	}
	renewed, err := f.Voice.Renew(context.Background(), issued.Channel, issued.UID)
	if err != nil || renewed.AppID != issued.AppID {
		t.Fatalf("renewed: %+v %v", renewed, err)
	}
	if fresh := issueGrant(t, f); fresh.AppID != nextApp {
		t.Fatalf("new grant did not use new application: %+v", fresh)
	}
	if err := f.Voice.Stop(context.Background(), call.AgentID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Voice.Renew(context.Background(), issued.Channel, issued.UID); err == nil {
		t.Fatal("stopped grant renewed")
	}
}

func TestPendingRTCGrantExpiresWithItsToken(t *testing.T) {
	f, _ := grantWorld(t)
	now := time.Now()
	f.Voice.now = func() time.Time { return now }
	issued := issueGrant(t, f)
	now = now.Add(time.Duration(agora.TokenSeconds) * time.Second)
	if _, err := f.Voice.Renew(context.Background(), issued.Channel, issued.UID); err == nil {
		t.Fatal("expired grant renewed")
	}
	if _, err := f.Voice.Start(context.Background(), issued.Channel, issued.UID); err == nil {
		t.Fatal("expired grant started")
	}
	if len(f.Voice.grants) != 0 {
		t.Fatal("expired pending grant retained")
	}
	fresh := issueGrant(t, f)
	if _, err := f.Voice.Start(context.Background(), fresh.Channel, "another-uid"); err == nil {
		t.Fatal("ungranted UID accepted")
	}
	f.Voice.voice.OnStop()
	if len(f.Voice.grants) != 0 {
		t.Fatal("shutdown retained grant")
	}
	if _, err := f.Voice.Session(context.Background()); err == nil {
		t.Fatal("stopped service issued grant")
	}
}

func TestRTCGrantIsRevokedWhenStartOrStopFails(t *testing.T) {
	f, capture := grantWorld(t)
	issued := issueGrant(t, f)
	capture.status, capture.body = 400, `{"detail":"rejected"}`
	if _, err := f.Voice.Start(context.Background(), issued.Channel, issued.UID); err == nil {
		t.Fatal("expected start failure")
	}
	if len(f.Voice.grants) != 0 || len(f.Voice.calls) != 0 {
		t.Fatal("failed start retained grant")
	}
	capture.status, capture.body = 0, ""
	issued = issueGrant(t, f)
	call, err := f.Voice.Start(context.Background(), issued.Channel, issued.UID)
	if err != nil {
		t.Fatal(err)
	}
	capture.status, capture.body = 400, `{"detail":"rejected"}`
	if err := f.Voice.Stop(context.Background(), call.AgentID); err == nil {
		t.Fatal("expected stop failure")
	}
	if _, err := f.Voice.Renew(context.Background(), issued.Channel, issued.UID); err == nil {
		t.Fatal("ending call renewed")
	}
	capture.status, capture.body = 200, `{}`
	if err := f.Voice.Stop(context.Background(), call.AgentID); err != nil {
		t.Fatal(err)
	}
	if len(f.Voice.calls) != 0 {
		t.Fatal("stop retry did not retire call")
	}
}

type blockedGrantCapture struct {
	*voiceCapture
	once             sync.Once
	entered, release chan struct{}
}

func (c *blockedGrantCapture) Do(req *http.Request) (*http.Response, error) {
	c.once.Do(func() { close(c.entered); <-c.release })
	return c.voiceCapture.Do(req)
}
func TestRTCGrantHasOneStarterAndCannotOutliveService(t *testing.T) {
	f, capture := grantWorld(t)
	blocking := &blockedGrantCapture{voiceCapture: capture, entered: make(chan struct{}), release: make(chan struct{})}
	f.Voice.http = blocking
	issued := issueGrant(t, f)
	done := make(chan error, 1)
	go func() { _, err := f.Voice.Start(context.Background(), issued.Channel, issued.UID); done <- err }()
	<-blocking.entered
	if _, err := f.Voice.Start(context.Background(), issued.Channel, issued.UID); err == nil {
		t.Fatal("second starter accepted")
	}
	f.Voice.voice.OnStop()
	close(blocking.release)
	if err := <-done; err == nil {
		t.Fatal("stopped service accepted late remote agent")
	}
	if len(capture.urls) != 2 || len(f.Voice.calls) != 0 || len(f.Voice.grants) != 0 {
		t.Fatalf("late start cleanup: %v", capture.urls)
	}
}

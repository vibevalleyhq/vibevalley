package base

import (
	"context"
	"go.uber.org/fx"
	"net/http"
	"net/http/httptest"
	"testing"
)

type readyRequest struct {
	url    *string
	result chan error
}

func (*readyRequest) OnStart(context.Context) error { return nil }
func (*readyRequest) OnStop()                       {}
func (p *readyRequest) OnReady(context.Context) {
	response, err := http.Get(*p.url)
	if err == nil {
		response.Body.Close()
	}
	p.result <- err
}
func TestTransportPreparationPrecedesServiceReadyRequests(t *testing.T) {
	var url string
	checked := make(chan error, 1)
	var transport *httptest.Server
	layer := func(r *Readies) fx.Option {
		return fx.Options(fx.Provide(Run[*readyRequest](r, func() *readyRequest { return &readyRequest{&url, checked} })), fx.Invoke(func(*readyRequest) {}))
	}
	app, err := NewApp(Config{Home: t.TempDir(), WorkRoot: t.TempDir()}, []Layer{layer}, BeforeReady(func(context.Context) error {
		transport = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }))
		url = transport.URL
		return nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	defer func() {
		if transport != nil {
			transport.Close()
		}
	}()
	if err := app.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := <-checked; err != nil {
		t.Fatalf("OnReady could not reach transport: %v", err)
	}
}

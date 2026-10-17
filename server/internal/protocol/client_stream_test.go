package protocol

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientStreamOwnsHeadersFramingAndEarlyClose(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer example" {
			t.Error("stream lost client headers")
		}
		fmt.Fprint(w, ": ping\n\ndata:{\"n\":\ndata: 1}\n\ndata: {\"n\":2}\n\n")
	}))
	defer server.Close()
	c := Client{Base: server.URL, Header: http.Header{"Authorization": []string{"Bearer example"}}}
	count := 0
	err := c.Stream(context.Background(), "/stream", func(body json.RawMessage) (bool, error) {
		count++
		var value struct {
			N int `json:"n"`
		}
		if err := json.Unmarshal(body, &value); err != nil {
			return false, err
		}
		if value.N != 1 {
			t.Errorf("unexpected event %s", body)
		}
		return false, nil
	})
	if err != nil || count != 1 {
		t.Fatalf("%d events, %v", count, err)
	}
}
func TestClientStreamUsesTaggedErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		fmt.Fprint(w, `{"_tag":"Refused","reason":"blocked"}`)
	}))
	defer server.Close()
	c := Client{Base: server.URL}
	err := c.Stream(context.Background(), "/stream", func(json.RawMessage) (bool, error) { t.Fatal("called on refusal"); return false, nil })
	var refused Refused
	if !errors.As(err, &refused) || !strings.Contains(err.Error(), "blocked") {
		t.Fatal(err)
	}
}

type streamBody struct {
	io.Reader
	closed bool
}

func (b *streamBody) Close() error { b.closed = true; return nil }

type streamTransport func(*http.Request) (*http.Response, error)

func (f streamTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestClientStreamClosesTheResponseOnConsumerExit(t *testing.T) {
	for _, failure := range []bool{false, true} {
		body := &streamBody{Reader: strings.NewReader("data: {}\n\ndata: {}\n\n")}
		c := Client{Base: "http://example.test", HTTP: &http.Client{Transport: streamTransport(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: body, Header: make(http.Header)}, nil
		})}}
		rejected := errors.New("consumer refused")
		err := c.Stream(context.Background(), "/stream", func(json.RawMessage) (bool, error) {
			if failure {
				return false, rejected
			}
			return false, nil
		})
		if !body.closed {
			t.Fatal("consumer exit left response open")
		}
		if failure && !errors.Is(err, rejected) {
			t.Fatal(err)
		}
		if !failure && err != nil {
			t.Fatal(err)
		}
	}
}

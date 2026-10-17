package protocol_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"

	"vibevalley/internal/protocol"
)

// Every Client method sends what its endpoint's route takes: the route matches, the query parameters it was given are
// there, a body when the endpoint takes one.
func TestClientCallsEveryEndpoint(t *testing.T) {
	type got struct {
		op    string
		query []string
		body  bool
	}
	var last got
	mux := http.NewServeMux()
	for _, e := range protocol.Endpoints {
		mux.HandleFunc(e.Method+" "+e.Path, func(w http.ResponseWriter, r *http.Request) {
			b, _ := io.ReadAll(r.Body)
			var q []string
			for k := range r.URL.Query() {
				q = append(q, k)
			}
			slices.Sort(q)
			last = got{e.Op, q, len(b) > 0}
			w.WriteHeader(http.StatusNoContent)
		})
	}
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := reflect.ValueOf(&protocol.Client{Base: srv.URL})
	for _, e := range protocol.Endpoints {
		group, op, _ := strings.Cut(e.Op, ".")
		name := strings.ToUpper(group[:1]) + group[1:] + strings.ToUpper(op[:1]) + op[1:]
		m := c.MethodByName(name)
		if !m.IsValid() {
			t.Errorf("%s: no Client.%s", e.Op, name)
			continue
		}
		args := []reflect.Value{reflect.ValueOf(context.Background())}
		for i := 1; i < m.Type().NumIn(); i++ {
			args = append(args, sample(m.Type().In(i)))
		}
		last = got{}
		out := m.Call(args)
		if err, _ := out[len(out)-1].Interface().(error); err != nil {
			t.Errorf("%s: %v", e.Op, err)
			continue
		}
		want := got{e.Op, slices.Sorted(slices.Values(e.Query)), e.Body}
		if last.op != want.op || !slices.Equal(last.query, want.query) || last.body != want.body {
			t.Errorf("%s: the server saw %+v, want %+v", e.Op, last, want)
		}
	}
}

// A path parameter is "x" or 1, a query one is given, a body is its zero value.
func sample(t reflect.Type) reflect.Value {
	switch {
	case t.Kind() == reflect.Pointer:
		v := reflect.New(t.Elem())
		v.Elem().Set(sample(t.Elem()))
		return v
	case t.Kind() == reflect.String:
		return reflect.ValueOf("x").Convert(t)
	case t.Kind() == reflect.Int64:
		return reflect.ValueOf(int64(1))
	}
	return reflect.Zero(t)
}

// A tagged error the server answers comes back as its type.
func TestClientErrorsKeepTheirType(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		io.WriteString(w, `{"_tag":"Refused","reason":"排上队了"}`)
	}))
	defer srv.Close()
	_, err := (&protocol.Client{Base: srv.URL}).IssueStart(context.Background(), "t1")
	var refused protocol.Refused
	if !errors.As(err, &refused) || refused.Reason != "排上队了" {
		t.Fatalf("%T %v", err, err)
	}
}

// Each handler only forwards to the service that owns the rule.
package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"vibevalley/internal/farm"
	"vibevalley/internal/protocol"
)

// Keeps proxies from closing a quiet event stream.
const heartbeat = 20 * time.Second

// It hands the yard gate its part (apiMux) before the farm starts: the gate answers the API, and the API answers for every service, the gate's own
// pages too.
func New(f *farm.Farm) http.Handler {
	f.Lan.API = apiMux(f)
	mux := apiMux(f)
	mux.Handle("/mcp", f.FarmTools.Handler())
	mux.Handle("/mcp/", f.FarmTools.Handler())
	return mux
}

// All the yard gate lets through.
func apiMux(f *farm.Farm) *http.ServeMux {
	a := api{f}
	mux := http.NewServeMux()
	protocol.Mount(mux, a)
	mux.HandleFunc("GET /api/site/events", a.siteEvents)
	mux.HandleFunc("GET /api/site/state", a.siteStates)
	return mux
}

func sse(w http.ResponseWriter) (func(any) bool, func() bool, bool) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return nil, nil, false
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	send := func(v any) bool {
		body, err := json.Marshal(v)
		if err != nil {
			return true
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", body); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	ping := func() bool {
		if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	return send, ping, true
}

func (a api) siteEvents(w http.ResponseWriter, r *http.Request) {
	send, ping, ok := sse(w)
	if !ok {
		return
	}
	snapshot, events, stop := a.f.Site.Events()
	defer stop()
	if !send(snapshot) {
		return
	}
	tick := time.NewTicker(heartbeat)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case e, open := <-events:
			if !open || !send(e) {
				return
			}
		case <-tick.C:
			if !ping() {
				return
			}
		}
	}
}

func (a api) siteStates(w http.ResponseWriter, r *http.Request) {
	send, ping, ok := sse(w)
	if !ok {
		return
	}
	frames := a.f.Site.States(r.Context().Done())
	tick := time.NewTicker(heartbeat)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case frame, open := <-frames:
			if !open || !send(frame) {
				return
			}
		case <-tick.C:
			if !ping() {
				return
			}
		}
	}
}

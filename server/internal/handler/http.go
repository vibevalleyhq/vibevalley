// Package handler is the farm over HTTP: VibeValleyApi, the site events and folded states as server-sent events, and
// the farm's MCP tools. Each handler forwards to the service that owns the rule. Listen on loopback only: helpers run
// without permission prompts; other devices come through the yard gate (channels/lan.go), which answers apiMux alone.
package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"vibevalley/internal/farm"
	"vibevalley/internal/protocol"
)

// heartbeat: a comment line every so often keeps proxies from closing a quiet event stream.
const heartbeat = 20 * time.Second

// New is everything the farm answers. It hands the yard gate its part (apiMux), so it comes before the farm starts:
// the gate answers the API, and the API answers for every service, the gate's own pages too.
func New(f *farm.Farm) http.Handler {
	f.Lan.API = apiMux(f)
	mux := apiMux(f)
	mux.Handle("/mcp", f.FarmTools.Handler())
	mux.Handle("/mcp/", f.FarmTools.Handler())
	return mux
}

// apiMux is VibeValleyApi and the site streams: what the clients use, and all the yard gate lets through.
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

// siteEvents: GET /api/site/events, a snapshot, then every site event, one per server-sent event.
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

// siteStates: GET /api/site/state, the folded state with its view and effects, again whenever it changes.
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

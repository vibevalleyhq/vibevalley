// The vibevalley server: the workspace (package workspace) over HTTP on loopback. The Flutter
// macOS app (app) bundles this command as vibevalley-server and starts it on a free loopback port; run alone, it is the server.
//
//	go run ./cmd/server                          # host:port from the configuration (127.0.0.1:8787)
//	go run ./cmd/server --config dev.yaml        # this file, not $VIBEVALLEY_HOME/vibevalley.yaml
//	go run ./cmd/server --log ~/.vibevalley/logs/server.log
//
// The configuration is base.LoadConfig's: the YAML file, then VIBEVALLEY_* in the environment.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/handler"
	"vibevalley/internal/workspace"
)

func main() {
	configFile := flag.String("config", "", "the YAML configuration (default $VIBEVALLEY_HOME/vibevalley.yaml, if it is there)")
	logFile := flag.String("log", "", "also append the log to this file")
	flag.Parse()
	cfg, err := base.LoadConfig(*configFile)
	if err != nil {
		log.Fatalf("vibevalley: %v", err)
	}
	if *logFile != "" {
		if err := os.MkdirAll(filepath.Dir(*logFile), 0o755); err != nil {
			log.Fatal(err)
		}
		out, err := os.OpenFile(*logFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			log.Fatal(err)
		}
		defer out.Close()
		log.SetOutput(io.MultiWriter(os.Stderr, out))
	}
	f, err := workspace.New(cfg)
	if err != nil {
		log.Fatal(err)
	}
	// Before the farm starts: it hands the yard gate the API.
	answer := handler.New(f)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := f.Start(ctx); err != nil {
		log.Fatal(err)
	}
	// host is 127.0.0.1 unless set: workers run without permission prompts, so the farm is never for the network.
	listener, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	if err != nil {
		log.Fatal(fmt.Errorf("vibevalley: %w", err))
	}
	f.Worker.SetAddress(listener.Addr().String())
	// Requests share the server's context: stopping ends the pages' event streams, which never end on their own, so
	// the farm saves (state.json, workers.json, the database) without waiting for them.
	server := &http.Server{Handler: answer, BaseContext: func(net.Listener) context.Context { return ctx }}
	done := make(chan struct{})
	go func() {
		defer close(done)
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			log.Printf("vibevalley: the HTTP server did not close cleanly: %v", err)
		}
	}()
	log.Printf("vibevalley: listening on http://%s", listener.Addr())
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-done
	f.Close()
}

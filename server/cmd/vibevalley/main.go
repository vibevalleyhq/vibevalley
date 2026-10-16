// The vibevalley server in Go: the farm (package farm) over HTTP on loopback. The Flutter
// macOS app (app) bundles this command and starts it on a free loopback port; run alone, it is the server.
//
//	go run ./cmd/vibevalley                          # $HOST:$PORT (127.0.0.1:8787)
//	go run ./cmd/vibevalley --env-file .env          # variables from a .env file too (set ones win)
//	go run ./cmd/vibevalley --log ~/.vibevalley/logs/server.log
//	go run ./cmd/vibevalley import <ts-home> --into <go-home>   # an existing farm from the TypeScript server (import.go)
//	go run ./cmd/vibevalley migrate [--dry-run]   # a farm kept under the old names, moved once (migrate.go)
//
// The environment: what is set, then --env-file, then $VIBEVALLEY_HOME/.env (the desktop app's place for the voice
// credentials and a DeepSeek key), each filling only what is not set yet.
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
	"syscall"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/farm"
	"vibevalley/internal/handler"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "import" {
		os.Exit(runImport(os.Args[2:]))
	}
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		os.Exit(runMigrate(os.Args[2:]))
	}
	envFile := flag.String("env-file", "", "a .env file to read (variables already set win)")
	logFile := flag.String("log", "", "also append the log to this file")
	flag.Parse()
	if *envFile != "" {
		if err := base.LoadEnvFile(*envFile); err != nil {
			log.Fatalf("vibevalley: %s: %v", *envFile, err)
		}
	}
	cfg := base.DefaultConfig()
	if err := base.LoadEnvFile(filepath.Join(cfg.Home, ".env")); err != nil {
		log.Fatalf("vibevalley: %s: %v", filepath.Join(cfg.Home, ".env"), err)
	}
	// $VIBEVALLEY_HOME/.env may name the work folder or the database too.
	cfg = base.DefaultConfig()
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
	host := envOr("HOST", "127.0.0.1")
	port := envOr("PORT", "8787")
	f, err := farm.New(cfg)
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
	// HOST is 127.0.0.1 unless set: helpers run without permission prompts, so the farm is never for the network.
	listener, err := net.Listen("tcp", net.JoinHostPort(host, port))
	if err != nil {
		log.Fatal(fmt.Errorf("vibevalley: %w", err))
	}
	f.Crew.SetAddress(listener.Addr().String())
	// Requests share the server's context: stopping ends the pages' event streams, which never end on their own, so
	// the farm saves (farm.json, crew.json, the database) without waiting for them.
	server := &http.Server{Handler: answer, BaseContext: func(net.Listener) context.Context { return ctx }}
	done := make(chan struct{})
	go func() {
		defer close(done)
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("vibevalley: listening on http://%s", listener.Addr())
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-done
	f.Close()
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

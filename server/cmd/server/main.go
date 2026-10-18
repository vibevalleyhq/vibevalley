// The vibevalley server: the workspace (package workspace) over HTTP on loopback. The Flutter
// macOS app (app) bundles this command as vibevalley-server and starts it on a free loopback port; run alone, it is the server.
//
//	go run ./cmd/server                          # port from the configuration (127.0.0.1:8787)
//	go run ./cmd/server --config dev.yaml        # this file, not $VIBEVALLEY_HOME/vibevalley.yaml
//	go run ./cmd/server --log ~/.vibevalley/logs/server.log
//
// The configuration is base.LoadConfig's: the YAML file, then VIBEVALLEY_* in the environment.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"vibevalley/internal/base"
	"vibevalley/internal/handler"
	"vibevalley/internal/protocol"
)

func main() {
	configFile := flag.String("config", "", "the YAML configuration (default $VIBEVALLEY_HOME/vibevalley.yaml, if it is there)")
	logFile := flag.String("log", "", "also append the log to this file")
	readyJSON := flag.Bool("ready-json", false, "write the ready address and process identity as one JSON line on stdout")
	flag.Parse()
	// A key in a line from a helper or a service never reaches the terminal or the file.
	log.SetOutput(base.RedactingWriter(os.Stderr))
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
		log.SetOutput(base.RedactingWriter(io.MultiWriter(os.Stderr, out)))
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	server, err := handler.Listen(ctx, cfg)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("vibevalley: listening on http://%s", server.Address())
	if *readyJSON {
		if err := json.NewEncoder(os.Stdout).Encode(protocol.ServerReady{URL: "http://" + server.Address(), PID: int64(os.Getpid())}); err != nil {
			stop()
			_ = server.Wait()
			log.Fatalf("vibevalley: publish readiness: %v", err)
		}
	}
	if err := server.Wait(); err != nil {
		log.Fatal(err)
	}
}

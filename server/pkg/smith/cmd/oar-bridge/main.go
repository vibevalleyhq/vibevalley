// Command oar-bridge serves OAR runtimes over JSON-RPC on stdio (see package bridge).
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"vibevalley/pkg/smith/bridge"
	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/shared"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	registry, err := bridge.Registry()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	err = bridge.Serve(ctx, registry, os.Stdin, os.Stdout)
	// Go has no exit hook: take down whatever a runtime left running.
	executable.KillOwned()
	shared.RemovePrivateTempDirs()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

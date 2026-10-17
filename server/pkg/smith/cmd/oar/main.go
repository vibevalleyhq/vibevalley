// Command oar observes and runs installed agent runtimes (packages/cli).
package main

import (
	"fmt"
	"os"

	"vibevalley/pkg/smith/cli"
	"vibevalley/pkg/smith/oar"
)

func main() {
	registry, err := oar.NewRuntimeRegistry(cli.Runtimes()...)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(cli.Main(os.Args[1:], cli.Options{Registry: registry}))
}

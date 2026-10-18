package main

import (
	"vibevalley/internal/base"
	"vibevalley/internal/runtime"
	"vibevalley/pkg/smith/cli"
	"vibevalley/pkg/smith/oar"
)

// runtimes is the farm's runtimes, as the server knows them; vibevalley's own agent reads the configuration's key.
func runtimes() (*oar.RuntimeRegistry, error) {
	cfg, err := base.LoadConfig("")
	if err != nil {
		return nil, err
	}
	return runtime.Registry(cfg.Home, func() string { return cfg.DeepSeek.APIKey }, nil), nil
}

// oarCommand is `vibevalley oar …`: smith's oar command line over the farm's runtimes, on this machine.
func oarCommand(raw []string) (int, error) {
	registry, err := runtimes()
	if err != nil {
		return 0, err
	}
	return cli.Main(raw, cli.Options{Name: "vibevalley oar", Registry: registry}), nil
}

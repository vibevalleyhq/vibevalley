package config

// Pin CLI and YAML configuration framework dependencies in go.mod before Swarm workers branch.
import (
	_ "github.com/knadh/koanf/parsers/yaml"
	_ "github.com/knadh/koanf/providers/confmap"
	_ "github.com/knadh/koanf/providers/file"
	_ "github.com/knadh/koanf/providers/posflag"
	_ "github.com/knadh/koanf/v2"
	_ "github.com/spf13/cobra"
	_ "github.com/spf13/pflag"
)

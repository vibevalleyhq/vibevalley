// Package config provides instance-scoped YAML, environment, and CLI flag
// configuration loading, validation, and secret redaction for VibeValley binaries.
package config

import (
	"errors"
	"fmt"
	"io/fs"
	"math"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/knadh/koanf/parsers/yaml"
	"github.com/knadh/koanf/providers/confmap"
	"github.com/knadh/koanf/providers/file"
	"github.com/knadh/koanf/providers/posflag"
	"github.com/knadh/koanf/v2"
	"github.com/spf13/pflag"
)

const (
	// RedactedValue replaces sensitive values in redacted config outputs.
	RedactedValue = "***REDACTED***"

	defaultConfigFilename  = "vibevalley.yaml"
	defaultServerAddr      = "127.0.0.1:8787"
	defaultPreviewAddr     = "127.0.0.1:0"
	defaultDBPath          = ":memory:"
	defaultMountSyncPeriod = 15 * time.Second
	defaultMountFlushWait  = 30 * time.Second
	defaultExecGrace       = 2 * time.Second
	maxExecGrace           = 3 * time.Second
	defaultWebScheme       = "vibe"
	defaultRootKeyID       = "desktop-master-v1"
	defaultKeychainService = "com.vibevalley.desktop.vault"
)

// AppConfig holds the complete resolved configuration for VibeValley processes.
type AppConfig struct {
	HomeDir  string            `koanf:"home_dir" yaml:"home_dir"`
	WorkRoot string            `koanf:"work_root" yaml:"work_root"`
	Server   ServerSection     `koanf:"server" yaml:"server"`
	Machine  MachineSection    `koanf:"machine" yaml:"machine"`
	Desktop  DesktopSection    `koanf:"desktop" yaml:"desktop"`
	DeepSeek DeepSeekSection   `koanf:"deepseek" yaml:"deepseek"`
	Secrets  map[string]string `koanf:"secrets" yaml:"secrets,omitempty"`
}

// ServerSection configures the vibe-server HTTP/WebSocket control plane and preview listener.
type ServerSection struct {
	Addr                string `koanf:"addr" yaml:"addr"`
	PreviewAddr         string `koanf:"preview_addr" yaml:"preview_addr"`
	DBPath              string `koanf:"db_path" yaml:"db_path"`
	WorkRoot            string `koanf:"work_root" yaml:"work_root"`
	ArtifactDir         string `koanf:"artifact_dir" yaml:"artifact_dir"`
	MediaDir            string `koanf:"media_dir" yaml:"media_dir"`
	ReadyJSON           bool   `koanf:"ready_json" yaml:"ready_json"`
	AllowLoopbackEgress bool   `koanf:"allow_loopback_egress" yaml:"allow_loopback_egress"`
}

// MachineSection configures the zero-secret vibe-machine execution node.
type MachineSection struct {
	ServerURL    string        `koanf:"server_url" yaml:"server_url"`
	MachineID    string        `koanf:"machine_id" yaml:"machine_id"`
	WorkRoot     string        `koanf:"work_root" yaml:"work_root"`
	Labels       []string      `koanf:"labels" yaml:"labels"`
	MCPTargets   []string      `koanf:"mcp_targets" yaml:"mcp_targets"`
	SyncInterval time.Duration `koanf:"sync_interval" yaml:"sync_interval"`
	FlushTimeout time.Duration `koanf:"flush_timeout" yaml:"flush_timeout"`
	ExecGrace    time.Duration `koanf:"exec_grace" yaml:"exec_grace"`
}

// MCPTargetConfig represents a parsed id=endpoint private intranet MCP tunnel target.
type MCPTargetConfig struct {
	ID       string `koanf:"id" yaml:"id"`
	Endpoint string `koanf:"endpoint" yaml:"endpoint"`
}

// DesktopSection configures the vibe-desktop GUI host and embedded runtime options.
type DesktopSection struct {
	ServerURL        string   `koanf:"server_url" yaml:"server_url"`
	WebDist          string   `koanf:"web_dist" yaml:"web_dist"`
	Scheme           string   `koanf:"scheme" yaml:"scheme"`
	AutomationSocket string   `koanf:"automation_socket" yaml:"automation_socket"`
	RepoRoots        []string `koanf:"repo_roots" yaml:"repo_roots"`
	HeadlessCheck    bool     `koanf:"headless_check" yaml:"headless_check"`
	RootKeyID        string   `koanf:"root_key_id" yaml:"root_key_id"`
	KeychainService  string   `koanf:"keychain_service" yaml:"keychain_service"`
	DBPath           string   `koanf:"db_path" yaml:"db_path"`
}

// DeepSeekSection holds DeepSeek provider credentials.
type DeepSeekSection struct {
	APIKey string `koanf:"api_key" yaml:"api_key"`
}

// LoadOptions controls configuration discovery, environment lookup, and CLI flag overrides.
type LoadOptions struct {
	ConfigFile string
	Getenv     func(string) string
	FlagSet    *pflag.FlagSet
	FlagKeyMap map[string]string
}

var (
	topLevelSections = map[string]bool{
		"server":   true,
		"machine":  true,
		"desktop":  true,
		"deepseek": true,
		"secrets":  true,
	}
	auxiliarySections = map[string]bool{
		"database": true,
		"agent":    true,
		"agora":    true,
		"voice":    true,
		"lan":      true,
		"patrol":   true,
		"cron":     true,
		"session":  true,
		"repo":     true,
		"github":   true,
		"chat":     true,
		"otlp":     true,
		"pkm":      true,
	}
	topLevelScalars = map[string]bool{
		"home_dir":    true,
		"work_root":   true,
		"port":        true,
		"db":          true,
		"web":         true,
		"tokei":       true,
		"cny_per_usd": true,
	}
	topLevelLists = map[string]bool{
		"git_emails": true,
	}
	sectionFields = map[string]map[string]bool{
		"server": {
			"addr":                  true,
			"preview_addr":          true,
			"db_path":               true,
			"work_root":             true,
			"artifact_dir":          true,
			"media_dir":             true,
			"ready_json":            true,
			"allow_loopback_egress": true,
		},
		"machine": {
			"server_url":    true,
			"machine_id":    true,
			"work_root":     true,
			"labels":        true,
			"mcp_targets":   true,
			"sync_interval": true,
			"flush_timeout": true,
			"exec_grace":    true,
		},
		"desktop": {
			"server_url":        true,
			"web_dist":          true,
			"scheme":            true,
			"automation_socket": true,
			"repo_roots":        true,
			"headless_check":    true,
			"root_key_id":       true,
			"keychain_service":  true,
			"db_path":           true,
		},
		"deepseek": {
			"api_key": true,
		},
	}
	sliceKeys = map[string]bool{
		"machine.labels":      true,
		"machine.mcp_targets": true,
		"desktop.repo_roots":  true,
	}
	// nonSecretKeySuffixExceptions prevents identifiers like root_key_id from matching *_key checks.
	nonSecretKeys = map[string]bool{
		"root_key_id":      true,
		"keychain_service": true,
		"machine_id":       true,
	}
)

// DefaultConfig returns a new AppConfig populated with VibeValley defaults for the given env lookup.
func DefaultConfig(getenv func(string) string) *AppConfig {
	return defaultConfig(getenv, getenv == nil)
}

func defaultConfig(getenv func(string) string, allowUserHomeFallback bool) *AppConfig {
	getenv = normalizeGetenv(getenv)
	homeDir, hasHome := resolveHomeDir(getenv, allowUserHomeFallback)
	workRoot := defaultWorkRoot(homeDir, hasHome)

	return &AppConfig{
		HomeDir:  homeDir,
		WorkRoot: workRoot,
		Server: ServerSection{
			Addr:        defaultServerAddr,
			PreviewAddr: defaultPreviewAddr,
			DBPath:      defaultDBPath,
		},
		Machine: MachineSection{
			MachineID:    defaultMachineID(),
			WorkRoot:     workRoot,
			Labels:       []string{},
			MCPTargets:   []string{},
			SyncInterval: defaultMountSyncPeriod,
			FlushTimeout: defaultMountFlushWait,
			ExecGrace:    defaultExecGrace,
		},
		Desktop: DesktopSection{
			Scheme:          defaultWebScheme,
			RepoRoots:       []string{},
			RootKeyID:       defaultRootKeyID,
			KeychainService: defaultKeychainService,
			DBPath:          defaultDBPath,
		},
		Secrets: map[string]string{},
	}
}

// DefaultMap returns DefaultConfig serialized as a nested map suitable for koanf confmap.Provider.
func DefaultMap(getenv func(string) string) map[string]any {
	return configToMap(defaultConfig(getenv, getenv == nil), false)
}

// ResolvePath determines the YAML configuration path and whether it was explicitly requested.
func ResolvePath(configFile string, getenv func(string) string) (path string, explicit bool) {
	return resolvePath(configFile, getenv, getenv == nil)
}

func resolvePath(configFile string, getenv func(string) string, allowUserHomeFallback bool) (path string, explicit bool) {
	getenv = normalizeGetenv(getenv)
	if trimmed := strings.TrimSpace(configFile); trimmed != "" {
		return expandTilde(trimmed, getenv, allowUserHomeFallback), true
	}
	if envPath := strings.TrimSpace(getenv("VIBE_CONFIG")); envPath != "" {
		return expandTilde(envPath, getenv, allowUserHomeFallback), true
	}
	homeDir, _ := resolveHomeDir(getenv, allowUserHomeFallback)
	return filepath.Join(homeDir, defaultConfigFilename), false
}

// Load resolves configuration with strict precedence:
// Changed CLI Flags > Environment Variables > YAML file > Defaults.
// It returns the validated AppConfig and the YAML path actually loaded (empty if none).
func Load(opts LoadOptions) (*AppConfig, string, error) {
	customEnv := opts.Getenv != nil
	allowUserHomeFallback := !customEnv
	getenv := normalizeGetenv(opts.Getenv)

	k := koanf.New(".")
	if err := k.Load(confmap.Provider(configToMap(defaultConfig(getenv, allowUserHomeFallback), false), "."), nil); err != nil {
		return nil, "", fmt.Errorf("load default config: %w", err)
	}

	resolvedPath, explicit := resolvePath(opts.ConfigFile, getenv, allowUserHomeFallback)
	loadedPath := ""

	info, statErr := os.Stat(resolvedPath)
	switch {
	case statErr == nil:
		if info.IsDir() {
			return nil, "", fmt.Errorf("load config %q: path is a directory", resolvedPath)
		}
		yamlMap, err := loadAndNormalizeYAML(resolvedPath)
		if err != nil {
			return nil, "", err
		}
		if err := k.Load(confmap.Provider(yamlMap, "."), nil); err != nil {
			return nil, "", fmt.Errorf("load config %q: %w", resolvedPath, err)
		}
		loadedPath = resolvedPath
	case explicit:
		return nil, "", fmt.Errorf("load config %q: %w", resolvedPath, statErr)
	case !errors.Is(statErr, fs.ErrNotExist):
		return nil, "", fmt.Errorf("load config %q: %w", resolvedPath, statErr)
	}

	envMap, err := envOverrides(getenv)
	if err != nil {
		return nil, "", err
	}
	if len(envMap) > 0 {
		if err := k.Load(confmap.Provider(envMap, "."), nil); err != nil {
			return nil, "", fmt.Errorf("load env overrides: %w", err)
		}
	}

	if opts.FlagSet != nil {
		p := posflag.ProviderWithFlag(opts.FlagSet, ".", nil, func(f *pflag.Flag) (string, any) {
			if !f.Changed {
				return "", nil
			}
			key := ""
			if opts.FlagKeyMap != nil {
				key = opts.FlagKeyMap[f.Name]
			} else if isKnownDottedKey(f.Name) {
				key = f.Name
			}
			if key == "" {
				return "", nil
			}
			val := posflag.FlagVal(opts.FlagSet, f)
			if sliceKeys[key] {
				if s, ok := val.(string); ok {
					return key, splitCSV(s)
				}
			}
			return key, val
		})
		if err := k.Load(p, nil); err != nil {
			return nil, "", fmt.Errorf("load flag overrides: %w", err)
		}
	}

	cfg := &AppConfig{}
	if err := k.UnmarshalWithConf("", cfg, koanf.UnmarshalConf{Tag: "koanf"}); err != nil {
		if loadedPath != "" {
			return nil, "", fmt.Errorf("decode config %q: %w", loadedPath, err)
		}
		return nil, "", fmt.Errorf("decode config: %w", err)
	}
	if cfg.Machine.Labels == nil {
		cfg.Machine.Labels = []string{}
	}
	if cfg.Machine.MCPTargets == nil {
		cfg.Machine.MCPTargets = []string{}
	}
	if cfg.Desktop.RepoRoots == nil {
		cfg.Desktop.RepoRoots = []string{}
	}
	if cfg.Secrets == nil {
		cfg.Secrets = map[string]string{}
	}

	if err := Validate(cfg); err != nil {
		if loadedPath != "" {
			return nil, "", fmt.Errorf("validate config %q: %w", loadedPath, err)
		}
		return nil, "", err
	}
	return cfg, loadedPath, nil
}

// Validate verifies structural and runtime invariants on cfg.
func Validate(cfg *AppConfig) error {
	if cfg == nil {
		return errors.New("config: nil configuration")
	}
	if addr := strings.TrimSpace(cfg.Server.Addr); addr != "" {
		if err := validateListenAddr("server.addr", addr); err != nil {
			return err
		}
	}
	if pAddr := strings.TrimSpace(cfg.Server.PreviewAddr); pAddr != "" && !isDisabledAddr(pAddr) {
		if err := validateListenAddr("server.preview_addr", pAddr); err != nil {
			return err
		}
	}
	if srvURL := strings.TrimSpace(cfg.Machine.ServerURL); srvURL != "" {
		if err := validateEndpointURL("machine.server_url", srvURL, []string{"http", "https", "ws", "wss"}); err != nil {
			return err
		}
	}
	if _, err := ParseMCPTargets(cfg.Machine.MCPTargets); err != nil {
		return err
	}
	if cfg.Machine.SyncInterval < 0 {
		return fmt.Errorf("machine.sync_interval must not be negative, got %s", cfg.Machine.SyncInterval)
	}
	if cfg.Machine.FlushTimeout < 0 {
		return fmt.Errorf("machine.flush_timeout must not be negative, got %s", cfg.Machine.FlushTimeout)
	}
	if cfg.Machine.ExecGrace <= 0 || cfg.Machine.ExecGrace > maxExecGrace {
		return fmt.Errorf("machine.exec_grace must be in (0s, %s], got %s", maxExecGrace, cfg.Machine.ExecGrace)
	}
	if srvURL := strings.TrimSpace(cfg.Desktop.ServerURL); srvURL != "" {
		if err := validateEndpointURL("desktop.server_url", srvURL, []string{"http", "https", "ws", "wss", "chord"}); err != nil {
			return err
		}
	}
	if scheme := strings.TrimSpace(cfg.Desktop.Scheme); scheme != "" {
		if !isValidScheme(scheme) {
			return fmt.Errorf("desktop.scheme %q is not a valid URL scheme", scheme)
		}
	}
	return nil
}

// ParsedMCPTargets parses MachineSection.MCPTargets into structured MCPTargetConfig items.
func (m MachineSection) ParsedMCPTargets() ([]MCPTargetConfig, error) {
	return ParseMCPTargets(m.MCPTargets)
}

// ParseMCPTarget parses a single "id=http(s)://url" string into an MCPTargetConfig.
func ParseMCPTarget(raw string) (MCPTargetConfig, error) {
	id, endpoint, ok := strings.Cut(raw, "=")
	id = strings.TrimSpace(id)
	endpoint = strings.TrimSpace(endpoint)
	if !ok || id == "" || endpoint == "" {
		return MCPTargetConfig{}, fmt.Errorf("machine.mcp_targets entry %q: expected id=http(s)://url", raw)
	}
	if err := validateEndpointURL(fmt.Sprintf("machine.mcp_targets[%s]", id), endpoint, []string{"http", "https"}); err != nil {
		return MCPTargetConfig{}, err
	}
	return MCPTargetConfig{ID: id, Endpoint: endpoint}, nil
}

// ParseMCPTargets parses and validates all MCP target specifications and rejects duplicate IDs.
func ParseMCPTargets(raw []string) ([]MCPTargetConfig, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	seen := make(map[string]struct{}, len(raw))
	out := make([]MCPTargetConfig, 0, len(raw))
	for _, entry := range raw {
		parsed, err := ParseMCPTarget(entry)
		if err != nil {
			return nil, err
		}
		if _, dup := seen[parsed.ID]; dup {
			return nil, fmt.Errorf("machine.mcp_targets: duplicate target id %q", parsed.ID)
		}
		seen[parsed.ID] = struct{}{}
		out = append(out, parsed)
	}
	return out, nil
}

// Redact returns a deep copy of cfg with non-empty DeepSeek.APIKey, all Secrets values,
// and any sensitive *_key/token/secret entries replaced with RedactedValue.
func Redact(cfg *AppConfig) *AppConfig {
	if cfg == nil {
		return nil
	}
	cp := *cfg
	cp.Machine.Labels = slices.Clone(cfg.Machine.Labels)
	cp.Machine.MCPTargets = slices.Clone(cfg.Machine.MCPTargets)
	cp.Desktop.RepoRoots = slices.Clone(cfg.Desktop.RepoRoots)

	if cp.DeepSeek.APIKey != "" {
		cp.DeepSeek.APIKey = RedactedValue
	}
	if cfg.Secrets != nil {
		cp.Secrets = make(map[string]string, len(cfg.Secrets))
		for k := range cfg.Secrets {
			cp.Secrets[k] = RedactedValue
		}
	}
	return &cp
}

// MarshalRedactedYAML marshals cfg to YAML after redacting all secrets and sensitive credentials.
func MarshalRedactedYAML(cfg *AppConfig) ([]byte, error) {
	if cfg == nil {
		return nil, errors.New("config: nil configuration")
	}
	redacted := Redact(cfg)
	mp := configToMap(redacted, true)
	redactMapEntries(mp, false)
	return yaml.Parser().Marshal(mp)
}

func loadAndNormalizeYAML(path string) (map[string]any, error) {
	yk := koanf.New(".")
	if err := yk.Load(file.Provider(path), yaml.Parser()); err != nil {
		return nil, fmt.Errorf("load config %q: %w", path, err)
	}
	raw := yk.Raw()
	if err := validateAndNormalizeYAML(raw, path); err != nil {
		return nil, err
	}
	// Propagate top-level work_root to server/machine sections unless YAML specified overrides.
	if workRoot, ok := raw["work_root"]; ok {
		setSectionDefault(raw, "server", "work_root", workRoot)
		setSectionDefault(raw, "machine", "work_root", workRoot)
	}
	// Map official TS vibevalley.yaml top-level keys into canonical Go sections when not overridden.
	if portVal, ok := raw["port"]; ok {
		portNum, err := parseYAMLPort(portVal)
		if err != nil {
			return nil, fmt.Errorf("load config %q: port: %w", path, err)
		}
		setSectionDefault(raw, "server", "addr", fmt.Sprintf("127.0.0.1:%d", portNum))
		delete(raw, "port")
	}
	if dbVal, ok := raw["db"]; ok {
		dbStr, ok := dbVal.(string)
		if !ok {
			return nil, fmt.Errorf("load config %q: key %q must be a string", path, "db")
		}
		if trimmed := strings.TrimSpace(dbStr); trimmed != "" {
			if trimmed == "memory" {
				trimmed = ":memory:"
			}
			setSectionDefault(raw, "server", "db_path", trimmed)
		}
		delete(raw, "db")
	}
	if webVal, ok := raw["web"]; ok {
		webStr, ok := webVal.(string)
		if !ok {
			return nil, fmt.Errorf("load config %q: key %q must be a string", path, "web")
		}
		if trimmed := strings.TrimSpace(webStr); trimmed != "" {
			setSectionDefault(raw, "desktop", "web_dist", trimmed)
		}
		delete(raw, "web")
	}
	delete(raw, "tokei")
	delete(raw, "cny_per_usd")
	delete(raw, "git_emails")
	for aux := range auxiliarySections {
		delete(raw, aux)
	}
	return raw, nil
}

func setSectionDefault(raw map[string]any, section, field string, val any) {
	if sec, ok := raw[section].(map[string]any); ok {
		if _, exists := sec[field]; !exists {
			sec[field] = val
		}
		return
	}
	raw[section] = map[string]any{field: val}
}

func parseYAMLPort(val any) (int, error) {
	var port int
	switch v := val.(type) {
	case int:
		port = v
	case int64:
		port = int(v)
	case uint64:
		if v > 65535 {
			return 0, fmt.Errorf("out of range %d (must be 0..65535)", v)
		}
		port = int(v)
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) || v != math.Trunc(v) {
			return 0, fmt.Errorf("must be an integer, got %v", v)
		}
		port = int(v)
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil {
			return 0, fmt.Errorf("invalid port %q", v)
		}
		port = parsed
	default:
		return 0, fmt.Errorf("must be an integer in 0..65535, got %T", val)
	}
	if port < 0 || port > 65535 {
		return 0, fmt.Errorf("out of range %d (must be 0..65535)", port)
	}
	return port, nil
}

func validateAndNormalizeYAML(raw map[string]any, path string) error {
	for key, val := range raw {
		if topLevelLists[key] {
			if val == nil {
				delete(raw, key)
				continue
			}
			list, err := normalizeStringSlice(val, key, path)
			if err != nil {
				return err
			}
			raw[key] = list
			continue
		}
		if topLevelScalars[key] {
			if val == nil {
				delete(raw, key)
				continue
			}
			if _, isMap := val.(map[string]any); isMap {
				return fmt.Errorf("load config %q: key %q must be a scalar value", path, key)
			}
			if _, isSlice := val.([]any); isSlice {
				return fmt.Errorf("load config %q: key %q must be a scalar value", path, key)
			}
			continue
		}
		if auxiliarySections[key] {
			if val == nil {
				delete(raw, key)
				continue
			}
			if _, ok := val.(map[string]any); !ok {
				return fmt.Errorf("load config %q: section %q must be a mapping", path, key)
			}
			continue
		}
		if !topLevelSections[key] {
			return fmt.Errorf("load config %q: unknown config key %q", path, key)
		}
		if val == nil {
			raw[key] = map[string]any{}
			continue
		}
		secMap, ok := val.(map[string]any)
		if !ok {
			return fmt.Errorf("load config %q: section %q must be a mapping", path, key)
		}
		if key == "secrets" {
			if err := normalizeSecretsMap(secMap, path); err != nil {
				return err
			}
			continue
		}
		allowed := sectionFields[key]
		for subKey, subVal := range secMap {
			fullKey := key + "." + subKey
			if !allowed[subKey] {
				return fmt.Errorf("load config %q: unknown config key %q", path, fullKey)
			}
			if subVal == nil {
				delete(secMap, subKey)
				continue
			}
			switch fullKey {
			case "machine.labels", "desktop.repo_roots":
				list, err := normalizeStringSlice(subVal, fullKey, path)
				if err != nil {
					return err
				}
				secMap[subKey] = list
			case "machine.mcp_targets":
				list, err := normalizeMCPTargets(subVal, path)
				if err != nil {
					return err
				}
				secMap[subKey] = list
			default:
				if _, isMap := subVal.(map[string]any); isMap {
					return fmt.Errorf("load config %q: key %q must be a scalar value", path, fullKey)
				}
				if _, isSlice := subVal.([]any); isSlice {
					return fmt.Errorf("load config %q: key %q must be a scalar value", path, fullKey)
				}
			}
		}
	}
	return nil
}

func normalizeSecretsMap(secMap map[string]any, path string) error {
	for k, v := range secMap {
		if v == nil {
			secMap[k] = ""
			continue
		}
		switch v.(type) {
		case map[string]any, []any:
			return fmt.Errorf("load config %q: key %q must be a scalar value", path, "secrets."+k)
		}
	}
	return nil
}

func normalizeStringSlice(val any, fullKey, path string) ([]string, error) {
	switch v := val.(type) {
	case string:
		return splitCSV(v), nil
	case []string:
		return slices.Clone(v), nil
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			switch s := item.(type) {
			case string:
				if trimmed := strings.TrimSpace(s); trimmed != "" {
					out = append(out, trimmed)
				}
			case int, int64, float64, bool:
				out = append(out, fmt.Sprint(s))
			default:
				return nil, fmt.Errorf("load config %q: key %q list items must be strings", path, fullKey)
			}
		}
		return out, nil
	default:
		return nil, fmt.Errorf("load config %q: key %q must be a string or list of strings", path, fullKey)
	}
}

func normalizeMCPTargets(val any, path string) ([]string, error) {
	switch v := val.(type) {
	case string:
		return splitCSV(v), nil
	case []string:
		return slices.Clone(v), nil
	case []any:
		out := make([]string, 0, len(v))
		for i, item := range v {
			switch entry := item.(type) {
			case string:
				if trimmed := strings.TrimSpace(entry); trimmed != "" {
					out = append(out, trimmed)
				}
			case map[string]any:
				var idStr, endpointStr string
				for mk, mv := range entry {
					switch mk {
					case "id":
						s, ok := mv.(string)
						if !ok {
							return nil, fmt.Errorf("load config %q: machine.mcp_targets[%d].id must be a string", path, i)
						}
						idStr = strings.TrimSpace(s)
					case "endpoint":
						s, ok := mv.(string)
						if !ok {
							return nil, fmt.Errorf("load config %q: machine.mcp_targets[%d].endpoint must be a string", path, i)
						}
						endpointStr = strings.TrimSpace(s)
					default:
						return nil, fmt.Errorf("load config %q: unknown config key %q", path, fmt.Sprintf("machine.mcp_targets[%d].%s", i, mk))
					}
				}
				if idStr == "" || endpointStr == "" {
					return nil, fmt.Errorf("load config %q: machine.mcp_targets[%d] requires non-empty id and endpoint", path, i)
				}
				out = append(out, idStr+"="+endpointStr)
			default:
				return nil, fmt.Errorf("load config %q: machine.mcp_targets[%d] must be \"id=url\" or {id, endpoint}", path, i)
			}
		}
		return out, nil
	default:
		return nil, fmt.Errorf("load config %q: key %q must be a string or list", path, "machine.mcp_targets")
	}
}

func envOverrides(getenv func(string) string) (map[string]any, error) {
	out := make(map[string]any)
	setIfPresent := func(envName string, keys ...string) {
		if val := strings.TrimSpace(getenv(envName)); val != "" {
			for _, k := range keys {
				out[k] = val
			}
		}
	}

	setIfPresent("VIBEVALLEY_HOME", "home_dir")
	setIfPresent("VIBEVALLEY_WORK_ROOT", "work_root", "server.work_root", "machine.work_root")
	setIfPresent("VIBE_SERVER_ADDR", "server.addr")
	setIfPresent("VIBE_PREVIEW_ADDR", "server.preview_addr")
	setIfPresent("VIBE_DB_PATH", "server.db_path", "desktop.db_path")
	if raw := strings.TrimSpace(getenv("VIBE_ALLOW_LOOPBACK_EGRESS")); raw != "" {
		b, err := strconv.ParseBool(raw)
		if err != nil {
			return nil, fmt.Errorf("invalid VIBE_ALLOW_LOOPBACK_EGRESS %q: %w", raw, err)
		}
		out["server.allow_loopback_egress"] = b
	}
	setIfPresent("VIBE_SERVER_URL", "machine.server_url", "desktop.server_url")
	setIfPresent("VIBE_MACHINE_ID", "machine.machine_id")
	setIfPresent("VIBE_WEB_DIST", "desktop.web_dist")
	setIfPresent("MYGO_AUTOMATION", "desktop.automation_socket")
	setIfPresent("DEEPSEEK_API_KEY", "deepseek.api_key")

	return out, nil
}

func configToMap(cfg *AppConfig, stringDurations bool) map[string]any {
	var syncVal, flushVal, graceVal any
	if stringDurations {
		syncVal = cfg.Machine.SyncInterval.String()
		flushVal = cfg.Machine.FlushTimeout.String()
		graceVal = cfg.Machine.ExecGrace.String()
	} else {
		syncVal = cfg.Machine.SyncInterval
		flushVal = cfg.Machine.FlushTimeout
		graceVal = cfg.Machine.ExecGrace
	}

	labels := cfg.Machine.Labels
	if labels == nil {
		labels = []string{}
	}
	mcpTargets := cfg.Machine.MCPTargets
	if mcpTargets == nil {
		mcpTargets = []string{}
	}
	repoRoots := cfg.Desktop.RepoRoots
	if repoRoots == nil {
		repoRoots = []string{}
	}

	secretsMap := make(map[string]any, len(cfg.Secrets))
	for k, v := range cfg.Secrets {
		secretsMap[k] = v
	}

	mp := map[string]any{
		"home_dir":  cfg.HomeDir,
		"work_root": cfg.WorkRoot,
		"server": map[string]any{
			"addr":                  cfg.Server.Addr,
			"preview_addr":          cfg.Server.PreviewAddr,
			"db_path":               cfg.Server.DBPath,
			"work_root":             cfg.Server.WorkRoot,
			"artifact_dir":          cfg.Server.ArtifactDir,
			"media_dir":             cfg.Server.MediaDir,
			"ready_json":            cfg.Server.ReadyJSON,
			"allow_loopback_egress": cfg.Server.AllowLoopbackEgress,
		},
		"machine": map[string]any{
			"server_url":    cfg.Machine.ServerURL,
			"machine_id":    cfg.Machine.MachineID,
			"work_root":     cfg.Machine.WorkRoot,
			"labels":        slices.Clone(labels),
			"mcp_targets":   slices.Clone(mcpTargets),
			"sync_interval": syncVal,
			"flush_timeout": flushVal,
			"exec_grace":    graceVal,
		},
		"desktop": map[string]any{
			"server_url":        cfg.Desktop.ServerURL,
			"web_dist":          cfg.Desktop.WebDist,
			"scheme":            cfg.Desktop.Scheme,
			"automation_socket": cfg.Desktop.AutomationSocket,
			"repo_roots":        slices.Clone(repoRoots),
			"headless_check":    cfg.Desktop.HeadlessCheck,
			"root_key_id":       cfg.Desktop.RootKeyID,
			"keychain_service":  cfg.Desktop.KeychainService,
			"db_path":           cfg.Desktop.DBPath,
		},
		"deepseek": map[string]any{
			"api_key": cfg.DeepSeek.APIKey,
		},
	}
	if !stringDurations || len(secretsMap) > 0 {
		mp["secrets"] = secretsMap
	}
	return mp
}

func redactMapEntries(mp map[string]any, inSecrets bool) {
	for k, v := range mp {
		if sub, ok := v.(map[string]any); ok {
			redactMapEntries(sub, inSecrets || k == "secrets")
			continue
		}
		if inSecrets {
			mp[k] = RedactedValue
			continue
		}
		if isSensitiveKey(k) {
			if s, ok := v.(string); ok && s != "" {
				mp[k] = RedactedValue
			}
		}
	}
}

func isSensitiveKey(key string) bool {
	lower := strings.ToLower(strings.TrimSpace(key))
	if nonSecretKeys[lower] {
		return false
	}
	return strings.HasSuffix(lower, "_key") ||
		strings.Contains(lower, "token") ||
		strings.Contains(lower, "secret")
}

func normalizeGetenv(getenv func(string) string) func(string) string {
	if getenv == nil {
		return os.Getenv
	}
	return getenv
}

func resolveHomeDir(getenv func(string) string, allowUserHomeFallback bool) (string, bool) {
	if h := strings.TrimSpace(getenv("VIBEVALLEY_HOME")); h != "" {
		return filepath.Clean(expandTilde(h, getenv, allowUserHomeFallback)), true
	}
	if h := userHomeDir(getenv, allowUserHomeFallback); h != "" {
		return filepath.Join(h, ".vibevalley"), true
	}
	return ".vibevalley", false
}

func userHomeDir(getenv func(string) string, allowUserHomeFallback bool) string {
	if h := strings.TrimSpace(getenv("HOME")); h != "" {
		return filepath.Clean(h)
	}
	if runtime.GOOS == "windows" {
		if h := strings.TrimSpace(getenv("USERPROFILE")); h != "" {
			return filepath.Clean(h)
		}
	}
	if allowUserHomeFallback {
		if h, err := os.UserHomeDir(); err == nil && strings.TrimSpace(h) != "" {
			return filepath.Clean(h)
		}
	}
	return ""
}

func expandTilde(path string, getenv func(string) string, allowUserHomeFallback bool) string {
	if path == "~" {
		if h := userHomeDir(getenv, allowUserHomeFallback); h != "" {
			return h
		}
		return path
	}
	if strings.HasPrefix(path, "~/") || (runtime.GOOS == "windows" && strings.HasPrefix(path, `~\`)) {
		if h := userHomeDir(getenv, allowUserHomeFallback); h != "" {
			return filepath.Join(h, path[2:])
		}
	}
	return path
}

func defaultWorkRoot(homeDir string, hasHome bool) string {
	if hasHome && homeDir != "" {
		return filepath.Join(homeDir, "work")
	}
	return "work"
}

func defaultMachineID() string {
	if host, err := os.Hostname(); err == nil {
		if trimmed := strings.TrimSpace(host); trimmed != "" {
			return trimmed
		}
	}
	return "vibe-machine"
}

func splitCSV(raw string) []string {
	out := []string{}
	for part := range strings.SplitSeq(raw, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func isKnownDottedKey(key string) bool {
	if topLevelScalars[key] {
		return true
	}
	sec, field, ok := strings.Cut(key, ".")
	if !ok {
		return false
	}
	if sec == "secrets" {
		return field != ""
	}
	fields, exists := sectionFields[sec]
	return exists && fields[field]
}

func isDisabledAddr(addr string) bool {
	return strings.EqualFold(addr, "disabled") ||
		strings.EqualFold(addr, "off") ||
		strings.EqualFold(addr, "none")
}

func validateListenAddr(field, addr string) error {
	_, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("%s %q: %w", field, addr, err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 0 || port > 65535 {
		return fmt.Errorf("%s %q: invalid port %q", field, addr, portStr)
	}
	return nil
}

func validateEndpointURL(field, raw string, allowedSchemes []string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("%s: invalid url: %w", field, err)
	}
	if u.User != nil {
		return fmt.Errorf("%s: url must not embed credentials", field)
	}
	if !slices.Contains(allowedSchemes, u.Scheme) {
		return fmt.Errorf("%s: unsupported url scheme %q", field, u.Scheme)
	}
	if u.Host == "" {
		return fmt.Errorf("%s: url must include host", field)
	}
	return nil
}

func isValidScheme(scheme string) bool {
	for i := 0; i < len(scheme); i++ {
		c := scheme[i]
		isLetter := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
		isDigit := c >= '0' && c <= '9'
		if i == 0 {
			if !isLetter {
				return false
			}
			continue
		}
		if !isLetter && !isDigit && c != '+' && c != '-' && c != '.' {
			return false
		}
	}
	return len(scheme) > 0
}

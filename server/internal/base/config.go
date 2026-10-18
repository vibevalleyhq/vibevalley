package base

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"

	"github.com/spf13/viper"

	"vibevalley/internal/protocol"
)

// The server's configuration: Defaults, then the YAML file, then the environment (VIBEVALLEY_ and the key, dots as
// underscores: session.stall_seconds is VIBEVALLEY_SESSION_STALL_SECONDS). A key not in Defaults is never read from the environment.
type Config struct {
	// VIBEVALLEY_HOME, or ~/.vibevalley; the YAML file is in it, so it cannot be set there.
	Home    string `mapstructure:"-"`
	Version string `mapstructure:"-"`

	// The farm's own folder: projects/<name> are its projects, worktrees/<project>.<session>-<stamp> its sessions' worktrees.
	WorkRoot string `mapstructure:"work_root"`
	// Empty: Home/vibevalley.db; "memory" (":memory:" once loaded) keeps it in memory; a folder holds vibevalley.db.
	DBPath string `mapstructure:"db"`
	Port   int    `mapstructure:"port"`

	// cmd/vibevalley on its own; empty is the agent's default model.
	Agent struct {
		Model string `mapstructure:"model"`
	} `mapstructure:"agent"`
	// Read from DEEPSEEK_API_KEY, AGORA_APP_ID and AGORA_APP_CERTIFICATE, those services' own names. A key saved in the app wins.
	DeepSeek struct {
		APIKey string `mapstructure:"api_key"`
	} `mapstructure:"deepseek"`
	Agora struct {
		AppID          string `mapstructure:"app_id"`
		AppCertificate string `mapstructure:"app_certificate"`
	} `mapstructure:"agora"`
	Voice struct {
		Model string `mapstructure:"model"`
		ID    string `mapstructure:"id"`
		Line  struct {
			// 0: a free port.
			Port int `mapstructure:"port"`
			// Where Agora reaches the line (a tunnel), without the trailing slash.
			URL string `mapstructure:"url"`
		} `mapstructure:"line"`
	} `mapstructure:"voice"`
	Lan struct {
		// 0: a free port.
		Port int `mapstructure:"port"`
	} `mapstructure:"lan"`
	// Commits by these emails count as yours too; in the environment, comma-separated.
	GitEmails []string `mapstructure:"git_emails"`
	// The tokei binary; empty: found on PATH.
	Tokei     string  `mapstructure:"tokei"`
	CNYPerUSD float64 `mapstructure:"cny_per_usd"`
	Patrol    struct {
		// 0 or less: no patrol.
		HeartbeatMinutes float64 `mapstructure:"heartbeat_minutes"`
	} `mapstructure:"patrol"`
	Schedule struct {
		// 0 or less: looked at every millisecond.
		TickMs float64 `mapstructure:"tick_ms"`
	} `mapstructure:"schedule"`
	Session struct {
		// Quiet this long, a session is shown as stuck.
		StallSeconds float64 `mapstructure:"stall_seconds"`
		// The steps of a session gone this long are deleted (its head stays); 0 or less keeps them.
		TrajectoryDays int `mapstructure:"trajectory_days"`
	} `mapstructure:"session"`
	Project struct {
		// Sessions at once in one project.
		MaxSessions         int `mapstructure:"max_sessions"`
		CheckTimeoutSeconds int `mapstructure:"check_timeout_seconds"`
	} `mapstructure:"project"`
	GitHub struct {
		PRProjects    []string `mapstructure:"pr_projects"`
		PRPollSeconds int      `mapstructure:"pr_poll_seconds"`
	} `mapstructure:"github"`
	Chat struct {
		NoticeBatchMs int `mapstructure:"notice_batch_ms"`
		RetryWakeMs   int `mapstructure:"retry_wake_ms"`
	} `mapstructure:"chat"`
}

func Defaults() Config {
	home, _ := os.UserHomeDir()
	var c Config
	c.Home = filepath.Join(home, ".vibevalley")
	c.Version = "0.1.0"
	c.WorkRoot = filepath.Join(home, "vibevalley-dev")
	c.Port = 8787
	c.Voice.Line.Port = 8788
	c.Lan.Port = 8790
	c.GitEmails = []string{}
	c.CNYPerUSD = 7.2
	c.Patrol.HeartbeatMinutes = 10
	c.Schedule.TickMs = 20_000
	c.Session.StallSeconds = 240
	c.GitHub.PRProjects = []string{}
	c.GitHub.PRPollSeconds = 180
	c.Project.MaxSessions = 3
	c.Project.CheckTimeoutSeconds = 1200
	c.Session.TrajectoryDays = 30
	c.Chat.NoticeBatchMs = protocol.NoticeBatchMs
	c.Chat.RetryWakeMs = 3_000
	return c
}

// The main API and its MCP endpoint share a fixed local identity; remote devices use the separate yard gate.
func (c Config) ServerAddress() string {
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(c.Port))
}

// file: the YAML to read, which must be there; empty is Home/vibevalley.yaml, read if it is there.
func LoadConfig(file string) (Config, error) {
	c := Defaults()
	if v := os.Getenv("VIBEVALLEY_HOME"); v != "" {
		c.Home = v
	}
	v := viper.New()
	v.SetEnvPrefix("VIBEVALLEY")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()
	setDefaults(v, "", reflect.ValueOf(c))
	for key, name := range map[string]string{"deepseek.api_key": "DEEPSEEK_API_KEY", "agora.app_id": "AGORA_APP_ID", "agora.app_certificate": "AGORA_APP_CERTIFICATE"} {
		if err := v.BindEnv(key, name); err != nil {
			return Config{}, err
		}
	}
	optional := file == ""
	if optional {
		file = filepath.Join(c.Home, "vibevalley.yaml")
	}
	v.SetConfigFile(file)
	v.SetConfigType("yaml")
	if err := v.ReadInConfig(); err != nil && !(optional && errors.Is(err, fs.ErrNotExist)) {
		return Config{}, fmt.Errorf("%s: %w", file, err)
	}
	if err := v.Unmarshal(&c); err != nil {
		return Config{}, fmt.Errorf("%s: %w", file, err)
	}
	for name, port := range map[string]int{"port": c.Port, "voice.line.port": c.Voice.Line.Port, "lan.port": c.Lan.Port} {
		if port < 0 || port > 65535 {
			return Config{}, fmt.Errorf("%s: %s 不是端口：%d", file, name, port)
		}
	}
	if c.GitHub.PRPollSeconds <= 0 {
		return Config{}, fmt.Errorf("github.pr_poll_seconds 必须大于 0")
	}
	c.WorkRoot, c.Tokei = expandHome(c.WorkRoot), expandHome(c.Tokei)
	c.DBPath = dbPathFrom(expandHome(c.DBPath))
	return c, nil
}

// Every key gets its default, so that Unmarshal reads it from the environment when the file does not have it.
func setDefaults(v *viper.Viper, prefix string, value reflect.Value) {
	t := value.Type()
	for i := range t.NumField() {
		tag := t.Field(i).Tag.Get("mapstructure")
		if tag == "-" || tag == "" {
			continue
		}
		key := prefix + tag
		if f := value.Field(i); f.Kind() == reflect.Struct {
			setDefaults(v, key+".", f)
		} else {
			v.SetDefault(key, f.Interface())
		}
	}
}

func expandHome(path string) string {
	if rest, ok := strings.CutPrefix(path, "~/"); ok {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, rest)
	}
	return path
}

const dbFile = "vibevalley.db"

// DBPath, or vibevalley.db in the home when it is not set.
func (c Config) DB() string {
	if c.DBPath == "" {
		return filepath.Join(c.Home, dbFile)
	}
	return c.DBPath
}

func dbPathFrom(v string) string {
	switch {
	case v == "":
		return ""
	case v == "memory":
		return ":memory:"
	}
	if info, err := os.Stat(v); err == nil && info.IsDir() {
		return filepath.Join(v, dbFile)
	}
	return v
}

// Where the projects are: each folder in it is one.
func (c Config) ProjectsDir() string { return filepath.Join(c.WorkRoot, "projects") }

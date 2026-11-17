package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/vibevalleyhq/vibevalley/internal/config"
)

const vibeVersion = "0.1.0-dev"

type resolvedEnv struct {
	HomeDir      string
	ServerURL    string
	ServerSource string
	Token        string
	TokenSource  string
	Config       *config.AppConfig
}

type appRuntime struct {
	getenv     func(string) string
	stdin      io.Reader
	stdout     io.Writer
	stderr     io.Writer
	httpClient *http.Client

	configFile string
	serverFlag string
	tokenFlag  string
	jsonOut    bool
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Stderr, os.Getenv, nil); err != nil {
		fmt.Fprintf(os.Stderr, "vibe: %v\n", err)
		os.Exit(1)
	}
}

func run(
	ctx context.Context,
	args []string,
	stdin io.Reader,
	stdout, stderr io.Writer,
	getenv func(string) string,
	httpClient *http.Client,
) error {
	rt := &appRuntime{
		getenv:     getenv,
		stdin:      stdin,
		stdout:     stdout,
		stderr:     stderr,
		httpClient: httpClient,
	}
	if rt.getenv == nil {
		rt.getenv = os.Getenv
	}
	if rt.stdin == nil {
		rt.stdin = os.Stdin
	}
	if rt.stdout == nil {
		rt.stdout = os.Stdout
	}
	if rt.stderr == nil {
		rt.stderr = os.Stderr
	}
	if rt.httpClient == nil {
		rt.httpClient = &http.Client{Timeout: 30 * time.Second}
	}

	rootCmd := newRootCommand(rt)
	if args == nil {
		args = []string{}
	}
	rootCmd.SetArgs(args)
	err := rootCmd.ExecuteContext(ctx)
	if err != nil && rt.jsonOut {
		rt.writeJSONError(err)
	}
	return err
}

func newRootCommand(rt *appRuntime) *cobra.Command {
	rootCmd := &cobra.Command{
		Use:           "vibe",
		Short:         "VibeValley domain command-line interface",
		Version:       vibeVersion,
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	rootCmd.SetOut(rt.stdout)
	rootCmd.SetErr(rt.stderr)
	rootCmd.SetVersionTemplate("vibe {{.Version}}\n")

	pflags := rootCmd.PersistentFlags()
	pflags.StringVarP(&rt.configFile, "config", "c", "", "path to vibevalley.yaml config file (or VIBE_CONFIG)")
	pflags.StringVar(&rt.serverFlag, "server", "", "control-plane server URL")
	pflags.StringVar(&rt.tokenFlag, "token", "", "bearer authentication token")
	pflags.BoolVar(&rt.jsonOut, "json", false, "output machine-readable JSON")

	versionCmd := &cobra.Command{
		Use:   "version",
		Short: "Print vibe CLI version",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return rt.writeOutput(
				map[string]string{"name": "vibe", "version": vibeVersion},
				func() string { return "vibe " + vibeVersion },
			)
		},
	}

	rootCmd.AddCommand(
		newIssueCommand(rt),
		newChannelCommand(rt),
		newPKMCommand(rt),
		newAuthCommand(rt),
		newDoctorCommand(rt),
		newAppCommand(rt),
		newChatCommand(rt),
		versionCmd,
	)
	return rootCmd
}

func (rt *appRuntime) resolve() (resolvedEnv, error) {
	cfg, _, err := config.Load(config.LoadOptions{
		ConfigFile: rt.configFile,
		Getenv:     rt.getenv,
	})
	if err != nil {
		return resolvedEnv{}, err
	}

	homeDir := cfg.HomeDir
	serverURL, serverSrc := discoverServerURL(rt.serverFlag, rt.getenv, homeDir, cfg)
	token, tokenSrc := discoverToken(rt.tokenFlag, rt.getenv, homeDir, serverURL)

	return resolvedEnv{
		HomeDir:      homeDir,
		ServerURL:    serverURL,
		ServerSource: serverSrc,
		Token:        token,
		TokenSource:  tokenSrc,
		Config:       cfg,
	}, nil
}

func (rt *appRuntime) newClient() (*Client, resolvedEnv, error) {
	env, err := rt.resolve()
	if err != nil {
		return nil, resolvedEnv{}, err
	}
	return &Client{
		BaseURL: env.ServerURL,
		Token:   env.Token,
		HTTP:    rt.httpClient,
	}, env, nil
}

func (rt *appRuntime) writeJSON(v any) error {
	if raw, ok := v.(json.RawMessage); ok && len(bytes.TrimSpace(raw)) > 0 {
		var buf bytes.Buffer
		if err := json.Indent(&buf, bytes.TrimSpace(raw), "", "  "); err == nil {
			buf.WriteByte('\n')
			_, wErr := rt.stdout.Write(buf.Bytes())
			return wErr
		}
	}
	enc := json.NewEncoder(rt.stdout)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func (rt *appRuntime) writeOutput(jsonVal any, textFn func() string) error {
	if rt.jsonOut {
		return rt.writeJSON(jsonVal)
	}
	text := strings.TrimRight(textFn(), "\n")
	if text == "" {
		return nil
	}
	_, err := fmt.Fprintln(rt.stdout, text)
	return err
}

func (rt *appRuntime) writeJSONError(err error) {
	payload := map[string]any{"message": err.Error()}
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		payload["bizCode"] = apiErr.BizCode
		payload["status"] = apiErr.HTTPStatus
		if apiErr.Op != "" {
			payload["op"] = apiErr.Op
		}
		if apiErr.Message != "" {
			payload["message"] = apiErr.Message
		}
		if apiErr.ErrorDetail != nil {
			payload["detail"] = apiErr.ErrorDetail
		}
	}
	b, mErr := json.Marshal(map[string]any{"error": payload})
	if mErr == nil {
		_, _ = fmt.Fprintf(rt.stderr, "%s\n", b)
	}
}

func (rt *appRuntime) readAllStdin() (string, error) {
	if rt.stdin == nil {
		return "", nil
	}
	if f, ok := rt.stdin.(*os.File); ok {
		if info, err := f.Stat(); err == nil && (info.Mode()&os.ModeCharDevice) != 0 {
			return "", nil
		}
	}
	b, err := io.ReadAll(io.LimitReader(rt.stdin, 2<<20))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

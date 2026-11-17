package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

type desktopStatusView struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Channel string `json:"channel"`
	Server  string `json:"server,omitempty"`
}

type bridgeSocketRequest struct {
	ID    int64  `json:"id"`
	Call  string `json:"call"`
	Input any    `json:"input,omitempty"`
}

type bridgeSocketResponse struct {
	ID     int64           `json:"id"`
	OK     bool            `json:"ok"`
	Output json.RawMessage `json:"output,omitempty"`
	Error  string          `json:"error,omitempty"`
}

func desktopSocketPath(rt *appRuntime, homeDir string) string {
	if rt.getenv != nil {
		if explicit := strings.TrimSpace(rt.getenv("VIBEVALLEY_DESKTOP_SOCKET")); explicit != "" {
			return explicit
		}
	}
	return filepath.Join(homeDir, "desktop.sock")
}

func callDesktopSocket(ctx context.Context, sockPath, method string, input any, dst any) (json.RawMessage, error) {
	dialer := net.Dialer{Timeout: 3 * time.Second}
	conn, err := dialer.DialContext(ctx, "unix", sockPath)
	if err != nil {
		return nil, fmt.Errorf("desktop app not running (%s): %w", sockPath, err)
	}
	defer conn.Close()

	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	}

	req := bridgeSocketRequest{
		ID:    1,
		Call:  method,
		Input: input,
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	if _, err := conn.Write(append(payload, '\n')); err != nil {
		return nil, fmt.Errorf("desktop control write: %w", err)
	}

	reader := bufio.NewReader(conn)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return nil, fmt.Errorf("desktop control read: %w", err)
	}
	var resp bridgeSocketResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, fmt.Errorf("desktop control decode: %w", err)
	}
	if !resp.OK {
		if resp.Error != "" {
			return nil, errors.New(resp.Error)
		}
		return nil, errors.New("desktop control call failed")
	}
	if dst != nil && len(resp.Output) > 0 {
		if err := json.Unmarshal(resp.Output, dst); err != nil {
			return nil, fmt.Errorf("desktop control output decode: %w", err)
		}
	}
	return resp.Output, nil
}

func newAppCommand(rt *appRuntime) *cobra.Command {
	appCmd := &cobra.Command{
		Use:   "app",
		Short: "Inspect and control the local VibeValley desktop app",
	}

	statusCmd := &cobra.Command{
		Use:   "status",
		Short: "Show running VibeValley desktop app status",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			env, err := rt.resolve()
			if err != nil {
				return err
			}
			sock := desktopSocketPath(rt, env.HomeDir)
			var status desktopStatusView
			raw, err := callDesktopSocket(cmd.Context(), sock, "status", nil, &status)
			if err != nil {
				return err
			}
			return rt.writeOutput(rawOrValue(raw, status), func() string {
				line := fmt.Sprintf("%s %s (%s)", status.Name, status.Version, status.Channel)
				if status.Server != "" {
					line += "  server=" + status.Server
				}
				return line
			})
		},
	}

	openCmd := &cobra.Command{
		Use:   "open [path]",
		Short: "Open a workbench route inside the desktop app",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			where := "/"
			if len(args) > 0 && strings.TrimSpace(args[0]) != "" {
				where = strings.TrimSpace(args[0])
				if !strings.HasPrefix(where, "/") {
					where = "/" + where
				}
			}
			env, err := rt.resolve()
			if err != nil {
				return err
			}
			sock := desktopSocketPath(rt, env.HomeDir)
			if _, err := callDesktopSocket(cmd.Context(), sock, "open", where, nil); err != nil {
				return err
			}
			return rt.writeOutput(
				map[string]any{"opened": where},
				func() string { return "opened " + where },
			)
		},
	}

	appCmd.AddCommand(statusCmd, openCmd)
	return appCmd
}

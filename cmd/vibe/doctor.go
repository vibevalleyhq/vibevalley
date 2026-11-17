package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/spf13/cobra"
)

type doctorCheck struct {
	Check  string `json:"check"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail,omitempty"`
	Data   any    `json:"data,omitempty"`
}

var knownAgentBinaries = []string{
	"claude",
	"codex",
	"opencode",
	"grok",
	"kimi",
	"codebuddy",
	"qwen",
	"qoder",
	"gemini",
}

func newDoctorCommand(rt *appRuntime) *cobra.Command {
	return &cobra.Command{
		Use:   "doctor",
		Short: "Verify home directory, server discovery, /healthz, git, and agent runtimes on PATH",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			client, env, err := rt.newClient()
			if err != nil {
				return err
			}

			checks := make([]doctorCheck, 0, 5)
			allOK := true

			// 1. Home directory check
			homeInfo, homeErr := os.Stat(env.HomeDir)
			switch {
			case homeErr == nil && homeInfo.IsDir():
				checks = append(checks, doctorCheck{
					Check:  "home",
					OK:     true,
					Detail: env.HomeDir,
					Data:   map[string]any{"path": env.HomeDir, "exists": true},
				})
			case homeErr == nil:
				allOK = false
				checks = append(checks, doctorCheck{
					Check:  "home",
					OK:     false,
					Detail: fmt.Sprintf("%s exists but is not a directory", env.HomeDir),
				})
			default:
				checks = append(checks, doctorCheck{
					Check:  "home",
					OK:     true,
					Detail: fmt.Sprintf("%s (not initialized yet)", env.HomeDir),
					Data:   map[string]any{"path": env.HomeDir, "exists": false},
				})
			}

			// 2. server.json discovery check
			srvInfo, srvPresent, srvErr := readServerJSON(env.HomeDir)
			switch {
			case !srvPresent:
				checks = append(checks, doctorCheck{
					Check:  "server.json",
					OK:     true,
					Detail: fmt.Sprintf("absent (using %s from %s)", env.ServerURL, env.ServerSource),
					Data:   map[string]any{"present": false, "url": env.ServerURL, "source": env.ServerSource},
				})
			case srvErr != nil:
				allOK = false
				checks = append(checks, doctorCheck{
					Check:  "server.json",
					OK:     false,
					Detail: fmt.Sprintf("invalid %s: %v", serverJSONPath(env.HomeDir), srvErr),
				})
			default:
				checks = append(checks, doctorCheck{
					Check:  "server.json",
					OK:     true,
					Detail: fmt.Sprintf("%s (pid=%d)", srvInfo.URL, srvInfo.PID),
					Data:   srvInfo,
				})
			}

			// 3. /healthz reachability check
			healthRaw, healthErr := client.Healthz(cmd.Context())
			if healthErr != nil {
				allOK = false
				checks = append(checks, doctorCheck{
					Check:  "healthz",
					OK:     false,
					Detail: fmt.Sprintf("%s unreachable: %v", env.ServerURL, healthErr),
				})
			} else {
				var decoded any
				_ = json.Unmarshal(healthRaw, &decoded)
				checks = append(checks, doctorCheck{
					Check:  "healthz",
					OK:     true,
					Detail: fmt.Sprintf("%s ok", env.ServerURL),
					Data:   decoded,
				})
			}

			// 4. git on PATH
			gitPath, gitErr := exec.LookPath("git")
			if gitErr != nil {
				allOK = false
				checks = append(checks, doctorCheck{
					Check:  "git",
					OK:     false,
					Detail: "git not found on PATH",
				})
			} else {
				checks = append(checks, doctorCheck{
					Check:  "git",
					OK:     true,
					Detail: gitPath,
					Data:   map[string]string{"path": gitPath},
				})
			}

			// 5. CLI agents on PATH
			foundAgents := map[string]string{}
			for _, bin := range knownAgentBinaries {
				if p, lookErr := exec.LookPath(bin); lookErr == nil {
					foundAgents[bin] = p
				}
			}
			agentNames := make([]string, 0, len(foundAgents))
			for _, bin := range knownAgentBinaries {
				if _, ok := foundAgents[bin]; ok {
					agentNames = append(agentNames, bin)
				}
			}
			agentDetail := "none detected on PATH"
			if len(agentNames) > 0 {
				agentDetail = strings.Join(agentNames, ", ")
			}
			checks = append(checks, doctorCheck{
				Check:  "agents",
				OK:     true,
				Detail: agentDetail,
				Data:   foundAgents,
			})

			report := map[string]any{
				"ok":     allOK,
				"server": env.ServerURL,
				"home":   env.HomeDir,
				"checks": checks,
			}
			if err := rt.writeOutput(report, func() string {
				lines := make([]string, 0, len(checks))
				for _, c := range checks {
					mark := "OK"
					if !c.OK {
						mark = "FAIL"
					}
					lines = append(lines, fmt.Sprintf("[%s] %-12s %s", mark, c.Check, c.Detail))
				}
				return strings.Join(lines, "\n")
			}); err != nil {
				return err
			}
			if !allOK {
				return errors.New("doctor checks failed")
			}
			return nil
		},
	}
}

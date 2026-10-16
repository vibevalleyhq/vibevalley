package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"

	"vibevalley/pkg/smith/oar"
)

type authStatusReport struct {
	RuntimeID    string                    `json:"runtimeId"`
	Installation *oar.InstallationSnapshot `json:"installation,omitempty"`
	Status       *oar.AuthStatus           `json:"status,omitempty"`
	Unsupported  string                    `json:"unsupported,omitempty"`
	Error        string                    `json:"error,omitempty"`
}

type loginReport struct {
	RuntimeID    string                    `json:"runtimeId"`
	Installation *oar.InstallationSnapshot `json:"installation,omitempty"`
	Result       *oar.LoginResult          `json:"result,omitempty"`
	Unsupported  string                    `json:"unsupported,omitempty"`
	Error        string                    `json:"error,omitempty"`
}

func readAuthStatus(ctx context.Context, runtime oar.Runtime, timeout int64) authStatusReport {
	report := authStatusReport{RuntimeID: runtime.ID}
	if runtime.Installation == nil {
		report.Unsupported = runtime.ID + " exposes no installation probe"
		return report
	}
	installation, err := runtime.Installation(ctx)
	if err != nil {
		return authStatusReport{RuntimeID: runtime.ID, Error: err.Error()}
	}
	if installation.Kind != "available" {
		report.Installation = &installation
		return report
	}
	if runtime.AuthStatus == nil {
		report.Unsupported = runtime.ID + " exposes no sign-in status query"
		return report
	}
	status, err := runtime.AuthStatus(ctx, installation.Available, oar.AuthStatusOptions{Timeout: millis(timeout)})
	if err != nil {
		return authStatusReport{RuntimeID: runtime.ID, Error: err.Error()}
	}
	report.Status = &status
	return report
}

func runLogin(ctx context.Context, runtime oar.Runtime, interaction oar.ProviderLoginInteraction, timeout int64) loginReport {
	report := loginReport{RuntimeID: runtime.ID}
	if runtime.Installation == nil {
		report.Unsupported = runtime.ID + " exposes no installation probe"
		return report
	}
	installation, err := runtime.Installation(ctx)
	if err != nil {
		return loginReport{RuntimeID: runtime.ID, Error: err.Error()}
	}
	if installation.Kind != "available" {
		report.Installation = &installation
		return report
	}
	if runtime.Login == nil {
		report.Unsupported = runtime.ID + " has no login oar can drive"
		return report
	}
	result, err := runtime.Login(ctx, installation.Available, interaction, oar.LoginOptions{Timeout: millis(timeout)})
	if err != nil {
		return loginReport{RuntimeID: runtime.ID, Error: err.Error()}
	}
	report.Result = &result
	return report
}

func accountLabel(account *oar.LoginAccount) string {
	if account == nil {
		return ""
	}
	var notes []string
	for _, note := range []string{account.Method, account.Plan} {
		if note != "" {
			notes = append(notes, note)
		}
	}
	if account.ExpiresAt != "" {
		notes = append(notes, "expires "+account.ExpiresAt)
	}
	label := ""
	if account.Email != "" {
		label = " as " + account.Email
	}
	if len(notes) > 0 {
		label += " (" + strings.Join(notes, ", ") + ")"
	}
	return label
}

func withDetail(text, detail string) string {
	if detail == "" {
		return text
	}
	return text + " (" + detail + ")"
}

func renderAuthStatus(report authStatusReport) string {
	switch {
	case report.Error != "":
		return report.RuntimeID + "\terror: " + report.Error
	case report.Installation != nil:
		return fmt.Sprintf("%s\tnot available (%s)", report.RuntimeID, report.Installation.Kind)
	case report.Status == nil:
		if report.Unsupported == "" {
			return report.RuntimeID + "\tno status"
		}
		return report.RuntimeID + "\t" + report.Unsupported
	}
	switch report.Status.Kind {
	case "logged_in":
		return report.RuntimeID + "\tlogged in" + accountLabel(report.Status.Account)
	case "logged_out":
		return report.RuntimeID + "\tlogged out"
	}
	return withDetail(report.RuntimeID+"\tstatus unknown", report.Status.Detail)
}

func renderLoginReport(report loginReport) string {
	switch {
	case report.Error != "":
		return report.RuntimeID + "\terror: " + report.Error
	case report.Installation != nil:
		return fmt.Sprintf("%s\tnot available (%s)", report.RuntimeID, report.Installation.Kind)
	case report.Result == nil:
		if report.Unsupported == "" {
			return report.RuntimeID + "\tno login"
		}
		return report.RuntimeID + "\t" + report.Unsupported
	}
	result := report.Result
	switch result.Kind {
	case "logged_in":
		return report.RuntimeID + "\tlogged in" + accountLabel(result.Account)
	case "cancelled":
		return report.RuntimeID + "\tlogin cancelled"
	case "failed":
		return withDetail(report.RuntimeID+"\tlogin failed: "+result.Reason, result.Detail)
	}
	return withDetail(report.RuntimeID+"\tlogin unsupported: "+result.Reason, result.Detail)
}

// loginExitCode: 0 logged in, 130 cancelled (as for Ctrl-C), 1 otherwise.
func loginExitCode(report loginReport) int {
	if report.Result != nil && report.Result.Kind == "logged_in" {
		return 0
	}
	if report.Result != nil && report.Result.Kind == "cancelled" {
		return 130
	}
	return 1
}

// renderLoginEvent is a login event as terminal lines.
func renderLoginEvent(event oar.ProviderLoginEvent) []string {
	switch event.Kind {
	case "auth_url":
		instructions := event.Instructions
		if instructions == "" {
			instructions = "Open this URL to sign in:"
		}
		return []string{instructions, "  " + event.URL}
	case "device_code":
		expires := ""
		if event.ExpiresInSeconds != nil {
			expires = fmt.Sprintf(" (expires in %d s)", *event.ExpiresInSeconds)
		}
		return []string{fmt.Sprintf("Open %s and enter this code%s:", event.VerificationURI, expires), "  " + event.UserCode}
	}
	return []string{event.Message}
}

func promptText(prompt oar.ProviderLoginPrompt) string {
	if prompt.Kind != "select" {
		if prompt.Placeholder == "" {
			return prompt.Message + ": "
		}
		return fmt.Sprintf("%s (%s): ", prompt.Message, prompt.Placeholder)
	}
	lines := []string{prompt.Message}
	for i, option := range prompt.Options {
		line := fmt.Sprintf("  %d. %s", i+1, option.Label)
		if option.Description != "" {
			line += " - " + option.Description
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n") + "\nChoose a number: "
}

// selectAnswer: a select answer is an option id; a person types its number or the id itself.
func selectAnswer(prompt oar.ProviderLoginPrompt, typed string) string {
	if prompt.Kind != "select" {
		return typed
	}
	answer := strings.TrimSpace(typed)
	if index, err := strconv.Atoi(answer); err == nil && index >= 1 && index <= len(prompt.Options) {
		return prompt.Options[index-1].ID
	}
	return answer
}

// hidesInput: a pasted code or a secret is typed blind.
func hidesInput(prompt oar.ProviderLoginPrompt) bool {
	return prompt.Kind == "manual_code" || prompt.Kind == "secret"
}

func isTerminal(file *os.File) bool {
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

// setEcho turns the terminal's echo on or off (stty), for blind input.
func setEcho(on bool) {
	mode := "-echo"
	if on {
		mode = "echo"
	}
	cmd := exec.Command("stty", mode)
	cmd.Stdin = os.Stdin
	_ = cmd.Run()
}

// terminalInteraction prints events and reads prompts from stdin; with
// json, events and prompts are JSON lines on stdout.
func (c *cli) terminalInteraction(json bool) oar.ProviderLoginInteraction {
	visible := c.stdout
	if json {
		visible = c.stderr
	}
	var mu sync.Mutex
	lines := make(chan string)
	ended := make(chan struct{})
	var startOnce sync.Once
	start := func() {
		go func() {
			reader := bufio.NewReader(c.stdin)
			for {
				line, err := reader.ReadString('\n')
				if line != "" || err == nil {
					lines <- strings.TrimRight(line, "\r\n")
				}
				if err != nil {
					close(ended)
					return
				}
			}
		}()
	}
	return oar.ProviderLoginInteraction{
		OnEvent: func(event oar.ProviderLoginEvent) {
			mu.Lock()
			defer mu.Unlock()
			if json {
				fmt.Fprintln(c.stdout, compact(map[string]any{"event": event}))
				return
			}
			fmt.Fprintln(c.stdout, strings.Join(renderLoginEvent(event), "\n"))
		},
		Prompt: func(ctx context.Context, prompt oar.ProviderLoginPrompt) (string, error) {
			startOnce.Do(start)
			mu.Lock()
			if json {
				fmt.Fprintln(c.stdout, compact(map[string]any{"prompt": prompt}))
			}
			hidden := hidesInput(prompt)
			if !json {
				fmt.Fprint(visible, promptText(prompt))
			}
			mu.Unlock()
			terminal := c.stdin == os.Stdin && isTerminal(os.Stdin)
			if hidden && terminal {
				setEcho(false)
				defer func() {
					setEcho(true)
					fmt.Fprintln(visible)
				}()
			}
			select {
			case line := <-lines:
				if !hidden && !terminal {
					fmt.Fprintln(visible)
				}
				return selectAnswer(prompt, line), nil
			case <-ended:
				return "", errors.New("input ended before an answer")
			case <-ctx.Done():
				return "", ctx.Err()
			}
		},
	}
}

func (c *cli) login(ctx context.Context, raw []string) error {
	parsed, err := parseArgs(raw, []string{"timeout"}, []string{"status", "json"})
	if err != nil {
		return err
	}
	timeout, _, err := parsed.positiveMs("timeout")
	if err != nil {
		fmt.Fprintln(c.stderr, err.Error())
		c.exitCode = 1
		return nil
	}
	id, named := parsed.arg(0)
	if parsed.flag("status") {
		runtimes, err := c.selected(id)
		if err != nil {
			return err
		}
		reports := make([]authStatusReport, 0, len(runtimes))
		for _, report := range readEach(runtimes, func(runtime oar.Runtime) (any, error) {
			return readAuthStatus(ctx, runtime, timeout), nil
		}) {
			typed := report.(authStatusReport)
			if typed.Error != "" {
				c.exitCode = 1
			}
			reports = append(reports, typed)
		}
		if parsed.flag("json") {
			fmt.Fprint(c.stdout, pretty(reports))
			return nil
		}
		for _, report := range reports {
			fmt.Fprintln(c.stdout, renderAuthStatus(report))
		}
		return nil
	}
	if !named || id == "all" {
		fmt.Fprintln(c.stderr, "name one runtime to sign in, e.g. `oar login claude`; `oar login --status` reports them all")
		c.exitCode = 1
		return nil
	}
	runtime, err := c.registry.Require(id)
	if err != nil {
		return err
	}
	loginCtx, cancel := signal.NotifyContext(ctx, os.Interrupt)
	defer cancel()
	report := runLogin(loginCtx, runtime, c.terminalInteraction(parsed.flag("json")), timeout)
	c.exitCode = loginExitCode(report)
	if parsed.flag("json") {
		fmt.Fprintln(c.stdout, compact(map[string]any{"result": report}))
	} else {
		fmt.Fprintln(c.stdout, renderLoginReport(report))
	}
	return nil
}

var _ io.Reader = os.Stdin

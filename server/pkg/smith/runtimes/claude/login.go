package claude

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// `claude auth login` over pipes (2.1.288, login.ts). It prints, on stdout:
//
//	Opening browser to sign in…
//	If the browser didn't open, visit: <url>      (an OSC 8 hyperlink from 2.1.202)
//	Paste code here if prompted >                 (no newline)
//
// and races two ends: the browser's redirect to its localhost listener, and
// a code#state line on stdin, which the page behind <url> shows after the
// sign-in. A malformed line prints `Invalid code. Please make sure the full
// code was copied.` to stderr and reading goes on. It ends with `Login
// successful.` (exit 0, after a few seconds of telemetry flushing) or a
// failure on stderr (exit 1): `Login failed: <message>`, or a message of its
// own. It has no deadline of its own. Reading a pasted code arrived in
// 2.1.126; `auth login` itself in 2.1.41.
const (
	pasteFloor   = "2.1.126"
	loginTimeout = 15 * time.Minute
)

var (
	urlLine     = regexp.MustCompile(`If the browser didn't open, visit:\s*(\S+)`)
	pastePrompt = regexp.MustCompile(`Paste code here if prompted\s*>`)
	// At the start of a stderr line only: `Login failed: Invalid code verifier` is a failure, not a retry.
	invalidCode  = regexp.MustCompile(`^Invalid code\b`)
	loginSuccess = regexp.MustCompile(`Login successful\b`)
	loginFailed  = regexp.MustCompile(`Login failed:\s*(.*)$`)
	whitespace   = regexp.MustCompile(`\s+`)
)

// loginFlow is the login's state, shared by the two stream readers and the
// prompts; guarded by mu, which is never held across a call to the caller.
type loginFlow struct {
	mu      sync.Mutex
	secrets shared.LoginSecrets
	urlSent bool
	// The paste prompt was seen and the caller asked once; later asks follow an Invalid code.
	pasteOffered bool
	// One question to the caller at a time.
	promptOpen bool
	// The login has ended; a late answer is dropped, never written.
	settled bool
	// claude printed Login successful.: the new login is stored, whatever ends the process.
	reportedSuccess bool
	// The message of a Login failed: line.
	failure    string
	hasFailure bool
	// The last stderr line, claude's reason when it fails in words of its own.
	lastStderr string
}

func (f *loginFlow) line(text string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.secrets.Line(text)
}

// confirmed: the status decides once claude has exited 0 or reported
// success. A query that cannot answer (it failed, or the caller cancelled)
// leaves claude's own report: a success it printed is logged_in, an exit 0
// without one is not.
func confirmed(ctx context.Context, installation oar.AvailableInstallation, reportedSuccess bool) oar.LoginResult {
	var status *oar.AuthStatus
	if ctx.Err() == nil {
		read := readClaudeAuthStatus(ctx, installation, oar.AuthStatusOptions{}).Status
		status = &read
	}
	if status != nil && status.Kind == "logged_in" {
		return oar.LoginResult{Kind: "logged_in", Account: status.Account}
	}
	if status != nil && status.Kind == "logged_out" {
		return oar.LoginResult{Kind: "failed", Reason: "not_logged_in", Detail: "claude auth login reported success, yet claude auth status says logged out"}
	}
	if reportedSuccess {
		return oar.LoginResult{Kind: "logged_in"}
	}
	return oar.LoginResult{Kind: "failed", Reason: "process_failed", Detail: "claude auth login exited 0 without reporting success"}
}

// failedExit is a failed exit, in claude's words where it gave any.
func failedExit(exit shared.LoginProcessExit, flow *loginFlow) oar.LoginResult {
	flow.mu.Lock()
	defer flow.mu.Unlock()
	if exit.Error != "" {
		return oar.LoginResult{Kind: "failed", Reason: "process_failed", Detail: flow.secrets.Line(exit.Error)}
	}
	if flow.hasFailure {
		return oar.LoginResult{Kind: "failed", Reason: "rejected", Detail: flow.secrets.Line(flow.failure)}
	}
	// claude exits 1 for a failure it reports, also in words other than `Login failed:`.
	if exit.ExitCode != nil && *exit.ExitCode == 1 && flow.lastStderr != "" {
		return oar.LoginResult{Kind: "failed", Reason: "rejected", Detail: flow.secrets.Line(flow.lastStderr)}
	}
	if flow.lastStderr != "" {
		return oar.LoginResult{Kind: "failed", Reason: "process_failed", Detail: flow.secrets.Line(flow.lastStderr)}
	}
	ended := ""
	if exit.ExitCode == nil {
		signal := exit.Signal
		if signal == "" {
			signal = "unknown"
		}
		ended = "signal " + signal
	} else {
		ended = fmt.Sprintf("code %d", *exit.ExitCode)
	}
	return oar.LoginResult{Kind: "failed", Reason: "process_failed", Detail: "claude auth login exited with " + ended}
}

func runClaudeLogin(ctx context.Context, installation oar.AvailableInstallation, command string, interaction oar.ProviderLoginInteraction, timeout time.Duration) oar.LoginResult {
	flow := &loginFlow{}
	interactionFailure := make(chan string, 1)
	var child *shared.LoginProcess
	childReady := make(chan struct{})

	// interactionFailed: the caller failed; settled at once, so no answer still in flight reaches claude.
	interactionFailed := func(message string) {
		flow.mu.Lock()
		flow.settled = true
		flow.mu.Unlock()
		select {
		case interactionFailure <- message:
		default:
		}
	}
	var ask func(message string)
	ask = func(message string) {
		flow.mu.Lock()
		if flow.promptOpen || flow.settled {
			flow.mu.Unlock()
			return
		}
		flow.promptOpen = true
		flow.mu.Unlock()
		var answer string
		var err error
		if interaction.Prompt == nil {
			err = fmt.Errorf("no prompt to ask the caller with")
		} else {
			answer, err = interaction.Prompt(ctx, oar.ProviderLoginPrompt{Kind: "manual_code", Message: message, Placeholder: "code#state"})
		}
		flow.mu.Lock()
		flow.promptOpen = false
		flow.mu.Unlock()
		if err != nil {
			// A prompt the caller gave up on because it cancelled is a cancellation, which the bounds report.
			if ctx.Err() == nil {
				interactionFailed(err.Error())
			}
			return
		}
		// The code has no whitespace; a pasted line break must not become a second attempt.
		code := whitespace.ReplaceAllString(answer, "")
		flow.mu.Lock()
		// Read after the wait: the login may have ended while the caller answered.
		if flow.settled {
			flow.mu.Unlock()
			return
		}
		if code == "" {
			flow.mu.Unlock()
			ask("No code was entered. Paste the code shown after signing in")
			return
		}
		// The authorization code is the secret part; the state after # is already in the sign-in URL.
		flow.secrets.Add(code)
		head, _, _ := strings.Cut(code, "#")
		flow.secrets.Add(head)
		flow.mu.Unlock()
		<-childReady
		// Only ever to claude's stdin: never an event, a result or an error.
		child.Write(code + "\n")
	}
	offerPaste := func() {
		flow.mu.Lock()
		offer := !flow.pasteOffered
		flow.pasteOffered = true
		flow.mu.Unlock()
		if offer {
			go ask("Paste the code shown after signing in")
		}
	}

	child = shared.SpawnLoginProcess(command, []string{"auth", "login"}, claudeEnv(), shared.LoginOutputHandlers{
		OnLine: func(line string, stream shared.LoginStream) {
			if match := urlLine.FindStringSubmatch(line); match != nil {
				flow.mu.Lock()
				send := !flow.urlSent
				flow.urlSent = true
				flow.mu.Unlock()
				if send {
					if failure := sendEvent(interaction, oar.ProviderLoginEvent{Kind: "auth_url", URL: match[1], Instructions: "Open this URL and sign in; if the page then shows a code, paste it back."}); failure != "" {
						// A caller that cannot show the URL cannot finish the login.
						interactionFailed(failure)
					}
				}
			}
			if pastePrompt.MatchString(line) {
				offerPaste()
			}
			flow.mu.Lock()
			retry := false
			if stream == shared.LoginStderr {
				flow.lastStderr = line
				retry = invalidCode.MatchString(line)
			}
			// Unanchored: with no echo of the pasted line, claude's next words continue the prompt's line.
			if loginSuccess.MatchString(line) {
				flow.reportedSuccess = true
			}
			if match := loginFailed.FindStringSubmatch(line); match != nil {
				flow.failure, flow.hasFailure = match[1], true
			}
			flow.mu.Unlock()
			if retry {
				go ask("That code was not accepted. Paste the full code shown after signing in")
			}
		},
		OnPartial: func(partial string, _ shared.LoginStream) {
			if pastePrompt.MatchString(partial) {
				offerPaste()
			}
		},
	})
	close(childReady)

	bounds := shared.NewLoginBounds(ctx, timeout)
	defer func() {
		flow.mu.Lock()
		flow.settled = true
		flow.mu.Unlock()
		bounds.Dispose()
	}()
	ending, stop, failure := "", shared.LoginStop(""), ""
	select {
	case <-child.Exited():
		ending = "exit"
	case stop = <-bounds.Stopped:
		ending = "stop"
	case failure = <-interactionFailure:
		ending = "interaction_failed"
	}
	flow.mu.Lock()
	flow.settled = true
	flow.mu.Unlock()
	if ending != "exit" {
		child.Stop()
		<-child.Exited()
	}
	flow.mu.Lock()
	reported := flow.reportedSuccess
	flow.mu.Unlock()
	// After `Login successful.` the new login is stored; a stop or an odd exit while claude flushes does not undo it.
	if reported {
		return confirmed(ctx, installation, true)
	}
	switch ending {
	case "stop":
		return shared.StoppedResult(stop, timeout)
	case "interaction_failed":
		return oar.LoginResult{Kind: "failed", Reason: "interaction_failed", Detail: flow.line(failure)}
	}
	exit := child.Exit()
	if exit.ExitCode != nil && *exit.ExitCode == 0 && exit.Error == "" {
		return confirmed(ctx, installation, false)
	}
	return failedExit(exit, flow)
}

// sendEvent calls the caller's OnEvent; a panic in it is its failure ("" when none).
func sendEvent(interaction oar.ProviderLoginInteraction, event oar.ProviderLoginEvent) (failure string) {
	if interaction.OnEvent == nil {
		return ""
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			failure = fmt.Sprint(recovered)
		}
	}()
	interaction.OnEvent(event)
	return ""
}

// Login signs claude in with `claude auth login`, relaying its URL and
// writing the pasted code to its stdin (claudeLogin).
func Login(ctx context.Context, installation oar.AvailableInstallation, interaction oar.ProviderLoginInteraction, options oar.LoginOptions) (oar.LoginResult, error) {
	target := shared.LoginExecutableOf(installation, "claude", pasteFloor)
	if target.Kind == "settled" {
		return target.Result.LoginResult(), nil
	}
	if ctx.Err() != nil {
		return oar.LoginResult{Kind: "cancelled"}, nil
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = loginTimeout
	}
	return runClaudeLogin(ctx, installation, target.Installation.Command, interaction, timeout), nil
}

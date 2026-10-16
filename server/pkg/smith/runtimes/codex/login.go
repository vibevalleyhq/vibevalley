package codex

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// Codex signs in over its app-server (0.160.0 schema; login.ts), never
// through `codex login`, whose browser and device flows both clear the
// stored credentials before the new sign-in completes:
//
//	→ account/login/start { type: "chatgptDeviceCode" }
//	← { type: "chatgptDeviceCode", loginId, verificationUrl, userCode }
//	← account/login/completed { loginId, success, error }   (notification)
//	→ account/read {}  ← { account: { type, email, planType } | null, ... }
//
// The app-server polls on its own and writes the credential store only once
// the new tokens are exchanged, so a failure, a cancel or the expiry leaves
// the stored login untouched; the code expires after 15 minutes. The
// `chatgptDeviceCode` login type arrived in 0.118.0. Device code sign-in
// must be allowed in the ChatGPT account's security settings (a workspace
// admin's permission for workspace accounts).
const (
	deviceCodeFloor = "0.118.0"
	// Past the code's 15 minutes, so codex reports the expiry itself.
	loginTimeout      = 16 * time.Minute
	statusTimeout     = 20 * time.Second
	statusSource      = "codex login status"
	deviceCodeSetting = "Device code sign-in must be allowed in your ChatGPT security settings (for a workspace account, by its admin)."
)

var (
	loggedInChatGPT = regexp.MustCompile(`Logged in using ChatGPT`)
	loggedInAPIKey  = regexp.MustCompile(`Logged in using an API key`)
	notLoggedIn     = regexp.MustCompile(`(?m)^Not logged in\b`)
	lineSplit       = regexp.MustCompile(`\r?\n`)
)

// projectCodexLoginStatus reads `codex login status`: it prints to stderr
// and exits 0 when logged in (`Logged in using ChatGPT`, or `Logged in using
// an API key - <masked>`), 1 with `Not logged in` when logged out, and 1
// with another message when it cannot tell (an unreadable configuration or
// credential store). exitCode nil is no code (TS null).
func projectCodexLoginStatus(exitCode *int, output string) oar.AuthStatus {
	if exitCode != nil && *exitCode == 0 {
		status := oar.AuthStatus{Kind: "logged_in", Source: statusSource}
		if loggedInChatGPT.MatchString(output) {
			status.Account = &oar.LoginAccount{Method: "chatgpt"}
		} else if loggedInAPIKey.MatchString(output) {
			status.Account = &oar.LoginAccount{Method: "apiKey"}
		}
		return status
	}
	if exitCode != nil && *exitCode == 1 && notLoggedIn.MatchString(output) {
		return oar.AuthStatus{Kind: "logged_out", Source: statusSource}
	}
	lines := lineSplit.Split(strings.TrimSpace(output), -1)
	line := lines[len(lines)-1]
	if line == "" {
		code := "null"
		if exitCode != nil {
			code = fmt.Sprint(*exitCode)
		}
		line = "exit " + code
	}
	secrets := shared.LoginSecrets{}
	return oar.AuthStatus{Kind: "unknown", Detail: secrets.Redact(line), Source: statusSource}
}

// AuthStatus reads codex's sign-in state with `codex login status` (codexAuthStatus).
func AuthStatus(ctx context.Context, installation oar.AvailableInstallation, options oar.AuthStatusOptions) (oar.AuthStatus, error) {
	if installation.Via != "executable" {
		return oar.AuthStatus{Kind: "unknown", Detail: "not a machine-installed executable"}, nil
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = statusTimeout
	}
	result := executable.Run(ctx, installation.Command, []string{"login", "status"}, executable.RunOptions{Timeout: timeout})
	code := result.ExitCode
	if result.OK {
		zero := 0
		code = &zero
	}
	return projectCodexLoginStatus(code, result.Stdout+"\n"+result.Stderr), nil
}

// projectCodexAccount reads `account/read` after the sign-in; nil when codex reports no account.
func projectCodexAccount(result any) *oar.LoginAccount {
	account := jsonx.AsRecord(jsonx.AsRecord(result)["account"])
	if account == nil {
		return nil
	}
	email, _ := trimmedText(account["email"])
	plan, _ := trimmedText(account["planType"])
	method, _ := trimmedText(account["type"])
	return &oar.LoginAccount{Email: email, Plan: plan, Method: method}
}

// loginCompletion is how the sign-in ended: "completed" (params) or "exited".
type loginCompletion struct {
	kind   string
	params jsonx.Record
}

// confirmation is the account read started when codex reports success: the
// login is stored, so its account decides whatever ends the flow.
type confirmation struct {
	done   chan struct{}
	result oar.LoginResult
}

func (c *confirmation) wait() oar.LoginResult {
	<-c.done
	return c.result
}

// loginFlow is the login's state, shared by the line goroutine and the flow; guarded by mu.
type loginFlow struct {
	mu sync.Mutex
	// Set as the start reply is read, before any notification after it.
	loginID    string
	hasLoginID bool
	// Completions read before the start reply, held until its login id is known.
	early    []jsonx.Record
	exited   bool
	exitCode *int
	// Ended: events are no longer shown.
	settled      bool
	confirmation *confirmation
	completion   chan loginCompletion
	completeOnce sync.Once
	secrets      shared.LoginSecrets
}

func (f *loginFlow) line(text string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.secrets.Line(text)
}

func (f *loginFlow) resolve(completion loginCompletion) {
	f.completeOnce.Do(func() { f.completion <- completion })
}

// oursLocked: a completion without a login id, or with this login's.
func (f *loginFlow) oursLocked(params jsonx.Record) bool {
	id, present := params["loginId"]
	return !present || id == nil || (f.hasLoginID && id == f.loginID)
}

// completeLocked takes a completion; a success starts the account read.
func (f *loginFlow) completeLocked(params jsonx.Record, confirm func() oar.LoginResult) {
	if params["success"] == true && f.confirmation == nil {
		started := &confirmation{done: make(chan struct{})}
		f.confirmation = started
		go func() {
			started.result = confirm()
			close(started.done)
		}()
	}
	f.resolve(loginCompletion{kind: "completed", params: params})
}

// readAccount is `account/read` on the same app-server, bounded by the
// status deadline and the caller's cancellation; nil when it gave no answer.
func readAccount(ctx context.Context, client appServerClient) any {
	if ctx.Err() != nil {
		return nil
	}
	bounded, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()
	// A late failure (the app-server stopped) is no answer.
	result, err := client.request(bounded, "account/read", jsonx.Record{}, nil)
	if err != nil {
		return nil
	}
	return result.record
}

// confirmed is the result after codex reported success: logged in, with the account when `account/read` names one.
func confirmed(ctx context.Context, client appServerClient) oar.LoginResult {
	read := readAccount(ctx, client)
	if read == nil {
		return oar.LoginResult{Kind: "logged_in"}
	}
	account := projectCodexAccount(read)
	if account == nil {
		return oar.LoginResult{Kind: "failed", Reason: "not_logged_in", Detail: "codex reported success, yet account/read shows no account"}
	}
	if *account == (oar.LoginAccount{}) {
		return oar.LoginResult{Kind: "logged_in"}
	}
	return oar.LoginResult{Kind: "logged_in", Account: account}
}

func exitDetail(code *int) string {
	if code == nil {
		return "codex app-server exited"
	}
	return fmt.Sprintf("codex app-server exited with code %d", *code)
}

var loginInitialize = jsonx.Record{"clientInfo": jsonx.Record{"name": "oar", "version": "0.0.0"}, "capabilities": jsonx.Record{"experimentalApi": true}}

func runCodexLogin(ctx context.Context, command string, interaction oar.ProviderLoginInteraction, timeout time.Duration) oar.LoginResult {
	inherit := false
	// Its stderr never reaches the host's, and a stop takes its process tree too.
	app := startAppServerClient(command, nil, nil, "", appServerProcessOptions{inheritStderr: &inherit})
	flow := &loginFlow{completion: make(chan loginCompletion, 1)}
	confirm := func() oar.LoginResult { return confirmed(ctx, app) }
	app.onExit(func(code *int) {
		flow.mu.Lock()
		flow.exited, flow.exitCode = true, code
		flow.mu.Unlock()
		flow.resolve(loginCompletion{kind: "exited"})
	})
	_ = app.handle(appServerHandlers{
		onNotification: func(method string, params json.RawMessage) {
			if method != "account/login/completed" {
				return
			}
			record := jsonx.ParseRecord(params)
			flow.mu.Lock()
			defer flow.mu.Unlock()
			if !flow.hasLoginID {
				flow.early = append(flow.early, record)
			} else if flow.oursLocked(record) {
				flow.completeLocked(record, confirm)
			}
		},
		// A login asks the client nothing.
		onServerRequest: func(string, string, json.RawMessage) {},
	})
	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	ended := make(chan oar.LoginResult, 1)
	go func() { ended <- runLoginFlow(runCtx, app, flow, interaction, confirm) }()

	bounds := shared.NewLoginBounds(ctx, timeout)
	defer func() {
		flow.mu.Lock()
		flow.settled = true
		flow.mu.Unlock()
		bounds.Dispose()
		// The pending login lives in the app-server; stopping it (and its tree) ends the polling.
		app.kill()
		<-app.exited()
	}()
	select {
	case result := <-ended:
		flow.mu.Lock()
		flow.settled = true
		flow.mu.Unlock()
		return result
	case stop := <-bounds.Stopped:
		flow.mu.Lock()
		flow.settled = true
		pending := flow.confirmation
		flow.mu.Unlock()
		// Codex reported success before the stop: the login is stored.
		if pending != nil {
			return pending.wait()
		}
		return shared.StoppedResult(stop, timeout)
	}
}

func runLoginFlow(ctx context.Context, app appServerClient, flow *loginFlow, interaction oar.ProviderLoginInteraction, confirm func() oar.LoginResult) oar.LoginResult {
	if err := app.spawned(ctx); err != nil {
		// An executable that cannot run (found, yet not startable) says so in its own words.
		return oar.LoginResult{Kind: "failed", Reason: "process_failed", Detail: flow.line(shared.ErrorMessage(err))}
	}
	failed := func(err error) oar.LoginResult {
		flow.mu.Lock()
		exited, code := flow.exited, flow.exitCode
		flow.mu.Unlock()
		// An exit's error carries the app-server's stderr tail: only the exit is reported, never that tail.
		if !exited {
			return oar.LoginResult{Kind: "failed", Reason: "rejected", Detail: flow.line(shared.ErrorMessage(err))}
		}
		return oar.LoginResult{Kind: "failed", Reason: "process_failed", Detail: exitDetail(code)}
	}
	if _, err := app.request(ctx, "initialize", loginInitialize, nil); err != nil {
		return failed(err)
	}
	app.notify("initialized", jsonx.Record{})
	started, err := app.request(ctx, "account/login/start", jsonx.Record{"type": "chatgptDeviceCode"}, func(outcome rpcOutcome) {
		if outcome.kind != "result" {
			return
		}
		flow.mu.Lock()
		defer flow.mu.Unlock()
		flow.loginID, flow.hasLoginID = trimmedText(outcome.result.record["loginId"])
		early := flow.early
		flow.early = nil
		for _, params := range early {
			if flow.oursLocked(params) {
				flow.completeLocked(params, confirm)
			}
		}
	})
	if err != nil {
		return failed(err)
	}
	verificationURI, hasURI := trimmedText(started.record["verificationUrl"])
	userCode, hasCode := trimmedText(started.record["userCode"])
	flow.mu.Lock()
	hasLoginID := flow.hasLoginID
	early := flow.confirmation
	settled := flow.settled
	flow.mu.Unlock()
	if !hasLoginID || !hasURI || !hasCode {
		return oar.LoginResult{Kind: "failed", Reason: "process_failed", Detail: "codex answered account/login/start without a device code"}
	}
	// A success that came before the start reply is final: nothing left to show the person.
	if early != nil {
		return early.wait()
	}
	if !settled {
		if refused := showDeviceCode(interaction, userCode, verificationURI); refused != nil {
			// A caller that cannot show the code cannot finish the login.
			return oar.LoginResult{Kind: "failed", Reason: "interaction_failed", Detail: flow.line(refused.Error())}
		}
	}
	var done loginCompletion
	select {
	case done = <-flow.completion:
	case <-ctx.Done():
		return oar.LoginResult{Kind: "cancelled"}
	}
	flow.mu.Lock()
	pending := flow.confirmation
	code := flow.exitCode
	flow.mu.Unlock()
	if pending != nil {
		return pending.wait()
	}
	if done.kind == "exited" {
		return oar.LoginResult{Kind: "failed", Reason: "process_failed", Detail: exitDetail(code) + " before the sign-in completed"}
	}
	reason, ok := trimmedText(done.params["error"])
	if !ok {
		reason = "codex reported that the sign-in failed"
	}
	return oar.LoginResult{Kind: "failed", Reason: "rejected", Detail: flow.line(reason)}
}

// showDeviceCode relays the code and its URL; a panicking caller is an error (TS: a throwing onEvent).
func showDeviceCode(interaction oar.ProviderLoginInteraction, userCode, verificationURI string) (failure error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			failure = fmt.Errorf("%v", recovered)
		}
	}()
	if interaction.OnEvent != nil {
		interaction.OnEvent(oar.ProviderLoginEvent{Kind: "device_code", UserCode: userCode, VerificationURI: verificationURI})
		interaction.OnEvent(oar.ProviderLoginEvent{Kind: "info", Message: deviceCodeSetting})
	}
	return nil
}

// Login signs codex in with the app-server's ChatGPT device code flow, relaying the code and its URL (codexLogin).
func Login(ctx context.Context, installation oar.AvailableInstallation, interaction oar.ProviderLoginInteraction, options oar.LoginOptions) (oar.LoginResult, error) {
	target := shared.LoginExecutableOf(installation, "codex", deviceCodeFloor)
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
	return runCodexLogin(ctx, target.Installation.Command, interaction, timeout), nil
}

package claude

import (
	"context"
	"fmt"
	"strings"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

const (
	statusTimeout = 20 * time.Second
	statusSource  = "claude auth status --json"
)

func trimmedText(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

// projectClaudeAuthStatus reads `claude auth status --json`: { loggedIn,
// authMethod, email?, subscriptionType?, ... }, exit 0 logged in, 1 logged out.
func projectClaudeAuthStatus(stdout string) oar.AuthStatus {
	status := jsonx.ParseRecord([]byte(stdout))
	loggedIn, ok := status["loggedIn"].(bool)
	if status == nil || !ok {
		return oar.AuthStatus{Kind: "unknown", Detail: "claude auth status gave no loggedIn field", Source: statusSource}
	}
	if !loggedIn {
		return oar.AuthStatus{Kind: "logged_out", Source: statusSource}
	}
	account := oar.LoginAccount{Email: trimmedText(status["email"]), Plan: trimmedText(status["subscriptionType"]), Method: trimmedText(status["authMethod"])}
	result := oar.AuthStatus{Kind: "logged_in", Source: statusSource}
	if account != (oar.LoginAccount{}) {
		result.Account = &account
	}
	return result
}

// claudeAuthRead is a status read, with what claude names as an API key's
// source (ANTHROPIC_API_KEY, apiKeyHelper), which AuthStatus has no field for.
type claudeAuthRead struct {
	Status       oar.AuthStatus
	APIKeySource string
}

// readClaudeAuthStatus: a cancelled ctx (the login's own) stops the query; the answer is then unknown.
func readClaudeAuthStatus(ctx context.Context, installation oar.AvailableInstallation, options oar.AuthStatusOptions) claudeAuthRead {
	if installation.Via != "executable" {
		return claudeAuthRead{Status: oar.AuthStatus{Kind: "unknown", Detail: "not a machine-installed executable"}}
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = statusTimeout
	}
	result := executable.Run(ctx, installation.Command, []string{"auth", "status", "--json"}, executable.RunOptions{Env: claudeEnv(), Timeout: timeout})
	// Exit 0 logged in, 1 logged out; anything else (a timeout, a crash, an abort) is no answer.
	if !result.OK && (result.ExitCode == nil || *result.ExitCode != 1) {
		code := "null"
		if result.ExitCode != nil {
			code = fmt.Sprint(*result.ExitCode)
		}
		return claudeAuthRead{Status: oar.AuthStatus{Kind: "unknown", Detail: "claude auth status ended without an answer (exit " + code + ")", Source: statusSource}}
	}
	status := projectClaudeAuthStatus(result.Stdout)
	read := claudeAuthRead{Status: status}
	if status.Kind == "logged_in" {
		read.APIKeySource = trimmedText(jsonx.ParseRecord([]byte(result.Stdout))["apiKeySource"])
	}
	return read
}

// AuthStatus reads claude's sign-in state (claudeAuthStatus).
func AuthStatus(ctx context.Context, installation oar.AvailableInstallation, options oar.AuthStatusOptions) (oar.AuthStatus, error) {
	return readClaudeAuthStatus(ctx, installation, options).Status, nil
}

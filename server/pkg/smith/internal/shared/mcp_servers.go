package shared

import (
	"errors"

	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
)

// Runtime-independent handling of SessionOptions.MCPServers: the checks
// every runtime that attaches them shares, and the known-credential rule
// shared with session records and errors (shared/mcp-servers.ts).

// IsHTTPMcpServer reports the streamable HTTP form (Type "http"); the other form is stdio.
func IsHTTPMcpServer(server oar.McpServer) bool { return server.IsHTTP() }

// HasMcpCredentials reports whether the entry carries a credential: a
// non-empty Env (stdio) or Headers (http).
func HasMcpCredentials(server oar.McpServer) bool {
	if server.IsHTTP() {
		return len(server.Headers) > 0
	}
	return len(server.Env) > 0
}

// GivenMcpServers is the given list, or nil when there is none to attach
// (absent or empty).
//
// TS also refuses a stdio env value that is not a string (null removal is
// only supported by SessionOptions.env). oar.McpServer.Env is
// map[string]string, so that value cannot reach Go: a JSON null decodes to "".
func GivenMcpServers(servers []oar.McpServer) []oar.McpServer {
	if len(servers) == 0 {
		return nil
	}
	return servers
}

// CheckMcpServerNames errors on a list no runtime can attach as given: an
// empty name, or a name given twice (each runtime keys its servers by name,
// so the later entry would silently replace the earlier one). The error
// names the value.
func CheckMcpServerNames(servers []oar.McpServer) error {
	GivenMcpServers(servers)
	seen := map[string]bool{}
	for _, server := range servers {
		if server.Name == "" {
			return errors.New("mcpServers has an entry with an empty name")
		}
		if seen[server.Name] {
			return errors.New("mcpServers names " + jsonText(server.Name) + " twice; names are unique within a session")
		}
		seen[server.Name] = true
	}
	return nil
}

// McpCredentialRedactor applies the same credential-name, length and path
// rules used for retained session records.
func McpCredentialRedactor(servers []oar.McpServer) func(string) string {
	return kernel.NewRedactor(oar.SessionOptions{MCPServers: servers}).Text
}

// RedactError is err with its text passed through redact, and so every
// error down its cause chain (a RuntimeFailureError keeps the agent's error
// in Cause). The typed open errors stay typed, as kernel.Redactor.Error
// keeps them; any other error whose text redact changes becomes a plain
// error with the redacted text. Go errors are values, so unlike TS (which
// edits the error in place) the redacted error is returned.
func RedactError(err error, redact func(string) string) error {
	if err == nil {
		return nil
	}
	var unsupported *oar.UnsupportedOptionError
	var notFound *oar.SessionNotFoundError
	var unavailable *oar.SessionUnavailableError
	var failure *oar.RuntimeFailureError
	switch {
	case errors.As(err, &unsupported):
		copied := *unsupported
		copied.Message = redact(copied.Message)
		return &copied
	case errors.As(err, &notFound):
		copied := *notFound
		copied.Message = redact(copied.Message)
		return &copied
	case errors.As(err, &unavailable):
		copied := *unavailable
		copied.Message = redact(copied.Message)
		return &copied
	case errors.As(err, &failure):
		copied := *failure
		copied.Reason = redact(copied.Reason)
		copied.Cause = RedactError(copied.Cause, redact)
		return &copied
	}
	text := err.Error()
	if redacted := redact(text); redacted != text {
		return errors.New(redacted)
	}
	return err
}

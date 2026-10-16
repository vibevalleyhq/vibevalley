package shared

import (
	"errors"
	"testing"

	"vibevalley/pkg/smith/oar"
)

func TestMcpServerNames(t *testing.T) {
	if err := CheckMcpServerNames([]oar.McpServer{{Name: "a", Command: "x"}, {Name: "b", Type: "http", URL: "http://x"}}); err != nil {
		t.Fatal(err)
	}
	if err := CheckMcpServerNames([]oar.McpServer{{Name: "", Command: "x"}}); err == nil || err.Error() != "mcpServers has an entry with an empty name" {
		t.Fatalf("err = %v", err)
	}
	if err := CheckMcpServerNames([]oar.McpServer{{Name: "a<b", Command: "x"}, {Name: "a<b", Command: "y"}}); err == nil || err.Error() != `mcpServers names "a<b" twice; names are unique within a session` {
		t.Fatalf("err = %v", err)
	}
	if GivenMcpServers(nil) != nil || GivenMcpServers([]oar.McpServer{}) != nil {
		t.Fatal("an empty list is none given")
	}
}

func TestMcpCredentials(t *testing.T) {
	if HasMcpCredentials(oar.McpServer{Name: "a", Command: "x"}) || !HasMcpCredentials(oar.McpServer{Name: "a", Command: "x", Env: map[string]string{"K": "v"}}) {
		t.Fatal("stdio credentials are its env")
	}
	if !HasMcpCredentials(oar.McpServer{Name: "a", Type: "http", Headers: map[string]string{"A": "b"}}) || HasMcpCredentials(oar.McpServer{Name: "a", Type: "http", Env: map[string]string{"K": "v"}}) {
		t.Fatal("http credentials are its headers")
	}
}

const sentinel = "sentinel-provider-secret"

func TestMcpCredentialHeadersUseSharedRedaction(t *testing.T) {
	for _, name := range []string{"Authorization", "Proxy-Authorization", "Cookie", "X-Api-Key", "Api-Key", "X-Service-Token", "x-custom-secret"} {
		servers := []oar.McpServer{{Name: "remote", Type: "http", URL: "http://localhost", Headers: map[string]string{name: sentinel}}}
		if got := McpCredentialRedactor(servers)(sentinel); got != "[redacted]" {
			t.Errorf("%s: %q", name, got)
		}
	}
	for _, scheme := range []string{"Bearer", "Basic", "Token"} {
		value := scheme + " " + sentinel
		servers := []oar.McpServer{{Name: "remote", Type: "http", URL: "http://localhost", Headers: map[string]string{"Authorization": value}}}
		if got := McpCredentialRedactor(servers)(value + "; " + sentinel); got != "[redacted]; [redacted]" {
			t.Errorf("%s: %q", scheme, got)
		}
	}
	if got := McpCredentialRedactor(nil)("nothing " + sentinel); got != "nothing "+sentinel {
		t.Errorf("no servers redacted %q", got)
	}
}

func TestRedactErrorFollowsTheCauseChain(t *testing.T) {
	redact := McpCredentialRedactor([]oar.McpServer{{Name: "remote", Type: "http", URL: "http://localhost", Headers: map[string]string{"Authorization": sentinel}}})
	failure := &oar.RuntimeFailureError{Failure: oar.FailureAuth, Reason: "rejected " + sentinel, Cause: errors.New("agent said " + sentinel)}
	got := RedactError(failure, redact)
	var redacted *oar.RuntimeFailureError
	if !errors.As(got, &redacted) || redacted.Reason != "rejected [redacted]" || redacted.Cause.Error() != "agent said [redacted]" || redacted.Failure != oar.FailureAuth {
		t.Fatalf("got %#v", got)
	}
	unsupported := RedactError(&oar.UnsupportedOptionError{Option: "mcpServers", Message: sentinel}, redact)
	var typed *oar.UnsupportedOptionError
	if !errors.As(unsupported, &typed) || typed.Message != "[redacted]" || typed.Option != "mcpServers" {
		t.Fatalf("got %#v", unsupported)
	}
	plain := errors.New("fine")
	if RedactError(plain, redact) != plain || RedactError(nil, redact) != nil {
		t.Fatal("an error with nothing to redact is kept")
	}
}

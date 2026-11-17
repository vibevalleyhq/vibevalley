package vault_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/vault"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func TestSecretRedactionEverywhere(t *testing.T) {
	t.Parallel()

	const rawAPIKey = "sk-ant-api03-super-secret-value-987654321"
	const rawRefresh = "rt-oauth-refresh-secret-abcdef123456"
	const rawExtra = "extra-header-secret-xyz999"

	sec := vault.NewSecret(rawAPIKey)
	if sec.Reveal() != rawAPIKey {
		t.Fatalf("Reveal() = %q, want %q", sec.Reveal(), rawAPIKey)
	}
	if !sec.Equal(vault.NewSecret(rawAPIKey)) {
		t.Fatal("Equal() returned false for identical secret")
	}
	if sec.Equal(vault.NewSecret("different")) {
		t.Fatal("Equal() returned true for different secret")
	}
	if got := sec.Hint(); got != "…4321" {
		t.Fatalf("Hint() = %q, want …4321", got)
	}
	if short := vault.NewSecret("abc").Hint(); short != "[secret]" {
		t.Fatalf("short secret Hint() = %q, want [secret]", short)
	}

	cred := vault.Credential{
		ID:           "cred-1",
		Kind:         vault.KindMCPOAuthToken,
		Name:         "linear",
		TargetHosts:  []string{"mcp.linear.app"},
		TokenType:    "Bearer",
		Value:        sec,
		RefreshToken: vault.NewSecret(rawRefresh),
		ExtraHeaders: map[string]vault.Secret{
			"X-Internal-Auth": vault.NewSecret(rawExtra),
		},
	}

	rootKey, err := vault.GenerateRootKey("rk-1")
	if err != nil {
		t.Fatalf("GenerateRootKey: %v", err)
	}
	signingKey, err := vault.GenerateSigningKey("sk-1")
	if err != nil {
		t.Fatalf("GenerateSigningKey: %v", err)
	}

	issued := vault.IssuedToken{
		TokenID: "tok-1",
		Token:   vault.NewSecret("vvcap1.secret-token-material-12345"),
		Principal: contract.Principal{
			Kind:         contract.PrincipalSessionToken,
			ID:           "machine-1",
			SessionID:    "sess-1",
			Capabilities: []string{vault.CapMCPCall},
			AllowedHosts: []string{"mcp.linear.app"},
			ExpiresAtMs:  time.Now().Add(15 * time.Minute).UnixMilli(),
		},
		IssuedAt:  time.Now(),
		ExpiresAt: time.Now().Add(15 * time.Minute),
	}

	type statusFrame struct {
		Status string           `json:"status"`
		Cred   vault.Credential `json:"cred"`
		Token  vault.Secret     `json:"token"`
	}
	frame := statusFrame{
		Status: "ready",
		Cred:   cred,
		Token:  sec,
	}

	var rendered strings.Builder
	for _, verb := range []string{"%s", "%v", "%+v", "%#v", "%q"} {
		rendered.WriteString(fmt.Sprintf(verb, sec))
		rendered.WriteByte('\n')
		rendered.WriteString(fmt.Sprintf(verb, cred))
		rendered.WriteByte('\n')
		rendered.WriteString(fmt.Sprintf(verb, frame))
		rendered.WriteByte('\n')
		rendered.WriteString(fmt.Sprintf(verb, issued))
		rendered.WriteByte('\n')
		rendered.WriteString(fmt.Sprintf(verb, rootKey))
		rendered.WriteByte('\n')
		rendered.WriteString(fmt.Sprintf(verb, signingKey))
		rendered.WriteByte('\n')
	}

	for _, target := range []any{sec, &sec, cred, frame, issued, rootKey, signingKey} {
		data, mErr := json.Marshal(target)
		if mErr != nil {
			t.Fatalf("json.Marshal(%T): %v", target, mErr)
		}
		rendered.Write(data)
		rendered.WriteByte('\n')
	}

	var logBuf bytes.Buffer
	jsonLogger := slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	textLogger := slog.New(slog.NewTextHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	for _, l := range []*slog.Logger{jsonLogger, textLogger} {
		l.Info("audit",
			slog.Any("secret", sec),
			slog.Any("cred", cred),
			slog.Any("frame", frame),
			slog.Any("issued", issued),
			slog.Any("rootKey", rootKey),
			slog.Any("signingKey", signingKey),
		)
	}
	rendered.WriteString(logBuf.String())

	dump := rendered.String()
	for _, forbidden := range []string{rawAPIKey, rawRefresh, rawExtra, "vvcap1.secret-token-material-12345"} {
		if strings.Contains(dump, forbidden) {
			t.Fatalf("redaction leak: found %q in output:\n%s", forbidden, dump)
		}
	}
	if !strings.Contains(dump, "[secret]") {
		t.Fatal("expected [secret] placeholder in redacted output")
	}

	var decoded vault.Secret
	if err := json.Unmarshal([]byte(`"plain"`), &decoded); err == nil {
		t.Fatal("expected Secret.UnmarshalJSON to fail")
	}
}

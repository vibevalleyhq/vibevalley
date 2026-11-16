package vault_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/vault"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func TestCapabilityTokenLifecycleAndSecurity(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	if _, err := vault.NewSigningKey("short", []byte("1234")); !errors.Is(err, vault.ErrInvalidSigningKey) {
		t.Fatalf("expected ErrInvalidSigningKey for short signing key, got %v", err)
	}

	sk1, err := vault.GenerateSigningKey("sig-1")
	if err != nil {
		t.Fatal(err)
	}
	sk2, err := vault.GenerateSigningKey("sig-2")
	if err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 11, 16, 14, 0, 0, 0, time.UTC)
	var logBuf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	svc, err := vault.NewTokenService(sk1,
		vault.WithTokenClock(func() time.Time { return now }),
		vault.WithTokenLogger(logger),
	)
	if err != nil {
		t.Fatal(err)
	}

	// Default TTL must be 15 minutes and bind sessionId, capabilities, and AllowedHosts.
	issued, err := svc.Issue(ctx, vault.IssueTokenRequest{
		PrincipalID:  "machine-alpha",
		SessionID:    "sess-42",
		Capabilities: []string{vault.CapGitRead, vault.CapMCPCall},
		AllowedHosts: []string{"github.com", "*.linear.app"},
		SecretIDs:    []string{"cred-git-1"},
	})
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if issued.ExpiresAt.Sub(issued.IssuedAt) != 15*time.Minute {
		t.Fatalf("default TTL = %s, want 15m", issued.ExpiresAt.Sub(issued.IssuedAt))
	}
	if issued.Principal.Kind != contract.PrincipalSessionToken ||
		issued.Principal.SessionID != "sess-42" ||
		issued.Principal.ID != "machine-alpha" ||
		issued.Principal.ExpiresAtMs != issued.ExpiresAt.UnixMilli() {
		t.Fatalf("unexpected principal binding: %+v", issued.Principal)
	}

	rawTok := issued.Token.Reveal()
	if !strings.HasPrefix(rawTok, vault.TokenPrefix) {
		t.Fatalf("token missing prefix %q", vault.TokenPrefix)
	}

	// Logs must never contain the raw token string.
	if bytes.Contains(logBuf.Bytes(), []byte(rawTok)) {
		t.Fatal("raw capability token leaked into slog")
	}

	// Valid before expiry.
	now = now.Add(14*time.Minute + 59*time.Second)
	epGit, _ := vault.ParseTargetEndpoint(mustURL(t, "https://github.com/org/repo.git"))
	epEvil, _ := vault.ParseTargetEndpoint(mustURL(t, "https://evil.example.com/exfil"))

	verified, err := svc.Verify(ctx, rawTok,
		vault.WithExpectedSession("sess-42"),
		vault.WithRequiredCapability(vault.CapGitRead),
		vault.WithRequiredSecretID("cred-git-1"),
		vault.WithRequiredHost(epGit),
	)
	if err != nil {
		t.Fatalf("Verify before expiry failed: %v", err)
	}
	if verified.Principal.SessionID != "sess-42" {
		t.Fatalf("verified session = %q, want sess-42", verified.Principal.SessionID)
	}

	// Cross-session, missing capability, unbound secret, and disallowed host checks.
	if _, err := svc.Verify(ctx, rawTok, vault.WithExpectedSession("sess-99")); !errors.Is(err, vault.ErrSessionMismatch) {
		t.Fatalf("wrong session got %v, want ErrSessionMismatch", err)
	}
	if _, err := svc.Verify(ctx, rawTok, vault.WithRequiredCapability(vault.CapGitWrite)); !errors.Is(err, vault.ErrCapabilityDenied) {
		t.Fatalf("missing cap got %v, want ErrCapabilityDenied", err)
	}
	if _, err := svc.Verify(ctx, rawTok, vault.WithRequiredSecretID("cred-other")); !errors.Is(err, vault.ErrCapabilityDenied) {
		t.Fatalf("unbound secret got %v, want ErrCapabilityDenied", err)
	}
	if _, err := svc.Verify(ctx, rawTok, vault.WithRequiredHost(epEvil)); !errors.Is(err, vault.ErrHostDenied) {
		t.Fatalf("disallowed host got %v, want ErrHostDenied", err)
	}

	// Tampered payload or signature fails verification.
	parts := strings.Split(strings.TrimPrefix(rawTok, vault.TokenPrefix), ".")
	tamperedSig := vault.TokenPrefix + parts[0] + "." + flipBase64Byte(t, parts[1])
	if _, err := svc.Verify(ctx, tamperedSig); !errors.Is(err, vault.ErrInvalidToken) {
		t.Fatalf("tampered sig got %v, want ErrInvalidToken", err)
	}

	payloadRaw, _ := base64.RawURLEncoding.DecodeString(parts[0])
	var claimsMap map[string]any
	_ = json.Unmarshal(payloadRaw, &claimsMap)
	pMap := claimsMap["principal"].(map[string]any)
	pMap["sessionId"] = "sess-hijacked"
	tamperedPayloadBytes, _ := json.Marshal(claimsMap)
	tamperedPayload := vault.TokenPrefix + base64.RawURLEncoding.EncodeToString(tamperedPayloadBytes) + "." + parts[1]
	if _, err := svc.Verify(ctx, tamperedPayload); !errors.Is(err, vault.ErrInvalidToken) {
		t.Fatalf("tampered payload got %v, want ErrInvalidToken", err)
	}

	// Exact 15-minute expiry boundary fails with ErrTokenExpired.
	now = now.Add(1 * time.Second)
	if _, err := svc.Verify(ctx, rawTok); !errors.Is(err, vault.ErrTokenExpired) {
		t.Fatalf("expired token got %v, want ErrTokenExpired", err)
	}

	// Issue via contract.Principal directly and test revocation + signing key rotation.
	pIssued, err := svc.IssueForPrincipal(ctx, contract.Principal{
		Kind:         contract.PrincipalSessionToken,
		ID:           "worker-1",
		SessionID:    "sess-77",
		Capabilities: []string{vault.CapMCPCall},
		AllowedHosts: []string{"mcp.linear.app"},
	}, 5*time.Minute)
	if err != nil {
		t.Fatalf("IssueForPrincipal: %v", err)
	}

	// Rotate signing key: old token remains valid until previous key retired.
	if err := svc.RotateSigningKey(sk2); err != nil {
		t.Fatalf("RotateSigningKey: %v", err)
	}
	if _, err := svc.Verify(ctx, pIssued.Token.Reveal()); err != nil {
		t.Fatalf("old token should verify before key retirement: %v", err)
	}

	svc.RevokeToken(pIssued.TokenID)
	if _, err := svc.Verify(ctx, pIssued.Token.Reveal()); !errors.Is(err, vault.ErrTokenRevoked) {
		t.Fatalf("revoked token got %v, want ErrTokenRevoked", err)
	}

	// Session revocation blocks all tokens of that session.
	pIssued2, err := svc.Issue(ctx, vault.IssueTokenRequest{
		SessionID:    "sess-88",
		Capabilities: []string{vault.CapHTTPEgress},
		AllowedHosts: []string{"example.com"},
	})
	if err != nil {
		t.Fatal(err)
	}
	svc.RevokeSession("sess-88")
	if _, err := svc.Verify(ctx, pIssued2.Token.Reveal()); !errors.Is(err, vault.ErrTokenRevoked) {
		t.Fatalf("revoked session got %v, want ErrTokenRevoked", err)
	}

	// Retiring old signing keys rejects tokens signed by sig-1.
	pIssued3, err := svc.Issue(ctx, vault.IssueTokenRequest{
		SessionID:    "sess-99",
		Capabilities: []string{vault.CapHTTPEgress},
		AllowedHosts: []string{"example.com"},
	})
	if err != nil {
		t.Fatal(err)
	}
	// pIssued3 was signed by sig-2; retiring others preserves sig-2 and drops sig-1.
	svc.RetireOtherSigningKeys()
	if _, err := svc.Verify(ctx, pIssued3.Token.Reveal()); err != nil {
		t.Fatalf("sig-2 token should still verify: %v", err)
	}
	if _, err := svc.Verify(ctx, rawTok); !errors.Is(err, vault.ErrInvalidToken) {
		t.Fatalf("retired sig-1 token got %v, want ErrInvalidToken", err)
	}
}

func TestTokenValidationRejectsBadInputs(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	sk, _ := vault.GenerateSigningKey("sk-val")
	svc, err := vault.NewTokenService(sk, vault.WithMaxTTL(15*time.Minute))
	if err != nil {
		t.Fatal(err)
	}

	if _, err := svc.Issue(ctx, vault.IssueTokenRequest{
		Capabilities: []string{vault.CapGitRead},
		AllowedHosts: []string{"github.com"},
	}); !errors.Is(err, vault.ErrSessionMismatch) {
		t.Fatalf("empty sessionId got %v, want ErrSessionMismatch", err)
	}

	if _, err := svc.Issue(ctx, vault.IssueTokenRequest{
		SessionID:    "s1",
		AllowedHosts: []string{"github.com"},
	}); !errors.Is(err, vault.ErrCapabilityDenied) {
		t.Fatalf("empty capabilities got %v, want ErrCapabilityDenied", err)
	}

	if _, err := svc.Issue(ctx, vault.IssueTokenRequest{
		SessionID:    "s1",
		Capabilities: []string{vault.CapGitRead},
		AllowedHosts: []string{"*.com"},
	}); !errors.Is(err, vault.ErrInvalidHostPattern) {
		t.Fatalf("too broad wildcard got %v, want ErrInvalidHostPattern", err)
	}

	if _, err := svc.Issue(ctx, vault.IssueTokenRequest{
		SessionID:    "s1",
		Capabilities: []string{vault.CapGitRead},
		AllowedHosts: []string{"github.com"},
		TTL:          30 * time.Minute,
	}); !errors.Is(err, vault.ErrInvalidToken) {
		t.Fatalf("TTL > MaxTTL got %v, want ErrInvalidToken", err)
	}
}

func flipBase64Byte(t *testing.T, s string) string {
	t.Helper()
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	b[0] ^= 0xff
	return base64.RawURLEncoding.EncodeToString(b)
}

package vault_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/vault"
)

func testDiscardLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}

func TestEnvelopeEncryptionAndTamperDetection(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	if _, err := vault.NewRootKey("rk-short", []byte("too-short")); !errors.Is(err, vault.ErrInvalidRootKey) {
		t.Fatalf("expected ErrInvalidRootKey for short key, got %v", err)
	}
	if _, err := vault.NewRootKey("", make([]byte, 32)); !errors.Is(err, vault.ErrInvalidRootKey) {
		t.Fatalf("expected ErrInvalidRootKey for empty id, got %v", err)
	}

	rk1, err := vault.GenerateRootKey("rk-1")
	if err != nil {
		t.Fatalf("GenerateRootKey: %v", err)
	}
	kr, err := vault.NewKeyRing(rk1)
	if err != nil {
		t.Fatalf("NewKeyRing: %v", err)
	}

	now := time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)
	var logBuf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	backend := vault.NewMemoryBackend()
	store, err := vault.NewStore(kr, backend,
		vault.WithStoreClock(func() time.Time { return now }),
		vault.WithStoreLogger(logger),
	)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	expires := now.Add(1 * time.Hour)
	secrets := []vault.Credential{
		{
			ID:           "cred-provider",
			Kind:         vault.KindProviderAPIKey,
			Name:         "anthropic-main",
			TargetHosts:  []string{"api.anthropic.com"},
			Provider:     "anthropic",
			HeaderName:   "x-api-key",
			Value:        vault.NewSecret("sk-ant-real-key-alpha-1111"),
			ExtraHeaders: map[string]vault.Secret{"anthropic-beta": vault.NewSecret("beta-secret-flag")},
		},
		{
			ID:          "cred-git",
			Kind:        vault.KindGitCredential,
			Name:        "github-org",
			TargetHosts: []string{"github.com", "api.github.com"},
			Username:    "bot-user-secret",
			Value:       vault.NewSecret("ghp_realGitTokenBeta2222"),
		},
		{
			ID:           "cred-mcp",
			Kind:         vault.KindMCPOAuthToken,
			Name:         "linear-mcp",
			TargetHosts:  []string{"mcp.linear.app"},
			TokenType:    "Bearer",
			Scopes:       []string{"read", "write"},
			ExpiresAt:    &expires,
			Value:        vault.NewSecret("mcp_oauth_access_gamma_3333"),
			RefreshToken: vault.NewSecret("mcp_oauth_refresh_delta_4444"),
		},
	}

	for _, c := range secrets {
		if err := store.Put(ctx, c); err != nil {
			t.Fatalf("Put(%s): %v", c.ID, err)
		}
	}

	// Verify roundtrip decryption and non-secret metadata listing.
	for _, want := range secrets {
		got, getErr := store.Get(ctx, want.ID)
		if getErr != nil {
			t.Fatalf("Get(%s): %v", want.ID, getErr)
		}
		if !got.Value.Equal(want.Value) {
			t.Fatalf("Get(%s) value mismatch", want.ID)
		}
		if got.Kind != want.Kind || got.Name != want.Name || got.Username != want.Username {
			t.Fatalf("Get(%s) metadata mismatch: %+v vs %+v", want.ID, got, want)
		}
		if !got.RefreshToken.Equal(want.RefreshToken) {
			t.Fatalf("Get(%s) refresh token mismatch", want.ID)
		}
		byName, nameErr := store.GetByName(ctx, want.Kind, want.Name)
		if nameErr != nil || !byName.Value.Equal(want.Value) {
			t.Fatalf("GetByName(%s, %s) failed: %v", want.Kind, want.Name, nameErr)
		}
	}

	metas, err := store.ListMetadata(ctx)
	if err != nil || len(metas) != 3 {
		t.Fatalf("ListMetadata len=%d err=%v", len(metas), err)
	}

	// Ensure zero plaintext secret material appears in stored envelopes or logs.
	envs, err := backend.ListEnvelopes(ctx)
	if err != nil {
		t.Fatalf("ListEnvelopes: %v", err)
	}
	rawPlaintexts := []string{
		"sk-ant-real-key-alpha-1111",
		"beta-secret-flag",
		"bot-user-secret",
		"ghp_realGitTokenBeta2222",
		"mcp_oauth_access_gamma_3333",
		"mcp_oauth_refresh_delta_4444",
	}
	for _, env := range envs {
		blob := append(append(append(env.WrappedDEKNonce, env.WrappedDEK...), env.PayloadNonce...), env.Ciphertext...)
		for _, pt := range rawPlaintexts {
			if bytes.Contains(blob, []byte(pt)) || bytes.Contains(logBuf.Bytes(), []byte(pt)) {
				t.Fatalf("found plaintext %q in envelope or logs", pt)
			}
		}
	}

	// Identical plaintext written to two secrets uses distinct DEKs and nonces.
	c1 := vault.Credential{ID: "dup-1", Kind: vault.KindProviderAPIKey, Name: "d1", TargetHosts: []string{"api.openai.com"}, Value: vault.NewSecret("same-secret-value")}
	c2 := vault.Credential{ID: "dup-2", Kind: vault.KindProviderAPIKey, Name: "d2", TargetHosts: []string{"api.openai.com"}, Value: vault.NewSecret("same-secret-value")}
	if err := store.Put(ctx, c1); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(ctx, c2); err != nil {
		t.Fatal(err)
	}
	e1, _ := backend.GetEnvelope(ctx, "dup-1")
	e2, _ := backend.GetEnvelope(ctx, "dup-2")
	if bytes.Equal(e1.WrappedDEK, e2.WrappedDEK) || bytes.Equal(e1.Ciphertext, e2.Ciphertext) || bytes.Equal(e1.PayloadNonce, e2.PayloadNonce) {
		t.Fatal("expected distinct DEKs, nonces, and ciphertexts for separate secrets")
	}

	// Tampering tests: bitflips and AAD / metadata mismatches must fail authentication.
	orig, err := backend.GetEnvelope(ctx, "cred-git")
	if err != nil {
		t.Fatal(err)
	}

	tamperCases := []struct {
		name    string
		mutate  func(e *vault.SealedEnvelope)
		wantErr error
	}{
		{
			name:    "ciphertext bitflip",
			mutate:  func(e *vault.SealedEnvelope) { e.Ciphertext[0] ^= 0x01 },
			wantErr: vault.ErrCiphertextTampered,
		},
		{
			name:    "payload nonce bitflip",
			mutate:  func(e *vault.SealedEnvelope) { e.PayloadNonce[0] ^= 0x80 },
			wantErr: vault.ErrCiphertextTampered,
		},
		{
			name:    "wrapped DEK bitflip",
			mutate:  func(e *vault.SealedEnvelope) { e.WrappedDEK[0] ^= 0x01 },
			wantErr: vault.ErrCiphertextTampered,
		},
		{
			name:    "wrapped DEK nonce bitflip",
			mutate:  func(e *vault.SealedEnvelope) { e.WrappedDEKNonce[0] ^= 0x40 },
			wantErr: vault.ErrCiphertextTampered,
		},
		{
			name:    "swapped secret ID AAD",
			mutate:  func(e *vault.SealedEnvelope) { e.SecretID = "cred-provider" },
			wantErr: vault.ErrCiphertextTampered,
		},
		{
			name:    "tampered kind AAD",
			mutate:  func(e *vault.SealedEnvelope) { e.Kind = vault.KindProviderAPIKey },
			wantErr: vault.ErrCiphertextTampered,
		},
		{
			name:    "tampered target hosts column",
			mutate:  func(e *vault.SealedEnvelope) { e.TargetHosts = []string{"evil.example.com"} },
			wantErr: vault.ErrCiphertextTampered,
		},
		{
			name:    "tampered root key id",
			mutate:  func(e *vault.SealedEnvelope) { e.RootKeyID = "rk-missing" },
			wantErr: vault.ErrUnknownRootKey,
		},
	}

	for _, tc := range tamperCases {
		t.Run(tc.name, func(t *testing.T) {
			tb := vault.NewMemoryBackend()
			copyEnv := orig
			copyEnv.Ciphertext = bytes.Clone(orig.Ciphertext)
			copyEnv.PayloadNonce = bytes.Clone(orig.PayloadNonce)
			copyEnv.WrappedDEK = bytes.Clone(orig.WrappedDEK)
			copyEnv.WrappedDEKNonce = bytes.Clone(orig.WrappedDEKNonce)
			tc.mutate(&copyEnv)
			if err := tb.PutEnvelope(ctx, copyEnv); err != nil {
				t.Fatal(err)
			}
			ts, err := vault.NewStore(kr, tb)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := ts.Get(ctx, copyEnv.SecretID); !errors.Is(err, tc.wantErr) {
				t.Fatalf("tamper %s: got %v, want %v", tc.name, err, tc.wantErr)
			}
		})
	}
}

func TestEnvelopeDEKAndRootKeyRotation(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	rk1, err := vault.GenerateRootKey("rk-v1")
	if err != nil {
		t.Fatal(err)
	}
	rk2, err := vault.GenerateRootKey("rk-v2")
	if err != nil {
		t.Fatal(err)
	}

	kr1, err := vault.NewKeyRing(rk1)
	if err != nil {
		t.Fatal(err)
	}
	backend := vault.NewMemoryBackend()
	store, err := vault.NewStore(kr1, backend, vault.WithStoreLogger(testDiscardLogger()))
	if err != nil {
		t.Fatal(err)
	}

	cred := vault.Credential{
		ID:          "rot-secret",
		Kind:        vault.KindGitCredential,
		Name:        "repo-token",
		TargetHosts: []string{"github.com"},
		Username:    "x-access-token",
		Value:       vault.NewSecret("ghp_rotate_me_9999"),
	}
	if err := store.Put(ctx, cred); err != nil {
		t.Fatal(err)
	}
	beforeDEKRot, err := backend.GetEnvelope(ctx, cred.ID)
	if err != nil {
		t.Fatal(err)
	}

	if err := store.RotateDEK(ctx, cred.ID); err != nil {
		t.Fatalf("RotateDEK: %v", err)
	}
	afterDEKRot, err := backend.GetEnvelope(ctx, cred.ID)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(beforeDEKRot.WrappedDEK, afterDEKRot.WrappedDEK) || bytes.Equal(beforeDEKRot.Ciphertext, afterDEKRot.Ciphertext) {
		t.Fatal("RotateDEK must produce fresh wrapped DEK and ciphertext")
	}

	if err := store.RotateRootKey(ctx, rk2); err != nil {
		t.Fatalf("RotateRootKey: %v", err)
	}
	afterRootRot, err := backend.GetEnvelope(ctx, cred.ID)
	if err != nil {
		t.Fatal(err)
	}
	if afterRootRot.RootKeyID != "rk-v2" {
		t.Fatalf("RootKeyID = %q, want rk-v2", afterRootRot.RootKeyID)
	}

	// Old key alone cannot decrypt after rotation.
	oldOnlyKR, _ := vault.NewKeyRing(rk1)
	oldOnlyStore, _ := vault.NewStore(oldOnlyKR, backend)
	if _, err := oldOnlyStore.Get(ctx, cred.ID); !errors.Is(err, vault.ErrUnknownRootKey) {
		t.Fatalf("old key alone got %v, want ErrUnknownRootKey", err)
	}

	// New key alone decrypts cleanly.
	newOnlyKR, _ := vault.NewKeyRing(rk2)
	newOnlyStore, _ := vault.NewStore(newOnlyKR, backend, vault.WithStoreLogger(testDiscardLogger()))
	got, err := newOnlyStore.Get(ctx, cred.ID)
	if err != nil {
		t.Fatalf("new key Get: %v", err)
	}
	if !got.Value.Equal(cred.Value) {
		t.Fatal("decrypted value mismatch after root key rotation")
	}

	// ReencryptAll upgrades prior-key envelopes when a KeyRing holds [rk3, rk2].
	rk3, err := vault.GenerateRootKey("rk-v3")
	if err != nil {
		t.Fatal(err)
	}
	upgradeKR, err := vault.NewKeyRing(rk3, rk2)
	if err != nil {
		t.Fatal(err)
	}
	upgradeStore, err := vault.NewStore(upgradeKR, backend, vault.WithStoreLogger(testDiscardLogger()))
	if err != nil {
		t.Fatal(err)
	}
	if err := upgradeStore.ReencryptAll(ctx); err != nil {
		t.Fatalf("ReencryptAll: %v", err)
	}
	envV3, err := backend.GetEnvelope(ctx, cred.ID)
	if err != nil || envV3.RootKeyID != "rk-v3" {
		t.Fatalf("expected rootKeyId rk-v3 after ReencryptAll, got %q err=%v", envV3.RootKeyID, err)
	}
}

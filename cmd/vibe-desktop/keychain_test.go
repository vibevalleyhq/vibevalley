package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"github.com/vibevalleyhq/vibevalley/internal/vault"
)

type recordedCall struct {
	name  string
	args  []string
	stdin string
}

type fakeKeychainRunner struct {
	calls   []recordedCall
	secrets map[string]string
}

func (f *fakeKeychainRunner) Run(_ context.Context, stdin []byte, name string, args ...string) ([]byte, []byte, int, error) {
	if f.secrets == nil {
		f.secrets = make(map[string]string)
	}
	f.calls = append(f.calls, recordedCall{
		name:  name,
		args:  append([]string(nil), args...),
		stdin: string(stdin),
	})

	switch name {
	case "security":
		if len(args) > 0 && args[0] == "-i" {
			// Parse "add-generic-password -U -s \"svc\" -a \"acct\" -w \"b64\""
			parts := splitQuoted(string(stdin))
			svc, acct, val := extractFlag(parts, "-s"), extractFlag(parts, "-a"), extractFlag(parts, "-w")
			f.secrets[svc+"/"+acct] = val
			return nil, nil, 0, nil
		}
		if len(args) > 0 && args[0] == "find-generic-password" {
			svc, acct := extractFlag(args, "-s"), extractFlag(args, "-a")
			val, ok := f.secrets[svc+"/"+acct]
			if !ok {
				return nil, []byte("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain."), 44, errors.New("exit 44")
			}
			return []byte(val + "\n"), nil, 0, nil
		}
		if len(args) > 0 && args[0] == "delete-generic-password" {
			svc, acct := extractFlag(args, "-s"), extractFlag(args, "-a")
			if _, ok := f.secrets[svc+"/"+acct]; !ok {
				return nil, []byte("could not be found"), 44, errors.New("exit 44")
			}
			delete(f.secrets, svc+"/"+acct)
			return nil, nil, 0, nil
		}

	case "secret-tool":
		if len(args) > 0 && args[0] == "store" {
			svc, acct := extractPair(args, "service"), extractPair(args, "account")
			f.secrets[svc+"/"+acct] = string(stdin)
			return nil, nil, 0, nil
		}
		if len(args) > 0 && args[0] == "lookup" {
			svc, acct := extractPair(args, "service"), extractPair(args, "account")
			val, ok := f.secrets[svc+"/"+acct]
			if !ok {
				return nil, nil, 1, errors.New("exit 1")
			}
			return []byte(val), nil, 0, nil
		}
		if len(args) > 0 && args[0] == "clear" {
			svc, acct := extractPair(args, "service"), extractPair(args, "account")
			delete(f.secrets, svc+"/"+acct)
			return nil, nil, 0, nil
		}

	case "cmdkey":
		if len(args) > 0 && strings.HasPrefix(args[0], "/generic:") {
			target := strings.TrimPrefix(args[0], "/generic:")
			f.secrets[target] = string(stdin)
			return nil, nil, 0, nil
		}
		if len(args) > 0 && strings.HasPrefix(args[0], "/delete:") {
			target := strings.TrimPrefix(args[0], "/delete:")
			delete(f.secrets, target)
			return nil, nil, 0, nil
		}

	case "powershell":
		target := args[len(args)-1]
		val, ok := f.secrets[target]
		if !ok {
			return nil, []byte("not found"), 44, errors.New("exit 44")
		}
		return []byte(val), nil, 0, nil
	}
	return nil, []byte("unexpected command"), 1, errors.New("unexpected command")
}

func splitQuoted(line string) []string {
	var out []string
	var cur strings.Builder
	inQuote := false
	escaped := false
	for _, r := range strings.TrimSpace(line) {
		switch {
		case escaped:
			cur.WriteRune(r)
			escaped = false
		case r == '\\':
			escaped = true
		case r == '"':
			inQuote = !inQuote
		case (r == ' ' || r == '\t') && !inQuote:
			if cur.Len() > 0 {
				out = append(out, cur.String())
				cur.Reset()
			}
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

func extractFlag(args []string, flag string) string {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag {
			return args[i+1]
		}
	}
	return ""
}

func extractPair(args []string, key string) string {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == key {
			return args[i+1]
		}
	}
	return ""
}

func TestVaultRootKeyStoreMemoryRoundTripAndEnvelopeIntegration(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	driver := NewMemoryKeychainDriver()
	ks := NewVaultRootKeyStore("dev.vibevalley.test", driver)

	// Missing key returns ErrKeychainNotFound.
	if _, err := ks.RetrieveRootKey(ctx, "rk-1"); !errors.Is(err, ErrKeychainNotFound) {
		t.Fatalf("RetrieveRootKey missing: got %v, want ErrKeychainNotFound", err)
	}

	// Reject non-32-byte keys and empty IDs.
	for _, bad := range [][]byte{nil, make([]byte, 16), make([]byte, 31), make([]byte, 33)} {
		if err := ks.StoreRootKey(ctx, "rk-bad", bad); !errors.Is(err, ErrInvalidRootKey) {
			t.Fatalf("StoreRootKey len=%d: got %v, want ErrInvalidRootKey", len(bad), err)
		}
	}
	if err := ks.StoreRootKey(ctx, "", make([]byte, 32)); !errors.Is(err, ErrInvalidRootKey) {
		t.Fatalf("StoreRootKey empty id: got %v, want ErrInvalidRootKey", err)
	}

	// Store -> Retrieve -> Vault KeyRing envelope round-trip with binary NUL/0xFF bytes.
	raw := make([]byte, vault.RootKeySize)
	for i := range raw {
		raw[i] = byte(i * 17)
	}
	raw[0] = 0x00
	raw[31] = 0xff
	if err := ks.StoreRootKey(ctx, "rk-1", raw); err != nil {
		t.Fatalf("StoreRootKey: %v", err)
	}

	rk, err := ks.RetrieveRootKey(ctx, "rk-1")
	if err != nil {
		t.Fatalf("RetrieveRootKey: %v", err)
	}
	if rk.ID() != "rk-1" {
		t.Fatalf("RootKey.ID = %q, want rk-1", rk.ID())
	}

	// Prove retrieved key unlocks an internal/vault Store envelope cleanly.
	kr, err := vault.NewKeyRing(rk)
	if err != nil {
		t.Fatalf("vault.NewKeyRing: %v", err)
	}
	vs, err := vault.NewStore(kr, vault.NewMemoryBackend())
	if err != nil {
		t.Fatalf("vault.NewStore: %v", err)
	}
	if err := vs.Put(ctx, vault.Credential{
		ID:          "cred-openai",
		Kind:        vault.KindProviderAPIKey,
		Name:        "openai",
		TargetHosts: []string{"api.openai.com"},
		Value:       vault.NewSecret("sk-test-secret-12345"),
	}); err != nil {
		t.Fatalf("vault Put: %v", err)
	}
	gotCred, err := vs.Get(ctx, "cred-openai")
	if err != nil || gotCred.Value.Reveal() != "sk-test-secret-12345" {
		t.Fatalf("vault Get: err=%v secret=%q", err, gotCred.Value.Reveal())
	}

	// EnsureRootKey returns existing key with created=false, and creates a new 32-byte key when missing.
	existing, created, err := ks.EnsureRootKey(ctx, "rk-1")
	if err != nil || created || existing.ID() != "rk-1" {
		t.Fatalf("EnsureRootKey existing: created=%v err=%v", created, err)
	}
	fresh, created, err := ks.EnsureRootKey(ctx, "rk-2")
	if err != nil || !created || fresh.ID() != "rk-2" {
		t.Fatalf("EnsureRootKey fresh: created=%v err=%v", created, err)
	}

	// Delete round-trip.
	if err := ks.DeleteRootKey(ctx, "rk-1"); err != nil {
		t.Fatalf("DeleteRootKey: %v", err)
	}
	if err := ks.DeleteRootKey(ctx, "rk-1"); err != nil {
		t.Fatalf("idempotent DeleteRootKey: %v", err)
	}
	if _, err := ks.RetrieveRootKey(ctx, "rk-1"); !errors.Is(err, ErrKeychainNotFound) {
		t.Fatalf("Retrieve after Delete: got %v, want ErrKeychainNotFound", err)
	}
}

func TestPlatformKeychainDriversDarwinLinuxWindowsCommands(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	raw := bytes.Repeat([]byte{0x00, 0xAB, 0xCD, 0xFF}, 8) // 32 bytes including NUL and 0xFF
	encoded := base64.StdEncoding.EncodeToString(raw)

	for _, goos := range []string{"darwin", "linux", "windows"} {
		t.Run(goos, func(t *testing.T) {
			t.Parallel()
			runner := &fakeKeychainRunner{}
			ks := NewVaultRootKeyStore("dev.vibevalley.cli", newCLIKeychainDriver(goos, runner))

			if _, err := ks.RetrieveRootKey(ctx, "master"); !errors.Is(err, ErrKeychainNotFound) {
				t.Fatalf("%s retrieve missing: got %v, want ErrKeychainNotFound", goos, err)
			}
			if err := ks.StoreRootKey(ctx, "master", raw); err != nil {
				t.Fatalf("%s store: %v", goos, err)
			}

			// Verify darwin & linux never leak the secret in argv.
			if goos == "darwin" || goos == "linux" {
				storeCall := runner.calls[len(runner.calls)-1]
				for _, arg := range storeCall.args {
					if strings.Contains(arg, encoded) {
						t.Fatalf("%s leaked encoded key into process argv: %v", goos, storeCall.args)
					}
				}
			}

			rk, err := ks.RetrieveRootKey(ctx, "master")
			if err != nil || rk.ID() != "master" {
				t.Fatalf("%s retrieve: rk=%v err=%v", goos, rk, err)
			}
			if err := ks.DeleteRootKey(ctx, "master"); err != nil {
				t.Fatalf("%s delete: %v", goos, err)
			}
			if _, err := ks.RetrieveRootKey(ctx, "master"); !errors.Is(err, ErrKeychainNotFound) {
				t.Fatalf("%s retrieve after delete: got %v, want ErrKeychainNotFound", goos, err)
			}
		})
	}
}

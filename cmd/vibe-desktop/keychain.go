package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"runtime"
	"strings"
	"sync"

	"github.com/egoist/mygo"
	"github.com/vibevalleyhq/vibevalley/internal/vault"
)

const defaultKeychainService = "dev.vibevalley.desktop.vault"

var (
	// ErrKeychainNotFound indicates no secret is stored for the requested key.
	ErrKeychainNotFound = errors.New("keychain: secret not found")
	// ErrInvalidRootKey indicates the key ID or 32-byte key material failed validation.
	ErrInvalidRootKey = errors.New("keychain: invalid vault root key")
)

// KeychainDriver abstracts OS credential storage for Vault root keys.
type KeychainDriver interface {
	Name() string
	Store(ctx context.Context, service, account string, secret []byte) error
	Retrieve(ctx context.Context, service, account string) ([]byte, error)
	Delete(ctx context.Context, service, account string) error
}

type commandRunner interface {
	Run(ctx context.Context, stdin []byte, name string, args ...string) (stdout []byte, stderr []byte, exitCode int, err error)
}

type osCommandRunner struct{}

func (osCommandRunner) Run(ctx context.Context, stdin []byte, name string, args ...string) ([]byte, []byte, int, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if len(stdin) > 0 {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	err := cmd.Run()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}
	return outBuf.Bytes(), errBuf.Bytes(), exitCode, err
}

// MemoryKeychainDriver is a deterministic in-memory KeychainDriver for tests and headless checks.
type MemoryKeychainDriver struct {
	mu    sync.RWMutex
	items map[string][]byte
}

// NewMemoryKeychainDriver constructs an isolated in-memory KeychainDriver.
func NewMemoryKeychainDriver() *MemoryKeychainDriver {
	return &MemoryKeychainDriver{
		items: make(map[string][]byte),
	}
}

func (d *MemoryKeychainDriver) Name() string { return "memory" }

func (d *MemoryKeychainDriver) Store(ctx context.Context, service, account string, secret []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateKeychainCoords(service, account); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	key := service + "\x00" + account
	if old, ok := d.items[key]; ok {
		clear(old)
	}
	d.items[key] = bytes.Clone(secret)
	return nil
}

func (d *MemoryKeychainDriver) Retrieve(ctx context.Context, service, account string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := validateKeychainCoords(service, account); err != nil {
		return nil, err
	}
	d.mu.RLock()
	defer d.mu.RUnlock()
	v, ok := d.items[service+"\x00"+account]
	if !ok {
		return nil, ErrKeychainNotFound
	}
	return bytes.Clone(v), nil
}

func (d *MemoryKeychainDriver) Delete(ctx context.Context, service, account string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateKeychainCoords(service, account); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	key := service + "\x00" + account
	if old, ok := d.items[key]; ok {
		clear(old)
		delete(d.items, key)
	}
	return nil
}

// MyGoSecretsDriver delegates credential persistence to MyGo's pure-Go OS secrets backend
// (Security.framework on macOS, libsecret on Linux, CredWriteW/CredReadW on Windows).
type MyGoSecretsDriver struct{}

func (MyGoSecretsDriver) Name() string { return "mygo-secrets" }

func (MyGoSecretsDriver) Store(ctx context.Context, service, account string, secret []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateKeychainCoords(service, account); err != nil {
		return err
	}
	return mygo.Secrets.Service(service).Set(account, secret)
}

func (MyGoSecretsDriver) Retrieve(ctx context.Context, service, account string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := validateKeychainCoords(service, account); err != nil {
		return nil, err
	}
	v, err := mygo.Secrets.Service(service).Get(account)
	if errors.Is(err, mygo.ErrSecretNotFound) {
		return nil, ErrKeychainNotFound
	}
	return v, err
}

func (MyGoSecretsDriver) Delete(ctx context.Context, service, account string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateKeychainCoords(service, account); err != nil {
		return err
	}
	return mygo.Secrets.Service(service).Delete(account)
}

// cliKeychainDriver implements platform CLI credential backends (darwin security,
// linux secret-tool, and windows Credential Manager / PowerShell DPAPI).
type cliKeychainDriver struct {
	goos   string
	runner commandRunner
}

// NewPlatformKeychainDriver returns the OS-native KeychainDriver for the active GOOS.
func NewPlatformKeychainDriver() KeychainDriver {
	return newCLIKeychainDriver(runtime.GOOS, osCommandRunner{})
}

func newCLIKeychainDriver(goos string, runner commandRunner) KeychainDriver {
	if runner == nil {
		runner = osCommandRunner{}
	}
	return &cliKeychainDriver{goos: goos, runner: runner}
}

func (d *cliKeychainDriver) Name() string {
	return "platform:" + d.goos
}

func (d *cliKeychainDriver) Store(ctx context.Context, service, account string, secret []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateKeychainCoords(service, account); err != nil {
		return err
	}
	encodedBuf := make([]byte, base64.StdEncoding.EncodedLen(len(secret)))
	base64.StdEncoding.Encode(encodedBuf, secret)
	defer clear(encodedBuf)

	switch d.goos {
	case "darwin":
		// Feed add-generic-password through `security -i` stdin so the secret never appears in argv.
		var script bytes.Buffer
		script.WriteString("add-generic-password -U -s ")
		script.WriteString(quoteSecurityArg(service))
		script.WriteString(" -a ")
		script.WriteString(quoteSecurityArg(account))
		script.WriteString(" -w ")
		script.WriteString(quoteSecurityArg(string(encodedBuf)))
		script.WriteByte('\n')
		defer clear(script.Bytes())
		_, stderr, code, err := d.runner.Run(ctx, script.Bytes(), "security", "-i")
		if err != nil {
			return fmt.Errorf("darwin security store (exit %d): %w (%s)", code, err, strings.TrimSpace(string(stderr)))
		}
		return nil

	case "linux":
		label := fmt.Sprintf("VibeValley Vault (%s/%s)", service, account)
		_, stderr, code, err := d.runner.Run(ctx, encodedBuf,
			"secret-tool", "store", "--label="+label, "service", service, "account", account)
		if err != nil {
			return fmt.Errorf("linux secret-tool store (exit %d): %w (%s)", code, err, strings.TrimSpace(string(stderr)))
		}
		return nil

	case "windows":
		if _, isRealOS := d.runner.(osCommandRunner); isRealOS {
			return MyGoSecretsDriver{}.Store(ctx, service, account, secret)
		}
		target := service + "/" + account
		_, stderr, code, err := d.runner.Run(ctx, encodedBuf,
			"cmdkey", "/generic:"+target, "/user:"+account, "/pass:"+string(encodedBuf))
		if err != nil {
			return fmt.Errorf("windows credential store (exit %d): %w (%s)", code, err, strings.TrimSpace(string(stderr)))
		}
		return nil

	default:
		return fmt.Errorf("%w: unsupported platform %s", errors.ErrUnsupported, d.goos)
	}
}

func (d *cliKeychainDriver) Retrieve(ctx context.Context, service, account string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := validateKeychainCoords(service, account); err != nil {
		return nil, err
	}

	switch d.goos {
	case "darwin":
		stdout, stderr, code, err := d.runner.Run(ctx, nil,
			"security", "find-generic-password", "-s", service, "-a", account, "-w")
		if err != nil {
			errMsg := strings.ToLower(string(stderr))
			if code == 44 || strings.Contains(errMsg, "could not be found") {
				return nil, ErrKeychainNotFound
			}
			return nil, fmt.Errorf("darwin security retrieve (exit %d): %w (%s)", code, err, strings.TrimSpace(string(stderr)))
		}
		return decodeKeychainPayload(stdout)

	case "linux":
		stdout, stderr, code, err := d.runner.Run(ctx, nil,
			"secret-tool", "lookup", "service", service, "account", account)
		if err != nil {
			if code == 1 && len(bytes.TrimSpace(stdout)) == 0 {
				return nil, ErrKeychainNotFound
			}
			return nil, fmt.Errorf("linux secret-tool retrieve (exit %d): %w (%s)", code, err, strings.TrimSpace(string(stderr)))
		}
		if len(bytes.TrimSpace(stdout)) == 0 {
			return nil, ErrKeychainNotFound
		}
		return decodeKeychainPayload(stdout)

	case "windows":
		if _, isRealOS := d.runner.(osCommandRunner); isRealOS {
			return MyGoSecretsDriver{}.Retrieve(ctx, service, account)
		}
		target := service + "/" + account
		stdout, stderr, code, err := d.runner.Run(ctx, nil,
			"powershell", "-NoProfile", "-Command", "Get-StoredCredential", target)
		if err != nil {
			if code == 44 || strings.Contains(strings.ToLower(string(stderr)), "not found") {
				return nil, ErrKeychainNotFound
			}
			return nil, fmt.Errorf("windows credential retrieve (exit %d): %w (%s)", code, err, strings.TrimSpace(string(stderr)))
		}
		return decodeKeychainPayload(stdout)

	default:
		return nil, fmt.Errorf("%w: unsupported platform %s", errors.ErrUnsupported, d.goos)
	}
}

func (d *cliKeychainDriver) Delete(ctx context.Context, service, account string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateKeychainCoords(service, account); err != nil {
		return err
	}

	switch d.goos {
	case "darwin":
		_, stderr, code, err := d.runner.Run(ctx, nil,
			"security", "delete-generic-password", "-s", service, "-a", account)
		if err != nil {
			errMsg := strings.ToLower(string(stderr))
			if code == 44 || strings.Contains(errMsg, "could not be found") {
				return nil
			}
			return fmt.Errorf("darwin security delete (exit %d): %w (%s)", code, err, strings.TrimSpace(string(stderr)))
		}
		return nil

	case "linux":
		_, stderr, code, err := d.runner.Run(ctx, nil,
			"secret-tool", "clear", "service", service, "account", account)
		if err != nil {
			if code == 1 {
				return nil
			}
			return fmt.Errorf("linux secret-tool delete (exit %d): %w (%s)", code, err, strings.TrimSpace(string(stderr)))
		}
		return nil

	case "windows":
		if _, isRealOS := d.runner.(osCommandRunner); isRealOS {
			return MyGoSecretsDriver{}.Delete(ctx, service, account)
		}
		target := service + "/" + account
		_, stderr, code, err := d.runner.Run(ctx, nil, "cmdkey", "/delete:"+target)
		if err != nil {
			if code == 44 || strings.Contains(strings.ToLower(string(stderr)), "not found") {
				return nil
			}
			return fmt.Errorf("windows credential delete (exit %d): %w (%s)", code, err, strings.TrimSpace(string(stderr)))
		}
		return nil

	default:
		return fmt.Errorf("%w: unsupported platform %s", errors.ErrUnsupported, d.goos)
	}
}

func decodeKeychainPayload(stdout []byte) ([]byte, error) {
	trimmed := strings.TrimSpace(string(stdout))
	if trimmed == "" {
		return nil, ErrKeychainNotFound
	}
	raw, err := base64.StdEncoding.DecodeString(trimmed)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid base64 payload: %v", ErrInvalidRootKey, err)
	}
	return raw, nil
}

func quoteSecurityArg(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

func validateKeychainCoords(service, account string) error {
	for name, val := range map[string]string{"service": service, "account": account} {
		if strings.TrimSpace(val) == "" {
			return fmt.Errorf("%w: %s must be non-empty", ErrInvalidRootKey, name)
		}
		if strings.ContainsAny(val, "\x00\r\n") {
			return fmt.Errorf("%w: %s contains disallowed control characters", ErrInvalidRootKey, name)
		}
	}
	return nil
}

// VaultRootKeyStore protects 32-byte internal/vault master keys via a KeychainDriver.
type VaultRootKeyStore struct {
	service string
	driver  KeychainDriver
}

// NewVaultRootKeyStore builds a VaultRootKeyStore using driver (defaulting to NewPlatformKeychainDriver).
func NewVaultRootKeyStore(service string, driver KeychainDriver) *VaultRootKeyStore {
	if strings.TrimSpace(service) == "" {
		service = defaultKeychainService
	}
	if driver == nil {
		driver = NewPlatformKeychainDriver()
	}
	return &VaultRootKeyStore{
		service: service,
		driver:  driver,
	}
}

// StoreRootKey persists a raw 32-byte master key under keyID.
func (s *VaultRootKeyStore) StoreRootKey(ctx context.Context, keyID string, raw []byte) error {
	if strings.TrimSpace(keyID) == "" {
		return fmt.Errorf("%w: empty key id", ErrInvalidRootKey)
	}
	if len(raw) != vault.RootKeySize {
		return fmt.Errorf("%w: expected %d bytes, got %d", ErrInvalidRootKey, vault.RootKeySize, len(raw))
	}
	return s.driver.Store(ctx, s.service, keyID, raw)
}

// RetrieveRootKey loads and validates a 32-byte master key from the keychain, scrubbing
// intermediate plaintext buffers before returning the redacted vault.RootKey.
func (s *VaultRootKeyStore) RetrieveRootKey(ctx context.Context, keyID string) (vault.RootKey, error) {
	if strings.TrimSpace(keyID) == "" {
		return vault.RootKey{}, fmt.Errorf("%w: empty key id", ErrInvalidRootKey)
	}
	raw, err := s.driver.Retrieve(ctx, s.service, keyID)
	if err != nil {
		return vault.RootKey{}, err
	}
	defer clear(raw)
	if len(raw) != vault.RootKeySize {
		return vault.RootKey{}, fmt.Errorf("%w: expected %d bytes, got %d", ErrInvalidRootKey, vault.RootKeySize, len(raw))
	}
	return vault.NewRootKey(keyID, raw)
}

// EnsureRootKey retrieves keyID or generates, stores, and returns a new 256-bit RootKey.
func (s *VaultRootKeyStore) EnsureRootKey(ctx context.Context, keyID string) (rk vault.RootKey, created bool, err error) {
	rk, err = s.RetrieveRootKey(ctx, keyID)
	if err == nil {
		return rk, false, nil
	}
	if !errors.Is(err, ErrKeychainNotFound) {
		return vault.RootKey{}, false, err
	}

	raw := make([]byte, vault.RootKeySize)
	defer clear(raw)
	if _, err := io.ReadFull(rand.Reader, raw); err != nil {
		return vault.RootKey{}, false, err
	}
	if err := s.StoreRootKey(ctx, keyID, raw); err != nil {
		return vault.RootKey{}, false, err
	}
	rk, err = vault.NewRootKey(keyID, raw)
	if err != nil {
		return vault.RootKey{}, false, err
	}
	return rk, true, nil
}

// DeleteRootKey removes keyID from the keychain idempotently.
func (s *VaultRootKeyStore) DeleteRootKey(ctx context.Context, keyID string) error {
	if strings.TrimSpace(keyID) == "" {
		return fmt.Errorf("%w: empty key id", ErrInvalidRootKey)
	}
	return s.driver.Delete(ctx, s.service, keyID)
}

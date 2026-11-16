package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
)

const (
	RootKeySize           = 32
	DEKSize               = 32
	GCMNonceSize          = 12
	EnvelopeVersion uint8 = 1
	gcmTagSize            = 16
)

// RootKey holds an immutable 256-bit master key used to wrap per-secret DEKs.
type RootKey struct {
	id  string
	key [RootKeySize]byte
}

// NewRootKey constructs a 256-bit master root key after validating length and non-empty id.
func NewRootKey(id string, raw []byte) (RootKey, error) {
	if strings.TrimSpace(id) == "" {
		return RootKey{}, fmt.Errorf("%w: key id must be non-empty", ErrInvalidRootKey)
	}
	if len(raw) != RootKeySize {
		return RootKey{}, fmt.Errorf("%w: expected %d bytes, got %d", ErrInvalidRootKey, RootKeySize, len(raw))
	}
	var rk RootKey
	rk.id = id
	copy(rk.key[:], raw)
	return rk, nil
}

// GenerateRootKey creates a cryptographically random 256-bit master root key.
func GenerateRootKey(id string) (RootKey, error) {
	if strings.TrimSpace(id) == "" {
		return RootKey{}, fmt.Errorf("%w: key id must be non-empty", ErrInvalidRootKey)
	}
	var raw [RootKeySize]byte
	if _, err := io.ReadFull(rand.Reader, raw[:]); err != nil {
		return RootKey{}, err
	}
	rk := RootKey{id: id, key: raw}
	clear(raw[:])
	return rk, nil
}

// ID returns the root key identifier.
func (k RootKey) ID() string {
	return k.id
}

func (k RootKey) isZero() bool {
	return k.id == ""
}

func (k RootKey) String() string {
	return fmt.Sprintf("RootKey(id=%s, %s)", k.id, redactedPlaceholder)
}

func (k RootKey) GoString() string {
	return k.String()
}

func (k RootKey) Format(f fmt.State, verb rune) {
	if verb == 'q' {
		_, _ = fmt.Fprintf(f, "%q", k.String())
		return
	}
	_, _ = io.WriteString(f, k.String())
}

func (k RootKey) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("id", k.id),
		slog.String("key", redactedPlaceholder),
	)
}

func (k RootKey) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		ID  string `json:"id"`
		Key string `json:"key"`
	}{
		ID:  k.id,
		Key: redactedPlaceholder,
	})
}

func (k RootKey) MarshalText() ([]byte, error) {
	return []byte(k.String()), nil
}

// KeyRing manages the active primary root key and prior root keys retained for decryption.
type KeyRing struct {
	mu        sync.RWMutex
	primaryID string
	keys      map[string]RootKey
}

// NewKeyRing initializes a KeyRing with one active primary root key and optional prior keys.
func NewKeyRing(primary RootKey, previous ...RootKey) (*KeyRing, error) {
	if primary.isZero() {
		return nil, fmt.Errorf("%w: primary root key is required", ErrInvalidRootKey)
	}
	keys := make(map[string]RootKey, 1+len(previous))
	keys[primary.id] = primary
	for _, k := range previous {
		if k.isZero() {
			return nil, fmt.Errorf("%w: empty previous root key", ErrInvalidRootKey)
		}
		if _, exists := keys[k.id]; exists {
			return nil, fmt.Errorf("%w: duplicate key id %q", ErrDuplicateRootKey, k.id)
		}
		keys[k.id] = k
	}
	return &KeyRing{
		primaryID: primary.id,
		keys:      keys,
	}, nil
}

// Primary returns the active master root key used for new DEK wraps.
func (kr *KeyRing) Primary() RootKey {
	kr.mu.RLock()
	defer kr.mu.RUnlock()
	return kr.keys[kr.primaryID]
}

// Lookup returns a root key by identifier if present in the ring.
func (kr *KeyRing) Lookup(id string) (RootKey, bool) {
	kr.mu.RLock()
	defer kr.mu.RUnlock()
	k, ok := kr.keys[id]
	return k, ok
}

// SetPrimary adds next to the key ring and promotes it as the active wrapping key.
func (kr *KeyRing) SetPrimary(next RootKey) error {
	if next.isZero() {
		return fmt.Errorf("%w: primary root key is required", ErrInvalidRootKey)
	}
	kr.mu.Lock()
	defer kr.mu.Unlock()
	kr.keys[next.id] = next
	kr.primaryID = next.id
	return nil
}

// RetireOthers removes and scrubs every key other than the active primary key.
func (kr *KeyRing) RetireOthers() {
	kr.mu.Lock()
	defer kr.mu.Unlock()
	for id, k := range kr.keys {
		if id == kr.primaryID {
			continue
		}
		clear(k.key[:])
		delete(kr.keys, id)
	}
}

func (kr *KeyRing) LogValue() slog.Value {
	kr.mu.RLock()
	defer kr.mu.RUnlock()
	return slog.GroupValue(
		slog.String("primaryId", kr.primaryID),
		slog.Int("keyCount", len(kr.keys)),
	)
}

func appendLengthPrefixed(dst []byte, parts ...string) []byte {
	var lenBuf [4]byte
	for _, p := range parts {
		binary.BigEndian.PutUint32(lenBuf[:], uint32(len(p)))
		dst = append(dst, lenBuf[:]...)
		dst = append(dst, p...)
	}
	return dst
}

func dekAAD(version uint8, secretID string, kind SecretKind, rootKeyID string) []byte {
	aad := make([]byte, 0, 64)
	aad = append(aad, "vibevalley.vault.dek.v1"...)
	aad = append(aad, version)
	return appendLengthPrefixed(aad, secretID, string(kind), rootKeyID)
}

func payloadAAD(version uint8, secretID string, kind SecretKind) []byte {
	aad := make([]byte, 0, 48)
	aad = append(aad, "vibevalley.vault.payload.v1"...)
	aad = append(aad, version)
	return appendLengthPrefixed(aad, secretID, string(kind))
}

func sealAESGCM(key []byte, plaintext, aad []byte) (nonce, ciphertext []byte, err error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, err
	}
	nonce = make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, nil, err
	}
	ciphertext = gcm.Seal(nil, nonce, plaintext, aad)
	return nonce, ciphertext, nil
}

func openAESGCM(key, nonce, ciphertext, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(nonce) != gcm.NonceSize() || len(ciphertext) < gcmTagSize {
		return nil, ErrCiphertextTampered
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return nil, ErrCiphertextTampered
	}
	return plaintext, nil
}

func sealEnvelopeParts(rootKey RootKey, secretID string, kind SecretKind, plaintext []byte) (
	wrappedDEKNonce, wrappedDEK, payloadNonce, ciphertext []byte, err error,
) {
	dek := make([]byte, DEKSize)
	defer clear(dek)
	if _, err := io.ReadFull(rand.Reader, dek); err != nil {
		return nil, nil, nil, nil, err
	}

	payloadNonce, ciphertext, err = sealAESGCM(dek, plaintext, payloadAAD(EnvelopeVersion, secretID, kind))
	if err != nil {
		return nil, nil, nil, nil, err
	}

	wrappedDEKNonce, wrappedDEK, err = sealAESGCM(
		rootKey.key[:],
		dek,
		dekAAD(EnvelopeVersion, secretID, kind, rootKey.id),
	)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	return wrappedDEKNonce, wrappedDEK, payloadNonce, ciphertext, nil
}

func openEnvelopeParts(kr *KeyRing, env SealedEnvelope) ([]byte, error) {
	if env.Version != EnvelopeVersion {
		return nil, fmt.Errorf("%w: unsupported envelope version %d", ErrCiphertextTampered, env.Version)
	}
	rootKey, ok := kr.Lookup(env.RootKeyID)
	if !ok {
		return nil, fmt.Errorf("%w: root key %q", ErrUnknownRootKey, env.RootKeyID)
	}

	dek, err := openAESGCM(
		rootKey.key[:],
		env.WrappedDEKNonce,
		env.WrappedDEK,
		dekAAD(env.Version, env.SecretID, env.Kind, env.RootKeyID),
	)
	if err != nil {
		return nil, err
	}
	defer clear(dek)
	if len(dek) != DEKSize {
		return nil, fmt.Errorf("%w: unexpected DEK size %d", ErrCiphertextTampered, len(dek))
	}

	plaintext, err := openAESGCM(
		dek,
		env.PayloadNonce,
		env.Ciphertext,
		payloadAAD(env.Version, env.SecretID, env.Kind),
	)
	if err != nil {
		return nil, err
	}
	return plaintext, nil
}

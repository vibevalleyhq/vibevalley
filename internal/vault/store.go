package vault

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sort"
	"sync"
	"time"
)

// SealedEnvelope holds an AES-256-GCM encrypted credential payload, wrapped DEK, and non-secret metadata.
type SealedEnvelope struct {
	Version         uint8
	SecretID        string
	Kind            SecretKind
	Name            string
	TargetHosts     []string
	Provider        string
	RootKeyID       string
	WrappedDEKNonce []byte
	WrappedDEK      []byte
	PayloadNonce    []byte
	Ciphertext      []byte
	ExpiresAtMs     *int64
	CreatedAtMs     int64
	UpdatedAtMs     int64
}

func cloneEnvelope(env SealedEnvelope) SealedEnvelope {
	out := env
	out.TargetHosts = slices.Clone(env.TargetHosts)
	out.WrappedDEKNonce = slices.Clone(env.WrappedDEKNonce)
	out.WrappedDEK = slices.Clone(env.WrappedDEK)
	out.PayloadNonce = slices.Clone(env.PayloadNonce)
	out.Ciphertext = slices.Clone(env.Ciphertext)
	if env.ExpiresAtMs != nil {
		v := *env.ExpiresAtMs
		out.ExpiresAtMs = &v
	}
	return out
}

// Backend persists SealedEnvelope records without ever seeing plaintext credentials.
type Backend interface {
	PutEnvelope(ctx context.Context, env SealedEnvelope) error
	GetEnvelope(ctx context.Context, id string) (SealedEnvelope, error)
	GetEnvelopeByName(ctx context.Context, kind SecretKind, name string) (SealedEnvelope, error)
	ListEnvelopes(ctx context.Context) ([]SealedEnvelope, error)
	DeleteEnvelope(ctx context.Context, id string) error
	ReplaceAllEnvelopes(ctx context.Context, envs []SealedEnvelope) error
}

// MemoryBackend is an in-memory thread-safe Backend implementation.
type MemoryBackend struct {
	mu   sync.RWMutex
	envs map[string]SealedEnvelope
}

// NewMemoryBackend creates an empty in-memory Backend.
func NewMemoryBackend() *MemoryBackend {
	return &MemoryBackend{
		envs: make(map[string]SealedEnvelope),
	}
}

func (b *MemoryBackend) PutEnvelope(_ context.Context, env SealedEnvelope) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.envs[env.SecretID] = cloneEnvelope(env)
	return nil
}

func (b *MemoryBackend) GetEnvelope(_ context.Context, id string) (SealedEnvelope, error) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	env, ok := b.envs[id]
	if !ok {
		return SealedEnvelope{}, ErrSecretNotFound
	}
	return cloneEnvelope(env), nil
}

func (b *MemoryBackend) GetEnvelopeByName(_ context.Context, kind SecretKind, name string) (SealedEnvelope, error) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, env := range b.envs {
		if env.Kind == kind && env.Name == name {
			return cloneEnvelope(env), nil
		}
	}
	return SealedEnvelope{}, ErrSecretNotFound
}

func (b *MemoryBackend) ListEnvelopes(_ context.Context) ([]SealedEnvelope, error) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	out := make([]SealedEnvelope, 0, len(b.envs))
	for _, env := range b.envs {
		out = append(out, cloneEnvelope(env))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAtMs != out[j].CreatedAtMs {
			return out[i].CreatedAtMs < out[j].CreatedAtMs
		}
		return out[i].SecretID < out[j].SecretID
	})
	return out, nil
}

func (b *MemoryBackend) DeleteEnvelope(_ context.Context, id string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.envs[id]; !ok {
		return ErrSecretNotFound
	}
	delete(b.envs, id)
	return nil
}

func (b *MemoryBackend) ReplaceAllEnvelopes(_ context.Context, envs []SealedEnvelope) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	next := make(map[string]SealedEnvelope, len(envs))
	for _, env := range envs {
		next[env.SecretID] = cloneEnvelope(env)
	}
	b.envs = next
	return nil
}

type sealedPayload struct {
	SecretID     string            `json:"id"`
	Kind         SecretKind        `json:"kind"`
	Name         string            `json:"name"`
	TargetHosts  []string          `json:"targetHosts,omitempty"`
	Provider     string            `json:"provider,omitempty"`
	HeaderName   string            `json:"headerName,omitempty"`
	HeaderPrefix string            `json:"headerPrefix,omitempty"`
	Username     string            `json:"username,omitempty"`
	TokenType    string            `json:"tokenType,omitempty"`
	Scopes       []string          `json:"scopes,omitempty"`
	ExpiresAtMs  *int64            `json:"expiresAtMs,omitempty"`
	Value        string            `json:"value"`
	RefreshToken string            `json:"refreshToken,omitempty"`
	ExtraHeaders map[string]string `json:"extraHeaders,omitempty"`
}

// StoreOption configures optional Store dependencies such as clock and logger.
type StoreOption func(*Store)

// WithStoreClock sets the time source used for CreatedAt/UpdatedAt timestamps.
func WithStoreClock(clock func() time.Time) StoreOption {
	return func(s *Store) {
		if clock != nil {
			s.clock = clock
		}
	}
}

// WithStoreLogger attaches a structured logger to Store (only non-secret metadata is logged).
func WithStoreLogger(logger *slog.Logger) StoreOption {
	return func(s *Store) {
		if logger != nil {
			s.logger = logger
		}
	}
}

// Store encrypts, stores, decrypts, and rotates vault credentials using AES-256-GCM envelope encryption.
type Store struct {
	mu      sync.RWMutex
	kr      *KeyRing
	backend Backend
	clock   func() time.Time
	logger  *slog.Logger
}

// NewStore builds a credential store over kr and backend (defaults to MemoryBackend when nil).
func NewStore(kr *KeyRing, backend Backend, opts ...StoreOption) (*Store, error) {
	if kr == nil {
		return nil, fmt.Errorf("%w: keyring is required", ErrInvalidRootKey)
	}
	if backend == nil {
		backend = NewMemoryBackend()
	}
	s := &Store{
		kr:      kr,
		backend: backend,
		clock:   time.Now,
		logger:  slog.Default(),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s, nil
}

// Put encrypts and persists a credential with a fresh 256-bit DEK wrapped by the active root key.
func (s *Store) Put(ctx context.Context, cred Credential) error {
	normalized, err := normalizeCredential(cred)
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	nowMs := s.clock().UTC().UnixMilli()
	createdAtMs := nowMs
	if existing, getErr := s.backend.GetEnvelope(ctx, normalized.ID); getErr == nil {
		createdAtMs = existing.CreatedAtMs
	} else if !errors.Is(getErr, ErrSecretNotFound) {
		return getErr
	}

	env, err := s.sealCredentialLocked(s.kr.Primary(), normalized, createdAtMs, nowMs)
	if err != nil {
		return err
	}
	if err := s.backend.PutEnvelope(ctx, env); err != nil {
		return err
	}
	s.logger.DebugContext(ctx, "vault credential stored",
		slog.String("secretId", env.SecretID),
		slog.String("kind", string(env.Kind)),
		slog.String("rootKeyId", env.RootKeyID),
	)
	return nil
}

// Get decrypts and returns a credential by ID.
func (s *Store) Get(ctx context.Context, id string) (Credential, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	env, err := s.backend.GetEnvelope(ctx, id)
	if err != nil {
		return Credential{}, err
	}
	return s.openCredentialLocked(env)
}

// GetByName decrypts and returns a credential matching (kind, name).
func (s *Store) GetByName(ctx context.Context, kind SecretKind, name string) (Credential, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	env, err := s.backend.GetEnvelopeByName(ctx, kind, name)
	if err != nil {
		return Credential{}, err
	}
	return s.openCredentialLocked(env)
}

// ListMetadata returns non-secret credential metadata without decrypting payloads.
func (s *Store) ListMetadata(ctx context.Context) ([]CredentialMetadata, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	envs, err := s.backend.ListEnvelopes(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]CredentialMetadata, len(envs))
	for i, env := range envs {
		out[i] = metadataFromEnvelope(env)
	}
	return out, nil
}

// Delete removes a credential by ID.
func (s *Store) Delete(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.backend.DeleteEnvelope(ctx, id); err != nil {
		return err
	}
	s.logger.DebugContext(ctx, "vault credential deleted", slog.String("secretId", id))
	return nil
}

// RotateDEK re-encrypts a single credential under a fresh 256-bit DEK and the active primary root key.
func (s *Store) RotateDEK(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	env, err := s.backend.GetEnvelope(ctx, id)
	if err != nil {
		return err
	}
	cred, err := s.openCredentialLocked(env)
	if err != nil {
		return err
	}

	nowMs := s.clock().UTC().UnixMilli()
	rotated, err := s.sealCredentialLocked(s.kr.Primary(), cred, env.CreatedAtMs, nowMs)
	if err != nil {
		return err
	}
	if err := s.backend.PutEnvelope(ctx, rotated); err != nil {
		return err
	}
	s.logger.DebugContext(ctx, "vault DEK rotated",
		slog.String("secretId", rotated.SecretID),
		slog.String("rootKeyId", rotated.RootKeyID),
	)
	return nil
}

// RotateRootKey activates next as primary, re-seals every stored credential with a fresh DEK under next,
// replaces all stored envelopes atomically, and retires previous root keys from the keyring.
func (s *Store) RotateRootKey(ctx context.Context, next RootKey) error {
	if next.isZero() {
		return fmt.Errorf("%w: primary root key is required", ErrInvalidRootKey)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	envs, err := s.backend.ListEnvelopes(ctx)
	if err != nil {
		return err
	}

	nowMs := s.clock().UTC().UnixMilli()
	reencrypted := make([]SealedEnvelope, 0, len(envs))
	for _, env := range envs {
		cred, openErr := s.openCredentialLocked(env)
		if openErr != nil {
			return openErr
		}
		sealed, sealErr := s.sealCredentialLocked(next, cred, env.CreatedAtMs, nowMs)
		if sealErr != nil {
			return sealErr
		}
		reencrypted = append(reencrypted, sealed)
	}

	if err := s.backend.ReplaceAllEnvelopes(ctx, reencrypted); err != nil {
		return err
	}
	if err := s.kr.SetPrimary(next); err != nil {
		return err
	}
	s.kr.RetireOthers()

	s.logger.InfoContext(ctx, "vault root key rotated",
		slog.String("rootKeyId", next.ID()),
		slog.Int("reencryptedCount", len(reencrypted)),
	)
	return nil
}

// ReencryptAll re-seals all envelopes with fresh DEKs under the current active primary root key.
func (s *Store) ReencryptAll(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	primary := s.kr.Primary()
	envs, err := s.backend.ListEnvelopes(ctx)
	if err != nil {
		return err
	}

	nowMs := s.clock().UTC().UnixMilli()
	reencrypted := make([]SealedEnvelope, 0, len(envs))
	for _, env := range envs {
		cred, openErr := s.openCredentialLocked(env)
		if openErr != nil {
			return openErr
		}
		sealed, sealErr := s.sealCredentialLocked(primary, cred, env.CreatedAtMs, nowMs)
		if sealErr != nil {
			return sealErr
		}
		reencrypted = append(reencrypted, sealed)
	}
	return s.backend.ReplaceAllEnvelopes(ctx, reencrypted)
}

// FindForTarget returns metadata for stored credentials matching kind and target host/port.
func (s *Store) FindForTarget(ctx context.Context, kind SecretKind, target TargetEndpoint) ([]CredentialMetadata, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	envs, err := s.backend.ListEnvelopes(ctx)
	if err != nil {
		return nil, err
	}

	var matches []CredentialMetadata
	for _, env := range envs {
		if kind != "" && env.Kind != kind {
			continue
		}
		if len(env.TargetHosts) == 0 {
			continue
		}
		ok, matchErr := MatchRawHostPatterns(env.TargetHosts, target)
		if matchErr != nil || !ok {
			continue
		}
		matches = append(matches, metadataFromEnvelope(env))
	}
	return matches, nil
}

func (s *Store) sealCredentialLocked(rootKey RootKey, cred Credential, createdAtMs, updatedAtMs int64) (SealedEnvelope, error) {
	var expiresAtMs *int64
	if cred.ExpiresAt != nil {
		ms := cred.ExpiresAt.UTC().UnixMilli()
		expiresAtMs = &ms
	}

	var extraHeaders map[string]string
	if len(cred.ExtraHeaders) > 0 {
		extraHeaders = make(map[string]string, len(cred.ExtraHeaders))
		for k, v := range cred.ExtraHeaders {
			extraHeaders[k] = v.Reveal()
		}
	}

	payload := sealedPayload{
		SecretID:     cred.ID,
		Kind:         cred.Kind,
		Name:         cred.Name,
		TargetHosts:  slices.Clone(cred.TargetHosts),
		Provider:     cred.Provider,
		HeaderName:   cred.HeaderName,
		HeaderPrefix: cred.HeaderPrefix,
		Username:     cred.Username,
		TokenType:    cred.TokenType,
		Scopes:       slices.Clone(cred.Scopes),
		ExpiresAtMs:  expiresAtMs,
		Value:        cred.Value.Reveal(),
		RefreshToken: cred.RefreshToken.Reveal(),
		ExtraHeaders: extraHeaders,
	}

	plaintext, err := json.Marshal(payload)
	if err != nil {
		return SealedEnvelope{}, err
	}
	defer clear(plaintext)

	wrappedDEKNonce, wrappedDEK, payloadNonce, ciphertext, err := sealEnvelopeParts(rootKey, cred.ID, cred.Kind, plaintext)
	if err != nil {
		return SealedEnvelope{}, err
	}

	return SealedEnvelope{
		Version:         EnvelopeVersion,
		SecretID:        cred.ID,
		Kind:            cred.Kind,
		Name:            cred.Name,
		TargetHosts:     slices.Clone(cred.TargetHosts),
		Provider:        cred.Provider,
		RootKeyID:       rootKey.ID(),
		WrappedDEKNonce: wrappedDEKNonce,
		WrappedDEK:      wrappedDEK,
		PayloadNonce:    payloadNonce,
		Ciphertext:      ciphertext,
		ExpiresAtMs:     expiresAtMs,
		CreatedAtMs:     createdAtMs,
		UpdatedAtMs:     updatedAtMs,
	}, nil
}

func (s *Store) openCredentialLocked(env SealedEnvelope) (Credential, error) {
	plaintext, err := openEnvelopeParts(s.kr, env)
	if err != nil {
		return Credential{}, err
	}
	defer clear(plaintext)

	var payload sealedPayload
	if err := json.Unmarshal(plaintext, &payload); err != nil {
		return Credential{}, fmt.Errorf("%w: %v", ErrCiphertextTampered, err)
	}

	// Cross-check unencrypted database metadata against authenticated payload to stop column tampering.
	if payload.SecretID != env.SecretID ||
		payload.Kind != env.Kind ||
		payload.Name != env.Name ||
		payload.Provider != env.Provider ||
		!slices.Equal(payload.TargetHosts, env.TargetHosts) ||
		!equalOptInt64(payload.ExpiresAtMs, env.ExpiresAtMs) {
		return Credential{}, fmt.Errorf("%w: envelope metadata mismatch", ErrCiphertextTampered)
	}

	var expiresAt *time.Time
	if payload.ExpiresAtMs != nil {
		t := time.UnixMilli(*payload.ExpiresAtMs).UTC()
		expiresAt = &t
	}

	var extraHeaders map[string]Secret
	if len(payload.ExtraHeaders) > 0 {
		extraHeaders = make(map[string]Secret, len(payload.ExtraHeaders))
		for k, v := range payload.ExtraHeaders {
			extraHeaders[k] = NewSecret(v)
		}
	}

	return Credential{
		ID:           payload.SecretID,
		Kind:         payload.Kind,
		Name:         payload.Name,
		TargetHosts:  slices.Clone(payload.TargetHosts),
		Provider:     payload.Provider,
		HeaderName:   payload.HeaderName,
		HeaderPrefix: payload.HeaderPrefix,
		Username:     payload.Username,
		TokenType:    payload.TokenType,
		Scopes:       slices.Clone(payload.Scopes),
		ExpiresAt:    expiresAt,
		Value:        NewSecret(payload.Value),
		RefreshToken: NewSecret(payload.RefreshToken),
		ExtraHeaders: extraHeaders,
	}, nil
}

func metadataFromEnvelope(env SealedEnvelope) CredentialMetadata {
	var expiresAt *time.Time
	if env.ExpiresAtMs != nil {
		t := time.UnixMilli(*env.ExpiresAtMs).UTC()
		expiresAt = &t
	}
	return CredentialMetadata{
		ID:          env.SecretID,
		Kind:        env.Kind,
		Name:        env.Name,
		TargetHosts: slices.Clone(env.TargetHosts),
		Provider:    env.Provider,
		RootKeyID:   env.RootKeyID,
		ExpiresAt:   expiresAt,
		CreatedAt:   time.UnixMilli(env.CreatedAtMs).UTC(),
		UpdatedAt:   time.UnixMilli(env.UpdatedAtMs).UTC(),
	}
}

func equalOptInt64(a, b *int64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

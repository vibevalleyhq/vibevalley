package vault

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

const (
	DefaultTokenTTL = 15 * time.Minute
	SigningKeySize  = 32
	TokenPrefix     = "vvcap1."

	CapGitRead      = "git:read"
	CapGitWrite     = "git:write"
	CapMCPCall      = "mcp:call"
	CapProviderCall = "provider:call"
	CapHTTPEgress   = "http:egress"
)

// SigningKey holds an HMAC-SHA256 key (at least 256 bits) for signing capability tokens.
type SigningKey struct {
	id  string
	key []byte
}

// NewSigningKey builds a validated HMAC-SHA256 signing key.
func NewSigningKey(id string, raw []byte) (SigningKey, error) {
	if strings.TrimSpace(id) == "" {
		return SigningKey{}, fmt.Errorf("%w: key id must be non-empty", ErrInvalidSigningKey)
	}
	if len(raw) < SigningKeySize {
		return SigningKey{}, fmt.Errorf("%w: expected at least %d bytes, got %d", ErrInvalidSigningKey, SigningKeySize, len(raw))
	}
	return SigningKey{
		id:  id,
		key: slices.Clone(raw),
	}, nil
}

// GenerateSigningKey generates a random 256-bit HMAC-SHA256 signing key.
func GenerateSigningKey(id string) (SigningKey, error) {
	if strings.TrimSpace(id) == "" {
		return SigningKey{}, fmt.Errorf("%w: key id must be non-empty", ErrInvalidSigningKey)
	}
	raw := make([]byte, SigningKeySize)
	if _, err := io.ReadFull(rand.Reader, raw); err != nil {
		return SigningKey{}, err
	}
	defer clear(raw)
	return NewSigningKey(id, raw)
}

func (k SigningKey) ID() string {
	return k.id
}

func (k SigningKey) isZero() bool {
	return k.id == "" || len(k.key) < SigningKeySize
}

func (k SigningKey) String() string {
	return fmt.Sprintf("SigningKey(id=%s, %s)", k.id, redactedPlaceholder)
}

func (k SigningKey) GoString() string {
	return k.String()
}

func (k SigningKey) Format(f fmt.State, verb rune) {
	if verb == 'q' {
		_, _ = fmt.Fprintf(f, "%q", k.String())
		return
	}
	_, _ = io.WriteString(f, k.String())
}

func (k SigningKey) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("id", k.id),
		slog.String("key", redactedPlaceholder),
	)
}

func (k SigningKey) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		ID  string `json:"id"`
		Key string `json:"key"`
	}{
		ID:  k.id,
		Key: redactedPlaceholder,
	})
}

func (k SigningKey) MarshalText() ([]byte, error) {
	return []byte(k.String()), nil
}

// IssueTokenRequest configures a short-lived session capability token.
type IssueTokenRequest struct {
	PrincipalID  string
	SessionID    string
	Capabilities []string
	AllowedHosts []string
	SecretIDs    []string
	TTL          time.Duration
}

// IssuedToken wraps a newly minted short-lived capability token and its principal metadata.
type IssuedToken struct {
	TokenID   string             `json:"tokenId"`
	Token     Secret             `json:"token"`
	Principal contract.Principal `json:"principal"`
	IssuedAt  time.Time          `json:"issuedAt"`
	ExpiresAt time.Time          `json:"expiresAt"`
	SecretIDs []string           `json:"secretIds,omitempty"`
}

func (t IssuedToken) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("tokenId", t.TokenID),
		slog.String("token", redactedPlaceholder),
		slog.String("sessionId", t.Principal.SessionID),
		slog.String("principalId", t.Principal.ID),
		slog.Any("capabilities", t.Principal.Capabilities),
		slog.Any("allowedHosts", t.Principal.AllowedHosts),
		slog.Time("expiresAt", t.ExpiresAt),
	)
}

// VerifiedToken holds validated claims decoded from a capability token.
type VerifiedToken struct {
	TokenID            string
	Principal          contract.Principal
	IssuedAt           time.Time
	ExpiresAt          time.Time
	SecretIDs          []string
	ParsedAllowedHosts []HostPattern
}

// HasCapability reports whether the verified token includes cap.
func (t VerifiedToken) HasCapability(cap string) bool {
	return slices.Contains(t.Principal.Capabilities, cap)
}

// AllowsSecret reports whether the verified token permits using secretID.
// When SecretIDs is empty, secret authorization falls back to capability + host binding.
func (t VerifiedToken) AllowsSecret(secretID string) bool {
	if len(t.SecretIDs) == 0 {
		return true
	}
	return slices.Contains(t.SecretIDs, secretID)
}

// TokenIssuer issues short-lived capability tokens bound to session, capabilities, and allowed hosts.
type TokenIssuer interface {
	Issue(ctx context.Context, req IssueTokenRequest) (IssuedToken, error)
}

// TokenVerifier validates capability tokens and enforces optional session/capability/host predicates.
type TokenVerifier interface {
	Verify(ctx context.Context, rawToken string, opts ...VerifyOption) (VerifiedToken, error)
}

// TokenOption configures TokenService.
type TokenOption func(*TokenService)

// WithTokenClock overrides the clock used for issuing and checking token lifetimes.
func WithTokenClock(clock func() time.Time) TokenOption {
	return func(s *TokenService) {
		if clock != nil {
			s.clock = clock
		}
	}
}

// WithDefaultTTL overrides the default token TTL (defaults to DefaultTokenTTL = 15m).
func WithDefaultTTL(ttl time.Duration) TokenOption {
	return func(s *TokenService) {
		if ttl > 0 {
			s.defaultTTL = ttl
		}
	}
}

// WithMaxTTL sets a hard ceiling on issued token lifetimes.
func WithMaxTTL(maxTTL time.Duration) TokenOption {
	return func(s *TokenService) {
		if maxTTL > 0 {
			s.maxTTL = maxTTL
		}
	}
}

// WithPreviousSigningKeys registers older signing keys that remain valid for verification during rotation.
func WithPreviousSigningKeys(keys ...SigningKey) TokenOption {
	return func(s *TokenService) {
		for _, k := range keys {
			if !k.isZero() {
				s.keys[k.id] = SigningKey{id: k.id, key: slices.Clone(k.key)}
			}
		}
	}
}

// WithTokenLogger attaches a structured logger to TokenService (raw tokens are never logged).
func WithTokenLogger(logger *slog.Logger) TokenOption {
	return func(s *TokenService) {
		if logger != nil {
			s.logger = logger
		}
	}
}

// VerifyOption adds extra assertions during capability token verification.
type VerifyOption func(*verifyChecks)

type verifyChecks struct {
	expectedSession    string
	requiredCapability string
	requiredSecretID   string
	requiredEndpoint   *TargetEndpoint
}

// WithExpectedSession requires the token's Principal.SessionID to match sessionID.
func WithExpectedSession(sessionID string) VerifyOption {
	return func(c *verifyChecks) {
		c.expectedSession = sessionID
	}
}

// WithRequiredCapability requires the token's Principal.Capabilities to include cap.
func WithRequiredCapability(cap string) VerifyOption {
	return func(c *verifyChecks) {
		c.requiredCapability = cap
	}
}

// WithRequiredSecretID requires the token to authorize secretID if SecretIDs are restricted.
func WithRequiredSecretID(secretID string) VerifyOption {
	return func(c *verifyChecks) {
		c.requiredSecretID = secretID
	}
}

// WithRequiredHost requires the token's Principal.AllowedHosts to permit target.
func WithRequiredHost(target TargetEndpoint) VerifyOption {
	return func(c *verifyChecks) {
		t := target
		c.requiredEndpoint = &t
	}
}

type tokenClaims struct {
	Version     int                `json:"v"`
	TokenID     string             `json:"jti"`
	KeyID       string             `json:"kid"`
	Principal   contract.Principal `json:"principal"`
	IssuedAtMs  int64              `json:"iatMs"`
	NotBeforeMs int64              `json:"nbfMs"`
	SecretIDs   []string           `json:"secretIds,omitempty"`
}

// TokenService issues, verifies, revokes, and rotates HMAC-SHA256 capability tokens.
type TokenService struct {
	mu              sync.RWMutex
	primaryID       string
	keys            map[string]SigningKey
	revokedTokens   map[string]struct{}
	revokedSessions map[string]struct{}
	defaultTTL      time.Duration
	maxTTL          time.Duration
	clock           func() time.Time
	logger          *slog.Logger
}

// NewTokenService constructs an HMAC-SHA256 capability token issuer & verifier.
func NewTokenService(primary SigningKey, opts ...TokenOption) (*TokenService, error) {
	if primary.isZero() {
		return nil, fmt.Errorf("%w: primary signing key is required", ErrInvalidSigningKey)
	}
	s := &TokenService{
		primaryID:       primary.id,
		keys:            map[string]SigningKey{primary.id: {id: primary.id, key: slices.Clone(primary.key)}},
		revokedTokens:   make(map[string]struct{}),
		revokedSessions: make(map[string]struct{}),
		defaultTTL:      DefaultTokenTTL,
		clock:           time.Now,
		logger:          slog.Default(),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s, nil
}

// RotateSigningKey installs next as the active signing key while keeping previous keys for verification.
func (s *TokenService) RotateSigningKey(next SigningKey) error {
	if next.isZero() {
		return fmt.Errorf("%w: signing key is required", ErrInvalidSigningKey)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.keys[next.id] = SigningKey{id: next.id, key: slices.Clone(next.key)}
	s.primaryID = next.id
	return nil
}

// RetireOtherSigningKeys scrubs and deletes all signing keys other than the active primary key.
func (s *TokenService) RetireOtherSigningKeys() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, k := range s.keys {
		if id == s.primaryID {
			continue
		}
		clear(k.key)
		delete(s.keys, id)
	}
}

// RevokeToken invalidates a specific token ID immediately.
func (s *TokenService) RevokeToken(tokenID string) {
	if tokenID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.revokedTokens[tokenID] = struct{}{}
}

// RevokeSession invalidates all capability tokens bound to sessionID immediately.
func (s *TokenService) RevokeSession(sessionID string) {
	if sessionID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.revokedSessions[sessionID] = struct{}{}
}

// Issue mints a new HMAC-SHA256 capability token bound to SessionID, Capabilities, and AllowedHosts.
func (s *TokenService) Issue(ctx context.Context, req IssueTokenRequest) (IssuedToken, error) {
	if strings.TrimSpace(req.SessionID) == "" || strings.ContainsAny(req.SessionID, " \t\r\n") {
		return IssuedToken{}, fmt.Errorf("%w: sessionId is required without whitespace", ErrSessionMismatch)
	}
	caps, err := normalizeNonEmptyList(req.Capabilities)
	if err != nil || len(caps) == 0 {
		return IssuedToken{}, fmt.Errorf("%w: at least one capability is required", ErrCapabilityDenied)
	}

	patterns, err := ValidateHostPatterns(req.AllowedHosts)
	if err != nil {
		return IssuedToken{}, err
	}
	normHosts := make([]string, len(patterns))
	for i, p := range patterns {
		normHosts[i] = p.Raw
	}

	secretIDs, err := normalizeOptionalList(req.SecretIDs)
	if err != nil {
		return IssuedToken{}, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}

	principalID := strings.TrimSpace(req.PrincipalID)
	if principalID == "" {
		principalID = "session:" + req.SessionID
	}

	s.mu.RLock()
	primary := s.keys[s.primaryID]
	defaultTTL := s.defaultTTL
	maxTTL := s.maxTTL
	clock := s.clock
	s.mu.RUnlock()

	ttl := req.TTL
	if ttl < 0 {
		return IssuedToken{}, fmt.Errorf("%w: negative TTL", ErrInvalidToken)
	}
	if ttl == 0 {
		ttl = defaultTTL
	}
	if maxTTL > 0 && ttl > maxTTL {
		return IssuedToken{}, fmt.Errorf("%w: requested TTL %s exceeds max %s", ErrInvalidToken, ttl, maxTTL)
	}

	now := clock().UTC()
	expiresAt := now.Add(ttl)

	var jtiRaw [16]byte
	if _, err := io.ReadFull(rand.Reader, jtiRaw[:]); err != nil {
		return IssuedToken{}, err
	}
	tokenID := hex.EncodeToString(jtiRaw[:])

	principal := contract.Principal{
		Kind:         contract.PrincipalSessionToken,
		ID:           principalID,
		SessionID:    req.SessionID,
		Capabilities: caps,
		AllowedHosts: normHosts,
		ExpiresAtMs:  expiresAt.UnixMilli(),
	}

	claims := tokenClaims{
		Version:     1,
		TokenID:     tokenID,
		KeyID:       primary.id,
		Principal:   principal,
		IssuedAtMs:  now.UnixMilli(),
		NotBeforeMs: now.UnixMilli(),
		SecretIDs:   secretIDs,
	}

	payloadJSON, err := json.Marshal(claims)
	if err != nil {
		return IssuedToken{}, err
	}

	signingInput := TokenPrefix + base64.RawURLEncoding.EncodeToString(payloadJSON)
	mac := hmac.New(sha256.New, primary.key)
	_, _ = mac.Write([]byte(signingInput))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	rawToken := signingInput + "." + sig

	s.logger.DebugContext(ctx, "vault capability token issued",
		slog.String("tokenId", tokenID),
		slog.String("sessionId", principal.SessionID),
		slog.String("principalId", principal.ID),
		slog.Time("expiresAt", expiresAt),
	)

	return IssuedToken{
		TokenID:   tokenID,
		Token:     NewSecret(rawToken),
		Principal: clonePrincipal(principal),
		IssuedAt:  now,
		ExpiresAt: expiresAt,
		SecretIDs: slices.Clone(secretIDs),
	}, nil
}

// IssueForPrincipal mints a session capability token directly from a contract.Principal.
func (s *TokenService) IssueForPrincipal(ctx context.Context, p contract.Principal, ttl time.Duration) (IssuedToken, error) {
	if p.Kind != "" && p.Kind != contract.PrincipalSessionToken {
		return IssuedToken{}, fmt.Errorf("%w: unsupported principal kind %q for capability token", ErrInvalidToken, p.Kind)
	}
	if ttl == 0 && p.ExpiresAtMs > 0 {
		s.mu.RLock()
		now := s.clock().UTC()
		s.mu.RUnlock()
		ttl = time.UnixMilli(p.ExpiresAtMs).UTC().Sub(now)
		if ttl <= 0 {
			return IssuedToken{}, fmt.Errorf("%w: principal expiresAtMs is not in the future", ErrTokenExpired)
		}
	}
	return s.Issue(ctx, IssueTokenRequest{
		PrincipalID:  p.ID,
		SessionID:    p.SessionID,
		Capabilities: p.Capabilities,
		AllowedHosts: p.AllowedHosts,
		TTL:          ttl,
	})
}

// Verify checks token signature, claims integrity, revocation, expiry, and optional verification checks.
func (s *TokenService) Verify(ctx context.Context, rawToken string, opts ...VerifyOption) (VerifiedToken, error) {
	if !strings.HasPrefix(rawToken, TokenPrefix) || strings.ContainsAny(rawToken, " \t\r\n") {
		return VerifiedToken{}, ErrInvalidToken
	}
	rest := strings.TrimPrefix(rawToken, TokenPrefix)
	payloadB64, sigB64, ok := strings.Cut(rest, ".")
	if !ok || payloadB64 == "" || sigB64 == "" || strings.Contains(sigB64, ".") {
		return VerifiedToken{}, ErrInvalidToken
	}

	gotMAC, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil || len(gotMAC) != sha256.Size {
		return VerifiedToken{}, ErrInvalidToken
	}

	payloadJSON, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return VerifiedToken{}, ErrInvalidToken
	}

	var claims tokenClaims
	dec := json.NewDecoder(bytes.NewReader(payloadJSON))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&claims); err != nil {
		return VerifiedToken{}, fmt.Errorf("%w: malformed claims", ErrInvalidToken)
	}
	if dec.More() {
		return VerifiedToken{}, fmt.Errorf("%w: trailing claims data", ErrInvalidToken)
	}

	s.mu.RLock()
	key, hasKey := s.keys[claims.KeyID]
	_, tokenRevoked := s.revokedTokens[claims.TokenID]
	_, sessionRevoked := s.revokedSessions[claims.Principal.SessionID]
	now := s.clock().UTC()
	s.mu.RUnlock()

	if !hasKey {
		return VerifiedToken{}, fmt.Errorf("%w: unknown signing key %q", ErrInvalidToken, claims.KeyID)
	}

	signingInput := TokenPrefix + payloadB64
	mac := hmac.New(sha256.New, key.key)
	_, _ = mac.Write([]byte(signingInput))
	expectedMAC := mac.Sum(nil)
	if !hmac.Equal(expectedMAC, gotMAC) {
		return VerifiedToken{}, fmt.Errorf("%w: signature mismatch", ErrInvalidToken)
	}

	if claims.Version != 1 ||
		claims.TokenID == "" ||
		claims.Principal.Kind != contract.PrincipalSessionToken ||
		claims.Principal.ID == "" ||
		claims.Principal.SessionID == "" ||
		len(claims.Principal.Capabilities) == 0 ||
		claims.Principal.ExpiresAtMs <= 0 {
		return VerifiedToken{}, fmt.Errorf("%w: incomplete claims", ErrInvalidToken)
	}

	if tokenRevoked || sessionRevoked {
		return VerifiedToken{}, ErrTokenRevoked
	}

	nowMs := now.UnixMilli()
	if nowMs < claims.NotBeforeMs {
		return VerifiedToken{}, ErrTokenNotYetValid
	}
	if nowMs >= claims.Principal.ExpiresAtMs {
		return VerifiedToken{}, ErrTokenExpired
	}

	patterns, err := ValidateHostPatterns(claims.Principal.AllowedHosts)
	if err != nil {
		return VerifiedToken{}, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}

	var checks verifyChecks
	for _, opt := range opts {
		if opt != nil {
			opt(&checks)
		}
	}
	if checks.expectedSession != "" && claims.Principal.SessionID != checks.expectedSession {
		return VerifiedToken{}, fmt.Errorf("%w: expected %q, got %q", ErrSessionMismatch, checks.expectedSession, claims.Principal.SessionID)
	}
	if checks.requiredCapability != "" && !slices.Contains(claims.Principal.Capabilities, checks.requiredCapability) {
		return VerifiedToken{}, fmt.Errorf("%w: missing capability %q", ErrCapabilityDenied, checks.requiredCapability)
	}
	if checks.requiredSecretID != "" && len(claims.SecretIDs) > 0 && !slices.Contains(claims.SecretIDs, checks.requiredSecretID) {
		return VerifiedToken{}, fmt.Errorf("%w: token not bound to secret %q", ErrCapabilityDenied, checks.requiredSecretID)
	}
	if checks.requiredEndpoint != nil && !MatchHostPatterns(patterns, *checks.requiredEndpoint) {
		return VerifiedToken{}, fmt.Errorf("%w: host %s:%s not in allowed_hosts", ErrHostDenied, checks.requiredEndpoint.Host, checks.requiredEndpoint.Port)
	}

	verified := VerifiedToken{
		TokenID:            claims.TokenID,
		Principal:          clonePrincipal(claims.Principal),
		IssuedAt:           time.UnixMilli(claims.IssuedAtMs).UTC(),
		ExpiresAt:          time.UnixMilli(claims.Principal.ExpiresAtMs).UTC(),
		SecretIDs:          slices.Clone(claims.SecretIDs),
		ParsedAllowedHosts: patterns,
	}

	s.logger.DebugContext(ctx, "vault capability token verified",
		slog.String("tokenId", verified.TokenID),
		slog.String("sessionId", verified.Principal.SessionID),
	)
	return verified, nil
}

func clonePrincipal(p contract.Principal) contract.Principal {
	out := p
	out.Capabilities = slices.Clone(p.Capabilities)
	out.AllowedHosts = slices.Clone(p.AllowedHosts)
	return out
}

func normalizeNonEmptyList(items []string) ([]string, error) {
	seen := make(map[string]struct{}, len(items))
	out := make([]string, 0, len(items))
	for _, raw := range items {
		item := strings.TrimSpace(raw)
		if item == "" || item != raw {
			return nil, fmt.Errorf("invalid blank or padded item %q", raw)
		}
		if _, exists := seen[item]; exists {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	return out, nil
}

func normalizeOptionalList(items []string) ([]string, error) {
	if len(items) == 0 {
		return nil, nil
	}
	return normalizeNonEmptyList(items)
}

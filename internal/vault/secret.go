package vault

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"strings"
	"time"
)

const redactedPlaceholder = "[secret]"

// SecretKind enumerates the credential domains stored in the vault.
type SecretKind string

const (
	KindProviderAPIKey SecretKind = "provider_api_key"
	KindGitCredential  SecretKind = "git_credential"
	KindMCPOAuthToken  SecretKind = "mcp_oauth_token"
)

// IsValid reports whether k is a supported credential kind.
func (k SecretKind) IsValid() bool {
	switch k {
	case KindProviderAPIKey, KindGitCredential, KindMCPOAuthToken:
		return true
	default:
		return false
	}
}

// Secret holds sensitive material that redacts itself in fmt, JSON, text, and slog output.
type Secret struct {
	box *secretBox
}

type secretBox struct {
	value string
}

// NewSecret wraps raw secret material inside a redacted Secret value.
func NewSecret(value string) Secret {
	if value == "" {
		return Secret{}
	}
	return Secret{box: &secretBox{value: value}}
}

// NewSecretFromBytes copies b into a redacted Secret value.
func NewSecretFromBytes(b []byte) Secret {
	if len(b) == 0 {
		return Secret{}
	}
	return Secret{box: &secretBox{value: string(b)}}
}

// Reveal returns the raw secret string; call only at the explicit exit injection boundary.
func (s Secret) Reveal() string {
	if s.box == nil {
		return ""
	}
	return s.box.value
}

// RevealBytes returns a fresh copy of the raw secret bytes; callers should clear the slice after use.
func (s Secret) RevealBytes() []byte {
	if s.box == nil || len(s.box.value) == 0 {
		return nil
	}
	return []byte(s.box.value)
}

// IsEmpty reports whether the secret holds no value.
func (s Secret) IsEmpty() bool {
	return s.box == nil || len(s.box.value) == 0
}

// Equal performs constant-time comparison against another Secret.
func (s Secret) Equal(other Secret) bool {
	return subtle.ConstantTimeCompare([]byte(s.Reveal()), []byte(other.Reveal())) == 1
}

// Hint returns a masked display hint when the secret is long enough, never exposing short keys.
func (s Secret) Hint() string {
	v := s.Reveal()
	if len(v) < 8 {
		return redactedPlaceholder
	}
	return "…" + v[len(v)-4:]
}

func (s Secret) String() string {
	return redactedPlaceholder
}

func (s Secret) GoString() string {
	return redactedPlaceholder
}

func (s Secret) Format(f fmt.State, verb rune) {
	if verb == 'q' {
		_, _ = io.WriteString(f, `"`+redactedPlaceholder+`"`)
		return
	}
	_, _ = io.WriteString(f, redactedPlaceholder)
}

func (s Secret) LogValue() slog.Value {
	return slog.StringValue(redactedPlaceholder)
}

func (s Secret) MarshalJSON() ([]byte, error) {
	return json.Marshal(redactedPlaceholder)
}

func (s Secret) MarshalText() ([]byte, error) {
	return []byte(redactedPlaceholder), nil
}

func (s *Secret) UnmarshalJSON([]byte) error {
	return errors.New("vault: secret cannot be decoded from public JSON")
}

// Credential represents an encrypted vault credential and its host/protocol binding metadata.
type Credential struct {
	ID           string            `json:"id"`
	Kind         SecretKind        `json:"kind"`
	Name         string            `json:"name"`
	TargetHosts  []string          `json:"targetHosts,omitempty"`
	Provider     string            `json:"provider,omitempty"`
	HeaderName   string            `json:"headerName,omitempty"`
	HeaderPrefix string            `json:"headerPrefix,omitempty"`
	Username     string            `json:"username,omitempty"`
	TokenType    string            `json:"tokenType,omitempty"`
	Scopes       []string          `json:"scopes,omitempty"`
	ExpiresAt    *time.Time        `json:"expiresAt,omitempty"`
	Value        Secret            `json:"value"`
	RefreshToken Secret            `json:"refreshToken,omitempty"`
	ExtraHeaders map[string]Secret `json:"extraHeaders,omitempty"`
}

func (c Credential) LogValue() slog.Value {
	attrs := []slog.Attr{
		slog.String("id", c.ID),
		slog.String("kind", string(c.Kind)),
		slog.String("name", c.Name),
		slog.Any("targetHosts", c.TargetHosts),
		slog.String("value", redactedPlaceholder),
	}
	if c.Provider != "" {
		attrs = append(attrs, slog.String("provider", c.Provider))
	}
	if !c.RefreshToken.IsEmpty() {
		attrs = append(attrs, slog.String("refreshToken", redactedPlaceholder))
	}
	if len(c.ExtraHeaders) > 0 {
		attrs = append(attrs, slog.Int("extraHeadersCount", len(c.ExtraHeaders)))
	}
	return slog.GroupValue(attrs...)
}

// CredentialMetadata describes a stored credential without revealing any secret values.
type CredentialMetadata struct {
	ID          string     `json:"id"`
	Kind        SecretKind `json:"kind"`
	Name        string     `json:"name"`
	TargetHosts []string   `json:"targetHosts,omitempty"`
	Provider    string     `json:"provider,omitempty"`
	RootKeyID   string     `json:"rootKeyId"`
	ExpiresAt   *time.Time `json:"expiresAt,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

func (m CredentialMetadata) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("id", m.ID),
		slog.String("kind", string(m.Kind)),
		slog.String("name", m.Name),
		slog.Any("targetHosts", m.TargetHosts),
		slog.String("provider", m.Provider),
		slog.String("rootKeyId", m.RootKeyID),
	)
}

func cloneCredential(c Credential) Credential {
	out := c
	out.TargetHosts = slices.Clone(c.TargetHosts)
	out.Scopes = slices.Clone(c.Scopes)
	if c.ExpiresAt != nil {
		t := *c.ExpiresAt
		out.ExpiresAt = &t
	}
	if c.ExtraHeaders != nil {
		out.ExtraHeaders = make(map[string]Secret, len(c.ExtraHeaders))
		for k, v := range c.ExtraHeaders {
			out.ExtraHeaders[k] = v
		}
	}
	return out
}

func normalizeCredential(c Credential) (Credential, error) {
	if strings.TrimSpace(c.ID) == "" || strings.ContainsAny(c.ID, " \t\r\n") {
		return Credential{}, fmt.Errorf("%w: credential id must be non-empty without whitespace", ErrInvalidCredential)
	}
	if !c.Kind.IsValid() {
		return Credential{}, fmt.Errorf("%w: unsupported kind %q", ErrInvalidCredential, c.Kind)
	}
	if c.Value.IsEmpty() {
		return Credential{}, fmt.Errorf("%w: credential value must be non-empty", ErrInvalidCredential)
	}

	normalized := cloneCredential(c)
	if len(c.TargetHosts) > 0 {
		patterns, err := ValidateHostPatterns(c.TargetHosts)
		if err != nil {
			return Credential{}, fmt.Errorf("%w: %v", ErrInvalidCredential, err)
		}
		hosts := make([]string, len(patterns))
		for i, p := range patterns {
			hosts[i] = p.Raw
		}
		normalized.TargetHosts = hosts
	}
	for hk := range normalized.ExtraHeaders {
		if strings.TrimSpace(hk) == "" {
			return Credential{}, fmt.Errorf("%w: empty extra header name", ErrInvalidCredential)
		}
	}
	if normalized.Kind == KindMCPOAuthToken && normalized.TokenType == "" {
		normalized.TokenType = "Bearer"
	}
	return normalized, nil
}

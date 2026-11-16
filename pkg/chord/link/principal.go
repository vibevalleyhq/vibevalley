package link

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"
)

var (
	ErrUnauthorized     = errors.New("link: unauthorized principal")
	ErrPrincipalExpired = errors.New("link: principal expired")
)

// PrincipalKind identifies the authenticated peer opening a multiplexed Link.
type PrincipalKind string

const (
	PrincipalUserDevice   PrincipalKind = "user_device"
	PrincipalMachineNode  PrincipalKind = "machine_node"
	PrincipalSessionToken PrincipalKind = "session_token"
)

// Principal binds authenticated peer identity, capabilities, and expiry during the Link handshake.
type Principal struct {
	Kind         PrincipalKind `json:"kind"`
	ID           string        `json:"id"`
	SessionID    string        `json:"sessionId,omitempty"`
	Capabilities []string      `json:"capabilities,omitempty"`
	ExpiresAtMs  int64         `json:"expiresAtMs,omitempty"`
}

// IsExpired reports whether ExpiresAtMs is set and has elapsed at now.
func (p Principal) IsExpired(now time.Time) bool {
	return p.ExpiresAtMs > 0 && now.UnixMilli() >= p.ExpiresAtMs
}

// HasCapability reports whether p carries the named capability scope.
func (p Principal) HasCapability(cap string) bool {
	return slices.Contains(p.Capabilities, cap)
}

// Validate checks that p carries a non-empty Kind and ID and has not expired at now.
func (p Principal) Validate(now time.Time) error {
	if p.Kind == "" {
		return fmt.Errorf("%w: missing kind", ErrUnauthorized)
	}
	if p.ID == "" {
		return fmt.Errorf("%w: missing id", ErrUnauthorized)
	}
	if p.IsExpired(now) {
		return fmt.Errorf("%w: expired at %d", ErrPrincipalExpired, p.ExpiresAtMs)
	}
	return nil
}

func (p Principal) clone() Principal {
	out := p
	out.Capabilities = slices.Clone(p.Capabilities)
	return out
}

type principalCtxKey struct{}

// WithPrincipal attaches p to ctx.
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalCtxKey{}, p.clone())
}

// PrincipalFromContext retrieves the authenticated Principal from ctx, if present.
func PrincipalFromContext(ctx context.Context) (Principal, bool) {
	if ctx == nil {
		return Principal{}, false
	}
	p, ok := ctx.Value(principalCtxKey{}).(Principal)
	if !ok {
		return Principal{}, false
	}
	return p.clone(), true
}

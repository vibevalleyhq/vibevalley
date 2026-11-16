package vault

import (
	"errors"
	"fmt"
	"net/http"
)

var (
	ErrInvalidRootKey         = errors.New("vault: invalid root key")
	ErrUnknownRootKey         = errors.New("vault: unknown root key")
	ErrDuplicateRootKey       = errors.New("vault: duplicate root key")
	ErrCiphertextTampered     = errors.New("vault: ciphertext authentication failed")
	ErrSecretNotFound         = errors.New("vault: secret not found")
	ErrInvalidCredential      = errors.New("vault: invalid credential")
	ErrCredentialExpired      = errors.New("vault: credential expired")
	ErrInvalidSigningKey      = errors.New("vault: invalid signing key")
	ErrInvalidToken           = errors.New("vault: invalid capability token")
	ErrTokenExpired           = errors.New("vault: capability token expired")
	ErrTokenNotYetValid       = errors.New("vault: capability token not yet valid")
	ErrTokenRevoked           = errors.New("vault: capability token revoked")
	ErrSessionMismatch        = errors.New("vault: session mismatch")
	ErrCapabilityDenied       = errors.New("vault: capability denied")
	ErrInvalidHostPattern     = errors.New("vault: invalid host pattern")
	ErrMissingCapabilityToken = errors.New("vault: missing capability token")
	ErrHostDenied             = errors.New("vault: target host denied")
	ErrPrivateNetworkBlocked  = errors.New("vault: private or non-public network blocked")
	ErrMethodDenied           = errors.New("vault: HTTP method denied")
	ErrInvalidTargetURL       = errors.New("vault: invalid target URL")
	ErrCredentialHostMismatch = errors.New("vault: credential not bound to target host")
	ErrAmbiguousCredential    = errors.New("vault: multiple credentials match target host")
	ErrCredentialRequired     = errors.New("vault: required credential missing or unauthorized")
)

// ProxyError carries a sanitized HTTP error code and status for egress denials.
type ProxyError struct {
	Status int
	Code   string
	Err    error
}

func (e *ProxyError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %v", e.Code, e.Err)
	}
	return e.Code
}

func (e *ProxyError) Unwrap() error {
	return e.Err
}

func statusForError(err error) (int, string) {
	var pe *ProxyError
	if errors.As(err, &pe) && pe.Status != 0 {
		return pe.Status, pe.Code
	}
	switch {
	case errors.Is(err, ErrMissingCapabilityToken), errors.Is(err, ErrInvalidToken), errors.Is(err, ErrTokenExpired), errors.Is(err, ErrTokenNotYetValid):
		return http.StatusUnauthorized, "unauthorized_token"
	case errors.Is(err, ErrTokenRevoked):
		return http.StatusUnauthorized, "token_revoked"
	case errors.Is(err, ErrSessionMismatch):
		return http.StatusForbidden, "session_mismatch"
	case errors.Is(err, ErrCapabilityDenied):
		return http.StatusForbidden, "capability_denied"
	case errors.Is(err, ErrHostDenied):
		return http.StatusForbidden, "host_denied"
	case errors.Is(err, ErrPrivateNetworkBlocked):
		return http.StatusForbidden, "private_network_blocked"
	case errors.Is(err, ErrMethodDenied):
		return http.StatusForbidden, "method_denied"
	case errors.Is(err, ErrCredentialHostMismatch):
		return http.StatusForbidden, "credential_host_mismatch"
	case errors.Is(err, ErrCredentialExpired):
		return http.StatusForbidden, "credential_expired"
	case errors.Is(err, ErrCredentialRequired), errors.Is(err, ErrSecretNotFound):
		return http.StatusForbidden, "credential_unavailable"
	case errors.Is(err, ErrAmbiguousCredential):
		return http.StatusConflict, "ambiguous_credential"
	case errors.Is(err, ErrInvalidTargetURL), errors.Is(err, ErrInvalidHostPattern):
		return http.StatusBadRequest, "invalid_target_url"
	default:
		return http.StatusBadGateway, "upstream_error"
	}
}

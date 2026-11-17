package vault

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	HeaderCapability    = "X-Vibe-Capability"
	HeaderTargetURL     = "X-Vibe-Target-URL"
	HeaderCredentialID  = "X-Vibe-Credential-ID"
	HeaderSessionID     = "X-Vibe-Session-ID"
	HeaderProxyAuth     = "Proxy-Authorization"
	HeaderAuthorization = "Authorization"
	capabilityBasicUser = "x-vibe-capability"
)

type contextKey int

const (
	ctxSessionIDKey contextKey = iota + 1
	ctxCapabilityTokenKey
)

// ContextWithSessionID binds an authenticated tunnel session ID to ctx for cross-session replay protection.
func ContextWithSessionID(ctx context.Context, sessionID string) context.Context {
	return context.WithValue(ctx, ctxSessionIDKey, sessionID)
}

// SessionIDFromContext extracts a tunnel-bound session ID from ctx if present.
func SessionIDFromContext(ctx context.Context) (string, bool) {
	if ctx == nil {
		return "", false
	}
	v, ok := ctx.Value(ctxSessionIDKey).(string)
	return v, ok && v != ""
}

// ContextWithCapabilityToken attaches a short-lived capability token to ctx for OutboundTransport callers.
func ContextWithCapabilityToken(ctx context.Context, rawToken string) context.Context {
	return context.WithValue(ctx, ctxCapabilityTokenKey, rawToken)
}

// CapabilityTokenFromContext extracts a capability token attached to ctx if present.
func CapabilityTokenFromContext(ctx context.Context) (string, bool) {
	if ctx == nil {
		return "", false
	}
	v, ok := ctx.Value(ctxCapabilityTokenKey).(string)
	return v, ok && v != ""
}

// AuditEvent records an egress allow/deny decision with all secrets and credentials stripped.
type AuditEvent struct {
	Timestamp      time.Time
	Decision       string
	Reason         string
	SessionID      string
	PrincipalID    string
	TokenID        string
	Method         string
	TargetScheme   string
	TargetHost     string
	TargetPort     string
	TargetPath     string
	CredentialID   string
	CredentialKind SecretKind
}

// OutboundOption configures OutboundTransport and EgressProxy behavior.
type OutboundOption func(*OutboundConfig)

// OutboundConfig holds policy, network, and observability settings for control-plane egress.
type OutboundConfig struct {
	Upstream     http.RoundTripper
	IPPolicy     IPPolicyOptions
	RequireHTTPS bool
	Clock        func() time.Time
	Logger       *slog.Logger
	AuditHook    func(AuditEvent)
}

// WithUpstreamTransport overrides the base RoundTripper used after authorization and credential injection.
func WithUpstreamTransport(rt http.RoundTripper) OutboundOption {
	return func(c *OutboundConfig) {
		if rt != nil {
			c.Upstream = rt
		}
	}
}

// WithIPPolicy overrides private/loopback IP blocking rules (defaults to blocking all non-public IPs).
func WithIPPolicy(policy IPPolicyOptions) OutboundOption {
	return func(c *OutboundConfig) {
		c.IPPolicy = policy
	}
}

// WithAllowLoopback permits explicit loopback targets when present in both AllowedHosts and TargetHosts.
func WithAllowLoopback(allow bool) OutboundOption {
	return func(c *OutboundConfig) {
		c.IPPolicy.AllowLoopback = allow
	}
}

// WithHostLookup overrides DNS resolution inside SafeDialContext (useful for deterministic DNS rebinding tests).
func WithHostLookup(fn HostLookupFunc) OutboundOption {
	return func(c *OutboundConfig) {
		c.IPPolicy.LookupIP = fn
	}
}

// WithRequireHTTPS rejects plain http:// upstream targets when enabled.
func WithRequireHTTPS(require bool) OutboundOption {
	return func(c *OutboundConfig) {
		c.RequireHTTPS = require
	}
}

// WithEgressClock sets the clock used to check credential expiration and audit timestamps.
func WithEgressClock(clock func() time.Time) OutboundOption {
	return func(c *OutboundConfig) {
		if clock != nil {
			c.Clock = clock
		}
	}
}

// WithEgressLogger attaches a structured logger to egress enforcement.
func WithEgressLogger(logger *slog.Logger) OutboundOption {
	return func(c *OutboundConfig) {
		if logger != nil {
			c.Logger = logger
		}
	}
}

// WithAuditHook registers a callback invoked on every egress allow/deny decision.
func WithAuditHook(fn func(AuditEvent)) OutboundOption {
	return func(c *OutboundConfig) {
		c.AuditHook = fn
	}
}

// OutboundTransport wraps an http.RoundTripper to enforce session capability tokens,
// allowed_hosts validation, private-network blocking, token stripping, and exit-only credential injection.
type OutboundTransport struct {
	store    *Store
	verifier TokenVerifier
	upstream http.RoundTripper
	cfg      OutboundConfig
}

// NewOutboundTransport constructs a zero-trust control-plane RoundTripper wrapper.
func NewOutboundTransport(store *Store, verifier TokenVerifier, opts ...OutboundOption) (*OutboundTransport, error) {
	if store == nil {
		return nil, errors.New("vault: store is required")
	}
	if verifier == nil {
		return nil, errors.New("vault: token verifier is required")
	}
	cfg := OutboundConfig{
		Clock:  time.Now,
		Logger: slog.Default(),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	upstream := cfg.Upstream
	if upstream == nil {
		upstream = &http.Transport{
			Proxy:                 nil, // Never bypass SafeDialContext via ambient HTTP_PROXY env vars.
			DialContext:           SafeDialContext(cfg.IPPolicy),
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          64,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		}
	}
	return &OutboundTransport{
		store:    store,
		verifier: verifier,
		upstream: upstream,
		cfg:      cfg,
	}, nil
}

// RoundTrip enforces token verification, allowed_hosts, and private IP rules before injecting credentials at exit.
func (t *OutboundTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req == nil || req.URL == nil {
		return nil, fmt.Errorf("%w: nil request or URL", ErrInvalidTargetURL)
	}
	outReq, audit, err := t.prepareOutboundRequest(req, req.URL)
	if err != nil {
		t.emitAudit(req.Context(), audit)
		return nil, err
	}
	resp, err := t.upstream.RoundTrip(outReq)
	if err != nil && (errors.Is(err, ErrPrivateNetworkBlocked) || errors.Is(err, ErrHostDenied) || errors.Is(err, ErrInvalidTargetURL)) {
		audit.Decision = "deny"
		_, audit.Reason = statusForError(err)
	}
	t.emitAudit(req.Context(), audit)
	return resp, err
}

func (t *OutboundTransport) prepareOutboundRequest(req *http.Request, targetURL *url.URL) (*http.Request, AuditEvent, error) {
	ctx := req.Context()
	audit := AuditEvent{
		Timestamp:  t.cfg.Clock().UTC(),
		Decision:   "deny",
		Method:     strings.ToUpper(req.Method),
		TargetPath: targetURL.Path,
	}

	if audit.Method == http.MethodConnect || audit.Method == http.MethodTrace || audit.Method == "TRACK" {
		audit.Reason = "method_denied"
		return nil, audit, fmt.Errorf("%w: method %s is not allowed", ErrMethodDenied, audit.Method)
	}

	endpoint, err := ParseTargetEndpoint(targetURL)
	if err != nil {
		audit.Reason = "invalid_target_url"
		return nil, audit, err
	}
	audit.TargetScheme = endpoint.Scheme
	audit.TargetHost = endpoint.Host
	audit.TargetPort = endpoint.Port

	if t.cfg.RequireHTTPS && endpoint.Scheme != "https" {
		audit.Reason = "https_required"
		return nil, audit, fmt.Errorf("%w: https required", ErrInvalidTargetURL)
	}

	rawToken, err := extractCapabilityToken(req)
	if err != nil {
		audit.Reason = "missing_capability_token"
		return nil, audit, err
	}

	verifyOpts := []VerifyOption{}
	if sessID, ok := SessionIDFromContext(ctx); ok {
		verifyOpts = append(verifyOpts, WithExpectedSession(sessID))
	} else if headerSess := req.Header.Get(HeaderSessionID); headerSess != "" {
		verifyOpts = append(verifyOpts, WithExpectedSession(headerSess))
	}

	verified, err := t.verifier.Verify(ctx, rawToken, verifyOpts...)
	if err != nil {
		_, audit.Reason = statusForError(err)
		return nil, audit, err
	}
	audit.SessionID = verified.Principal.SessionID
	audit.PrincipalID = verified.Principal.ID
	audit.TokenID = verified.TokenID

	if !MatchHostPatterns(verified.ParsedAllowedHosts, endpoint) {
		audit.Reason = "host_denied"
		return nil, audit, fmt.Errorf("%w: target %s:%s is not in allowed_hosts", ErrHostDenied, endpoint.Host, endpoint.Port)
	}

	if err := CheckTargetNetworkPolicy(endpoint, t.cfg.IPPolicy); err != nil {
		audit.Reason = "private_network_blocked"
		return nil, audit, err
	}

	outReq := req.Clone(ctx)
	outReq.URL = cloneURL(targetURL)
	outReq.Host = targetURL.Host
	outReq.RequestURI = ""
	stripHopByHopAndAuthHeaders(outReq.Header)

	requestedCredID := strings.TrimSpace(req.Header.Get(HeaderCredentialID))
	cred, injected, err := t.resolveCredential(ctx, verified, endpoint, targetURL, requestedCredID)
	if err != nil {
		_, audit.Reason = statusForError(err)
		return nil, audit, err
	}
	if injected {
		audit.CredentialID = cred.ID
		audit.CredentialKind = cred.Kind
		injectCredentialHeaders(outReq, cred)
	}

	audit.Decision = "allow"
	audit.Reason = "ok"
	return outReq, audit, nil
}

func (t *OutboundTransport) resolveCredential(
	ctx context.Context,
	verified VerifiedToken,
	endpoint TargetEndpoint,
	targetURL *url.URL,
	requestedCredID string,
) (Credential, bool, error) {
	gitWrite := isGitWriteRequest(targetURL)
	gitRead := isGitReadRequest(targetURL)

	if gitWrite && !verified.HasCapability(CapGitWrite) {
		return Credential{}, false, fmt.Errorf("%w: git push requires %s capability", ErrCapabilityDenied, CapGitWrite)
	}

	if requestedCredID != "" {
		if !verified.AllowsSecret(requestedCredID) && !verified.HasCapability("secret:"+requestedCredID) {
			return Credential{}, false, fmt.Errorf("%w: token does not authorize credential %q", ErrCapabilityDenied, requestedCredID)
		}
		cred, err := t.store.Get(ctx, requestedCredID)
		if err != nil {
			if errors.Is(err, ErrSecretNotFound) {
				return Credential{}, false, fmt.Errorf("%w: credential %q not found", ErrCredentialRequired, requestedCredID)
			}
			return Credential{}, false, err
		}
		if err := t.authorizeCredentialUse(verified, cred, endpoint, gitWrite); err != nil {
			return Credential{}, false, err
		}
		return cred, true, nil
	}

	allowedKinds := eligibleKindsForToken(verified, gitRead, gitWrite)
	var candidateIDs []string
	for _, kind := range allowedKinds {
		metas, err := t.store.FindForTarget(ctx, kind, endpoint)
		if err != nil {
			return Credential{}, false, err
		}
		for _, meta := range metas {
			if !verified.AllowsSecret(meta.ID) && !verified.HasCapability("secret:"+meta.ID) {
				continue
			}
			candidateIDs = append(candidateIDs, meta.ID)
		}
	}

	if len(candidateIDs) > 1 {
		return Credential{}, false, fmt.Errorf("%w: %d credentials match %s:%s", ErrAmbiguousCredential, len(candidateIDs), endpoint.Host, endpoint.Port)
	}
	if len(candidateIDs) == 1 {
		cred, err := t.store.Get(ctx, candidateIDs[0])
		if err != nil {
			return Credential{}, false, err
		}
		if err := t.authorizeCredentialUse(verified, cred, endpoint, gitWrite); err != nil {
			return Credential{}, false, err
		}
		return cred, true, nil
	}

	// No vault credential matched: allow unauthenticated egress only if token grants an HTTP/service capability.
	if verified.HasCapability(CapHTTPEgress) ||
		verified.HasCapability(CapMCPCall) ||
		(gitRead && (verified.HasCapability(CapGitRead) || verified.HasCapability(CapGitWrite))) {
		return Credential{}, false, nil
	}
	return Credential{}, false, fmt.Errorf("%w: no matching credential or %s capability for %s:%s", ErrCredentialRequired, CapHTTPEgress, endpoint.Host, endpoint.Port)
}

func (t *OutboundTransport) authorizeCredentialUse(
	verified VerifiedToken,
	cred Credential,
	endpoint TargetEndpoint,
	gitWrite bool,
) error {
	if !capabilityAllowsKind(verified, cred.ID, cred.Kind, gitWrite) {
		return fmt.Errorf("%w: token lacks capability for %s credential", ErrCapabilityDenied, cred.Kind)
	}
	if len(cred.TargetHosts) == 0 {
		return fmt.Errorf("%w: credential %q has no bound targetHosts", ErrCredentialHostMismatch, cred.ID)
	}
	matched, err := MatchRawHostPatterns(cred.TargetHosts, endpoint)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrCredentialHostMismatch, err)
	}
	if !matched {
		return fmt.Errorf("%w: credential %q is not bound to %s:%s", ErrCredentialHostMismatch, cred.ID, endpoint.Host, endpoint.Port)
	}
	if cred.ExpiresAt != nil && !t.cfg.Clock().UTC().Before(*cred.ExpiresAt) {
		return fmt.Errorf("%w: credential %q expired", ErrCredentialExpired, cred.ID)
	}
	return nil
}

func (t *OutboundTransport) emitAudit(ctx context.Context, event AuditEvent) {
	if event.Decision == "allow" {
		t.cfg.Logger.InfoContext(ctx, "vault egress allowed",
			slog.String("decision", event.Decision),
			slog.String("sessionId", event.SessionID),
			slog.String("principalId", event.PrincipalID),
			slog.String("tokenId", event.TokenID),
			slog.String("method", event.Method),
			slog.String("targetHost", event.TargetHost),
			slog.String("targetPort", event.TargetPort),
			slog.String("targetPath", event.TargetPath),
			slog.String("credentialId", event.CredentialID),
			slog.String("credentialKind", string(event.CredentialKind)),
		)
	} else {
		t.cfg.Logger.WarnContext(ctx, "vault egress denied",
			slog.String("decision", event.Decision),
			slog.String("reason", event.Reason),
			slog.String("sessionId", event.SessionID),
			slog.String("principalId", event.PrincipalID),
			slog.String("tokenId", event.TokenID),
			slog.String("method", event.Method),
			slog.String("targetHost", event.TargetHost),
			slog.String("targetPort", event.TargetPort),
			slog.String("targetPath", event.TargetPath),
		)
	}
	if t.cfg.AuditHook != nil {
		t.cfg.AuditHook(event)
	}
}

func extractCapabilityToken(req *http.Request) (string, error) {
	if tok := req.Header.Get(HeaderCapability); tok != "" {
		return tok, nil
	}
	if tok, ok := parseAuthHeaderForToken(req.Header.Get(HeaderProxyAuth)); ok {
		return tok, nil
	}
	if tok, ok := parseAuthHeaderForToken(req.Header.Get(HeaderAuthorization)); ok {
		return tok, nil
	}
	if tok, ok := CapabilityTokenFromContext(req.Context()); ok {
		return tok, nil
	}
	return "", ErrMissingCapabilityToken
}

func parseAuthHeaderForToken(header string) (string, bool) {
	if header == "" {
		return "", false
	}
	scheme, rest, ok := strings.Cut(header, " ")
	if !ok {
		return "", false
	}
	rest = strings.TrimSpace(rest)
	if rest == "" {
		return "", false
	}
	switch {
	case strings.EqualFold(scheme, "Bearer"):
		return rest, true
	case strings.EqualFold(scheme, "Basic"):
		decoded, err := base64.StdEncoding.DecodeString(rest)
		if err != nil {
			return "", false
		}
		user, pass, hasColon := strings.Cut(string(decoded), ":")
		if !hasColon || pass == "" {
			return "", false
		}
		if user == capabilityBasicUser || strings.HasPrefix(pass, TokenPrefix) {
			return pass, true
		}
	}
	return "", false
}

func eligibleKindsForToken(v VerifiedToken, gitRead, gitWrite bool) []SecretKind {
	if gitWrite {
		if v.HasCapability(CapGitWrite) {
			return []SecretKind{KindGitCredential}
		}
		return nil
	}
	if gitRead {
		if v.HasCapability(CapGitRead) || v.HasCapability(CapGitWrite) {
			return []SecretKind{KindGitCredential}
		}
		return nil
	}
	var kinds []SecretKind
	if v.HasCapability(CapGitRead) || v.HasCapability(CapGitWrite) {
		kinds = append(kinds, KindGitCredential)
	}
	if v.HasCapability(CapMCPCall) {
		kinds = append(kinds, KindMCPOAuthToken)
	}
	if v.HasCapability(CapProviderCall) {
		kinds = append(kinds, KindProviderAPIKey)
	}
	return kinds
}

func capabilityAllowsKind(v VerifiedToken, credID string, kind SecretKind, gitWrite bool) bool {
	if v.HasCapability("secret:" + credID) {
		return !gitWrite || v.HasCapability(CapGitWrite)
	}
	switch kind {
	case KindGitCredential:
		if gitWrite {
			return v.HasCapability(CapGitWrite)
		}
		return v.HasCapability(CapGitRead) || v.HasCapability(CapGitWrite)
	case KindMCPOAuthToken:
		return v.HasCapability(CapMCPCall)
	case KindProviderAPIKey:
		return v.HasCapability(CapProviderCall)
	default:
		return false
	}
}

func isGitWriteRequest(u *url.URL) bool {
	if u.Query().Get("service") == "git-receive-pack" {
		return true
	}
	return strings.HasSuffix(u.Path, "/git-receive-pack")
}

func isGitReadRequest(u *url.URL) bool {
	if u.Query().Get("service") == "git-upload-pack" {
		return true
	}
	return strings.HasSuffix(u.Path, "/git-upload-pack")
}

func injectCredentialHeaders(outReq *http.Request, cred Credential) {
	switch cred.Kind {
	case KindProviderAPIKey:
		if cred.HeaderName != "" {
			outReq.Header.Set(cred.HeaderName, cred.HeaderPrefix+cred.Value.Reveal())
		} else if strings.EqualFold(cred.Provider, "anthropic") {
			outReq.Header.Set("x-api-key", cred.Value.Reveal())
		} else {
			prefix := cred.HeaderPrefix
			if prefix == "" {
				prefix = "Bearer "
			}
			outReq.Header.Set(HeaderAuthorization, prefix+cred.Value.Reveal())
		}
	case KindGitCredential:
		if strings.EqualFold(cred.TokenType, "Bearer") {
			outReq.Header.Set(HeaderAuthorization, "Bearer "+cred.Value.Reveal())
		} else if cred.HeaderName != "" {
			outReq.Header.Set(cred.HeaderName, cred.HeaderPrefix+cred.Value.Reveal())
		} else {
			username := cred.Username
			if username == "" {
				username = "x-access-token"
			}
			encoded := base64.StdEncoding.EncodeToString([]byte(username + ":" + cred.Value.Reveal()))
			outReq.Header.Set(HeaderAuthorization, "Basic "+encoded)
		}
	case KindMCPOAuthToken:
		if cred.HeaderName != "" {
			outReq.Header.Set(cred.HeaderName, cred.HeaderPrefix+cred.Value.Reveal())
		} else {
			tokenType := cred.TokenType
			if tokenType == "" {
				tokenType = "Bearer"
			}
			outReq.Header.Set(HeaderAuthorization, tokenType+" "+cred.Value.Reveal())
		}
	}

	for k, v := range cred.ExtraHeaders {
		outReq.Header.Set(k, v.Reveal())
	}
}

var hopByHopHeaders = []string{
	"Connection",
	"Proxy-Connection",
	"Keep-Alive",
	"Proxy-Authenticate",
	"Proxy-Authorization",
	"Te",
	"Trailer",
	"Transfer-Encoding",
	"Upgrade",
}

func stripHopByHopAndAuthHeaders(h http.Header) {
	for _, connVal := range h.Values("Connection") {
		for field := range strings.SplitSeq(connVal, ",") {
			if name := strings.TrimSpace(field); name != "" {
				h.Del(name)
			}
		}
	}
	for _, name := range hopByHopHeaders {
		h.Del(name)
	}
	h.Del(HeaderCapability)
	h.Del(HeaderTargetURL)
	h.Del(HeaderCredentialID)
	h.Del(HeaderSessionID)
	h.Del(HeaderAuthorization)
}

func cloneURL(u *url.URL) *url.URL {
	c := *u
	if u.User != nil {
		c.User = nil
	}
	return &c
}

// ProxyClientTransport routes sandbox client requests through a control-plane EgressProxy URL,
// attaching only the short-lived capability token and target URL header.
type ProxyClientTransport struct {
	ProxyURL     *url.URL
	Token        Secret
	CredentialID string
	Base         http.RoundTripper
}

// NewProxyClientTransport builds a sandbox-side RoundTripper that forwards all calls through proxyURL
// using a short-lived capability token (holding zero upstream credentials).
func NewProxyClientTransport(proxyURL *url.URL, capabilityToken Secret, base http.RoundTripper) (*ProxyClientTransport, error) {
	if proxyURL == nil || !proxyURL.IsAbs() {
		return nil, fmt.Errorf("%w: absolute proxy URL is required", ErrInvalidTargetURL)
	}
	if capabilityToken.IsEmpty() {
		return nil, ErrMissingCapabilityToken
	}
	if base == nil {
		base = &http.Transport{Proxy: nil}
	}
	return &ProxyClientTransport{
		ProxyURL: cloneURL(proxyURL),
		Token:    capabilityToken,
		Base:     base,
	}, nil
}

// RoundTrip rewrites req to target the control-plane EgressProxy while carrying the original target in X-Vibe-Target-URL.
func (c *ProxyClientTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req == nil || req.URL == nil || !req.URL.IsAbs() {
		return nil, fmt.Errorf("%w: absolute request URL required", ErrInvalidTargetURL)
	}
	proxyReq := req.Clone(req.Context())
	proxyReq.URL = cloneURL(c.ProxyURL)
	proxyReq.Host = c.ProxyURL.Host
	proxyReq.RequestURI = ""
	proxyReq.Header.Set(HeaderTargetURL, req.URL.String())
	proxyReq.Header.Set(HeaderCapability, c.Token.Reveal())
	if c.CredentialID != "" {
		proxyReq.Header.Set(HeaderCredentialID, c.CredentialID)
	}
	return c.Base.RoundTrip(proxyReq)
}

package lan

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

const (
	defaultLANPort      = 8790
	lanStateFileName    = "lan-state.json"
	maxJSONInspectBytes = 256 * 1024

	// HeaderLANDevice identifies the authenticated LAN device to upstream handlers.
	HeaderLANDevice = "X-Vibevalley-Lan-Device"
	// HeaderOutside marks every request entering through the LAN listener.
	HeaderOutside = "X-Vibevalley-Outside"
	// HeaderFrom records the peer IP observed by the LAN listener.
	HeaderFrom = "X-Vibevalley-From"
	// DeviceKeyCookie is the cookie carrying a paired/login device key.
	DeviceKeyCookie = "vibevalley_device_key"
)

var (
	// ErrLanForbidden indicates a local-only or blocked LAN operation/route.
	ErrLanForbidden = errors.New("lan: forbidden")
	// ErrLanUnavailable indicates the LAN listener is not active or has no network address.
	ErrLanUnavailable = errors.New("lan: unavailable")
	// ErrUnauthorized indicates a missing or invalid LAN device token.
	ErrUnauthorized = errors.New("lan: unauthorized")
)

// AuthenticatedDevice identifies a verified remote device returned by TokenVerifier.
type AuthenticatedDevice struct {
	ID   string
	Name string
	Came string // "paired" or "login"
}

// DeviceMinted is the token response returned by a DeviceMinter callback.
type DeviceMinted struct {
	Device string
	Key    string
}

// DeviceMinter mints a device token for an approved pairing request.
type DeviceMinter func(ctx context.Context, deviceName string) (DeviceMinted, error)

// TokenVerifier validates a bearer or cookie device key.
type TokenVerifier func(token string) (AuthenticatedDevice, bool)

// Options configures the isolated LAN access and pairing Service.
type Options struct {
	HomeDir         string
	Port            int
	BindHost        string
	Label           string
	Clock           store.Clock
	Upstream        http.Handler
	DeviceMinter    DeviceMinter
	TokenVerifier   TokenVerifier
	AddressResolver func() string
}

// LanStatus matches packages/protocol/src/lan/shapes.ts LanStatus.
type LanStatus struct {
	Open     bool        `json:"open"`
	Port     int         `json:"port,omitempty"`
	HostName string      `json:"hostName"`
	URL      string      `json:"url,omitempty"`
	Problem  string      `json:"problem"`
	Pairing  *LanPairing `json:"pairing,omitempty"`
}

// LanPairing matches packages/protocol/src/lan/shapes.ts LanPairing.
type LanPairing struct {
	Code      string `json:"code"`
	Link      string `json:"link"`
	ExpiresAt int64  `json:"expiresAt"`
	Asking    string `json:"asking,omitempty"`
}

// LanPaired matches packages/protocol/src/lan/shapes.ts LanPaired.
type LanPaired struct {
	Device   string `json:"device"`
	Key      string `json:"key"`
	HostName string `json:"hostName"`
}

// UpdateRequest updates LAN listener configuration (enable/disable/port/label).
type UpdateRequest struct {
	Open  *bool   `json:"open,omitempty"`
	Port  *int    `json:"port,omitempty"`
	Label *string `json:"label,omitempty"`
}

// Preview matches packages/protocol/src/common/shapes.ts Preview.
type Preview struct {
	Does []string `json:"does"`
}

// RemoteDecision describes whether a remote HTTP request is permitted across the LAN boundary.
type RemoteDecision struct {
	Allowed      bool
	RequiresAuth bool
	Status       int
	Reason       string
}

type storedLanState struct {
	Port  int    `json:"port"`
	Label string `json:"label,omitempty"`
}

// Service manages the isolated "连接到本机" LAN listener, device pairing, and remote route gating.
type Service struct {
	homeDir         string
	filePath        string
	bindHost        string
	clock           store.Clock
	upstream        http.Handler
	minter          DeviceMinter
	verifier        TokenVerifier
	addressResolver func() string

	opMu sync.Mutex
	mu   sync.RWMutex

	open         bool
	port         int
	boundPort    int
	label        string
	listenErr    string
	listener     net.Listener
	server       *http.Server
	pairing      *pairingSession
	activeCancel context.CancelFunc
	connSeq      uint64
	conns        map[string]map[uint64]context.CancelFunc
	closed       bool
}

// NewService constructs a LAN access service (off by default).
func NewService(opts Options) (*Service, error) {
	clk := opts.Clock
	if clk == nil {
		clk = store.RealClock{}
	}
	port := opts.Port
	if port <= 0 {
		port = defaultLANPort
	}
	bindHost := strings.TrimSpace(opts.BindHost)
	if bindHost == "" {
		bindHost = "0.0.0.0"
	}
	label := strings.TrimSpace(opts.Label)
	if label == "" {
		label = defaultHostName()
	}
	addrFn := opts.AddressResolver
	if addrFn == nil {
		addrFn = func() string {
			if bindHost == "127.0.0.1" || bindHost == "::1" || bindHost == "localhost" {
				return "127.0.0.1"
			}
			return detectLANIPv4()
		}
	}

	s := &Service{
		homeDir:         strings.TrimSpace(opts.HomeDir),
		bindHost:        bindHost,
		clock:           clk,
		upstream:        opts.Upstream,
		minter:          opts.DeviceMinter,
		verifier:        opts.TokenVerifier,
		addressResolver: addrFn,
		port:            port,
		label:           label,
		conns:           make(map[string]map[uint64]context.CancelFunc),
	}
	if s.homeDir != "" {
		s.filePath = filepath.Join(s.homeDir, lanStateFileName)
		if err := s.loadState(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// Get returns the current LanStatus without exposing internal errors beyond Problem.
func (s *Service) Get() LanStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.statusLocked()
}

// SetOpen enables or disables the LAN listener.
func (s *Service) SetOpen(ctx context.Context, open bool) (LanStatus, error) {
	return s.Update(ctx, UpdateRequest{Open: &open})
}

// Update changes LAN configuration (enable/disable, port, label), restarting the listener if needed.
func (s *Service) Update(ctx context.Context, req UpdateRequest) (LanStatus, error) {
	if err := ctx.Err(); err != nil {
		return LanStatus{}, err
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return LanStatus{}, ErrLanUnavailable
	}
	wantOpen := s.open
	if req.Open != nil {
		wantOpen = *req.Open
	}
	nextPort := s.port
	portChanged := false
	if req.Port != nil {
		if *req.Port < 0 || *req.Port > 65535 {
			s.mu.Unlock()
			return LanStatus{}, fmt.Errorf("%w: invalid port %d", ErrLanForbidden, *req.Port)
		}
		if *req.Port != s.port {
			nextPort = *req.Port
			portChanged = true
		}
	}
	if req.Label != nil {
		trimmed := strings.TrimSpace(*req.Label)
		if trimmed == "" {
			trimmed = defaultHostName()
		}
		s.label = trimmed
	}
	s.port = nextPort
	_ = s.persistStateLocked()
	wasOpen := s.open
	s.mu.Unlock()

	if !wantOpen {
		s.stopListener()
	} else if !wasOpen || portChanged {
		if wasOpen {
			s.stopListener()
		}
		if err := s.startListener(); err != nil {
			return s.Get(), err
		}
	}
	return s.Get(), nil
}

// Close shuts down the LAN listener, cancels active streams, and clears pending pairing.
func (s *Service) Close() error {
	s.opMu.Lock()
	defer s.opMu.Unlock()

	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()

	s.stopListener()
	return nil
}

// DisconnectDevice immediately cancels all open connections belonging to deviceID.
func (s *Service) DisconnectDevice(deviceID string) {
	s.mu.Lock()
	cancels := s.conns[deviceID]
	delete(s.conns, deviceID)
	s.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

// Handler returns the HTTP middleware enforcing strict remote route isolation and device token auth.
func (s *Service) Handler() http.Handler {
	return LANMiddleware(s.verifier, s.upstream, s.trackConn)
}

func (s *Service) trackConn(deviceID string, cancel context.CancelFunc) func() {
	if deviceID == "" || cancel == nil {
		return func() {}
	}
	s.mu.Lock()
	s.connSeq++
	seq := s.connSeq
	set := s.conns[deviceID]
	if set == nil {
		set = make(map[uint64]context.CancelFunc)
		s.conns[deviceID] = set
	}
	set[seq] = cancel
	s.mu.Unlock()

	return func() {
		s.mu.Lock()
		if existing, ok := s.conns[deviceID]; ok {
			delete(existing, seq)
			if len(existing) == 0 {
				delete(s.conns, deviceID)
			}
		}
		s.mu.Unlock()
	}
}

// LANMiddleware wraps next to enforce strict remote route whitelisting, local-path media import blocking,
// same-origin checks, and valid device token authentication for remote LAN clients.
func LANMiddleware(verifier TokenVerifier, next http.Handler, trackConn ...func(string, context.CancelFunc) func()) http.Handler {
	var tracker func(string, context.CancelFunc) func()
	if len(trackConn) > 0 {
		tracker = trackConn[0]
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		decision := CheckRemoteRequest(r, "")
		if !decision.Allowed {
			writeJSONError(w, decision.Status, decision.Reason)
			return
		}

		token := extractToken(r)
		var authed AuthenticatedDevice
		var hasAuthed bool
		if verifier != nil && token != "" {
			authed, hasAuthed = verifier(token)
		}

		if decision.RequiresAuth {
			if verifier == nil || !hasAuthed {
				writeJSONError(w, http.StatusUnauthorized, "device token required")
				return
			}
			roleDecision := CheckRemoteRequest(r, authed.Came)
			if !roleDecision.Allowed {
				writeJSONError(w, roleDecision.Status, roleDecision.Reason)
				return
			}
		}

		if next == nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}

		req := r.Clone(r.Context())
		stripSpoofableHeaders(req.Header)
		req.Header.Set(HeaderOutside, "1")
		req.Header.Set(HeaderFrom, peerAddress(r))
		if hasAuthed {
			req.Header.Set(HeaderLANDevice, authed.ID)
		}

		if hasAuthed && tracker != nil {
			ctx, cancel := context.WithCancel(req.Context())
			req = req.WithContext(ctx)
			cleanup := tracker(authed.ID, cancel)
			defer func() {
				cleanup()
				cancel()
			}()
		}

		next.ServeHTTP(w, req)
	})
}

// AllowRemoteRequest evaluates whether r is permitted over the LAN listener for the given device came mode
// ("" for unauthenticated pre-auth evaluation, "paired", or "login").
func AllowRemoteRequest(r *http.Request, came string) (bool, string) {
	dec := CheckRemoteRequest(r, came)
	return dec.Allowed, dec.Reason
}

// CheckRemoteRequest performs full route whitelist, blocked-endpoint, local-path media import, and origin validation.
func CheckRemoteRequest(r *http.Request, came string) RemoteDecision {
	if r == nil || r.URL == nil {
		return RemoteDecision{Allowed: false, Status: http.StatusBadRequest, Reason: "invalid request"}
	}
	cleanPath := canonicalPath(r.URL.Path)
	method := strings.ToUpper(strings.TrimSpace(r.Method))
	if method == "" {
		method = http.MethodGet
	}

	if isExplicitlyBlockedLANPath(cleanPath) {
		return RemoteDecision{
			Allowed: false,
			Status:  http.StatusForbidden,
			Reason:  fmt.Sprintf("route %q is restricted to local loopback access", cleanPath),
		}
	}

	if isLocalPathMediaImport(method, cleanPath, r) {
		return RemoteDecision{
			Allowed: false,
			Status:  http.StatusForbidden,
			Reason:  "local-path media imports are forbidden over LAN",
		}
	}

	if strings.HasPrefix(cleanPath, "/api/v1/") && !sameOriginHeaders(r) {
		return RemoteDecision{
			Allowed: false,
			Status:  http.StatusForbidden,
			Reason:  "cross-origin API request refused over LAN",
		}
	}

	if isKeylessLANRequest(method, cleanPath) {
		return RemoteDecision{Allowed: true, RequiresAuth: false, Status: http.StatusOK}
	}

	if !strings.HasPrefix(cleanPath, "/api/v1/") {
		if method == http.MethodGet || method == http.MethodHead {
			return RemoteDecision{Allowed: true, RequiresAuth: false, Status: http.StatusOK}
		}
		return RemoteDecision{
			Allowed: false,
			Status:  http.StatusNotFound,
			Reason:  "not found",
		}
	}

	// Password changes always require loopback even for login-authenticated LAN devices.
	if method == http.MethodPost && cleanPath == "/api/v1/user/password/set" {
		return RemoteDecision{
			Allowed: false,
			Status:  http.StatusForbidden,
			Reason:  "password changes require local loopback access",
		}
	}

	if came == "" {
		// Pre-auth pass: route is either login-accessible or remote-whitelisted; auth check decides next.
		return RemoteDecision{Allowed: true, RequiresAuth: true, Status: http.StatusOK}
	}

	if came == "login" {
		return RemoteDecision{Allowed: true, RequiresAuth: true, Status: http.StatusOK}
	}

	if !isRemoteWhitelisted(method, cleanPath) {
		return RemoteDecision{
			Allowed: false,
			Status:  http.StatusForbidden,
			Reason:  fmt.Sprintf("endpoint %s %s is not permitted for paired remote devices", method, cleanPath),
		}
	}

	return RemoteDecision{Allowed: true, RequiresAuth: true, Status: http.StatusOK}
}

func canonicalPath(raw string) string {
	p := path.Clean("/" + strings.TrimPrefix(raw, "/"))
	if p == "." {
		return "/"
	}
	return p
}

func isExplicitlyBlockedLANPath(p string) bool {
	blockedPrefixes := []string{
		"/mcp",
		"/v1/chat/completions",
		"/machine/ws",
		"/egress",
		"/chord/ws",
		"/api/v1/media/input",
		"/api/v1/media/import",
	}
	for _, prefix := range blockedPrefixes {
		if p == prefix || strings.HasPrefix(p, prefix+"/") {
			return true
		}
	}
	return false
}

func isLocalPathMediaImport(method, cleanPath string, r *http.Request) bool {
	if method != http.MethodPost {
		return false
	}
	if cleanPath != "/api/v1/library/item/add" && !strings.HasPrefix(cleanPath, "/api/v1/media/") {
		return false
	}
	if r.Body == nil || r.Body == http.NoBody {
		return false
	}
	bodyBytes, err := io.ReadAll(io.LimitReader(r.Body, maxJSONInspectBytes+1))
	if err != nil {
		return false
	}
	_ = r.Body.Close()
	r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	if len(bodyBytes) > maxJSONInspectBytes || len(bytes.TrimSpace(bodyBytes)) == 0 {
		return false
	}
	var payload map[string]any
	if err := json.Unmarshal(bodyBytes, &payload); err != nil {
		return false
	}
	for _, field := range []string{"path", "file", "localPath", "sourcePath"} {
		if rawVal, exists := payload[field]; exists {
			if strVal, ok := rawVal.(string); ok && strings.TrimSpace(strVal) != "" {
				return true
			}
		}
	}
	return false
}

func sameOriginHeaders(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin != "" {
		host := r.Host
		if host == "" {
			host = r.Header.Get("Host")
		}
		if origin != "http://"+host && origin != "https://"+host {
			return false
		}
	}
	site := r.Header.Get("Sec-Fetch-Site")
	if site != "" && site != "same-origin" && site != "none" {
		return false
	}
	return true
}

func isKeylessLANRequest(method, cleanPath string) bool {
	if method != http.MethodPost {
		return false
	}
	switch cleanPath {
	case "/api/v1/lan/pair",
		"/api/v1/user/login",
		"/api/v1/user/get",
		"/api/v1/user/approval/create",
		"/api/v1/user/approval/collect":
		return true
	default:
		return false
	}
}

var remoteAllowedGETPrefixes = []string{
	"/api/v1/attachment/",
	"/api/v1/artifact/",
	"/api/v1/subscribe/",
}

var remoteAllowedPOST = map[string]bool{
	"/api/v1/server/health/get":     true,
	"/api/v1/setting/get":           true,
	"/api/v1/setting/validate":      true,
	"/api/v1/user/get":              true,
	"/api/v1/user/login":            true,
	"/api/v1/user/logout":           true,
	"/api/v1/user/approval/create":  true,
	"/api/v1/user/approval/collect": true,
	"/api/v1/lan/pair":              true,
	"/api/v1/attachment/create":     true,
	"/api/v1/connector/list":        true,
	"/api/v1/core/state/get":        true,
	"/api/v1/orchestrator/chat":     true,
	"/api/v1/orchestrator/stop":     true,
	"/api/v1/orchestrator/answer":   true,
	"/api/v1/issue/list":            true,
	"/api/v1/issue/get":             true,
	"/api/v1/issue/create":          true,
	"/api/v1/issue/update":          true,
	"/api/v1/issue/status":          true,
	"/api/v1/issue/comment/create":  true,
	"/api/v1/issue/answer":          true,
	"/api/v1/issue/delete":          true,
	"/api/v1/channel/list":          true,
	"/api/v1/channel/messages":      true,
	"/api/v1/channel/send":          true,
	"/api/v1/channel/read":          true,
	"/api/v1/channel/reaction/set":  true,
	"/api/v1/pkm/list":              true,
	"/api/v1/pkm/get":               true,
	"/api/v1/pkm/search":            true,
	"/api/v1/pkm/capture":           true,
	"/api/v1/memory/list":           true,
	"/api/v1/memory/search":         true,
	"/api/v1/repo/list":             true,
	"/api/v1/repo/get":              true,
	"/api/v1/agent/list":            true,
	"/api/v1/agent/get":             true,
	"/api/v1/artifact/list":         true,
	"/api/v1/artifact/get":          true,
	"/api/v1/artifact/content":      true,
	"/api/v1/game/get":              true,
	"/api/v1/cron/list":             true,
	"/api/v1/runtime/list":          true,
	"/api/v1/library/item/list":     true,
	"/api/v1/library/item/add":      true,
	"/api/v1/library/item/delete":   true,
	"/api/v1/voice/grant/create":    true,
	"/api/v1/voice/grant/renew":     true,
	"/api/v1/voice/call/start":      true,
	"/api/v1/voice/call/stop":       true,
	"/api/v1/voice/call/hear":       true,
	"/api/v1/voice/call/say":        true,
	"/api/v1/voice/hear":            true,
	"/api/v1/voice/dictate":         true,
}

func isRemoteWhitelisted(method, cleanPath string) bool {
	if method == http.MethodGet || method == http.MethodHead {
		switch cleanPath {
		case "/api/v1/state", "/api/v1/events", "/api/v1/live":
			return true
		}
		for _, prefix := range remoteAllowedGETPrefixes {
			if strings.HasPrefix(cleanPath, prefix) {
				return true
			}
		}
		if strings.HasPrefix(cleanPath, "/api/v1/media/speech/") && strings.HasSuffix(cleanPath, "/stream") {
			return true
		}
		return false
	}
	if method == http.MethodPost {
		return remoteAllowedPOST[cleanPath]
	}
	return false
}

func stripSpoofableHeaders(h http.Header) {
	for _, k := range []string{
		"Cookie",
		"Authorization",
		"Connection",
		HeaderLANDevice,
		HeaderOutside,
		HeaderFrom,
	} {
		h.Del(k)
	}
}

func extractToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	if c, err := r.Cookie(DeviceKeyCookie); err == nil {
		return c.Value
	}
	return ""
}

func peerAddress(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	host = strings.TrimPrefix(host, "::ffff:")
	if (host == "127.0.0.1" || host == "::1") && r.Header.Get("X-Forwarded-For") != "" {
		first, _, _ := strings.Cut(r.Header.Get("X-Forwarded-For"), ",")
		if trimmed := strings.TrimSpace(first); trimmed != "" {
			return trimmed
		}
	}
	return host
}

func (s *Service) startListener() error {
	s.mu.Lock()
	port := s.port
	bindAddr := net.JoinHostPort(s.bindHost, fmt.Sprintf("%d", port))
	s.mu.Unlock()

	ln, err := net.Listen("tcp", bindAddr)
	if err != nil {
		s.mu.Lock()
		s.listenErr = fmt.Sprintf("cannot listen on %s: %v", bindAddr, err)
		s.open = false
		s.mu.Unlock()
		return fmt.Errorf("%w: %v", ErrLanUnavailable, err)
	}

	boundPort := port
	if tcpAddr, ok := ln.Addr().(*net.TCPAddr); ok {
		boundPort = tcpAddr.Port
	}

	baseCtx, cancel := context.WithCancel(context.Background())
	srv := &http.Server{
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return baseCtx },
	}

	s.mu.Lock()
	s.open = true
	s.boundPort = boundPort
	s.listenErr = ""
	s.listener = ln
	s.server = srv
	s.activeCancel = cancel
	s.mu.Unlock()

	go func() {
		_ = srv.Serve(ln)
	}()
	return nil
}

func (s *Service) stopListener() {
	s.mu.Lock()
	s.dropPairingLocked(false)
	srv := s.server
	ln := s.listener
	cancel := s.activeCancel
	s.server = nil
	s.listener = nil
	s.activeCancel = nil
	s.open = false
	s.boundPort = 0
	cancels := make([]context.CancelFunc, 0)
	for _, set := range s.conns {
		for _, fn := range set {
			cancels = append(cancels, fn)
		}
	}
	s.conns = make(map[string]map[uint64]context.CancelFunc)
	s.mu.Unlock()

	for _, fn := range cancels {
		fn()
	}
	if cancel != nil {
		cancel()
	}
	if srv != nil {
		ctx, shutCancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = srv.Shutdown(ctx)
		shutCancel()
		_ = srv.Close()
	} else if ln != nil {
		_ = ln.Close()
	}
}

func (s *Service) statusLocked() LanStatus {
	s.pruneExpiredPairingLocked()
	st := LanStatus{
		Open:     s.open,
		Port:     s.port,
		HostName: s.label,
		Problem:  s.listenErr,
	}
	if s.open && s.boundPort > 0 {
		st.Port = s.boundPort
		addr := s.advertisedURL(s.boundPort)
		if addr == "" {
			st.Problem = "no local network address available"
		} else {
			st.URL = addr
		}
		if s.pairing != nil && addr != "" {
			st.Pairing = &LanPairing{
				Code:      s.pairing.code,
				Link:      pairURI(addr, s.pairing.code),
				ExpiresAt: s.pairing.expiresAt,
				Asking:    s.pairing.asking,
			}
		}
	}
	return st
}

func (s *Service) advertisedURL(port int) string {
	host := strings.TrimSpace(s.addressResolver())
	if host == "" {
		return ""
	}
	return fmt.Sprintf("http://%s:%d", host, port)
}

func defaultHostName() string {
	h, err := os.Hostname()
	if err != nil {
		return "vibevalley"
	}
	h = strings.TrimSuffix(strings.TrimSpace(h), ".local")
	if h == "" {
		return "vibevalley"
	}
	return h
}

func detectLANIPv4() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	best := ""
	bestRank := 3
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		rank := 2
		for _, prefix := range []string{"en", "eth", "wlan", "wl"} {
			if strings.HasPrefix(iface.Name, prefix) {
				rank = 1
				break
			}
		}
		if rank >= bestRank {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil {
				continue
			}
			v4 := ip.To4()
			if v4 == nil || v4.IsLoopback() || !v4.IsPrivate() {
				continue
			}
			best = v4.String()
			bestRank = rank
			break
		}
	}
	return best
}

func (s *Service) loadState() error {
	raw, err := os.ReadFile(s.filePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var st storedLanState
	if err := json.Unmarshal(raw, &st); err != nil {
		return err
	}
	if st.Port > 0 && st.Port <= 65535 {
		s.port = st.Port
	}
	if strings.TrimSpace(st.Label) != "" {
		s.label = strings.TrimSpace(st.Label)
	}
	return nil
}

func (s *Service) persistStateLocked() error {
	if s.filePath == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.filePath), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(storedLanState{
		Port:  s.port,
		Label: s.label,
	}, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	tmp, err := os.CreateTemp(filepath.Dir(s.filePath), ".lan-state-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, s.filePath); err != nil {
		return err
	}
	cleanup = false
	return nil
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	bizCode := 200005 // LanForbidden
	if status == http.StatusUnauthorized {
		bizCode = 200001 // Unauthorized
	} else if status == http.StatusNotFound {
		bizCode = 100005 // RouteNotFound
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"bizCode": bizCode,
		"message": msg,
	})
}

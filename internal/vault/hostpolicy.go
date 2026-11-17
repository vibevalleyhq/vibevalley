package vault

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// HostPattern represents a validated host/port rule from AllowedHosts or TargetHosts.
type HostPattern struct {
	Raw      string
	Host     string
	Wildcard bool
	Port     string
	IsIP     bool
}

// TargetEndpoint holds the canonicalized scheme, host, and port extracted from an outbound URL.
type TargetEndpoint struct {
	Scheme string
	Host   string
	Port   string
	IsIP   bool
	IP     netip.Addr
}

// HostLookupFunc resolves a hostname to IP addresses for SafeDialContext.
type HostLookupFunc func(ctx context.Context, host string) ([]net.IPAddr, error)

// IPPolicyOptions configures which non-public IP ranges are permitted by egress dialing.
type IPPolicyOptions struct {
	AllowLoopback  bool
	AllowPrivate   bool
	AllowLinkLocal bool
	LookupIP       HostLookupFunc
	DialTimeout    time.Duration
}

// ParseHostPattern parses and validates a host or host:port pattern (supporting leading *. subdomain wildcards).
func ParseHostPattern(raw string) (HostPattern, error) {
	if raw == "" || strings.ContainsAny(raw, " \t\r\n/\\?#%@") {
		return HostPattern{}, fmt.Errorf("%w: invalid characters in %q", ErrInvalidHostPattern, raw)
	}
	if strings.Contains(raw, "://") {
		return HostPattern{}, fmt.Errorf("%w: scheme not allowed in host pattern %q", ErrInvalidHostPattern, raw)
	}

	hostPart := raw
	var portPart string

	if strings.HasPrefix(raw, "[") {
		// Bracketed IPv6 literal: [::1] or [::1]:8080.
		if strings.Contains(raw, "]:") {
			h, p, err := net.SplitHostPort(raw)
			if err != nil {
				return HostPattern{}, fmt.Errorf("%w: %v", ErrInvalidHostPattern, err)
			}
			hostPart = h
			portPart = p
		} else if strings.HasSuffix(raw, "]") {
			hostPart = raw[1 : len(raw)-1]
		} else {
			return HostPattern{}, fmt.Errorf("%w: malformed bracketed host %q", ErrInvalidHostPattern, raw)
		}
	} else if addr, err := netip.ParseAddr(raw); err == nil && addr.Is6() {
		hostPart = addr.Unmap().String()
	} else if strings.Contains(raw, ":") {
		h, p, err := net.SplitHostPort(raw)
		if err != nil {
			return HostPattern{}, fmt.Errorf("%w: %v", ErrInvalidHostPattern, err)
		}
		hostPart = h
		portPart = p
	}

	if portPart != "" {
		if err := validatePort(portPart); err != nil {
			return HostPattern{}, fmt.Errorf("%w: %v", ErrInvalidHostPattern, err)
		}
	}

	hostPart = strings.ToLower(hostPart)
	if strings.HasSuffix(hostPart, ".") {
		hostPart = strings.TrimSuffix(hostPart, ".")
	}
	if hostPart == "" || strings.HasPrefix(hostPart, ".") || strings.Contains(hostPart, "..") {
		return HostPattern{}, fmt.Errorf("%w: empty or malformed host %q", ErrInvalidHostPattern, raw)
	}

	if strings.HasPrefix(hostPart, "*.") {
		suffix := hostPart[2:]
		if strings.Contains(suffix, "*") {
			return HostPattern{}, fmt.Errorf("%w: multiple wildcards in %q", ErrInvalidHostPattern, raw)
		}
		if _, err := netip.ParseAddr(suffix); err == nil {
			return HostPattern{}, fmt.Errorf("%w: wildcard cannot wrap IP address %q", ErrInvalidHostPattern, raw)
		}
		if !isValidDNSName(suffix) {
			return HostPattern{}, fmt.Errorf("%w: invalid wildcard suffix %q", ErrInvalidHostPattern, raw)
		}
		if strings.Count(suffix, ".") < 1 {
			return HostPattern{}, fmt.Errorf("%w: wildcard %q is too broad; require at least two domain labels", ErrInvalidHostPattern, raw)
		}
		canonical := "*." + suffix
		if portPart != "" {
			canonical = canonical + ":" + portPart
		}
		return HostPattern{
			Raw:      canonical,
			Host:     suffix,
			Wildcard: true,
			Port:     portPart,
		}, nil
	}

	if strings.Contains(hostPart, "*") {
		return HostPattern{}, fmt.Errorf("%w: wildcard only allowed as leading '*.' label in %q", ErrInvalidHostPattern, raw)
	}

	if addr, err := netip.ParseAddr(hostPart); err == nil {
		addr = addr.Unmap()
		canonical := addr.String()
		if addr.Is6() && portPart != "" {
			canonical = "[" + canonical + "]:" + portPart
		} else if portPart != "" {
			canonical = canonical + ":" + portPart
		}
		return HostPattern{
			Raw:  canonical,
			Host: addr.String(),
			Port: portPart,
			IsIP: true,
		}, nil
	}

	if !isValidDNSName(hostPart) {
		return HostPattern{}, fmt.Errorf("%w: invalid DNS hostname %q", ErrInvalidHostPattern, raw)
	}

	canonical := hostPart
	if portPart != "" {
		canonical = canonical + ":" + portPart
	}
	return HostPattern{
		Raw:  canonical,
		Host: hostPart,
		Port: portPart,
	}, nil
}

// ValidateHostPatterns validates and deduplicates a slice of host patterns.
func ValidateHostPatterns(patterns []string) ([]HostPattern, error) {
	seen := make(map[string]struct{}, len(patterns))
	out := make([]HostPattern, 0, len(patterns))
	for _, raw := range patterns {
		p, err := ParseHostPattern(raw)
		if err != nil {
			return nil, err
		}
		if _, ok := seen[p.Raw]; ok {
			continue
		}
		seen[p.Raw] = struct{}{}
		out = append(out, p)
	}
	return out, nil
}

// ParseTargetEndpoint extracts and canonicalizes a target URL's scheme, host, and effective port.
func ParseTargetEndpoint(u *url.URL) (TargetEndpoint, error) {
	if u == nil || !u.IsAbs() || u.Opaque != "" {
		return TargetEndpoint{}, fmt.Errorf("%w: absolute URL required", ErrInvalidTargetURL)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return TargetEndpoint{}, fmt.Errorf("%w: unsupported scheme %q", ErrInvalidTargetURL, u.Scheme)
	}
	if u.User != nil {
		return TargetEndpoint{}, fmt.Errorf("%w: URL userinfo is forbidden", ErrInvalidTargetURL)
	}

	rawHost := u.Hostname()
	if rawHost == "" || strings.ContainsAny(rawHost, " \t\r\n/\\?#%@*") {
		return TargetEndpoint{}, fmt.Errorf("%w: invalid host %q", ErrInvalidTargetURL, rawHost)
	}
	host := strings.ToLower(rawHost)
	if strings.HasSuffix(host, ".") {
		host = strings.TrimSuffix(host, ".")
	}
	if host == "" || strings.HasPrefix(host, ".") || strings.Contains(host, "..") {
		return TargetEndpoint{}, fmt.Errorf("%w: malformed host %q", ErrInvalidTargetURL, rawHost)
	}

	port := u.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	} else if err := validatePort(port); err != nil {
		return TargetEndpoint{}, fmt.Errorf("%w: %v", ErrInvalidTargetURL, err)
	}

	if addr, err := netip.ParseAddr(host); err == nil {
		addr = addr.Unmap()
		return TargetEndpoint{
			Scheme: scheme,
			Host:   addr.String(),
			Port:   port,
			IsIP:   true,
			IP:     addr,
		}, nil
	}

	if !isValidDNSName(host) {
		return TargetEndpoint{}, fmt.Errorf("%w: invalid hostname %q", ErrInvalidTargetURL, rawHost)
	}
	return TargetEndpoint{
		Scheme: scheme,
		Host:   host,
		Port:   port,
	}, nil
}

// MatchHostPatterns reports whether target matches at least one allowed pattern.
func MatchHostPatterns(patterns []HostPattern, target TargetEndpoint) bool {
	if len(patterns) == 0 {
		return false
	}
	for _, p := range patterns {
		if !matchPort(p.Port, target.Scheme, target.Port) {
			continue
		}
		if p.Wildcard {
			if !target.IsIP && len(target.Host) > len(p.Host)+1 && strings.HasSuffix(target.Host, "."+p.Host) {
				return true
			}
			continue
		}
		if p.IsIP != target.IsIP {
			continue
		}
		if p.Host == target.Host {
			return true
		}
	}
	return false
}

// MatchRawHostPatterns parses raw patterns and checks whether target matches any of them.
func MatchRawHostPatterns(rawPatterns []string, target TargetEndpoint) (bool, error) {
	patterns, err := ValidateHostPatterns(rawPatterns)
	if err != nil {
		return false, err
	}
	return MatchHostPatterns(patterns, target), nil
}

// CheckTargetNetworkPolicy rejects localhost/internal names and non-public IP literals per opts.
func CheckTargetNetworkPolicy(target TargetEndpoint, opts IPPolicyOptions) error {
	if target.IsIP {
		if IsBlockedIP(target.IP, opts) {
			return fmt.Errorf("%w: IP %s is blocked", ErrPrivateNetworkBlocked, target.IP)
		}
		return nil
	}
	if target.Host == "localhost" || strings.HasSuffix(target.Host, ".localhost") {
		if !opts.AllowLoopback && !opts.AllowPrivate {
			return fmt.Errorf("%w: localhost target %q is blocked", ErrPrivateNetworkBlocked, target.Host)
		}
	}
	if strings.HasSuffix(target.Host, ".local") || strings.HasSuffix(target.Host, ".internal") {
		if !opts.AllowPrivate {
			return fmt.Errorf("%w: internal hostname %q is blocked", ErrPrivateNetworkBlocked, target.Host)
		}
	}
	return nil
}

var (
	thisNetPrefix4   = netip.MustParsePrefix("0.0.0.0/8")
	cgnatPrefix      = netip.MustParsePrefix("100.64.0.0/10")
	ietfProtoPrefix  = netip.MustParsePrefix("192.0.0.0/24")
	benchmarkPrefix  = netip.MustParsePrefix("198.18.0.0/15")
	futureUsePrefix4 = netip.MustParsePrefix("240.0.0.0/4")
)

// IsBlockedIP reports whether addr falls in a non-public, loopback, private, link-local, or reserved range.
func IsBlockedIP(addr netip.Addr, opts IPPolicyOptions) bool {
	if !addr.IsValid() {
		return true
	}
	addr = addr.Unmap()
	if addr.IsUnspecified() || addr.IsMulticast() {
		return true
	}
	if addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() {
		return !opts.AllowLinkLocal
	}
	if addr.IsLoopback() {
		return !opts.AllowLoopback && !opts.AllowPrivate
	}
	if addr.IsPrivate() {
		return !opts.AllowPrivate
	}
	if addr.Is4() {
		if thisNetPrefix4.Contains(addr) {
			return true
		}
		if cgnatPrefix.Contains(addr) {
			return !opts.AllowPrivate
		}
		if ietfProtoPrefix.Contains(addr) || benchmarkPrefix.Contains(addr) || futureUsePrefix4.Contains(addr) {
			return true
		}
	}
	return false
}

// SafeDialContext returns a DialContext function that validates all resolved IPs before dialing
// and pins the validated IP to defeat TOCTOU DNS rebinding.
func SafeDialContext(opts IPPolicyOptions) func(ctx context.Context, network, addr string) (net.Conn, error) {
	lookup := opts.LookupIP
	if lookup == nil {
		lookup = net.DefaultResolver.LookupIPAddr
	}
	timeout := opts.DialTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	dialer := &net.Dialer{Timeout: timeout}

	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, fmt.Errorf("%w: invalid dial address %q", ErrInvalidTargetURL, addr)
		}

		if ip, parseErr := netip.ParseAddr(host); parseErr == nil {
			ip = ip.Unmap()
			if IsBlockedIP(ip, opts) {
				return nil, fmt.Errorf("%w: IP %s is blocked", ErrPrivateNetworkBlocked, ip)
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		}

		ipAddrs, err := lookup(ctx, host)
		if err != nil {
			return nil, err
		}
		if len(ipAddrs) == 0 {
			return nil, fmt.Errorf("%w: no addresses resolved for %q", ErrPrivateNetworkBlocked, host)
		}

		// Verify every resolved address before connecting so multi-record responses cannot smuggle a private IP.
		validated := make([]netip.Addr, 0, len(ipAddrs))
		for _, ipAddr := range ipAddrs {
			parsed, ok := netip.AddrFromSlice(ipAddr.IP)
			if !ok {
				return nil, fmt.Errorf("%w: invalid resolved IP for %q", ErrPrivateNetworkBlocked, host)
			}
			parsed = parsed.Unmap()
			if ipAddr.Zone != "" {
				parsed = parsed.WithZone(ipAddr.Zone)
			}
			if IsBlockedIP(parsed, opts) {
				return nil, fmt.Errorf("%w: resolved IP %s for %q is blocked", ErrPrivateNetworkBlocked, parsed, host)
			}
			validated = append(validated, parsed)
		}

		var lastErr error
		for _, ip := range validated {
			conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if dialErr == nil {
				return conn, nil
			}
			lastErr = dialErr
		}
		return nil, lastErr
	}
}

func matchPort(patternPort, scheme, targetPort string) bool {
	if patternPort != "" {
		return patternPort == targetPort
	}
	return (scheme == "https" && targetPort == "443") || (scheme == "http" && targetPort == "80")
}

func validatePort(p string) error {
	if p == "" || (len(p) > 1 && p[0] == '0') {
		return fmt.Errorf("invalid port %q", p)
	}
	for i := range len(p) {
		if p[i] < '0' || p[i] > '9' {
			return fmt.Errorf("invalid port %q", p)
		}
	}
	n, err := strconv.Atoi(p)
	if err != nil || n < 1 || n > 65535 {
		return fmt.Errorf("port out of range %q", p)
	}
	return nil
}

func isValidDNSName(host string) bool {
	if len(host) == 0 || len(host) > 253 {
		return false
	}
	labels := strings.Split(host, ".")
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 {
			return false
		}
		if label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for i := range len(label) {
			c := label[i]
			if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
				return false
			}
		}
	}
	// Reject decimal/octal/hex IP obfuscations such as 2130706433, 0177.0.0.1, or 0x7f000001.
	last := labels[len(labels)-1]
	if isAllDigits(last) || strings.HasPrefix(last, "0x") {
		return false
	}
	return true
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := range len(s) {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

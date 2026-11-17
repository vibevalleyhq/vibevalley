package vault_test

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"net/url"
	"testing"

	"github.com/vibevalleyhq/vibevalley/internal/vault"
)

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("url.Parse(%q): %v", raw, err)
	}
	return u
}

func TestHostPatternParsingAndMatching(t *testing.T) {
	t.Parallel()

	invalidPatterns := []string{
		"",
		"*",
		"*.*",
		"*.com",
		"*.local",
		"api.*.com",
		"api.github.*",
		"https://api.github.com",
		"api.github.com/path",
		"user@api.github.com",
		"api.github.com:0",
		"api.github.com:65536",
		"api.github.com:0443",
		"192.168.*",
		"2130706433",
		"0177.0.0.1",
		"0x7f000001",
		"api.github.com ",
	}
	for _, raw := range invalidPatterns {
		if _, err := vault.ParseHostPattern(raw); !errors.Is(err, vault.ErrInvalidHostPattern) {
			t.Errorf("ParseHostPattern(%q) = %v, want ErrInvalidHostPattern", raw, err)
		}
	}

	patterns, err := vault.ValidateHostPatterns([]string{
		"API.GitHub.COM.",
		"*.mcp.example.com",
		"custom.host.org:8443",
		"[::1]:8080",
	})
	if err != nil {
		t.Fatalf("ValidateHostPatterns: %v", err)
	}

	cases := []struct {
		url  string
		want bool
	}{
		{"https://api.github.com/user", true},
		{"http://api.github.com/user", true},
		{"https://api.github.com:443/user", true},
		{"https://api.github.com:8443/user", false},
		{"https://sub.api.github.com/user", false},
		{"https://evil-api.github.com/user", false},
		{"https://api.github.com.evil.com/user", false},
		{"https://linear.mcp.example.com/sse", true},
		{"https://deep.sub.mcp.example.com/sse", true},
		{"https://mcp.example.com/sse", false},
		{"https://evilmcp.example.com/sse", false},
		{"https://linear.mcp.example.com:9000/sse", false},
		{"https://custom.host.org:8443/v1", true},
		{"https://custom.host.org/v1", false},
		{"http://custom.host.org:8443/v1", true},
		{"http://[::1]:8080/health", true},
		{"http://[::1]:9090/health", false},
	}
	for _, tc := range cases {
		ep, err := vault.ParseTargetEndpoint(mustURL(t, tc.url))
		if err != nil {
			t.Fatalf("ParseTargetEndpoint(%q): %v", tc.url, err)
		}
		if got := vault.MatchHostPatterns(patterns, ep); got != tc.want {
			t.Errorf("MatchHostPatterns(%q) = %v, want %v", tc.url, got, tc.want)
		}
	}

	for _, badURL := range []string{
		"file:///etc/passwd",
		"ftp://github.com/file",
		"https://allowed.com@evil.com/steal",
		"https://2130706433/admin",
		"https://0177.0.0.1/admin",
		"https://0x7f000001/admin",
	} {
		if _, err := vault.ParseTargetEndpoint(mustURL(t, badURL)); !errors.Is(err, vault.ErrInvalidTargetURL) {
			t.Errorf("ParseTargetEndpoint(%q) = %v, want ErrInvalidTargetURL", badURL, err)
		}
	}
}

func TestPrivateNetworkAndDNSRebindingBlocked(t *testing.T) {
	t.Parallel()

	blockedIPs := []string{
		"127.0.0.1",
		"127.1.2.3",
		"::1",
		"::ffff:127.0.0.1",
		"10.0.0.1",
		"172.16.0.1",
		"172.31.255.254",
		"192.168.1.10",
		"100.64.0.1",
		"169.254.169.254",
		"::ffff:169.254.169.254",
		"fe80::1",
		"fc00::1",
		"fd12:3456::1",
		"0.0.0.0",
		"0.1.2.3",
		"::",
		"224.0.0.1",
	}
	for _, raw := range blockedIPs {
		addr := netip.MustParseAddr(raw)
		if !vault.IsBlockedIP(addr, vault.IPPolicyOptions{}) {
			t.Errorf("IsBlockedIP(%s) = false, want true", raw)
		}
	}
	if vault.IsBlockedIP(netip.MustParseAddr("93.184.216.34"), vault.IPPolicyOptions{}) {
		t.Fatal("public IP 93.184.216.34 should not be blocked")
	}

	// CheckTargetNetworkPolicy blocks localhost, .local, .internal hostnames.
	for _, hostURL := range []string{
		"http://localhost/admin",
		"http://api.localhost/admin",
		"http://metadata.internal/latest",
		"http://printer.local/",
	} {
		ep, err := vault.ParseTargetEndpoint(mustURL(t, hostURL))
		if err != nil {
			t.Fatalf("ParseTargetEndpoint(%q): %v", hostURL, err)
		}
		if err := vault.CheckTargetNetworkPolicy(ep, vault.IPPolicyOptions{}); !errors.Is(err, vault.ErrPrivateNetworkBlocked) {
			t.Errorf("CheckTargetNetworkPolicy(%q) = %v, want ErrPrivateNetworkBlocked", hostURL, err)
		}
	}

	// SafeDialContext blocks DNS rebinding even when a public IP is paired with a metadata IP.
	dial := vault.SafeDialContext(vault.IPPolicyOptions{
		LookupIP: func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{
				{IP: net.ParseIP("93.184.216.34")},
				{IP: net.ParseIP("169.254.169.254")},
			}, nil
		},
	})
	if _, err := dial(context.Background(), "tcp", "rebind.allowed.example.com:443"); !errors.Is(err, vault.ErrPrivateNetworkBlocked) {
		t.Fatalf("DNS rebinding dial got %v, want ErrPrivateNetworkBlocked", err)
	}

	// Also blocks IPv4-mapped IPv6 DNS response to loopback even when AllowLoopback is false.
	dialLoopback := vault.SafeDialContext(vault.IPPolicyOptions{
		LookupIP: func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{
				{IP: net.ParseIP("::ffff:127.0.0.1")},
			}, nil
		},
	})
	if _, err := dialLoopback(context.Background(), "tcp", "rebind.allowed.example.com:443"); !errors.Is(err, vault.ErrPrivateNetworkBlocked) {
		t.Fatalf("DNS rebinding to ::ffff:127.0.0.1 got %v, want ErrPrivateNetworkBlocked", err)
	}
}

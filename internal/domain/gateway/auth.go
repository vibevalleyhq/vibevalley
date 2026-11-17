package gateway

import (
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/vibevalleyhq/vibevalley/internal/domain/lan"
	"github.com/vibevalleyhq/vibevalley/internal/domain/stack"
	"github.com/vibevalleyhq/vibevalley/internal/domain/user"
)

func isLoopbackHost(host string) bool {
	trimmed := strings.TrimSpace(strings.ToLower(host))
	if trimmed == "" {
		return false
	}
	if h, _, err := net.SplitHostPort(trimmed); err == nil {
		trimmed = h
	}
	trimmed = strings.Trim(trimmed, "[]")
	if trimmed == "localhost" || strings.HasSuffix(trimmed, ".localhost") {
		return true
	}
	ip := net.ParseIP(trimmed)
	return ip != nil && ip.IsLoopback()
}

// isOriginAllowed validates Origin/Sec-Fetch-Site against same-origin or loopback workbench origins.
func isOriginAllowed(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin != "" {
		if strings.EqualFold(origin, "null") {
			return false
		}
		parsed, err := url.Parse(origin)
		if err != nil {
			return false
		}
		scheme := strings.ToLower(parsed.Scheme)
		if scheme != "http" && scheme != "https" && scheme != "vibe" {
			// Allow custom desktop schemes or same-host origins when host matches r.Host.
			if r.Host == "" || !strings.EqualFold(parsed.Host, r.Host) {
				return false
			}
		}
		reqOutside := r.Header.Get(lan.HeaderOutside) == "1"
		if reqOutside {
			return strings.EqualFold(parsed.Host, r.Host)
		}
		if !isLoopbackHost(parsed.Host) && !strings.EqualFold(parsed.Host, r.Host) {
			return false
		}
	}

	sfs := strings.TrimSpace(strings.ToLower(r.Header.Get("Sec-Fetch-Site")))
	if sfs == "cross-site" {
		return false
	}
	return true
}

func resolveCaller(st *stack.Stack, r *http.Request) user.Caller {
	outside := r.Header.Get(lan.HeaderOutside) == "1"
	caller := user.Caller{
		Here: !outside,
		From: strings.TrimSpace(r.Header.Get(lan.HeaderFrom)),
	}
	if outside {
		caller.DeviceID = strings.TrimSpace(r.Header.Get(lan.HeaderLANDevice))
	}
	if st != nil && st.User != nil {
		rawTok := user.ExtractTokenFromRequest(r)
		if rawTok != "" {
			if dev, ok := st.User.VerifyToken(rawTok); ok {
				caller.DeviceID = dev.ID
			}
		}
	}
	return caller
}

func requireLocalUser(caller user.Caller) error {
	if !caller.Here {
		return newBizError(BizLanForbidden, "operation is restricted to the host machine")
	}
	return nil
}

func requireOwnerOrLogin(st *stack.Stack, caller user.Caller) error {
	if caller.Here {
		return nil
	}
	if st == nil || st.User == nil || caller.DeviceID == "" {
		return newBizError(BizForbidden, "operation requires an owner session")
	}
	for _, dev := range st.User.ListDevices() {
		if dev.ID == caller.DeviceID && dev.Came == user.DeviceCameLogin {
			return nil
		}
	}
	return newBizError(BizForbidden, "paired device is restricted from owner-only operation")
}

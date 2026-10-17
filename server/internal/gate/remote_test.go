package gate

import (
	"net/http/httptest"
	"regexp"
	"slices"
	"testing"

	"vibevalley/internal/protocol"
)

// The gate lets a device through to an endpoint exactly when api.go says vibevalley:can remote.
func TestRemoteMayFollowsCan(t *testing.T) {
	param := regexp.MustCompile(`\{\w+\}`)
	for _, e := range protocol.Endpoints {
		r := httptest.NewRequest(e.Method, param.ReplaceAllString(e.Path, "1"), nil)
		if got, want := remoteMay(r), slices.Contains(e.Can, protocol.CallerRemote); got != want {
			t.Errorf("%s %s %s: the gate lets it through %v, can remote %v", e.Op, e.Method, e.Path, got, want)
		}
	}
	for _, s := range protocol.Streams {
		if slices.Contains(s.Can, protocol.CallerRemote) && !remoteMay(httptest.NewRequest("GET", s.Path, nil)) {
			t.Errorf("GET %s refused", s.Path)
		}
	}
	if remoteMay(httptest.NewRequest("GET", "/api/v1/nothing-here", nil)) {
		t.Error("an unknown path let through")
	}
}

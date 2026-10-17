package protocol

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vibevalley/internal/testkit"
)

// Only what the test asks; anything else panics on the nil Handlers.
type mountFake struct {
	Handlers
	removed []int64
	toggled []bool
	history [][2]*int64
}

func (f *mountFake) ScheduleRemove(_ context.Context, id int64) error {
	if id == 404 {
		return Missing{What: "定时 404"}
	}
	f.removed = append(f.removed, id)
	return nil
}

func (f *mountFake) ScheduleToggle(_ context.Context, _ int64, body ToggleScheduleRequest) error {
	f.toggled = append(f.toggled, body.Enabled)
	return nil
}

func (f *mountFake) ChannelHistory(_ context.Context, _ int64, before, limit *int64) ([]ChatMessage, error) {
	f.history = append(f.history, [2]*int64{before, limit})
	return nil, nil
}

func (f *mountFake) ServerHealth(context.Context) (Health, error) {
	return Health{}, errors.New("boom")
}

func TestMountKeepsTheContract(t *testing.T) {
	f := &mountFake{}
	mux := http.NewServeMux()
	Mount(mux, f)
	ask := func(method, path, body string) (int, string) {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
		return w.Code, strings.TrimSpace(w.Body.String())
	}

	code, _ := ask("DELETE", "/api/schedules/7", "")
	testkit.Eq(t, [2]any{code, f.removed}, [2]any{http.StatusNoContent, []int64{7}}, "nothing to answer is 204")
	code, body := ask("DELETE", "/api/schedules/seven", "")
	testkit.Eq(t, [2]any{code, body}, [2]any{http.StatusNotFound, `{"_tag":"Missing","what":"seven"}`}, "a number path that is not a number is nothing there")
	code, body = ask("DELETE", "/api/schedules/404", "")
	testkit.Eq(t, [2]any{code, body}, [2]any{http.StatusNotFound, `{"_tag":"Missing","what":"定时 404"}`}, "a tagged error has its own status")
	code, _ = ask("PUT", "/api/schedules/7", "{not json")
	testkit.Eq(t, [2]any{code, f.toggled}, [2]any{http.StatusBadRequest, []bool(nil)}, "a body that is not JSON never reaches the service")
	code, body = ask("GET", "/api/health", "")
	testkit.Eq(t, [2]any{code, body}, [2]any{http.StatusInternalServerError, "boom"}, "any other error is 500")
	code, body = ask("GET", "/api/chat/3/messages?before=10&limit=many", "")
	testkit.Eq(t, [2]any{code, body}, [2]any{http.StatusOK, "[]"}, "a nil list is []")
	testkit.Eq(t, *f.history[0][0], int64(10), "a number query")
	testkit.Eq(t, f.history[0][1], (*int64)(nil), "one that is not a number is none")
}

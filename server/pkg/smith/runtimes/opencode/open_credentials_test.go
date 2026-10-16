package opencode

// Ported from tests/opencode/open-credentials.test.ts. TS's mocked runner
// throws an error carrying the key; a Go runner answers a failed run whose
// stderr carries it, which the preparation's error quotes.

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/oar"
)

func TestPreparationBeforeTheACPOpenUsesTheSessionCredentialRuleToo(t *testing.T) {
	one := 1
	useRunner(t, executable.Result{Stderr: "provider rejected opencode-open-key-sentinel", ExitCode: &one})
	cwd, _ := os.Getwd()
	_, err := Session(context.Background(), oar.AvailableInstallation{Via: "executable", Command: "not-spawned", Version: "1.18.35"}, oar.SessionOptions{
		Cwd: cwd, SystemPrompt: oar.String("replace"), Env: map[string]*string{"API_KEY": oar.String("opencode-open-key-sentinel")},
	})
	if err == nil || !strings.Contains(err.Error(), "provider rejected [redacted]") || strings.Contains(fmt.Sprintf("%+v %#v", err, err), "opencode-open-key-sentinel") {
		t.Fatalf("%v", err)
	}
}

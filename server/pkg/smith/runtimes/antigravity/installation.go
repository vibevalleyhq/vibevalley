package antigravity

import (
	"regexp"
	"runtime"
	"time"

	"vibevalley/pkg/smith/internal/shared"
)

var buildLabel = regexp.MustCompile(`(?m)^Build label:\s*(\S+)`)

// ReadVersion reads agy_acp_server's `--version` build stamp: the release is
// the `Build label:` line ("" when there is none). Its `--help` exits 1, so
// there is no cheap readiness check beyond the version read.
func ReadVersion(stdout string) string {
	if match := buildLabel.FindStringSubmatch(stdout); match != nil {
		return match[1]
	}
	return ""
}

func executableName() string {
	if runtime.GOOS == "windows" {
		return "agy_acp_server.exe"
	}
	return "agy_acp_server.par"
}

// Installation: the ACP registry ships the server as a zip that unpacks to
// `agy_acp_server.par` (`agy_acp_server.exe` on Windows) with no installer,
// so it is found on PATH or pinned with OAR_ANTIGRAVITY_BIN.
var Installation = shared.ExecutableInstallation("OAR_ANTIGRAVITY_BIN", executableName(), nil, nil, shared.ExecutableInstallationOptions{VersionTimeout: 30 * time.Second, ReadVersion: ReadVersion})

package pi

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"vibevalley/pkg/smith/oar"
)

// AgentDir is pi's global config home for every pi entry point (resolve.ts
// piAgentDir): OAR_PI_AGENT_DIR, else pi's own (PI_CODING_AGENT_DIR or
// ~/.pi/agent). Empty counts as unset, as pi treats an empty PI_CODING_AGENT_DIR.
func AgentDir() string {
	if pinned := os.Getenv("OAR_PI_AGENT_DIR"); pinned != "" {
		return pinned
	}
	if own := os.Getenv("PI_CODING_AGENT_DIR"); own != "" {
		return own
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pi", "agent")
}

var slugSeparators = regexp.MustCompile(`[/\\:]`)

// SessionDir mirrors pi's getDefaultSessionDirPath: the cwd with its leading
// separator dropped and every `/ \ :` turned into `-`, wrapped in `--…--`
// under <agentDir>/sessions.
func SessionDir(cwd, agentDir string) string {
	resolved, err := filepath.Abs(cwd)
	if err != nil {
		resolved = cwd
	}
	slug := slugSeparators.ReplaceAllString(strings.TrimLeft(resolved, `/\`), "-")
	absoluteAgentDir, err := filepath.Abs(agentDir)
	if err != nil {
		absoluteAgentDir = agentDir
	}
	return filepath.Join(absoluteAgentDir, "sessions", "--"+slug+"--")
}

// sessionDirs are the directories pi may have stored the cwd's sessions in:
// the cwd as given and its real path (pi 1.1.0 slugs the canonical path).
func sessionDirs(cwd, agentDir string) []string {
	dirs := []string{SessionDir(cwd, agentDir)}
	if real, err := filepath.EvalSymlinks(cwd); err == nil {
		if other := SessionDir(real, agentDir); other != dirs[0] {
			dirs = append(dirs, other)
		}
	}
	return dirs
}

// headerID is a session file's id: its first line, `{"type":"session","id":…}`.
func headerID(file string) string {
	handle, err := os.Open(file)
	if err != nil {
		return ""
	}
	defer handle.Close()
	reader := bufio.NewReaderSize(handle, 64*1024)
	line, _ := reader.ReadString('\n')
	var header struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(line)), &header) != nil || header.Type != "session" {
		return ""
	}
	return header.ID
}

// FindSessionFile maps a session id to its file under the cwd's session
// directory (resolve.ts piFindSessionFile). Listing is per cwd: a session
// started elsewhere is not found here.
func FindSessionFile(id, cwd, agentDir string) (string, error) {
	dirs := sessionDirs(cwd, agentDir)
	count := 0
	for _, dir := range dirs {
		entries, _ := os.ReadDir(dir)
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
				continue
			}
			count++
			path := filepath.Join(dir, entry.Name())
			if headerID(path) == id {
				return path, nil
			}
		}
	}
	native, _ := json.Marshal(map[string]any{"cwd": cwd, "sessionDir": dirs[0], "sessionCount": count})
	return "", &oar.SessionNotFoundError{
		SessionID: id,
		Message: fmt.Sprintf("pi session %s not found: no session file with that id under %s (%d session(s) there for cwd %s; pi persists a session on its first message)",
			id, dirs[0], count, cwd),
		Method: "SessionManager.list",
		Native: native,
	}
}

// SplitModelID splits `provider/model` at the first slash; model ids may contain slashes.
func SplitModelID(model string) (provider, modelID string, err error) {
	slash := strings.Index(model, "/")
	if slash <= 0 || slash == len(model)-1 {
		quoted, _ := json.Marshal(model)
		return "", "", fmt.Errorf("pi model must be spelled provider/model as listed by `oar models pi`; got %s", quoted)
	}
	return model[:slash], model[slash+1:], nil
}

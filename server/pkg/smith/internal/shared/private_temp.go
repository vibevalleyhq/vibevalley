package shared

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
)

// Temporary directories oar makes for one runtime process (claude's MCP
// config, opencode's appended prompt): <prefix><host pid>-XXXXXX in the
// system temporary directory, mode 0700. Their owner removes them when the
// process ends. Two backstops for a host that ends without disposing its
// sessions: RemovePrivateTempDirs removes every directory still present
// (TS runs it on the host's exit event; Go has none, so the host calls it
// on its shutdown path), and making the next directory with the same prefix
// (or SweepPrivateTempDirs) first removes those whose host pid no longer
// runs. A pid the system has given to another process since keeps its
// directory until that process ends too; this host's own pid is never
// swept, since a directory another session of it is making may not be
// registered yet.
//
// Every removal first releases a reader blocked opening a FIFO in the
// directory (claude waiting for its MCP config): a writer opens and closes
// at once, so the reader reads an empty document and fails instead of
// waiting forever, which unlinking the FIFO alone would leave it doing.

// PrivateTempDir is a directory NewPrivateTempDir made.
type PrivateTempDir struct {
	Path string
}

var (
	liveMu sync.Mutex
	live   = map[string]bool{}
)

func releaseFifos(directory string) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return
	}
	for _, entry := range entries {
		file := filepath.Join(directory, entry.Name())
		if info, err := os.Lstat(file); err == nil {
			releaseFifo(file, info)
		}
	}
}

func removeDirectory(directory string) {
	releaseFifos(directory)
	_ = os.RemoveAll(directory)
}

// RemovePrivateTempDirs removes every private temporary directory this host
// still has: the backstop TS runs on the host's exit event. Call it on the
// host's shutdown path; a host that is killed runs nothing, and the next
// sweep takes its directories.
func RemovePrivateTempDirs() {
	liveMu.Lock()
	directories := make([]string, 0, len(live))
	for directory := range live {
		directories = append(directories, directory)
	}
	live = map[string]bool{}
	liveMu.Unlock()
	for _, directory := range directories {
		removeDirectory(directory)
	}
}

var hostPid = regexp.MustCompile(`^(\d+)-`)

// SweepPrivateTempDirs removes prefix directories whose host pid no longer
// runs, releasing their FIFOs first; one that cannot be removed (another
// user's) stays.
func SweepPrivateTempDirs(prefix string) {
	root := os.TempDir()
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	own := os.Getpid()
	var wait sync.WaitGroup
	for _, entry := range entries {
		name := entry.Name()
		if len(name) < len(prefix) || name[:len(prefix)] != prefix {
			continue
		}
		match := hostPid.FindStringSubmatch(name[len(prefix):])
		if match == nil {
			continue
		}
		pid, err := strconv.Atoi(match[1])
		if err != nil || pid == own || pidRunning(pid) {
			continue
		}
		wait.Add(1)
		go func(directory string) {
			defer wait.Done()
			removeDirectory(directory)
		}(filepath.Join(root, name))
	}
	wait.Wait()
}

// NewPrivateTempDir makes a fresh 0700 directory for one runtime process,
// removed by Remove or, failing that, by the backstops above.
func NewPrivateTempDir(prefix string) (*PrivateTempDir, error) {
	SweepPrivateTempDirs(prefix)
	directory, err := os.MkdirTemp(os.TempDir(), prefix+strconv.Itoa(os.Getpid())+"-")
	if err != nil {
		return nil, err
	}
	liveMu.Lock()
	live[directory] = true
	liveMu.Unlock()
	return &PrivateTempDir{Path: directory}, nil
}

// Remove removes the directory, releasing its FIFOs first. Synchronous and idempotent.
func (d *PrivateTempDir) Remove() {
	liveMu.Lock()
	delete(live, d.Path)
	liveMu.Unlock()
	removeDirectory(d.Path)
}

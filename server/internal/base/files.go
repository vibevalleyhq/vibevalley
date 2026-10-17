package base

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
)

// FileWriter saves a file the server keeps (state.json, sessions.json, config.json…): whole or not at all, and in order.
// Each write goes to a temporary file and is renamed over the file, so a crash never leaves half a file; writes to one
// file run one after another, so the last one asked for is the one left on disk.
type FileWriter struct {
	path string
	mode os.FileMode
	mu   sync.Mutex
	n    atomic.Int64
}

func NewFileWriter(path string, mode os.FileMode) *FileWriter {
	if mode == 0 {
		mode = 0o644
	}
	return &FileWriter{path: path, mode: mode}
}

// body is asked when this write's turn comes: the state as it is then.
func (w *FileWriter) Write(body func() ([]byte, error)) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	data, err := body()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(w.path), 0o755); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.%d.tmp", w.path, os.Getpid(), w.n.Add(1))
	if err := os.WriteFile(tmp, data, w.mode); err != nil {
		return err
	}
	return os.Rename(tmp, w.path)
}

package machine

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	ErrEnvClosed            = errors.New("machine: execution env is closed")
	ErrPathTraversal        = errors.New("machine: path escapes workspace root")
	ErrInvalidPath          = errors.New("machine: invalid relative path")
	ErrReadOnlyMount        = errors.New("machine: target is in a read-only mount")
	ErrPatchTargetNotFound  = errors.New("machine: edit patch oldText not found")
	ErrPatchTargetAmbiguous = errors.New("machine: edit patch oldText matched multiple locations")
	ErrLinkDisconnected     = errors.New("machine: link disconnected")
)

const (
	defaultDirPerm     os.FileMode = 0o755
	defaultFilePerm    os.FileMode = 0o644
	defaultExecGrace               = 2 * time.Second
	maxExecGrace                   = 3 * time.Second
	syncStateRelPath               = ".vibe/.sync-state.json"
	skillsMountPrefix              = ".vibe/skills"
	memoryMountPrefix              = ".vibe/memory"
	outputsMountPrefix             = ".vibe/outputs"
	ephemeralTempDir               = ".vibe/tmp"
)

type fileLockKey struct {
	envID string
	path  string
}

type refRWMutex struct {
	mu   sync.RWMutex
	refs int
}

// PathLocks serializes file mutations per (envID, canonicalPath) without leaking entries.
type PathLocks struct {
	mu    sync.Mutex
	locks map[fileLockKey]*refRWMutex
}

// NewPathLocks returns a concurrency-safe path lock table.
func NewPathLocks() *PathLocks {
	return &PathLocks{locks: make(map[fileLockKey]*refRWMutex)}
}

var defaultPathLocks = NewPathLocks()

// Lock acquires an exclusive write lock for (envID, canonicalPath).
func (p *PathLocks) Lock(envID, canonicalPath string) func() {
	entry := p.acquireEntry(envID, canonicalPath)
	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		p.releaseEntry(envID, canonicalPath, entry)
	}
}

// RLock acquires a shared read lock for (envID, canonicalPath).
func (p *PathLocks) RLock(envID, canonicalPath string) func() {
	entry := p.acquireEntry(envID, canonicalPath)
	entry.mu.RLock()
	return func() {
		entry.mu.RUnlock()
		p.releaseEntry(envID, canonicalPath, entry)
	}
}

func (p *PathLocks) acquireEntry(envID, canonicalPath string) *refRWMutex {
	key := fileLockKey{envID: envID, path: canonicalPath}
	p.mu.Lock()
	defer p.mu.Unlock()
	entry, ok := p.locks[key]
	if !ok {
		entry = &refRWMutex{}
		p.locks[key] = entry
	}
	entry.refs++
	return entry
}

func (p *PathLocks) releaseEntry(envID, canonicalPath string, entry *refRWMutex) {
	key := fileLockKey{envID: envID, path: canonicalPath}
	p.mu.Lock()
	defer p.mu.Unlock()
	entry.refs--
	if entry.refs == 0 {
		delete(p.locks, key)
	}
}

// LocalEnvConfig configures a workspace-scoped ExecutionEnv implementation.
type LocalEnvConfig struct {
	EnvID           string
	WorkDir         string
	Locks           *PathLocks
	ExecGracePeriod time.Duration
	MountRemote     MountRemote
	MaxHarvestBytes int64
}

// LocalEnv implements contract.ExecutionEnv over a local or container workspace directory.
type LocalEnv struct {
	envID           string
	workDir         string
	resolvedRoot    string
	root            *os.Root
	locks           *PathLocks
	execGrace       time.Duration
	mountRemote     MountRemote
	maxHarvestBytes int64

	// Lock ordering: syncMu must always be acquired before any PathLocks entry.
	syncMu sync.Mutex

	lifeMu     sync.Mutex
	lifeCtx    context.Context
	lifeCancel context.CancelCauseFunc
	closed     atomic.Bool
	closeOnce  sync.Once
	execWG     sync.WaitGroup
}

// NewLocalEnv constructs an ExecutionEnv rooted at cfg.WorkDir.
func NewLocalEnv(cfg LocalEnvConfig) (*LocalEnv, error) {
	if strings.TrimSpace(cfg.WorkDir) == "" {
		return nil, fmt.Errorf("%w: empty workDir", ErrInvalidPath)
	}
	envID := strings.TrimSpace(cfg.EnvID)
	if envID == "" {
		envID = cfg.WorkDir
	}
	absRoot, err := filepath.Abs(cfg.WorkDir)
	if err != nil {
		return nil, fmt.Errorf("resolve workDir: %w", err)
	}
	if err := os.MkdirAll(absRoot, defaultDirPerm); err != nil {
		return nil, fmt.Errorf("create workDir: %w", err)
	}
	resolvedRoot, err := filepath.EvalSymlinks(absRoot)
	if err != nil {
		return nil, fmt.Errorf("canonicalize workDir: %w", err)
	}
	root, err := os.OpenRoot(resolvedRoot)
	if err != nil {
		return nil, fmt.Errorf("open root %s: %w", resolvedRoot, err)
	}

	locks := cfg.Locks
	if locks == nil {
		locks = defaultPathLocks
	}
	grace := cfg.ExecGracePeriod
	if grace <= 0 {
		grace = defaultExecGrace
	}
	if grace > maxExecGrace {
		grace = maxExecGrace
	}
	maxHarvest := cfg.MaxHarvestBytes
	if maxHarvest <= 0 {
		maxHarvest = 64 << 20 // 64 MiB default inline harvest cap
	}

	lifeCtx, lifeCancel := context.WithCancelCause(context.Background())
	return &LocalEnv{
		envID:           envID,
		workDir:         absRoot,
		resolvedRoot:    resolvedRoot,
		root:            root,
		locks:           locks,
		execGrace:       grace,
		mountRemote:     cfg.MountRemote,
		maxHarvestBytes: maxHarvest,
		lifeCtx:         lifeCtx,
		lifeCancel:      lifeCancel,
	}, nil
}

// EnvID returns the environment identifier used for locking and lease tracking.
func (e *LocalEnv) EnvID() string {
	return e.envID
}

// RootDir returns the canonicalized workspace directory path on disk.
func (e *LocalEnv) RootDir() string {
	return e.resolvedRoot
}

// WriteAtomic writes data to relPath using a per-(envID, canonicalPath) lock and same-dir atomic rename.
func (e *LocalEnv) WriteAtomic(ctx context.Context, relPath string, data []byte, perm uint32) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if e.closed.Load() {
		return ErrEnvClosed
	}
	cleanRel, canonical, err := e.resolveRelPath(relPath, false)
	if err != nil {
		return err
	}
	if isProtectedWriteRel(cleanRel) {
		return fmt.Errorf("%w: %s", ErrReadOnlyMount, cleanRel)
	}

	unlock := e.locks.Lock(e.envID, canonical)
	defer unlock()

	if err := ctx.Err(); err != nil {
		return err
	}
	if e.closed.Load() {
		return ErrEnvClosed
	}
	return e.writeFileAtomicUnlocked(cleanRel, data, perm)
}

// EditPatch replaces a unique occurrence of oldText with newText atomically under the path lock.
func (e *LocalEnv) EditPatch(ctx context.Context, relPath string, oldText string, newText string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if e.closed.Load() {
		return ErrEnvClosed
	}
	if oldText == "" {
		return errors.New("machine: oldText must not be empty")
	}
	cleanRel, canonical, err := e.resolveRelPath(relPath, false)
	if err != nil {
		return err
	}
	if isProtectedWriteRel(cleanRel) {
		return fmt.Errorf("%w: %s", ErrReadOnlyMount, cleanRel)
	}

	unlock := e.locks.Lock(e.envID, canonical)
	defer unlock()

	if err := ctx.Err(); err != nil {
		return err
	}
	if e.closed.Load() {
		return ErrEnvClosed
	}

	info, err := e.root.Stat(cleanRel)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return fmt.Errorf("%w: %s is a directory", ErrInvalidPath, cleanRel)
	}

	raw, err := e.root.ReadFile(cleanRel)
	if err != nil {
		return err
	}
	content := string(raw)
	count := strings.Count(content, oldText)
	if count == 0 {
		return fmt.Errorf("%w: %s", ErrPatchTargetNotFound, cleanRel)
	}
	if count > 1 {
		return fmt.Errorf("%w: %d matches in %s", ErrPatchTargetAmbiguous, count, cleanRel)
	}

	patched := strings.Replace(content, oldText, newText, 1)
	return e.writeFileAtomicUnlocked(cleanRel, []byte(patched), uint32(info.Mode().Perm()))
}

// ReadFile reads the file at relPath within the workspace root under a shared path lock.
func (e *LocalEnv) ReadFile(ctx context.Context, relPath string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if e.closed.Load() {
		return nil, ErrEnvClosed
	}
	cleanRel, canonical, err := e.resolveRelPath(relPath, false)
	if err != nil {
		return nil, err
	}

	unlock := e.locks.RLock(e.envID, canonical)
	defer unlock()

	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if e.closed.Load() {
		return nil, ErrEnvClosed
	}
	return e.root.ReadFile(cleanRel)
}

// Disconnect cancels running executions immediately because the control-plane link dropped.
func (e *LocalEnv) Disconnect(cause error) {
	if cause == nil {
		cause = ErrLinkDisconnected
	}
	e.lifeMu.Lock()
	cancel := e.lifeCancel
	e.lifeMu.Unlock()
	cancel(cause)
}

// ResetLink restores a fresh execution lifecycle after the outbound link reconnects.
func (e *LocalEnv) ResetLink() {
	e.lifeMu.Lock()
	defer e.lifeMu.Unlock()
	if e.closed.Load() || e.lifeCtx.Err() == nil {
		return
	}
	e.lifeCtx, e.lifeCancel = context.WithCancelCause(context.Background())
}

// Close cancels active subprocesses, cleans temporary runtime mounts, and closes the workspace root handle.
func (e *LocalEnv) Close() error {
	var closeErr error
	e.closeOnce.Do(func() {
		e.lifeMu.Lock()
		e.closed.Store(true)
		cancel := e.lifeCancel
		e.lifeMu.Unlock()
		cancel(ErrEnvClosed)
		e.execWG.Wait()
		_ = e.root.RemoveAll(ephemeralTempDir)
		closeErr = e.root.Close()
	})
	return closeErr
}

func (e *LocalEnv) writeFileAtomicUnlocked(cleanRel string, data []byte, perm uint32) error {
	parentRel := filepath.Dir(cleanRel)
	if parentRel != "." {
		if err := e.root.MkdirAll(parentRel, defaultDirPerm); err != nil {
			return fmt.Errorf("mkdir %s: %w", parentRel, err)
		}
	}

	mode := os.FileMode(perm) & os.ModePerm
	if perm == 0 {
		mode = defaultFilePerm
	}

	tmpRel := tempRelPath(parentRel)
	tmpFile, err := e.root.OpenFile(tmpRel, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}

	cleanup := true
	defer func() {
		if cleanup {
			_ = tmpFile.Close()
			_ = e.root.Remove(tmpRel)
		}
	}()

	if err := writeAll(tmpFile, data); err != nil {
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmpFile.Chmod(mode); err != nil {
		return fmt.Errorf("chmod temp file: %w", err)
	}
	if err := tmpFile.Sync(); err != nil {
		return fmt.Errorf("sync temp file: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := e.root.Rename(tmpRel, cleanRel); err != nil {
		return fmt.Errorf("rename %s -> %s: %w", tmpRel, cleanRel, err)
	}
	cleanup = false
	return nil
}

func writeAll(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		if err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}

func tempRelPath(parentRel string) string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return filepath.Join(parentRel, fmt.Sprintf(".vibe-tmp-%d", time.Now().UnixNano()))
	}
	name := ".vibe-tmp-" + hex.EncodeToString(b[:])
	if parentRel == "." {
		return name
	}
	return filepath.Join(parentRel, name)
}

func isProtectedWriteRel(cleanRel string) bool {
	slash := filepath.ToSlash(cleanRel)
	if slash == skillsMountPrefix || strings.HasPrefix(slash, skillsMountPrefix+"/") {
		return true
	}
	return slash == syncStateRelPath
}

func (e *LocalEnv) resolveRelPath(relPath string, allowRootDot bool) (cleanRel string, canonicalPath string, err error) {
	if relPath == "" {
		if allowRootDot {
			return ".", e.resolvedRoot, nil
		}
		return "", "", fmt.Errorf("%w: empty path", ErrInvalidPath)
	}
	if strings.ContainsRune(relPath, 0) {
		return "", "", fmt.Errorf("%w: null byte in path", ErrInvalidPath)
	}
	if filepath.IsAbs(relPath) || strings.HasPrefix(relPath, "/") || strings.HasPrefix(relPath, "\\") {
		return "", "", fmt.Errorf("%w: absolute path %q", ErrPathTraversal, relPath)
	}
	slashRaw := filepath.ToSlash(relPath)
	for seg := range strings.SplitSeq(slashRaw, "/") {
		if seg == ".." {
			return "", "", fmt.Errorf("%w: parent segment in %q", ErrPathTraversal, relPath)
		}
	}
	clean := filepath.Clean(relPath)
	if clean == "." {
		if !allowRootDot {
			return "", "", fmt.Errorf("%w: cannot address root as file", ErrInvalidPath)
		}
		return ".", e.resolvedRoot, nil
	}
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || filepath.IsAbs(clean) {
		return "", "", fmt.Errorf("%w: %q", ErrPathTraversal, relPath)
	}

	absTarget := filepath.Join(e.resolvedRoot, clean)
	canonical, err := resolveContainment(e.resolvedRoot, absTarget)
	if err != nil {
		return "", "", err
	}
	return clean, canonical, nil
}

// resolveContainment resolves the deepest existing ancestor through symlinks to block escapes
// even when intermediate or target files do not exist yet.
func resolveContainment(resolvedRoot, absTarget string) (string, error) {
	if info, err := os.Lstat(absTarget); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			resolved, err := filepath.EvalSymlinks(absTarget)
			if err != nil {
				return "", fmt.Errorf("%w: %v", ErrPathTraversal, err)
			}
			if !isWithinRoot(resolvedRoot, resolved) {
				return "", fmt.Errorf("%w: symlink %s resolves outside workspace", ErrPathTraversal, absTarget)
			}
			return resolved, nil
		}
		resolved, err := filepath.EvalSymlinks(absTarget)
		if err != nil {
			return "", err
		}
		if !isWithinRoot(resolvedRoot, resolved) {
			return "", fmt.Errorf("%w: %s resolves outside workspace", ErrPathTraversal, absTarget)
		}
		return resolved, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}

	cur := absTarget
	var tail []string
	for {
		parent := filepath.Dir(cur)
		base := filepath.Base(cur)
		tail = append(tail, base)
		if parent == cur {
			return "", fmt.Errorf("%w: no existing ancestor for %s", ErrPathTraversal, absTarget)
		}
		cur = parent
		if _, err := os.Lstat(cur); err == nil {
			resolvedAncestor, err := filepath.EvalSymlinks(cur)
			if err != nil {
				return "", fmt.Errorf("%w: %v", ErrPathTraversal, err)
			}
			if !isWithinRoot(resolvedRoot, resolvedAncestor) {
				return "", fmt.Errorf("%w: ancestor %s resolves outside workspace", ErrPathTraversal, cur)
			}
			joined := resolvedAncestor
			for i := len(tail) - 1; i >= 0; i-- {
				joined = filepath.Join(joined, tail[i])
			}
			if !isWithinRoot(resolvedRoot, joined) {
				return "", fmt.Errorf("%w: %s", ErrPathTraversal, joined)
			}
			return joined, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	}
}

func isWithinRoot(root, candidate string) bool {
	if candidate == root {
		return true
	}
	prefix := root
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	return strings.HasPrefix(candidate, prefix)
}

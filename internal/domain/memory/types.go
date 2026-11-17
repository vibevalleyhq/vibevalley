package memory

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path"
	"strings"
)

var (
	// ErrNotFound is returned when a requested memory scope, version, conflict, or dream proposal does not exist.
	ErrNotFound = errors.New("memory: not found")
	// ErrConflict is returned on optimistic version mismatch or concurrent modification.
	ErrConflict = errors.New("memory: version conflict")
	// ErrInvalidArgument is returned for invalid paths, empty scopes, or malformed arguments.
	ErrInvalidArgument = errors.New("memory: invalid argument")
	// ErrInvalidTransition is returned when approving, rejecting, or rolling back a proposal in an incompatible state.
	ErrInvalidTransition = errors.New("memory: invalid state transition")
	// ErrChecksumMismatch is returned when an uploaded MountFile SHA-256 does not match its content.
	ErrChecksumMismatch = errors.New("memory: checksum mismatch")
	// ErrClosed is returned when operations are invoked on a closed Store.
	ErrClosed = errors.New("memory: store closed")
)

const (
	// DefaultScopeID is used when a caller omits an explicit agent or workspace scope identifier.
	DefaultScopeID = "default"

	memoryMountPrefix = ".vibe/memory"
)

// VersionKind classifies how an immutable memory snapshot version was created.
type VersionKind string

const (
	VersionInit               VersionKind = "init"
	VersionMountSync          VersionKind = "mount_sync"
	VersionManual             VersionKind = "manual"
	VersionDreamCandidate     VersionKind = "dream_candidate"
	VersionConflictResolution VersionKind = "conflict_resolution"
	VersionRollback           VersionKind = "rollback"
)

// VersionStatus tracks whether a snapshot version is active, superseded, pending candidate, rejected, or rolled back.
type VersionStatus string

const (
	VersionStatusActive     VersionStatus = "active"
	VersionStatusSuperseded VersionStatus = "superseded"
	VersionStatusCandidate  VersionStatus = "candidate"
	VersionStatusRejected   VersionStatus = "rejected"
	VersionStatusRolledBack VersionStatus = "rolled_back"
)

// DreamStatus enumerates lifecycle states for a DreamProposalView.
type DreamStatus string

const (
	DreamPending    DreamStatus = "pending"
	DreamApproved   DreamStatus = "approved"
	DreamRejected   DreamStatus = "rejected"
	DreamRolledBack DreamStatus = "rolled_back"
)

// ConflictResolution chooses how to resolve a preserved mount conflict branch.
type ConflictResolution string

const (
	ResolutionKeepServer     ConflictResolution = "keep_server"
	ResolutionAcceptConflict ConflictResolution = "accept_conflict"
	ResolutionMerge          ConflictResolution = "merge"
)

// MemoryFile represents a single immutable file within a snapshot version.
type MemoryFile struct {
	RelPath     string `json:"relPath"`
	Version     int64  `json:"version"`
	SHA256      string `json:"sha256"`
	Content     []byte `json:"content"`
	UpdatedAtMs int64  `json:"updatedAtMs"`
}

// MemoryFileInput supplies a memory file payload to commit into a new snapshot version.
type MemoryFileInput struct {
	RelPath     string
	BaseVersion int64
	Content     []byte
}

// Snapshot is an immutable point-in-time memory version for a scope.
type Snapshot struct {
	ScopeID       string        `json:"scopeId"`
	Version       int64         `json:"version"`
	ParentVersion int64         `json:"parentVersion"`
	Kind          VersionKind   `json:"kind"`
	Status        VersionStatus `json:"status"`
	Summary       string        `json:"summary,omitempty"`
	SessionID     string        `json:"sessionId,omitempty"`
	CreatedAtMs   int64         `json:"createdAtMs"`
	Files         []MemoryFile  `json:"files,omitempty"`
}

// File returns a copy of the named memory file within the snapshot if present.
func (s Snapshot) File(relPath string) (MemoryFile, bool) {
	norm, err := normalizeMemoryRelPath(relPath)
	if err != nil {
		return MemoryFile{}, false
	}
	for _, f := range s.Files {
		if f.RelPath == norm {
			return cloneMemoryFile(f), true
		}
	}
	return MemoryFile{}, false
}

// CommitRequest commits an explicit set of memory file updates atomically on expected version.
type CommitRequest struct {
	ScopeID         string
	ExpectedVersion int64 // When > 0, requires current active version == ExpectedVersion.
	SessionID       string
	Summary         string
	Files           []MemoryFileInput
	DeletePaths     []string
}

// ConflictBranch preserves a concurrent `.vibe/memory/` edit instead of overwriting newer active memory.
type ConflictBranch struct {
	ConflictID      string             `json:"conflictId"`
	ScopeID         string             `json:"scopeId"`
	RelPath         string             `json:"relPath"`
	BaseVersion     int64              `json:"baseVersion"`
	ServerVersion   int64              `json:"serverVersion"`
	ConflictRelPath string             `json:"conflictRelPath"`
	UploadedSHA256  string             `json:"uploadedSha256"`
	Content         []byte             `json:"content"`
	SessionID       string             `json:"sessionId,omitempty"`
	Resolved        bool               `json:"resolved"`
	Resolution      ConflictResolution `json:"resolution,omitempty"`
	CreatedAtMs     int64              `json:"createdAtMs"`
	ResolvedAtMs    int64              `json:"resolvedAtMs,omitempty"`
}

// SessionSummary captures a finished session's distilled outcome fed into the offline Dreaming Pipeline.
type SessionSummary struct {
	SessionID     string   `json:"sessionId"`
	IssueID       string   `json:"issueId,omitempty"`
	Repo          string   `json:"repo,omitempty"`
	Title         string   `json:"title,omitempty"`
	Summary       string   `json:"summary"`
	Facts         []string `json:"facts,omitempty"`
	CompletedAtMs int64    `json:"completedAtMs"`
}

func normalizeScopeID(scopeID string) string {
	trimmed := strings.TrimSpace(scopeID)
	if trimmed == "" {
		return DefaultScopeID
	}
	return trimmed
}

func normalizeMemoryRelPath(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || strings.ContainsRune(trimmed, 0) {
		return "", ErrInvalidArgument
	}
	slash := strings.ReplaceAll(trimmed, "\\", "/")
	if strings.HasPrefix(slash, "/") {
		return "", ErrInvalidArgument
	}
	for seg := range strings.SplitSeq(slash, "/") {
		if seg == ".." {
			return "", ErrInvalidArgument
		}
	}
	cleaned := strings.TrimPrefix(path.Clean(slash), "./")
	cleaned = strings.TrimPrefix(cleaned, memoryMountPrefix+"/")
	if cleaned == "" || cleaned == "." || cleaned == ".." || cleaned == memoryMountPrefix || strings.HasPrefix(cleaned, "../") {
		return "", ErrInvalidArgument
	}
	return cleaned, nil
}

func conflictMountRelPath(relPath string, serverVersion int64, uploadedSHA string) string {
	dir := path.Dir(relPath)
	base := path.Base(relPath)
	ext := path.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	shortHash := uploadedSHA
	if len(shortHash) > 8 {
		shortHash = shortHash[:8]
	}
	if shortHash == "" {
		shortHash = "local"
	}
	name := stem + ".conflict-v" + itoa64(serverVersion) + "-" + shortHash + ext
	if dir == "." {
		return memoryMountPrefix + "/" + name
	}
	return memoryMountPrefix + "/" + dir + "/" + name
}

func itoa64(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [24]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func cloneBytes(b []byte) []byte {
	if b == nil {
		return nil
	}
	out := make([]byte, len(b))
	copy(out, b)
	return out
}

func cloneMemoryFile(f MemoryFile) MemoryFile {
	f.Content = cloneBytes(f.Content)
	return f
}

func cloneSnapshot(s Snapshot) Snapshot {
	if len(s.Files) > 0 {
		files := make([]MemoryFile, len(s.Files))
		for i, f := range s.Files {
			files[i] = cloneMemoryFile(f)
		}
		s.Files = files
	}
	return s
}

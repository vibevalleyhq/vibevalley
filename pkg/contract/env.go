package contract

import "context"

const (
	DefaultMaxImageWidth  = 2000
	DefaultMaxImageHeight = 2000
	DefaultMaxImageBytes  = 4_718_592 // 4.5 MiB
)

// ImageBounds constrains image normalization dimensions and encoded byte size.
type ImageBounds struct {
	MaxWidth  int   `json:"maxWidth"`
	MaxHeight int   `json:"maxHeight"`
	MaxBytes  int64 `json:"maxBytes"`
}

// ExecSpec defines a shell-free process invocation inside an ExecutionEnv.
type ExecSpec struct {
	Argv      []string `json:"argv"`
	Dir       string   `json:"dir,omitempty"`
	Env       []string `json:"env,omitempty"`
	Stdin     []byte   `json:"stdin,omitempty"`
	TimeoutMs int64    `json:"timeoutMs,omitempty"`
}

// ExecResult reports process termination and captured output streams.
type ExecResult struct {
	ExitCode    int    `json:"exitCode"`
	Stdout      string `json:"stdout"`
	Stderr      string `json:"stderr"`
	Interrupted bool   `json:"interrupted"`
	DurationMs  int64  `json:"durationMs"`
}

// MountFile carries a workspace skill or memory document with version metadata for reconciliation.
type MountFile struct {
	RelPath     string `json:"relPath"`
	Version     int64  `json:"version"`
	BaseVersion int64  `json:"baseVersion,omitempty"`
	SHA256      string `json:"sha256"`
	Content     []byte `json:"content,omitempty"`
	ReadOnly    bool   `json:"readOnly,omitempty"`
}

// MountSyncRequest reconciles read-only skills and bidirectional memory files in `.vibe/`.
type MountSyncRequest struct {
	SessionID string      `json:"sessionId"`
	Skills    []MountFile `json:"skills,omitempty"`
	Memories  []MountFile `json:"memories,omitempty"`
	Flush     bool        `json:"flush,omitempty"`
}

// MountConflict preserves concurrent memory edits instead of silently overwriting newer versions.
type MountConflict struct {
	RelPath         string `json:"relPath"`
	BaseVersion     int64  `json:"baseVersion"`
	ServerVersion   int64  `json:"serverVersion"`
	ConflictRelPath string `json:"conflictRelPath"`
	UploadedSHA256  string `json:"uploadedSha256"`
}

// MountSyncResult summarizes materialized files, uploaded updates, and version conflicts.
type MountSyncResult struct {
	Materialized int             `json:"materialized"`
	Uploaded     []MountFile     `json:"uploaded,omitempty"`
	Conflicts    []MountConflict `json:"conflicts,omitempty"`
}

// HarvestedOutput holds a deliverable collected from `.vibe/outputs/` before container teardown.
type HarvestedOutput struct {
	RelPath  string `json:"relPath"`
	SHA256   string `json:"sha256"`
	Size     int64  `json:"size"`
	MimeType string `json:"mimeType,omitempty"`
	Data     []byte `json:"data,omitempty"`
}

// ExecutionEnv abstracts local or remote workspace storage, process execution, mount sync, and output harvesting.
type ExecutionEnv interface {
	WriteAtomic(ctx context.Context, relPath string, data []byte, perm uint32) error
	EditPatch(ctx context.Context, relPath string, oldText string, newText string) error
	ReadFile(ctx context.Context, relPath string) ([]byte, error)
	Exec(ctx context.Context, spec ExecSpec) (ExecResult, error)
	SyncMounts(ctx context.Context, req MountSyncRequest) (MountSyncResult, error)
	HarvestOutputs(ctx context.Context) ([]HarvestedOutput, error)
	Close() error
}

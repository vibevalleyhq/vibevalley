package machine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

const (
	DefaultMountSyncInterval = 15 * time.Second
	DefaultMountFlushTimeout = 30 * time.Second

	readOnlySkillPerm os.FileMode = 0o444
	harvestChunkSize              = 32 * 1024
)

var (
	ErrChecksumMismatch = errors.New("machine: mount file sha256 mismatch")
	ErrOutputTooLarge   = errors.New("machine: harvested output exceeds inline cap")
)

// MountPushAck reports server-side reconciliation after uploading memory changes.
type MountPushAck struct {
	AcceptedVersions map[string]int64         `json:"acceptedVersions,omitempty"`
	Conflicts        []contract.MountConflict `json:"conflicts,omitempty"`
	Latest           []contract.MountFile     `json:"latest,omitempty"`
}

// OutputMeta describes a streamed `.vibe/outputs/` deliverable without buffering its contents.
type OutputMeta struct {
	RelPath  string `json:"relPath"`
	SHA256   string `json:"sha256"`
	Size     int64  `json:"size"`
	MimeType string `json:"mimeType,omitempty"`
}

// MountRemote optionally persists uploaded memory versions and conflict notices to the control plane.
type MountRemote interface {
	PushMemories(ctx context.Context, sessionID string, files []contract.MountFile) (MountPushAck, error)
}

// OutputSink receives `.vibe/outputs/` deliverables via streaming io.Reader.
type OutputSink interface {
	UploadOutput(ctx context.Context, sessionID string, meta OutputMeta, r io.Reader) error
}

type memoryBaseline struct {
	Version int64  `json:"version"`
	SHA256  string `json:"sha256"`
	RelPath string `json:"relPath"`
}

type mountSyncState struct {
	Memories      map[string]memoryBaseline `json:"memories"`
	ConflictFiles map[string]bool           `json:"conflictFiles,omitempty"`
}

// SyncMounts reconciles `.vibe/skills/` (read-only) and `.vibe/memory/` (bidirectional with conflict preservation).
func (e *LocalEnv) SyncMounts(ctx context.Context, req contract.MountSyncRequest) (contract.MountSyncResult, error) {
	if err := ctx.Err(); err != nil {
		return contract.MountSyncResult{}, err
	}
	if e.closed.Load() {
		return contract.MountSyncResult{}, ErrEnvClosed
	}

	e.syncMu.Lock()
	defer e.syncMu.Unlock()

	if err := ctx.Err(); err != nil {
		return contract.MountSyncResult{}, err
	}
	if e.closed.Load() {
		return contract.MountSyncResult{}, ErrEnvClosed
	}

	var result contract.MountSyncResult

	if req.Skills != nil {
		mat, err := e.syncSkillsLocked(ctx, req.Skills)
		if err != nil {
			return contract.MountSyncResult{}, err
		}
		result.Materialized += mat
	}

	state, err := e.loadSyncStateLocked()
	if err != nil {
		return contract.MountSyncResult{}, err
	}

	memRes, err := e.syncMemoriesLocked(ctx, req, &state)
	if err != nil {
		return contract.MountSyncResult{}, err
	}
	result.Materialized += memRes.Materialized
	result.Uploaded = append(result.Uploaded, memRes.Uploaded...)
	result.Conflicts = append(result.Conflicts, memRes.Conflicts...)

	if err := e.saveSyncStateLocked(state); err != nil {
		return contract.MountSyncResult{}, err
	}

	if e.mountRemote != nil && len(result.Uploaded) > 0 {
		ack, err := e.mountRemote.PushMemories(ctx, req.SessionID, result.Uploaded)
		if err != nil {
			return result, err
		}
		if err := e.applyPushAckLocked(ctx, &state, result.Uploaded, ack, &result); err != nil {
			return result, err
		}
		if err := e.saveSyncStateLocked(state); err != nil {
			return result, err
		}
	}

	return result, nil
}

func (e *LocalEnv) syncSkillsLocked(ctx context.Context, skills []contract.MountFile) (int, error) {
	if err := e.root.MkdirAll(skillsMountPrefix, defaultDirPerm); err != nil {
		return 0, fmt.Errorf("create skills mount dir: %w", err)
	}

	desired := make(map[string]contract.MountFile, len(skills))
	order := make([]string, 0, len(skills))
	for _, sk := range skills {
		subRel, err := normalizeMountSubPath(sk.RelPath, skillsMountPrefix)
		if err != nil {
			return 0, err
		}
		if sk.Content != nil && sk.SHA256 != "" && sha256Hex(sk.Content) != strings.ToLower(sk.SHA256) {
			return 0, fmt.Errorf("%w: skill %s", ErrChecksumMismatch, sk.RelPath)
		}
		if _, dup := desired[subRel]; !dup {
			order = append(order, subRel)
		}
		desired[subRel] = sk
	}

	// Prune stale skill files removed from the bound agent profile.
	existing, err := e.listSubtreeFilesLocked(skillsMountPrefix)
	if err != nil {
		return 0, err
	}
	for _, subRel := range existing {
		if _, keep := desired[subRel]; !keep {
			workRel := filepath.Join(skillsMountPrefix, subRel)
			_, canonical, err := e.resolveRelPath(workRel, false)
			if err != nil {
				return 0, err
			}
			unlock := e.locks.Lock(e.envID, canonical)
			rmErr := e.root.Remove(workRel)
			unlock()
			if rmErr != nil && !errors.Is(rmErr, os.ErrNotExist) {
				return 0, rmErr
			}
		}
	}

	materialized := 0
	for _, subRel := range order {
		if err := ctx.Err(); err != nil {
			return materialized, err
		}
		sk := desired[subRel]
		workRel := filepath.Join(skillsMountPrefix, subRel)
		_, canonical, err := e.resolveRelPath(workRel, false)
		if err != nil {
			return materialized, err
		}

		wantSHA := strings.ToLower(sk.SHA256)
		if wantSHA == "" {
			wantSHA = sha256Hex(sk.Content)
		}

		unlock := e.locks.Lock(e.envID, canonical)
		info, statErr := e.root.Stat(workRel)
		needWrite := statErr != nil || info.Mode().Perm() != readOnlySkillPerm
		if !needWrite {
			curData, readErr := e.root.ReadFile(workRel)
			if readErr != nil || sha256Hex(curData) != wantSHA {
				needWrite = true
			}
		}
		var writeErr error
		if needWrite {
			writeErr = e.writeFileAtomicUnlocked(workRel, sk.Content, uint32(readOnlySkillPerm))
			if writeErr == nil {
				materialized++
			}
		}
		unlock()
		if writeErr != nil {
			return materialized, writeErr
		}
	}

	return materialized, nil
}

func (e *LocalEnv) syncMemoriesLocked(ctx context.Context, req contract.MountSyncRequest, state *mountSyncState) (contract.MountSyncResult, error) {
	if err := e.root.MkdirAll(memoryMountPrefix, defaultDirPerm); err != nil {
		return contract.MountSyncResult{}, fmt.Errorf("create memory mount dir: %w", err)
	}
	if state.Memories == nil {
		state.Memories = make(map[string]memoryBaseline)
	}
	if state.ConflictFiles == nil {
		state.ConflictFiles = make(map[string]bool)
	}

	var res contract.MountSyncResult
	seen := make(map[string]bool, len(req.Memories))

	for _, sm := range req.Memories {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		subRel, err := normalizeMountSubPath(sm.RelPath, memoryMountPrefix)
		if err != nil {
			return res, err
		}
		seen[subRel] = true

		serverSHA := strings.ToLower(sm.SHA256)
		if sm.Content != nil {
			computed := sha256Hex(sm.Content)
			if serverSHA != "" && serverSHA != computed {
				return res, fmt.Errorf("%w: memory %s", ErrChecksumMismatch, sm.RelPath)
			}
			serverSHA = computed
		}

		workRel := filepath.Join(memoryMountPrefix, subRel)
		_, canonical, err := e.resolveRelPath(workRel, false)
		if err != nil {
			return res, err
		}

		perm := uint32(defaultFilePerm)
		if sm.ReadOnly {
			perm = uint32(readOnlySkillPerm)
		}

		unlock := e.locks.Lock(e.envID, canonical)
		localBytes, readErr := e.root.ReadFile(workRel)

		switch {
		case errors.Is(readErr, os.ErrNotExist):
			if sm.Content != nil {
				if err := e.writeFileAtomicUnlocked(workRel, sm.Content, perm); err != nil {
					unlock()
					return res, err
				}
				state.Memories[subRel] = memoryBaseline{
					Version: sm.Version,
					SHA256:  serverSHA,
					RelPath: sm.RelPath,
				}
				res.Materialized++
			}
			unlock()

		case readErr != nil:
			unlock()
			return res, readErr

		default:
			localSHA := sha256Hex(localBytes)
			base, hasBase := state.Memories[subRel]

			switch {
			case serverSHA != "" && localSHA == serverSHA:
				state.Memories[subRel] = memoryBaseline{
					Version: sm.Version,
					SHA256:  serverSHA,
					RelPath: sm.RelPath,
				}
				unlock()

			case !hasBase:
				conflictSub, conflictWorkRel := conflictPathFor(subRel, sm.Version, localSHA)
				if err := e.writeConflictAndReplaceLocked(conflictWorkRel, localBytes, workRel, sm.Content, perm); err != nil {
					unlock()
					return res, err
				}
				state.ConflictFiles[filepath.ToSlash(conflictSub)] = true
				state.Memories[subRel] = memoryBaseline{
					Version: sm.Version,
					SHA256:  serverSHA,
					RelPath: sm.RelPath,
				}
				res.Materialized++
				res.Conflicts = append(res.Conflicts, contract.MountConflict{
					RelPath:         sm.RelPath,
					BaseVersion:     0,
					ServerVersion:   sm.Version,
					ConflictRelPath: filepath.ToSlash(conflictWorkRel),
					UploadedSHA256:  localSHA,
				})
				unlock()

			case localSHA == base.SHA256:
				// Local file is clean; fast-forward to newer server content.
				if sm.Content != nil && (sm.Version != base.Version || serverSHA != base.SHA256) {
					if err := e.writeFileAtomicUnlocked(workRel, sm.Content, perm); err != nil {
						unlock()
						return res, err
					}
					state.Memories[subRel] = memoryBaseline{
						Version: sm.Version,
						SHA256:  serverSHA,
						RelPath: sm.RelPath,
					}
					res.Materialized++
				}
				unlock()

			case sm.Version == base.Version && (serverSHA == "" || serverSHA == base.SHA256):
				// Only local copy changed; queue upload without bumping baseline until server acks.
				res.Uploaded = append(res.Uploaded, contract.MountFile{
					RelPath:     sm.RelPath,
					BaseVersion: base.Version,
					Version:     base.Version + 1,
					SHA256:      localSHA,
					Content:     localBytes,
				})
				unlock()

			default:
				// Both server and local diverged since base.Version: preserve local edit as conflict branch.
				conflictSub, conflictWorkRel := conflictPathFor(subRel, sm.Version, localSHA)
				if err := e.writeConflictAndReplaceLocked(conflictWorkRel, localBytes, workRel, sm.Content, perm); err != nil {
					unlock()
					return res, err
				}
				state.ConflictFiles[filepath.ToSlash(conflictSub)] = true
				if sm.Content != nil {
					state.Memories[subRel] = memoryBaseline{
						Version: sm.Version,
						SHA256:  serverSHA,
						RelPath: sm.RelPath,
					}
					res.Materialized++
				}
				res.Conflicts = append(res.Conflicts, contract.MountConflict{
					RelPath:         sm.RelPath,
					BaseVersion:     base.Version,
					ServerVersion:   sm.Version,
					ConflictRelPath: filepath.ToSlash(conflictWorkRel),
					UploadedSHA256:  localSHA,
				})
				unlock()
			}
		}
	}

	// Scan for newly created or locally edited memory files not included in req.Memories.
	localFiles, err := e.listSubtreeFilesLocked(memoryMountPrefix)
	if err != nil {
		return res, err
	}
	for _, subRel := range localFiles {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		slashSub := filepath.ToSlash(subRel)
		if seen[subRel] || state.ConflictFiles[slashSub] || isConflictFilename(slashSub) {
			continue
		}
		workRel := filepath.Join(memoryMountPrefix, subRel)
		_, canonical, err := e.resolveRelPath(workRel, false)
		if err != nil {
			return res, err
		}

		unlock := e.locks.RLock(e.envID, canonical)
		localBytes, readErr := e.root.ReadFile(workRel)
		unlock()
		if readErr != nil {
			return res, readErr
		}

		localSHA := sha256Hex(localBytes)
		base, hasBase := state.Memories[subRel]
		if !hasBase {
			res.Uploaded = append(res.Uploaded, contract.MountFile{
				RelPath:     slashSub,
				BaseVersion: 0,
				Version:     1,
				SHA256:      localSHA,
				Content:     localBytes,
			})
			continue
		}
		if localSHA != base.SHA256 {
			relName := base.RelPath
			if relName == "" {
				relName = slashSub
			}
			res.Uploaded = append(res.Uploaded, contract.MountFile{
				RelPath:     relName,
				BaseVersion: base.Version,
				Version:     base.Version + 1,
				SHA256:      localSHA,
				Content:     localBytes,
			})
		}
	}

	return res, nil
}

func (e *LocalEnv) writeConflictAndReplaceLocked(conflictWorkRel string, localBytes []byte, targetWorkRel string, serverContent []byte, perm uint32) error {
	if err := e.writeFileAtomicUnlocked(conflictWorkRel, localBytes, uint32(defaultFilePerm)); err != nil {
		return err
	}
	if serverContent != nil {
		if err := e.writeFileAtomicUnlocked(targetWorkRel, serverContent, perm); err != nil {
			return err
		}
	}
	return nil
}

func (e *LocalEnv) applyPushAckLocked(ctx context.Context, state *mountSyncState, uploaded []contract.MountFile, ack MountPushAck, res *contract.MountSyncResult) error {
	uploadedBySub := make(map[string]contract.MountFile, len(uploaded))
	for _, u := range uploaded {
		subRel, err := normalizeMountSubPath(u.RelPath, memoryMountPrefix)
		if err != nil {
			continue
		}
		uploadedBySub[subRel] = u
	}

	for rel, ver := range ack.AcceptedVersions {
		subRel, err := normalizeMountSubPath(rel, memoryMountPrefix)
		if err != nil {
			continue
		}
		if u, ok := uploadedBySub[subRel]; ok {
			state.Memories[subRel] = memoryBaseline{
				Version: ver,
				SHA256:  u.SHA256,
				RelPath: u.RelPath,
			}
		}
	}

	latestBySub := make(map[string]contract.MountFile, len(ack.Latest))
	for _, l := range ack.Latest {
		subRel, err := normalizeMountSubPath(l.RelPath, memoryMountPrefix)
		if err != nil {
			continue
		}
		latestBySub[subRel] = l
	}

	for _, c := range ack.Conflicts {
		if err := ctx.Err(); err != nil {
			return err
		}
		subRel, err := normalizeMountSubPath(c.RelPath, memoryMountPrefix)
		if err != nil {
			continue
		}
		u, hasUploaded := uploadedBySub[subRel]
		var conflictBytes []byte
		localSHA := c.UploadedSHA256
		if hasUploaded {
			conflictBytes = u.Content
			if localSHA == "" {
				localSHA = u.SHA256
			}
		}

		conflictSub, conflictWorkRel := conflictPathFor(subRel, c.ServerVersion, localSHA)
		if c.ConflictRelPath != "" {
			if sub, err := normalizeMountSubPath(c.ConflictRelPath, memoryMountPrefix); err == nil {
				conflictSub = sub
				conflictWorkRel = filepath.Join(memoryMountPrefix, sub)
			}
		} else {
			c.ConflictRelPath = filepath.ToSlash(conflictWorkRel)
		}

		workRel := filepath.Join(memoryMountPrefix, subRel)
		_, canonical, err := e.resolveRelPath(workRel, false)
		if err != nil {
			return err
		}

		var serverBytes []byte
		var serverSHA string
		if latest, ok := latestBySub[subRel]; ok && latest.Content != nil {
			serverBytes = latest.Content
			serverSHA = sha256Hex(latest.Content)
		}

		unlock := e.locks.Lock(e.envID, canonical)
		if conflictBytes == nil {
			conflictBytes, _ = e.root.ReadFile(workRel)
		}
		err = e.writeConflictAndReplaceLocked(conflictWorkRel, conflictBytes, workRel, serverBytes, uint32(defaultFilePerm))
		unlock()
		if err != nil {
			return err
		}

		state.ConflictFiles[filepath.ToSlash(conflictSub)] = true
		if serverBytes != nil {
			state.Memories[subRel] = memoryBaseline{
				Version: c.ServerVersion,
				SHA256:  serverSHA,
				RelPath: c.RelPath,
			}
			res.Materialized++
		}
		res.Conflicts = append(res.Conflicts, c)
	}

	return nil
}

func (e *LocalEnv) loadSyncStateLocked() (mountSyncState, error) {
	raw, err := e.root.ReadFile(syncStateRelPath)
	if errors.Is(err, os.ErrNotExist) {
		return mountSyncState{
			Memories:      make(map[string]memoryBaseline),
			ConflictFiles: make(map[string]bool),
		}, nil
	}
	if err != nil {
		return mountSyncState{}, fmt.Errorf("read sync state: %w", err)
	}
	var state mountSyncState
	if err := json.Unmarshal(raw, &state); err != nil {
		return mountSyncState{}, fmt.Errorf("decode sync state: %w", err)
	}
	if state.Memories == nil {
		state.Memories = make(map[string]memoryBaseline)
	}
	if state.ConflictFiles == nil {
		state.ConflictFiles = make(map[string]bool)
	}
	return state, nil
}

func (e *LocalEnv) saveSyncStateLocked(state mountSyncState) error {
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return e.writeFileAtomicUnlocked(syncStateRelPath, raw, uint32(defaultFilePerm))
}

func (e *LocalEnv) listSubtreeFilesLocked(mountPrefix string) ([]string, error) {
	rootFS := e.root.FS()
	if _, err := fs.Stat(rootFS, mountPrefix); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}

	var files []string
	err := fs.WalkDir(rootFS, mountPrefix, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		base := filepath.Base(p)
		if strings.HasPrefix(base, ".vibe-tmp-") {
			return nil
		}
		rel := strings.TrimPrefix(filepath.ToSlash(p), mountPrefix+"/")
		if rel != "" && rel != p {
			files = append(files, filepath.FromSlash(rel))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	slices.Sort(files)
	return files, nil
}

// HarvestOutputs walks `.vibe/outputs/`, streaming each file through SHA-256 and capturing its MIME type.
func (e *LocalEnv) HarvestOutputs(ctx context.Context) ([]contract.HarvestedOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if e.closed.Load() {
		return nil, ErrEnvClosed
	}

	relFiles, err := e.listSubtreeFilesLocked(outputsMountPrefix)
	if err != nil {
		return nil, err
	}
	if len(relFiles) == 0 {
		return nil, nil
	}

	outputs := make([]contract.HarvestedOutput, 0, len(relFiles))
	buf := make([]byte, harvestChunkSize)

	for _, subRel := range relFiles {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		workRel := filepath.Join(outputsMountPrefix, subRel)
		_, canonical, err := e.resolveRelPath(workRel, false)
		if err != nil {
			return nil, err
		}

		unlock := e.locks.RLock(e.envID, canonical)
		item, err := e.readOutputFileLocked(workRel, subRel, buf)
		unlock()
		if err != nil {
			return nil, err
		}
		outputs = append(outputs, item)
	}
	return outputs, nil
}

func (e *LocalEnv) readOutputFileLocked(workRel, subRel string, chunkBuf []byte) (contract.HarvestedOutput, error) {
	f, err := e.root.Open(workRel)
	if err != nil {
		return contract.HarvestedOutput{}, err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return contract.HarvestedOutput{}, err
	}
	if info.Size() > e.maxHarvestBytes {
		return contract.HarvestedOutput{}, fmt.Errorf("%w: %s (%d bytes)", ErrOutputTooLarge, subRel, info.Size())
	}

	hasher := sha256.New()
	var dataBuf bytes.Buffer
	if info.Size() > 0 && info.Size() <= e.maxHarvestBytes {
		dataBuf.Grow(int(info.Size()))
	}

	var head [512]byte
	var headLen int
	var total int64

	for {
		n, readErr := f.Read(chunkBuf)
		if n > 0 {
			if total+int64(n) > e.maxHarvestBytes {
				return contract.HarvestedOutput{}, fmt.Errorf("%w: %s", ErrOutputTooLarge, subRel)
			}
			if headLen < len(head) {
				copied := copy(head[headLen:], chunkBuf[:n])
				headLen += copied
			}
			_, _ = hasher.Write(chunkBuf[:n])
			_, _ = dataBuf.Write(chunkBuf[:n])
			total += int64(n)
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return contract.HarvestedOutput{}, readErr
		}
	}

	slashSub := filepath.ToSlash(subRel)
	return contract.HarvestedOutput{
		RelPath:  slashSub,
		SHA256:   hex.EncodeToString(hasher.Sum(nil)),
		Size:     total,
		MimeType: detectOutputMimeType(slashSub, head[:headLen]),
		Data:     dataBuf.Bytes(),
	}, nil
}

// HarvestStream streams `.vibe/outputs/` files through SHA-256 directly to sink with bounded O(32KB) memory.
func (e *LocalEnv) HarvestStream(ctx context.Context, sessionID string, sink OutputSink) ([]OutputMeta, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if e.closed.Load() {
		return nil, ErrEnvClosed
	}
	if sink == nil {
		return nil, errors.New("machine: nil output sink")
	}

	relFiles, err := e.listSubtreeFilesLocked(outputsMountPrefix)
	if err != nil {
		return nil, err
	}
	if len(relFiles) == 0 {
		return nil, nil
	}

	metas := make([]OutputMeta, 0, len(relFiles))
	for _, subRel := range relFiles {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		workRel := filepath.Join(outputsMountPrefix, subRel)
		_, canonical, err := e.resolveRelPath(workRel, false)
		if err != nil {
			return nil, err
		}

		unlock := e.locks.RLock(e.envID, canonical)
		meta, err := e.streamOneOutputLocked(ctx, sessionID, workRel, subRel, sink)
		unlock()
		if err != nil {
			return nil, err
		}
		metas = append(metas, meta)
	}
	return metas, nil
}

func (e *LocalEnv) streamOneOutputLocked(ctx context.Context, sessionID, workRel, subRel string, sink OutputSink) (OutputMeta, error) {
	f, err := e.root.Open(workRel)
	if err != nil {
		return OutputMeta{}, err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return OutputMeta{}, err
	}

	hasher := sha256.New()
	var head [512]byte
	headLen, err := io.ReadFull(f, head[:])
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return OutputMeta{}, err
	}
	_, _ = hasher.Write(head[:headLen])

	buf := make([]byte, harvestChunkSize)
	for {
		n, readErr := f.Read(buf)
		if n > 0 {
			_, _ = hasher.Write(buf[:n])
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return OutputMeta{}, readErr
		}
	}

	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return OutputMeta{}, err
	}

	slashSub := filepath.ToSlash(subRel)
	meta := OutputMeta{
		RelPath:  slashSub,
		SHA256:   hex.EncodeToString(hasher.Sum(nil)),
		Size:     info.Size(),
		MimeType: detectOutputMimeType(slashSub, head[:headLen]),
	}
	if err := sink.UploadOutput(ctx, sessionID, meta, f); err != nil {
		return OutputMeta{}, err
	}
	return meta, nil
}

// MountSyncerConfig configures the 15s throttled + 30s turn-end flush scheduler around ExecutionEnv.SyncMounts.
type MountSyncerConfig struct {
	ThrottleInterval time.Duration
	FlushTimeout     time.Duration
	Now              func() time.Time
}

// MountSyncer coordinates throttled per-turn syncs and bounded turn-end flushes.
type MountSyncer struct {
	env              contract.ExecutionEnv
	throttleInterval time.Duration
	flushTimeout     time.Duration
	now              func() time.Time

	mu         sync.Mutex
	hasSynced  bool
	lastSyncAt time.Time
}

// NewMountSyncer wraps env with 15s default throttling and 30s default flush timeout.
func NewMountSyncer(env contract.ExecutionEnv, cfg MountSyncerConfig) *MountSyncer {
	interval := cfg.ThrottleInterval
	if interval <= 0 {
		interval = DefaultMountSyncInterval
	}
	flushTimeout := cfg.FlushTimeout
	if flushTimeout <= 0 {
		flushTimeout = DefaultMountFlushTimeout
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	return &MountSyncer{
		env:              env,
		throttleInterval: interval,
		flushTimeout:     flushTimeout,
		now:              now,
	}
}

// SyncOnTurn reconciles mounts at most once per ThrottleInterval unless req.Flush is set.
func (s *MountSyncer) SyncOnTurn(ctx context.Context, req contract.MountSyncRequest) (res contract.MountSyncResult, throttled bool, err error) {
	if req.Flush {
		res, err = s.Flush(ctx, req)
		return res, false, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	if s.hasSynced && now.Sub(s.lastSyncAt) < s.throttleInterval {
		return contract.MountSyncResult{}, true, nil
	}
	res, err = s.env.SyncMounts(ctx, req)
	if err == nil {
		s.hasSynced = true
		s.lastSyncAt = s.now()
	}
	return res, false, err
}

// Flush bypasses throttling and performs a final bidirectional sync bounded by FlushTimeout (default 30s).
func (s *MountSyncer) Flush(ctx context.Context, req contract.MountSyncRequest) (contract.MountSyncResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	req.Flush = true
	flushCtx, cancel := context.WithTimeout(ctx, s.flushTimeout)
	defer cancel()

	res, err := s.env.SyncMounts(flushCtx, req)
	if err == nil {
		s.hasSynced = true
		s.lastSyncAt = s.now()
	}
	return res, err
}

func normalizeMountSubPath(raw, prefix string) (string, error) {
	if raw == "" || strings.ContainsRune(raw, 0) {
		return "", fmt.Errorf("%w: empty mount path", ErrInvalidPath)
	}
	if filepath.IsAbs(raw) || strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "\\") {
		return "", fmt.Errorf("%w: %q", ErrPathTraversal, raw)
	}
	slash := filepath.ToSlash(raw)
	for seg := range strings.SplitSeq(slash, "/") {
		if seg == ".." {
			return "", fmt.Errorf("%w: %q", ErrPathTraversal, raw)
		}
	}
	cleanSlash := strings.TrimPrefix(filepath.ToSlash(filepath.Clean(raw)), "./")
	cleanSlash = strings.TrimPrefix(cleanSlash, prefix+"/")
	if cleanSlash == "" || cleanSlash == "." || cleanSlash == ".." || cleanSlash == prefix || strings.HasPrefix(cleanSlash, "../") {
		return "", fmt.Errorf("%w: invalid mount relative path %q", ErrInvalidPath, raw)
	}
	return filepath.FromSlash(cleanSlash), nil
}

func conflictPathFor(subRel string, serverVersion int64, localSHA string) (conflictSub string, conflictWorkRel string) {
	dir := filepath.Dir(subRel)
	base := filepath.Base(subRel)
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	shortHash := localSHA
	if len(shortHash) > 8 {
		shortHash = shortHash[:8]
	}
	if shortHash == "" {
		shortHash = "local"
	}
	conflictName := fmt.Sprintf("%s.conflict-v%d-%s%s", stem, serverVersion, shortHash, ext)
	if dir == "." {
		conflictSub = conflictName
	} else {
		conflictSub = filepath.Join(dir, conflictName)
	}
	return conflictSub, filepath.Join(memoryMountPrefix, conflictSub)
}

func isConflictFilename(slashSub string) bool {
	return strings.Contains(filepath.Base(slashSub), ".conflict-v")
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func detectOutputMimeType(slashRel string, head []byte) string {
	if ext := filepath.Ext(slashRel); ext != "" {
		if t := mime.TypeByExtension(ext); t != "" {
			return t
		}
	}
	if len(head) > 0 {
		return http.DetectContentType(head)
	}
	return "application/octet-stream"
}

package artifact

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
)

// BlobRef summarizes a stored content-addressed blob and whether its bytes were deduplicated.
type BlobRef struct {
	SHA256       string `json:"sha256"`
	Size         int64  `json:"size"`
	Deduplicated bool   `json:"deduplicated"`
}

// CASStats tracks unique stored blobs vs logical writes for deduplication verification.
type CASStats struct {
	UniqueBlobs   int   `json:"uniqueBlobs"`
	UniqueBytes   int64 `json:"uniqueBytes"`
	TotalPuts     int64 `json:"totalPuts"`
	Deduplicated  int64 `json:"deduplicated"`
	LogicalBytes  int64 `json:"logicalBytes"`
	DiskPersisted bool  `json:"diskPersisted"`
}

// ContentStore is a thread-safe SHA-256 content-addressed blob store backed by memory and optionally disk.
type ContentStore struct {
	dir string

	mu           sync.RWMutex
	blobs        map[string][]byte // populated only when dir == "" (in-memory mode)
	diskSizes    map[string]int64  // populated when dir != "" (disk-backed mode)
	totalPuts    int64
	deduplicated int64
	logicalBytes int64
}

// NewMemoryCAS creates a pure in-memory SHA-256 content-addressed store.
func NewMemoryCAS() *ContentStore {
	return &ContentStore{
		blobs: make(map[string][]byte),
	}
}

// NewDirCAS creates a disk-backed SHA-256 content-addressed store rooted at dir.
// Existing blobs under <dir>/blobs are verified by SHA-256 during startup.
func NewDirCAS(dir string) (*ContentStore, error) {
	clean := strings.TrimSpace(dir)
	if clean == "" {
		return NewMemoryCAS(), nil
	}
	blobsDir := filepath.Join(clean, "blobs")
	if err := os.MkdirAll(blobsDir, 0o755); err != nil {
		return nil, fmt.Errorf("artifact cas mkdir: %w", err)
	}
	cs := &ContentStore{
		dir:       blobsDir,
		diskSizes: make(map[string]int64),
	}
	entries, err := os.ReadDir(blobsDir)
	if err != nil {
		return nil, fmt.Errorf("artifact cas readdir: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || strings.HasPrefix(entry.Name(), ".tmp-") {
			continue
		}
		key, err := NormalizeSHA256(entry.Name())
		if err != nil {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(blobsDir, key))
		if err != nil {
			continue
		}
		if SumSHA256(raw) != key {
			return nil, fmt.Errorf("%w: existing blob %s", ErrCorruptedBlob, key)
		}
		cs.diskSizes[key] = int64(len(raw))
	}
	return cs, nil
}

// SumSHA256 returns the lowercase 64-character hex SHA-256 digest of data.
func SumSHA256(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// NormalizeSHA256 validates and lowercases a 64-character hex SHA-256 digest.
func NormalizeSHA256(digest string) (string, error) {
	s := strings.ToLower(strings.TrimSpace(digest))
	if len(s) != 64 {
		return "", fmt.Errorf("%w: length %d", ErrInvalidSHA256, len(s))
	}
	for i := range len(s) {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return "", fmt.Errorf("%w: non-hex character at %d", ErrInvalidSHA256, i)
		}
	}
	return s, nil
}

// Put stores data under its SHA-256 digest, deduplicating identical payloads atomically.
func (s *ContentStore) Put(data []byte) (BlobRef, error) {
	key := SumSHA256(data)

	s.mu.Lock()
	defer s.mu.Unlock()

	s.totalPuts++
	s.logicalBytes += int64(len(data))

	if s.dir == "" {
		if existing, ok := s.blobs[key]; ok {
			if len(existing) == len(data) && SumSHA256(existing) == key {
				s.deduplicated++
				return BlobRef{
					SHA256:       key,
					Size:         int64(len(data)),
					Deduplicated: true,
				}, nil
			}
		}
		s.blobs[key] = slices.Clone(data)
		return BlobRef{
			SHA256:       key,
			Size:         int64(len(data)),
			Deduplicated: false,
		}, nil
	}

	target := filepath.Join(s.dir, key)
	if info, statErr := os.Stat(target); statErr == nil && !info.IsDir() {
		diskBytes, readErr := os.ReadFile(target)
		if readErr == nil && SumSHA256(diskBytes) == key {
			s.diskSizes[key] = int64(len(diskBytes))
			s.deduplicated++
			return BlobRef{
				SHA256:       key,
				Size:         int64(len(diskBytes)),
				Deduplicated: true,
			}, nil
		}
	}
	if err := writeFileAtomic(target, data, 0o644); err != nil {
		return BlobRef{}, err
	}
	s.diskSizes[key] = int64(len(data))
	return BlobRef{
		SHA256:       key,
		Size:         int64(len(data)),
		Deduplicated: false,
	}, nil
}

// Get retrieves a defensive copy of the blob bytes for digest after verifying integrity.
func (s *ContentStore) Get(digest string) ([]byte, error) {
	key, err := NormalizeSHA256(digest)
	if err != nil {
		return nil, err
	}

	s.mu.RLock()
	dir := s.dir
	if dir == "" {
		data, ok := s.blobs[key]
		if !ok {
			s.mu.RUnlock()
			return nil, fmt.Errorf("%w: %s", ErrBlobNotFound, key)
		}
		cp := slices.Clone(data)
		s.mu.RUnlock()
		if SumSHA256(cp) != key {
			return nil, fmt.Errorf("%w: %s", ErrCorruptedBlob, key)
		}
		return cp, nil
	}
	s.mu.RUnlock()

	raw, err := os.ReadFile(filepath.Join(dir, key))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("%w: %s", ErrBlobNotFound, key)
		}
		return nil, err
	}
	if SumSHA256(raw) != key {
		return nil, fmt.Errorf("%w: %s", ErrCorruptedBlob, key)
	}
	return raw, nil
}

// Has reports whether digest is present in the store.
func (s *ContentStore) Has(digest string) bool {
	key, err := NormalizeSHA256(digest)
	if err != nil {
		return false
	}
	s.mu.RLock()
	dir := s.dir
	if dir == "" {
		_, ok := s.blobs[key]
		s.mu.RUnlock()
		return ok
	}
	s.mu.RUnlock()
	_, err = os.Stat(filepath.Join(dir, key))
	return err == nil
}

// Stats returns deduplication and storage statistics.
func (s *ContentStore) Stats() CASStats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var uniqueBytes int64
	uniqueBlobs := 0
	if s.dir == "" {
		uniqueBlobs = len(s.blobs)
		for _, b := range s.blobs {
			uniqueBytes += int64(len(b))
		}
	} else {
		uniqueBlobs = len(s.diskSizes)
		for _, sz := range s.diskSizes {
			uniqueBytes += sz
		}
	}
	return CASStats{
		UniqueBlobs:   uniqueBlobs,
		UniqueBytes:   uniqueBytes,
		TotalPuts:     s.totalPuts,
		Deduplicated:  s.deduplicated,
		LogicalBytes:  s.logicalBytes,
		DiskPersisted: s.dir != "",
	}
}

func writeFileAtomic(target string, data []byte, perm os.FileMode) error {
	parent := filepath.Dir(target)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", parent, err)
	}
	tmp, err := os.CreateTemp(parent, ".tmp-*")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = tmp.Close()
			_ = os.Remove(tmpPath)
		}
	}()

	for len(data) > 0 {
		n, err := tmp.Write(data)
		if err != nil {
			return fmt.Errorf("write temp file: %w", err)
		}
		data = data[n:]
	}
	if err := tmp.Chmod(perm); err != nil {
		return fmt.Errorf("chmod temp file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("sync temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp file: %w", err)
	}
	if err := os.Rename(tmpPath, target); err != nil {
		return fmt.Errorf("rename %s -> %s: %w", tmpPath, target, err)
	}
	cleanup = false
	return nil
}

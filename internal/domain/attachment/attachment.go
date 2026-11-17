package attachment

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

const (
	// DefaultMaxBytes bounds single uploaded attachments (25 MiB).
	DefaultMaxBytes int64 = 25 * 1024 * 1024
	// PathPrefix is the HTTP route prefix for GET attachment reads.
	PathPrefix = "/api/v1/attachment/"
	// ImmutableCacheControl caches immutable SHA-256 blobs privately for one year.
	ImmutableCacheControl = "private, max-age=31536000, immutable"
)

var (
	// ErrEmpty indicates an empty attachment upload.
	ErrEmpty = errors.New("attachment: empty payload")
	// ErrTooLarge indicates an upload exceeds MaxBytes.
	ErrTooLarge = errors.New("attachment: payload exceeds max size")
	// ErrInvalidInput indicates malformed base64 or metadata.
	ErrInvalidInput = errors.New("attachment: invalid input")
	// ErrInvalidSHA256 indicates an ID is not a strict 64-character lowercase hex SHA-256 digest.
	ErrInvalidSHA256 = errors.New("attachment: invalid sha256 id")
	// ErrNotFound indicates the requested attachment does not exist.
	ErrNotFound = errors.New("attachment: not found")
	// ErrCorrupted indicates on-disk bytes failed SHA-256 integrity verification.
	ErrCorrupted = errors.New("attachment: corrupted bytes")
)

// Config configures a content-addressed Attachment Store.
type Config struct {
	Dir      string
	MaxBytes int64
	Clock    store.Clock
}

// Attachment matches packages/protocol/src/attachment/shapes.ts Attachment.
type Attachment struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
	Size int64  `json:"size"`
}

// AttachmentUpload matches packages/protocol/src/attachment/shapes.ts AttachmentUpload.
type AttachmentUpload struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Data string `json:"data"`
}

type storedMeta struct {
	Attachment
	CreatedAtMs int64 `json:"createdAtMs"`
}

// Store persists content-addressed SHA-256 attachments on disk or in memory.
type Store struct {
	dir      string
	maxBytes int64
	clock    store.Clock

	mu    sync.RWMutex
	blobs map[string][]byte     // populated when dir == ""
	metas map[string]storedMeta // in-memory cache of metadata
}

// NewStore creates a content-addressed attachment store. When cfg.Dir == "", storage is in-memory.
func NewStore(cfg Config) (*Store, error) {
	maxBytes := cfg.MaxBytes
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBytes
	}
	clk := cfg.Clock
	if clk == nil {
		clk = store.RealClock{}
	}
	dir := strings.TrimSpace(cfg.Dir)
	st := &Store{
		dir:      dir,
		maxBytes: maxBytes,
		clock:    clk,
		metas:    make(map[string]storedMeta),
	}
	if dir == "" {
		st.blobs = make(map[string][]byte)
	} else {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("attachment mkdir %s: %w", dir, err)
		}
		if err := st.loadMetadata(); err != nil {
			return nil, err
		}
	}
	return st, nil
}

// CreateFromBase64 decodes base64 upload bytes, enforces MaxBytes, deduplicates by SHA-256, and stores metadata.
func (s *Store) CreateFromBase64(ctx context.Context, upload AttachmentUpload) (Attachment, error) {
	if err := ctx.Err(); err != nil {
		return Attachment{}, err
	}
	rawStr := strings.TrimSpace(upload.Data)
	if rawStr == "" {
		return Attachment{}, ErrEmpty
	}
	if idx := strings.Index(rawStr, ";base64,"); idx > 0 && strings.HasPrefix(rawStr, "data:") {
		rawStr = rawStr[idx+len(";base64,"):]
	}
	if int64(base64.StdEncoding.DecodedLen(len(rawStr))) > s.maxBytes+3 {
		return Attachment{}, fmt.Errorf("%w: exceeds %d bytes", ErrTooLarge, s.maxBytes)
	}
	decoded, err := base64.StdEncoding.DecodeString(rawStr)
	if err != nil {
		decoded, err = base64.RawStdEncoding.DecodeString(rawStr)
		if err != nil {
			return Attachment{}, fmt.Errorf("%w: invalid base64: %v", ErrInvalidInput, err)
		}
	}
	return s.PutBytes(ctx, upload.Name, upload.Type, decoded)
}

// PutBytes validates size and non-emptiness, hashes bytes with SHA-256, and persists blob + metadata once.
func (s *Store) PutBytes(ctx context.Context, name, declaredType string, data []byte) (Attachment, error) {
	if err := ctx.Err(); err != nil {
		return Attachment{}, err
	}
	if len(data) == 0 {
		return Attachment{}, ErrEmpty
	}
	if int64(len(data)) > s.maxBytes {
		return Attachment{}, fmt.Errorf("%w: %d > %d bytes", ErrTooLarge, len(data), s.maxBytes)
	}

	cleanName := sanitizeFilename(name)
	safeType := DetectContentType(cleanName, declaredType, data)
	digest := sumSHA256Hex(data)

	s.mu.Lock()
	defer s.mu.Unlock()

	if existing, ok := s.metas[digest]; ok {
		return existing.Attachment, nil
	}

	if s.dir == "" {
		s.blobs[digest] = slices.Clone(data)
	} else {
		blobPath := filepath.Join(s.dir, digest)
		if err := writeOnceAtomic(blobPath, data); err != nil {
			return Attachment{}, err
		}
		meta := storedMeta{
			Attachment: Attachment{
				ID:   digest,
				Name: cleanName,
				Type: safeType,
				Size: int64(len(data)),
			},
			CreatedAtMs: s.clock.NowMs(),
		}
		metaBytes, err := json.Marshal(meta)
		if err != nil {
			return Attachment{}, err
		}
		if err := writeAtomic0600(filepath.Join(s.dir, digest+".json"), metaBytes); err != nil {
			return Attachment{}, err
		}
		s.metas[digest] = meta
		return meta.Attachment, nil
	}

	meta := storedMeta{
		Attachment: Attachment{
			ID:   digest,
			Name: cleanName,
			Type: safeType,
			Size: int64(len(data)),
		},
		CreatedAtMs: s.clock.NowMs(),
	}
	s.metas[digest] = meta
	return meta.Attachment, nil
}

// Get looks up attachment metadata by strict lowercase 64-hex SHA-256 ID.
func (s *Store) Get(ctx context.Context, id string) (Attachment, error) {
	if err := ctx.Err(); err != nil {
		return Attachment{}, err
	}
	if err := ValidateSHA256(id); err != nil {
		return Attachment{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	meta, ok := s.metas[id]
	if !ok {
		return Attachment{}, fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	return meta.Attachment, nil
}

// Bytes reads and SHA-256 verifies raw attachment bytes by strict lowercase 64-hex SHA-256 ID.
func (s *Store) Bytes(ctx context.Context, id string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := ValidateSHA256(id); err != nil {
		return nil, err
	}
	s.mu.RLock()
	if s.dir == "" {
		raw, ok := s.blobs[id]
		s.mu.RUnlock()
		if !ok {
			return nil, fmt.Errorf("%w: %s", ErrNotFound, id)
		}
		cp := slices.Clone(raw)
		if sumSHA256Hex(cp) != id {
			return nil, fmt.Errorf("%w: %s", ErrCorrupted, id)
		}
		return cp, nil
	}
	s.mu.RUnlock()

	raw, err := os.ReadFile(filepath.Join(s.dir, id))
	if errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	if err != nil {
		return nil, err
	}
	if sumSHA256Hex(raw) != id {
		return nil, fmt.Errorf("%w: %s", ErrCorrupted, id)
	}
	return raw, nil
}

// Open returns an io.ReadCloser and Attachment metadata for id.
func (s *Store) Open(ctx context.Context, id string) (io.ReadCloser, Attachment, error) {
	att, err := s.Get(ctx, id)
	if err != nil {
		return nil, Attachment{}, err
	}
	raw, err := s.Bytes(ctx, id)
	if err != nil {
		return nil, Attachment{}, err
	}
	return io.NopCloser(bytes.NewReader(raw)), att, nil
}

// Of resolves a list of unique attachment IDs, failing if any is missing or invalid.
func (s *Store) Of(ctx context.Context, ids []string) ([]Attachment, error) {
	seen := make(map[string]struct{}, len(ids))
	out := make([]Attachment, 0, len(ids))
	for _, id := range ids {
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		att, err := s.Get(ctx, id)
		if err != nil {
			return nil, err
		}
		out = append(out, att)
	}
	return out, nil
}

// PathOf returns the disk path of the content-addressed blob for id (or "" in memory mode).
func (s *Store) PathOf(id string) string {
	if s.dir == "" || !IsValidSHA256(id) {
		return ""
	}
	return filepath.Join(s.dir, id)
}

// ServeHTTP serves GET /api/v1/attachment/<sha256> with strict hash validation, immutable caching,
// nosniff, safe Content-Disposition, and Content-Security-Policy: sandbox for non-PDF files.
func (s *Store) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, PathPrefix)
	if !IsValidSHA256(id) {
		http.NotFound(w, r)
		return
	}
	att, err := s.Get(r.Context(), id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	raw, err := s.Bytes(r.Context(), id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	hdrs := ResponseHeaders(att)
	for k, vals := range hdrs {
		for _, v := range vals {
			w.Header().Add(k, v)
		}
	}
	w.Header().Set("Content-Length", strconv.FormatInt(int64(len(raw)), 10))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(raw)
}

// ResponseHeaders builds the security and caching headers for serving att over HTTP.
func ResponseHeaders(att Attachment) http.Header {
	h := make(http.Header)
	contentType := sanitizeMediaType(att.Type)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	baseType, _, _ := mime.ParseMediaType(contentType)
	h.Set("Content-Type", contentType)
	h.Set("Cache-Control", ImmutableCacheControl)
	h.Set("X-Content-Type-Options", "nosniff")

	disp := "attachment"
	if isInlineMediaType(baseType) {
		disp = "inline"
	}
	escaped := url.PathEscape(sanitizeFilename(att.Name))
	h.Set("Content-Disposition", fmt.Sprintf("%s; filename*=UTF-8''%s", disp, escaped))

	if baseType != "application/pdf" {
		h.Set("Content-Security-Policy", "sandbox")
	}
	return h
}

// IsValidSHA256 returns true iff id is exactly 64 lowercase hexadecimal characters.
func IsValidSHA256(id string) bool {
	if len(id) != 64 {
		return false
	}
	for i := range len(id) {
		c := id[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

// ValidateSHA256 checks that id is strictly a 64-character lowercase SHA-256 hex digest.
func ValidateSHA256(id string) error {
	if !IsValidSHA256(id) {
		return fmt.Errorf("%w: %q", ErrInvalidSHA256, id)
	}
	return nil
}

// DetectContentType determines a safe Content-Type from declared type, filename extension, and magic bytes.
func DetectContentType(name, declared string, data []byte) string {
	if clean := sanitizeMediaType(declared); clean != "" && clean != "application/octet-stream" {
		return clean
	}
	if ext := strings.ToLower(path.Ext(strings.TrimSpace(name))); ext != "" {
		if fallback, ok := extMimeFallback[ext]; ok {
			return fallback
		}
		if detected := mime.TypeByExtension(ext); detected != "" {
			if clean := sanitizeMediaType(detected); clean != "" {
				return clean
			}
		}
	}
	if len(data) > 0 {
		head := data
		if len(head) > 512 {
			head = head[:512]
		}
		if detected := sanitizeMediaType(http.DetectContentType(head)); detected != "" {
			return detected
		}
	}
	return "application/octet-stream"
}

var extMimeFallback = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".svg":  "image/svg+xml",
	".mp4":  "video/mp4",
	".webm": "video/webm",
	".mov":  "video/quicktime",
	".mp3":  "audio/mpeg",
	".wav":  "audio/wav",
	".flac": "audio/flac",
	".ogg":  "audio/ogg",
	".pdf":  "application/pdf",
	".json": "application/json",
	".txt":  "text/plain; charset=utf-8",
	".md":   "text/markdown; charset=utf-8",
	".csv":  "text/csv; charset=utf-8",
	".html": "text/html; charset=utf-8",
}

func isInlineMediaType(base string) bool {
	return strings.HasPrefix(base, "image/") ||
		strings.HasPrefix(base, "video/") ||
		strings.HasPrefix(base, "audio/") ||
		base == "application/pdf"
}

func sanitizeMediaType(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || strings.ContainsAny(trimmed, "\r\n") {
		return ""
	}
	mediaType, params, err := mime.ParseMediaType(trimmed)
	if err != nil || mediaType == "" {
		return ""
	}
	return mime.FormatMediaType(mediaType, params)
}

func sanitizeFilename(raw string) string {
	cleaned := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '/' || r == '\\' {
			return -1
		}
		return r
	}, strings.TrimSpace(raw))
	if cleaned == "" || cleaned == "." || cleaned == ".." {
		return "file"
	}
	return cleaned
}

func sumSHA256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (s *Store) loadMetadata() error {
	entries, err := os.ReadDir(s.dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("attachment readdir %s: %w", s.dir, err)
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".json")
		if !IsValidSHA256(id) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(s.dir, e.Name()))
		if err != nil {
			return err
		}
		var meta storedMeta
		if err := json.Unmarshal(raw, &meta); err != nil {
			return fmt.Errorf("decode %s: %w", e.Name(), err)
		}
		if meta.ID != id {
			continue
		}
		s.metas[id] = meta
	}
	return nil
}

func writeOnceAtomic(target string, data []byte) error {
	if _, err := os.Stat(target); err == nil {
		return nil
	}
	dir := filepath.Dir(target)
	tmp, err := os.CreateTemp(dir, ".blob-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Link(tmpName, target); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	_ = os.Remove(tmpName)
	cleanup = false
	return nil
}

func writeAtomic0600(target string, data []byte) error {
	dir := filepath.Dir(target)
	tmp, err := os.CreateTemp(dir, ".meta-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, target); err != nil {
		return err
	}
	cleanup = false
	return nil
}

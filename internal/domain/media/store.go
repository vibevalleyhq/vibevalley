package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

// DefaultMaxAssetBytes bounds single ingested media deliverables (64 MiB).
const DefaultMaxAssetBytes int64 = 64 << 20

// Config configures a SHA-256 deduplicated media asset store.
type Config struct {
	Dir           string
	MaxAssetBytes int64
	Now           func() int64
}

// Asset describes a SHA-256 deduplicated binary deliverable persisted in the media store.
type Asset struct {
	SHA256         string   `json:"sha256"`
	Size           int64    `json:"size"`
	MimeType       string   `json:"mimeType"`
	PrimaryRelPath string   `json:"primaryRelPath"`
	SourcePaths    []string `json:"sourcePaths"`
	SessionIDs     []string `json:"sessionIds,omitempty"`
	IssueIDs       []string `json:"issueIds,omitempty"`
	ChannelIDs     []string `json:"channelIds,omitempty"`
	IngestCount    int64    `json:"ingestCount"`
	CreatedAtMs    int64    `json:"createdAtMs"`
	LastSeenAtMs   int64    `json:"lastSeenAtMs"`
}

// IngestMetadata scopes harvested outputs to a session, issue, and/or channel.
type IngestMetadata struct {
	SessionID        string                                  `json:"sessionId,omitempty"`
	IssueID          string                                  `json:"issueId,omitempty"`
	ChannelID        string                                  `json:"channelId,omitempty"`
	DisplayOverrides map[string]contract.ArtifactDisplayMode `json:"displayOverrides,omitempty"`
}

// IngestRequest bundles harvested outputs recovered from `.vibe/outputs/` before sandbox teardown.
type IngestRequest struct {
	Outputs          []contract.HarvestedOutput              `json:"outputs"`
	SessionID        string                                  `json:"sessionId,omitempty"`
	IssueID          string                                  `json:"issueId,omitempty"`
	ChannelID        string                                  `json:"channelId,omitempty"`
	DisplayOverrides map[string]contract.ArtifactDisplayMode `json:"displayOverrides,omitempty"`
}

// IngestedItem describes the outcome for a single HarvestedOutput entry.
type IngestedItem struct {
	RelPath          string                    `json:"relPath"`
	SHA256           string                    `json:"sha256"`
	Size             int64                     `json:"size"`
	MimeType         string                    `json:"mimeType"`
	BlobDeduplicated bool                      `json:"blobDeduplicated"`
	CardDeduplicated bool                      `json:"cardDeduplicated"`
	Deduplicated     bool                      `json:"deduplicated"`
	Asset            Asset                     `json:"asset"`
	Card             contract.ArtifactCardView `json:"card"`
}

// IngestResult summarizes deduplicated assets and emitted ArtifactCardView cards from an ingestion batch.
type IngestResult struct {
	Items             []IngestedItem              `json:"items"`
	Assets            []Asset                     `json:"assets"`
	Cards             []contract.ArtifactCardView `json:"cards"`
	DeduplicatedCount int                         `json:"deduplicatedCount"`
	NewBlobs          int                         `json:"newBlobs"`
	StoredBytes       int64                       `json:"storedBytes"`
	LogicalBytes      int64                       `json:"logicalBytes"`
}

// CardFilter filters stored ArtifactCardView metadata entries.
type CardFilter struct {
	IssueID   string
	ChannelID string
	SHA256    string
}

// StoreStats summarizes deduplication and storage efficiency across all ingested assets.
type StoreStats struct {
	UniqueBlobs       int   `json:"uniqueBlobs"`
	UniqueAssets      int   `json:"uniqueAssets"`
	TotalCards        int   `json:"totalCards"`
	UniqueBytes       int64 `json:"uniqueBytes"`
	LogicalBytes      int64 `json:"logicalBytes"`
	TotalIngests      int64 `json:"totalIngests"`
	DeduplicatedCount int64 `json:"deduplicatedCount"`
	DiskPersisted     bool  `json:"diskPersisted"`
}

type scopedCardRecord struct {
	Scope   string                    `json:"scope"`
	RelPath string                    `json:"relPath"`
	Card    contract.ArtifactCardView `json:"card"`
}

type persistedIndex struct {
	Assets       map[string]Asset            `json:"assets"`
	Cards        map[string]scopedCardRecord `json:"cards"`
	CardOrder    []string                    `json:"cardOrder"`
	LogicalBytes int64                       `json:"logicalBytes"`
	TotalIngests int64                       `json:"totalIngests"`
	Deduplicated int64                       `json:"deduplicated"`
}

// Store persists SHA-256 deduplicated binary deliverables and emits ArtifactCardView metadata.
type Store struct {
	dir      string
	blobsDir string
	maxBytes int64
	now      func() int64

	mu           sync.RWMutex
	blobs        map[string][]byte // populated only in in-memory mode (dir == "")
	diskSizes    map[string]int64  // populated in disk-backed mode (dir != "")
	assets       map[string]Asset
	cards        map[string]scopedCardRecord // keyed by Card.ID
	cardByPath   map[string]string           // scope+"\x00"+relPath -> Card.ID
	cardBySHA    map[string]string           // scope+"\x00"+sha256  -> Card.ID
	cardOrder    []string
	logicalBytes int64
	totalIngests int64
	deduplicated int64
}

// NewStore creates a SHA-256 deduplicated media store, reloading persisted blobs/cards if cfg.Dir is set.
func NewStore(cfg Config) (*Store, error) {
	maxBytes := cfg.MaxAssetBytes
	if maxBytes <= 0 {
		maxBytes = DefaultMaxAssetBytes
	}
	now := cfg.Now
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	st := &Store{
		dir:        strings.TrimSpace(cfg.Dir),
		maxBytes:   maxBytes,
		now:        now,
		assets:     make(map[string]Asset),
		cards:      make(map[string]scopedCardRecord),
		cardByPath: make(map[string]string),
		cardBySHA:  make(map[string]string),
	}
	if st.dir == "" {
		st.blobs = make(map[string][]byte)
	} else {
		st.diskSizes = make(map[string]int64)
		st.blobsDir = filepath.Join(st.dir, "blobs")
		if err := os.MkdirAll(st.blobsDir, 0o755); err != nil {
			return nil, fmt.Errorf("media mkdir blobs: %w", err)
		}
		if err := st.loadFromDisk(); err != nil {
			return nil, err
		}
	}
	return st, nil
}

// HarvestAndIngest recovers `.vibe/outputs/` from env before sandbox teardown and persists them cleanly.
func (s *Store) HarvestAndIngest(ctx context.Context, env contract.ExecutionEnv, meta IngestMetadata) (IngestResult, error) {
	if err := ctx.Err(); err != nil {
		return IngestResult{}, err
	}
	outputs, err := env.HarvestOutputs(ctx)
	if err != nil {
		return IngestResult{}, err
	}
	return s.IngestHarvested(ctx, IngestRequest{
		Outputs:          outputs,
		SessionID:        meta.SessionID,
		IssueID:          meta.IssueID,
		ChannelID:        meta.ChannelID,
		DisplayOverrides: meta.DisplayOverrides,
	})
}

// IngestHarvested validates, SHA-256 deduplicates, persists binary outputs, and emits ArtifactCardView metadata.
func (s *Store) IngestHarvested(ctx context.Context, req IngestRequest) (IngestResult, error) {
	if err := ctx.Err(); err != nil {
		return IngestResult{}, err
	}
	for rawPath, mode := range req.DisplayOverrides {
		if !isValidDisplayMode(mode) {
			return IngestResult{}, fmt.Errorf("%w: %q for %q", ErrInvalidDisplay, mode, rawPath)
		}
	}

	type preparedOutput struct {
		relPath  string
		sha256   string
		size     int64
		mimeType string
		display  contract.ArtifactDisplayMode
		data     []byte
	}

	prepared := make([]preparedOutput, 0, len(req.Outputs))
	for _, out := range req.Outputs {
		if err := ctx.Err(); err != nil {
			return IngestResult{}, err
		}
		cleanRel, err := normalizeRelPath(out.RelPath)
		if err != nil {
			return IngestResult{}, err
		}
		if out.Data == nil && out.Size > 0 {
			return IngestResult{}, fmt.Errorf("%w: %s", ErrMissingData, cleanRel)
		}
		actualSize := int64(len(out.Data))
		if actualSize > s.maxBytes || out.Size > s.maxBytes {
			return IngestResult{}, fmt.Errorf("%w: %s (%d bytes)", ErrAssetTooLarge, cleanRel, max(actualSize, out.Size))
		}
		if out.Size < 0 || (out.Size > 0 && actualSize != out.Size) {
			return IngestResult{}, fmt.Errorf("%w: %s declared=%d actual=%d", ErrSizeMismatch, cleanRel, out.Size, actualSize)
		}

		computed := sumSHA256(out.Data)
		if strings.TrimSpace(out.SHA256) != "" {
			normDecl, err := normalizeSHA256(out.SHA256)
			if err != nil {
				return IngestResult{}, fmt.Errorf("%w: %s", ErrChecksumMismatch, cleanRel)
			}
			if normDecl != computed {
				return IngestResult{}, fmt.Errorf("%w: %s expected=%s actual=%s", ErrChecksumMismatch, cleanRel, normDecl, computed)
			}
		}

		mimeType := resolveMimeType(cleanRel, out.MimeType, out.Data)
		display := inferDisplayMode(cleanRel, out.RelPath, mimeType, req.DisplayOverrides)

		prepared = append(prepared, preparedOutput{
			relPath:  cleanRel,
			sha256:   computed,
			size:     actualSize,
			mimeType: mimeType,
			display:  display,
			data:     out.Data,
		})
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	nowMs := s.now()
	scope := scopeKey(req.IssueID, req.ChannelID)

	res := IngestResult{
		Items: make([]IngestedItem, 0, len(prepared)),
	}
	seenAssets := make(map[string]int)
	seenCards := make(map[string]int)

	for _, p := range prepared {
		blobDedup, err := s.ensureBlobLocked(p.sha256, p.data)
		if err != nil {
			return IngestResult{}, err
		}
		if !blobDedup {
			res.NewBlobs++
			res.StoredBytes += p.size
		}
		res.LogicalBytes += p.size
		s.logicalBytes += p.size
		s.totalIngests++

		asset := s.upsertAssetLocked(p.sha256, p.size, p.mimeType, p.relPath, req.SessionID, req.IssueID, req.ChannelID, nowMs)
		card, cardDedup := s.upsertCardLocked(scope, p.relPath, p.sha256, p.mimeType, p.display, req.ChannelID, req.IssueID, nowMs)

		dedup := blobDedup || cardDedup
		if dedup {
			res.DeduplicatedCount++
			s.deduplicated++
		}

		item := IngestedItem{
			RelPath:          p.relPath,
			SHA256:           p.sha256,
			Size:             p.size,
			MimeType:         p.mimeType,
			BlobDeduplicated: blobDedup,
			CardDeduplicated: cardDedup,
			Deduplicated:     dedup,
			Asset:            cloneAsset(asset),
			Card:             card,
		}
		res.Items = append(res.Items, item)

		if idx, ok := seenAssets[asset.SHA256]; ok {
			res.Assets[idx] = cloneAsset(asset)
		} else {
			seenAssets[asset.SHA256] = len(res.Assets)
			res.Assets = append(res.Assets, cloneAsset(asset))
		}
		if idx, ok := seenCards[card.ID]; ok {
			res.Cards[idx] = card
		} else {
			seenCards[card.ID] = len(res.Cards)
			res.Cards = append(res.Cards, card)
		}
	}

	if err := s.saveIndexLocked(); err != nil {
		return IngestResult{}, err
	}
	return res, nil
}

// IngestStream reads a bounded binary stream, hashes it with SHA-256, deduplicates it, and emits an ArtifactCardView.
func (s *Store) IngestStream(ctx context.Context, relPath, mimeType string, r io.Reader, meta IngestMetadata) (IngestedItem, error) {
	if r == nil {
		return IngestedItem{}, ErrMissingData
	}
	limited := io.LimitReader(r, s.maxBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return IngestedItem{}, err
	}
	if int64(len(data)) > s.maxBytes {
		return IngestedItem{}, fmt.Errorf("%w: %s exceeds %d bytes", ErrAssetTooLarge, relPath, s.maxBytes)
	}
	res, err := s.IngestHarvested(ctx, IngestRequest{
		Outputs: []contract.HarvestedOutput{{
			RelPath:  relPath,
			SHA256:   sumSHA256(data),
			Size:     int64(len(data)),
			MimeType: mimeType,
			Data:     data,
		}},
		SessionID:        meta.SessionID,
		IssueID:          meta.IssueID,
		ChannelID:        meta.ChannelID,
		DisplayOverrides: meta.DisplayOverrides,
	})
	if err != nil {
		return IngestedItem{}, err
	}
	return res.Items[0], nil
}

// GetAsset returns metadata for the deduplicated asset matching digest.
func (s *Store) GetAsset(_ context.Context, digest string) (Asset, error) {
	key, err := normalizeSHA256(digest)
	if err != nil {
		return Asset{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	a, ok := s.assets[key]
	if !ok {
		return Asset{}, fmt.Errorf("%w: %s", ErrAssetNotFound, key)
	}
	return cloneAsset(a), nil
}

// ReadBytes retrieves stored asset bytes by SHA-256 after verifying integrity.
func (s *Store) ReadBytes(_ context.Context, digest string) ([]byte, error) {
	key, err := normalizeSHA256(digest)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	blobsDir := s.blobsDir
	if blobsDir == "" {
		raw, ok := s.blobs[key]
		if !ok {
			s.mu.RUnlock()
			return nil, fmt.Errorf("%w: %s", ErrAssetNotFound, key)
		}
		cp := slices.Clone(raw)
		s.mu.RUnlock()
		if sumSHA256(cp) != key {
			return nil, fmt.Errorf("%w: %s", ErrCorruptedAsset, key)
		}
		return cp, nil
	}
	s.mu.RUnlock()
	return s.readDiskBlob(key)
}

// Open returns an io.ReadCloser and Asset metadata for digest.
func (s *Store) Open(ctx context.Context, digest string) (io.ReadCloser, Asset, error) {
	asset, err := s.GetAsset(ctx, digest)
	if err != nil {
		return nil, Asset{}, err
	}
	data, err := s.ReadBytes(ctx, digest)
	if err != nil {
		return nil, Asset{}, err
	}
	return io.NopCloser(bytes.NewReader(data)), asset, nil
}

// ListAssets returns all unique assets sorted by LastSeenAtMs descending then SHA256.
func (s *Store) ListAssets(_ context.Context) []Asset {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Asset, 0, len(s.assets))
	for _, a := range s.assets {
		out = append(out, cloneAsset(a))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].LastSeenAtMs != out[j].LastSeenAtMs {
			return out[i].LastSeenAtMs > out[j].LastSeenAtMs
		}
		return out[i].SHA256 < out[j].SHA256
	})
	return out
}

// ListCards returns emitted ArtifactCardView records matching filter, newest first.
func (s *Store) ListCards(_ context.Context, filter CardFilter) []contract.ArtifactCardView {
	s.mu.RLock()
	defer s.mu.RUnlock()
	normSHA := strings.ToLower(strings.TrimSpace(filter.SHA256))
	out := make([]contract.ArtifactCardView, 0, len(s.cardOrder))
	for i := len(s.cardOrder) - 1; i >= 0; i-- {
		rec, ok := s.cards[s.cardOrder[i]]
		if !ok {
			continue
		}
		if filter.IssueID != "" && rec.Card.IssueID != filter.IssueID {
			continue
		}
		if filter.ChannelID != "" && rec.Card.ChannelID != filter.ChannelID {
			continue
		}
		if normSHA != "" && rec.Card.SHA256 != normSHA {
			continue
		}
		out = append(out, rec.Card)
	}
	return out
}

// Stats reports unique blob counts, deduplicated saves, and bytes saved.
func (s *Store) Stats() StoreStats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var uniqueBytes int64
	uniqueBlobs := 0
	if s.blobsDir == "" {
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
	return StoreStats{
		UniqueBlobs:       uniqueBlobs,
		UniqueAssets:      len(s.assets),
		TotalCards:        len(s.cards),
		UniqueBytes:       uniqueBytes,
		LogicalBytes:      s.logicalBytes,
		TotalIngests:      s.totalIngests,
		DeduplicatedCount: s.deduplicated,
		DiskPersisted:     s.dir != "",
	}
}

func (s *Store) readDiskBlob(key string) ([]byte, error) {
	raw, err := os.ReadFile(filepath.Join(s.blobsDir, key))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("%w: %s", ErrAssetNotFound, key)
		}
		return nil, err
	}
	if sumSHA256(raw) != key {
		return nil, fmt.Errorf("%w: %s", ErrCorruptedAsset, key)
	}
	return raw, nil
}

func (s *Store) ensureBlobLocked(shaHex string, data []byte) (deduplicated bool, err error) {
	if s.blobsDir == "" {
		if existing, ok := s.blobs[shaHex]; ok {
			if len(existing) == len(data) && sumSHA256(existing) == shaHex {
				return true, nil
			}
		}
		s.blobs[shaHex] = slices.Clone(data)
		return false, nil
	}

	target := filepath.Join(s.blobsDir, shaHex)
	if info, statErr := os.Stat(target); statErr == nil && !info.IsDir() {
		raw, readErr := os.ReadFile(target)
		if readErr == nil && sumSHA256(raw) == shaHex {
			s.diskSizes[shaHex] = int64(len(raw))
			return true, nil
		}
	}
	if err := writeFileAtomic(target, data, 0o644); err != nil {
		return false, err
	}
	s.diskSizes[shaHex] = int64(len(data))
	return false, nil
}

func (s *Store) upsertAssetLocked(shaHex string, size int64, mimeType, relPath, sessionID, issueID, channelID string, nowMs int64) Asset {
	a, ok := s.assets[shaHex]
	if !ok {
		a = Asset{
			SHA256:         shaHex,
			Size:           size,
			MimeType:       mimeType,
			PrimaryRelPath: relPath,
			CreatedAtMs:    nowMs,
		}
	}
	a.IngestCount++
	a.LastSeenAtMs = nowMs
	if !slices.Contains(a.SourcePaths, relPath) {
		a.SourcePaths = append(a.SourcePaths, relPath)
	}
	if sessionID != "" && !slices.Contains(a.SessionIDs, sessionID) {
		a.SessionIDs = append(a.SessionIDs, sessionID)
	}
	if issueID != "" && !slices.Contains(a.IssueIDs, issueID) {
		a.IssueIDs = append(a.IssueIDs, issueID)
	}
	if channelID != "" && !slices.Contains(a.ChannelIDs, channelID) {
		a.ChannelIDs = append(a.ChannelIDs, channelID)
	}
	s.assets[shaHex] = a
	return a
}

func (s *Store) upsertCardLocked(scope, relPath, shaHex, mimeType string, display contract.ArtifactDisplayMode, channelID, issueID string, nowMs int64) (card contract.ArtifactCardView, deduplicated bool) {
	shaKey := scope + "\x00" + shaHex
	if existingID, ok := s.cardBySHA[shaKey]; ok {
		if rec, exists := s.cards[existingID]; exists {
			return rec.Card, true
		}
	}

	pathKey := scope + "\x00" + relPath
	bodyKind := "media"
	if strings.HasPrefix(strings.ToLower(mimeType), "text/html") {
		bodyKind = "html"
	}

	if existingID, ok := s.cardByPath[pathKey]; ok {
		if rec, exists := s.cards[existingID]; exists {
			next := rec.Card
			next.Version++
			next.SHA256 = shaHex
			next.Body = bodyKind
			next.Display = display
			next.UpdatedAtMs = nowMs
			s.cards[existingID] = scopedCardRecord{
				Scope:   scope,
				RelPath: relPath,
				Card:    next,
			}
			s.cardBySHA[shaKey] = existingID
			return next, false
		}
	}

	cardID := "med_" + sumSHA256([]byte(pathKey))[:16]
	card = contract.ArtifactCardView{
		ID:          cardID,
		Title:       path.Base(relPath),
		Body:        bodyKind,
		Display:     display,
		Version:     1,
		SHA256:      shaHex,
		ChannelID:   channelID,
		IssueID:     issueID,
		UpdatedAtMs: nowMs,
	}
	s.cards[cardID] = scopedCardRecord{
		Scope:   scope,
		RelPath: relPath,
		Card:    card,
	}
	s.cardByPath[pathKey] = cardID
	s.cardBySHA[shaKey] = cardID
	s.cardOrder = append(s.cardOrder, cardID)
	return card, false
}

func (s *Store) saveIndexLocked() error {
	if s.dir == "" {
		return nil
	}
	idx := persistedIndex{
		Assets:       s.assets,
		Cards:        s.cards,
		CardOrder:    s.cardOrder,
		LogicalBytes: s.logicalBytes,
		TotalIngests: s.totalIngests,
		Deduplicated: s.deduplicated,
	}
	raw, err := json.Marshal(idx)
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(s.dir, "index.json"), raw, 0o644)
}

func (s *Store) loadFromDisk() error {
	entries, err := os.ReadDir(s.blobsDir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("media readdir blobs: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || strings.HasPrefix(entry.Name(), ".tmp-") {
			continue
		}
		key, err := normalizeSHA256(entry.Name())
		if err != nil {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(s.blobsDir, key))
		if err != nil {
			return err
		}
		if sumSHA256(raw) != key {
			return fmt.Errorf("%w: blob %s", ErrCorruptedAsset, key)
		}
		s.diskSizes[key] = int64(len(raw))
	}

	idxPath := filepath.Join(s.dir, "index.json")
	raw, err := os.ReadFile(idxPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("media read index: %w", err)
	}
	var idx persistedIndex
	if err := json.Unmarshal(raw, &idx); err != nil {
		return fmt.Errorf("media decode index: %w", err)
	}
	if idx.Assets != nil {
		s.assets = idx.Assets
	}
	if idx.Cards != nil {
		s.cards = idx.Cards
	}
	s.cardOrder = idx.CardOrder
	s.logicalBytes = idx.LogicalBytes
	s.totalIngests = idx.TotalIngests
	s.deduplicated = idx.Deduplicated
	for id, rec := range s.cards {
		s.cardByPath[rec.Scope+"\x00"+rec.RelPath] = id
		s.cardBySHA[rec.Scope+"\x00"+rec.Card.SHA256] = id
	}
	return nil
}

func normalizeRelPath(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" || strings.ContainsRune(raw, 0) {
		return "", fmt.Errorf("%w: empty path", ErrInvalidRelPath)
	}
	slash := strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/")
	if strings.HasPrefix(slash, "/") {
		return "", fmt.Errorf("%w: absolute path %q", ErrInvalidRelPath, raw)
	}
	for seg := range strings.SplitSeq(slash, "/") {
		if seg == ".." {
			return "", fmt.Errorf("%w: path traversal %q", ErrInvalidRelPath, raw)
		}
	}
	cleaned := strings.TrimPrefix(path.Clean(slash), "./")
	if cleaned == "" || cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("%w: %q", ErrInvalidRelPath, raw)
	}
	return cleaned, nil
}

func sumSHA256(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func normalizeSHA256(digest string) (string, error) {
	s := strings.ToLower(strings.TrimSpace(digest))
	if len(s) != 64 {
		return "", fmt.Errorf("%w: length %d", ErrInvalidSHA256, len(s))
	}
	for i := range len(s) {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return "", fmt.Errorf("%w: invalid char at %d", ErrInvalidSHA256, i)
		}
	}
	return s, nil
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
	".html": "text/html; charset=utf-8",
	".htm":  "text/html; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".js":   "application/javascript; charset=utf-8",
	".tsx":  "text/typescript-jsx; charset=utf-8",
	".json": "application/json",
	".csv":  "text/csv; charset=utf-8",
	".md":   "text/markdown; charset=utf-8",
	".txt":  "text/plain; charset=utf-8",
}

func resolveMimeType(relPath, declared string, data []byte) string {
	if trimmed := strings.TrimSpace(declared); trimmed != "" {
		return trimmed
	}
	ext := strings.ToLower(path.Ext(relPath))
	if ext != "" {
		if m, ok := extMimeFallback[ext]; ok {
			return m
		}
		if m := mime.TypeByExtension(ext); m != "" {
			return m
		}
	}
	if len(data) > 0 {
		head := data
		if len(head) > 512 {
			head = head[:512]
		}
		return http.DetectContentType(head)
	}
	return "application/octet-stream"
}

func inferDisplayMode(cleanRel, rawRel, mimeType string, overrides map[string]contract.ArtifactDisplayMode) contract.ArtifactDisplayMode {
	if m, ok := overrides[cleanRel]; ok && m != "" {
		return m
	}
	if m, ok := overrides[rawRel]; ok && m != "" {
		return m
	}
	lower := strings.ToLower(cleanRel)
	switch {
	case strings.Contains(lower, ".slides."):
		return contract.ArtifactDisplaySlides
	case strings.Contains(lower, ".dashboard."):
		return contract.ArtifactDisplayDashboard
	case strings.Contains(lower, ".canvas."):
		return contract.ArtifactDisplayCanvas
	case strings.Contains(lower, ".whiteboard."):
		return contract.ArtifactDisplayWhiteboard
	case strings.Contains(lower, ".motion.") || strings.HasPrefix(strings.ToLower(mimeType), "video/"):
		return contract.ArtifactDisplayMotion
	default:
		return contract.ArtifactDisplayPage
	}
}

func isValidDisplayMode(mode contract.ArtifactDisplayMode) bool {
	switch mode {
	case contract.ArtifactDisplayPage,
		contract.ArtifactDisplaySlides,
		contract.ArtifactDisplayMotion,
		contract.ArtifactDisplayCanvas,
		contract.ArtifactDisplayDashboard,
		contract.ArtifactDisplayWhiteboard:
		return true
	default:
		return false
	}
}

func scopeKey(issueID, channelID string) string {
	return strings.TrimSpace(issueID) + "|" + strings.TrimSpace(channelID)
}

func cloneAsset(a Asset) Asset {
	out := a
	out.SourcePaths = slices.Clone(a.SourcePaths)
	out.SessionIDs = slices.Clone(a.SessionIDs)
	out.IssueIDs = slices.Clone(a.IssueIDs)
	out.ChannelIDs = slices.Clone(a.ChannelIDs)
	return out
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

package artifact

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/hexops/gotextdiff"
	"github.com/hexops/gotextdiff/myers"
	"github.com/hexops/gotextdiff/span"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

// DefaultMaxDeliverableBytes bounds raw or compiled HTML deliverable sizes (5 MiB).
const DefaultMaxDeliverableBytes = 5 * 1024 * 1024

// IsValidDisplayMode reports whether mode is one of the contract ArtifactDisplayMode variants.
func IsValidDisplayMode(mode contract.ArtifactDisplayMode) bool {
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

// TextDiff holds line-level Myers edits and unified diff output produced via gotextdiff.
type TextDiff struct {
	From    string                `json:"from"`
	To      string                `json:"to"`
	Unified string                `json:"unified"`
	Hunks   []*gotextdiff.Hunk    `json:"hunks,omitempty"`
	Edits   []gotextdiff.TextEdit `json:"edits,omitempty"`
	Equal   bool                  `json:"equal"`
}

// FileDiff summarizes the line-level diff of a single virtual file across two versions.
type FileDiff struct {
	Path       string   `json:"path"`
	Status     string   `json:"status"` // "added", "modified", "deleted", "unchanged"
	FromSHA256 string   `json:"fromSha256,omitempty"`
	ToSHA256   string   `json:"toSha256,omitempty"`
	Diff       TextDiff `json:"diff"`
}

// VersionDiff summarizes diffs across both source files and compiled HTML between two versions.
type VersionDiff struct {
	ArtifactID  string     `json:"artifactId"`
	FromVersion int        `json:"fromVersion"`
	ToVersion   int        `json:"toVersion"`
	HTMLDiff    TextDiff   `json:"htmlDiff"`
	FileDiffs   []FileDiff `json:"fileDiffs,omitempty"`
	HasChanges  bool       `json:"hasChanges"`
}

// DiffText computes an exact line-level unified diff between before and after via hexops/gotextdiff.
func DiffText(fromLabel, toLabel, before, after string) TextDiff {
	edits := myers.ComputeEdits(span.URIFromPath(fromLabel), before, after)
	u := gotextdiff.ToUnified(fromLabel, toLabel, before, edits)
	return TextDiff{
		From:    fromLabel,
		To:      toLabel,
		Unified: fmt.Sprint(u),
		Hunks:   u.Hunks,
		Edits:   edits,
		Equal:   len(u.Hunks) == 0,
	}
}

// PublishRequest describes creating or adding a version to a web/HTML/TSX deliverable.
type PublishRequest struct {
	ID        string                       `json:"id,omitempty"`
	Title     string                       `json:"title,omitempty"`
	Display   contract.ArtifactDisplayMode `json:"display,omitempty"`
	ChannelID string                       `json:"channelId,omitempty"`
	IssueID   string                       `json:"issueId,omitempty"`
	Note      string                       `json:"note,omitempty"`
	Author    string                       `json:"author,omitempty"`
	Bundle    *CompileRequest              `json:"bundle,omitempty"`
	RawHTML   string                       `json:"rawHtml,omitempty"`
}

// DeliverableVersion captures immutable metadata and CAS references for one published version.
type DeliverableVersion struct {
	Version      int                          `json:"version"`
	HTMLSHA256   string                       `json:"htmlSha256"`
	SourceSHA256 string                       `json:"sourceSha256,omitempty"`
	FileSHAs     map[string]string            `json:"fileShas,omitempty"`
	Size         int64                        `json:"size"`
	Display      contract.ArtifactDisplayMode `json:"display"`
	Note         string                       `json:"note,omitempty"`
	Author       string                       `json:"author,omitempty"`
	CreatedAtMs  int64                        `json:"createdAtMs"`
	Card         contract.ArtifactCardView    `json:"card"`
}

// Deliverable summarizes an artifact and its immutable version history.
type Deliverable struct {
	ID            string                       `json:"id"`
	Title         string                       `json:"title"`
	Display       contract.ArtifactDisplayMode `json:"display"`
	ChannelID     string                       `json:"channelId,omitempty"`
	IssueID       string                       `json:"issueId,omitempty"`
	LatestVersion int                          `json:"latestVersion"`
	LatestSHA256  string                       `json:"latestSha256"`
	Versions      []DeliverableVersion         `json:"versions"`
	Card          contract.ArtifactCardView    `json:"card"`
	CreatedAtMs   int64                        `json:"createdAtMs"`
	UpdatedAtMs   int64                        `json:"updatedAtMs"`
}

// PublishResult reports the published deliverable, new version metadata, and CAS deduplication flags.
type PublishResult struct {
	Deliverable      Deliverable               `json:"deliverable"`
	Version          DeliverableVersion        `json:"version"`
	Card             contract.ArtifactCardView `json:"card"`
	BlobDeduplicated bool                      `json:"blobDeduplicated"`
	CompileMs        int64                     `json:"compileMs"`
}

// DeliverableFilter filters listed Deliverable cards.
type DeliverableFilter struct {
	ChannelID string
	IssueID   string
	Display   contract.ArtifactDisplayMode
}

// DeliverableStoreConfig configures a DeliverableStore.
type DeliverableStoreConfig struct {
	CAS      *ContentStore
	Dir      string
	MaxBytes int64
	Now      func() int64
}

// DeliverableStore persists versioned HTML/TSX deliverables in SHA-256 CAS with exact unified diffs.
type DeliverableStore struct {
	cas      *ContentStore
	dir      string
	maxBytes int64
	now      func() int64

	mu    sync.RWMutex
	items map[string]*Deliverable
	order []string
}

// NewDeliverableStore constructs a DeliverableStore backed by cfg.CAS (creating an in-memory CAS if nil).
func NewDeliverableStore(cfg DeliverableStoreConfig) (*DeliverableStore, error) {
	cas := cfg.CAS
	if cas == nil {
		if cfg.Dir != "" {
			var err error
			cas, err = NewDirCAS(cfg.Dir)
			if err != nil {
				return nil, err
			}
		} else {
			cas = NewMemoryCAS()
		}
	}
	maxBytes := cfg.MaxBytes
	if maxBytes <= 0 {
		maxBytes = DefaultMaxDeliverableBytes
	}
	now := cfg.Now
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	ds := &DeliverableStore{
		cas:      cas,
		dir:      strings.TrimSpace(cfg.Dir),
		maxBytes: maxBytes,
		now:      now,
		items:    make(map[string]*Deliverable),
	}
	if ds.dir != "" {
		if err := ds.loadFromDisk(); err != nil {
			return nil, err
		}
	}
	return ds, nil
}

// CAS returns the underlying SHA-256 ContentStore.
func (s *DeliverableStore) CAS() *ContentStore {
	return s.cas
}

// Publish compiles (when Bundle is provided) or validates (when RawHTML is provided) and persists a new version.
// Compilation/policy failures return *CompileError BEFORE any CAS blob or deliverable version is persisted.
func (s *DeliverableStore) Publish(_ context.Context, req PublishRequest) (PublishResult, error) {
	if (req.Bundle == nil && req.RawHTML == "") || (req.Bundle != nil && req.RawHTML != "") {
		return PublishResult{}, fmt.Errorf("%w: exactly one of Bundle or RawHTML is required", ErrInvalidBundle)
	}

	display := req.Display
	if display == "" && req.Bundle != nil {
		display = req.Bundle.Display
	}
	if display == "" {
		display = contract.ArtifactDisplayPage
	}
	if !IsValidDisplayMode(display) {
		return PublishResult{}, fmt.Errorf("%w: %q", ErrInvalidDisplayMode, display)
	}

	var htmlBytes []byte
	var sourceSHA string
	var fileSHAs map[string]string
	var compileMs int64
	var vfsNormalized map[string]string

	if req.Bundle != nil {
		creq := *req.Bundle
		if creq.Display == "" {
			creq.Display = display
		}
		if creq.Title == "" {
			creq.Title = req.Title
		}
		compiled, err := CompileBundle(creq)
		if err != nil {
			return PublishResult{}, err
		}
		compileMs = compiled.Duration.Milliseconds()
		htmlBytes = []byte(compiled.HTML)
		sourceSHA = compiled.SourceSHA256
		vfsNormalized, err = normalizeVirtualFiles(creq.Files)
		if err != nil {
			return PublishResult{}, err
		}
	} else {
		if len(req.RawHTML) == 0 {
			return PublishResult{}, &CompileError{
				Cause:       ErrHTMLPolicyViolation,
				Diagnostics: []Diagnostic{{File: "index.html", Line: 1, Column: 1, Message: "html deliverable is empty"}},
			}
		}
		if int64(len(req.RawHTML)) > s.maxBytes {
			return PublishResult{}, &CompileError{
				Cause:       ErrHTMLPolicyViolation,
				Diagnostics: []Diagnostic{{File: "index.html", Line: 1, Column: 1, Message: fmt.Sprintf("html size %d exceeds limit %d", len(req.RawHTML), s.maxBytes)}},
			}
		}
		if diags := CheckHTMLPolicy(req.RawHTML); len(diags) > 0 {
			return PublishResult{}, &CompileError{
				Cause:       ErrHTMLPolicyViolation,
				Diagnostics: diags,
			}
		}
		htmlBytes = []byte(req.RawHTML)
	}

	if int64(len(htmlBytes)) > s.maxBytes {
		return PublishResult{}, &CompileError{
			Cause:       ErrHTMLPolicyViolation,
			Diagnostics: []Diagnostic{{File: "bundle.html", Line: 1, Column: 1, Message: fmt.Sprintf("compiled bundle size %d exceeds limit %d", len(htmlBytes), s.maxBytes)}},
		}
	}

	// Only persist into CAS AFTER compile & validation succeed.
	if len(vfsNormalized) > 0 {
		fileSHAs = make(map[string]string, len(vfsNormalized))
		for pathKey, body := range vfsNormalized {
			ref, err := s.cas.Put([]byte(body))
			if err != nil {
				return PublishResult{}, err
			}
			fileSHAs[pathKey] = ref.SHA256
		}
	}

	htmlRef, err := s.cas.Put(htmlBytes)
	if err != nil {
		return PublishResult{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	nowMs := s.now()
	id := strings.TrimSpace(req.ID)
	if id == "" {
		id = newHexID("art")
	}

	existing, exists := s.items[id]
	title := strings.TrimSpace(req.Title)
	if !exists {
		if title == "" {
			title = "Untitled Artifact"
		}
		verNum := 1
		card := contract.ArtifactCardView{
			ID:          id,
			Title:       title,
			Body:        "html",
			Display:     display,
			Version:     verNum,
			SHA256:      htmlRef.SHA256,
			ChannelID:   req.ChannelID,
			IssueID:     req.IssueID,
			UpdatedAtMs: nowMs,
		}
		ver := DeliverableVersion{
			Version:      verNum,
			HTMLSHA256:   htmlRef.SHA256,
			SourceSHA256: sourceSHA,
			FileSHAs:     fileSHAs,
			Size:         htmlRef.Size,
			Display:      display,
			Note:         strings.TrimSpace(req.Note),
			Author:       strings.TrimSpace(req.Author),
			CreatedAtMs:  nowMs,
			Card:         card,
		}
		d := &Deliverable{
			ID:            id,
			Title:         title,
			Display:       display,
			ChannelID:     req.ChannelID,
			IssueID:       req.IssueID,
			LatestVersion: verNum,
			LatestSHA256:  htmlRef.SHA256,
			Versions:      []DeliverableVersion{ver},
			Card:          card,
			CreatedAtMs:   nowMs,
			UpdatedAtMs:   nowMs,
		}
		if err := s.saveDeliverableMetadata(d); err != nil {
			return PublishResult{}, err
		}
		s.items[id] = d
		s.order = append(s.order, id)
		return PublishResult{
			Deliverable:      cloneDeliverable(*d),
			Version:          cloneDeliverableVersion(ver),
			Card:             card,
			BlobDeduplicated: htmlRef.Deduplicated,
			CompileMs:        compileMs,
		}, nil
	}

	if title == "" {
		title = existing.Title
	}
	if req.Display == "" && (req.Bundle == nil || req.Bundle.Display == "") {
		display = existing.Display
	}
	channelID := req.ChannelID
	if channelID == "" {
		channelID = existing.ChannelID
	}
	issueID := req.IssueID
	if issueID == "" {
		issueID = existing.IssueID
	}

	verNum := existing.LatestVersion + 1
	card := contract.ArtifactCardView{
		ID:          existing.ID,
		Title:       title,
		Body:        "html",
		Display:     display,
		Version:     verNum,
		SHA256:      htmlRef.SHA256,
		ChannelID:   channelID,
		IssueID:     issueID,
		UpdatedAtMs: nowMs,
	}
	ver := DeliverableVersion{
		Version:      verNum,
		HTMLSHA256:   htmlRef.SHA256,
		SourceSHA256: sourceSHA,
		FileSHAs:     fileSHAs,
		Size:         htmlRef.Size,
		Display:      display,
		Note:         strings.TrimSpace(req.Note),
		Author:       strings.TrimSpace(req.Author),
		CreatedAtMs:  nowMs,
		Card:         card,
	}

	updated := cloneDeliverable(*existing)
	updated.Title = title
	updated.Display = display
	updated.ChannelID = channelID
	updated.IssueID = issueID
	updated.LatestVersion = verNum
	updated.LatestSHA256 = htmlRef.SHA256
	updated.Versions = append(updated.Versions, ver)
	updated.Card = card
	updated.UpdatedAtMs = nowMs

	if err := s.saveDeliverableMetadata(&updated); err != nil {
		return PublishResult{}, err
	}
	s.items[id] = &updated

	return PublishResult{
		Deliverable:      cloneDeliverable(updated),
		Version:          cloneDeliverableVersion(ver),
		Card:             card,
		BlobDeduplicated: htmlRef.Deduplicated,
		CompileMs:        compileMs,
	}, nil
}

// Get returns the deliverable metadata and version history for id.
func (s *DeliverableStore) Get(_ context.Context, id string) (Deliverable, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.items[id]
	if !ok {
		return Deliverable{}, fmt.Errorf("%w: deliverable %q", ErrNotFound, id)
	}
	return cloneDeliverable(*d), nil
}

// GetVersion returns version metadata and compiled HTML bytes for (id, version).
// If version <= 0, the latest version is returned.
func (s *DeliverableStore) GetVersion(_ context.Context, id string, version int) (DeliverableVersion, []byte, error) {
	s.mu.RLock()
	d, ok := s.items[id]
	if !ok {
		s.mu.RUnlock()
		return DeliverableVersion{}, nil, fmt.Errorf("%w: deliverable %q", ErrNotFound, id)
	}
	targetVer := version
	if targetVer <= 0 {
		targetVer = d.LatestVersion
	}
	var found *DeliverableVersion
	for i := range d.Versions {
		if d.Versions[i].Version == targetVer {
			cp := cloneDeliverableVersion(d.Versions[i])
			found = &cp
			break
		}
	}
	s.mu.RUnlock()

	if found == nil {
		return DeliverableVersion{}, nil, fmt.Errorf("%w: deliverable %q version %d", ErrVersionNotFound, id, targetVer)
	}
	bytes, err := s.cas.Get(found.HTMLSHA256)
	if err != nil {
		return DeliverableVersion{}, nil, err
	}
	return *found, bytes, nil
}

// GetBySHA256 reads a compiled HTML deliverable directly by SHA-256 digest.
func (s *DeliverableStore) GetBySHA256(_ context.Context, digest string) ([]byte, error) {
	return s.cas.Get(digest)
}

// ListCards returns matching ArtifactCardView summaries ordered newest-first (or insertion order reversed).
func (s *DeliverableStore) ListCards(_ context.Context, filter DeliverableFilter) []contract.ArtifactCardView {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := make([]contract.ArtifactCardView, 0, len(s.order))
	for i := len(s.order) - 1; i >= 0; i-- {
		d := s.items[s.order[i]]
		if d == nil {
			continue
		}
		if filter.ChannelID != "" && d.ChannelID != filter.ChannelID {
			continue
		}
		if filter.IssueID != "" && d.IssueID != filter.IssueID {
			continue
		}
		if filter.Display != "" && d.Display != filter.Display {
			continue
		}
		out = append(out, d.Card)
	}
	return out
}

// DiffVersions computes exact line-level unified diffs via gotextdiff across two versions of a deliverable.
func (s *DeliverableStore) DiffVersions(ctx context.Context, id string, fromVersion, toVersion int) (VersionDiff, error) {
	fromVer, fromHTML, err := s.GetVersion(ctx, id, fromVersion)
	if err != nil {
		return VersionDiff{}, err
	}
	toVer, toHTML, err := s.GetVersion(ctx, id, toVersion)
	if err != nil {
		return VersionDiff{}, err
	}

	fromLabel := fmt.Sprintf("v%d/bundle.html", fromVer.Version)
	toLabel := fmt.Sprintf("v%d/bundle.html", toVer.Version)
	htmlDiff := DiffText(fromLabel, toLabel, string(fromHTML), string(toHTML))

	pathSet := make(map[string]struct{}, len(fromVer.FileSHAs)+len(toVer.FileSHAs))
	for p := range fromVer.FileSHAs {
		pathSet[p] = struct{}{}
	}
	for p := range toVer.FileSHAs {
		pathSet[p] = struct{}{}
	}
	paths := make([]string, 0, len(pathSet))
	for p := range pathSet {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	hasChanges := !htmlDiff.Equal
	fileDiffs := make([]FileDiff, 0, len(paths))
	for _, p := range paths {
		fromSHA := fromVer.FileSHAs[p]
		toSHA := toVer.FileSHAs[p]
		var beforeStr, afterStr string
		if fromSHA != "" {
			raw, err := s.cas.Get(fromSHA)
			if err != nil {
				return VersionDiff{}, err
			}
			beforeStr = string(raw)
		}
		if toSHA != "" {
			raw, err := s.cas.Get(toSHA)
			if err != nil {
				return VersionDiff{}, err
			}
			afterStr = string(raw)
		}

		status := "modified"
		switch {
		case fromSHA == "":
			status = "added"
		case toSHA == "":
			status = "deleted"
		case fromSHA == toSHA:
			status = "unchanged"
		}
		td := DiffText(fmt.Sprintf("v%d/%s", fromVer.Version, p), fmt.Sprintf("v%d/%s", toVer.Version, p), beforeStr, afterStr)
		if !td.Equal {
			hasChanges = true
		}
		fileDiffs = append(fileDiffs, FileDiff{
			Path:       p,
			Status:     status,
			FromSHA256: fromSHA,
			ToSHA256:   toSHA,
			Diff:       td,
		})
	}

	return VersionDiff{
		ArtifactID:  id,
		FromVersion: fromVer.Version,
		ToVersion:   toVer.Version,
		HTMLDiff:    htmlDiff,
		FileDiffs:   fileDiffs,
		HasChanges:  hasChanges,
	}, nil
}

func (s *DeliverableStore) saveDeliverableMetadata(d *Deliverable) error {
	if s.dir == "" {
		return nil
	}
	raw, err := json.Marshal(d)
	if err != nil {
		return err
	}
	safeName := hex.EncodeToString([]byte(d.ID))
	target := filepath.Join(s.dir, "deliverables", safeName+".json")
	return writeFileAtomic(target, raw, 0o644)
}

func (s *DeliverableStore) loadFromDisk() error {
	dir := filepath.Join(s.dir, "deliverables")
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read deliverables dir: %w", err)
	}
	var loaded []*Deliverable
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") || strings.HasPrefix(entry.Name(), ".tmp-") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			return err
		}
		var d Deliverable
		if err := json.Unmarshal(raw, &d); err != nil {
			return err
		}
		loaded = append(loaded, &d)
	}
	sort.Slice(loaded, func(i, j int) bool {
		if loaded[i].CreatedAtMs != loaded[j].CreatedAtMs {
			return loaded[i].CreatedAtMs < loaded[j].CreatedAtMs
		}
		return loaded[i].ID < loaded[j].ID
	})
	for _, d := range loaded {
		s.items[d.ID] = d
		s.order = append(s.order, d.ID)
	}
	return nil
}

func cloneDeliverable(d Deliverable) Deliverable {
	out := d
	out.Versions = make([]DeliverableVersion, len(d.Versions))
	for i, v := range d.Versions {
		out.Versions[i] = cloneDeliverableVersion(v)
	}
	return out
}

func cloneDeliverableVersion(v DeliverableVersion) DeliverableVersion {
	out := v
	if v.FileSHAs != nil {
		out.FileSHAs = make(map[string]string, len(v.FileSHAs))
		for k, val := range v.FileSHAs {
			out.FileSHAs[k] = val
		}
	}
	return out
}

var (
	forbiddenFrameTagRe = regexp.MustCompile(`(?is)<\s*(iframe|frame|frameset|object|embed|portal|fencedframe)\b`)
	baseHrefTagRe       = regexp.MustCompile(`(?is)<\s*base\b[^>]*\bhref\s*=`)
	metaRefreshTagRe    = regexp.MustCompile(`(?is)<\s*meta\b[^>]*\bhttp-equiv\s*=\s*["']?\s*refresh\b`)
	externalScriptRe    = regexp.MustCompile(`(?is)<\s*script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`)
	externalFormRe      = regexp.MustCompile(`(?is)<\s*(?:form|button|input)\b[^>]*\b(?:form)?action\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`)
)

// CheckHTMLPolicy performs static security validation on raw HTML deliverables before persistence.
func CheckHTMLPolicy(source string) []Diagnostic {
	var diags []Diagnostic

	addAt := func(offset int, msg string) {
		line, col := lineColAt(source, offset)
		diags = append(diags, Diagnostic{
			File:    "index.html",
			Line:    line,
			Column:  col,
			Message: msg,
		})
	}

	for _, loc := range forbiddenFrameTagRe.FindAllStringSubmatchIndex(source, -1) {
		tag := strings.ToLower(source[loc[2]:loc[3]])
		addAt(loc[0], fmt.Sprintf("disallowed embedded frame tag <%s>", tag))
	}
	for _, loc := range baseHrefTagRe.FindAllStringIndex(source, -1) {
		addAt(loc[0], "disallowed <base href> element")
	}
	for _, loc := range metaRefreshTagRe.FindAllStringIndex(source, -1) {
		addAt(loc[0], "disallowed <meta http-equiv=\"refresh\"> redirect")
	}
	for _, m := range externalScriptRe.FindAllStringSubmatchIndex(source, -1) {
		url := firstMatch(source, m, 2)
		if !isInlineOrHashURL(url) {
			addAt(m[0], fmt.Sprintf("disallowed external script src %q under isolated preview CSP", url))
		}
	}
	for _, m := range externalFormRe.FindAllStringSubmatchIndex(source, -1) {
		action := firstMatch(source, m, 2)
		trimmed := strings.TrimSpace(action)
		if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			addAt(m[0], fmt.Sprintf("disallowed form action %q", trimmed))
		}
	}

	sort.Slice(diags, func(i, j int) bool {
		if diags[i].Line != diags[j].Line {
			return diags[i].Line < diags[j].Line
		}
		return diags[i].Column < diags[j].Column
	})
	return diags
}

func firstMatch(s string, indices []int, groupStart int) string {
	for i := groupStart; i+1 < len(indices); i += 2 {
		if indices[i] >= 0 && indices[i+1] >= indices[i] {
			return s[indices[i]:indices[i+1]]
		}
	}
	return ""
}

func isInlineOrHashURL(raw string) bool {
	u := strings.ToLower(strings.TrimSpace(raw))
	return u == "" || strings.HasPrefix(u, "#") || strings.HasPrefix(u, "data:") || strings.HasPrefix(u, "blob:")
}

func lineColAt(s string, offset int) (line, col int) {
	if offset < 0 {
		offset = 0
	}
	if offset > len(s) {
		offset = len(s)
	}
	prefix := s[:offset]
	line = strings.Count(prefix, "\n") + 1
	lastNL := strings.LastIndexByte(prefix, '\n')
	if lastNL < 0 {
		col = len(prefix) + 1
	} else {
		col = len(prefix) - lastNL
	}
	return line, col
}

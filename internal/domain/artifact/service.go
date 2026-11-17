package artifact

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

// ServiceConfig configures the unified Artifact domain service (CAS, block pages, deliverables, and preview HTTP handler).
type ServiceConfig struct {
	Dir                 string
	Now                 func() int64
	MaxDeliverableBytes int64
	PreviewHost         string
	WorkbenchHosts      []string
	AllowWorkbenchEmbed bool
}

// Service bundles SHA-256 content-addressed block documents, versioned deliverables, and isolated HTTP preview.
type Service struct {
	CAS          *ContentStore
	Pages        *PageStore
	Deliverables *DeliverableStore
	Preview      *PreviewHandler
}

// NewService constructs a unified artifact domain Service sharing a single ContentStore.
func NewService(cfg ServiceConfig) (*Service, error) {
	var cas *ContentStore
	if strings.TrimSpace(cfg.Dir) != "" {
		var err error
		cas, err = NewDirCAS(cfg.Dir)
		if err != nil {
			return nil, err
		}
	} else {
		cas = NewMemoryCAS()
	}

	pages, err := NewPageStore(PageStoreConfig{
		CAS: cas,
		Dir: cfg.Dir,
		Now: cfg.Now,
	})
	if err != nil {
		return nil, err
	}

	deliverables, err := NewDeliverableStore(DeliverableStoreConfig{
		CAS:      cas,
		Dir:      cfg.Dir,
		MaxBytes: cfg.MaxDeliverableBytes,
		Now:      cfg.Now,
	})
	if err != nil {
		return nil, err
	}

	preview := NewPreviewHandler(PreviewConfig{
		Store:               deliverables,
		CAS:                 cas,
		PreviewHost:         cfg.PreviewHost,
		WorkbenchHosts:      cfg.WorkbenchHosts,
		AllowWorkbenchEmbed: cfg.AllowWorkbenchEmbed,
	})

	return &Service{
		CAS:          cas,
		Pages:        pages,
		Deliverables: deliverables,
		Preview:      preview,
	}, nil
}

// PublishToolInput represents the JSON tool payload emitted by durable agents publishing artifacts.
type PublishToolInput struct {
	ID        string            `json:"id,omitempty"`
	Title     string            `json:"title,omitempty"`
	Display   string            `json:"display,omitempty"`
	ChannelID string            `json:"channelId,omitempty"`
	IssueID   string            `json:"issueId,omitempty"`
	Note      string            `json:"note,omitempty"`
	Author    string            `json:"author,omitempty"`
	Entry     string            `json:"entry,omitempty"`
	Files     map[string]string `json:"files,omitempty"`
	RawHTML   string            `json:"rawHtml,omitempty"`
	Minify    bool              `json:"minify,omitempty"`
}

// ExecutePublishTool compiles/validates and publishes an artifact from JSON tool args.
// On compilation or HTML policy errors, nothing is persisted and a typed *CompileError is returned
// so durable feeds structured file:line:column diagnostics back into the same-turn agent loop.
func (s *Service) ExecutePublishTool(ctx context.Context, rawArgs json.RawMessage) (json.RawMessage, error) {
	var in PublishToolInput
	if err := json.Unmarshal(rawArgs, &in); err != nil {
		return nil, fmt.Errorf("%w: decode publish tool args: %v", ErrInvalidBundle, err)
	}

	req := PublishRequest{
		ID:        in.ID,
		Title:     in.Title,
		ChannelID: in.ChannelID,
		IssueID:   in.IssueID,
		Note:      in.Note,
		Author:    in.Author,
		RawHTML:   in.RawHTML,
	}
	if len(in.Files) > 0 || in.Entry != "" {
		req.Bundle = &CompileRequest{
			Entry:  in.Entry,
			Files:  in.Files,
			Title:  in.Title,
			Minify: in.Minify,
		}
	}
	if in.Display != "" {
		mode, err := parseDisplayMode(in.Display)
		if err != nil {
			return nil, err
		}
		req.Display = mode
	}

	res, err := s.Deliverables.Publish(ctx, req)
	if err != nil {
		return nil, err
	}

	out := struct {
		Card             any    `json:"card"`
		Version          int    `json:"version"`
		SHA256           string `json:"sha256"`
		PreviewPath      string `json:"previewPath"`
		SHA256Path       string `json:"sha256Path"`
		BlobDeduplicated bool   `json:"blobDeduplicated"`
		CompileMs        int64  `json:"compileMs"`
	}{
		Card:             res.Card,
		Version:          res.Version.Version,
		SHA256:           res.Version.HTMLSHA256,
		PreviewPath:      ArtifactVersionPreviewPath(res.Deliverable.ID, res.Version.Version),
		SHA256Path:       SHA256PreviewPath(res.Version.HTMLSHA256),
		BlobDeduplicated: res.BlobDeduplicated,
		CompileMs:        res.CompileMs,
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return nil, err
	}
	return raw, nil
}

func parseDisplayMode(raw string) (contract.ArtifactDisplayMode, error) {
	m := contract.ArtifactDisplayMode(strings.TrimSpace(raw))
	if !IsValidDisplayMode(m) {
		return "", fmt.Errorf("%w: %q", ErrInvalidDisplayMode, raw)
	}
	return m, nil
}

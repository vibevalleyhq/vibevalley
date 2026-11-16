package pkm

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path"
	"strings"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

var (
	// ErrNotFound is returned when a requested note or block does not exist in the store.
	ErrNotFound = errors.New("pkm: not found")
	// ErrInvalidPath is returned when a note path escapes the vault or is malformed.
	ErrInvalidPath = errors.New("pkm: invalid path")
	// ErrInvalidArgument is returned when a caller passes an empty or malformed query/input.
	ErrInvalidArgument = errors.New("pkm: invalid argument")
	// ErrClosed is returned when operations are invoked on a closed Store.
	ErrClosed = errors.New("pkm: store closed")
)

// Tier classifies a PARA knowledge vault note by its folder hierarchy.
type Tier string

const (
	TierInbox    Tier = "inbox"
	TierProject  Tier = "project"
	TierArea     Tier = "area"
	TierResource Tier = "resource"
	TierArchive  Tier = "archive"
	TierJournal  Tier = "journal"
)

// LinkKind identifies which PKM link construct produced a BacklinkView span.
type LinkKind string

const (
	KindWikiLink LinkKind = "wikilink"
	KindBlockRef LinkKind = "block_ref"
	KindEmbed    LinkKind = "embed"
	KindTag      LinkKind = "tag"
)

var tierFolders = map[Tier]string{
	TierInbox:    "00_Inbox",
	TierProject:  "01_Projects",
	TierArea:     "02_Areas",
	TierResource: "03_Resources",
	TierArchive:  "04_Archives",
	TierJournal:  "journals",
}

var tierWeights = map[Tier]float64{
	TierProject:  2.0,
	TierArea:     1.5,
	TierJournal:  1.4,
	TierResource: 1.2,
	TierInbox:    1.0,
	TierArchive:  0.5,
}

var folderToTier = map[string]Tier{
	"00_inbox":     TierInbox,
	"inbox":        TierInbox,
	"01_projects":  TierProject,
	"projects":     TierProject,
	"02_areas":     TierArea,
	"areas":        TierArea,
	"03_resources": TierResource,
	"resources":    TierResource,
	"04_archives":  TierArchive,
	"archives":     TierArchive,
	"journals":     TierJournal,
	"journal":      TierJournal,
}

// FolderForTier returns the canonical PARA vault folder name for tier.
func FolderForTier(tier Tier) string {
	if f, ok := tierFolders[tier]; ok {
		return f
	}
	return tierFolders[TierInbox]
}

// TierWeight returns the search ranking multiplier for tier (active projects highest, archives lowest).
func TierWeight(tier Tier) float64 {
	if w, ok := tierWeights[tier]; ok {
		return w
	}
	return 1.0
}

// TierOfPath maps a vault-relative Markdown path to its PARA tier.
func TierOfPath(relPath string) Tier {
	clean := normalizeRelSlash(relPath)
	if clean == "" {
		return TierInbox
	}
	first, _, _ := strings.Cut(clean, "/")
	if tier, ok := folderToTier[strings.ToLower(first)]; ok {
		return tier
	}
	return TierInbox
}

// IsVaultMarkdownPath reports whether relPath is a user knowledge Markdown file inside the PARA vault.
// Internal snapshot/metadata directories such as .pkm, .vibe, and .git are excluded.
func IsVaultMarkdownPath(relPath string) bool {
	clean := normalizeRelSlash(relPath)
	if clean == "" || !strings.HasSuffix(strings.ToLower(clean), ".md") {
		return false
	}
	for seg := range strings.SplitSeq(clean, "/") {
		if seg == "" || strings.HasPrefix(seg, ".") {
			return false
		}
	}
	return true
}

// SlugOf normalizes a note title or tag name into its canonical slug identifier.
func SlugOf(title string) string {
	trimmed := strings.TrimSpace(title)
	if trimmed == "" {
		return ""
	}
	trimmed = strings.ReplaceAll(trimmed, "\\", "/")
	trimmed = strings.ReplaceAll(trimmed, "/", "__")
	fields := strings.Fields(trimmed)
	return strings.ToLower(strings.Join(fields, "-"))
}

// TitleOfPath derives a note title from its vault-relative file path.
func TitleOfPath(relPath string) string {
	clean := normalizeRelSlash(relPath)
	base := path.Base(clean)
	if base == "." || base == "/" {
		return ""
	}
	if strings.HasSuffix(strings.ToLower(base), ".md") {
		base = base[:len(base)-3]
	}
	return strings.ReplaceAll(base, "__", "/")
}

// Frontmatter captures YAML, TOML, or Logseq page-level metadata extracted from a note.
type Frontmatter struct {
	Format   string         `json:"format,omitempty"`
	Title    string         `json:"title,omitempty"`
	Aliases  []string       `json:"aliases,omitempty"`
	Tags     []string       `json:"tags,omitempty"`
	Tier     string         `json:"tier,omitempty"`
	Status   string         `json:"status,omitempty"`
	Area     string         `json:"area,omitempty"`
	Deadline string         `json:"deadline,omitempty"`
	TLDR     string         `json:"tldr,omitempty"`
	Raw      map[string]any `json:"raw,omitempty"`
}

// BlockDef records an addressable `id:: <blockId>` outline block inside a note.
type BlockDef struct {
	ID        string `json:"id"`
	Body      string `json:"body"`
	Line      int    `json:"line"`
	ByteStart int    `json:"byteStart"`
	ByteEnd   int    `json:"byteEnd"`
}

// LinkSpan pairs a parsed AST/CST inline reference with its contract.BacklinkView projection.
type LinkSpan struct {
	Kind          LinkKind              `json:"kind"`
	Raw           string                `json:"raw"`
	TargetSlug    string                `json:"targetSlug,omitempty"`
	Alias         string                `json:"alias,omitempty"`
	Heading       string                `json:"heading,omitempty"`
	SourceBlockID string                `json:"sourceBlockId,omitempty"`
	Backlink      contract.BacklinkView `json:"backlink"`
}

// Note represents a parsed PARA Markdown note with exact AST/CST link spans and metadata.
type Note struct {
	RelPath     string      `json:"relPath"`
	Title       string      `json:"title"`
	Slug        string      `json:"slug"`
	Tier        Tier        `json:"tier"`
	Frontmatter Frontmatter `json:"frontmatter"`
	Body        string      `json:"body"`
	Source      []byte      `json:"-"`
	SHA256      string      `json:"sha256"`
	Links       []LinkSpan  `json:"links,omitempty"`
	Blocks      []BlockDef  `json:"blocks,omitempty"`
	Tags        []string    `json:"tags,omitempty"`
	UpdatedAtMs int64       `json:"updatedAtMs"`
}

// BacklinkViews returns the note's forward link spans projected as contract.BacklinkView slices.
func (n Note) BacklinkViews() []contract.BacklinkView {
	out := make([]contract.BacklinkView, len(n.Links))
	for i, l := range n.Links {
		out[i] = l.Backlink
	}
	return out
}

// NoteInput supplies a raw Markdown note and optional embedding vector for indexing.
type NoteInput struct {
	RelPath     string
	Content     []byte
	Embedding   []float32
	UpdatedAtMs int64
}

// SearchQuery configures hybrid FTS5 trigram + sqlite-vec cosine + RRF search.
type SearchQuery struct {
	Text         string
	QueryVector  []float32
	Tier         Tier
	Tag          string
	LinkedTo     string
	Limit        int
	FTSWeight    float64
	VectorWeight float64
	RRFK         float64
}

// SearchHit reports a ranked hybrid search match combining FTS5 trigram and cosine similarity.
type SearchHit struct {
	RelPath       string   `json:"relPath"`
	Title         string   `json:"title"`
	Slug          string   `json:"slug"`
	Tier          Tier     `json:"tier"`
	Score         float64  `json:"score"`
	FTSScore      float64  `json:"ftsScore"`
	FTSRank       int      `json:"ftsRank,omitempty"`
	VectorScore   float64  `json:"vectorScore"`
	VectorRank    int      `json:"vectorRank,omitempty"`
	Snippet       string   `json:"snippet"`
	Tags          []string `json:"tags,omitempty"`
	BacklinkCount int      `json:"backlinkCount"`
}

// SyncStats summarizes an incremental or full directory index synchronization pass.
type SyncStats struct {
	Indexed   int `json:"indexed"`
	Unchanged int `json:"unchanged"`
	Deleted   int `json:"deleted"`
}

// Embedder optionally computes dense embeddings for notes during directory synchronization.
type Embedder interface {
	Embed(text string) ([]float32, error)
}

// EmbedderFunc adapts a function to Embedder.
type EmbedderFunc func(text string) ([]float32, error)

// Embed delegates to f.
func (f EmbedderFunc) Embed(text string) ([]float32, error) {
	return f(text)
}

func normalizeRelSlash(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || strings.ContainsRune(trimmed, 0) {
		return ""
	}
	slash := strings.ReplaceAll(trimmed, "\\", "/")
	if strings.HasPrefix(slash, "/") {
		return ""
	}
	cleaned := path.Clean(slash)
	cleaned = strings.TrimPrefix(cleaned, "./")
	if cleaned == "" || cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return ""
	}
	return cleaned
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

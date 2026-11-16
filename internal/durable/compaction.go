package durable

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

// CompactionLevel identifies the four context compaction triggers.
type CompactionLevel string

const (
	CompactionManual   CompactionLevel = "manual"
	CompactionSoft     CompactionLevel = "soft"
	CompactionHard     CompactionLevel = "hard"
	CompactionOverflow CompactionLevel = "overflow"
)

// ToolSpec defines a tool advertised to the model.
type ToolSpec struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	IsMCP       bool           `json:"isMcp,omitempty"`
	InputSchema map[string]any `json:"inputSchema,omitempty"`
}

// ToolCall describes a tool invocation requested by the model.
type ToolCall struct {
	ID       string          `json:"id"`
	ToolName string          `json:"toolName"`
	IsMCP    bool            `json:"isMcp,omitempty"`
	ArgsJSON json.RawMessage `json:"argsJson"`
}

// TranscriptEntry is a model-visible entry ordered for prompt prefix cache stability.
type TranscriptEntry struct {
	Seq         int64           `json:"seq"`
	Kind        string          `json:"kind"`
	PayloadJSON json.RawMessage `json:"payloadJson"`
}

// Transcript holds the ordered prompt messages and fixed provider_affinity for a model request.
type Transcript struct {
	ConversationID   string            `json:"conversationId"`
	ProviderAffinity string            `json:"providerAffinity"`
	Entries          []TranscriptEntry `json:"entries"`
	PrefixHash       string            `json:"prefixHash"`
}

// ModelRequest is the narrow interface payload sent to a ModelClient.
type ModelRequest struct {
	ConversationID   string     `json:"conversationId"`
	ProviderAffinity string     `json:"providerAffinity"`
	Transcript       Transcript `json:"transcript"`
	Tools            []ToolSpec `json:"tools,omitempty"`
	ReadOnly         bool       `json:"readOnly,omitempty"`
}

// ModelResponse is returned by a ModelClient for a single generation turn.
type ModelResponse struct {
	Text      string                `json:"text,omitempty"`
	ToolCalls []ToolCall            `json:"toolCalls,omitempty"`
	Usage     *contract.UsageTotals `json:"usage,omitempty"`
	Streamed  []string              `json:"streamed,omitempty"`
}

// ModelClient abstracts underlying LLM SDK calls (Anthropic / OpenAI / Gemini / test mocks).
type ModelClient interface {
	Generate(ctx context.Context, req ModelRequest, onDelta func(chunk string)) (ModelResponse, error)
}

// Summarizer produces a compact summary string for a contiguous range of entries.
type Summarizer interface {
	Summarize(ctx context.Context, level CompactionLevel, entries []store.Entry) (summary string, tokenCount int64, err error)
}

// SummarizerFunc adapts a function to Summarizer.
type SummarizerFunc func(ctx context.Context, level CompactionLevel, entries []store.Entry) (string, int64, error)

func (f SummarizerFunc) Summarize(ctx context.Context, level CompactionLevel, entries []store.Entry) (string, int64, error) {
	return f(ctx, level, entries)
}

// CompactionThresholds configures soft (background), hard (blocking), and overflow token budgets.
type CompactionThresholds struct {
	SoftTokens        int
	HardTokens        int
	KeepRecentEntries int
}

// DefaultCompactionThresholds mirrors pi-durable's 120k hard fold and 32k earlier soft fold.
func DefaultCompactionThresholds() CompactionThresholds {
	return CompactionThresholds{
		SoftTokens:        88_000,
		HardTokens:        120_000,
		KeepRecentEntries: 4,
	}
}

// BuildTranscript loads visible entries for conversationID, preserving provider_affinity,
// parent fork prefix, pi.compaction / pi.reset boundaries, and tail-only pi.system additions.
func BuildTranscript(ctx context.Context, st *store.Store, conversationID string) (Transcript, error) {
	conv, err := st.GetConversation(ctx, conversationID)
	if err != nil {
		return Transcript{}, err
	}
	vis, err := st.GetVisibleEntries(ctx, conversationID)
	if err != nil {
		return Transcript{}, err
	}
	entries := make([]TranscriptEntry, len(vis))
	for i, e := range vis {
		entries[i] = TranscriptEntry{
			Seq:         e.Seq,
			Kind:        e.Kind,
			PayloadJSON: json.RawMessage(e.PayloadJSON),
		}
	}
	return Transcript{
		ConversationID:   conv.ID,
		ProviderAffinity: conv.ProviderAffinity,
		Entries:          entries,
		PrefixHash:       hashTranscriptEntries(entries),
	}, nil
}

// AppendSystemDelta appends an incremental pi.system instruction/tool change strictly at the
// conversation tail without altering any preceding prefix entries, preserving provider prefix cache.
func AppendSystemDelta(ctx context.Context, st *store.Store, conversationID string, text string, tools []ToolSpec) (store.Entry, error) {
	payload := map[string]any{
		"text":  text,
		"delta": true,
	}
	if len(tools) > 0 {
		payload["tools"] = tools
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return store.Entry{}, err
	}
	return st.AppendEntry(ctx, conversationID, store.EntrySystem, raw)
}

// EstimateEntriesTokens provides a deterministic fast token estimate (approx 1 token / 4 bytes + overhead)
// unless explicit token metadata is embedded in payloads.
func EstimateEntriesTokens(entries []store.Entry) int {
	total := 0
	for _, e := range entries {
		total += 16 + (len(e.PayloadJSON)+3)/4
	}
	return total
}

// Compactor manages 4-level context compaction (manual, soft background, hard blocking, overflow retry)
// and drops concurrent summaries that fall behind a newer cutpoint or reset as stale.
type Compactor struct {
	st         *store.Store
	summarizer Summarizer
	thresholds CompactionThresholds

	bgMu     sync.Mutex
	inFlight map[string]bool
	wg       sync.WaitGroup
}

// NewCompactor constructs a Compactor over st using summarizer (or a deterministic fallback summarizer if nil).
func NewCompactor(st *store.Store, summarizer Summarizer, thresholds CompactionThresholds) *Compactor {
	if thresholds.SoftTokens <= 0 {
		thresholds.SoftTokens = DefaultCompactionThresholds().SoftTokens
	}
	if thresholds.HardTokens <= 0 {
		thresholds.HardTokens = DefaultCompactionThresholds().HardTokens
	}
	if thresholds.KeepRecentEntries < 0 {
		thresholds.KeepRecentEntries = 0
	}
	if summarizer == nil {
		summarizer = SummarizerFunc(defaultDeterministicSummarize)
	}
	return &Compactor{
		st:         st,
		summarizer: summarizer,
		thresholds: thresholds,
		inFlight:   make(map[string]bool),
	}
}

// Compact performs compaction at the requested level.
// For CompactionSoft/Hard/Manual/Overflow, it determines the cutpoint, invokes Summarizer outside
// the store write lock (allowing concurrent turns/compactions), and commits atomically via
// store.CommitCompaction — discarding stale concurrent summaries automatically.
func (c *Compactor) Compact(ctx context.Context, conversationID string, level CompactionLevel, explicitCutSeq int64) (store.CompactionOutcome, error) {
	conv, err := c.st.GetConversation(ctx, conversationID)
	if err != nil {
		return store.CompactionOutcome{}, err
	}
	vis, err := c.st.GetVisibleEntries(ctx, conversationID)
	if err != nil {
		return store.CompactionOutcome{}, err
	}
	if len(vis) == 0 {
		return store.CompactionOutcome{Applied: false}, nil
	}

	cutSeq := explicitCutSeq
	if cutSeq <= 0 {
		keep := c.thresholds.KeepRecentEntries
		if level == CompactionOverflow {
			// Overflow retries aggressively compact down to at most the final entry.
			keep = min(keep, 1)
		}
		if len(vis) <= keep {
			return store.CompactionOutcome{Applied: false}, nil
		}
		cutIdx := len(vis) - keep - 1
		if cutIdx < 0 {
			return store.CompactionOutcome{Applied: false}, nil
		}
		cutSeq = vis[cutIdx].Seq
	}

	var toSummarize []store.Entry
	for _, e := range vis {
		if e.Seq <= cutSeq {
			toSummarize = append(toSummarize, e)
		}
	}
	if len(toSummarize) == 0 {
		return store.CompactionOutcome{Applied: false}, nil
	}

	summary, tokCount, err := c.summarizer.Summarize(ctx, level, toSummarize)
	if err != nil {
		return store.CompactionOutcome{}, err
	}
	if tokCount <= 0 {
		tokCount = int64((len(summary) + 3) / 4)
	}

	return c.st.CommitCompaction(ctx, store.CompactionCommit{
		ConversationID: conversationID,
		Level:          string(level),
		BaseHeadSeq:    conv.HeadSeq,
		FromSeq:        toSummarize[0].Seq,
		CutSeq:         cutSeq,
		Summary:        summary,
		TokenCount:     tokCount,
	})
}

// MaybeCompactBeforeGenerate enforces hard blocking compaction if tokens >= HardTokens,
// and triggers asynchronous non-blocking soft compaction if tokens >= SoftTokens.
func (c *Compactor) MaybeCompactBeforeGenerate(ctx context.Context, conversationID string) (hardCompacted bool, err error) {
	vis, err := c.st.GetVisibleEntries(ctx, conversationID)
	if err != nil {
		return false, err
	}
	tokens := EstimateEntriesTokens(vis)
	if tokens >= c.thresholds.HardTokens {
		res, err := c.Compact(ctx, conversationID, CompactionHard, 0)
		return res.Applied, err
	}
	if tokens >= c.thresholds.SoftTokens {
		c.TriggerBackgroundSoft(conversationID)
	}
	return false, nil
}

// TriggerBackgroundSoft starts an asynchronous soft compaction if one isn't already running for conversationID.
func (c *Compactor) TriggerBackgroundSoft(conversationID string) {
	c.bgMu.Lock()
	if c.inFlight[conversationID] {
		c.bgMu.Unlock()
		return
	}
	c.inFlight[conversationID] = true
	c.wg.Add(1)
	c.bgMu.Unlock()

	go func() {
		defer func() {
			c.bgMu.Lock()
			delete(c.inFlight, conversationID)
			c.bgMu.Unlock()
			c.wg.Done()
		}()
		_, _ = c.Compact(context.Background(), conversationID, CompactionSoft, 0)
	}()
}

// WaitBackground waits for any in-flight soft compactions to finish (useful in tests and shutdown).
func (c *Compactor) WaitBackground() {
	c.wg.Wait()
}

func defaultDeterministicSummarize(_ context.Context, level CompactionLevel, entries []store.Entry) (string, int64, error) {
	var b strings.Builder
	fmt.Fprintf(&b, "[compaction:%s seq=%d..%d]", level, entries[0].Seq, entries[len(entries)-1].Seq)
	for _, e := range entries {
		fmt.Fprintf(&b, "\n%d:%s=%s", e.Seq, e.Kind, string(e.PayloadJSON))
	}
	out := b.String()
	return out, int64((len(out) + 3) / 4), nil
}

func hashTranscriptEntries(entries []TranscriptEntry) string {
	h := sha256.New()
	for _, e := range entries {
		_, _ = fmt.Fprintf(h, "%d|%s|%s\n", e.Seq, e.Kind, string(e.PayloadJSON))
	}
	return hex.EncodeToString(h.Sum(nil))
}

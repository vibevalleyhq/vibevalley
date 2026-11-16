package pkm

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/viant/sqlite-vec/engine"
	"github.com/viant/sqlite-vec/vec"
	"github.com/viant/sqlite-vec/vector"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

func lineNumberInSource(src []byte, offset int) int {
	return 1 + bytes.Count(src[:offset], []byte{'\n'})
}

func TestParserYAMLAndTOMLFrontmatterAndExactByteSpans(t *testing.T) {
	t.Parallel()

	yamlSrc := []byte(strings.Join([]string{
		"---",
		"title: 核心引擎架构设计",
		"aliases: [CoreEngine, 核心架构]",
		"tags: [\"#architecture\", 知识图谱]",
		"status: active",
		"tldr: 纯 Go 增量解析器与双链图谱设计",
		"---",
		"",
		"# 第一章 [[项目概览|概览]] #中文标签",
		"",
		"- 任务：实现 [[Parser Core#Inline]] 与 ![[嵌入模板]]",
		"  id:: blk-yaml-01",
		"  - 子项引用 ((aaaaaaaa-0000-4000-a000-000000000001)) 以及 ![[((blk-embed-99))]] #go/v1-beta",
		"> 引用段落里的中文后接标签：中文#紧贴标签 和 [[引用页]]",
		"",
		"| 模块 | 链接 |",
		"|---|---|",
		"| PKM | [[表格链接]] #table-tag |",
		"",
		"不应匹配的噪声：C# issue#12 &#123; [md](https://example.com/#frag) `[[代码跨度]] #not-tag` \\[[转义]] \\#转义",
		"```go",
		"var s = \"[[代码块内]] ((11111111-1111-1111-1111-111111111111)) #ignored\"",
		"```",
		"",
	}, "\n"))

	note, err := ParseNote("01_Projects/核心引擎.md", yamlSrc)
	if err != nil {
		t.Fatalf("ParseNote yaml: %v", err)
	}
	if note.Tier != TierProject {
		t.Fatalf("expected TierProject, got %q", note.Tier)
	}
	if note.Frontmatter.Format != "yaml" || note.Title != "核心引擎架构设计" {
		t.Fatalf("unexpected yaml frontmatter/title: %+v title=%q", note.Frontmatter, note.Title)
	}
	if len(note.Frontmatter.Aliases) != 2 || note.Frontmatter.Aliases[0] != "CoreEngine" {
		t.Fatalf("unexpected aliases: %+v", note.Frontmatter.Aliases)
	}
	if len(note.Blocks) != 1 || note.Blocks[0].ID != "blk-yaml-01" {
		t.Fatalf("expected block blk-yaml-01, got %+v", note.Blocks)
	}

	type wantSpan struct {
		kind   LinkKind
		raw    string
		target string
		block  string
	}
	want := []wantSpan{
		{KindWikiLink, "[[项目概览|概览]]", "项目概览", ""},
		{KindTag, "#中文标签", "中文标签", ""},
		{KindWikiLink, "[[Parser Core#Inline]]", "Parser Core", ""},
		{KindEmbed, "![[嵌入模板]]", "嵌入模板", ""},
		{KindBlockRef, "((aaaaaaaa-0000-4000-a000-000000000001))", "", "aaaaaaaa-0000-4000-a000-000000000001"},
		{KindEmbed, "![[((blk-embed-99))]]", "", "blk-embed-99"},
		{KindTag, "#go/v1-beta", "go/v1-beta", ""},
		{KindTag, "#紧贴标签", "紧贴标签", ""},
		{KindWikiLink, "[[引用页]]", "引用页", ""},
		{KindWikiLink, "[[表格链接]]", "表格链接", ""},
		{KindTag, "#table-tag", "table-tag", ""},
	}
	if len(note.Links) != len(want) {
		t.Fatalf("expected %d links, got %d: %+v", len(want), len(note.Links), note.Links)
	}
	for i, w := range want {
		got := note.Links[i]
		bl := got.Backlink
		if got.Kind != w.kind {
			t.Fatalf("[%d] kind = %q, want %q", i, got.Kind, w.kind)
		}
		if bl.TargetTitle != w.target || bl.BlockID != w.block {
			t.Fatalf("[%d] target/block = (%q, %q), want (%q, %q)", i, bl.TargetTitle, bl.BlockID, w.target, w.block)
		}
		if bl.ByteStart < 0 || bl.ByteEnd > len(yamlSrc) || bl.ByteStart >= bl.ByteEnd {
			t.Fatalf("[%d] out-of-bounds span [%d:%d] for len=%d", i, bl.ByteStart, bl.ByteEnd, len(yamlSrc))
		}
		if slice := string(yamlSrc[bl.ByteStart:bl.ByteEnd]); slice != w.raw {
			t.Fatalf("[%d] source[%d:%d] = %q, want %q", i, bl.ByteStart, bl.ByteEnd, slice, w.raw)
		}
		if wantLine := lineNumberInSource(yamlSrc, bl.ByteStart); bl.Line != wantLine {
			t.Fatalf("[%d] line = %d, want %d", i, bl.Line, wantLine)
		}
		if !strings.Contains(bl.Snippet, w.raw) {
			t.Fatalf("[%d] snippet %q does not contain %q", i, bl.Snippet, w.raw)
		}
	}
	if note.Links[2].SourceBlockID != "blk-yaml-01" {
		t.Fatalf("expected enclosing block id blk-yaml-01, got %q", note.Links[2].SourceBlockID)
	}

	// TOML frontmatter + CRLF line endings must keep exact byte offsets.
	tomlSrc := []byte("+++\r\ntitle = \"TOML Note\"\r\ntags = [\"toml\", \"pkm\"]\r\npara = \"areas\"\r\n+++\r\n\r\n- Link [[Alpha]] and #beta\r\n")
	tomlNote, err := ParseNote("notes/toml-note.md", tomlSrc)
	if err != nil {
		t.Fatalf("ParseNote toml: %v", err)
	}
	if tomlNote.Frontmatter.Format != "toml" || tomlNote.Title != "TOML Note" || tomlNote.Tier != TierArea {
		t.Fatalf("unexpected toml note metadata: title=%q tier=%q fm=%+v", tomlNote.Title, tomlNote.Tier, tomlNote.Frontmatter)
	}
	if len(tomlNote.Links) != 2 {
		t.Fatalf("expected 2 links in toml note, got %d", len(tomlNote.Links))
	}
	for _, l := range tomlNote.Links {
		gotSlice := string(tomlSrc[l.Backlink.ByteStart:l.Backlink.ByteEnd])
		if gotSlice != l.Raw {
			t.Fatalf("CRLF byte span mismatch: got %q want %q", gotSlice, l.Raw)
		}
		if wantLine := lineNumberInSource(tomlSrc, l.Backlink.ByteStart); l.Backlink.Line != wantLine {
			t.Fatalf("CRLF line mismatch: got %d want %d", l.Backlink.Line, wantLine)
		}
	}
}

func TestGraphSSOTForwardAndBacklinks(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	store, err := OpenStore(ctx, ":memory:")
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	defer store.Close()

	cetusSrc := []byte("---\ntitle: Cetus Engine\naliases: [Whale]\n---\n- Core outline\n  id:: blk-cetus-1\n- See [[Roadmap]] #engine\n")
	roadmapSrc := []byte("- Build [[Whale]] and embed ![[Cetus Engine]]\n- Ref ((blk-cetus-1)) and ![[((blk-cetus-1))]]\n")
	journalSrc := []byte("- Reviewed [[Cetus Engine|Cetus]] #daily\n")

	if _, err := store.IndexBatch(ctx, []NoteInput{
		{RelPath: "01_Projects/Cetus-Engine.md", Content: cetusSrc, UpdatedAtMs: 100},
		{RelPath: "projects/roadmap.md", Content: roadmapSrc, UpdatedAtMs: 200},
		{RelPath: "journals/2026_11_16.md", Content: journalSrc, UpdatedAtMs: 300},
	}); err != nil {
		t.Fatalf("IndexBatch: %v", err)
	}

	// Forward links from roadmap should resolve ((blk-cetus-1)) TargetTitle -> "Cetus Engine".
	fwd, err := store.ForwardLinks(ctx, "projects/roadmap.md")
	if err != nil {
		t.Fatalf("ForwardLinks: %v", err)
	}
	if len(fwd) != 4 {
		t.Fatalf("expected 4 forward links from roadmap, got %d: %+v", len(fwd), fwd)
	}
	if fwd[2].BlockID != "blk-cetus-1" || fwd[2].TargetTitle != "Cetus Engine" {
		t.Fatalf("expected block-ref to resolve TargetTitle 'Cetus Engine', got %+v", fwd[2])
	}

	// Backlinks for Cetus Engine must include alias [[Whale]], ![[Cetus Engine]], ((blk-cetus-1)), ![[((blk-cetus-1))]], and journal [[Cetus Engine|Cetus]].
	bls, err := store.Backlinks(ctx, "Cetus Engine")
	if err != nil {
		t.Fatalf("Backlinks: %v", err)
	}
	if len(bls) != 5 {
		t.Fatalf("expected 5 backlinks to Cetus Engine, got %d: %+v", len(bls), bls)
	}

	// Querying by alias "Whale" must find the same Cetus Engine backlinks.
	aliasBls, err := store.Backlinks(ctx, "Whale")
	if err != nil {
		t.Fatalf("Backlinks by alias: %v", err)
	}
	if len(aliasBls) != len(bls) {
		t.Fatalf("alias backlink parity mismatch: got %d want %d", len(aliasBls), len(bls))
	}

	// Filtered BacklinksByKind (resolved page + unresolved target), GetNote, ResolveBlock, and Search LinkedTo/Tier/Tag filters.
	embedBls, err := store.BacklinksByKind(ctx, "Cetus Engine", KindEmbed)
	if err != nil || len(embedBls) != 2 {
		t.Fatalf("BacklinksByKind(Cetus Engine, KindEmbed): got %d (%+v) err=%v", len(embedBls), embedBls, err)
	}
	unresolvedBls, err := store.Backlinks(ctx, "Roadmap")
	if err != nil || len(unresolvedBls) != 1 {
		t.Fatalf("Backlinks(Roadmap): got %d (%+v) err=%v", len(unresolvedBls), unresolvedBls, err)
	}
	unresolvedWiki, err := store.BacklinksByKind(ctx, "Roadmap", KindWikiLink)
	if err != nil || len(unresolvedWiki) != 1 {
		t.Fatalf("BacklinksByKind(Roadmap, KindWikiLink): got %d (%+v) err=%v", len(unresolvedWiki), unresolvedWiki, err)
	}
	if gotNote, ok, err := store.GetNote(ctx, "Whale"); err != nil || ok {
		// GetNote looks up by path, slug, or title (not alias); verify title lookup works.
		t.Fatalf("GetNote(Whale): ok=%v note=%+v err=%v", ok, gotNote, err)
	}
	gotCetus, ok, err := store.GetNote(ctx, "Cetus Engine")
	if err != nil || !ok || gotCetus.RelPath != "01_Projects/Cetus-Engine.md" || len(gotCetus.Blocks) != 1 {
		t.Fatalf("GetNote(Cetus Engine): ok=%v note=%+v err=%v", ok, gotCetus, err)
	}
	blk, blkPath, blkOK, err := store.ResolveBlock(ctx, "blk-cetus-1")
	if err != nil || !blkOK || blkPath != "01_Projects/Cetus-Engine.md" || blk.ID != "blk-cetus-1" {
		t.Fatalf("ResolveBlock: blk=%+v path=%q ok=%v err=%v", blk, blkPath, blkOK, err)
	}
	linkedHits, err := store.Search(ctx, SearchQuery{LinkedTo: "Whale", Tier: TierJournal, Tag: "daily"})
	if err != nil || len(linkedHits) != 1 || linkedHits[0].RelPath != "journals/2026_11_16.md" {
		t.Fatalf("Search(LinkedTo=Whale, Tier=journal, Tag=daily): hits=%+v err=%v", linkedHits, err)
	}
	textLinkedHits, err := store.Search(ctx, SearchQuery{Text: "Cetus", LinkedTo: "Roadmap"})
	if err != nil || len(textLinkedHits) != 1 || textLinkedHits[0].RelPath != "01_Projects/Cetus-Engine.md" {
		t.Fatalf("Search(Text=Cetus, LinkedTo=Roadmap): hits=%+v err=%v", textLinkedHits, err)
	}

	// Block backlinks query.
	blkBls, err := store.BlockBacklinks(ctx, "blk-cetus-1")
	if err != nil {
		t.Fatalf("BlockBacklinks: %v", err)
	}
	if len(blkBls) != 2 {
		t.Fatalf("expected 2 block backlinks for blk-cetus-1, got %d", len(blkBls))
	}

	// Tag backlinks query (with and without '#').
	tagBls, err := store.TagBacklinks(ctx, "#engine")
	if err != nil {
		t.Fatalf("TagBacklinks: %v", err)
	}
	if len(tagBls) != 1 || tagBls[0].SourcePath != "01_Projects/Cetus-Engine.md" {
		t.Fatalf("unexpected tag backlinks: %+v", tagBls)
	}

	// Updating roadmap removes old links and updates graph cleanly.
	updatedRoadmap := []byte("- Replaced link [[AnotherPage]]\n")
	if _, err := store.UpsertNote(ctx, NoteInput{RelPath: "projects/roadmap.md", Content: updatedRoadmap, UpdatedAtMs: 400}); err != nil {
		t.Fatalf("UpsertNote: %v", err)
	}
	blsAfter, err := store.Backlinks(ctx, "Cetus Engine")
	if err != nil {
		t.Fatalf("Backlinks after update: %v", err)
	}
	if len(blsAfter) != 1 || blsAfter[0].SourcePath != "journals/2026_11_16.md" {
		t.Fatalf("expected only journal backlink after roadmap update, got %+v", blsAfter)
	}

	// Deleting journal removes its backlink.
	if err := store.DeleteNote(ctx, "journals/2026_11_16.md"); err != nil {
		t.Fatalf("DeleteNote: %v", err)
	}
	blsDeleted, err := store.Backlinks(ctx, "Cetus Engine")
	if err != nil {
		t.Fatalf("Backlinks after delete: %v", err)
	}
	if len(blsDeleted) != 0 {
		t.Fatalf("expected 0 backlinks after delete, got %+v", blsDeleted)
	}
}

func Test5000MixedCJKEnglishPARANotesAndBacklinkParity(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	store, err := OpenStore(ctx, ":memory:")
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	defer store.Close()

	const totalNotes = 5000
	folders := []string{"01_Projects", "02_Areas", "03_Resources", "04_Archives", "journals"}
	inputs := make([]NoteInput, totalNotes)
	sources := make(map[string][]byte, totalNotes)
	expectedForwardByPath := make(map[string][]contract.BacklinkView, totalNotes)
	expectedBacklinkCountByTarget := make(map[string]int)

	for i := range totalNotes {
		folder := folders[i%len(folders)]
		var relPath, title string
		if folder == "journals" {
			day := (i % 28) + 1
			month := ((i / 28) % 12) + 1
			relPath = fmt.Sprintf("journals/2026_%02d_%02d_%04d.md", month, day, i)
			title = fmt.Sprintf("日记-%04d", i)
		} else {
			relPath = fmt.Sprintf("%s/Note-%04d.md", folder, i)
			title = fmt.Sprintf("Note-%04d", i)
		}

		targetIdx := (i + 1) % totalNotes
		targetTitle := fmt.Sprintf("Note-%04d", targetIdx)
		if folders[targetIdx%len(folders)] == "journals" {
			targetTitle = fmt.Sprintf("日记-%04d", targetIdx)
		}
		blockTargetIdx := (i + 2) % totalNotes
		blockID := fmt.Sprintf("blk-%04d", blockTargetIdx)
		ownBlockID := fmt.Sprintf("blk-%04d", i)
		tag := fmt.Sprintf("topic-%02d", i%50)

		var content string
		if i%2 == 0 {
			content = fmt.Sprintf(
				"---\ntitle: %s\ntags: [\"%s\", 知识图谱]\n---\n\n- 研究笔记 %04d：推进 [[%s]] 并引用 ((%s)) #%s\n  id:: %s\n- 附带嵌入 ![[%s]]\n",
				title, tag, i, targetTitle, blockID, tag, ownBlockID, targetTitle,
			)
		} else {
			content = fmt.Sprintf(
				"+++\ntitle = \"%s\"\ntags = [\"%s\", \"english\"]\n+++\n\n- Engineering task %04d linking [[%s|alias-%d]] and ((%s)) #%s\n  id:: %s\n- Embedded section ![[%s]]\n",
				title, tag, i, targetTitle, i, blockID, tag, ownBlockID, targetTitle,
			)
		}
		raw := []byte(content)
		inputs[i] = NoteInput{
			RelPath:     relPath,
			Content:     raw,
			UpdatedAtMs: int64(1700000000000 + i),
		}
		sources[relPath] = raw

		parsed, parseErr := ParseNote(relPath, raw)
		if parseErr != nil {
			t.Fatalf("ParseNote(%s): %v", relPath, parseErr)
		}
		expectedForwardByPath[relPath] = parsed.BacklinkViews()
		expectedBacklinkCountByTarget[targetTitle] += 2 // [[targetTitle]] + ![[targetTitle]]
	}

	start := time.Now()
	indexed, err := store.IndexBatch(ctx, inputs)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("IndexBatch 5000 notes: %v", err)
	}
	if len(indexed) != totalNotes {
		t.Fatalf("indexed count = %d, want %d", len(indexed), totalNotes)
	}
	t.Logf("Indexed %d mixed CJK/English PARA notes in %v", totalNotes, elapsed)

	// Verify exact BacklinkView byte-span parity and forward/backlink counts across all 5,000 notes.
	var totalForwardLinks int
	for i := range totalNotes {
		relPath := inputs[i].RelPath
		src := sources[relPath]
		fwd, err := store.ForwardLinks(ctx, relPath)
		if err != nil {
			t.Fatalf("ForwardLinks(%s): %v", relPath, err)
		}
		wantFwd := expectedForwardByPath[relPath]
		if len(fwd) != len(wantFwd) {
			t.Fatalf("forward link count mismatch for %s: got %d want %d", relPath, len(fwd), len(wantFwd))
		}
		totalForwardLinks += len(fwd)

		for j, bl := range fwd {
			if bl.ByteStart < 0 || bl.ByteEnd > len(src) || bl.ByteStart >= bl.ByteEnd {
				t.Fatalf("%s[%d]: invalid byte span [%d:%d] len=%d", relPath, j, bl.ByteStart, bl.ByteEnd, len(src))
			}
			gotToken := string(src[bl.ByteStart:bl.ByteEnd])
			wantToken := string(src[wantFwd[j].ByteStart:wantFwd[j].ByteEnd])
			if gotToken != wantToken || bl.ByteStart != wantFwd[j].ByteStart || bl.ByteEnd != wantFwd[j].ByteEnd || bl.Line != wantFwd[j].Line {
				t.Fatalf("%s[%d]: byte parity mismatch got=%q [%d:%d]@L%d want=%q [%d:%d]@L%d",
					relPath, j, gotToken, bl.ByteStart, bl.ByteEnd, bl.Line,
					wantToken, wantFwd[j].ByteStart, wantFwd[j].ByteEnd, wantFwd[j].Line,
				)
			}
		}
	}
	if totalForwardLinks != totalNotes*4 {
		t.Fatalf("totalForwardLinks = %d, want %d", totalForwardLinks, totalNotes*4)
	}

	// Spot-check and verify aggregate backlink parity on target notes (including block-refs resolved to page!).
	for _, sampleIdx := range []int{0, 1, 42, 999, 2500, 4999} {
		targetTitle := fmt.Sprintf("Note-%04d", sampleIdx)
		if folders[sampleIdx%len(folders)] == "journals" {
			targetTitle = fmt.Sprintf("日记-%04d", sampleIdx)
		}
		bls, err := store.Backlinks(ctx, targetTitle)
		if err != nil {
			t.Fatalf("Backlinks(%s): %v", targetTitle, err)
		}
		// 2 direct links ([[...]] + ![[...]]) from note (sampleIdx-1) + 1 block-ref from note (sampleIdx-2).
		wantCount := expectedBacklinkCountByTarget[targetTitle] + 1
		if len(bls) != wantCount {
			t.Fatalf("Backlinks(%s) count = %d, want %d", targetTitle, len(bls), wantCount)
		}
		for _, bl := range bls {
			src := sources[bl.SourcePath]
			if bl.ByteStart < 0 || bl.ByteEnd > len(src) || bl.ByteStart >= bl.ByteEnd {
				t.Fatalf("Backlink %+v invalid offsets", bl)
			}
			token := string(src[bl.ByteStart:bl.ByteEnd])
			if !strings.Contains(token, targetTitle) && (bl.BlockID == "" || !strings.Contains(token, bl.BlockID)) {
				t.Fatalf("Backlink token %q at [%d:%d] does not match target %q / block %q", token, bl.ByteStart, bl.ByteEnd, targetTitle, bl.BlockID)
			}
		}
	}
}

func TestFTS5TrigramChinesePhraseAndVecHybridRecall(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	store, err := OpenStore(ctx, ":memory:")
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	defer store.Close()

	// Explicitly verify FTS5 virtual table is configured with tokenize='trigram'.
	var ftsDDL string
	if err := store.DB().QueryRowContext(ctx, `SELECT sql FROM sqlite_master WHERE name = 'pkm_notes_fts'`).Scan(&ftsDDL); err != nil {
		t.Fatalf("inspect pkm_notes_fts DDL: %v", err)
	}
	if !strings.Contains(strings.ToLower(ftsDDL), "tokenize='trigram'") {
		t.Fatalf("expected pkm_notes_fts to use tokenize='trigram', got: %s", ftsDDL)
	}

	notes := []NoteInput{
		{
			RelPath:     "01_Projects/Hybrid-Search.md",
			Content:     []byte("---\ntitle: 向量混合检索设计\ntags: [search, pkm]\n---\n\n- 采用 SQLite FTS5 trigram 实现中文词组精确召回，并结合 sqlite-vec 余弦相似度进行 RRF 混合排序。\n"),
			Embedding:   []float32{0.82, 0.50, 0.20, 0.10},
			UpdatedAtMs: 1000,
		},
		{
			RelPath:     "02_Areas/Semantic-Memory.md",
			Content:     []byte("---\ntitle: Semantic Embeddings Guide\ntags: [vector]\n---\n\n- Dense neural embeddings map conceptually related personal knowledge documents into nearby cosine directions.\n"),
			Embedding:   []float32{0.93, 0.34, 0.08, 0.04}, // closest vector to queryVec, no Chinese FTS match
			UpdatedAtMs: 900,
		},
		{
			RelPath:     "04_Archives/Legacy-Search.md",
			Content:     []byte("---\ntitle: 旧版检索笔记\n---\n\n- 旧版本只使用了简单的词法匹配，没有向量混合检索能力。\n"),
			Embedding:   []float32{0.05, 0.10, 0.90, 0.40}, // distant vector, archived tier
			UpdatedAtMs: 800,
		},
		{
			RelPath:     "03_Resources/Reconciliation.md",
			Content:     []byte("---\ntitle: Mount Reconciliation\ntags: [sync]\n---\n\n- Bidirectional directory reconciliation preserves conflict branches on concurrent edits.\n"),
			Embedding:   []float32{0.00, 0.00, 0.10, 0.99}, // orthogonal to search query
			UpdatedAtMs: 700,
		},
	}

	if _, err := store.IndexBatch(ctx, notes); err != nil {
		t.Fatalf("IndexBatch: %v", err)
	}

	// 1. FTS5 trigram Chinese phrase query ("向量混合检索").
	phraseHits, err := store.Search(ctx, SearchQuery{Text: "向量混合检索", Limit: 10})
	if err != nil {
		t.Fatalf("FTS5 Chinese phrase search: %v", err)
	}
	if len(phraseHits) != 2 {
		t.Fatalf("expected 2 FTS5 trigram hits for '向量混合检索', got %d: %+v", len(phraseHits), phraseHits)
	}
	if phraseHits[0].RelPath != "01_Projects/Hybrid-Search.md" {
		t.Fatalf("expected 01_Projects/Hybrid-Search.md ranked first (project tier + title match), got %s", phraseHits[0].RelPath)
	}

	// 2. English substring query via FTS5 trigram ("reconcil" inside "reconciliation").
	subHits, err := store.Search(ctx, SearchQuery{Text: "reconcil", Limit: 5})
	if err != nil {
		t.Fatalf("FTS5 substring search: %v", err)
	}
	if len(subHits) != 1 || subHits[0].RelPath != "03_Resources/Reconciliation.md" {
		t.Fatalf("expected Reconciliation.md for substring 'reconcil', got %+v", subHits)
	}

	// 3. Verify vec_cosine scalar function registered by sqlite-vec/engine works on stored embeddings.
	queryVec := []float32{0.93, 0.34, 0.08, 0.04}
	qBlob, err := vector.EncodeEmbedding(queryVec)
	if err != nil {
		t.Fatalf("EncodeEmbedding: %v", err)
	}
	var sim float64
	if err := store.DB().QueryRowContext(ctx,
		`SELECT vec_cosine(embedding, ?) FROM _vec_`+vecTableName+` WHERE id = ?`,
		qBlob, "02_Areas/Semantic-Memory.md",
	).Scan(&sim); err != nil {
		t.Fatalf("vec_cosine SQL query: %v", err)
	}
	if sim <= 0.99 {
		t.Fatalf("expected high cosine similarity > 0.99, got %f", sim)
	}

	// 4. Hybrid search combining Chinese phrase ("向量混合检索") + vector cosine recall.
	hybridHits, err := store.Search(ctx, SearchQuery{
		Text:         "向量混合检索",
		QueryVector:  queryVec,
		FTSWeight:    1.0,
		VectorWeight: 1.0,
		Limit:        10,
	})
	if err != nil {
		t.Fatalf("Hybrid search: %v", err)
	}
	if len(hybridHits) < 3 {
		t.Fatalf("expected at least 3 hybrid hits (both FTS + semantic vector recall), got %d: %+v", len(hybridHits), hybridHits)
	}
	// 01_Projects/Hybrid-Search.md hits BOTH FTS5 trigram AND top vector recall + Project tier weight -> must be #1!
	if hybridHits[0].RelPath != "01_Projects/Hybrid-Search.md" {
		t.Fatalf("expected Hybrid-Search.md at #1, got %+v", hybridHits)
	}
	if hybridHits[0].FTSRank == 0 || hybridHits[0].VectorRank == 0 {
		t.Fatalf("expected #1 hit to carry both FTSRank and VectorRank, got %+v", hybridHits[0])
	}

	// Semantic-only hit (02_Areas/Semantic-Memory.md) must be recalled above Legacy-Search (04_Archives) due to rank1 vector + Area tier (1.5 vs Archive 0.5)!
	var seenSemantic bool
	for _, h := range hybridHits {
		if h.RelPath == "02_Areas/Semantic-Memory.md" {
			seenSemantic = true
			if h.VectorRank != 1 {
				t.Fatalf("expected Semantic-Memory.md to have VectorRank=1, got %d", h.VectorRank)
			}
			wantScore := (1.0 / (defaultRRFK + 1.0)) * TierWeight(TierArea)
			if math.Abs(h.Score-wantScore) > 1e-9 {
				t.Fatalf("RRF score mismatch for Semantic-Memory: got %v want %v", h.Score, wantScore)
			}
		}
	}
	if !seenSemantic {
		t.Fatalf("expected semantic vector neighbor to be recalled in hybrid search, got %+v", hybridHits)
	}

	// 5. Short 2-char Chinese query ("检索").
	shortHits, err := store.Search(ctx, SearchQuery{Text: "检索", Limit: 5})
	if err != nil {
		t.Fatalf("short CJK search: %v", err)
	}
	if len(shortHits) < 2 {
		t.Fatalf("expected >=2 hits for short query '检索', got %+v", shortHits)
	}
}

func TestFilePersistenceSyncDirAndConcurrency(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	dir := t.TempDir()
	vaultDir := filepath.Join(dir, "vault")
	dbPath := filepath.Join(dir, "pkm.sqlite")

	for rel, body := range map[string]string{
		"01_Projects/Alpha.md": "- Work on [[Beta]] #go\n",
		"03_Resources/Beta.md": "- Reference guide for Alpha\n",
		".pkm/snapshots/x.md":  "- Should be ignored [[Alpha]]\n",
	} {
		full := filepath.Join(vaultDir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	st, err := OpenStore(ctx, dbPath)
	if err != nil {
		t.Fatalf("OpenStore file: %v", err)
	}

	var jm string
	var syncMode int
	if err := st.DB().QueryRowContext(ctx, `PRAGMA journal_mode`).Scan(&jm); err != nil {
		t.Fatalf("PRAGMA journal_mode: %v", err)
	}
	if err := st.DB().QueryRowContext(ctx, `PRAGMA synchronous`).Scan(&syncMode); err != nil {
		t.Fatalf("PRAGMA synchronous: %v", err)
	}
	if strings.ToLower(jm) != "wal" || syncMode != 1 {
		t.Fatalf("unexpected WAL pragmas: mode=%s sync=%d", jm, syncMode)
	}

	stats1, err := st.SyncDir(ctx, vaultDir, EmbedderFunc(func(text string) ([]float32, error) {
		if strings.Contains(text, "Alpha") {
			return []float32{1, 0}, nil
		}
		return []float32{0, 1}, nil
	}))
	if err != nil {
		t.Fatalf("SyncDir 1: %v", err)
	}
	if stats1.Indexed != 2 || stats1.Unchanged != 0 || stats1.Deleted != 0 {
		t.Fatalf("unexpected stats1: %+v", stats1)
	}

	// Second sync without changes skips all unchanged files.
	stats2, err := st.SyncDir(ctx, vaultDir, nil)
	if err != nil {
		t.Fatalf("SyncDir 2: %v", err)
	}
	if stats2.Unchanged != 2 || stats2.Indexed != 0 {
		t.Fatalf("unexpected stats2: %+v", stats2)
	}

	// Modify Beta and delete Alpha, then SyncDir.
	if err := os.Remove(filepath.Join(vaultDir, "01_Projects/Alpha.md")); err != nil {
		t.Fatalf("remove Alpha: %v", err)
	}
	if err := os.WriteFile(filepath.Join(vaultDir, "03_Resources/Beta.md"), []byte("- Updated Beta [[Gamma]]\n"), 0o644); err != nil {
		t.Fatalf("update Beta: %v", err)
	}
	stats3, err := st.SyncDir(ctx, vaultDir, nil)
	if err != nil {
		t.Fatalf("SyncDir 3: %v", err)
	}
	if stats3.Indexed != 1 || stats3.Deleted != 1 {
		t.Fatalf("unexpected stats3: %+v", stats3)
	}

	if err := st.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Reopen and verify persisted graph & search.
	st2, err := OpenStore(ctx, dbPath)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	defer st2.Close()

	bls, err := st2.Backlinks(ctx, "Gamma")
	if err != nil {
		t.Fatalf("Backlinks after reopen: %v", err)
	}
	if len(bls) != 1 || bls[0].SourcePath != "03_Resources/Beta.md" {
		t.Fatalf("unexpected persisted backlinks: %+v", bls)
	}

	// Concurrent reads and writes under -race.
	var wg sync.WaitGroup
	for g := range 4 {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for step := range 10 {
				path := fmt.Sprintf("01_Projects/Conc-%d-%d.md", worker, step)
				_, err := st2.UpsertNote(ctx, NoteInput{
					RelPath:     path,
					Content:     []byte(fmt.Sprintf("- 并发测试 [[Gamma]] #%d\n", worker)),
					Embedding:   []float32{0.8, 0.2},
					UpdatedAtMs: int64(2000 + step),
				})
				if err != nil {
					t.Errorf("concurrent UpsertNote: %v", err)
					return
				}
				if _, err := st2.Search(ctx, SearchQuery{Text: "并发测试", QueryVector: []float32{0.8, 0.2}, Limit: 5}); err != nil {
					t.Errorf("concurrent Search: %v", err)
					return
				}
			}
		}(g)
	}
	wg.Wait()
}

func TestPKMMigrationsUpStatusDownAllUp(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	_ = engine.RegisterVectorFunctions(nil)
	dbPath := filepath.Join(t.TempDir(), "pkm-mig.sqlite")
	db, err := engine.Open(dbPath)
	if err != nil {
		t.Fatalf("engine.Open: %v", err)
	}
	defer db.Close()

	if err := vec.Register(db); err != nil {
		t.Fatalf("vec.Register: %v", err)
	}

	runner, err := migrate.New(db, "pkm", MigrationsFS)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}

	applied, err := runner.Up(ctx)
	if err != nil || applied != 1 {
		t.Fatalf("Up: applied=%d err=%v", applied, err)
	}
	if again, err := runner.Up(ctx); err != nil || again != 0 {
		t.Fatalf("idempotent Up: applied=%d err=%v", again, err)
	}

	statuses, err := runner.Status(ctx)
	if err != nil || len(statuses) != 1 || !statuses[0].Applied || statuses[0].Scope != "pkm" || statuses[0].Version != 1 {
		t.Fatalf("unexpected status after Up: %+v err=%v", statuses, err)
	}

	expectedTables := []string{
		"pkm_notes",
		"pkm_aliases",
		"pkm_blocks",
		"pkm_links",
		"pkm_notes_fts",
		"vector_storage",
		"_vec_pkm_vectors",
		"pkm_vectors",
	}
	for _, tbl := range expectedTables {
		var name string
		if err := db.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, tbl).Scan(&name); err != nil {
			t.Fatalf("expected table %s after Up: %v", tbl, err)
		}
	}

	reverted, err := runner.DownAll(ctx)
	if err != nil || reverted != 1 {
		t.Fatalf("DownAll: reverted=%d err=%v", reverted, err)
	}
	statusesAfterDown, err := runner.Status(ctx)
	if err != nil || len(statusesAfterDown) != 1 || statusesAfterDown[0].Applied {
		t.Fatalf("unexpected status after DownAll: %+v err=%v", statusesAfterDown, err)
	}
	for _, tbl := range expectedTables {
		var name string
		err := db.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, tbl).Scan(&name)
		if !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("expected table %s dropped after DownAll, got name=%q err=%v", tbl, name, err)
		}
	}

	reapplied, err := runner.Up(ctx)
	if err != nil || reapplied != 1 {
		t.Fatalf("re-Up after DownAll: applied=%d err=%v", reapplied, err)
	}
	_ = db.Close()

	// Store opened against migrated file indexes and runs hybrid FTS5+vector search cleanly.
	st, err := OpenStore(ctx, dbPath)
	if err != nil {
		t.Fatalf("OpenStore after re-Up: %v", err)
	}
	defer st.Close()

	if _, err := st.UpsertNote(ctx, NoteInput{
		RelPath:     "01_Projects/MigCheck.md",
		Content:     []byte("---\ntitle: 迁移验证笔记\ntags: [migrate]\n---\n\n- 验证 [[TargetNote]] 与 FTS5 trigram 向量混合检索。\n"),
		Embedding:   []float32{0.9, 0.1, 0.0, 0.0},
		UpdatedAtMs: 1234,
	}); err != nil {
		t.Fatalf("UpsertNote after re-Up: %v", err)
	}
	hits, err := st.Search(ctx, SearchQuery{
		Text:        "向量混合检索",
		QueryVector: []float32{0.9, 0.1, 0.0, 0.0},
		Limit:       5,
	})
	if err != nil || len(hits) != 1 || hits[0].RelPath != "01_Projects/MigCheck.md" {
		t.Fatalf("Search after re-Up: hits=%+v err=%v", hits, err)
	}
}

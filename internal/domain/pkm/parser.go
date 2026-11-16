package pkm

import (
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
	"go.abhg.dev/goldmark/frontmatter"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

// KindPKMLink is the Goldmark AST node kind for parsed WikiLinks, block-refs, embeds, and tags.
var KindPKMLink = ast.NewNodeKind("PKMLink")

// LinkASTNode represents a PKM inline reference in the Goldmark AST with exact source byte segment.
type LinkASTNode struct {
	ast.BaseInline

	LinkKind    LinkKind
	TargetTitle string
	BlockID     string
	Alias       string
	Heading     string
	Segment     text.Segment
}

// Kind implements ast.Node.Kind.
func (n *LinkASTNode) Kind() ast.NodeKind {
	return KindPKMLink
}

// Text implements ast.Node.Text.
func (n *LinkASTNode) Text(source []byte) []byte {
	return n.Segment.Value(source)
}

// Dump implements ast.Node.Dump.
func (n *LinkASTNode) Dump(source []byte, level int) {
	ast.DumpHelper(n, source, level, map[string]string{
		"Kind":        string(n.LinkKind),
		"TargetTitle": n.TargetTitle,
		"BlockID":     n.BlockID,
		"Raw":         string(n.Text(source)),
	}, nil)
}

type pkmExtender struct{}

func (e *pkmExtender) Extend(md goldmark.Markdown) {
	md.Parser().AddOptions(
		parser.WithInlineParsers(
			util.Prioritized(&bracketLinkParser{}, 150),
			util.Prioritized(&tagInlineParser{}, 350),
		),
	)
}

type bracketLinkParser struct{}

func (p *bracketLinkParser) Trigger() []byte {
	return []byte{'!', '[', '('}
}

func (p *bracketLinkParser) Parse(_ ast.Node, block text.Reader, _ parser.Context) ast.Node {
	line, seg := block.PeekLine()
	if seg.Padding != 0 || len(line) < 2 {
		return nil
	}

	switch line[0] {
	case '!':
		if len(line) < 5 || line[1] != '[' || line[2] != '[' {
			return nil
		}
		closeIdx := findDoubleClose(line[3:], ']')
		if closeIdx <= 0 {
			return nil
		}
		inner := string(line[3 : 3+closeIdx])
		totalLen := 3 + closeIdx + 2
		node := &LinkASTNode{
			LinkKind: KindEmbed,
			Segment:  text.NewSegment(seg.Start, seg.Start+totalLen),
		}
		if strings.HasPrefix(inner, "((") && strings.HasSuffix(inner, "))") {
			bid := strings.TrimSpace(inner[2 : len(inner)-2])
			if !isValidBlockID(bid) {
				return nil
			}
			node.BlockID = bid
		} else {
			target, heading, blockID, alias, ok := parseWikiTarget(inner)
			if !ok {
				return nil
			}
			node.TargetTitle = target
			node.Heading = heading
			node.BlockID = blockID
			node.Alias = alias
		}
		block.Advance(totalLen)
		return node

	case '[':
		if len(line) < 5 || line[1] != '[' {
			return nil
		}
		if prev := block.PrecendingCharacter(); prev == '[' || prev == '!' {
			return nil
		}
		closeIdx := findDoubleClose(line[2:], ']')
		if closeIdx <= 0 {
			return nil
		}
		inner := string(line[2 : 2+closeIdx])
		target, heading, blockID, alias, ok := parseWikiTarget(inner)
		if !ok {
			return nil
		}
		totalLen := 2 + closeIdx + 2
		block.Advance(totalLen)
		return &LinkASTNode{
			LinkKind:    KindWikiLink,
			TargetTitle: target,
			Heading:     heading,
			BlockID:     blockID,
			Alias:       alias,
			Segment:     text.NewSegment(seg.Start, seg.Start+totalLen),
		}

	case '(':
		if len(line) < 5 || line[1] != '(' {
			return nil
		}
		if block.PrecendingCharacter() == '(' {
			return nil
		}
		closeIdx := findDoubleClose(line[2:], ')')
		if closeIdx <= 0 {
			return nil
		}
		inner := string(line[2 : 2+closeIdx])
		if !isValidBlockID(inner) {
			return nil
		}
		totalLen := 2 + closeIdx + 2
		block.Advance(totalLen)
		return &LinkASTNode{
			LinkKind: KindBlockRef,
			BlockID:  inner,
			Segment:  text.NewSegment(seg.Start, seg.Start+totalLen),
		}
	}

	return nil
}

type tagInlineParser struct{}

func (p *tagInlineParser) Trigger() []byte {
	return []byte{'#'}
}

func (p *tagInlineParser) Parse(_ ast.Node, block text.Reader, _ parser.Context) ast.Node {
	line, seg := block.PeekLine()
	if seg.Padding != 0 || len(line) < 2 || line[0] != '#' {
		return nil
	}
	prev := block.PrecendingCharacter()
	if !isValidTagPreceder(prev) {
		return nil
	}

	offset := 1
	hasAlphaNum := false
	for offset < len(line) {
		rn, size := utf8.DecodeRune(line[offset:])
		if rn == utf8.RuneError && size == 1 {
			break
		}
		if !isTagNameRune(rn) {
			break
		}
		if unicode.IsLetter(rn) || unicode.IsNumber(rn) {
			hasAlphaNum = true
		}
		offset += size
	}
	for offset > 1 && line[offset-1] == '/' {
		offset--
	}
	if offset <= 1 || !hasAlphaNum {
		return nil
	}

	tagName := string(line[1:offset])
	block.Advance(offset)
	return &LinkASTNode{
		LinkKind:    KindTag,
		TargetTitle: tagName,
		Segment:     text.NewSegment(seg.Start, seg.Start+offset),
	}
}

func findDoubleClose(b []byte, closer byte) int {
	for i := 0; i+1 < len(b); i++ {
		if b[i] == '\n' || b[i] == '\r' {
			return -1
		}
		if closer == ']' && b[i] == '[' && b[i+1] == '[' {
			return -1
		}
		if closer == ')' && b[i] == '(' && b[i+1] == '(' {
			return -1
		}
		if b[i] == closer && b[i+1] == closer {
			return i
		}
	}
	return -1
}

func parseWikiTarget(inner string) (targetTitle, heading, blockID, alias string, ok bool) {
	targetPart, aliasPart, hasPipe := strings.Cut(inner, "|")
	targetPart = strings.TrimSpace(targetPart)
	if hasPipe {
		alias = strings.TrimSpace(aliasPart)
	}
	if targetPart == "" {
		return "", "", "", "", false
	}
	pagePart, frag, hasFrag := strings.Cut(targetPart, "#")
	pagePart = strings.TrimSpace(pagePart)
	frag = strings.TrimSpace(frag)
	if hasFrag {
		if strings.HasPrefix(frag, "^") {
			blockID = strings.TrimSpace(strings.TrimPrefix(frag, "^"))
		} else {
			heading = frag
		}
	}
	if pagePart == "" && heading == "" && blockID == "" {
		return "", "", "", "", false
	}
	if strings.HasPrefix(pagePart, ".") {
		return "", "", "", "", false
	}
	return pagePart, heading, blockID, alias, true
}

func isValidBlockID(s string) bool {
	if s == "" {
		return false
	}
	hasAlphaNum := false
	for _, r := range s {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9'):
			hasAlphaNum = true
		case r == '-' || r == '_' || r == '.' || r == ':':
		default:
			return false
		}
	}
	return hasAlphaNum
}

func isValidTagPreceder(r rune) bool {
	if r == utf8.RuneError {
		return false
	}
	if unicode.Is(unicode.Latin, r) || unicode.IsNumber(r) {
		return false
	}
	switch r {
	case '_', '/', '&', '#':
		return false
	default:
		return true
	}
}

func isTagNameRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_' || r == '/' || r == '-'
}

func newMarkdownParser() goldmark.Markdown {
	return goldmark.New(
		goldmark.WithExtensions(
			extension.Table,
			extension.Strikethrough,
			extension.TaskList,
			&frontmatter.Extender{},
			&pkmExtender{},
		),
	)
}

var defaultMD = newMarkdownParser()

// ParseNote parses a single Markdown file using Goldmark + frontmatter + CST/AST byte-span link extraction.
func ParseNote(relPath string, src []byte) (Note, error) {
	cleanPath := normalizeRelSlash(relPath)
	if cleanPath == "" {
		return Note{}, fmt.Errorf("%w: %q", ErrInvalidPath, relPath)
	}

	rawCopy := make([]byte, len(src))
	copy(rawCopy, src)

	pc := parser.NewContext()
	doc := defaultMD.Parser().Parse(text.NewReader(rawCopy), parser.WithContext(pc))

	fm, bodyOffset := extractFrontmatter(rawCopy, pc)
	title := fm.Title
	if title == "" {
		title = TitleOfPath(cleanPath)
	}
	slug := SlugOf(title)

	tier := TierOfPath(cleanPath)
	if fm.Tier != "" {
		if firstTier, ok := folderToTier[strings.ToLower(fm.Tier)]; ok && !hasExplicitParaFolder(cleanPath) {
			tier = firstTier
		}
	}

	lineStarts := computeLineStarts(rawCopy)
	blocks, links := extractASTNodes(cleanPath, title, rawCopy, doc, lineStarts)

	tagSet := make(map[string]struct{})
	var tags []string
	addTag := func(t string) {
		clean := strings.TrimSpace(strings.TrimPrefix(t, "#"))
		if clean == "" {
			return
		}
		key := strings.ToLower(clean)
		if _, exists := tagSet[key]; !exists {
			tagSet[key] = struct{}{}
			tags = append(tags, clean)
		}
	}
	for _, t := range fm.Tags {
		addTag(t)
	}
	for _, l := range links {
		if l.Kind == KindTag {
			addTag(l.Backlink.TargetTitle)
		}
	}

	bodyText := string(rawCopy)
	if bodyOffset > 0 && bodyOffset <= len(rawCopy) {
		bodyText = string(rawCopy[bodyOffset:])
	}

	return Note{
		RelPath:     cleanPath,
		Title:       title,
		Slug:        slug,
		Tier:        tier,
		Frontmatter: fm,
		Body:        bodyText,
		Source:      rawCopy,
		SHA256:      sha256Hex(rawCopy),
		Links:       links,
		Blocks:      blocks,
		Tags:        tags,
	}, nil
}

func hasExplicitParaFolder(cleanPath string) bool {
	first, _, hasSlash := strings.Cut(cleanPath, "/")
	if !hasSlash {
		return false
	}
	_, ok := folderToTier[strings.ToLower(first)]
	return ok
}

func extractFrontmatter(src []byte, pc parser.Context) (Frontmatter, int) {
	var fm Frontmatter
	if data := frontmatter.Get(pc); data != nil {
		raw := make(map[string]any)
		if err := data.Decode(&raw); err == nil {
			fm.Raw = raw
		}
		if bytes.HasPrefix(src, []byte("+++")) {
			fm.Format = "toml"
		} else {
			fm.Format = "yaml"
		}
		fm.Title = stringField(raw, "title")
		fm.Aliases = stringSliceField(raw, "aliases", "alias")
		fm.Tags = normalizeTagSlice(stringSliceField(raw, "tags", "tag"))
		fm.Tier = firstNonEmpty(stringField(raw, "para"), stringField(raw, "tier"))
		fm.Status = stringField(raw, "status")
		fm.Area = stringField(raw, "area")
		fm.Deadline = stringField(raw, "deadline")
		fm.TLDR = stringField(raw, "tldr")
		return fm, frontmatterBodyOffset(src)
	}

	// Fallback: Logseq page-level `key:: value` lines before the first block or bullet.
	props, consumed := parseLogseqPageProps(src)
	if len(props) > 0 {
		fm.Format = "props"
		raw := make(map[string]any, len(props))
		for k, v := range props {
			raw[k] = v
		}
		fm.Raw = raw
		fm.Title = props["title"]
		if aliasStr := props["alias"]; aliasStr != "" {
			fm.Aliases = splitCommaFields(aliasStr)
		} else if aliasesStr := props["aliases"]; aliasesStr != "" {
			fm.Aliases = splitCommaFields(aliasesStr)
		}
		if tagsStr := props["tags"]; tagsStr != "" {
			fm.Tags = normalizeTagSlice(splitCommaFields(tagsStr))
		}
		fm.Tier = firstNonEmpty(props["para"], props["tier"])
		fm.Status = props["status"]
		fm.Area = props["area"]
		fm.Deadline = props["deadline"]
		fm.TLDR = props["tldr"]
	}
	return fm, consumed
}

func frontmatterBodyOffset(src []byte) int {
	if len(src) < 3 {
		return 0
	}
	delim := src[0]
	if delim != '-' && delim != '+' {
		return 0
	}
	firstNL := bytes.IndexByte(src, '\n')
	if firstNL < 0 {
		return 0
	}
	openLine := bytes.TrimRight(src[:firstNL], "\r")
	if len(openLine) < 3 {
		return 0
	}
	for _, b := range openLine {
		if b != delim {
			return 0
		}
	}
	pos := firstNL + 1
	for pos < len(src) {
		nextNL := bytes.IndexByte(src[pos:], '\n')
		var lineEnd int
		var line []byte
		if nextNL < 0 {
			line = src[pos:]
			lineEnd = len(src)
		} else {
			line = src[pos : pos+nextNL]
			lineEnd = pos + nextNL + 1
		}
		trimmed := bytes.TrimRight(line, "\r")
		if len(trimmed) == len(openLine) && bytes.Equal(trimmed, openLine) {
			return lineEnd
		}
		pos = lineEnd
	}
	return 0
}

func parseLogseqPageProps(src []byte) (map[string]string, int) {
	props := make(map[string]string)
	pos := 0
	lastPropEnd := 0
	for pos < len(src) {
		nextNL := bytes.IndexByte(src[pos:], '\n')
		var line []byte
		var nextPos int
		if nextNL < 0 {
			line = src[pos:]
			nextPos = len(src)
		} else {
			line = src[pos : pos+nextNL]
			nextPos = pos + nextNL + 1
		}
		trimmed := strings.TrimSpace(string(bytes.TrimRight(line, "\r")))
		if trimmed == "" {
			pos = nextPos
			continue
		}
		if strings.HasPrefix(trimmed, "- ") || trimmed == "-" || strings.HasPrefix(trimmed, "#") {
			break
		}
		k, v, ok := parsePropKeyValue(trimmed)
		if !ok {
			break
		}
		props[strings.ToLower(k)] = v
		lastPropEnd = nextPos
		pos = nextPos
	}
	if len(props) == 0 {
		return nil, 0
	}
	return props, lastPropEnd
}

func parsePropKeyValue(line string) (string, string, bool) {
	idx := strings.Index(line, "::")
	if idx <= 0 {
		return "", "", false
	}
	key := line[:idx]
	for _, r := range key {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-') {
			return "", "", false
		}
	}
	return key, strings.TrimSpace(line[idx+2:]), true
}

func extractASTNodes(relPath, pageTitle string, src []byte, doc ast.Node, lineStarts []int) ([]BlockDef, []LinkSpan) {
	var blocks []BlockDef
	var links []LinkSpan

	listItemBlockIDs := make(map[ast.Node]string)

	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}

		switch node := n.(type) {
		case *ast.ListItem:
			if bd, ok := extractBlockDefFromListItem(node, src, lineStarts); ok {
				blocks = append(blocks, bd)
				listItemBlockIDs[node] = bd.ID
			}
		case *LinkASTNode:
			seg := node.Segment
			if seg.Start < 0 || seg.Stop > len(src) || seg.Start >= seg.Stop {
				return ast.WalkContinue, nil
			}
			lineNum := lineNumberAt(lineStarts, seg.Start)
			snippet := lineSnippetAt(src, lineStarts, lineNum)
			targetTitle := node.TargetTitle
			if targetTitle == "" && node.LinkKind == KindWikiLink && (node.Heading != "" || node.BlockID != "") {
				targetTitle = pageTitle
			}
			targetSlug := SlugOf(targetTitle)
			if node.LinkKind == KindTag {
				targetSlug = SlugOf(strings.TrimPrefix(targetTitle, "#"))
			}

			srcBlockID := enclosingBlockID(node, listItemBlockIDs)
			links = append(links, LinkSpan{
				Kind:          node.LinkKind,
				Raw:           string(src[seg.Start:seg.Stop]),
				TargetSlug:    targetSlug,
				Alias:         node.Alias,
				Heading:       node.Heading,
				SourceBlockID: srcBlockID,
				Backlink: contract.BacklinkView{
					SourcePath:  relPath,
					TargetTitle: targetTitle,
					BlockID:     node.BlockID,
					Line:        lineNum,
					ByteStart:   seg.Start,
					ByteEnd:     seg.Stop,
					Snippet:     snippet,
				},
			})
		}
		return ast.WalkContinue, nil
	})

	return blocks, links
}

func extractBlockDefFromListItem(li *ast.ListItem, src []byte, lineStarts []int) (BlockDef, bool) {
	var blockID string
	var bodyParts []string
	byteStart := -1
	byteEnd := -1

	for c := li.FirstChild(); c != nil; c = c.NextSibling() {
		if c.Type() != ast.TypeBlock {
			continue
		}
		// Stop before nested sublists; only inspect lines belonging directly to this item.
		if c.Kind() == ast.KindList {
			continue
		}
		lines := c.Lines()
		if lines == nil {
			continue
		}
		for i := range lines.Len() {
			seg := lines.At(i)
			if seg.Start < 0 || seg.Stop > len(src) || seg.Start >= seg.Stop {
				continue
			}
			if byteStart < 0 || seg.Start < byteStart {
				byteStart = seg.Start
			}
			if seg.Stop > byteEnd {
				byteEnd = seg.Stop
			}
			lineText := strings.TrimSpace(strings.TrimRight(string(src[seg.Start:seg.Stop]), "\r\n"))
			if k, v, ok := parsePropKeyValue(lineText); ok && strings.EqualFold(k, "id") {
				if v != "" {
					blockID = v
				}
				continue
			}
			if lineText != "" {
				bodyParts = append(bodyParts, lineText)
			}
		}
	}
	if blockID == "" || byteStart < 0 {
		return BlockDef{}, false
	}
	return BlockDef{
		ID:        blockID,
		Body:      strings.Join(bodyParts, "\n"),
		Line:      lineNumberAt(lineStarts, byteStart),
		ByteStart: byteStart,
		ByteEnd:   byteEnd,
	}, true
}

func enclosingBlockID(n ast.Node, listItemBlockIDs map[ast.Node]string) string {
	for cur := n.Parent(); cur != nil; cur = cur.Parent() {
		if cur.Kind() == ast.KindListItem {
			return listItemBlockIDs[cur]
		}
	}
	return ""
}

func computeLineStarts(src []byte) []int {
	starts := make([]int, 1, 16)
	starts[0] = 0
	for i, b := range src {
		if b == '\n' && i+1 <= len(src) {
			starts = append(starts, i+1)
		}
	}
	return starts
}

func lineNumberAt(lineStarts []int, offset int) int {
	idx := sort.Search(len(lineStarts), func(i int) bool {
		return lineStarts[i] > offset
	})
	if idx <= 0 {
		return 1
	}
	return idx
}

func lineSnippetAt(src []byte, lineStarts []int, lineNum int) string {
	if lineNum < 1 || lineNum > len(lineStarts) {
		return ""
	}
	start := lineStarts[lineNum-1]
	end := len(src)
	if lineNum < len(lineStarts) {
		end = lineStarts[lineNum]
	}
	return strings.TrimSpace(strings.TrimRight(string(src[start:end]), "\r\n"))
}

func stringField(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	v, ok := m[key]
	if !ok || v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s)
	}
	return strings.TrimSpace(fmt.Sprint(v))
}

func stringSliceField(m map[string]any, keys ...string) []string {
	if m == nil {
		return nil
	}
	for _, key := range keys {
		v, ok := m[key]
		if !ok || v == nil {
			continue
		}
		switch val := v.(type) {
		case string:
			return splitCommaFields(val)
		case []string:
			var out []string
			for _, item := range val {
				if trimmed := strings.TrimSpace(item); trimmed != "" {
					out = append(out, trimmed)
				}
			}
			return out
		case []any:
			var out []string
			for _, item := range val {
				if trimmed := strings.TrimSpace(fmt.Sprint(item)); trimmed != "" {
					out = append(out, trimmed)
				}
			}
			return out
		}
	}
	return nil
}

func splitCommaFields(s string) []string {
	var out []string
	for part := range strings.SplitSeq(s, ",") {
		trimmed := strings.TrimSpace(part)
		trimmed = strings.TrimPrefix(trimmed, "[[")
		trimmed = strings.TrimSuffix(trimmed, "]]")
		trimmed = strings.TrimSpace(trimmed)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func normalizeTagSlice(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := make([]string, 0, len(in))
	for _, raw := range in {
		cleaned := strings.TrimSpace(strings.TrimPrefix(raw, "#"))
		if cleaned != "" {
			out = append(out, cleaned)
		}
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// ParseVaultDir walks rootDir and concurrently parses every PARA Markdown note using Goldmark.
func ParseVaultDir(ctx context.Context, rootDir string) ([]Note, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	type rawFile struct {
		relPath     string
		absPath     string
		updatedAtMs int64
	}
	var files []rawFile
	err := filepath.WalkDir(rootDir, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		name := d.Name()
		if d.IsDir() {
			if p != rootDir && strings.HasPrefix(name, ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		rel, err := filepath.Rel(rootDir, p)
		if err != nil {
			return err
		}
		relSlash := filepath.ToSlash(rel)
		if !IsVaultMarkdownPath(relSlash) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		files = append(files, rawFile{
			relPath:     relSlash,
			absPath:     p,
			updatedAtMs: info.ModTime().UnixMilli(),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, nil
	}

	sort.Slice(files, func(i, j int) bool {
		return files[i].relPath < files[j].relPath
	})

	notes := make([]Note, len(files))
	workers := min(max(runtime.GOMAXPROCS(0), 1), len(files))
	jobs := make(chan int, workers*2)
	var firstErr error
	var errOnce sync.Once
	var wg sync.WaitGroup

	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range jobs {
				if err := ctx.Err(); err != nil {
					errOnce.Do(func() { firstErr = err })
					return
				}
				rf := files[idx]
				raw, err := os.ReadFile(rf.absPath)
				if err != nil {
					errOnce.Do(func() { firstErr = err })
					return
				}
				parsed, err := ParseNote(rf.relPath, raw)
				if err != nil {
					errOnce.Do(func() { firstErr = err })
					return
				}
				parsed.UpdatedAtMs = rf.updatedAtMs
				notes[idx] = parsed
			}
		}()
	}

	for i := range files {
		if ctx.Err() != nil {
			break
		}
		jobs <- i
	}
	close(jobs)
	wg.Wait()

	if firstErr != nil {
		return nil, firstErr
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return notes, nil
}

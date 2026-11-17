package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/pkm"
)

var (
	pkmPropLineRe     = regexp.MustCompile(`^([a-zA-Z0-9_-]+)::\s*(.*)$`)
	pkmBulletLineRe   = regexp.MustCompile(`^(\s*)-(?:\s(.*))?$`)
	pkmPriorityLeadRe = regexp.MustCompile(`^\[#([ABC])\]\s+(.*)$`)
	pkmBlockRefRe     = regexp.MustCompile(`\(\(([0-9a-fA-F-]{8,36})\)\)`)
	pkmWikiLinkRe     = regexp.MustCompile(`\[\[([^[\]]+?)\]\]`)
	pkmJournalFileRe  = regexp.MustCompile(`^journals/(\d{4})_(\d{2})_(\d{2})\.md$`)
	pkmJournalSlugRe  = regexp.MustCompile(`^(\d{4})[-_](\d{2})[-_](\d{2})$`)
)

var pkmMarkers = []string{"TODO", "DOING", "DONE", "NOW", "LATER", "WAITING", "CANCELED"}

func pkmSeededID(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	h := hex.EncodeToString(sum[:])
	return fmt.Sprintf("%s-%s-4%s-a%s-%s", h[0:8], h[8:12], h[13:16], h[17:20], h[20:32])
}

func journalDayFromPathOrSlug(relPath, slug string) string {
	if m := pkmJournalFileRe.FindStringSubmatch(relPath); len(m) == 4 {
		return m[1] + "-" + m[2] + "-" + m[3]
	}
	if m := pkmJournalSlugRe.FindStringSubmatch(slug); len(m) == 4 {
		return m[1] + "-" + m[2] + "-" + m[3]
	}
	return ""
}

func journalSlugFromDay(day string) string {
	return strings.ReplaceAll(strings.TrimSpace(day), "-", "_")
}

func formatYamlScalar(v any) string {
	switch tv := v.(type) {
	case string:
		return tv
	case time.Time:
		return tv.Format("2006-01-02")
	default:
		return fmt.Sprint(v)
	}
}

func extractNoteProps(n pkm.Note, pageProps map[string]string) map[string]string {
	out := map[string]string{}
	if n.Frontmatter.Raw != nil {
		for k, v := range n.Frontmatter.Raw {
			if k == "title" || k == "tier" || k == "para" || k == "tldr" || v == nil {
				continue
			}
			s := strings.TrimSpace(formatYamlScalar(v))
			if s != "" {
				out[k] = s
			}
		}
	}
	for k, v := range pageProps {
		if k != "" && v != "" {
			out[k] = v
		}
	}
	return out
}

func formatPkmNoteContent(title, tier string, props map[string]string, body string) string {
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString(fmt.Sprintf("title: %s\n", strconv.Quote(title)))
	if strings.TrimSpace(tier) != "" {
		b.WriteString(fmt.Sprintf("tier: %s\n", strconv.Quote(tier)))
	}
	if len(props) > 0 {
		keys := make([]string, 0, len(props))
		for k, v := range props {
			if k == "title" || k == "tier" || k == "para" || strings.TrimSpace(k) == "" || v == "" {
				continue
			}
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			b.WriteString(fmt.Sprintf("%s: %s\n", k, strconv.Quote(props[k])))
		}
	}
	b.WriteString("---\n")
	b.WriteString(body)
	return b.String()
}

func pkmUnindent(line string, depth int) string {
	indent := strings.Repeat("  ", max(0, depth+1))
	if strings.HasPrefix(line, indent) {
		return line[len(indent):]
	}
	return strings.TrimLeft(line, " \t")
}

func parsePkmOutlineAndProps(slug, bodyText string) (map[string]string, []protoPkmBlock) {
	pageProps := map[string]string{}
	normal := strings.ReplaceAll(bodyText, "\r\n", "\n")
	lines := strings.Split(normal, "\n")

	i := 0
	for ; i < len(lines); i++ {
		line := lines[i]
		if strings.TrimSpace(line) == "" {
			continue
		}
		if pkmBulletLineRe.MatchString(line) {
			break
		}
		if m := pkmPropLineRe.FindStringSubmatch(strings.TrimSpace(line)); len(m) == 3 {
			pageProps[m[1]] = strings.TrimSpace(m[2])
			continue
		}
		break
	}

	blocks := []protoPkmBlock{}
	var depthStack []int
	curIdx := -1
	fence := ""
	readingProps := false
	count := 0

	for ; i < len(lines); i++ {
		line := lines[i]
		if fence != "" && curIdx >= 0 {
			cont := pkmUnindent(line, blocks[curIdx].Depth)
			blocks[curIdx].Body += "\n" + cont
			blocks[curIdx].Path = blocks[curIdx].Body
			if strings.HasPrefix(strings.TrimLeft(cont, " \t"), fence) {
				fence = ""
			}
			continue
		}
		if m := pkmBulletLineRe.FindStringSubmatch(line); m != nil {
			spaces := strings.ReplaceAll(m[1], "\t", "  ")
			depth := len(spaces) / 2
			if depth > len(depthStack) {
				depth = len(depthStack)
			}
			depthStack = depthStack[:depth]
			content := m[2]
			marker := ""
			priority := ""
			for _, mk := range pkmMarkers {
				if strings.HasPrefix(content, mk+" ") {
					marker = mk
					rest := strings.TrimLeft(content[len(mk):], " \t")
					if pm := pkmPriorityLeadRe.FindStringSubmatch(rest); len(pm) == 3 {
						priority = pm[1]
						content = pm[2]
					} else {
						content = rest
					}
					break
				}
			}
			if marker == "" {
				if pm := pkmPriorityLeadRe.FindStringSubmatch(content); len(pm) == 3 {
					priority = pm[1]
					content = pm[2]
				}
			}
			count++
			parentID := ""
			if len(depthStack) > 0 {
				parentID = blocks[depthStack[len(depthStack)-1]].ID
			}
			blk := protoPkmBlock{
				ID:       pkmSeededID(fmt.Sprintf("%s::%d", slug, count)),
				Parent:   parentID,
				Depth:    depth,
				Marker:   marker,
				Priority: priority,
				Body:     content,
				Props:    map[string]string{},
				Path:     content,
			}
			blocks = append(blocks, blk)
			curIdx = len(blocks) - 1
			depthStack = append(depthStack, curIdx)
			readingProps = true
			if trimmedStart := strings.TrimLeft(content, " \t"); strings.HasPrefix(trimmedStart, "```") {
				fence = "```"
				readingProps = false
			}
			continue
		}
		if curIdx < 0 {
			continue
		}
		if strings.TrimSpace(line) == "" && i == len(lines)-1 {
			continue
		}
		cont := pkmUnindent(line, blocks[curIdx].Depth)
		if strings.HasPrefix(strings.TrimLeft(cont, " \t"), "```") {
			fence = "```"
			readingProps = false
			blocks[curIdx].Body += "\n" + cont
			blocks[curIdx].Path = blocks[curIdx].Body
			continue
		}
		if readingProps {
			if pm := pkmPropLineRe.FindStringSubmatch(strings.TrimSpace(cont)); len(pm) == 3 {
				if pm[1] == "id" {
					idVal := strings.TrimSpace(pm[2])
					if idVal != "" {
						blocks[curIdx].ID = idVal
						blocks[curIdx].ExplicitID = true
					}
				} else {
					blocks[curIdx].Props[pm[1]] = strings.TrimSpace(pm[2])
				}
				continue
			}
		}
		if strings.TrimSpace(line) != "" {
			readingProps = false
			blocks[curIdx].Body += "\n" + cont
			blocks[curIdx].Path = blocks[curIdx].Body
		}
	}
	return pageProps, blocks
}

var pkmBlockPropOrder = []string{"collapsed", "id", "completed", "deadline", "scheduled", "render", "caption", "source-anchor", "comment"}

func renderPkmOutline(blocks []protoPkmBlock, referenced map[string]bool) string {
	if len(blocks) == 0 {
		return ""
	}
	lines := make([]string, 0, len(blocks)*2)
	for _, b := range blocks {
		indent := strings.Repeat("  ", max(0, b.Depth))
		more := strings.Repeat("  ", max(0, b.Depth+1))
		lead := indent + "- "
		if b.Marker != "" {
			lead += b.Marker + " "
		}
		if b.Priority != "" {
			lead += "[#" + b.Priority + "] "
		}
		bodyLines := strings.Split(b.Body, "\n")
		first := ""
		if len(bodyLines) > 0 {
			first = bodyLines[0]
		}
		lines = append(lines, strings.TrimRight(lead+first, " \t"))

		props := make(map[string]string, len(b.Props)+1)
		for k, v := range b.Props {
			if v != "" {
				props[k] = v
			}
		}
		if b.ExplicitID || referenced[b.ID] || props["comment"] != "" {
			props["id"] = b.ID
		}
		if len(props) > 0 {
			keys := make([]string, 0, len(props))
			for k, v := range props {
				if v != "" {
					keys = append(keys, k)
				}
			}
			sort.Slice(keys, func(i, j int) bool {
				ia, ib := -1, -1
				for idx, ord := range pkmBlockPropOrder {
					if ord == keys[i] {
						ia = idx
					}
					if ord == keys[j] {
						ib = idx
					}
				}
				if ia != -1 && ib != -1 {
					return ia < ib
				}
				if ia != -1 {
					return true
				}
				if ib != -1 {
					return false
				}
				return keys[i] < keys[j]
			})
			for _, k := range keys {
				lines = append(lines, strings.TrimRight(more+k+":: "+props[k], " \t"))
			}
		}
		for _, cont := range bodyLines[1:] {
			lines = append(lines, strings.TrimRight(more+cont, " \t"))
		}
	}
	return strings.Join(lines, "\n") + "\n"
}

type pkmTreeNode struct {
	block    protoPkmBlock
	children []*pkmTreeNode
}

func blocksToPkmTree(blocks []protoPkmBlock) []*pkmTreeNode {
	var roots []*pkmTreeNode
	var stack []*pkmTreeNode
	for _, b := range blocks {
		cp := b
		pm := make(map[string]string, len(cp.Props))
		for k, v := range cp.Props {
			pm[k] = v
		}
		cp.Props = pm
		node := &pkmTreeNode{block: cp}
		d := max(0, min(b.Depth, len(stack)))
		stack = stack[:d]
		if d == 0 {
			roots = append(roots, node)
		} else {
			parent := stack[d-1]
			parent.children = append(parent.children, node)
		}
		stack = append(stack, node)
	}
	return roots
}

func flattenPkmTree(roots []*pkmTreeNode) []protoPkmBlock {
	var out []protoPkmBlock
	var walk func(nodes []*pkmTreeNode, depth int, parentID string)
	walk = func(nodes []*pkmTreeNode, depth int, parentID string) {
		for _, n := range nodes {
			n.block.Depth = depth
			n.block.Parent = parentID
			n.block.Path = n.block.Body
			out = append(out, n.block)
			if len(n.children) > 0 {
				walk(n.children, depth+1, n.block.ID)
			}
		}
	}
	walk(roots, 0, "")
	return out
}

func locatePkmNode(roots *[]*pkmTreeNode, id string) (node *pkmTreeNode, parent *pkmTreeNode, siblings *[]*pkmTreeNode, index int, found bool) {
	var walk func(list *[]*pkmTreeNode, par *pkmTreeNode) bool
	walk = func(list *[]*pkmTreeNode, par *pkmTreeNode) bool {
		for i, n := range *list {
			if n.block.ID == id {
				node = n
				parent = par
				siblings = list
				index = i
				found = true
				return true
			}
			if walk(&n.children, n) {
				return true
			}
		}
		return false
	}
	walk(roots, nil)
	return
}

func containsPkmNode(nodes []*pkmTreeNode, id string) bool {
	for _, n := range nodes {
		if n.block.ID == id || containsPkmNode(n.children, id) {
			return true
		}
	}
	return false
}

func applyPkmOutlineOps(slug string, blocks []protoPkmBlock, rawOps []json.RawMessage) []protoPkmBlock {
	roots := blocksToPkmTree(blocks)
	cycleMarker := map[string]string{
		"":        "TODO",
		"TODO":    "DOING",
		"DOING":   "DONE",
		"DONE":    "TODO",
		"LATER":   "NOW",
		"NOW":     "DONE",
		"WAITING": "TODO",
	}

	for idx, rawOp := range rawOps {
		var op struct {
			Op        string            `json:"op"`
			Block     string            `json:"block"`
			ID        string            `json:"id"`
			Body      *string           `json:"body"`
			Marker    *string           `json:"marker"`
			Priority  *string           `json:"priority"`
			Props     map[string]string `json:"props"`
			Direction string            `json:"direction"`
			Target    string            `json:"target"`
			At        string            `json:"at"`
		}
		if json.Unmarshal(rawOp, &op) != nil {
			continue
		}
		fresh := func() *pkmTreeNode {
			id := strings.TrimSpace(op.ID)
			explicit := id != ""
			if id == "" {
				id = pkmSeededID(fmt.Sprintf("%s::%d::%d", slug, len(blocks)+idx+1, time.Now().UnixNano()))
			}
			body := ""
			if op.Body != nil {
				body = *op.Body
			}
			marker := ""
			if op.Marker != nil {
				marker = *op.Marker
			}
			priority := ""
			if op.Priority != nil {
				priority = *op.Priority
			}
			pm := map[string]string{}
			for k, v := range op.Props {
				if v != "" {
					pm[k] = v
				}
			}
			return &pkmTreeNode{
				block: protoPkmBlock{
					ID:         id,
					Marker:     marker,
					Priority:   priority,
					Body:       body,
					Props:      pm,
					Path:       body,
					ExplicitID: explicit,
				},
			}
		}

		if op.Op == "append" {
			roots = append(roots, fresh())
			continue
		}
		node, parent, siblings, atIdx, found := locatePkmNode(&roots, op.Block)
		if !found {
			continue
		}
		switch op.Op {
		case "insert_before":
			*siblings = slices.Insert(*siblings, atIdx, fresh())
		case "insert_after":
			*siblings = slices.Insert(*siblings, atIdx+1, fresh())
		case "insert_child":
			node.children = append(node.children, fresh())
		case "update":
			if op.Body != nil {
				node.block.Body = *op.Body
				node.block.Path = *op.Body
			}
			if op.Priority != nil {
				node.block.Priority = *op.Priority
			}
			for k, v := range op.Props {
				if v == "" {
					delete(node.block.Props, k)
				} else {
					node.block.Props[k] = v
				}
			}
		case "set_marker":
			if op.Marker != nil {
				node.block.Marker = *op.Marker
			} else {
				node.block.Marker = ""
			}
		case "toggle_marker":
			if next, ok := cycleMarker[node.block.Marker]; ok {
				node.block.Marker = next
			} else {
				node.block.Marker = "DONE"
			}
		case "delete":
			*siblings = slices.Delete(*siblings, atIdx, atIdx+1)
		case "indent":
			if atIdx > 0 {
				prev := (*siblings)[atIdx-1]
				*siblings = slices.Delete(*siblings, atIdx, atIdx+1)
				prev.children = append(prev.children, node)
			}
		case "outdent":
			if parent != nil {
				_, _, upSibs, upIdx, ok := locatePkmNode(&roots, parent.block.ID)
				if ok {
					*siblings = slices.Delete(*siblings, atIdx, atIdx+1)
					*upSibs = slices.Insert(*upSibs, upIdx+1, node)
				}
			}
		case "move":
			to := atIdx + 1
			if op.Direction == "up" {
				to = atIdx - 1
			}
			list := *siblings
			if to >= 0 && to < len(list) {
				list[atIdx], list[to] = list[to], list[atIdx]
			}
		case "move_to":
			if op.Target == node.block.ID || containsPkmNode(node.children, op.Target) {
				continue
			}
			*siblings = slices.Delete(*siblings, atIdx, atIdx+1)
			tNode, _, tSibs, tIdx, ok := locatePkmNode(&roots, op.Target)
			if !ok {
				*siblings = slices.Insert(*siblings, atIdx, node)
				continue
			}
			switch op.At {
			case "inside":
				tNode.children = slices.Insert(tNode.children, 0, node)
			case "after":
				*tSibs = slices.Insert(*tSibs, tIdx+1, node)
			default:
				*tSibs = slices.Insert(*tSibs, tIdx, node)
			}
		}
	}
	return flattenPkmTree(roots)
}

func collectAllReferencedBlockIDs(notes []pkm.Note) map[string]bool {
	refs := map[string]bool{}
	for _, n := range notes {
		for _, m := range pkmBlockRefRe.FindAllStringSubmatch(n.Body, -1) {
			if len(m) == 2 {
				refs[m[1]] = true
			}
		}
	}
	return refs
}

func (h *Handler) resolvePkmNote(ctx context.Context, target string) (pkm.Note, bool, error) {
	if h.st == nil || h.st.PKM == nil {
		return pkm.Note{}, false, nil
	}
	q := strings.TrimSpace(target)
	if q == "" {
		return pkm.Note{}, false, nil
	}
	if n, ok, err := h.st.PKM.GetNote(ctx, q); err == nil && ok {
		return n, true, nil
	}
	if m := pkmJournalSlugRe.FindStringSubmatch(q); len(m) == 4 {
		jPath := fmt.Sprintf("journals/%s_%s_%s.md", m[1], m[2], m[3])
		if n, ok, err := h.st.PKM.GetNote(ctx, jPath); err == nil && ok {
			return n, true, nil
		}
	}
	notes, err := h.loadAllPkmNotes(ctx)
	if err != nil {
		return pkm.Note{}, false, err
	}
	for _, n := range notes {
		if n.RelPath == q || strings.EqualFold(n.Slug, q) || strings.EqualFold(n.Title, q) {
			return n, true, nil
		}
		for _, al := range n.Frontmatter.Aliases {
			if strings.EqualFold(al, q) {
				return n, true, nil
			}
		}
	}
	return pkm.Note{}, false, nil
}

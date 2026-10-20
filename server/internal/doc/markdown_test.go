package doc

import (
	"fmt"
	"strings"
	"testing"

	"vibevalley/internal/protocol"
)

// blocks lays mdBlocks out as stored blocks: ids b0, b1…, each under the last block one level up.
func blocks(t *testing.T, md []mdBlock) []protocol.Block {
	t.Helper()
	var out []protocol.Block
	parents := []string{}
	last := map[string]string{}
	for i, b := range md {
		parents = parents[:b.depth]
		var parent *string
		if b.depth > 0 {
			parent = new(parents[b.depth-1])
		}
		key, err := keyBetween(last[ptrValue(parent)], "")
		if err != nil {
			t.Fatal(err)
		}
		last[ptrValue(parent)] = key
		id := fmt.Sprintf("b%d", i)
		parents = append(parents, id)
		out = append(out, protocol.Block{ID: id, ParentID: parent, OrderKey: key, Type: b.typ, Attrs: b.attrs, Text: b.text, Rev: 1})
	}
	return out
}

// What a block is, without its id and place: its depth, type, attrs and text with marks.
func shape(t *testing.T, bs []protocol.Block) string {
	t.Helper()
	depth := map[string]int{}
	var lines []string
	for _, b := range ordered(bs) {
		d := 0
		if b.ParentID != nil {
			d = depth[*b.ParentID] + 1
		}
		depth[b.ID] = d
		lines = append(lines, fmt.Sprintf("%d %s %+v %s", d, b.Type, attrsText(b.Attrs), spansText(normal(b.Text))))
	}
	return strings.Join(lines, "\n")
}

func attrsText(a protocol.BlockAttrs) string {
	var parts []string
	if a.Level != nil {
		parts = append(parts, fmt.Sprint("level=", *a.Level))
	}
	if a.Checked != nil {
		parts = append(parts, fmt.Sprint("checked=", *a.Checked))
	}
	for name, v := range map[string]*string{"language": a.Language, "src": a.Src, "alt": a.Alt, "issue": a.IssueID, "memory": a.MemoryID} {
		if v != nil {
			parts = append(parts, name+"="+*v)
		}
	}
	if a.Width != nil {
		parts = append(parts, fmt.Sprint("size=", *a.Width, "x", *a.Height))
	}
	return strings.Join(sorted(parts), ",")
}

func sorted(s []string) []string {
	for i := range s {
		for j := i + 1; j < len(s); j++ {
			if s[j] < s[i] {
				s[i], s[j] = s[j], s[i]
			}
		}
	}
	return s
}

func spansText(spans []protocol.DocSpan) string {
	var parts []string
	for _, s := range spans {
		m := ""
		if s.Marks.Bold {
			m += "B"
		}
		if s.Marks.Italic {
			m += "I"
		}
		if s.Marks.Code {
			m += "C"
		}
		if s.Marks.Strike {
			m += "S"
		}
		if s.Marks.Link != nil {
			m += "L(" + *s.Marks.Link + ")"
		}
		parts = append(parts, fmt.Sprintf("%q%s", s.T, m))
	}
	return strings.Join(parts, "+")
}

const sample = "# 周报：VibeValley 🌾\n" +
	"\n" +
	"这周把**块编辑器**的第一步做完了，_顺利_ 😀。见 [设计](https://example.com/a_b) 和 `doc.submit`，~~不用 CRDT~~。\n" +
	"\n" +
	"## 做了什么\n" +
	"\n" +
	"- 按块存\n" +
	"  - 子项：中文、emoji 👍🏽\n" +
	"- [x] 合并段落\n" +
	"- [ ] 三方合并\n" +
	"1. 第一\n" +
	"2. 第二\n" +
	"\n" +
	"> 引用一句\n" +
	"> 第二行\n" +
	"\n" +
	"```go\n" +
	"func main() {\n" +
	"\tfmt.Println(\"**不是粗体**\")\n" +
	"}\n" +
	"```\n" +
	"\n" +
	"---\n" +
	"\n" +
	"![农场](https://example.com/farm.png \"640x480\")\n" +
	"\n" +
	"<!-- issue:0192f -->\n" +
	"\n" +
	"<!-- memory:m1 --> 记住：测试用 `make check`\n" +
	"\n" +
	"\\# 不是标题，\\*也不是\\* 列表 \\\\ 反斜杠\n" +
	"\n" +
	"### 结尾\n"

// Markdown → blocks → Markdown gives the same text back, and the blocks again are the same blocks.
func TestMarkdownRoundTrip(t *testing.T) {
	first := blocks(t, blocksOfMarkdown(sample))
	md := markdownOf(first)
	if md != sample {
		t.Fatalf("export differs:\n%s\n--- want ---\n%s", md, sample)
	}
	again := blocks(t, blocksOfMarkdown(md))
	if shape(t, first) != shape(t, again) {
		t.Fatalf("blocks differ:\n%s\n---\n%s", shape(t, first), shape(t, again))
	}
	want := []string{
		`0 heading level=1 "周报：VibeValley 🌾"`,
		`0 paragraph  "这周把"+"块编辑器"B+"的第一步做完了，"+"顺利"I+" 😀。见 "+"设计"L(https://example.com/a_b)+" 和 "+"doc.submit"C+"，"+"不用 CRDT"S+"。"`,
		`1 bulleted  "子项：中文、emoji 👍🏽"`,
		`0 todo checked=true "合并段落"`,
		`0 quote  "引用一句\n第二行"`,
		"0 code language=go \"func main() {\\n\\tfmt.Println(\\\"**不是粗体**\\\")\\n}\"",
		`0 image alt=农场,size=640x480,src=https://example.com/farm.png `,
		`0 issue_ref issue=0192f `,
		`0 memory_item memory=m1 "记住：测试用 "+"make check"C`,
		`0 paragraph  "# 不是标题，*也不是* 列表 \\ 反斜杠"`,
	}
	got := shape(t, first)
	for _, w := range want {
		if !strings.Contains(got, w) {
			t.Errorf("missing %s in\n%s", w, got)
		}
	}
}

// Blocks → Markdown → blocks keeps every block, whatever its text holds.
func TestBlocksRoundTrip(t *testing.T) {
	link := "https://example.com"
	in := []protocol.Block{
		{ID: "a", OrderKey: "V", Type: protocol.BlockParagraph, Text: []protocol.DocSpan{
			span("前 "), {T: "粗斜", Marks: protocol.DocMarks{Bold: true, Italic: true}}, {T: "粗", Marks: protocol.DocMarks{Bold: true}},
			{T: "链接里的`码`", Marks: protocol.DocMarks{Link: &link, Code: true}}, span(" *星号* _下划线_ [方括号] ~波浪~ 👨‍👩‍👧"), span(" doc"), {T: "mid", Marks: protocol.DocMarks{Italic: true}}, span("word"),
		}},
		{ID: "s", OrderKey: "VV", Type: protocol.BlockParagraph, Text: []protocol.DocSpan{span("doc_append 和 doc_update 是工具名")}},
		{ID: "b", OrderKey: "W", Type: protocol.BlockParagraph, Text: []protocol.DocSpan{span("- 像列表的段落")}},
		{ID: "c", OrderKey: "X", Type: protocol.BlockBulleted, Text: []protocol.DocSpan{span("[ ] 像待办的列表")}},
		{ID: "d", OrderKey: "Y", Type: protocol.BlockNumbered, Text: []protocol.DocSpan{span("一")}},
		{ID: "e", OrderKey: "V", ParentID: new("d"), Type: protocol.BlockNumbered, Text: []protocol.DocSpan{span("一点一")}},
		{ID: "f", OrderKey: "Z", Type: protocol.BlockNumbered, Text: []protocol.DocSpan{span("二")}},
		{ID: "g", OrderKey: "a", Type: protocol.BlockHeading, Attrs: protocol.BlockAttrs{Level: new(int64(2))}, Text: []protocol.DocSpan{span("1. 像编号")}},
	}
	out := blocks(t, blocksOfMarkdown(markdownOf(in)))
	if shape(t, in) != shape(t, out) {
		t.Fatalf("blocks differ:\n%s\n--- markdown ---\n%s\n--- back ---\n%s", shape(t, in), markdownOf(in), shape(t, out))
	}
	if md := markdownOf(in); !strings.Contains(md, "1. 一\n  1. 一点一\n2. 二") {
		t.Fatalf("numbers are counted per level:\n%s", md)
	}
}

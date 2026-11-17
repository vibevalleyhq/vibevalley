package gateway

import (
	"fmt"
	"html"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/vibevalleyhq/vibevalley/internal/domain/artifact"
)

const (
	shellLightVars     = "color-scheme:light;--vv-page:#fcfcfb;--vv-side:#f6f5f3;--vv-ink:#1c1917;--vv-muted:#5e5852;--vv-faint:#716a64;--vv-line:#1c191714;--vv-accent:#4d7a2a;--vv-leaf:#74a046;--vv-wheat:#e5a93c;--vv-berry:#a83a2c;--vv-water:#2f6fa8;"
	shellDarkVars      = "color-scheme:dark;--vv-page:#151413;--vv-side:#1b1a18;--vv-ink:#ecebe8;--vv-muted:#a9a49e;--vv-faint:#8b867f;--vv-line:#ecebe81a;--vv-accent:#7fae4f;--vv-leaf:#8dbb5c;--vv-wheat:#e5a93c;--vv-berry:#e47d6d;--vv-water:#6aa6dc;"
	shellTypeVariables = `--vv-font-sans:"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;--vv-font-mono:Menlo,ui-monospace,monospace;--vv-radius:8px;`
)

const shellSlideStyles = `
:where(html.vv-slides),:where(html.vv-slides) :where(body){margin:0;height:100%;overflow:hidden;background:var(--vv-side);color:var(--vv-ink);font-family:var(--vv-font-sans);-webkit-font-smoothing:antialiased}
:where(html.vv-slides) :where(section){position:absolute;left:50%;top:50%;width:1280px;height:720px;box-sizing:border-box;padding:80px 112px;display:none;flex-direction:column;justify-content:center;gap:28px;background:var(--vv-page);transform:translate(-50%,-50%) scale(var(--vv-scale,1));transform-origin:center;overflow:hidden}
:where(html.vv-slides) :where(section.vv-on){display:flex}
:where(html.vv-slides) :where(section) :where(h1){margin:0;font-size:72px;line-height:1.1;font-weight:700;letter-spacing:-0.01em}
:where(html.vv-slides) :where(section) :where(h2){margin:0;font-size:48px;line-height:1.15;font-weight:650}
:where(html.vv-slides) :where(section) :where(h3){margin:0;font-size:32px;line-height:1.2;font-weight:600;color:var(--vv-muted)}
:where(html.vv-slides) :where(section) :where(p,li){margin:0;font-size:30px;line-height:1.5}
:where(html.vv-slides) :where(section) :where(ul,ol){margin:0;padding-left:1.2em;display:flex;flex-direction:column;gap:14px}
:where(html.vv-slides) :where(section) :where(li)::marker{color:var(--vv-leaf)}
:where(html.vv-slides) :where(section) :where(small,figcaption,.muted){font-size:22px;color:var(--vv-muted)}
:where(html.vv-slides) :where(section) :where(code){font-family:var(--vv-font-mono);font-size:0.9em;padding:0.1em 0.3em;border-radius:6px;background:var(--vv-line)}
:where(html.vv-slides) :where(section) :where(img,video,svg){max-width:100%;max-height:100%;border-radius:var(--vv-radius)}
:where(html.vv-slides) :where(section) :where(aside.notes){display:none}
:where(html.vv-slides) :where(section.title){align-items:flex-start;justify-content:flex-end;padding-bottom:112px}
:where(html.vv-slides) :where(section.title) :where(h1){font-size:88px}
:where(html.vv-slides) :where(section.title)::before{content:"";width:72px;height:6px;border-radius:3px;background:var(--vv-accent);margin-bottom:8px}
:where(html.vv-slides) :where(section.two-col){display:none;grid-template-columns:1fr 1fr;grid-template-rows:auto 1fr;column-gap:64px;row-gap:36px;align-content:center}
:where(html.vv-slides) :where(section.two-col.vv-on){display:grid}
:where(html.vv-slides) :where(section.two-col) > :where(h1,h2,h3){grid-column:1 / -1}
:where(html.vv-slides) :where(section.two-col) > :where(div){display:flex;flex-direction:column;gap:16px;min-width:0}
:where(html.vv-slides) :where(section.image){padding:56px;align-items:center;gap:20px}
:where(html.vv-slides) :where(section.image) :where(img,video,svg){flex:1;min-height:0;object-fit:contain}
:where(html.vv-slides) :where(section.quote){padding:96px 160px}
:where(html.vv-slides) :where(section.quote) :where(blockquote){margin:0;padding-left:40px;border-left:8px solid var(--vv-wheat);font-size:48px;line-height:1.4;font-weight:500}
:where(html.vv-slides) :where(section.quote) :where(cite,figcaption){font-style:normal;font-size:26px;color:var(--vv-muted)}
@page{size:1280px 720px;margin:0}
@media print{
  :where(html.vv-slides),:where(html.vv-slides) :where(body){height:auto;overflow:visible;background:none}
  :where(html.vv-slides) :where(section){position:relative;left:auto;top:auto;transform:none;display:flex;break-after:page;page-break-after:always}
  :where(html.vv-slides) :where(section.two-col){display:grid}
}`

const shellSelectionScript = `(() => {
  const hidden = new Set(["HEAD", "SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "TEXTAREA", "TITLE"]);
  const context = 32;
  const texts = () => {
    const out = [];
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        for (let p = n.parentElement; p; p = p.parentElement) if (hidden.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
    return out;
  };
  const indexOf = (nodes, container, offset) => {
    const point = document.createRange();
    point.setStart(container, offset);
    let at = 0;
    for (const t of nodes) {
      if (t === container) return at + offset;
      if (point.comparePoint(t, 0) >= 0) return at;
      at += t.data.length;
    }
    return at;
  };
  const anchor = () => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const nodes = texts();
    const whole = nodes.map((t) => t.data).join("");
    const from = indexOf(nodes, range.startContainer, range.startOffset);
    const to = indexOf(nodes, range.endContainer, range.endOffset);
    const exact = whole.slice(from, to);
    if (exact.trim() === "") return null;
    return { kind: "text", exact, prefix: whole.slice(Math.max(0, from - context), from), suffix: whole.slice(to, to + context) };
  };
  let timer = 0;
  document.addEventListener("selectionchange", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      let found = null;
      try {
        found = anchor();
      } catch {
        found = null;
      }
      if (found) parent.postMessage({ vibevalley: "selection", anchor: found }, "*");
    }, 150);
  });
})();`

const shellRuntimeScript = `(config) => {
  const say = (message) => parent.postMessage(Object.assign({ vibevalley: message.kind }, message.body), "*");
  const commands = {};
  addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const d = e.data;
    if (!d || typeof d !== "object" || typeof d.vibevalley !== "string") return;
    const run = Object.prototype.hasOwnProperty.call(commands, d.vibevalley) ? commands[d.vibevalley] : undefined;
    if (run) run(d);
  });
  const asked = new URLSearchParams(location.search);
  const displays = {
    page: () => say({ kind: "ready", body: { display: "page" } }),
    slides: () => {
      const all = Array.from(document.querySelectorAll("section")).filter((s) => !s.parentElement || !s.parentElement.closest("section"));
      if (all.length === 0) return displays.page();
      const root = document.documentElement;
      root.classList.add("vv-slides");
      const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim().slice(0, 500) : "");
      const titles = all.map((s) => text(s.querySelector("h1, h2, h3")));
      const notes = all.map((s) => text(s.querySelector("aside.notes")));
      if (asked.get("print") === "1") {
        root.classList.add("vv-print");
        addEventListener("load", () => setTimeout(() => print(), 300));
        return say({ kind: "ready", body: { display: "slides", pages: all.length, titles, notes } });
      }
      const fit = () => {
        const k = Math.min(innerWidth / 1280, innerHeight / 720);
        for (const s of all) s.style.setProperty("--vv-scale", String(k));
      };
      let at = -1;
      const show = (n) => {
        const next = Math.max(0, Math.min(all.length - 1, n));
        if (next === at) return;
        at = next;
        all.forEach((s, i) => s.classList.toggle("vv-on", i === at));
        say({ kind: "at", body: { page: at } });
      };
      commands.goto = (d) => {
        if (Number.isInteger(d.page)) show(d.page);
      };
      addEventListener("resize", fit);
      fit();
      const first = Number(asked.get("at"));
      show(Number.isInteger(first) ? first : 0);
      if (asked.get("still") !== "1") {
        addEventListener("keydown", (e) => {
          if (e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
          const step = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, " ": 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 }[e.key];
          if (step) {
            e.preventDefault();
            show(at + step);
          } else if (e.key === "Home") show(0);
          else if (e.key === "End") show(all.length - 1);
        });
        addEventListener("click", (e) => {
          if (e.target && e.target.closest && e.target.closest("a, button, input, textarea, select, summary, video, audio, [contenteditable]")) return;
          if (getSelection() && !getSelection().isCollapsed) return;
          show(at + (e.clientX < innerWidth / 4 ? -1 : 1));
        });
      }
      say({ kind: "ready", body: { display: "slides", pages: all.length, titles, notes } });
    },
  };
  const start = () => (displays[config.display] || displays.page)();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}`

func withHTMLShell(page, display, theme string) string {
	themeVars := shellLightVars
	if theme == "dark" {
		themeVars = shellDarkVars
	}
	disp := "page"
	dispCSS := ""
	switch display {
	case "slides":
		disp = "slides"
		dispCSS = shellSlideStyles
	case "motion":
		disp = "motion"
	}
	return fmt.Sprintf("%s\n<style>:root{%s%s}%s</style>\n<script>%s</script>\n<script>(%s)({ display: %q })</script>\n",
		page, themeVars, shellTypeVariables, dispCSS, shellSelectionScript, shellRuntimeScript, disp)
}

var (
	scriptBlockRe = regexp.MustCompile(`(?is)<script\b[^>]*>.*?</script>`)
	styleBlockRe  = regexp.MustCompile(`(?is)<style\b[^>]*>.*?</style>`)
	mdHTMLTagRe   = regexp.MustCompile(`(?s)<[^>]+>`)
	orderedItemRe = regexp.MustCompile(`^\d+\.\s+(.*)$`)
	dividerLineRe = regexp.MustCompile(`^(\*{3,}|-{3,}|_{3,})$`)
	imageLineRe   = regexp.MustCompile(`^!\[((?:\\.|[^\]])*)\]\(([^)\s]*)(?: "(\d+)x(\d+)")?\)$`)
)

func stripUnsafeInlineHTML(s string) string {
	s = scriptBlockRe.ReplaceAllString(s, "")
	s = styleBlockRe.ReplaceAllString(s, "")
	s = mdHTMLTagRe.ReplaceAllString(s, "")
	return s
}

func parseInlineSpans(s string) []artifact.TextSpan {
	if s == "" {
		return []artifact.TextSpan{}
	}
	var spans []artifact.TextSpan
	add := func(t string, m artifact.SpanMarks) {
		if t == "" {
			return
		}
		spans = append(spans, artifact.TextSpan{Text: t, Marks: m})
	}
	var buf strings.Builder
	flush := func() {
		if buf.Len() > 0 {
			add(buf.String(), artifact.SpanMarks{})
			buf.Reset()
		}
	}
	for i := 0; i < len(s); {
		if strings.HasPrefix(s[i:], "**") {
			if end := strings.Index(s[i+2:], "**"); end > 0 {
				flush()
				add(s[i+2:i+2+end], artifact.SpanMarks{Bold: true})
				i += 2 + end + 2
				continue
			}
		}
		if strings.HasPrefix(s[i:], "~~") {
			if end := strings.Index(s[i+2:], "~~"); end > 0 {
				flush()
				add(s[i+2:i+2+end], artifact.SpanMarks{Strike: true})
				i += 2 + end + 2
				continue
			}
		}
		if s[i] == '`' {
			if end := strings.IndexByte(s[i+1:], '`'); end > 0 {
				flush()
				add(s[i+1:i+1+end], artifact.SpanMarks{Code: true})
				i += 1 + end + 1
				continue
			}
		}
		if s[i] == '*' && !strings.HasPrefix(s[i:], "**") {
			if end := strings.IndexByte(s[i+1:], '*'); end > 0 {
				flush()
				add(s[i+1:i+1+end], artifact.SpanMarks{Italic: true})
				i += 1 + end + 1
				continue
			}
		}
		if s[i] == '[' {
			if closeBracket := strings.IndexByte(s[i+1:], ']'); closeBracket > 0 {
				afterBracket := i + 1 + closeBracket + 1
				if afterBracket < len(s) && s[afterBracket] == '(' {
					if closeParen := strings.IndexByte(s[afterBracket+1:], ')'); closeParen > 0 {
						label := s[i+1 : i+1+closeBracket]
						href := strings.TrimSpace(s[afterBracket+1 : afterBracket+1+closeParen])
						lower := strings.ToLower(href)
						if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "/") || strings.HasPrefix(lower, "#") {
							flush()
							add(label, artifact.SpanMarks{Link: href})
							i = afterBracket + 1 + closeParen + 1
							continue
						}
					}
				}
			}
		}
		buf.WriteByte(s[i])
		i++
	}
	flush()
	if len(spans) == 0 {
		return []artifact.TextSpan{}
	}
	return spans
}

func markdownToBlockOps(docID, raw string) []artifact.BlockOp {
	cleaned := strings.ReplaceAll(raw, "\r\n", "\n")
	cleaned = scriptBlockRe.ReplaceAllString(cleaned, "")
	cleaned = styleBlockRe.ReplaceAllString(cleaned, "")
	lines := strings.Split(cleaned, "\n")

	var ops []artifact.BlockOp
	prevKey := ""
	seq := 0
	nextOp := func(bt artifact.BlockType, attrs artifact.BlockAttrs, spans []artifact.TextSpan) {
		seq++
		key, err := artifact.KeyBetween(prevKey, "")
		if err != nil {
			key = fmt.Sprintf("a%04d", seq)
		}
		prevKey = key
		ops = append(ops, artifact.BlockOp{
			Op: artifact.OpInsertBlock,
			Block: &artifact.BlockInput{
				ID:       fmt.Sprintf("%s-blk-%d", docID, seq),
				OrderKey: key,
				Type:     bt,
				Attrs:    attrs,
				Text:     spans,
			},
		})
	}

	for i := 0; i < len(lines); i++ {
		rawLine := lines[i]
		trimmed := strings.TrimSpace(rawLine)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "```") {
			lang := strings.TrimSpace(strings.TrimPrefix(trimmed, "```"))
			var codeLines []string
			for i++; i < len(lines); i++ {
				if strings.HasPrefix(strings.TrimSpace(lines[i]), "```") {
					break
				}
				codeLines = append(codeLines, lines[i])
			}
			nextOp(artifact.BlockCode, artifact.BlockAttrs{Language: lang}, []artifact.TextSpan{{Text: strings.Join(codeLines, "\n")}})
			continue
		}

		noHTML := strings.TrimSpace(mdHTMLTagRe.ReplaceAllString(trimmed, ""))
		if noHTML == "" {
			continue
		}
		if dividerLineRe.MatchString(noHTML) {
			nextOp(artifact.BlockDivider, artifact.BlockAttrs{}, []artifact.TextSpan{})
			continue
		}
		if m := imageLineRe.FindStringSubmatch(noHTML); len(m) >= 3 {
			attrs := artifact.BlockAttrs{Alt: m[1], Src: m[2]}
			if len(m) >= 5 && m[3] != "" && m[4] != "" {
				if w, err := strconv.Atoi(m[3]); err == nil {
					attrs.Width = &w
				}
				if ht, err := strconv.Atoi(m[4]); err == nil {
					attrs.Height = &ht
				}
			}
			nextOp(artifact.BlockImage, attrs, []artifact.TextSpan{})
			continue
		}
		if strings.HasPrefix(noHTML, "#") {
			lvl := 0
			for lvl < len(noHTML) && lvl < 6 && noHTML[lvl] == '#' {
				lvl++
			}
			if lvl > 0 && lvl < len(noHTML) && noHTML[lvl] == ' ' {
				body := strings.TrimSpace(noHTML[lvl+1:])
				l := lvl
				nextOp(artifact.BlockHeading, artifact.BlockAttrs{Level: &l}, parseInlineSpans(body))
				continue
			}
		}
		if strings.HasPrefix(noHTML, "- [ ] ") || strings.HasPrefix(noHTML, "* [ ] ") {
			checked := false
			nextOp(artifact.BlockTodo, artifact.BlockAttrs{Checked: &checked}, parseInlineSpans(strings.TrimSpace(noHTML[6:])))
			continue
		}
		if strings.HasPrefix(noHTML, "- [x] ") || strings.HasPrefix(noHTML, "- [X] ") || strings.HasPrefix(noHTML, "* [x] ") || strings.HasPrefix(noHTML, "* [X] ") {
			checked := true
			nextOp(artifact.BlockTodo, artifact.BlockAttrs{Checked: &checked}, parseInlineSpans(strings.TrimSpace(noHTML[6:])))
			continue
		}
		if strings.HasPrefix(noHTML, "- ") || strings.HasPrefix(noHTML, "* ") {
			nextOp(artifact.BlockBulleted, artifact.BlockAttrs{}, parseInlineSpans(strings.TrimSpace(noHTML[2:])))
			continue
		}
		if m := orderedItemRe.FindStringSubmatch(noHTML); len(m) == 2 {
			nextOp(artifact.BlockNumbered, artifact.BlockAttrs{}, parseInlineSpans(strings.TrimSpace(m[1])))
			continue
		}
		if strings.HasPrefix(noHTML, ">") {
			body := strings.TrimSpace(strings.TrimPrefix(noHTML, ">"))
			nextOp(artifact.BlockQuote, artifact.BlockAttrs{}, parseInlineSpans(body))
			continue
		}
		nextOp(artifact.BlockParagraph, artifact.BlockAttrs{}, parseInlineSpans(noHTML))
	}
	return ops
}

type htmlTextBytePos struct {
	node int
	from int
	to   int
}

var htmlHiddenTags = map[string]bool{
	"head":     true,
	"script":   true,
	"style":    true,
	"template": true,
	"noscript": true,
	"textarea": true,
	"title":    true,
}

var htmlEntityPrefixRe = regexp.MustCompile(`^&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?`)

func collapseSpacesRunes(s string) string {
	var b strings.Builder
	inSpace := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			if !inSpace {
				b.WriteByte(' ')
				inSpace = true
			}
			continue
		}
		inSpace = false
		b.WriteRune(r)
	}
	return b.String()
}

func bareNonSpace(s string) string {
	var b strings.Builder
	for _, r := range s {
		if !unicode.IsSpace(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func scanVisibleHTMLText(source string) ([]rune, []htmlTextBytePos) {
	type rawRunePos struct {
		r   rune
		pos htmlTextBytePos
	}
	var raw []rawRunePos
	var hiddenStack []string
	nodeID := 0
	inTextNode := false

	appendTextRange := func(start, end int) {
		if start >= end || len(hiddenStack) > 0 {
			return
		}
		if !inTextNode {
			nodeID++
			inTextNode = true
		}
		seg := source[start:end]
		for off := 0; off < len(seg); {
			if seg[off] == '&' {
				if m := htmlEntityPrefixRe.FindString(seg[off:]); m != "" {
					decoded := html.UnescapeString(m)
					for _, r := range decoded {
						raw = append(raw, rawRunePos{r: r, pos: htmlTextBytePos{node: nodeID, from: start + off, to: start + off + len(m)}})
					}
					off += len(m)
					continue
				}
			}
			var r rune
			var sz int
			for _, rr := range seg[off:] {
				r = rr
				sz = len(string(rr))
				break
			}
			if sz == 0 {
				r = rune(seg[off])
				sz = 1
			}
			raw = append(raw, rawRunePos{r: r, pos: htmlTextBytePos{node: nodeID, from: start + off, to: start + off + sz}})
			off += sz
		}
	}

	i := 0
	textStart := 0
	for i < len(source) {
		if source[i] != '<' {
			i++
			continue
		}
		if i > textStart {
			appendTextRange(textStart, i)
		}
		if strings.HasPrefix(source[i:], "<!--") {
			end := strings.Index(source[i+4:], "-->")
			if end < 0 {
				i = len(source)
			} else {
				i = i + 4 + end + 3
			}
			textStart = i
			continue
		}
		// Scan past '>' respecting single/double quotes inside tag attributes.
		gt := -1
		var quote byte
		for p := i + 1; p < len(source); p++ {
			c := source[p]
			if quote != 0 {
				if c == quote {
					quote = 0
				}
				continue
			}
			if c == '"' || c == '\'' {
				quote = c
				continue
			}
			if c == '>' {
				gt = p - (i + 1)
				break
			}
		}
		if gt < 0 {
			break
		}
		tagBody := strings.TrimSpace(source[i+1 : i+1+gt])
		i = i + 1 + gt + 1
		textStart = i
		if tagBody == "" || strings.HasPrefix(tagBody, "!") || strings.HasPrefix(tagBody, "?") {
			continue
		}
		inTextNode = false
		closing := strings.HasPrefix(tagBody, "/")
		if closing {
			tagBody = strings.TrimSpace(tagBody[1:])
		}
		endName := 0
		for endName < len(tagBody) && !unicode.IsSpace(rune(tagBody[endName])) && tagBody[endName] != '/' {
			endName++
		}
		tagName := strings.ToLower(tagBody[:endName])
		selfClosing := strings.HasSuffix(tagBody, "/")
		if (tagName == "script" || tagName == "style") && !closing && !selfClosing {
			closeTag := "</" + tagName
			lowerRest := strings.ToLower(source[i:])
			if idx := strings.Index(lowerRest, closeTag); idx >= 0 {
				after := i + idx + len(closeTag)
				if gtEnd := strings.IndexByte(source[after:], '>'); gtEnd >= 0 {
					i = after + gtEnd + 1
				} else {
					i = len(source)
				}
			} else {
				i = len(source)
			}
			textStart = i
			continue
		}
		if htmlHiddenTags[tagName] {
			if closing {
				for idx := len(hiddenStack) - 1; idx >= 0; idx-- {
					if hiddenStack[idx] == tagName {
						hiddenStack = hiddenStack[:idx]
						break
					}
				}
			} else if !selfClosing {
				hiddenStack = append(hiddenStack, tagName)
			}
		}
	}
	if textStart < len(source) {
		appendTextRange(textStart, len(source))
	}

	var outRunes []rune
	var outPos []htmlTextBytePos
	for _, ch := range raw {
		if unicode.IsSpace(ch.r) && len(outRunes) > 0 && outRunes[len(outRunes)-1] == ' ' {
			last := &outPos[len(outPos)-1]
			node := last.node
			if node != ch.pos.node {
				node = -1
			}
			*last = htmlTextBytePos{node: node, from: last.from, to: ch.pos.to}
			continue
		}
		r := ch.r
		if unicode.IsSpace(r) {
			r = ' '
		}
		outRunes = append(outRunes, r)
		outPos = append(outPos, ch.pos)
	}
	return outRunes, outPos
}

func escapeHTMLText(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	return s
}

func applyHTMLAnchorEdit(source, prefixRaw, exactRaw, suffixRaw, replacement string) (string, string, bool) {
	exact := strings.TrimSpace(collapseSpacesRunes(exactRaw))
	if exact == "" {
		return "", "anchor text is empty", false
	}
	if strings.TrimSpace(collapseSpacesRunes(replacement)) == exact {
		return "", "replacement matches existing text", false
	}
	pageRunes, at := scanVisibleHTMLText(source)
	exactRunes := []rune(exact)
	var found []int
	for i := 0; i+len(exactRunes) <= len(pageRunes); i++ {
		match := true
		for j := 0; j < len(exactRunes); j++ {
			if pageRunes[i+j] != exactRunes[j] {
				match = false
				break
			}
		}
		if match {
			found = append(found, i)
		}
	}
	if len(found) == 0 {
		return "", "anchor text not found in HTML", false
	}
	prefix := bareNonSpace(prefixRaw)
	suffix := bareNonSpace(suffixRaw)
	chosen := found
	if len(found) > 1 {
		var filtered []int
		for _, k := range found {
			pStart := max(0, k-4*len([]rune(prefix))-64)
			sEnd := min(len(pageRunes), k+len(exactRunes)+4*len([]rune(suffix))+64)
			before := bareNonSpace(string(pageRunes[pStart:k]))
			after := bareNonSpace(string(pageRunes[k+len(exactRunes) : sEnd]))
			if strings.HasSuffix(before, prefix) && strings.HasPrefix(after, suffix) {
				filtered = append(filtered, k)
			}
		}
		chosen = filtered
	}
	if len(chosen) != 1 {
		return "", fmt.Sprintf("ambiguous anchor match (%d)", len(chosen)), false
	}
	k := chosen[0]
	first := at[k]
	last := at[k+len(exactRunes)-1]
	if first.node <= 0 || first.node != last.node {
		return "", "anchor crosses HTML nodes", false
	}
	return source[:first.from] + escapeHTMLText(replacement) + source[last.to:], "", true
}

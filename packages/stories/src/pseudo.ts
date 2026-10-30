export const pseudoStates = ["rest", "hover", "focus", "active"] as const;
export type PseudoState = (typeof pseudoStates)[number];

const tokens: Record<Exclude<PseudoState, "rest">, RegExp> = {
  hover: /:hover(?![-\w])/gu,
  // :focus-within is a parent's state, not the part's own.
  focus: /:focus-visible(?![-\w])|:focus(?![-\w])/gu,
  active: /:active(?![-\w])/gu,
};

/** What a rule left with no selector of its own (a bare :focus-visible) applies to: what can take the focus. */
const focusable = ":is(a[href],button,input,select,textarea,summary,[tabindex])";

/** A selector list split at its top-level commas, not the ones inside :is(…) or :where(…). */
export function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}

/** The selector list a rule gets for a forced state, or undefined when no part of it waits on that state. */
export function forcedSelector(list: string, state: Exclude<PseudoState, "rest">): string | undefined {
  const token = tokens[state];
  const parts = splitSelectors(list)
    .filter((s) => s.search(token) !== -1)
    .map((s) => {
      token.lastIndex = 0;
      const rest = s.replace(token, "").trim();
      return `[data-pseudo~="${state}"] ${rest === "" || rest === "*" ? focusable : rest}`;
    });
  token.lastIndex = 0;
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** A media query that only asks whether the device can hover: dropped, as the state is forced anyway. */
const onlyHover = (condition: string) => /^\(\s*hover\s*:\s*hover\s*\)$/u.test(condition.trim());

interface Wrap {
  readonly open: string;
}

/** The copies, as CSS text, of every rule in `rules` that waits on an interaction state, inside the same layers and media. */
function forcedRules(rules: CSSRuleList | readonly CSSRule[], wraps: readonly Wrap[] = []): string {
  let out = "";
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      for (const state of ["hover", "focus", "active"] as const) {
        const selector = forcedSelector(rule.selectorText, state);
        if (selector === undefined) continue;
        const body = `${selector}{${rule.style.cssText}}`;
        out += wraps.reduceRight((inner, w) => `${w.open}{${inner}}`, body);
      }
    } else if (rule instanceof CSSMediaRule) {
      const condition = rule.conditionText;
      out += forcedRules(rule.cssRules, onlyHover(condition) ? wraps : [...wraps, { open: `@media ${condition}` }]);
    } else if (typeof CSSLayerBlockRule !== "undefined" && rule instanceof CSSLayerBlockRule) {
      // The copies stay in their layer, so they win over the rules they win over now and no others.
      out += forcedRules(rule.cssRules, [...wraps, { open: `@layer ${rule.name}` }]);
    } else if (rule instanceof CSSSupportsRule) {
      out += forcedRules(rule.cssRules, [...wraps, { open: `@supports ${rule.conditionText}` }]);
    }
  }
  return out;
}

export const pseudoStyleId = "stories-pseudo";

export function forceStates(doc: Document = document) {
  let css = "";
  for (const sheet of Array.from(doc.styleSheets)) {
    if (sheet.ownerNode instanceof HTMLElement && sheet.ownerNode.id === pseudoStyleId) continue;
    try {
      css += forcedRules(sheet.cssRules);
    } catch {
      // A sheet from another origin cannot be read; the page's own are all same-origin.
    }
  }
  let el = doc.getElementById(pseudoStyleId);
  if (el?.textContent === css) return;
  if (!el) {
    el = doc.createElement("style");
    el.id = pseudoStyleId;
    doc.head.append(el);
  }
  el.textContent = css;
}

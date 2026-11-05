// What an artifact may be, and the headers its content is served with (docs/subsystems/artifact.md).

import { t } from "@vibevalley/i18n";
import { ArtifactKindValues } from "@vibevalley/protocol";
import { htmlSandbox, isOneOf } from "@vibevalley/protocol/rules";

/** The largest artifact body, bytes, and title, characters. */
export const artifactMax = 5 * 1024 * 1024;
const artifactTitleMax = 80;

/** Why a title, a kind or a hand-in's size is refused, in the owner's words; "" when they are right. Absent ones are not
 * judged: a new version has no title or kind of its own, and an empty blocks artifact the owner starts has no content. */
export function artifactProblem(a: { readonly title?: string; readonly kind?: string; readonly size?: number }): string {
  if (a.title !== undefined) {
    const n = [...a.title.trim()].length;
    if (n === 0) return t("server.artifact.noTitle");
    if (n > artifactTitleMax) return t("server.artifact.longTitle", { max: artifactTitleMax });
  }
  if (a.kind !== undefined && !isOneOf(ArtifactKindValues, a.kind)) return t("server.artifact.badKind", { kind: a.kind, kinds: ArtifactKindValues.join(", ") });
  if (a.size === undefined) return "";
  if (a.size === 0) return t("server.artifact.empty");
  if (a.size > artifactMax) return t("server.artifact.tooBig", { mb: artifactMax / 1024 / 1024 });
  return "";
}

const libraries = ["https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"];

/**
 * Where an HTML artifact may load from besides its own inline code: the one list its CSP, the check before it is kept
 * (check.ts) and the helpers' manual (tool/prompts.ts) are written from. Pictures and media are inline (data:, blob:),
 * never a URL that tells someone the page was opened.
 */
export const htmlSources = {
  script: libraries,
  style: [...libraries, "https://fonts.googleapis.com"],
  font: [...libraries, "https://fonts.gstatic.com"],
} as const;

/**
 * An HTML artifact is someone else's page: it must never run as one of the farm's. The sandbox (rules/display.ts) gives
 * it an opaque origin, connect-src 'none' keeps it from calling the farm's API on 127.0.0.1 or anything else, and
 * nothing loads from outside htmlSources. In the header, not only on the page's <iframe>, so a version opened in a tab of
 * its own is kept the same way.
 */
export const htmlPolicy = [
  `sandbox ${htmlSandbox}`,
  "default-src 'none'",
  ["script-src 'unsafe-inline'", ...htmlSources.script].join(" "),
  ["style-src 'unsafe-inline'", ...htmlSources.style].join(" "),
  "img-src data: blob:",
  ["font-src data:", ...htmlSources.font].join(" "),
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** An html artifact's version never changes once made: cached for good. A blocks one is not served as a file. */
export const artifactHeaders: Record<string, string> = {
  "cache-control": "private, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": htmlPolicy,
};

// The demo's pacing: up to three helpers write one article at once, from the script in the catalog, through the real op
// pipeline as their profiles. The writing itself is in blocks.ts.

/** The pacing of one writer: about a tick per piece, a bit more or less so the writers interleave. */
export const demoPieces = 6;
export const demoJitter = 0.3;

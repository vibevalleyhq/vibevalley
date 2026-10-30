// What an artifact may be, and the headers its content is served with (docs/subsystems/artifact.md).

import { t } from "@vibevalley/i18n";

import { isOneOf } from "@vibevalley/protocol/rules";
import { ArtifactKindValues } from "@vibevalley/protocol";

/** The largest artifact body, bytes, and title, characters. */
export const artifactMax = 5 * 1024 * 1024;
export const artifactTitleMax = 80;

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

/**
 * An HTML artifact is someone else's page: it must never run as one of the farm's. sandbox without allow-same-origin
 * gives it an opaque origin (none of the farm's cookies or storage), and connect-src 'none' keeps it from calling the
 * farm's API on 127.0.0.1 or anything else; scripts, styles, pictures and fonts may come inline or over https, so a page
 * can use a chart library. In the header, not only on the page's <iframe>, so a version opened in a tab of its own is
 * kept the same way.
 */
export const htmlPolicy = [
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
  "default-src 'none'",
  "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
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

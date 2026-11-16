import { readdir, readFile } from "node:fs/promises";

import { currentLocale, list, t } from "@vibevalley/i18n";
import { ArtifactTypeValues } from "@vibevalley/protocol";
import type * as T from "@vibevalley/protocol";
import { isOneOf } from "@vibevalley/protocol/rules";

import { serverFile } from "#/base/assets.ts";
import { BizCode, errnoOf, refuseIn } from "#/base/errors.ts";
import type { Db } from "#/infra/db.ts";
import * as qa from "#db/artifact.sql.ts";

const refused = refuseIn(BizCode.ArtifactRefused);

function stripFrontmatter(raw: string): string {
  const normalized = raw.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return normalized.trim();
  const end = normalized.indexOf("\n---\n", 4);
  return end >= 0 ? normalized.slice(end + 5).trim() : normalized.trim();
}

function typeWords(type: T.ArtifactType): { readonly title: string; readonly summary: string } {
  switch (type) {
    case "docs":
      return { title: t("server.artifact.types.docs.title"), summary: t("server.artifact.types.docs.summary") };
    case "slides":
      return { title: t("server.artifact.types.slides.title"), summary: t("server.artifact.types.slides.summary") };
    case "dashboard":
      return { title: t("server.artifact.types.dashboard.title"), summary: t("server.artifact.types.dashboard.summary") };
    case "motion":
      return { title: t("server.artifact.types.motion.title"), summary: t("server.artifact.types.motion.summary") };
    case "whiteboard":
      return { title: t("server.artifact.types.whiteboard.title"), summary: t("server.artifact.types.whiteboard.summary") };
    case "design":
      return { title: t("server.artifact.types.design.title"), summary: t("server.artifact.types.design.summary") };
    case "design-system":
      return { title: t("server.artifact.types.design-system.title"), summary: t("server.artifact.types.design-system.summary") };
  }
}

async function listReferences(type: T.ArtifactType): Promise<string[]> {
  try {
    const entries = await readdir(serverFile(`src/modules/artifact/types/${type}/references`), { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name.slice(0, -3))
      .toSorted();
  } catch (e) {
    if (errnoOf(e) === "ENOENT") return [];
    throw e;
  }
}

export interface TypeRegistry {
  readonly listTypes: () => Promise<T.ArtifactTypeInfo[]>;
  readonly readType: (req: T.ArtifactTypeReadRequest) => Promise<T.ArtifactTypeGuide>;
}

export function makeTypeRegistry(deps: { readonly db: Db }): TypeRegistry {
  const { db } = deps;

  return {
    listTypes: async () => {
      const def = await qa.defaultDesignSystemArtifact(db.sql);
      const out: T.ArtifactTypeInfo[] = [];
      for (const type of ArtifactTypeValues) {
        const words = typeWords(type);
        out.push({
          type,
          body: type === "docs" ? "blocks" : "store",
          title: words.title,
          summary: words.summary,
          references: await listReferences(type),
          defaultArtifactId: type === "design-system" ? (def?.id ?? null) : null,
        });
      }
      return out;
    },
    readType: async (req) => {
      if (!isOneOf(ArtifactTypeValues, req.type)) {
        throw refused(t("server.artifact.badType", { type: String(req.type), types: list(ArtifactTypeValues) }));
      }
      const references = await listReferences(req.type);
      const words = typeWords(req.type);
      const def = await qa.defaultDesignSystemArtifact(db.sql);
      const wantedRef = req.reference?.trim().replace(/\.md$/iu, "") ?? "";
      let content: string;
      let reference: string | null = null;
      if (wantedRef !== "") {
        if (!references.includes(wantedRef)) {
          throw refused(
            t("server.artifact.noReference", {
              type: req.type,
              reference: req.reference ?? wantedRef,
              available: references.length > 0 ? list(references) : "-",
            }),
          );
        }
        reference = wantedRef;
        content = stripFrontmatter(await readFile(serverFile(`src/modules/artifact/types/${req.type}/references/${wantedRef}.md`), "utf8"));
      } else {
        const skillFile = currentLocale() === "en" ? "SKILL.en.md" : "SKILL.md";
        content = stripFrontmatter(await readFile(serverFile(`src/modules/artifact/types/${req.type}/${skillFile}`), "utf8"));
      }
      return {
        type: req.type,
        title: words.title,
        reference,
        content,
        references,
        defaultArtifactId: def?.id ?? null,
        defaultArtifactTitle: def?.title ?? null,
      };
    },
  };
}

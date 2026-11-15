import { z } from "zod";

import { localizedJson } from "#/base/json.ts";

import catalogEn from "./template_catalog.en.json";
import catalogZh from "./template_catalog.json";

/** A template as template_catalog.json writes it: done may still hold {test}, {lint} and {build}. */
const WrittenTemplate = z.object({ id: z.string(), title: z.string(), done: z.string() });
export type WrittenTemplate = z.infer<typeof WrittenTemplate>;
const WrittenKind = z.object({ id: z.string(), name: z.string(), icon: z.string(), templates: z.array(WrittenTemplate) });
export type WrittenKind = z.infer<typeof WrittenKind>;
const Catalog = z.object({ kinds: z.array(WrittenKind) });

const catalog = localizedJson(Catalog, catalogZh, catalogEn);

/** The issue templates on the sowing form, in its order, as written. */
export const templateCatalog = (): readonly WrittenKind[] => catalog().kinds;

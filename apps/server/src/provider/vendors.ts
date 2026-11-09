import { Schema } from "effect";

import { mossImageModels } from "@vibevalley/provider/moss/image-models";

/** What an image is asked for with, whoever draws it. A layout prompt is the parsed layout. */
export interface ImageRequest {
  readonly prompt: unknown;
  readonly width: number;
  readonly height: number;
  readonly seed?: number;
  readonly steps?: number;
  readonly guidance?: number;
  readonly negativePrompt?: string;
  readonly enhance: boolean;
  readonly watermark: boolean;
}

/** A drawn image: where to fetch it (signed, short-lived), and what the vendor says it made. */
export interface GeneratedImage {
  readonly url: string;
  readonly usage: { readonly images: number; readonly width: number; readonly height: number };
}

/** An image call that gave no image: refused by the vendor, or with no answer to say whether it ran (and was paid for). */
export class ImageFailure extends Schema.TaggedError<ImageFailure, { readonly brand: unique symbol }>()("ImageFailure", {
  outcome: Schema.Literals(["Rejected", "Unknown"]),
}) {}

/** A vendor an account is of: its name, where its keys are made, and the models it has for each thing it serves. */
export interface Vendor {
  readonly name: string;
  readonly console: string;
  readonly image?: { readonly models: readonly string[] };
}

/** Every vendor, by the adapter an account names. How each one is called is the Provider's business (provider.ts). */
export const vendors: Record<"moss", Vendor> = {
  moss: { name: "MOSS", console: "https://platform.moss.cn/", image: { models: mossImageModels } },
};

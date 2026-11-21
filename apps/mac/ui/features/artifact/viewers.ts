import { z } from "zod";

export interface StorePropDef {
  readonly name: string;
  readonly label?: string;
  readonly type: "select" | "boolean" | "number" | "text" | "color";
  readonly options?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly value: string | number | boolean;
}

export interface StoreProvenanceMark {
  readonly source: string;
  readonly field: string;
  readonly agg: string;
  readonly displayed: string;
  readonly expected: string;
  readonly matched: boolean;
}

const StorePropDefSchema = z.object({
  name: z.string().max(100),
  label: z.exactOptional(z.string().max(200)),
  type: z.enum(["select", "boolean", "number", "text", "color"]),
  options: z.exactOptional(z.array(z.string().max(200)).max(50)),
  min: z.exactOptional(z.number()),
  max: z.exactOptional(z.number()),
  step: z.exactOptional(z.number()),
  value: z.union([z.string().max(500), z.number(), z.boolean()]),
});

const StoreProvenanceMarkSchema = z.object({
  source: z.string().max(200),
  field: z.string().max(200),
  agg: z.string().max(50),
  displayed: z.string().max(200),
  expected: z.string().max(200),
  matched: z.boolean(),
});

const ParamPrimitive = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);

export const StoreBridgeMessageSchema = z.discriminatedUnion("vibevalley", [
  z.object({
    vibevalley: z.literal("store-provenance"),
    marks: z.array(StoreProvenanceMarkSchema).max(500),
    verified: z.number().int().min(0),
    mismatches: z.number().int().min(0),
  }),
  z.object({
    vibevalley: z.literal("store-mark-click"),
    source: z.string().max(200),
    field: z.string().max(200),
  }),
  z.object({
    vibevalley: z.literal("store-params"),
    params: z.record(z.string().max(100), ParamPrimitive),
  }),
  z.object({
    vibevalley: z.literal("store-props"),
    path: z.string().max(240),
    props: z.array(StorePropDefSchema).max(100),
  }),
  z.object({
    vibevalley: z.literal("store-embed-save"),
    elementId: z.string().max(200),
    state: z.record(z.string().max(100), ParamPrimitive),
  }),
]);

export type StoreBridgeMessage = z.output<typeof StoreBridgeMessageSchema>;

export function storeMessageOf(data: unknown): StoreBridgeMessage | undefined {
  const got = StoreBridgeMessageSchema.safeParse(data);
  return got.success ? got.data : undefined;
}

import { z } from "zod";

import type { Codec } from "../codec";
import type * as T from "./shapes.gen";

export const OrchestratorEvalRequest = z.object({
  agent: z.exactOptional(z.string()),
  on: z.number(),
  want: z.string(),
}) satisfies Codec<T.OrchestratorEvalRequest>;

export const OrchestratorEval = z.object({
  id: z.string(),
  file: z.string(),
}) satisfies Codec<T.OrchestratorEval>;

export const OrchestratorApprovalListInput = z.object({
  conversationId: z.exactOptional(z.string()),
}) satisfies Codec<T.OrchestratorApprovalListInput>;

export const OrchestratorApproval = z.object({
  conversationId: z.string(),
  taskId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  argumentsJson: z.string(),
  reason: z.string(),
  requestedAtMs: z.int(),
}) satisfies Codec<T.OrchestratorApproval>;

export const OrchestratorApprovalResolveInput = z.object({
  conversationId: z.string(),
  taskId: z.string(),
  toolCallId: z.string(),
  approved: z.boolean(),
  reason: z.exactOptional(z.string()),
}) satisfies Codec<T.OrchestratorApprovalResolveInput>;

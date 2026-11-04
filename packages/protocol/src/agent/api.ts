// The endpoints of profiles, templates and skills: their answers (AgentHandlers) and their lines in the table (api.ts puts the
// concepts together).

import { type Effect, Schema } from "effect";

import { type ApiError, type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

const agentDeleteInput = input({ id: Schema.String });
const skillDeleteInput = input({ id: Schema.String });

export interface AgentHandlers<R = never> {
  readonly "agent.list": () => Effect.Effect<T.Agent[], ApiError, R>;
  /** The issues of each profile as it would be dispatched now; a draft not saved yet too. */
  readonly "agent.validate": (a: T.AgentValidateRequest) => Effect.Effect<T.AgentValidation[], ApiError, R>;
  /** Create allocates an identity; callers with an existing identity use save. */
  readonly "agent.create": (a: T.Agent) => Effect.Effect<T.Agent, ApiError, R>;
  readonly "agent.update": (a: T.Agent) => Effect.Effect<T.Agent, ApiError, R>;
  readonly "agent.delete": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  /** What delete would do, refused as it would be; nothing changes. */
  readonly "agent.previewDelete": (a: { readonly id: string }) => Effect.Effect<T.Preview, ApiError, R>;
  /** The templates a profile can be installed from: the built-in ones, then those added on this machine. */
  readonly "agent.template.list": () => Effect.Effect<T.AgentTemplate[], ApiError, R>;
  /** A new profile from a template; installing one again makes another. */
  readonly "agent.template.install": (a: { readonly id: string }) => Effect.Effect<T.Agent, ApiError, R>;
  /** A profile made again from its template's version now: what came from the template is replaced, what is the
   * machine's (environment, default project, on or off) stays. */
  readonly "agent.template.update": (a: { readonly agent: string }) => Effect.Effect<T.Agent, ApiError, R>;
  /** A template folder on this machine copied in beside the built-in ones; nothing is installed. */
  readonly "agent.template.add": (a: { readonly path: string }) => Effect.Effect<T.AgentTemplate, ApiError, R>;
  /** An added template gone; the profiles installed from it stay. */
  readonly "agent.template.delete": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  /** What deleting the template would do, refused as it would be; nothing changes. */
  readonly "agent.template.previewDelete": (a: { readonly id: string }) => Effect.Effect<T.Preview, ApiError, R>;
  readonly "skill.list": () => Effect.Effect<T.Skill[], ApiError, R>;
  /** Create allocates an identity; callers with an existing identity use save. */
  readonly "skill.create": (a: T.Skill) => Effect.Effect<T.Skill, ApiError, R>;
  readonly "skill.update": (a: T.Skill) => Effect.Effect<T.Skill, ApiError, R>;
  readonly "skill.delete": (a: { readonly id: string }) => Effect.Effect<void, ApiError, R>;
  /** What delete would do, refused as it would be; nothing changes. */
  readonly "skill.previewDelete": (a: { readonly id: string }) => Effect.Effect<T.Preview, ApiError, R>;
}

export const agentEndpoints: readonly Endpoint[] = [
  {
    op: "agent.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.Agent)),
    can: ["owner", "remote"],
  },
  {
    op: "agent.validate",
    about: [],
    input: S.AgentValidateRequest,
    result: Schema.mutable(Schema.Array(S.AgentValidation)),
    can: ["owner", "remote"],
  },
  {
    op: "agent.create",
    about: [],
    input: S.Agent,
    result: S.Agent,
    can: ["owner"],
  },
  {
    op: "agent.update",
    about: ["id"],
    input: S.Agent,
    result: S.Agent,
    can: ["owner"],
  },
  {
    op: "agent.delete",
    about: ["id"],
    input: agentDeleteInput,
    result: undefined,
    can: ["owner"],
    dryRun: "agent.previewDelete",
  },
  {
    op: "agent.previewDelete",
    about: ["id"],
    input: agentDeleteInput,
    result: S.Preview,
    can: ["owner"],
  },
  {
    op: "agent.template.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.AgentTemplate)),
    can: ["owner", "remote"],
  },
  {
    op: "agent.template.install",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.Agent,
    can: ["owner"],
  },
  {
    op: "agent.template.update",
    about: ["agent"],
    input: input({ agent: Schema.String }),
    result: S.Agent,
    can: ["owner"],
  },
  {
    op: "agent.template.add",
    about: ["path"],
    input: input({ path: Schema.String }),
    result: S.AgentTemplate,
    can: ["owner"],
  },
  {
    op: "agent.template.delete",
    about: ["id"],
    input: agentDeleteInput,
    result: undefined,
    can: ["owner"],
    dryRun: "agent.template.previewDelete",
  },
  {
    op: "agent.template.previewDelete",
    about: ["id"],
    input: agentDeleteInput,
    result: S.Preview,
    can: ["owner"],
  },
  {
    op: "skill.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.Skill)),
    can: ["owner", "remote"],
  },
  {
    op: "skill.create",
    about: [],
    input: S.Skill,
    result: S.Skill,
    can: ["owner"],
  },
  {
    op: "skill.update",
    about: ["id"],
    input: S.Skill,
    result: S.Skill,
    can: ["owner"],
  },
  {
    op: "skill.delete",
    about: ["id"],
    input: skillDeleteInput,
    result: undefined,
    can: ["owner"],
    dryRun: "skill.previewDelete",
  },
  {
    op: "skill.previewDelete",
    about: ["id"],
    input: skillDeleteInput,
    result: S.Preview,
    can: ["owner"],
  },
];

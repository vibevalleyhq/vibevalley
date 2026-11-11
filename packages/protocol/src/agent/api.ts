import { z } from "zod";

import { type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

const agentDeleteInput = input({ id: z.string() });
const skillDeleteInput = input({ id: z.string() });

export interface AgentHandlers {
  readonly "agent.list": () => Promise<T.Agent[]>;
  /** The issues of each profile as it would be dispatched now; a draft not saved yet too. */
  readonly "agent.validate": (a: T.AgentValidateRequest) => Promise<T.AgentValidation[]>;
  /** Create allocates an identity; callers with an existing identity use save. */
  readonly "agent.create": (a: T.Agent) => Promise<T.Agent>;
  readonly "agent.update": (a: T.Agent) => Promise<T.Agent>;
  readonly "agent.delete": (a: { readonly id: string }) => Promise<void>;
  /** What delete would do, refused as it would be; nothing changes. */
  readonly "agent.previewDelete": (a: { readonly id: string }) => Promise<T.Preview>;
  /** The templates a profile can be installed from: the built-in ones, then those added on this machine. */
  readonly "agent.template.list": () => Promise<T.AgentTemplate[]>;
  /** A new profile from a template; installing one again makes another. */
  readonly "agent.template.install": (a: { readonly id: string }) => Promise<T.Agent>;
  /** A profile made again from its template's version now. */
  readonly "agent.template.update": (a: { readonly agent: string }) => Promise<T.Agent>;
  /** A template folder on this machine copied in beside the built-in ones; nothing is installed. */
  readonly "agent.template.add": (a: { readonly path: string }) => Promise<T.AgentTemplate>;
  /** An added template gone; the profiles installed from it stay. */
  readonly "agent.template.delete": (a: { readonly id: string }) => Promise<void>;
  /** What deleting the template would do, refused as it would be; nothing changes. */
  readonly "agent.template.previewDelete": (a: { readonly id: string }) => Promise<T.Preview>;
  readonly "skill.list": () => Promise<T.Skill[]>;
  /** Create allocates an identity; callers with an existing identity use save. */
  readonly "skill.create": (a: T.Skill) => Promise<T.Skill>;
  readonly "skill.update": (a: T.Skill) => Promise<T.Skill>;
  readonly "skill.delete": (a: { readonly id: string }) => Promise<void>;
  /** What delete would do, refused as it would be; nothing changes. */
  readonly "skill.previewDelete": (a: { readonly id: string }) => Promise<T.Preview>;
}

export const agentEndpoints: readonly Endpoint[] = [
  {
    op: "agent.list",
    about: [],
    input: undefined,
    result: z.array(S.Agent),
    can: ["user", "remote"],
  },
  {
    op: "agent.validate",
    about: [],
    input: S.AgentValidateRequest,
    result: z.array(S.AgentValidation),
    can: ["user", "remote"],
  },
  {
    op: "agent.create",
    about: [],
    input: S.Agent,
    result: S.Agent,
    can: ["user"],
  },
  {
    op: "agent.update",
    about: ["id"],
    input: S.Agent,
    result: S.Agent,
    can: ["user"],
  },
  {
    op: "agent.delete",
    about: ["id"],
    input: agentDeleteInput,
    result: undefined,
    can: ["user"],
    dryRun: "agent.previewDelete",
  },
  {
    op: "agent.previewDelete",
    about: ["id"],
    input: agentDeleteInput,
    result: S.Preview,
    can: ["user"],
  },
  {
    op: "agent.template.list",
    about: [],
    input: undefined,
    result: z.array(S.AgentTemplate),
    can: ["user", "remote"],
  },
  {
    op: "agent.template.install",
    about: ["id"],
    input: input({ id: z.string() }),
    result: S.Agent,
    can: ["user"],
  },
  {
    op: "agent.template.update",
    about: ["agent"],
    input: input({ agent: z.string() }),
    result: S.Agent,
    can: ["user"],
  },
  {
    op: "agent.template.add",
    about: ["path"],
    input: input({ path: z.string() }),
    result: S.AgentTemplate,
    can: ["user"],
  },
  {
    op: "agent.template.delete",
    about: ["id"],
    input: agentDeleteInput,
    result: undefined,
    can: ["user"],
    dryRun: "agent.template.previewDelete",
  },
  {
    op: "agent.template.previewDelete",
    about: ["id"],
    input: agentDeleteInput,
    result: S.Preview,
    can: ["user"],
  },
  {
    op: "skill.list",
    about: [],
    input: undefined,
    result: z.array(S.Skill),
    can: ["user", "remote"],
  },
  {
    op: "skill.create",
    about: [],
    input: S.Skill,
    result: S.Skill,
    can: ["user"],
  },
  {
    op: "skill.update",
    about: ["id"],
    input: S.Skill,
    result: S.Skill,
    can: ["user"],
  },
  {
    op: "skill.delete",
    about: ["id"],
    input: skillDeleteInput,
    result: undefined,
    can: ["user"],
    dryRun: "skill.previewDelete",
  },
  {
    op: "skill.previewDelete",
    about: ["id"],
    input: skillDeleteInput,
    result: S.Preview,
    can: ["user"],
  },
];

import { Option, Schema } from "effect";
import * as SecureStore from "expo-secure-store";

import { t } from "@vibevalley/i18n";
import { pathOf } from "@vibevalley/protocol";
import { ApiErrorEnvelope, apiSuccessEnvelope } from "@vibevalley/protocol/api";
import * as S from "@vibevalley/protocol/schema";

import { type PairLink, parsePairLink } from "./pairing";

export interface Farm {
  readonly url: string;
  readonly key: string;
  readonly hostName: string;
}

export interface Pairing {
  readonly kind: "pairing";
  readonly link?: PairLink;
  readonly name: string;
  readonly asking: boolean;
  readonly problem: string;
}

type FarmChoice = { readonly kind: "loading" } | { readonly kind: "farm"; readonly farm: Farm } | Pairing;

const where = "vibevalley.farm";

const StoredFarm = Schema.fromJsonString(
  Schema.Struct({
    url: Schema.NonEmptyString,
    key: Schema.NonEmptyString,
    hostName: Schema.String,
  }),
);
const PairedAnswer = Schema.fromJsonString(apiSuccessEnvelope(S.LanPaired));
const RefusedAnswer = Schema.fromJsonString(ApiErrorEnvelope);

async function readFarm(): Promise<Farm | undefined> {
  const text = await SecureStore.getItemAsync(where);
  if (!text) return undefined;
  return Option.getOrUndefined(Schema.decodeUnknownOption(StoredFarm)(text));
}

const writeFarm = (farm: Farm | undefined) => (farm ? SecureStore.setItemAsync(where, JSON.stringify(farm)) : SecureStore.deleteItemAsync(where));
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class FarmConnection {
  private choice: FarmChoice = { kind: "loading" };
  private committed?: Farm;
  private active = false;
  private revision = 0;
  private request?: AbortController;
  private writes: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly defaultName: string) {}

  snapshot = () => this.choice;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(choice: FarmChoice) {
    if (!this.active) return;
    this.choice = choice;
    for (const listener of this.listeners) listener();
  }

  private pairing(link?: PairLink): Pairing {
    return { kind: "pairing", ...(link ? { link } : {}), name: this.defaultName, asking: false, problem: "" };
  }

  private replace() {
    this.request?.abort();
    this.request = undefined;
    return ++this.revision;
  }

  private owns(revision: number) {
    return this.active && this.revision === revision;
  }

  private serialize<A>(work: () => Promise<A>): Promise<A> {
    const result = this.writes.then(work);
    this.writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async start() {
    if (this.active) return;
    this.active = true;
    const revision = this.replace();
    this.publish({ kind: "loading" });
    try {
      await this.serialize(async () => {
        this.committed = await readFarm();
      });
      if (this.owns(revision)) this.publish(this.committed ? { kind: "farm", farm: this.committed } : this.pairing());
    } catch (e) {
      if (this.owns(revision)) this.publish({ ...this.pairing(), problem: t("mobile.cannotRead", { why: reason(e) }) });
    }
  }

  close = () => {
    this.active = false;
    this.replace();
  };

  select(link: PairLink) {
    this.replace();
    this.publish(this.pairing(link));
  }

  setName(name: string) {
    if (this.choice.kind === "pairing") this.publish({ ...this.choice, name });
  }

  /** Opening a pairing link is already the user's request to ask for entry. */
  async openLink(text: string) {
    const link = parsePairLink(text);
    if (!link) return;
    this.select(link);
    await this.pair();
  }

  async pair() {
    const choice = this.choice;
    if (!this.active || choice.kind !== "pairing" || !choice.link || choice.asking) return;
    const revision = this.replace();
    const request = new AbortController();
    this.request = request;
    this.publish({ ...choice, asking: true, problem: "" });
    try {
      let response: Response;
      try {
        response = await fetch(choice.link.url + pathOf("lan.pair"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: choice.link.code, name: choice.name.trim() }),
          signal: request.signal,
        });
      } catch {
        throw new Error(t("mobile.unreachable"));
      }
      const text = await response.text();
      if (!this.owns(revision)) return;
      if (!response.ok) {
        const refused = Option.getOrUndefined(Schema.decodeUnknownOption(RefusedAnswer)(text));
        const problem = refused?.message ?? text;
        throw new Error(problem || t("mobile.answered", { status: response.status }));
      }
      const paired = Option.getOrUndefined(Schema.decodeUnknownOption(PairedAnswer)(text))?.data;
      if (!paired) throw new Error(t("mobile.answered", { status: response.status }));
      const farm: Farm = { url: choice.link.url, key: paired.key, hostName: paired.hostName };
      await this.serialize(async () => {
        if (!this.owns(revision)) return;
        try {
          await writeFarm(farm);
        } catch (e) {
          throw new Error(t("mobile.cannotSave", { why: reason(e) }), { cause: e });
        }
        if (!this.owns(revision)) {
          try {
            await writeFarm(this.committed);
          } catch (e) {
            if (this.choice.kind === "pairing") this.publish({ ...this.choice, problem: t("mobile.cannotRestore", { why: reason(e) }) });
          }
          return;
        }
        this.committed = farm;
        this.publish({ kind: "farm", farm });
      });
    } catch (e) {
      if (this.owns(revision)) this.publish({ ...choice, asking: false, problem: reason(e) });
    } finally {
      if (this.owns(revision)) this.request = undefined;
    }
  }

  async cancel() {
    const revision = this.replace();
    this.publish(this.pairing());
    try {
      await this.serialize(async () => {
        if (!this.owns(revision)) return;
        await writeFarm(this.committed);
        if (this.owns(revision)) this.publish(this.committed ? { kind: "farm", farm: this.committed } : this.pairing());
      });
    } catch (e) {
      if (this.owns(revision)) this.publish({ ...this.pairing(), problem: t("mobile.cannotRestore", { why: reason(e) }) });
    }
  }

  async forget() {
    const revision = this.replace();
    this.publish(this.pairing());
    try {
      await this.serialize(async () => {
        await writeFarm(undefined);
        this.committed = undefined;
      });
    } catch (e) {
      if (this.owns(revision)) this.publish({ ...this.pairing(), problem: t("mobile.cannotForget", { why: reason(e) }) });
    }
  }
}

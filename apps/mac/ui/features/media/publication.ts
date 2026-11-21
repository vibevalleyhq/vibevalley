import { sha256Hex } from "../../infra/api";

export function publicationKey(job: string, channel: string): Promise<string> {
  return sha256Hex(JSON.stringify(["media", job, channel]));
}

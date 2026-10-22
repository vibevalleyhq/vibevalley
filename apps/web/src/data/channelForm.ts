// Making a channel or changing one, as both chat windows carry it out: the workbench's dialogs (pages/chat/Dialogs.tsx)
// and the farm's menu (farm/chat/ChannelMenu.tsx). This keeps the fields, the busy flag and the server's refusal; a
// window only draws them and says what happens once it went through.

import { createSignal, untrack } from "solid-js";
import type { Conversation } from "@vibevalley/protocol";
import { api, reasonOf } from "./api";

/** The form for a new channel, or for the one given as it is when opened (the form edits its own copy). */
export function createChannelForm(channel?: Conversation) {
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal(untrack(() => channel?.description ?? ""));
  const [project, setProject] = createSignal(untrack(() => channel?.project ?? ""));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();

  /** The channel's id once it went through; undefined, with the reason in error, when refused. */
  const save = async (): Promise<string | undefined> => {
    setBusy(true);
    setError(undefined);
    try {
      if (channel) {
        await api.channel.update({ id: channel.id, body: { description: description(), project: project() } });
        return channel.id;
      }
      return await api.channel.create({
        body: { name: name().trim(), description: description().trim() || undefined, project: project().trim() || undefined },
      });
    } catch (e) {
      setError(reasonOf(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  return {
    name,
    setName: (v: string) => {
      setName(v);
      setError(undefined);
    },
    description,
    setDescription,
    project,
    setProject,
    busy,
    error,
    /** Pressing save now would be sent: not busy, and a new channel has a name. */
    ready: () => !busy() && (channel !== undefined || name().trim() !== ""),
    save,
  };
}

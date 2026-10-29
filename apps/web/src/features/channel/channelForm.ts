// Making a channel or changing one, as both chat windows carry it out: the workbench's dialogs (features/channel/Dialogs.tsx)
// and the farm's menu (farm/chat/ChannelMenu.tsx). This keeps the fields, the busy flag and the server's refusal; a
// window only draws them and says what happens once it went through.

import { createSignal, untrack } from "solid-js";
import { type Channel, defaultOrchestrator, type Notify } from "@vibevalley/protocol";
import { api, reasonOf } from "@/base/api";
import { omitUndefined } from "@vibevalley/protocol/rules";
/** The form for a new channel, or for the one given as it is when opened (the form edits its own copy). */
export function createChannelForm(channel?: Channel) {
  const was = untrack(() => ({
    name: channel?.name ?? "",
    description: channel?.description ?? "",
    project: channel?.project ?? "",
    category: channel?.category ?? "",
    notify: channel?.notify ?? "all",
    orchestrator: channel?.orchestrator ?? defaultOrchestrator,
  }));
  const [name, setName] = createSignal(was.name);
  const [description, setDescription] = createSignal(was.description);
  const [project, setProject] = createSignal(was.project);
  const [category, setCategory] = createSignal(was.category);
  const [notify, setNotify] = createSignal<Notify>(was.notify);
  const [orchestrator, setOrchestrator] = createSignal(was.orchestrator);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();

  /** The channel's id once it went through; undefined, with the reason in error, when refused. */
  const save = async (): Promise<string | undefined> => {
    setBusy(true);
    setError(undefined);
    try {
      if (channel) {
        // A direct channel has only its notifications to change.
        if (channel.type === "channel")
          await api.channel.update({
            id: channel.id,
            description: description(),
            project: project(),
            category: category().trim(),
            ...(name().trim() !== was.name ? { name: name().trim() } : {}),
            ...(orchestrator() !== was.orchestrator ? { orchestrator: orchestrator() } : {}),
          });
        if (notify() !== was.notify) await api.channel.notify.set({ id: channel.id, notify: notify() });
        return channel.id;
      }
      return await api.channel.create(
        omitUndefined({ name: name().trim(), description: description().trim() || undefined, project: project().trim() || undefined }),
      );
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
    category,
    setCategory,
    notify,
    setNotify,
    /** The orchestrator that looks after the channel, by its profile id. */
    orchestrator,
    setOrchestrator,
    busy,
    error,
    /** Pressing save now would be sent: not busy, and a new channel has a name. */
    ready: () => !busy() && (channel !== undefined || name().trim() !== ""),
    save,
  };
}

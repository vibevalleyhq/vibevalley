// Making a channel or changing one, as both chat windows carry it out: the workbench's dialogs (features/channel/Dialogs.tsx)
// and the farm's menu (farm/chat/ChannelMenu.tsx). This keeps the fields, the busy flag and the server's refusal; a
// window only draws them and says what happens once it went through.

import { createSignal, untrack } from "solid-js";

import { type Channel, defaultOrchestrator, type Notify } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { api } from "@/infra/api";
import { createAct } from "@/ui/act";
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
  const [error, setError] = createSignal<string>();
  // A refusal is said in the form, beside what it refuses, rather than in a toast.
  const act = createAct(setError);
  const busy = act.busy;

  /** The channel's id once it went through; undefined, with the reason in error, when refused. */
  const save = (): Promise<string | undefined> => {
    setError(undefined);
    // Read as the owner saves: the form may change while the call waits.
    const now = {
      name: name().trim(),
      description: description(),
      project: project(),
      category: category().trim(),
      notify: notify(),
      orchestrator: orchestrator(),
    };
    return act.run(async () => {
      if (!channel)
        return api.channel.create(
          omitUndefined({ name: now.name, description: now.description.trim() || undefined, project: now.project.trim() || undefined }),
        );
      // A direct channel has only its notifications to change.
      if (channel.type === "channel")
        await api.channel.update({
          id: channel.id,
          description: now.description,
          project: now.project,
          category: now.category,
          ...(now.name !== was.name ? { name: now.name } : {}),
          ...(now.orchestrator !== was.orchestrator ? { orchestrator: now.orchestrator } : {}),
        });
      if (now.notify !== was.notify) await api.channel.notify.set({ id: channel.id, notify: now.notify });
      return channel.id;
    });
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

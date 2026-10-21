// A channel has no members to pick: helpers are in the channel their job was arranged in.

import { type FormEvent, type ReactNode, useState } from "react";
import type { Conversation } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { useProjects } from "../../data/projects";
import { channelName } from "../../rules/chat";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Field, TextArea, TextInput } from "../../ui/Field";

function ProjectInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const projects = useProjects().data ?? [];
  return (
    <>
      <TextInput value={value} onChange={(e) => onChange(e.target.value)} placeholder="比如 clock-in" list="chat-projects" />
      <datalist id="chat-projects">
        {projects.map((p) => (
          <option key={p.name} value={p.name} />
        ))}
      </datalist>
    </>
  );
}

function Form({
  submit,
  onSubmit,
  onCancel,
  busy,
  error,
  ready = true,
  children,
}: {
  submit: string;
  onSubmit: () => Promise<void>;
  onCancel: () => void;
  busy: boolean;
  error?: string;
  ready?: boolean;
  children: ReactNode;
}) {
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (ready && !busy) void onSubmit();
      }}
    >
      {children}
      {error && <p className="text-sm text-berry">{error}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <Button onClick={onCancel}>取消</Button>
        <Button type="submit" tone="primary" disabled={busy || !ready}>
          {submit}
        </Button>
      </div>
    </form>
  );
}

/** onCreated gets the new channel's id. */
export function NewChannelDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="创建频道">
      <NewChannelForm onClose={onClose} onCreated={onCreated} />
    </Dialog>
  );
}

function NewChannelForm({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    setBusy(true);
    try {
      const id = await api.channel.create({ body: { name, description: description.trim() || undefined, project: project.trim() || undefined } });
      onCreated(id);
      onClose();
    } catch (e) {
      setError(reasonOf(e));
      setBusy(false);
    }
  };
  return (
    <Form submit="创建频道" onSubmit={submit} onCancel={onClose} busy={busy} error={error} ready={name.trim() !== ""}>
      <Field label="名称" hint="字母、数字、汉字、- 和 _，不超过 24 个字">
        <TextInput
          autoFocus
          required
          value={name}
          placeholder="例如 clock-in"
          onChange={(e) => {
            setName(e.target.value);
            setError(undefined);
          }}
        />
      </Field>
      <Field label="描述（可不填）">
        <TextArea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="这个频道是做什么的？" />
      </Field>
      <Field label="默认项目（可不填）" hint="在这个频道里派活、没说项目时，就在这个项目里干">
        <ProjectInput value={project} onChange={setProject} />
      </Field>
    </Form>
  );
}

export function ChannelSettingsDialog({ channel, open, onClose }: { channel: Conversation; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={`# ${channelName(channel)} 的设置`}>
      <ChannelSettingsForm key={channel.id} channel={channel} onClose={onClose} />
    </Dialog>
  );
}

function ChannelSettingsForm({ channel, onClose }: { channel: Conversation; onClose: () => void }) {
  const [description, setDescription] = useState(channel.description ?? "");
  const [project, setProject] = useState(channel.project ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    setBusy(true);
    try {
      await api.channel.update({ id: channel.id, body: { description, project } });
      onClose();
    } catch (e) {
      setError(reasonOf(e));
      setBusy(false);
    }
  };
  return (
    <Form submit="保存" onSubmit={submit} onCancel={onClose} busy={busy} error={error}>
      <Field label="描述（可不填）">
        <TextArea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="这个频道是做什么的？" />
      </Field>
      <Field label="默认项目（可不填）" hint="空着就没有：派活时管家要问在哪个项目">
        <ProjectInput value={project} onChange={setProject} />
      </Field>
    </Form>
  );
}

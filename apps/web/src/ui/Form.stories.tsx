import * as stylex from "@stylexjs/stylex";
import { Schema } from "effect";
import { createSignal, onCleanup } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { useForm, type Submission } from "#/infra/form.ts";

import { Button } from "./Button";
import { TextInput } from "./Field";
import { Form, FormField, formControl, formMessages } from "./Form";

const viewStyles = stylex.create({
  form: { display: "flex", flexDirection: "column", gap: "0.75rem" },
  editorDiv: {
    display: "flex",
    maxWidth: "var(--container-md)",
    flexDirection: "column",
    gap: "0.75rem",
    padding: "1rem",
  },
});

const Input = Schema.Struct({
  name: Schema.Trim.check(Schema.isMinLength(1)),
  amount: Schema.Trim.check(Schema.isMinLength(1)).pipe(Schema.decodeTo(Schema.FiniteFromString)),
});
function Editor() {
  const [writes, setWrites] = createSignal(0);
  let reply: ((accepted: boolean) => void) | undefined;
  const form = useForm({
    schema: Input,
    defaultValues: { name: "", amount: "1" },
    messages: formMessages,
    onSubmit: (value, attempt): Promise<Submission<number>> => {
      setWrites((n) => n + 1);
      return new Promise((resolve) => {
        reply = (accepted) => {
          if (accepted) {
            form.reset({ name: value.name, amount: String(value.amount) }, { ifRevision: attempt.revision });
            resolve({ kind: "accepted", receipt: value.amount });
          } else resolve({ kind: "unknown", message: formMessages.unknown });
          reply = undefined;
        };
      });
    },
  });
  onCleanup(() => reply?.(false));
  const name = form.field(["name"]);
  const amount = form.field(["amount"]);
  return (
    <div {...stylex.attrs(viewStyles.editorDiv)}>
      <Form form={form} testid="form-demo" styles={viewStyles.form}>
        <FormField field={name} label="Name">
          <TextInput {...formControl(name)} data-testid="form-name" value={name.value()} onInput={(event) => name.setValue(event.currentTarget.value)} />
        </FormField>
        <FormField field={amount} label="Amount">
          <TextInput
            {...formControl(amount)}
            data-testid="form-amount"
            value={amount.value()}
            onInput={(event) => amount.setValue(event.currentTarget.value)}
          />
        </FormField>
        <Button type="submit" data-testid="form-submit" disabled={form.submitting()}>
          Submit
        </Button>
      </Form>
      <output data-testid="form-writes" data-dirty={String(form.dirty())}>
        {writes()}
      </output>
      <Button data-testid="form-accepted" onClick={() => reply?.(true)}>
        Accepted receipt
      </Button>
      <Button data-testid="form-unknown" onClick={() => reply?.(false)}>
        Unknown delivery
      </Button>
    </div>
  );
}
export default stories({ title: "组件/工作台/Form", stories: { Receipts: story({ render: Editor }) } });

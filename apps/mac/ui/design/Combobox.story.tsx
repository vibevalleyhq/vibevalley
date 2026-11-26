import "../infra/polyfill";
import { mount, signal, Text, View } from "nsh";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";

import { Combobox, type ComboboxOption } from "./Combobox";
import { Select } from "./Field";

setLocale("en");

const repoOptions: readonly ComboboxOption[] = [
  { value: "vibevalley", label: "VibeValley Core", group: "Active" },
  { value: "papertrails", label: "Papertrails Assets", group: "Active" },
  { value: "nsh-ui", label: "NSH UI Runtime", group: "Platform" },
  { value: "archived-old", label: "Legacy Archive", disabled: true, group: "Platform" },
];

const tagOptions: readonly ComboboxOption[] = [
  { value: "arch", label: "Architecture" },
  { value: "ux", label: "UX Polish" },
  { value: "perf", label: "Performance" },
  { value: "a11y", label: "Accessibility" },
];

const manyOptions: readonly ComboboxOption[] = Array.from({ length: 24 }, (_, idx) => ({
  value: `item-${idx + 1}`,
  label: `Option ${idx + 1}`,
}));

const enumOptions = [
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In Progress" },
  { value: "done", label: "Done" },
] as const;

function ComboboxBench() {
  const single = signal("");
  const multi = signal<string[]>(["arch"]);
  const bounded = signal("");
  const enumVal = signal<"todo" | "in_progress" | "done">("in_progress");
  const searchableVal = signal("");

  return (
    <View testID="combobox-bench" class="flex-1 gap-4 bg-page p-6">
      <View class="gap-1">
        <Combobox
          testid="combo-single"
          label="Single repository"
          placeholder="Select a repository"
          clearable
          value={single()}
          options={repoOptions}
          onChange={(next) => single.set(next)}
        />
        <Text testID="combo-single-value">{`single:${single() || "none"}`}</Text>
      </View>

      <View class="gap-1">
        <Combobox
          testid="combo-multi"
          label="Tags"
          placeholder="Filter tags..."
          multiple
          clearable
          value={multi()}
          options={tagOptions}
          onChange={(next) => multi.set(next)}
        />
        <Text testID="combo-multi-value">{`multi:${multi().join(",") || "none"}`}</Text>
      </View>

      <View class="gap-1">
        <Combobox
          testid="combo-bounded"
          label="Long list"
          placeholder="Choose from 24 items"
          clearable
          value={bounded()}
          options={manyOptions}
          onChange={(next) => bounded.set(next)}
        />
      </View>

      <View class="flex-row items-center gap-3">
        <Select testid="select-enum" class="w-44" label="Status" value={enumVal()} options={enumOptions} onChange={(v) => enumVal.set(v)} />
        <Select
          testid="select-searchable"
          class="w-48"
          label="Searchable select"
          placeholder="Pick repo"
          searchable
          value={searchableVal()}
          options={repoOptions}
          onChange={(v) => searchableVal.set(v)}
        />
      </View>
    </View>
  );
}

mount(() => <ComboboxBench />);

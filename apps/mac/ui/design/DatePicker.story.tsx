import "../infra/polyfill";
import { mount, signal, Text, View } from "nsh";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";

import { SCENARIO_NOW } from "../fixtures/scenarios";
import { Calendar, DatePicker, type DateInputValue, EpochDatePicker } from "./DatePicker";

setLocale("zh");

function singleText(v: DateInputValue | undefined): string {
  return typeof v === "string" ? v : "none";
}

function rangeText(v: DateInputValue | undefined): string {
  return Array.isArray(v) ? `${v[0] ?? ""}:${v[1] ?? ""}` : "none";
}

function DatePickerBench() {
  const isoSingle = signal<DateInputValue | undefined>("2026-11-20");
  const isoRange = signal<DateInputValue | undefined>(undefined);
  const epochMs = signal<number | undefined>(Date.UTC(2026, 10, 20));
  const calValue = signal<DateInputValue | undefined>("2026-10-15");

  return (
    <View testID="datepicker-bench" class="flex-1 gap-4 bg-page p-6">
      <View class="w-64 gap-1">
        <DatePicker label="ISO Date" testid="dp-iso" value={isoSingle()} nowMs={SCENARIO_NOW} onChange={(v) => isoSingle.set(v)} />
        <View testID="dp-iso-out">
          <Text>{singleText(isoSingle())}</Text>
        </View>
      </View>

      <View class="w-64 gap-1">
        <DatePicker label="Range Date" testid="dp-range" range value={isoRange()} nowMs={SCENARIO_NOW} onChange={(v) => isoRange.set(v)} />
        <View testID="dp-range-out">
          <Text>{rangeText(isoRange())}</Text>
        </View>
      </View>

      <View class="w-64 gap-1">
        <EpochDatePicker
          label="Epoch Date"
          testid="dp-epoch"
          quiet
          size="control"
          value={epochMs()}
          nowMs={SCENARIO_NOW}
          onChange={(ms) => epochMs.set(ms > 0 ? ms : undefined)}
        />
        <View testID="dp-epoch-out">
          <Text>{String(epochMs() ?? 0)}</Text>
        </View>
      </View>

      <View class="w-64 gap-1">
        <DatePicker label="Disabled Date" testid="dp-disabled" disabled value="2026-11-20" nowMs={SCENARIO_NOW} />
      </View>

      <View class="w-64 rounded-lg border border-line bg-elevated p-2.5">
        <Calendar testid="cal-standalone" value={calValue()} onChange={(v) => calValue.set(v)} />
        <View testID="cal-out">
          <Text>{singleText(calValue())}</Text>
        </View>
      </View>
    </View>
  );
}

mount(() => <DatePickerBench />);

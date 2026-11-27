import { colorScheme, signal, Text, View } from "nsh";

import type { SessionEvent, TrajectoryWaterfall } from "@vibevalley/protocol";

import { Bubble } from "../../../design/Tip";
import { tone } from "../../../design/tone";
import { createMemo } from "../../../infra/solid";
import { lanes, projectTrajectory, secondsText, waterfallWidths } from "../runs";
import { laneNames } from "./model";

/** Runs side by side by how long each took; the idle time between them is a fixed gap. */
export function WaterfallView(props: {
  steps: SessionEvent[];
  waterfall?: TrajectoryWaterfall | undefined;
  end: number;
  selectedSeq?: number | undefined;
  colorOf: (seq: number) => string;
  summaryOf: (seq: number) => string;
  onPick: (seq: number) => void;
}) {
  const width = signal(0);
  const lane = 12;
  const gap = 3;
  const between = 4;
  const bars = createMemo(() => {
    colorScheme();
    const fall = props.waterfall ?? projectTrajectory(props.steps, props.end)?.waterfall ?? { runs: [], spans: [] };
    const runs = fall.runs;
    if (width() <= 0 || runs.length === 0) return [];
    const room = Math.max(0, width() - between * (runs.length - 1));
    const took = runs.map(([a, b]) => b - a);
    const widths = waterfallWidths(took, room);
    const lefts: number[] = [];
    let x = 0;
    for (const w of widths) {
      lefts.push(x);
      x += w + between;
    }
    const at = (r: number, t: number) => {
      const left = lefts[r] ?? 0;
      const runTook = took[r] ?? 0;
      const runStart = runs[r]?.[0] ?? 0;
      const runWidth = widths[r] ?? 0;
      return left + (runTook > 0 ? ((t - runStart) / runTook) * runWidth : 0);
    };
    const minTickWidth = 6;
    let r = 0;
    return fall.spans.map((span) => {
      while (r + 1 < runs.length && span.start >= (runs[r + 1]?.[0] ?? 0)) r++;
      while (r > 0 && span.start < (runs[r]?.[0] ?? 0)) r--;
      const rawLeft = at(r, span.start);
      const barWidth = Math.max(minTickWidth, at(r, span.end) - rawLeft - 1);
      const left = Math.min(rawLeft, Math.max(0, width() - barWidth));
      const preview = props.summaryOf(span.seq);
      const head = `${laneNames[span.lane]} · ${secondsText(span.end - span.start)}`;
      return {
        seq: span.seq,
        left,
        width: barWidth,
        top: lanes.indexOf(span.lane) * (lane + gap),
        label: preview ? `${head}\n${preview}` : head,
        color: span.lane === "asked" ? tone("wheat") : span.lane === "model" ? tone("leaf") : props.colorOf(span.seq),
      };
    });
  });
  return (
    <View testID="waterfall" class="flex-row items-center rounded-lg border border-line bg-side px-3 py-2">
      <View class="w-12 shrink-0 justify-between" style={{ height: lane * 3 + gap * 2 }}>
        <Each of={lanes} key={(l) => l}>
          {(l) => (
            <Text class="text-2xs font-medium text-muted" style={{ lineHeight: lane }}>
              {laneNames[l()]}
            </Text>
          )}
        </Each>
      </View>
      <View onLayout={(e) => width.set(e.bounds.size.width)} class="min-w-0 flex-1 overflow-hidden" style={{ height: lane * 3 + gap * 2 }}>
        <Each of={[0, 1, 2]} key={(i) => i}>
          {(i) => <View class="absolute inset-x-0 h-3 rounded-xs bg-hover" style={{ top: i() * (lane + gap) }} />}
        </Each>
        <Each of={bars()} key="index">
          {(b) => {
            const active = () => props.selectedSeq === b().seq;
            return (
              <View
                role="button"
                testID={`waterfall-bar-${String(b().seq)}`}
                accessibilityLabel={b().label}
                tooltip={<Bubble text={b().label} />}
                onPress={() => props.onPick(b().seq)}
                class="absolute h-3 min-w-1.5 rounded-full focus-visible:outline-2 focus-visible:outline-focus"
                style={{ left: b().left, width: b().width, top: b().top, backgroundColor: active() ? tone("ink") : b().color }}
                hoverStyle={{ backgroundColor: tone("ink") }}
              />
            );
          }}
        </Each>
      </View>
    </View>
  );
}

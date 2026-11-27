import { View } from "nsh";

import type { HostLiveVoicePhase } from "@vibevalley/protocol";

import { Icon } from "../../../design/Icon";
import { motionClass, motionOff } from "../../../design/motion";
import { mix, tone } from "../../../design/tone";

type ToneKey = "accent" | "leaf" | "water" | "wheat" | "berry" | "idle";

const ORB_TONES: Record<HostLiveVoicePhase, ToneKey> = {
  idle: "idle",
  connecting: "water",
  live: "leaf",
  stopping: "wheat",
};

const CORE_BG_CLASSES: Record<ToneKey, string> = {
  accent: "bg-accent",
  leaf: "bg-leaf",
  water: "bg-water",
  wheat: "bg-wheat",
  berry: "bg-berry",
  idle: "bg-side",
};

const clampLevel = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);

/**
 * Ambient breathing orb for MOSS Live voice calls, driven by call phase and live mic amplitude
 * and strictly quantized when reduced motion is enabled.
 */
export function VoiceOrb(props: { phase: HostLiveVoicePhase; muted: boolean; micLevel: number; size?: number }) {
  const reduced = () => motionOff();
  const level = () => (props.phase === "live" && !props.muted ? clampLevel(props.micLevel) : 0);
  const orbTone = (): ToneKey => (props.phase === "live" && props.muted ? "berry" : ORB_TONES[props.phase]);
  const baseSize = () => props.size ?? 88;
  const ringScale = () => (reduced() ? 1 : props.phase === "live" ? 1 + level() * 0.24 : props.phase === "connecting" ? 1.08 : 0.96);
  const haloOpacity = () => {
    if (props.phase === "idle") return 0.14;
    if (props.phase === "live" && props.muted) return 0.2;
    return props.phase === "live" ? 0.2 + level() * 0.34 : 0.22;
  };
  const iconName = () => {
    if (props.phase === "live") return props.muted ? "stop" : "realtime";
    if (props.phase === "connecting") return "call";
    return "audio";
  };
  const iconTone = () => (props.phase === "idle" ? "muted" : "page");

  return (
    <View
      testID="voice-orb"
      accessibilityLabel={`voice orb ${props.phase}${props.muted ? " muted" : ""}`}
      class="items-center justify-center"
      style={{ width: baseSize() + 28, height: baseSize() + 28 }}
    >
      <View
        class={`absolute inset-0 items-center justify-center rounded-full ${motionClass("transition-transform duration-150")}`}
        style={{
          backgroundColor: mix(orbTone(), haloOpacity()),
          transform: reduced() ? undefined : [{ scale: ringScale() }],
        }}
      />
      <View
        class="absolute rounded-full border border-line"
        style={{
          width: baseSize() + 12,
          height: baseSize() + 12,
          backgroundColor: mix(orbTone(), props.phase === "idle" ? 0.08 : 0.14 + level() * 0.18),
        }}
      />
      <View
        class={`items-center justify-center rounded-full border border-line-strong ${CORE_BG_CLASSES[orbTone()]}`}
        style={{
          width: baseSize() - 16,
          height: baseSize() - 16,
          backgroundColor: props.phase === "idle" ? tone("elevated") : tone(orbTone()),
        }}
      >
        <Icon name={iconName()} size={22} tone={iconTone()} />
      </View>
    </View>
  );
}

/**
 * Live microphone amplitude bars scaled smoothly from normalized PCM RMS energy (`0..1`),
 * respecting semantic theme tokens and `reduceMotion`.
 */
export function MicWaveform(props: { level: number; active: boolean; muted?: boolean; compact?: boolean; bars?: number; testid?: string; label?: string }) {
  const count = () => Math.max(3, props.bars ?? (props.compact === true ? 7 : 16));
  const items = () => Array.from({ length: count() }, (_, i) => i);
  const energy = () => (props.active && props.muted !== true ? clampLevel(props.level) : 0);
  const barTone = (): ToneKey => {
    if (props.muted === true) return "berry";
    return props.active ? "leaf" : "idle";
  };
  const barHeight = (index: number): number => {
    const total = count();
    const min = props.compact === true ? 4 : 5;
    const span = props.compact === true ? 12 : 24;
    if (!props.active || props.muted === true) return min;
    const shape = 0.35 + 0.65 * Math.sin((Math.PI * (index + 0.5)) / total);
    const floor = 0.16 * shape;
    const drive = energy() * shape;
    return Math.round(min + span * Math.min(1, floor + drive));
  };

  return (
    <View
      testID={props.testid ?? "mic-waveform"}
      accessibilityLabel={props.label}
      class={`flex-row items-center ${props.compact === true ? "h-4 gap-0.5" : "h-8 gap-1"}`}
    >
      <Each of={items()} key={(i) => i}>
        {(i) => (
          <View
            testID={`${props.testid ?? "mic-waveform"}-bar-${i()}`}
            class={`rounded-full ${props.compact === true ? "w-0.5" : "w-1"} ${motionClass("transition-opacity duration-75")}`}
            style={{
              height: barHeight(i()),
              backgroundColor: tone(barTone()),
              opacity: props.active && props.muted !== true ? 0.55 + energy() * 0.45 : props.muted === true ? 0.6 : 0.45,
            }}
          />
        )}
      </Each>
    </View>
  );
}

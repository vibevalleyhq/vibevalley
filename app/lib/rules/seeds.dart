// The runtimes' names and looks come from seeds.json through lib/gen (runtimePresets, fallbackPreset).

import '../gen/vibevalley.dart';

RuntimePreset presetOf(String runtime) =>
    runtimePresets.where((p) => p.id == runtime).firstOrNull ??
    RuntimePreset(id: runtime, label: runtime, blurb: fallbackPreset.blurb, look: fallbackPreset.look);

/// The id for one without a preset.
String runtimeName(String runtime) => presetOf(runtime).label;

final _unknownFacts = RuntimeFacts(steer: false, refused: const {}, capabilities: const [], inProcess: false);

/// What the runtime takes (seeds.json's runtimeFacts); one not there takes nothing.
RuntimeFacts factsOf(String runtime) => runtimeFacts[runtime] ?? _unknownFacts;

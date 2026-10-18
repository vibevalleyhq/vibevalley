// The runtimes' names, looks and facts come with runtime.list (RuntimeInfo.preset, RuntimeInfo.facts).

import '../gen/vibevalley.dart';

RuntimeInfo? runtimeOf(List<RuntimeInfo> catalog, String runtime) => catalog.where((r) => r.id == runtime).firstOrNull;

/// The id for one not in the catalog (or before it is read).
String runtimeName(List<RuntimeInfo> catalog, String runtime) => runtimeOf(catalog, runtime)?.preset.label ?? runtime;

final _unknownFacts = RuntimeFacts(steer: false, refused: const {}, capabilities: const [], inProcess: false);

/// What the runtime takes, as the server probed it; one not in the catalog takes nothing.
RuntimeFacts factsOf(RuntimeInfo? info) => info?.facts ?? _unknownFacts;

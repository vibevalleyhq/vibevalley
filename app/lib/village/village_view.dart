import 'package:flame/game.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../gen/vibevalley.dart';
import 'game.dart';
import 'level.dart';
import 'world.dart';

/// Cut to its box: the plants in front of the camera stand mostly past its edges.
class VillageCanvas extends StatelessWidget {
  const VillageCanvas({super.key, required this.game, this.cursor = MouseCursor.defer});
  final VillageGame game;
  final MouseCursor cursor;

  @override
  Widget build(BuildContext context) => MouseRegion(
    cursor: cursor,
    onExit: (_) => game.pointerExit(),
    child: ClipRect(child: GameWidget(game: game)),
  );
}

final villageProvider = FutureProvider<VillageWorld>((ref) async => VillageWorld(Level.parse(await rootBundle.loadString('assets/village.ldtk'))));

({int? lowest, bool any}) lowestQuota(List<RuntimeInfo> runtimes) {
  final usable = runtimes.where((r) => r.installation is InstallationAvailable && r.settings.enabled).toList();
  final lefts = [
    for (final r in usable)
      if (r.usage case AccountUsageOk(:final windows) when windows.isNotEmpty)
        windows.map((w) => 100 - w.usedPercent).reduce((a, b) => a < b ? a : b).clamp(0, 100).round(),
  ];
  return (lowest: lefts.isEmpty ? null : lefts.reduce((a, b) => a < b ? a : b), any: usable.isNotEmpty);
}

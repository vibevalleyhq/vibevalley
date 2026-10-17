// What a tap lands on: the order is the rule, the Flame component is only the pointer adapter.

import 'dart:ui' show Offset, Rect;

import 'level.dart' show Box;

sealed class VillageHit {
  const VillageHit();
}

final class VillageHitSession extends VillageHit {
  const VillageHitSession(this.id);
  final String id;

  @override
  bool operator ==(Object other) => other is VillageHitSession && other.id == id;
  @override
  int get hashCode => id.hashCode;
}

final class VillageHitDog extends VillageHit {
  const VillageHitDog();

  @override
  bool operator ==(Object other) => other is VillageHitDog;
  @override
  int get hashCode => 1;
}

final class VillageHitSpot extends VillageHit {
  const VillageHitSpot(this.spot);
  final String spot;

  @override
  bool operator ==(Object other) => other is VillageHitSpot && other.spot == spot;
  @override
  int get hashCode => spot.hashCode;
}

final class VillageHitPlot extends VillageHit {
  const VillageHitPlot(this.bed);
  final int bed;

  @override
  bool operator ==(Object other) => other is VillageHitPlot && other.bed == bed;
  @override
  int get hashCode => bed;
}

class VillageHitData {
  const VillageHitData({required this.sessions, required this.dog, required this.spots, required this.plots});
  final Map<String, Rect> sessions;
  final Rect dog;
  final Map<String, Box> spots;
  final Map<int, Box> plots;
}

bool _inside(Offset p, Box b) => p.dx >= b.x0 && p.dx < b.x1 && p.dy >= b.y0 && p.dy < b.y1;

VillageHit? villageHitAt(VillageHitData data, Offset p) {
  for (final MapEntry(key: id, value: box) in data.sessions.entries.toList().reversed) {
    if (box.contains(p)) return VillageHitSession(id);
  }
  if (data.dog.contains(p)) return const VillageHitDog();
  for (final MapEntry(key: spot, value: box) in data.spots.entries.toList().reversed) {
    if (_inside(p, box)) return VillageHitSpot(spot);
  }
  for (final MapEntry(key: bed, value: box) in data.plots.entries.toList().reversed) {
    if (p.dx >= box.x0 && p.dx < box.x1 && p.dy >= box.y0 - 4 && p.dy < box.y1 + 2) return VillageHitPlot(bed);
  }
  return null;
}

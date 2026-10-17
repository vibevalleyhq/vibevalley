// The beds (the village's plots) and what grows in them: the world draws them, the actions name them.

import '../gen/vibevalley.dart';

class Bed {
  const Bed(this.index, this.station, [this.unlockLevel]);
  final int index;

  /// -1 for locked ones.
  final int station;

  final int? unlockLevel;
}

const beds = [Bed(0, 0), Bed(1, 1), Bed(2, 2), Bed(3, 3), Bed(4, 4), Bed(5, 5), Bed(6, -1, 5), Bed(7, -1, 8), Bed(8, -1, 12)];

Bed? bedOfStation(int station) => station < 0 ? null : beds.where((b) => b.station == station).firstOrNull;

bool isRipe(Crop crop) => crop == Crop.wheat || crop == Crop.carrot;

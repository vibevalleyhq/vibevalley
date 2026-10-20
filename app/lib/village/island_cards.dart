import 'package:flutter/widgets.dart' hide Icon;

import '../gen/vibevalley.dart' show BadgeTone;
import '../sprites/atlas.dart';
import '../ui/pixel/pixel_card.dart' show CardColors, Icon, PixelCard, Words, badgeColors;

// The signs drawn on the project map's islands: part of the picture of the farm, so in the pixel kit whichever page shows it.

/// The sign over a plot (可收获, 卡住了…), in its tone's paper and ink.
class PlotSign extends StatelessWidget {
  const PlotSign({super.key, required this.text, required this.tone});
  final String text;
  final BadgeTone tone;

  @override
  Widget build(BuildContext context) {
    final (paper, ink) = badgeColors(tone);
    return PixelCard(
      paper: paper,
      ink: ink,
      padX: 4,
      padY: 1,
      rows: [
        [Words(text, size: 10)],
      ],
    );
  }
}

/// How many more sacks wait than the gate shows.
class MoreSacks extends StatelessWidget {
  const MoreSacks(this.more, {super.key});
  final int more;

  @override
  Widget build(BuildContext context) => PixelCard(
    padX: 3,
    padY: 0,
    rows: [
      [Words('+$more', size: 10)],
    ],
  );
}

/// The island's name board: its project, how busy it is, and the way in unless it is the one open.
class IslandSign extends StatelessWidget {
  const IslandSign({super.key, required this.project, required this.line, required this.selected, required this.hovered, required this.maxWidth, this.enter});
  final String project;
  final String line;
  final bool selected;
  final bool hovered;
  final double maxWidth;

  /// The arrow beside 进岛.
  final SpriteInfo? enter;

  @override
  Widget build(BuildContext context) => PixelCard(
    paper: selected ? CardColors.held : (hovered ? CardColors.slot : CardColors.paper),
    center: true,
    maxWidth: maxWidth,
    maxLines: 1,
    rows: [
      [Words(project, size: 14)],
      [Words(line, color: CardColors.muted)],
      // The way onto the island, said and pointed at, not only the island to click.
      if (!selected) [const Words('进岛', color: CardColors.good), if (enter case final e?) Icon(e, 12)],
    ],
  );
}

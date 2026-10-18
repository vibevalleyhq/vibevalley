import 'package:flutter/widgets.dart';

import '../sprites/atlas.dart';

class EarnedMedal extends StatelessWidget {
  const EarnedMedal({super.key, required this.atlas, required this.achievement, required this.tier, this.oneOff = false, this.size = 48});
  final SpriteAtlas atlas;
  final String achievement;
  final int tier;

  /// A one-off's medal is gold.
  final bool oneOff;
  final double size;

  @override
  Widget build(BuildContext context) {
    final frameTier = oneOff ? 3 : tier;
    final frame =
        atlas[switch (frameTier) {
          1 => 'medal-bronze',
          2 => 'medal-silver',
          _ => 'medal-gold',
        }];
    final emblem = atlas.first(['emblem-$achievement', 'emblem-wreath']);
    // Where the ribbon frames' empty disc is, as a share of the square.
    final e = size * 0.44;
    return SizedBox.square(
      dimension: size,
      child: Stack(
        children: [
          Positioned.fill(
            child: Image.asset(frame.asset, fit: BoxFit.contain, filterQuality: FilterQuality.none),
          ),
          Positioned(
            left: (size - e) / 2,
            top: size * 0.409 - e / 2,
            width: e,
            height: e,
            child: Image.asset(emblem.asset, fit: BoxFit.contain, filterQuality: FilterQuality.none),
          ),
        ],
      ),
    );
  }
}

// What the FX layer shows of an achievement: the line above a toast's title (web/src/farm/FxLayer.tsx earnedText) and
// the medal (web/src/farm/Achievements.tsx Medal, earned tiers only). The catalogue and its rules are rules/progress.dart's.

import 'package:flutter/widgets.dart';

import '../rules/progress.dart';
import '../sprites/atlas.dart';

/// The line above an achievement toast's title: what kind of news it is (FxLayer.tsx earnedText).
String earnedText(AchievementDef a, int tier) {
  if (a.category == AchievementCategory.starter) return '新手任务做完了';
  if (a.category == AchievementCategory.secret) return '发现一个彩蛋';
  return tier == 3 ? '升到金牌' : (tier == 2 ? '升到银牌' : '解锁成就');
}

/// An earned medal: the achievement's emblem in the frame of its tier (one-offs are gold), drawn `size` square.
class EarnedMedal extends StatelessWidget {
  const EarnedMedal({super.key, required this.atlas, required this.achievement, required this.tier, this.size = 48});
  final SpriteAtlas atlas;
  final AchievementDef achievement;
  final int tier;
  final double size;

  @override
  Widget build(BuildContext context) {
    final frameTier = achievement.tiers.length == 1 ? 3 : tier;
    final frame =
        atlas[switch (frameTier) {
          1 => 'medal-bronze',
          2 => 'medal-silver',
          _ => 'medal-gold',
        }];
    final emblem = atlas.first(['emblem-${achievement.id}', 'emblem-wreath']);
    // Where the ribbon frames' empty disc is, as a share of the square (Achievements.tsx DISC.ribbon).
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

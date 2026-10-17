// The server folds the progress; these only read it.

import '../gen/vibevalley.dart';

AchievementDef? achievementOf(String id) {
  for (final a in achievements) {
    if (a.id == id) return a;
  }
  return null;
}

String tierTitle(AchievementDef a, int tier) {
  final own = a.tierTitles;
  if (own != null && tier >= 1 && tier <= own.length) return own[tier - 1];
  return tier == 2 ? '银牌${a.title}' : (tier == 3 ? '金牌${a.title}' : a.title);
}

const categoryText = {
  AchievementCategory.starter: '新手任务',
  AchievementCategory.harvest: '收成',
  AchievementCategory.craft: '手艺',
  AchievementCategory.thrift: '精打细算',
  AchievementCategory.team: '协作',
  AchievementCategory.secret: '彩蛋',
};

bool isTitle(AchievementDef a) => a.category != AchievementCategory.starter;

/// 0: none yet.
int tierOf(Progress p, String id) => p.unlocked.fold(0, (t, u) => u.id == id && u.tier > t ? u.tier.round() : t);

/// The next tier is null once all are reached.
({int tier, int count, int? next}) standing(Progress p, AchievementDef a) {
  final tier = tierOf(p, a.id);
  return (tier: tier, count: (p.counts[a.id] ?? 0).round(), next: tier < a.tiers.length ? a.tiers[tier].round() : null);
}

const emptyProgress = Progress(coins: 0, streak: 0, bestStreak: 0, counts: {}, unlocked: []);

/// What reaching that tier (from 1) pays, as seeds.json says.
int tierCoins(AchievementDef a, int tier) => tier >= 1 && tier <= a.coins.length ? a.coins[tier - 1].round() : 0;

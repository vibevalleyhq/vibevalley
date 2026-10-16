// The server folds the progress; these only read it.

import 'dart:math' as math;

import '../gen/vibevalley.dart';

enum AchievementCategory { starter, harvest, craft, thrift, team, secret }

class AchievementDef {
  const AchievementDef(this.id, this.category, this.title, this.detail, this.tiers, {this.tierTitles, this.unit});
  final String id;
  final AchievementCategory category;
  final String title;
  final List<String>? tierTitles;
  final String detail;
  final List<int> tiers;
  final String? unit;
}

const achievements = <AchievementDef>[
  AchievementDef('s_open', AchievementCategory.starter, '开门', '开工', [1]),
  AchievementDef('s_hire', AchievementCategory.starter, '派活', '派出第一个帮工', [1]),
  AchievementDef('s_tell', AchievementCategory.starter, '带话', '给帮工带一句话：浇水，或者在它的工单串里说', [1]),
  AchievementDef('s_review', AchievementCategory.starter, '验收', '看过收成清单，再收进主分支', [1]),
  AchievementDef('s_voice', AchievementCategory.starter, '说话', '用语音和管家说一次话', [1]),
  AchievementDef('s_plan', AchievementCategory.starter, '规划', '拆一张种植计划', [1]),
  AchievementDef('s_call', AchievementCategory.starter, '点名', '在田头 @ 一个帮工', [1]),
  AchievementDef('harvests', AchievementCategory.harvest, '收成', '收进主分支的活', [1, 20, 100], tierTitles: ['开张大吉', '小有收成', '粮仓满了'], unit: '件'),
  AchievementDef('first_try', AchievementCategory.harvest, '一气呵成', '第一轮就做完、没带过话、没失败过就收进去的活', [1, 10, 50], unit: '件'),
  AchievementDef('big_playbook', AchievementCategory.harvest, '五谷丰登', '收获的种植计划里，合进去的步数最多的一张', [3, 5, 10], unit: '步'),
  AchievementDef('farm_level', AchievementCategory.harvest, '农场规模', '农场的等级（跟着你的 commit 数长）', [5, 10, 20], tierTitles: ['小有规模', '远近闻名', '一方粮仓'], unit: '级'),
  AchievementDef('steady', AchievementCategory.craft, '稳如老农', '最长连胜：连着收进去，中间没有一轮失败', [5, 15, 40], unit: '件'),
  AchievementDef('untangle', AchievementCategory.craft, '解铃人', '冲突过、最后还是收进去的活', [1, 5, 20], unit: '件'),
  AchievementDef('comeback', AchievementCategory.craft, '浴火重生', '没做成过、修好以后收进去的活', [1, 5, 20], unit: '件'),
  AchievementDef('thrifty', AchievementCategory.thrift, '一分钱一分货', '花不到 ¥0.05 就收进去的活（只算知道花费的农机）', [1, 10, 50], unit: '件'),
  AchievementDef('every_machine', AchievementCategory.thrift, '物尽其用', '收进过活的农机种数', [2, 3, 5], unit: '种'),
  AchievementDef('handoff', AchievementCategory.team, '交接', '帮工在田头点名另一个帮工，对方回了话', [1, 5, 20], unit: '次'),
  AchievementDef('parallel_plan', AchievementCategory.team, '运筹帷幄', '有一批步骤同时做的种植计划，收获了', [1, 3, 10], unit: '张'),
  AchievementDef('night_owl', AchievementCategory.secret, '夜猫子', '深夜（0–5 点）收进一件活', [1]),
  AchievementDef('weekend', AchievementCategory.secret, '周末农夫', '周末收进一件活', [1]),
  AchievementDef('full_house', AchievementCategory.secret, '满园春色', '六块地同时有帮工在干活', [1]),
];

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

int tierCoins(AchievementDef a, int tier) {
  if (a.category == AchievementCategory.starter) return 20;
  if (a.category == AchievementCategory.secret) return 50;
  const coins = [0, 10, 30, 60];
  return tier >= 0 && tier < coins.length ? coins[tier] : 0;
}

int xpToNext(int level) => 10 * level;

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

double streakMultiplier(double streak) => math.min(2, 1 + 0.1 * math.max(0, streak - 1));

/// The next tier is null once all are reached.
({int tier, int count, int? next}) standing(Progress p, AchievementDef a) {
  final tier = tierOf(p, a.id);
  return (tier: tier, count: (p.counts[a.id] ?? 0).round(), next: tier < a.tiers.length ? a.tiers[tier] : null);
}

const emptyProgress = Progress(coins: 0, streak: 0, bestStreak: 0, counts: {}, unlocked: []);

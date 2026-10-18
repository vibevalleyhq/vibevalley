import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../data/remote.dart' show achievementsProvider;
import '../game/commands.dart';
import '../game/tools.dart';
import '../gen/vibevalley.dart';
import '../ui/kit/kit.dart';
import '../shared/popover.dart';
import '../shared/tags.dart';

class Medal extends StatelessWidget {
  const Medal({super.key, required this.achievement, required this.tier, required this.size});
  final Achievement achievement;
  final int tier;
  final double size;

  @override
  Widget build(BuildContext context) {
    final earned = tier > 0;
    final frameTier = achievement.tiers.length == 1 ? 3 : tier;
    final frame = !earned
        ? 'medal-wood'
        : switch (frameTier) {
            1 => 'medal-bronze',
            2 => 'medal-silver',
            _ => 'medal-gold',
          };
    // Where each frame's empty disc is, as a share of the square: high on the ribbon frames, all of the wooden one.
    final (top, share) = earned ? (0.409, 0.44) : (0.5, 0.5);
    final e = size * share;
    Widget emblem = Image.asset(
      'assets/pixel/emblem-${achievement.id}.png',
      fit: BoxFit.contain,
      filterQuality: FilterQuality.none,
      errorBuilder: (_, _, _) => const SpriteIcon('emblem-wreath', size: 64),
    );
    if (!earned) {
      emblem = Opacity(
        opacity: .5,
        child: ColorFiltered(colorFilter: _grey, child: emblem),
      );
    }
    return SizedBox.square(
      dimension: size,
      child: Stack(
        children: [
          Positioned.fill(child: SpriteIcon(frame, size: size)),
          Positioned(left: (size - e) / 2, top: size * top - e / 2, width: e, height: e, child: emblem),
        ],
      ),
    );
  }
}

const _grey = ColorFilter.matrix([0.2126, 0.7152, 0.0722, 0, 0, 0.2126, 0.7152, 0.0722, 0, 0, 0.2126, 0.7152, 0.0722, 0, 0, 0, 0, 0, 1, 0]);

class FarmBar extends StatelessWidget {
  const FarmBar({super.key, required this.value, required this.max, this.height = 8, this.label});
  final double value;
  final double max;
  final double height;
  final String? label;

  @override
  Widget build(BuildContext context) => Semantics(
    label: label,
    value: '${value.round()}/${max.round()}',
    child: Container(
      height: height,
      decoration: BoxDecoration(
        color: Palette.cream200,
        border: Border.all(color: Palette.cream300),
      ),
      child: FractionallySizedBox(
        alignment: Alignment.centerLeft,
        widthFactor: max <= 0 ? 0 : (value / max).clamp(0, 1).toDouble(),
        child: const ColoredBox(color: Palette.leaf500),
      ),
    ),
  );
}

const _walls = [AchievementCategory.harvest, AchievementCategory.craft, AchievementCategory.thrift, AchievementCategory.team];

String _day(double at) {
  final d = DateTime.fromMillisecondsSinceEpoch(at.round());
  return '${d.month}月${d.day}日';
}

double? _reachedAt(Progress p, String id, int tier) => p.unlocked.where((u) => u.id == id && u.tier == tier).firstOrNull?.at;

const _tierText = {1: '铜', 2: '银', 3: '金'};

const _categoryText = {
  AchievementCategory.starter: '新手任务',
  AchievementCategory.harvest: '收成',
  AchievementCategory.craft: '手艺',
  AchievementCategory.thrift: '精打细算',
  AchievementCategory.team: '协作',
  AchievementCategory.secret: '彩蛋',
};

const _emptyProgress = Progress(coins: 0, streak: 0, bestStreak: 0, counts: {}, unlocked: []);

/// The tier's name; the achievement's own before the first.
String _tierTitle(Achievement a, int tier) => tier >= 1 && tier <= a.tiers.length ? a.tiers[tier - 1].title : a.title;

/// How far the farm is with each achievement, as the frame's view says; nothing before the first frame.
class _Standings {
  _Standings(List<AchievementStanding> list) : _by = {for (final s in list) s.id: s};
  final Map<String, AchievementStanding> _by;

  ({int tier, int count, int? next}) of(Achievement a) {
    final s = _by[a.id];
    return (tier: s?.tier.round() ?? 0, count: s?.count.round() ?? 0, next: s?.next?.round());
  }
}

const _pip = {1: Color(0xFFC07A43), 2: Color(0xFFA9B4BF), 3: Palette.wheat};

class Tasks extends ConsumerWidget {
  const Tasks({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = ref.watch(stateProvider.select((s) => s?.progress)) ?? _emptyProgress;
    final level = ref.watch(viewProvider.select((v) => v?.level.level.round())) ?? 1;
    final catalog = ref.watch(achievementsProvider).value ?? const <Achievement>[];
    final st = _Standings(ref.watch(viewProvider.select((v) => v?.achievements)) ?? const []);
    List<Achievement> of(AchievementCategory c) => catalog.where((a) => a.category == c).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const _Standing(),
        const SizedBox(height: 20),
        _Starter(list: of(AchievementCategory.starter), st: st),
        const SizedBox(height: 20),
        _Heading('开垦'),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final b in beds.where((b) => b.unlockLevel != null))
              Container(
                color: level >= b.unlockLevel! ? tint(Palette.leaf300, .7) : Palette.cream200,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text('Lv.${b.unlockLevel} 开垦一块地', style: KitText.xs.copyWith(color: level >= b.unlockLevel! ? Palette.bark900 : Palette.bark600)),
                    if (level >= b.unlockLevel!) ...[const SizedBox(width: 4), const SpriteIcon('mark-check', size: 12)],
                  ],
                ),
              ),
          ],
        ),
        for (final c in _walls) ...[const SizedBox(height: 20), _Wall(category: c, list: of(c), p: p, st: st)],
        const SizedBox(height: 20),
        _Secrets(list: of(AchievementCategory.secret), p: p, st: st),
      ],
    );
  }
}

class _Heading extends StatelessWidget {
  const _Heading(this.text, {this.aside});
  final String text;
  final String? aside;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Text.rich(
      TextSpan(
        children: [
          TextSpan(text: text),
          if (aside != null) TextSpan(text: '  $aside'),
        ],
      ),
      style: KitText.xs.copyWith(color: Palette.bark600),
    ),
  );
}

class _Standing extends ConsumerWidget {
  const _Standing();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = ref.watch(stateProvider.select((s) => s?.progress)) ?? _emptyProgress;
    final lv = ref.watch(viewProvider.select((v) => v?.level)) ?? const FarmLevel(level: 1, xp: 0, need: 10);
    final commits = ref.watch(stateProvider.select((s) => s?.commits?.total)) ?? 0;
    final level = lv.level.round();
    final need = lv.need.round();
    return Tinted(
      padding: const EdgeInsets.all(12),
      child: Wrap(
        spacing: 24,
        runSpacing: 12,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          ConstrainedBox(
            constraints: const BoxConstraints(minWidth: 160, maxWidth: 280),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Wrap(
                  spacing: 8,
                  crossAxisAlignment: WrapCrossAlignment.end,
                  children: [
                    Text('Lv.$level', style: KitText.xl.copyWith(color: Palette.leaf700)),
                    Text('再 ${need - lv.xp.round()} 个 commit 升级 · 共 ${commits.round()} 个', style: KitText.xs.copyWith(color: Palette.bark600)),
                  ],
                ),
                const SizedBox(height: 6),
                FarmBar(value: lv.xp, max: need.toDouble(), label: '到下一级的 commit'),
              ],
            ),
          ),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SpriteIcon('coins-stack', size: 40),
              const SizedBox(width: 8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(_thousands(p.coins.round()), style: KitText.xl),
                  Text(
                    p.streak > 1 ? '连胜 ${p.streak.round()} · 收成金币 ×${(p.multiplier ?? 1).toStringAsFixed(1)}' : '收进主分支才给金币',
                    style: KitText.xs.copyWith(color: Palette.bark600),
                  ),
                ],
              ),
            ],
          ),
          _TitlePicker(p: p),
        ],
      ),
    );
  }
}

String _thousands(int n) => n.toString().replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');

/// Any tier reached can be worn, not a starter task's.
class _TitlePicker extends ConsumerWidget {
  const _TitlePicker({required this.p});
  final Progress p;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final title = p.title;
    final catalog = ref.watch(achievementsProvider).value ?? const <Achievement>[];
    final worn = title == null ? null : catalog.where((a) => a.id == title.id).firstOrNull;
    final earned = [
      for (final a in catalog.where((a) => a.wearable))
        for (var i = 0; i < a.tiers.length; i++)
          if (p.unlocked.any((u) => u.id == a.id && u.tier == i + 1)) (a: a, tier: i + 1),
    ];
    return FarmPopover(
      side: PopSide.bottom,
      alignEnd: true,
      offset: 8,
      width: 256,
      enabled: earned.isNotEmpty,
      trigger: (context, open, toggle) => KitTappable(
        onTap: earned.isEmpty ? null : toggle,
        builder: (context, s) => Opacity(
          opacity: earned.isEmpty ? .6 : 1,
          child: Container(
            decoration: BoxDecoration(
              color: s.hovered ? Palette.cream200 : Palette.cream50,
              border: Border.all(color: Palette.cream300, width: 2),
            ),
            padding: const EdgeInsets.fromLTRB(6, 6, 12, 6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (worn != null && title != null)
                  Medal(achievement: worn, tier: title.tier.round(), size: 32)
                else
                  const SizedBox(width: 48, height: 20, child: SpriteIcon('banner-title', size: 48)),
                const SizedBox(width: 8),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('称号', style: KitText.xs.copyWith(color: Palette.bark600)),
                    Text(
                      worn != null && title != null
                          ? _tierTitle(worn, title.tier.round())
                          : earned.isNotEmpty
                          ? '挑一个'
                          : '拿到成就就有',
                      style: KitText.sm,
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
      popup: (context, close) {
        final commands = ref.read(farmCommandsProvider);
        return ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 320),
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(8, 4, 8, 6),
                  child: Text('挂在农场卡上的称号', style: KitText.xs.copyWith(color: Palette.bark600)),
                ),
                for (final (:a, :tier) in earned)
                  KitTappable(
                    onTap: () {
                      fire(commands.chooseTitle(a.id, tier));
                      close();
                    },
                    builder: (context, s) {
                      final on = title?.id == a.id && title?.tier == tier;
                      return Container(
                        color: s.hovered || s.focused ? Palette.cream100 : null,
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                        child: Row(
                          children: [
                            Medal(achievement: a, tier: tier, size: 28),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(_tierTitle(a, tier), style: KitText.sm.copyWith(color: on ? Palette.leaf700 : null)),
                            ),
                            if (on) Semantics(label: '挂着', child: const SpriteIcon('mark-check', size: 14)),
                          ],
                        ),
                      );
                    },
                  ),
                if (title != null)
                  KitTappable(
                    onTap: () {
                      fire(commands.chooseTitle());
                      close();
                    },
                    builder: (context, s) => Container(
                      color: s.hovered || s.focused ? Palette.cream100 : null,
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                      child: Text('不挂称号', style: KitText.sm.copyWith(color: Palette.bark600)),
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _Starter extends StatelessWidget {
  const _Starter({required this.list, required this.st});
  final List<Achievement> list;
  final _Standings st;

  @override
  Widget build(BuildContext context) {
    final done = list.where((a) => st.of(a).tier > 0).length;
    if (done == list.length) {
      return Tinted(
        color: tint(Palette.leaf300, .4),
        child: Row(
          children: [
            const SpriteIcon('emblem-starter', size: 28),
            const SizedBox(width: 8),
            Text('新手任务都做完了。', style: KitText.sm.copyWith(color: Palette.bark800)),
          ],
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Heading('新手任务 $done/${list.length}', aside: list.isEmpty ? null : '每做完一个 +${list.first.tiers.first.coins.round()} 金币'),
        _Grid(
          spacing: 6,
          children: [
            for (final a in list)
              Builder(
                builder: (context) {
                  final ok = st.of(a).tier > 0;
                  Widget emblem = Image.asset(
                    'assets/pixel/emblem-${a.id}.png',
                    width: 36,
                    height: 36,
                    fit: BoxFit.contain,
                    filterQuality: FilterQuality.none,
                    errorBuilder: (_, _, _) => const SpriteIcon('emblem-wreath', size: 36),
                  );
                  if (!ok) emblem = Opacity(opacity: .6, child: emblem);
                  return Container(
                    color: ok ? tint(Palette.leaf300, .35) : Palette.cream100,
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                    child: Row(
                      children: [
                        SizedBox(
                          width: 36,
                          height: 36,
                          child: Stack(
                            clipBehavior: Clip.none,
                            children: [
                              emblem,
                              if (ok) const Positioned(right: -6, bottom: -4, child: SpriteIcon('stamp-done', size: 20, semanticLabel: '做完了')),
                            ],
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(a.title, style: KitText.sm.copyWith(color: ok ? Palette.bark800 : Palette.bark900)),
                              Tooltip(
                                message: a.detail,
                                child: Text(
                                  a.detail,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: KitText.xs.copyWith(color: Palette.bark600),
                                ),
                              ),
                            ],
                          ),
                        ),
                        if (!ok)
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const SpriteIcon('icon-coin', size: 16),
                              Text('+${a.tiers.first.coins.round()}', style: KitText.xs.copyWith(color: Palette.bark600)),
                            ],
                          ),
                      ],
                    ),
                  );
                },
              ),
          ],
        ),
      ],
    );
  }
}

class _Grid extends StatelessWidget {
  const _Grid({required this.children, this.spacing = 8});
  final List<Widget> children;
  final double spacing;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final two = box.maxWidth >= 600;
      final w = two ? (box.maxWidth - spacing) / 2 : box.maxWidth;
      return Wrap(
        spacing: spacing,
        runSpacing: spacing,
        children: [for (final c in children) SizedBox(width: w, child: c)],
      );
    },
  );
}

class _Wall extends StatelessWidget {
  const _Wall({required this.category, required this.list, required this.p, required this.st});
  final AchievementCategory category;
  final List<Achievement> list;
  final Progress p;
  final _Standings st;

  @override
  Widget build(BuildContext context) {
    final got = list.where((a) => st.of(a).tier > 0).length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Heading('${_categoryText[category]} $got/${list.length}'),
        _Grid(
          children: [for (final a in list) _AchievementCard(a: a, p: p, st: st)],
        ),
      ],
    );
  }
}

class _AchievementCard extends StatelessWidget {
  const _AchievementCard({required this.a, required this.p, required this.st});
  final Achievement a;
  final Progress p;
  final _Standings st;

  @override
  Widget build(BuildContext context) {
    final (:tier, :count, :next) = st.of(a);
    final at = tier > 0 ? _reachedAt(p, a.id, tier) : null;
    final unit = a.unit ?? '';
    return Container(
      decoration: BoxDecoration(
        color: tier == 3 ? tint(Palette.wheat, .2) : Palette.cream100,
        border: tier == 3 ? Border.all(color: Palette.wheat.withValues(alpha: .7), width: 2) : null,
      ),
      padding: const EdgeInsets.all(10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Medal(achievement: a, tier: tier, size: 60),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        _tierTitle(a, tier < 1 ? 1 : tier),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: KitText.sm.copyWith(color: tier > 0 ? Palette.bark900 : Palette.bark600),
                      ),
                    ),
                    if (a.tiers.length > 1)
                      Semantics(
                        label: '$tier/${a.tiers.length} 档',
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            for (final (i, t) in a.tiers.indexed)
                              Tooltip(
                                message: '${_tierText[i + 1]}：${numberText(t.need)} $unit',
                                child: Container(width: 8, height: 8, margin: const EdgeInsets.only(left: 4), color: i < tier ? _pip[i + 1] : Palette.cream300),
                              ),
                          ],
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: 2),
                Text(a.detail, style: KitText.xs.copyWith(color: Palette.bark600)),
                if (next != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Row(
                      children: [
                        Expanded(
                          child: FarmBar(
                            value: (count < next ? count : next).toDouble(),
                            max: next.toDouble(),
                            height: 6,
                            label: '到${_tierText[tier + 1] ?? ''}档',
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text('$count/$next $unit', style: KitText.xs.copyWith(color: Palette.bark600)),
                      ],
                    ),
                  ),
                if (at != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text('${_day(at)}拿到${a.tiers.length > 1 ? '${_tierText[tier]}牌' : ''}', style: KitText.xs.copyWith(color: Palette.bark400)),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Secrets extends StatelessWidget {
  const _Secrets({required this.list, required this.p, required this.st});
  final List<Achievement> list;
  final Progress p;
  final _Standings st;

  @override
  Widget build(BuildContext context) {
    final found = list.where((a) => st.of(a).tier > 0).toList();
    final left = list.length - found.length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Heading('${_categoryText[AchievementCategory.secret]} ${found.length}/${list.length}'),
        _Grid(
          children: [
            for (final a in found) _AchievementCard(a: a, p: p, st: st),
            if (left > 0)
              Container(
                color: Palette.cream100,
                padding: const EdgeInsets.all(10),
                child: Row(
                  children: [
                    const SpriteIcon('medal-locked', size: 60),
                    const SizedBox(width: 12),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('还有 $left 个彩蛋', style: KitText.sm.copyWith(color: Palette.bark600)),
                        Text('碰上了才知道是什么。', style: KitText.xs.copyWith(color: Palette.bark600)),
                      ],
                    ),
                  ],
                ),
              ),
          ],
        ),
      ],
    );
  }
}

// How much each runtime has left (web/src/farm/Quota.tsx): an energy potion in the HUD's top row (the tightest one),
// and a card with every machine's potion and a stamina bar per plan window, or its pay-as-you-go balance. The card's
// button asks the accounts again now.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../desk/shared/faces.dart' show RuntimeIcon;
import '../game/commands.dart';
import '../gen/vibevalley.dart';
import '../ui/kit/kit.dart';
import '../village/village_view.dart' show runtimesProvider;
import 'popover.dart';
import '../rules/index.dart';
import '../rules/quota.dart';
import '../rules/seeds.dart';

/// Number colour by how much is left.
Color _textOf(double? left) => switch (levelOf(left)) {
  QuotaLevel.plenty => Palette.leaf700,
  QuotaLevel.low || QuotaLevel.gold => const Color(0xFFB8862A),
  QuotaLevel.empty => Palette.berry,
  QuotaLevel.unknown => Palette.bark500,
};

/// The pill in the HUD's top row, `height` tall; nothing without a usable runtime.
class QuotaPill extends ConsumerWidget {
  const QuotaPill({super.key, required this.height});
  final double height;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    final runtimes = usableRuntimes(ref.watch(runtimesProvider).value ?? const []);
    if (runtimes.isEmpty || atlas == null) return const SizedBox.shrink();
    final lefts = [for (final r in runtimes) ?quotaLeft(r.usage)];
    final lowest = lefts.isEmpty ? null : lefts.reduce((a, b) => a < b ? a : b);
    final shown = lowest?.round();
    return FarmPopover(
      side: PopSide.bottom,
      alignEnd: true,
      offset: 8,
      width: 352,
      trigger: (context, open, toggle) => KitTappable(
        onTap: toggle,
        semanticLabel: shown == null ? '各 runtime 的剩余额度' : '剩余额度，最少的还剩 $shown%',
        builder: (context, s) => HudCard(
          height: height,
          bright: s.hovered,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              EnergyBottle(
                atlas: atlas,
                quota: Quota(level: levelOf(lowest), fill: lowest == null ? 0 : lowest / 100, short: '', text: ''),
                size: 28,
              ),
              const SizedBox(width: 4),
              Text(shown == null ? '额度' : '$shown%', style: KitText.xs.copyWith(color: lowest == null ? Palette.bark900 : _textOf(lowest))),
            ],
          ),
        ),
      ),
      popup: (context, close) => Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(child: Text('剩余额度', style: KitText.sm)),
                PxButton(
                  size: PxSize.icon,
                  tooltip: '现在读一次额度',
                  semanticLabel: '现在读一次额度',
                  onPressed: () {
                    final commands = ref.read(farmCommandsProvider);
                    for (final r in runtimes) {
                      commands.refreshRuntime(r.id).catchError((Object _) {});
                    }
                  },
                  child: const SpriteIcon('button-refresh', size: 14),
                ),
              ],
            ),
            const SizedBox(height: 8),
            ConstrainedBox(
              constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * .7 > 512 ? 512 : MediaQuery.sizeOf(context).height * .7),
              child: SingleChildScrollView(
                child: Column(
                  children: [
                    for (final (i, r) in runtimes.indexed) ...[if (i > 0) const SizedBox(height: 12), Machine(info: r)],
                  ],
                ),
              ),
            ),
            const SizedBox(height: 8),
            Text('从各家账户读来，几分钟更新一次；帮工干完一轮也会更新。', style: KitText.xs.copyWith(color: Palette.bark400)),
          ],
        ),
      ),
    );
  }
}

/// One machine: its icon, its plan's windows or balance, what it spent today, why nobody new goes to it.
class Machine extends ConsumerWidget {
  const Machine({super.key, required this.info});
  final RuntimeInfo info;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    final quota = quotaOf(info.usage);
    final stop = moneyStop(info);
    final usage = info.usage;
    return Container(
      decoration: BoxDecoration(
        color: Palette.cream100,
        border: Border.all(color: Palette.cream200, width: 1.5),
      ),
      padding: const EdgeInsets.all(8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          RuntimeIcon(runtime: info.id, size: 34),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Text(runtimeName(info.id), style: KitText.sm),
                    if (usage case AccountUsageOk(:final plan?)) ...[
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(
                          plan,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: KitText.xs.copyWith(color: Palette.bark500),
                        ),
                      ),
                    ],
                  ],
                ),
                UsageLines(usage: usage),
                if (info.spentToday != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      '今天花了约 ${yuan(info.spentToday!)}${(info.settings.dailyBudget ?? 0) > 0 ? ' / 预算 ${yuan(info.settings.dailyBudget!)}' : ''}',
                      style: KitText.xs.copyWith(color: Palette.bark500),
                    ),
                  ),
                if (stop != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(stop, style: KitText.xs.copyWith(color: Palette.berry)),
                  ),
              ],
            ),
          ),
          SizedBox(
            width: 48,
            child: Column(
              children: [
                if (atlas != null) EnergyBottle(atlas: atlas, quota: quota, size: 40),
                Text(
                  quota.short.isEmpty ? '—' : quota.short,
                  style: KitText.xs.copyWith(
                    color: quota.level == QuotaLevel.unknown
                        ? Palette.bark400
                        : quota.level == QuotaLevel.empty
                        ? Palette.berry
                        : Palette.bark800,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class UsageLines extends StatelessWidget {
  const UsageLines({super.key, required this.usage});
  final AccountUsage? usage;

  @override
  Widget build(BuildContext context) {
    final xs = KitText.xs;
    return switch (usage) {
      null => Text('不报额度', style: xs.copyWith(color: Palette.bark400)),
      AccountUsageLoginRequired() => Text('没登录，额度读不到', style: xs.copyWith(color: const Color(0xFFB8682A))),
      AccountUsageUnavailable(:final reason) => Tooltip(
        message: reason,
        child: Text(
          '读不到：$reason',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: xs.copyWith(color: Palette.bark400),
        ),
      ),
      AccountUsageBalance(:final provider, :final available) => Padding(
        padding: const EdgeInsets.only(top: 2),
        child: Text('按量计费 · $provider 余额${available ? '' : '，不够用了'}', style: xs.copyWith(color: available ? Palette.bark900 : Palette.berry)),
      ),
      AccountUsageOk(:final windows) => Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final w in windows)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            windowLabel(w.label),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: xs.copyWith(color: Palette.bark500),
                          ),
                        ),
                        Text('${(100 - w.usedPercent).round()}%', style: xs.copyWith(color: _textOf(100 - w.usedPercent))),
                      ],
                    ),
                    StaminaBar(
                      quota: Quota(
                        level: levelOf(100 - w.usedPercent),
                        fill: (100 - w.usedPercent) / 100,
                        short: '${(100 - w.usedPercent).round()}%',
                        text: '${windowLabel(w.label)} 剩 ${(100 - w.usedPercent).round()}%',
                      ),
                      width: 150,
                      height: 9,
                    ),
                    if (w.resetsAt != null) Text(resetText(w.resetsAt!), style: xs.copyWith(fontSize: 10, color: Palette.bark400)),
                  ],
                ),
              ),
          ],
        ),
      ),
    };
  }
}

/// The HUD's own card (.hud-card): parchment in a dark outline with a hard drop, a part of the game screen.
class HudCard extends StatelessWidget {
  const HudCard({super.key, required this.child, this.height, this.bright = false, this.dim = false, this.padding = const EdgeInsets.symmetric(horizontal: 8)});
  final Widget child;
  final double? height;
  final bool bright;
  final bool dim;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(right: 2, bottom: 2),
    child: Container(
      height: height,
      padding: padding,
      decoration: BoxDecoration(
        color: dim ? const Color(0xFFE6D5AE) : (bright ? const Color(0xFFF6E6BE) : const Color(0xFFF3E2B8)),
        border: Border.all(color: const Color(0xFF3A2A18), width: 2),
        boxShadow: [BoxShadow(color: const Color(0xFF3A2A18).withValues(alpha: .6), offset: const Offset(2, 2))],
      ),
      child: DefaultTextStyle(
        style: KitText.xs.copyWith(color: Palette.bark900),
        // As tall as `height` when given, else as its content (a bare Center would fill a loose height: the crew's list).
        child: Center(widthFactor: 1, heightFactor: height == null ? 1 : null, child: child),
      ),
    ),
  );
}

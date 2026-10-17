import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../sprites/atlas.dart';
import '../../ui/kit/kit.dart';
import '../../shared/faces.dart';
import '../../data/remote.dart';
import 'runtimes_state.dart';
import '../../rules/quota.dart';
import '../../rules/seeds.dart';
import '../../rules/money.dart';

Color quotaInk(double left) => switch (levelOf(left)) {
  QuotaLevel.plenty => Palette.leaf700,
  QuotaLevel.low || QuotaLevel.gold => const Color(0xFFB8862A),
  QuotaLevel.empty => Palette.berry,
  QuotaLevel.unknown => Palette.bark500,
};

class QuotaPanel extends ConsumerWidget {
  const QuotaPanel({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final runtimes = usableRuntimes(ref.watch(workbenchConfigProvider).runtimes);
    final atlas = ref.watch(atlasProvider).value;
    if (runtimes.isEmpty || atlas == null) return const SizedBox.shrink();
    return SizedBox(
      width: 352,
      child: PxWindow(
        paper: Palette.cream50,
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Expanded(child: Text('剩余额度', style: KitText.sm)),
                PxButton(
                  size: PxSize.icon,
                  tooltip: '现在读一次额度',
                  semanticLabel: '现在读一次额度',
                  onPressed: () {
                    for (final r in runtimes) {
                      ref.read(runtimeBusyProvider.notifier).refresh(r.id);
                    }
                  },
                  child: const SpriteIcon('button-refresh', size: 14),
                ),
              ],
            ),
            const SizedBox(height: 8),
            ConstrainedBox(
              constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * .7 < 512 ? MediaQuery.sizeOf(context).height * .7 : 512),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    for (var i = 0; i < runtimes.length; i++) ...[if (i > 0) const SizedBox(height: 12), QuotaMachine(atlas: atlas, info: runtimes[i])],
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

class QuotaMachine extends StatelessWidget {
  const QuotaMachine({super.key, required this.atlas, required this.info});
  final SpriteAtlas atlas;
  final RuntimeInfo info;

  @override
  Widget build(BuildContext context) {
    final quota = quotaOf(info);
    final stop = info.stop;
    final small = KitText.xs.copyWith(color: Palette.bark500);
    return Container(
      padding: const EdgeInsets.all(8),
      decoration: pxInset(fill: Palette.cream100, line: Palette.cream200),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          RuntimeIcon(runtime: info.id, size: 34),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    Text(runtimeName(info.id), style: KitText.sm),
                    if (info.usage case AccountUsageOk(:final plan?)) ...[
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(plan, style: small, maxLines: 1, overflow: TextOverflow.ellipsis),
                      ),
                    ],
                  ],
                ),
                _UsageLines(usage: info.usage),
                if (info.spentToday case final spent?)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text('今天花了约 ${yuan(spent)}${(info.settings.dailyBudget ?? 0) > 0 ? ' / 预算 ${yuan(info.settings.dailyBudget!)}' : ''}', style: small),
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
                EnergyBottle(atlas: atlas, quota: quota, size: 40),
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

String _pct(double n) => n == n.roundToDouble() ? n.toInt().toString() : n.toString();

class _UsageLines extends StatelessWidget {
  const _UsageLines({required this.usage});
  final AccountUsage? usage;

  @override
  Widget build(BuildContext context) {
    final faint = KitText.xs.copyWith(color: Palette.bark400);
    return switch (usage) {
      null => Text('不报额度', style: faint),
      AccountUsageLoginRequired() => Text('没登录，额度读不到', style: KitText.xs.copyWith(color: const Color(0xFFB8682A))),
      AccountUsageUnavailable(:final reason) => Tooltip(
        message: reason,
        child: Text('读不到：$reason', style: faint, maxLines: 1, overflow: TextOverflow.ellipsis),
      ),
      AccountUsageBalance(:final provider, :final available) => Padding(
        padding: const EdgeInsets.only(top: 2),
        child: Text('按量计费 · $provider 余额${available ? '' : '，不够用了'}', style: KitText.xs.copyWith(color: available ? Palette.bark800 : Palette.berry)),
      ),
      AccountUsageOk(:final windows) => Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final w in windows) ...[
              SizedBox(
                width: 150,
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        windowLabel(w.label),
                        style: KitText.xs.copyWith(color: Palette.bark500),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    Text('${_pct(100 - w.usedPercent)}%', style: KitText.xs.copyWith(color: quotaInk(100 - w.usedPercent))),
                  ],
                ),
              ),
              StaminaBar(
                quota: Quota(
                  level: levelOf(100 - w.usedPercent),
                  fill: (100 - w.usedPercent) / 100,
                  short: '${_pct(100 - w.usedPercent)}%',
                  text: '${windowLabel(w.label)} 剩 ${_pct(100 - w.usedPercent)}%',
                ),
                width: 150,
                height: 9,
              ),
              if (w.resetsAt case final at?) Text(resetText(at), style: KitText.xs.copyWith(color: Palette.bark400, fontSize: 10)),
              const SizedBox(height: 6),
            ],
          ],
        ),
      ),
    };
  }
}

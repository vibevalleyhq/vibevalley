// The helpers' dock in the HUD's lower-left corner (web/src/farm/Hud.tsx FriendsDock, compact): a button with the first
// few faces, how many are busy and whether one needs you; it opens the whole crew above it. Each face opens a card:
// what it is doing, its runtime's stamina, and the way to send it the next job or to its file.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../data/providers.dart';
import '../game/farm.dart';
import '../game/state.dart';
import '../gen/vibevalley.dart';
import '../shell/prefs.dart';
import '../ui/kit/kit.dart';
import '../village/village_view.dart' show agentsProvider, runtimesProvider;
import 'bits.dart';
import 'popover.dart';
import 'quota.dart';
import '../rules/farm.dart';
import '../rules/seeds.dart';

enum FriendStatus { bug, ripe, busy, rest, away }

const _status = {
  FriendStatus.bug: (dot: Palette.berry, label: '地里有虫'),
  FriendStatus.ripe: (dot: Palette.wheat, label: '熟了，等你收'),
  FriendStatus.busy: (dot: Palette.leaf500, label: '在干活'),
  FriendStatus.rest: (dot: Palette.cream300, label: '在地里歇着'),
  FriendStatus.away: (dot: Color(0x00000000), label: '没在农场'),
};

/// An agent's standing on the farm, from its helpers' plots (Hud.tsx statusOf).
FriendStatus statusOf(List<Helper> mine, FarmView view) {
  final crops = [for (final w in mine) plotOf(view, w).crop];
  if (crops.contains(Crop.withered)) return FriendStatus.bug;
  if (crops.any(isRipe)) return FriendStatus.ripe;
  if (mine.any(isBusy)) return FriendStatus.busy;
  return mine.isNotEmpty ? FriendStatus.rest : FriendStatus.away;
}

class FriendsDock extends ConsumerStatefulWidget {
  const FriendsDock({super.key, required this.height});

  /// As tall as a tool slot.
  final double height;

  @override
  ConsumerState<FriendsDock> createState() => _FriendsDockState();
}

class _FriendsDockState extends ConsumerState<FriendsDock> {
  final _link = LayerLink();
  // The crew's list stays in the overlay, faded out and not hit while closed, so it can fade both ways.
  final _portal = OverlayPortalController()..show();

  @override
  Widget build(BuildContext context) {
    final height = widget.height;
    final agents = (ref.watch(agentsProvider).value ?? const <String, AgentProfile>{}).values.toList();
    final helpers = ref.watch(farmProvider.select((s) => s?.helpers)) ?? const <Helper>[];
    final view = ref.watch(viewProvider) ?? const FarmView(level: FarmLevel(level: 1, xp: 0, need: 10), plots: {});
    final open = ref.watch(friendsOpenProvider);
    final sorted = [...agents.where((a) => a.enabled), ...agents.where((a) => !a.enabled)];
    final statuses = [for (final a in sorted) statusOf(helpers.where((h) => h.agent == a.id).toList(), view)];
    final busy = statuses.where((s) => s == FriendStatus.busy).length;
    final attention = statuses.contains(FriendStatus.bug)
        ? FriendStatus.bug
        : statuses.contains(FriendStatus.ripe)
        ? FriendStatus.ripe
        : null;
    void toggle() => ref.read(friendsOpenProvider.notifier).set(!open);
    // The crew, floating above the button rather than widening the row.
    final list = IgnorePointer(
      ignoring: !open,
      child: AnimatedOpacity(
        opacity: open ? 1 : 0,
        duration: const Duration(milliseconds: 200),
        child: AnimatedSlide(
          offset: open ? Offset.zero : const Offset(0, .05),
          duration: const Duration(milliseconds: 200),
          child: ConstrainedBox(
            constraints: BoxConstraints(maxWidth: (MediaQuery.sizeOf(context).width * .9).clamp(0, 640)),
            child: HudCard(
              padding: const EdgeInsets.all(6),
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    for (final (i, a) in sorted.indexed) ...[if (i > 0) const SizedBox(width: 4), Friend(agent: a, status: statuses[i])],
                    const SizedBox(width: 4),
                    KitTappable(
                      onTap: () => context.go('/agents/new'),
                      builder: (context, s) => Container(
                        width: 72,
                        color: s.hovered ? Palette.cream200 : null,
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Container(
                              width: 48,
                              height: 48,
                              decoration: BoxDecoration(border: Border.all(color: Palette.cream300, width: 2)),
                              alignment: Alignment.center,
                              child: const SpriteIcon('button-add', size: 20),
                            ),
                            const SizedBox(height: 2),
                            Text('捏帮工', style: KitText.xs.copyWith(color: Palette.bark600)),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
    return Semantics(
      label: '帮工',
      container: true,
      child: CompositedTransformTarget(
        link: _link,
        child: OverlayPortal(
          controller: _portal,
          overlayChildBuilder: (context) => CompositedTransformFollower(
            link: _link,
            targetAnchor: Alignment.topLeft,
            followerAnchor: Alignment.bottomLeft,
            offset: const Offset(0, -4),
            child: Align(alignment: Alignment.bottomLeft, child: list),
          ),
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              KitTappable(
                onTap: toggle,
                semanticLabel: '帮工',
                selected: open,
                builder: (context, s) => HudCard(
                  height: height,
                  bright: s.hovered && !open,
                  dim: open,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      SizedBox(
                        width: sorted.isEmpty ? 0 : 22 + (sorted.take(3).length - 1) * 12,
                        height: 22,
                        child: Stack(
                          children: [for (var i = sorted.take(3).length - 1; i >= 0; i--) Positioned(left: i * 12.0, child: AgentFace(sorted[i].id, size: 22))],
                        ),
                      ),
                      const SizedBox(width: 6),
                      Text('帮工', style: KitText.xs.copyWith(color: Palette.bark900)),
                      if (busy > 0) ...[
                        const SizedBox(width: 6),
                        Container(
                          constraints: const BoxConstraints(minWidth: 16),
                          height: 16,
                          color: Palette.leaf500,
                          padding: const EdgeInsets.symmetric(horizontal: 4),
                          alignment: Alignment.center,
                          child: Text('$busy', style: KitText.xs.copyWith(fontSize: 10, color: Palette.cream50, height: 1)),
                        ),
                      ],
                      const SizedBox(width: 6),
                      // The chevron (the page's ›, turned): down while closed, up while open.
                      AnimatedRotation(
                        turns: open ? 0.5 : 0,
                        duration: const Duration(milliseconds: 200),
                        child: const RotatedBox(quarterTurns: 1, child: SpriteIcon('button-next', size: 12)),
                      ),
                    ],
                  ),
                ),
              ),
              if (attention != null)
                Positioned(
                  left: -4,
                  top: -4,
                  child: Container(
                    width: 10,
                    height: 10,
                    decoration: BoxDecoration(
                      color: _status[attention]!.dot,
                      border: Border.all(color: Palette.cream300, width: 2),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One of the crew: its face, its name, its stamina; a card above it.
class Friend extends ConsumerWidget {
  const Friend({super.key, required this.agent, required this.status});
  final AgentProfile agent;
  final FriendStatus status;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pick = ref.watch(prefsProvider.select((p) => p.pick));
    final tally = ref.watch(farmProvider.select((s) => s?.progress?.agents?[agent.id]));
    final atlas = ref.watch(atlasProvider).value;
    final usage = (ref.watch(runtimesProvider).value ?? const <RuntimeInfo>[]).where((r) => r.id == agent.runtime).firstOrNull?.usage;
    final quota = quotaOf(usage);
    final picked = pick == agent.id;
    final st = _status[status]!;
    return FarmPopover(
      offset: 10,
      width: 288,
      trigger: (context, open, toggle) => KitTappable(
        onTap: toggle,
        semanticLabel: '${agent.name}，${st.label}',
        builder: (context, s) => Container(
          width: 72,
          color: picked ? tint(Palette.leaf300, .6) : (s.hovered ? Palette.cream200 : null),
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Stack(
            children: [
              Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    color: picked ? Palette.leaf500 : Palette.cream300,
                    padding: const EdgeInsets.all(2),
                    child: AgentFace(agent.id, size: 46, muted: !agent.enabled),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    agent.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: KitText.xs.copyWith(color: agent.enabled ? Palette.bark900 : Palette.bark400),
                  ),
                  if (quota.level == QuotaLevel.unknown) const SizedBox(height: 7) else StaminaBar(quota: quota, segments: 8, width: 52, height: 7),
                ],
              ),
              if (status != FriendStatus.away)
                Positioned(
                  top: 0,
                  right: 10,
                  child: Container(
                    width: 12,
                    height: 12,
                    decoration: BoxDecoration(
                      color: st.dot,
                      border: Border.all(color: Palette.cream300, width: 2),
                    ),
                  ),
                ),
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
                AgentFace(agent.id, size: 60, muted: !agent.enabled),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(agent.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: KitText.lg),
                      Text(
                        '${runtimeName(agent.runtime)}${agent.model.isNotEmpty ? ' · ${agent.model}' : ''}',
                        style: KitText.xs.copyWith(color: Palette.bark600),
                      ),
                      Text(
                        '${st.label}${tally != null ? ' · 请过 ${tally.hired.round()} 次，收成 ${tally.harvested.round()} 次' : ''}',
                        style: KitText.xs.copyWith(color: Palette.bark800),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Container(
              color: Palette.cream100,
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              child: Row(
                children: [
                  if (atlas != null) EnergyBottle(atlas: atlas, quota: quota, size: 30),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('精力 ${quota.short.isEmpty ? '—' : quota.short}', style: KitText.xs.copyWith(color: Palette.bark800)),
                        Tooltip(
                          message: quota.text,
                          child: Text(
                            '${runtimeName(agent.runtime)}：${quota.text}',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: KitText.xs.copyWith(color: Palette.bark500),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            Text(agent.role, style: KitText.sm.copyWith(color: Palette.bark800)),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: agent.enabled
                      ? PxButton.text(
                          picked ? '不再指定' : '下一单派它',
                          tone: picked ? PxTone.plain : PxTone.primary,
                          onPressed: () => ref.read(prefsProvider.notifier).setPick(picked ? 'auto' : agent.id),
                        )
                      : Text('停用了，派不出去', style: KitText.sm.copyWith(color: Palette.bark600)),
                ),
                const SizedBox(width: 8),
                PxButton.text(
                  '档案',
                  onPressed: () {
                    close();
                    context.go('/agents/${Uri.encodeComponent(agent.id)}');
                  },
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

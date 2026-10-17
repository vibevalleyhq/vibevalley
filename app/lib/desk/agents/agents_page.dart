import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../ui/kit/kit.dart';
import '../../shared/faces.dart';
import '../../shared/looks.dart';
import '../shared/rules.dart';
import '../../data/remote.dart';
import '../../shared/widgets.dart';
import '../../rules/seeds.dart';

class AgentsPage extends ConsumerWidget {
  const AgentsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final config = ref.watch(deskConfigProvider);
    final farm = ref.watch(farmProvider);
    final tallies = farm?.progress?.agents ?? const <String, AgentTally>{};
    final workers = farm?.workers ?? const <Worker>[];
    final skillName = {for (final s in config.skills) s.id: s.name};

    final cards = <Widget>[
      const _ManagerCard(),
      for (final a in config.agents)
        _AgentCard(
          agent: a,
          runtime: config.runtime(a.runtime),
          tally: tallies[a.id],
          here: workers.where((h) => h.agent == a.id).length,
          skillName: skillName,
        ),
      const _NewCard(),
    ];

    return PxScrollView(
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 1152),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 12, 24, 32),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Wrap(
                  alignment: WrapAlignment.spaceBetween,
                  crossAxisAlignment: WrapCrossAlignment.end,
                  runSpacing: 12,
                  spacing: 12,
                  children: [
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 576),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text.rich(
                            TextSpan(
                              text: '帮工 ',
                              children: [
                                TextSpan(
                                  text: 'Agent',
                                  style: KitText.sm.copyWith(color: Palette.bark500),
                                ),
                              ],
                            ),
                            style: KitText.x2l,
                          ),
                          const SizedBox(height: 4),
                          Text('每个帮工是一种配置好的 runtime：用哪个 runtime 和模型、带什么人设和技能，在农场里是哪种小动物、穿什么。管家派活时派的就是帮工。', style: KitText.sm.copyWith(color: Palette.bark600)),
                        ],
                      ),
                    ),
                    const _NewButton(),
                  ],
                ),
                const SizedBox(height: 24),
                LayoutBuilder(
                  builder: (context, box) {
                    final cols = box.maxWidth >= 1024 ? 3 : (box.maxWidth >= 640 ? 2 : 1);
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        for (var i = 0; i < cards.length; i += cols)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 12),
                            child: IntrinsicHeight(
                              child: Row(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: [
                                  for (var j = 0; j < cols; j++) ...[
                                    if (j > 0) const SizedBox(width: 12),
                                    Expanded(child: i + j < cards.length ? cards[i + j] : const SizedBox()),
                                  ],
                                ],
                              ),
                            ),
                          ),
                      ],
                    );
                  },
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _NewButton extends StatelessWidget {
  const _NewButton();

  @override
  Widget build(BuildContext context) => KitTappable(
    onTap: () => deskGo(context, '/agents/new'),
    semanticLabel: '捏一个新帮工',
    builder: (context, s) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      color: s.hovered ? Palette.leafHover : Palette.leaf500,
      foregroundDecoration: pxRing,
      child: Text('捏一个新帮工', style: KitText.sm.copyWith(color: Palette.cream50)),
    ),
  );
}

class _Card extends StatefulWidget {
  const _Card({required this.path, required this.label, required this.child, this.corner, this.muted = false});
  final String path;
  final String label;
  final Widget child;

  final Widget Function(bool shown)? corner;
  final bool muted;

  @override
  State<_Card> createState() => _CardState();
}

class _CardState extends State<_Card> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) => MouseRegion(
    onEnter: (_) => setState(() => _hover = true),
    onExit: (_) => setState(() => _hover = false),
    child: AnimatedSlide(
      duration: const Duration(milliseconds: 150),
      offset: Offset(0, _hover ? -2 / 200 : 0),
      child: Opacity(
        opacity: widget.muted ? .6 : 1,
        child: PxWindow(
          clip: true,
          child: Stack(
            children: [
              KitTappable(
                onTap: () => deskGo(context, widget.path),
                semanticLabel: widget.label,
                builder: (context, s) => Container(padding: const EdgeInsets.all(16), foregroundDecoration: pxRing, child: widget.child),
              ),
              if (widget.corner != null) Positioned(top: 12, right: 12, child: widget.corner!(_hover)),
            ],
          ),
        ),
      ),
    ),
  );
}

Widget _footer(List<Widget> children) => Container(
  margin: const EdgeInsets.only(top: 12),
  padding: const EdgeInsets.only(top: 12),
  decoration: const BoxDecoration(
    border: Border(top: BorderSide(color: Palette.cream300)),
  ),
  child: DefaultTextStyle(
    style: KitText.fine.copyWith(color: Palette.bark500),
    child: Row(children: children),
  ),
);

class _ManagerCard extends StatelessWidget {
  const _ManagerCard();

  @override
  Widget build(BuildContext context) => _Card(
    path: '/manager',
    label: '管家',
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(width: 80, height: 80, color: Palette.cream200, alignment: Alignment.center, child: const DeskManagerFace(size: 68)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('管家', style: KitText.base),
                  const SizedBox(height: 2),
                  Text(
                    '不下地：派活、盯进度、转告结果，也接电话。',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: KitText.xs.copyWith(height: 1.625, color: Palette.bark600),
                  ),
                ],
              ),
            ),
          ],
        ),
        const Spacer(),
        _footer(const [Text('记性'), SizedBox(width: 12), Text('旧账'), SizedBox(width: 12), Text('声音')]),
      ],
    ),
  );
}

class _AgentCard extends ConsumerWidget {
  const _AgentCard({required this.agent, required this.runtime, required this.tally, required this.here, required this.skillName});
  final Agent agent;
  final RuntimeInfo? runtime;
  final AgentTally? tally;
  final int here;
  final Map<String, String> skillName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final a = agent;
    final errors = (watchAgentIssues(ref, [a])[a.id] ?? const <AgentIssue>[]).where((i) => i.level == AgentIssueLevel.error).toList();
    final available = runtime?.installation is InstallationAvailable;
    return _Card(
      path: '/agents/${Uri.encodeComponent(a.id)}',
      label: a.name,
      muted: !a.enabled,
      corner: (shown) => _Toggle(agent: a, shown: shown),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // A gradient in a BoxDecoration takes the place of its colour.
              ColoredBox(
                color: Palette.cream200,
                child: Container(
                  width: 80,
                  height: 80,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    gradient: RadialGradient(
                      center: const Alignment(0, .4),
                      radius: .7,
                      colors: [
                        hexColor(a.look.hat).withValues(alpha: 0x33 / 255),
                        hexColor(a.look.hat).withValues(alpha: 0),
                      ],
                    ),
                  ),
                  child: AgentFace(look: a.look, id: a.id, size: 68, muted: !a.enabled),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(a.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: KitText.base),
                        ),
                        if (here > 0) ...[const SizedBox(width: 8), DeskBadge('在场 $here', hat: true)],
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      a.role,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: KitText.xs.copyWith(height: 1.625, color: Palette.bark600),
                    ),
                    const SizedBox(height: 6),
                    DefaultTextStyle(
                      style: KitText.fine.copyWith(color: Palette.bark500),
                      child: Row(
                        children: [
                          Container(width: 6, height: 6, color: available ? Palette.leaf500 : Palette.berry),
                          const SizedBox(width: 6),
                          Text(runtimeName(a.runtime)),
                          if (a.model.isNotEmpty) Flexible(child: Text(' · ${a.model}', maxLines: 1, overflow: TextOverflow.ellipsis)),
                          if (a.effort.isNotEmpty) Text(' · ${a.effort}'),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (a.skills.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Wrap(
                spacing: 4,
                runSpacing: 4,
                children: [
                  for (final id in a.skills)
                    Container(
                      color: Palette.cream200,
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      child: Text(skillName[id] ?? id, style: KitText.fine.copyWith(color: Palette.bark800)),
                    ),
                ],
              ),
            ),
          const Spacer(),
          _footer([
            Tooltip(
              message: '从这份档案派出去的帮工，干的活收进主分支的次数（服务端的账本）',
              child: Text.rich(
                TextSpan(
                  text: '雇过 ',
                  children: [
                    TextSpan(
                      text: '${(tally?.hired ?? 0).round()}',
                      style: const TextStyle(color: Palette.bark800),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 12),
            Text.rich(
              TextSpan(
                text: '收成 ',
                children: [
                  TextSpan(
                    text: '${(tally?.harvested ?? 0).round()}',
                    style: const TextStyle(color: Palette.leaf700),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: errors.isNotEmpty
                  ? Tooltip(
                      message: errors.map((e) => e.text).join('\n'),
                      child: Text(
                        '派不出去：${errors.first.text}',
                        textAlign: TextAlign.right,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(color: Palette.berry),
                      ),
                    )
                  : Text(a.tags.take(4).join(' · '), textAlign: TextAlign.right, maxLines: 1, overflow: TextOverflow.ellipsis),
            ),
          ]),
        ],
      ),
    );
  }
}

class _Toggle extends ConsumerWidget {
  const _Toggle({required this.agent, required this.shown});
  final Agent agent;
  final bool shown;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final a = agent;
    final label = a.enabled ? '停用' : '启用';
    return KitTappable(
      onTap: () => deskRun(() => ref.read(deskConfigProvider.notifier).saveAgent(a.copyWith(enabled: !a.enabled))),
      semanticLabel: '$label ${a.name}',
      builder: (context, s) => Opacity(
        opacity: shown || s.focused ? 1 : 0,
        child: Container(
          color: Palette.cream200.withValues(alpha: .8),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          child: Text(label, style: KitText.xs.copyWith(color: s.hovered ? Palette.bark900 : Palette.bark600)),
        ),
      ),
    );
  }
}

class _NewCard extends StatelessWidget {
  const _NewCard();

  @override
  Widget build(BuildContext context) => KitTappable(
    onTap: () => deskGo(context, '/agents/new'),
    semanticLabel: '捏一个新帮工',
    builder: (context, s) {
      final ink = s.hovered ? Palette.leaf700 : Palette.bark600;
      return CustomPaint(
        painter: _Dashed(s.hovered ? Palette.leaf500.withValues(alpha: .5) : Palette.cream300),
        child: Container(
          constraints: const BoxConstraints(minHeight: 176),
          alignment: Alignment.center,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SpriteIcon('button-add', size: 28),
              const SizedBox(height: 8),
              Text('捏一个新帮工', style: KitText.sm.copyWith(color: ink)),
            ],
          ),
        ),
      );
    },
  );
}

class _Dashed extends CustomPainter {
  _Dashed(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = color;
    const dash = 6.0, gap = 4.0, w = 2.0;
    for (var x = 0.0; x < size.width; x += dash + gap) {
      canvas
        ..drawRect(Rect.fromLTWH(x, 0, dash, w), p)
        ..drawRect(Rect.fromLTWH(x, size.height - w, dash, w), p);
    }
    for (var y = 0.0; y < size.height; y += dash + gap) {
      canvas
        ..drawRect(Rect.fromLTWH(0, y, w, dash), p)
        ..drawRect(Rect.fromLTWH(size.width - w, y, w, dash), p);
    }
  }

  @override
  bool shouldRepaint(_Dashed old) => old.color != color;
}

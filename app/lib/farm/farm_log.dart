import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../data/providers.dart';
import '../game/state.dart';
import '../gen/vibevalley.dart';
import '../shell/prefs.dart';
import '../ui/kit/kit.dart';
import '../data/remote.dart' show agentsProvider;
import 'bits.dart';
import '../rules/chat.dart';
import '../rules/issues.dart' show issueTitle;
import '../rules/warehouse.dart';
import '../shared/faces.dart';
import '../shared/tags.dart';
import '../rules/money.dart';

class Warehouse extends ConsumerWidget {
  const Warehouse({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final stored = harvestedOf(ref.watch(stateProvider));
    if (stored.isEmpty) return const FarmEmpty('仓库还空着。收获进主分支的活会放在这里。');
    final plans = ref.watch(plansProvider);
    final agents = ref.watch(agentsProvider).value ?? const <String, Agent>{};
    final now = DateTime.now().millisecondsSinceEpoch;
    return LayoutBuilder(
      builder: (context, box) {
        final w = box.maxWidth >= 600 ? (box.maxWidth - 8) / 2 : box.maxWidth;
        return Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final i in stored)
              SizedBox(
                width: w,
                child: KitTappable(
                  onTap: () {
                    if (i.plan != null) {
                      ref.read(planShownProvider.notifier).set(i.id);
                      ref.read(panelProvider.notifier).set(FarmPanel.plans);
                    } else {
                      context.go('/issues/${Uri.encodeComponent(i.id)}');
                    }
                  },
                  semanticLabel: issueTitle(i, plans),
                  builder: (context, s) => Container(
                    color: s.hovered ? Palette.cream200 : Palette.cream100,
                    padding: const EdgeInsets.all(12),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        SpriteIcon(i.plan != null ? 'icon-plan' : 'icon-harvest', size: 40),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(issueTitle(i, plans), maxLines: 2, overflow: TextOverflow.ellipsis, style: KitText.sm),
                              const SizedBox(height: 4),
                              Text(
                                [
                                  if (i.plan != null) '种植计划',
                                  if (i.assignee case final a?) agents[a]?.name ?? a,
                                  ?i.project,
                                  if (i.closedAt case final at?) '${ago(at, now)}收的',
                                ].join(' · '),
                                style: KitText.xs.copyWith(color: Palette.bark600),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

const _outcomeTag = {
  Outcome.completed: ('做完', Color(0xFFEFCF92), Palette.bark900),
  Outcome.failed: ('没过', Color(0xFFF0CDA6), Palette.berry),
  Outcome.interrupted: ('叫停', Palette.cream200, Palette.bark600),
};

sealed class _Row {
  const _Row(this.at);
  final double at;
}

final class _SaidRow extends _Row {
  const _SaidRow(this.message) : super(0);
  final ChatMessage message;
  @override
  double get at => message.at;
}

final class _ReportRow extends _Row {
  const _ReportRow(this.report) : super(0);
  final ChatMessage report;
  @override
  double get at => report.at;
}

/// Voice captions carry no times, so the log keeps to the typed lines.
class FarmLog extends ConsumerWidget {
  const FarmLog({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(stateProvider);
    final look = ref.watch(prefsProvider.select((p) => p.managerLook)) ?? 'farmer';
    final chat = s?.chat;
    final rows = <_Row>[
      for (final m in messagesIn(chat, generalOf(chat)?.id ?? ""))
        if (m.kind == MessageKind.chat && (m.fromKind == SenderKind.user || m.fromKind == SenderKind.manager)) _SaidRow(m),
      for (final r in turnReportsOf(s)) _ReportRow(r),
    ]..sort((a, b) => b.at.compareTo(a.at));
    if (rows.isEmpty) return const FarmEmpty('还没有事。开工以后，你和管家说的话、谁做完了什么，都记在这里。');
    final shown = rows.take(80).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (i, row) in shown.indexed) ...[
          if (i > 0) const DashedLine(),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 44,
                  child: Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(
                      clockOf(row.at),
                      textAlign: TextAlign.right,
                      style: KitText.xs.copyWith(color: Palette.bark400),
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                ...switch (row) {
                  _SaidRow(:final message) => _said(message, look),
                  _ReportRow(:final report) => _report(report, issueOfSession(s, report.session ?? report.from)),
                },
              ],
            ),
          ),
        ],
      ],
    );
  }

  List<Widget> _said(ChatMessage m, String look) {
    final you = m.fromKind == SenderKind.user;
    return [
      if (you)
        Container(
          width: 32,
          height: 32,
          color: Palette.leaf500,
          alignment: Alignment.center,
          child: Text('你', style: KitText.xs.copyWith(color: Palette.cream50)),
        )
      else
        ManagerFaceOf(size: 32, look: look),
      const SizedBox(width: 10),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _Who(
              name: you ? '你' : '管家',
              tag: FarmTag(you ? '说' : (m.final_ ? '答' : '正在说'), ink: Palette.bark600),
            ),
            const SizedBox(height: 2),
            PxMarkdown(m.text, style: KitText.sm.copyWith(color: you ? Palette.bark900 : Palette.bark800)),
          ],
        ),
      ),
    ];
  }

  List<Widget> _report(ChatMessage r, Issue? issue) {
    final outcome = r.outcome ?? Outcome.completed;
    final (text, fill, ink) = _outcomeTag[outcome]!;
    return [
      AgentFaceOf(r.agent ?? '', size: 32),
      const SizedBox(width: 10),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _Who(
              name: r.name,
              tag: FarmTag(text, fill: fill, ink: ink),
            ),
            const SizedBox(height: 2),
            if (issue != null) Text(issue.title, style: KitText.sm),
            Text(
              r.text,
              maxLines: 4,
              overflow: TextOverflow.ellipsis,
              style: KitText.xs.copyWith(color: outcome == Outcome.failed ? Palette.berry : Palette.bark600),
            ),
            if (r.spent != null) Text('这一轮花了 ${spentText(r.spent!)}', style: KitText.xs.copyWith(color: Palette.bark400)),
          ],
        ),
      ),
    ];
  }
}

class _Who extends StatelessWidget {
  const _Who({required this.name, required this.tag});
  final String name;
  final Widget tag;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Text(name, style: KitText.sm),
      const SizedBox(width: 6),
      tag,
    ],
  );
}

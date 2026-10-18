import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../data/providers.dart';
import '../data/ui_state.dart';
import '../chat/chat_state.dart';
import '../data/remote.dart';
import '../game/commands.dart' show fire;
import '../gen/vibevalley.dart';
import '../rules/chat.dart';
import '../rules/issues.dart';
import '../shared/issue_view.dart';

class PlotDetail extends ConsumerWidget {
  const PlotDetail({super.key, required this.session, required this.onDone});
  final Session session;
  final VoidCallback onDone;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(stateProvider);
    final issue = state?.issues?.where((i) => i.id == session.issueId).firstOrNull;
    final history = issue == null ? null : ref.watch(issueHistoryProvider).value?.where((h) => h.issue.id == issue.id).firstOrNull;
    final sessions = history?.sessions ?? [session];
    final issueId = issue?.id ?? session.issue;
    final hasThread = issueId != null && issueThreadOf(state?.chat, issueId) != null;
    return IssueView(
      frame: IssueFrame.farm,
      issue: issue,
      sessions: sessions,
      session: session,
      state: issue == null ? (session.phase is PhaseWorking || session.phase is PhaseArriving ? IssueTag.working : IssueTag.waiting) : issueTag(issue),
      onHarvest: (session) async {
        ref.read(farmOverlaysProvider.notifier).review(session.id);
        onDone();
      },
      onClose: (session) async {
        await ref
            .read(apiProvider)
            .issue
            .status(
              id: session.issueId,
              body: const IssueStatusRequest(status: IssueStatus.canceled),
            );
        onDone();
      },
      onThread: !hasThread
          ? null
          : () {
              fire(ref.read(chatActionsProvider).showIssueThread(issueId));
              ref.read(chatOpenProvider.notifier).set(true);
              onDone();
            },
      onNavigate: () => context.go('/issues/${Uri.encodeComponent(issue?.id ?? session.issueId)}'),
      onTask: session.graph == null
          ? null
          : () {
              ref.read(graphShownProvider.notifier).set(session.graph!.id);
              ref.read(farmOverlaysProvider.notifier).panel(FarmPanel.taskBoard);
              onDone();
            },
    );
  }
}

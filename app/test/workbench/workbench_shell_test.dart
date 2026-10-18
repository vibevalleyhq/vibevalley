import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/workbench/places.dart';
import 'package:vibevalley/workbench/agents/agent_creator_page.dart';
import 'package:vibevalley/workbench/workbench_shell.dart';

import '../support/workbench.dart';

void main() {
  for (final id in ['backend', 'new']) {
    testWidgets('agent $id: the full editor toolbar fits 390 pixels', (t) async {
      final backend = WorkbenchBackend(agents: [agent('backend', '一个名字很长的帮工档案')], runtimes: [runtime('claude')]);
      await pumpPage(
        t,
        Workbench(
          place: Place.agents,
          child: AgentCreatorPage(id: id),
        ),
        backend.handle,
        farm: const CoreState(call: CallState.live, manager: ManagerState.listening, sessions: []),
        size: const Size(390, 844),
      );
      expect(find.text(id == 'new' ? '捏好了，保存' : '已保存'), findsOneWidget);
      expect(t.takeException(), isNull);
    });
  }
  for (final place in [Place.agents, Place.runtimes, Place.settings]) {
    testWidgets('${place.name}: the configuration header fits 390 pixels while the farm is open', (t) async {
      await pumpPage(
        t,
        Workbench(place: place, child: const SizedBox()),
        WorkbenchBackend().handle,
        farm: const CoreState(call: CallState.live, manager: ManagerState.listening, sessions: []),
        size: const Size(390, 844),
      );
      expect(t.takeException(), isNull);
      expect(find.text(place.label), findsOneWidget);
      expect(find.text('0 个在干活'), findsOneWidget);
      expect(find.text(place.hint), findsNothing);
    });
  }
}

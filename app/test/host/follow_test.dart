import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/data/server.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/host/follow.dart';
import 'package:vibevalley/host/notify.dart';

InboxItem _call(String id, InboxKind kind) => InboxItem(
  id: id,
  kind: kind,
  from: const InboxFromSession(id: 'w1', name: '阿土', agent: 'oar'),
  text: '修好登录页',
  at: 1,
  target: const InboxTargetSession(id: 'w1'),
);

StateFrame _frame(List<InboxItem> inbox) => StateFrame(
  state: CoreState.fromJson({
    'call': 'live',
    'manager': ManagerState.values.first.wire,
    'sessions': const <Object>[],
    'chat': {'conversations': const <Object>[], 'messages': const <Object>[]},
  }),
  inbox: inbox,
  plans: const [],
  view: const FarmView(level: FarmLevel(level: 1, xp: 0, need: 10), plots: {}),
  effects: const [],
);

void main() {
  test('one follow sends calls to the delivery, and tray summaries beside them', () async {
    final frames = StreamController<ReceivedFrame>.broadcast();
    final effects = StreamController<GameEffect>.broadcast();
    final sides = StreamController<SideEvent>.broadcast();
    final notices = <HostNotice>[];
    final trays = <TraySummary>[];
    final c = ProviderContainer(
      overrides: [
        stateFrameProvider.overrideWith((ref) => frames.stream),
        effectsProvider.overrideWith((ref) => effects.stream),
        sideEventsProvider.overrideWith((ref) => sides.stream),
        hostDeliveryProvider.overrideWithValue(HostDelivery(notify: (n) async => notices.add(n), tray: (s) async => trays.add(s))),
      ],
    );
    addTearDown(() async {
      await frames.close();
      await effects.close();
      await sides.close();
      c.dispose();
    });
    c.listen(hostFollowProvider, (_, _) {});
    await Future<void>.delayed(Duration.zero);
    expect(trays.single, TraySummary.opening);

    frames.add(ReceivedFrame(_frame(const []), bytes: 0, decodeMicros: 0));
    await Future<void>.delayed(Duration.zero);
    frames.add(ReceivedFrame(_frame([_call('w1:merge:1', InboxKind.merge)]), bytes: 0, decodeMicros: 0));
    await Future<void>.delayed(Duration.zero);
    expect(notices.map((n) => n.title), ['阿土 做完了']);
    expect(trays.last.title, '1!');

    effects.add(const GameEffectAchievement(achievement: 'harvests', tier: 2));
    await Future<void>.delayed(Duration.zero);
    expect(notices.last.title, '升到银牌：小有收成');

    sides.add(const SideEventNotice(at: 0, level: NoticeLevel.error, text: '数据库坏了'));
    await Future<void>.delayed(Duration.zero);
    expect(notices.last.title, '码农场物语');
  });

  test('a delivery that cannot notify now keeps the tray and drops the call', () async {
    final frames = StreamController<ReceivedFrame>.broadcast();
    final notices = <HostNotice>[];
    final c = ProviderContainer(
      overrides: [
        stateFrameProvider.overrideWith((ref) => frames.stream),
        effectsProvider.overrideWith((ref) => const Stream<GameEffect>.empty()),
        sideEventsProvider.overrideWith((ref) => const Stream<SideEvent>.empty()),
        hostDeliveryProvider.overrideWithValue(HostDelivery(notify: (n) async => notices.add(n), canNotify: () => false)),
      ],
    );
    addTearDown(() async {
      await frames.close();
      c.dispose();
    });
    c.listen(hostFollowProvider, (_, _) {});
    await Future<void>.delayed(Duration.zero);
    frames.add(ReceivedFrame(_frame(const []), bytes: 0, decodeMicros: 0));
    await Future<void>.delayed(Duration.zero);
    frames.add(ReceivedFrame(_frame([_call('w1:fix:2', InboxKind.fix)]), bytes: 0, decodeMicros: 0));
    await Future<void>.delayed(Duration.zero);
    expect(notices, isEmpty);
  });
}

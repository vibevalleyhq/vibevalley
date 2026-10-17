import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/host/command.dart';
import 'package:vibevalley/host/mobile_notices.dart';

void main() {
  test('a tap waits for a screen, then opens what the notification was about', () async {
    final notices = PhoneNotices.instance;
    notices.open(jsonEncode(const HostOpenSession('w3').toJson()));
    final got = <HostCommand>[];
    final sub = notices.commands.listen(got.add);
    await Future<void>.delayed(Duration.zero);
    notices.open(jsonEncode(const HostOpenAchievements().toJson()));
    notices.open('');
    notices.open('not json');
    await Future<void>.delayed(Duration.zero);
    await sub.cancel();
    expect(got.map((c) => c.toJson()), [
      {'type': 'session', 'id': 'w3'},
      {'type': 'achievements'},
    ]);
  });
}

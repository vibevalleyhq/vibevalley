// The generated shapes read what the server's own encoder writes (schema/state-frame.sample.json, written by the Go
// server's protocol/golden_test.go), so a protocol change that breaks the client shows up here.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/gen/vibevalley.dart';

void main() {
  test('the server-encoded sample frame decodes: helpers, their phase and play, the general, the view, the effects', () {
    final frame = StateFrame.fromJson(jsonDecode(File('schema/state-frame.sample.json').readAsStringSync()) as Map<String, dynamic>);
    final state = frame.state;
    expect(state.call, CallState.live);
    expect(state.workers.single.name, 'Pi 实验员');
    final phase = state.workers.single.phase;
    expect(phase, isA<PhaseWorking>());
    expect((phase as PhaseWorking).doing.label, '改 checkin.ts');
    expect(state.chat!.messages.map((m) => m.text), ['让 Pi 实验员写打卡', '好，派给 Pi 实验员了']);
    expect(state.chat!.messages.last.final_, isFalse);
    expect(state.workers.single.play?.station, 2);
    expect(state.workers.single.play?.files, ['src/checkin.ts']);
    expect(frame.view.level.level, greaterThanOrEqualTo(1));
    expect(frame.effects.single, isA<GameEffectLevelUp>().having((e) => e.level, 'level', 2));
  });
}

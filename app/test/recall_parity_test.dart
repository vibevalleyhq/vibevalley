// schema/recall.sample.json is written by Go's server/internal/protocol/recall_sample_test.go; regenerate: cd server && go test ./internal/protocol -update

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/desk/shared/recall.dart';
import 'package:vibevalley/gen/vibevalley.dart';

void main() {
  final cases = (jsonDecode(File('schema/recall.sample.json').readAsStringSync()) as List).cast<Map<String, dynamic>>();

  for (final c in cases) {
    test('pick agrees with Go: ${c['name']}', () {
      final cue = c['cue'] as Map<String, dynamic>;
      final picked = pick(
        [for (final m in c['memories'] as List) Memory.fromJson(m as Map<String, dynamic>)],
        Cue(
          helper: cue['helper'] as String,
          project: cue['project'] as String,
          text: cue['text'] as String,
          skip: {...(cue['skip'] as List).cast<String>()},
          now: cue['now'] as num,
        ),
      );
      expect(picked.map((m) => m.id).toList(), c['pick'], reason: 'recall.sample.json case "${c['name']}"');
    });
  }
}

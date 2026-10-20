// The harvest's checklist, as decisions: what was changed and how it reads. The farm (shared/harvest.dart) and the
// workbench (workbench/issues/harvest_review.dart) each draw it.

import 'dart:math' as math;

import '../gen/vibevalley.dart';

/// A binary file counts -1: not counted.
(int, int) lineCounts(Changes c) =>
    (c.files.fold(0, (n, f) => n + math.max(0, f.added.round())), c.files.fold(0, (n, f) => n + math.max(0, f.removed.round())));

/// Nothing to merge: harvesting only lets the helper go.
bool nothingChanged(Changes c) => c.commits.isEmpty && c.uncommitted.isEmpty;

/// What a git status letter is, as a mark and a word; an unknown one is itself.
({String mark, String label}) changeKind(String status) => switch (status) {
  'A' => (mark: '新', label: '新增'),
  'M' => (mark: '改', label: '修改'),
  'D' => (mark: '删', label: '删除'),
  _ => (mark: status, label: status),
};

enum PatchMark { added, removed, hunk, plain }

PatchMark patchMarkOf(String line) => line.startsWith('+')
    ? PatchMark.added
    : line.startsWith('-')
    ? PatchMark.removed
    : line.startsWith('@@')
    ? PatchMark.hunk
    : PatchMark.plain;

/// A patch from its first hunk: the header above it says nothing the file row does not.
List<String> patchLines(String text) {
  final lines = text.split('\n');
  final from = lines.indexWhere((l) => l.startsWith('@@'));
  return lines.sublist(math.max(0, from));
}

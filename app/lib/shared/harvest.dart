import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../game/commands.dart';
import '../game/state.dart' show fireBedEffects;
import '../gen/vibevalley.dart';
import '../ui/kit/kit.dart';
import '../data/providers.dart';
import '../data/remote.dart' show SessionIssue;
import 'tags.dart';

sealed class Loaded {
  const Loaded();
}

final class Loading extends Loaded {
  const Loading();
}

final class LoadFailed extends Loaded {
  const LoadFailed(this.reason);
  final String reason;
}

final class LoadReady extends Loaded {
  const LoadReady(this.changes);
  final Changes changes;
}

Future<Loaded> loadChanges(Future<Changes> Function() fetch) async {
  try {
    return LoadReady(await fetch());
  } on VibeValleyApiError catch (e) {
    return LoadFailed(e.reason);
  } on Object catch (e) {
    return LoadFailed('$e');
  }
}

/// A binary file counts -1: not counted.
(int, int) lineCounts(Changes c) =>
    (c.files.fold(0, (n, f) => n + math.max(0, f.added.round())), c.files.fold(0, (n, f) => n + math.max(0, f.removed.round())));

class HarvestReview extends ConsumerStatefulWidget {
  const HarvestReview({super.key, required this.session, required this.onDone});
  final Session session;
  final VoidCallback onDone;

  @override
  ConsumerState<HarvestReview> createState() => _HarvestReviewState();
}

class _HarvestReviewState extends ConsumerState<HarvestReview> {
  Loaded _loaded = const Loading();

  @override
  void initState() {
    super.initState();
    final api = ref.read(apiProvider);
    loadChanges(() => api.issue.changes(id: widget.session.issueId)).then((l) {
      if (mounted) setState(() => _loaded = l);
    });
  }

  @override
  Widget build(BuildContext context) => switch (_loaded) {
    Loading() => Padding(
      padding: const EdgeInsets.symmetric(vertical: 40),
      child: Text(
        '正在看它改了什么…',
        textAlign: TextAlign.center,
        style: KitText.sm.copyWith(color: Palette.bark600),
      ),
    ),
    LoadFailed(:final reason) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Tinted(
          color: tint(Palette.berry, .12),
          child: Text('看不了改动：$reason', style: KitText.sm.copyWith(color: Palette.berry)),
        ),
        const SizedBox(height: 12),
        PxButton.text('先不收', onPressed: widget.onDone),
      ],
    ),
    LoadReady(:final changes) => _Ready(session: widget.session, changes: changes, onDone: widget.onDone),
  };
}

class _Ready extends ConsumerWidget {
  const _Ready({required this.session, required this.changes, required this.onDone});
  final Session session;
  final Changes changes;
  final VoidCallback onDone;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final now = DateTime.now().millisecondsSinceEpoch.toDouble();
    final (added, removed) = lineCounts(changes);
    final empty = changes.commits.isEmpty && changes.uncommitted.isEmpty;
    final conflicts = changes.conflicts;
    final commands = ref.read(farmCommandsProvider);
    void take() {
      fireBedEffects(ref, commands.harvest(session));
      onDone();
    }

    void resolve() {
      fireBedEffects(ref, commands.resolve(session));
      onDone();
    }

    final xs = KitText.xs.copyWith(color: Palette.bark600);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          spacing: 6,
          runSpacing: 6,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            FarmTag('项目 ${changes.project}', fill: const Color(0xFFA5743F), ink: Palette.cream50),
            if (changes.branch != null) FarmTag('${changes.branch} → ${changes.base}', ink: Palette.bark800),
            Text('${changes.commits.length} 个提交 · ${changes.files.length} 个文件', style: xs),
            if (changes.files.isNotEmpty) PlusMinus(added, removed),
          ],
        ),
        if (conflicts.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Tinted(
              color: tint(Palette.berry, .12),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('合进 ${changes.base} 会冲突，先没法收', style: KitText.sm.copyWith(color: Palette.berry)),
                  const SizedBox(height: 6),
                  Wrap(
                    spacing: 4,
                    runSpacing: 4,
                    children: [for (final f in conflicts) FarmTag(f, fill: Palette.cream50, ink: Palette.berry)],
                  ),
                  const SizedBox(height: 6),
                  Text('让它在自己的分支上把 ${changes.base} 合进来、解决冲突、跑一遍测试再提交；做完再来收。', style: xs),
                ],
              ),
            ),
          )
        else if (empty)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Tinted(
              child: Text('这一单没有改动。收获就是请它收工。', style: KitText.sm.copyWith(color: Palette.bark600)),
            ),
          ),
        if (changes.behind > 0 && conflicts.isEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text('它干活这段时间，${changes.base} 上多了 ${changes.behind.round()} 个提交；收获时会合在一起（多一个合并提交）。', style: xs),
          ),
        if (changes.uncommitted.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Tinted(
              color: tint(Palette.wheat, .2),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('还有 ${changes.uncommitted.length} 个文件没提交，收获时会先帮它提交：', style: KitText.xs.copyWith(color: Palette.bark800)),
                  const SizedBox(height: 4),
                  Wrap(
                    spacing: 4,
                    runSpacing: 4,
                    children: [
                      for (final f in changes.uncommitted)
                        Container(
                          color: Palette.cream50,
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          child: Text('${_status[f.status]?.mark ?? f.status} ${f.path}', style: KitText.mono),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (conflicts.isNotEmpty)
                PxButton.text('让它解决冲突', tone: PxTone.danger, onPressed: resolve)
              else
                PxButton.text(empty ? '请它收工' : '确认收获，合进 ${changes.base}', tone: PxTone.primary, onPressed: take),
              PxButton.text('先不收', onPressed: onDone),
            ],
          ),
        ),
        if (changes.commits.isNotEmpty)
          FarmSection(
            title: '提交',
            child: Column(
              children: [
                for (final c in changes.commits)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 1),
                    child: Row(
                      children: [
                        Text(c.hash, style: KitText.mono.copyWith(color: Palette.bark500)),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(c.subject, maxLines: 1, overflow: TextOverflow.ellipsis, style: KitText.sm),
                        ),
                        Text(ago(c.at, now), style: KitText.xs.copyWith(color: Palette.bark400)),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        if (changes.files.isNotEmpty)
          FarmSection(
            title: '改了的文件',
            child: Column(
              children: [
                for (final f in changes.files)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: FileRow(file: f, conflict: conflicts.contains(f.path)),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}

class PlusMinus extends StatelessWidget {
  const PlusMinus(this.added, this.removed, {super.key});
  final int added;
  final int removed;

  @override
  Widget build(BuildContext context) => Text.rich(
    TextSpan(
      children: [
        TextSpan(
          text: '+$added',
          style: KitText.mono.copyWith(color: Palette.leaf700),
        ),
        TextSpan(
          text: ' −$removed',
          style: KitText.mono.copyWith(color: Palette.berry),
        ),
      ],
    ),
  );
}

const _status = {
  'A': (mark: '新', label: '新增', fill: Color(0xFFD0DCA9), ink: Palette.leaf700),
  'M': (mark: '改', label: '修改', fill: Color(0xFFF0DBA9), ink: Palette.bark800),
  'D': (mark: '删', label: '删除', fill: Color(0xFFEDCBA9), ink: Palette.berry),
};

class FileRow extends StatefulWidget {
  const FileRow({super.key, required this.file, required this.conflict});
  final ChangedFile file;
  final bool conflict;

  @override
  State<FileRow> createState() => _FileRowState();
}

class _FileRowState extends State<FileRow> {
  var _open = false;

  @override
  Widget build(BuildContext context) {
    final f = widget.file;
    final st = _status[f.status] ?? (mark: f.status, label: f.status, fill: Palette.cream200, ink: Palette.bark800);
    final patch = f.patch;
    return Container(
      color: Palette.cream100,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          KitTappable(
            onTap: patch == null || patch.isEmpty ? null : () => setState(() => _open = !_open),
            semanticLabel: f.path,
            builder: (context, s) => Container(
              color: s.hovered ? Palette.cream200 : null,
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              child: Row(
                children: [
                  Tooltip(
                    message: st.label,
                    child: Container(
                      width: 20,
                      height: 20,
                      color: st.fill,
                      alignment: Alignment.center,
                      child: Text(st.mark, style: KitText.xs.copyWith(color: st.ink)),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Tooltip(
                      message: f.path,
                      child: Text(
                        f.path,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: KitText.mono.copyWith(color: widget.conflict ? Palette.berry : Palette.bark800),
                      ),
                    ),
                  ),
                  if (widget.conflict) ...[const SizedBox(width: 8), FarmTag('冲突', fill: tint(Palette.berry, .15), ink: Palette.berry)],
                  const SizedBox(width: 8),
                  if (f.added < 0) Text('二进制', style: KitText.mono.copyWith(color: Palette.bark500)) else PlusMinus(f.added.round(), f.removed.round()),
                ],
              ),
            ),
          ),
          if (_open && patch != null) Patch(text: patch),
        ],
      ),
    );
  }
}

class Patch extends StatelessWidget {
  const Patch({super.key, required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    final lines = text.split('\n');
    final from = lines.indexWhere((l) => l.startsWith('@@'));
    final shown = lines.sublist(math.max(0, from));
    return Container(
      margin: const EdgeInsets.fromLTRB(8, 0, 8, 8),
      color: Palette.cream50,
      constraints: const BoxConstraints(maxHeight: 320),
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: SingleChildScrollView(
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final line in shown)
                Container(
                  color: line.startsWith('+')
                      ? Palette.leaf300.withValues(alpha: .35)
                      : line.startsWith('-')
                      ? Palette.berry.withValues(alpha: .1)
                      : null,
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  child: Text(
                    line.isEmpty ? ' ' : line,
                    softWrap: false,
                    style: KitText.mono.copyWith(
                      height: 1.4,
                      color: line.startsWith('+')
                          ? Palette.leaf700
                          : line.startsWith('-')
                          ? Palette.berry
                          : line.startsWith('@@')
                          ? Palette.water
                          : Palette.bark800,
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

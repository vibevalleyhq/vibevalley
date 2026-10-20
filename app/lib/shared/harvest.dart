import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../game/commands.dart';
import '../gen/vibevalley.dart';
import '../ui/pixel/pixel.dart';
import '../data/remote.dart' show SessionIssue, issueChangesProvider, reasonOf;
import 'harvest_rules.dart';
import 'tags.dart';

export 'harvest_rules.dart' show lineCounts;

class HarvestReview extends ConsumerWidget {
  const HarvestReview({super.key, required this.session, required this.onDone});
  final Session session;
  final VoidCallback onDone;

  @override
  Widget build(BuildContext context, WidgetRef ref) => ref
      .watch(issueChangesProvider(session.issueId))
      .when(
        loading: () => Padding(
          padding: const EdgeInsets.symmetric(vertical: 40),
          child: Text(
            '正在看它改了什么…',
            textAlign: TextAlign.center,
            style: PxText.sm.copyWith(color: Palette.bark600),
          ),
        ),
        error: (error, _) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Tinted(
              color: tint(Palette.berry, .12),
              child: Text('看不了改动：${reasonOf(error)}', style: PxText.sm.copyWith(color: Palette.berry)),
            ),
            const SizedBox(height: 12),
            PxButton.text('先不收', onPressed: onDone),
          ],
        ),
        data: (changes) => _Ready(session: session, changes: changes, onDone: onDone),
      );
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
    final empty = nothingChanged(changes);
    final conflicts = changes.conflicts;
    final commands = ref.read(farmCommandsProvider);
    void take() {
      fire(commands.harvest(session));
      onDone();
    }

    void resolve() {
      fire(commands.resolve(session));
      onDone();
    }

    final xs = PxText.xs.copyWith(color: Palette.bark600);
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
                  Text('合进 ${changes.base} 会冲突，先没法收', style: PxText.sm.copyWith(color: Palette.berry)),
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
              child: Text('这一单没有改动。收获就是请它收工。', style: PxText.sm.copyWith(color: Palette.bark600)),
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
                  Text('还有 ${changes.uncommitted.length} 个文件没提交，收获时会先帮它提交：', style: PxText.xs.copyWith(color: Palette.bark800)),
                  const SizedBox(height: 4),
                  Wrap(
                    spacing: 4,
                    runSpacing: 4,
                    children: [
                      for (final f in changes.uncommitted)
                        Container(
                          color: Palette.cream50,
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          child: Text('${changeKind(f.status).mark} ${f.path}', style: PxText.mono),
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
                        Text(c.hash, style: PxText.mono.copyWith(color: Palette.bark500)),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(c.subject, maxLines: 1, overflow: TextOverflow.ellipsis, style: PxText.sm),
                        ),
                        Text(ago(c.at, now), style: PxText.xs.copyWith(color: Palette.bark400)),
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
          style: PxText.mono.copyWith(color: Palette.leaf700),
        ),
        TextSpan(
          text: ' −$removed',
          style: PxText.mono.copyWith(color: Palette.berry),
        ),
      ],
    ),
  );
}

const _look = {
  'A': (fill: Color(0xFFD0DCA9), ink: Palette.leaf700),
  'M': (fill: Color(0xFFF0DBA9), ink: Palette.bark800),
  'D': (fill: Color(0xFFEDCBA9), ink: Palette.berry),
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
    final kind = changeKind(f.status);
    final look = _look[f.status] ?? (fill: Palette.cream200, ink: Palette.bark800);
    final patch = f.patch;
    return Container(
      color: Palette.cream100,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Tappable(
            onTap: patch == null || patch.isEmpty ? null : () => setState(() => _open = !_open),
            semanticLabel: f.path,
            builder: (context, s) => Container(
              color: s.hovered ? Palette.cream200 : null,
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              child: Row(
                children: [
                  Tooltip(
                    message: kind.label,
                    child: Container(
                      width: 20,
                      height: 20,
                      color: look.fill,
                      alignment: Alignment.center,
                      child: Text(kind.mark, style: PxText.xs.copyWith(color: look.ink)),
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
                        style: PxText.mono.copyWith(color: widget.conflict ? Palette.berry : Palette.bark800),
                      ),
                    ),
                  ),
                  if (widget.conflict) ...[const SizedBox(width: 8), FarmTag('冲突', fill: tint(Palette.berry, .15), ink: Palette.berry)],
                  const SizedBox(width: 8),
                  if (f.added < 0) Text('二进制', style: PxText.mono.copyWith(color: Palette.bark500)) else PlusMinus(f.added.round(), f.removed.round()),
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
    final shown = patchLines(text);
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
                  color: switch (patchMarkOf(line)) {
                    PatchMark.added => Palette.leaf300.withValues(alpha: .35),
                    PatchMark.removed => Palette.berry.withValues(alpha: .1),
                    PatchMark.hunk || PatchMark.plain => null,
                  },
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  child: Text(
                    line.isEmpty ? ' ' : line,
                    softWrap: false,
                    style: PxText.mono.copyWith(
                      height: 1.4,
                      color: switch (patchMarkOf(line)) {
                        PatchMark.added => Palette.leaf700,
                        PatchMark.removed => Palette.berry,
                        PatchMark.hunk => Palette.water,
                        PatchMark.plain => Palette.bark800,
                      },
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

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/remote.dart' show SessionIssue, issueChangesProvider, reasonOf;
import '../../game/commands.dart';
import '../../gen/vibevalley.dart';
import '../../shared/harvest_rules.dart';
import '../../ui/pro/pro.dart';
import '../shared/layout.dart' show TintTag;
import '../shared/widgets.dart';

/// The workbench's harvest checklist: what the branch brings before it is merged. The farm draws its own (shared/harvest.dart).
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
            style: ProText.sm.copyWith(color: ProColor.muted),
          ),
        ),
        error: (error, _) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _Note(
              color: Palette.berry,
              child: Text('看不了改动：${reasonOf(error)}', style: ProText.sm.copyWith(color: Palette.berry)),
            ),
            const SizedBox(height: 16),
            ProButton.text('先不收', onPressed: onDone),
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

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 6,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            TintTag('项目 ${changes.project}', fill: ProColor.selected, ink: ProColor.ink),
            if (changes.branch != null) Text('${changes.branch} → ${changes.base}', style: ProText.mono),
            Text('${changes.commits.length} 个提交 · ${changes.files.length} 个文件', style: ProText.meta),
            if (changes.files.isNotEmpty) PlusMinus(added, removed),
          ],
        ),
        if (conflicts.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: _Note(
              color: Palette.berry,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '合进 ${changes.base} 会冲突，先没法收',
                    style: ProText.sm.copyWith(color: Palette.berry, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 6),
                  Wrap(
                    spacing: 4,
                    runSpacing: 4,
                    children: [for (final f in conflicts) TintTag(f, fill: ProColor.page, ink: Palette.berry)],
                  ),
                  const SizedBox(height: 6),
                  Text('让它在自己的分支上把 ${changes.base} 合进来、解决冲突、跑一遍测试再提交；做完再来收。', style: ProText.meta),
                ],
              ),
            ),
          )
        else if (empty)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: _Note(
              child: Text('这一单没有改动。收获就是请它收工。', style: ProText.sm.copyWith(color: ProColor.muted)),
            ),
          ),
        if (changes.behind > 0 && conflicts.isEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text('它干活这段时间，${changes.base} 上多了 ${changes.behind.round()} 个提交；收获时会合在一起（多一个合并提交）。', style: ProText.meta),
          ),
        if (changes.uncommitted.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: _Note(
              color: Palette.wheat,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('还有 ${changes.uncommitted.length} 个文件没提交，收获时会先帮它提交：', style: ProText.sm),
                  const SizedBox(height: 6),
                  Wrap(
                    spacing: 4,
                    runSpacing: 4,
                    children: [
                      for (final f in changes.uncommitted)
                        Container(
                          decoration: const BoxDecoration(color: ProColor.page, borderRadius: BorderRadius.all(Radius.circular(4))),
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                          child: Text('${changeKind(f.status).mark} ${f.path}', style: ProText.mono),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.only(top: 16),
          child: Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (conflicts.isNotEmpty)
                ProButton.text('让它解决冲突', tone: ProTone.danger, onPressed: resolve)
              else
                ProButton.text(empty ? '请它收工' : '确认收获，合进 ${changes.base}', tone: ProTone.primary, onPressed: take),
              ProButton.text('先不收', onPressed: onDone),
            ],
          ),
        ),
        if (changes.commits.isNotEmpty) ...[
          const SizedBox(height: 20),
          WorkbenchSection(
            title: '提交',
            count: changes.commits.length,
            child: Column(
              children: [
                for (final c in changes.commits)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 2),
                    child: Row(
                      children: [
                        Text(c.hash, style: ProText.mono.copyWith(color: ProColor.muted)),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(c.subject, maxLines: 1, overflow: TextOverflow.ellipsis, style: ProText.sm),
                        ),
                        const SizedBox(width: 8),
                        Text(ago(c.at, now), style: ProText.meta.copyWith(color: ProColor.faint)),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
        if (changes.files.isNotEmpty) ...[
          const SizedBox(height: 20),
          WorkbenchSection(
            title: '改了的文件',
            count: changes.files.length,
            child: Container(
              decoration: const BoxDecoration(border: Border.fromBorderSide(proLine), borderRadius: proRadius),
              clipBehavior: Clip.antiAlias,
              child: Column(
                children: [
                  for (final (i, f) in changes.files.indexed) ...[
                    if (i > 0) const Divider(height: 1, thickness: 1, color: ProColor.line),
                    FileRow(file: f, conflict: conflicts.contains(f.path)),
                  ],
                ],
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// A tinted note in the checklist: a conflict, nothing to merge, files not committed.
class _Note extends StatelessWidget {
  const _Note({required this.child, this.color});
  final Widget child;
  final Color? color;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    decoration: BoxDecoration(color: color?.withValues(alpha: .1) ?? ProColor.hover, borderRadius: const BorderRadius.all(Radius.circular(8))),
    child: child,
  );
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
          style: ProText.mono.copyWith(color: Palette.leaf700),
        ),
        TextSpan(
          text: ' −$removed',
          style: ProText.mono.copyWith(color: Palette.berry),
        ),
      ],
    ),
  );
}

const _look = {
  'A': (fill: Color(0x3374A046), ink: Palette.leaf700),
  'M': (fill: Color(0x33E5A93C), ink: Palette.bark800),
  'D': (fill: Color(0x26C84A3A), ink: Palette.berry),
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
    final look = _look[f.status] ?? (fill: ProColor.selected, ink: ProColor.ink);
    final patch = f.patch;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Tappable(
          onTap: patch == null || patch.isEmpty ? null : () => setState(() => _open = !_open),
          semanticLabel: f.path,
          builder: (context, s) => Container(
            color: s.hovered || _open ? ProColor.hover : null,
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            child: Row(
              children: [
                Tooltip(
                  message: kind.label,
                  child: Container(
                    width: 20,
                    height: 20,
                    decoration: BoxDecoration(color: look.fill, borderRadius: const BorderRadius.all(Radius.circular(4))),
                    alignment: Alignment.center,
                    child: Text(
                      kind.mark,
                      style: ProText.xs.copyWith(color: look.ink, fontWeight: FontWeight.w600),
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Tooltip(
                    message: f.path,
                    child: Text(
                      f.path,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ProText.mono.copyWith(color: widget.conflict ? Palette.berry : ProColor.ink),
                    ),
                  ),
                ),
                if (widget.conflict) ...[const SizedBox(width: 8), TintTag('冲突', fill: Palette.berry.withValues(alpha: .15), ink: Palette.berry)],
                const SizedBox(width: 8),
                if (f.added < 0) Text('二进制', style: ProText.mono.copyWith(color: ProColor.muted)) else PlusMinus(f.added.round(), f.removed.round()),
              ],
            ),
          ),
        ),
        if (_open && patch != null) Patch(text: patch),
      ],
    );
  }
}

class Patch extends StatelessWidget {
  const Patch({super.key, required this.text});
  final String text;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.fromLTRB(8, 0, 8, 8),
    decoration: const BoxDecoration(color: ProColor.page, border: Border.fromBorderSide(proLine), borderRadius: proRadius),
    constraints: const BoxConstraints(maxHeight: 320),
    padding: const EdgeInsets.symmetric(vertical: 4),
    child: SingleChildScrollView(
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final line in patchLines(text))
              Container(
                color: switch (patchMarkOf(line)) {
                  PatchMark.added => Palette.leaf300.withValues(alpha: .3),
                  PatchMark.removed => Palette.berry.withValues(alpha: .1),
                  PatchMark.hunk || PatchMark.plain => null,
                },
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: Text(
                  line.isEmpty ? ' ' : line,
                  softWrap: false,
                  style: ProText.mono.copyWith(
                    height: 1.4,
                    color: switch (patchMarkOf(line)) {
                      PatchMark.added => Palette.leaf700,
                      PatchMark.removed => Palette.berry,
                      PatchMark.hunk => Palette.water,
                      PatchMark.plain => ProColor.ink,
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

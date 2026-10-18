import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../ui/theme.dart';
import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../ui/kit/base.dart';
import '../../ui/kit/button.dart';
import '../../ui/kit/choice.dart';
import '../../ui/kit/field.dart';
import '../../ui/kit/labels.dart';
import '../../data/remote.dart';
import './widgets.dart';
import '../../rules/task.dart';

/// Notes its helpers could still add before the oldest are dropped: those are marked 快忘了.
const _everywhere = '*';

double _now() => DateTime.now().millisecondsSinceEpoch.toDouble();

TextStyle get _lead => KitText.xs.copyWith(height: 1.625, color: Palette.bark600);
TextStyle get _meta => KitText.xs.copyWith(color: Palette.bark500);

List<Widget> _gap(List<Widget> children, [double gap = 16]) => [
  for (var i = 0; i < children.length; i++) ...[if (i > 0) SizedBox(height: gap), children[i]],
];

class MemoryPanel extends ConsumerStatefulWidget {
  const MemoryPanel({super.key, required this.agent});
  final String agent;

  @override
  ConsumerState<MemoryPanel> createState() => _MemoryPanelState();
}

class _MemoryPanelState extends ConsumerState<MemoryPanel> {
  String _shown = '';

  @override
  Widget build(BuildContext context) {
    final view = ref.watch(memoryProvider(widget.agent)).value;
    final list = view?.memories;
    final sources = {for (final src in view?.sources ?? const <MemorySourceInfo>[]) src.name: src};
    final sessions = {for (final h in ref.watch(stateProvider)?.sessions ?? const <Session>[]) h.id: h.name};
    final now = _now();
    final all = list ?? const <Memory>[];
    final notes = all.where((m) => m.kind == MemoryKind.note).toList();
    final jobs = all.where((m) => m.kind == MemoryKind.issue).toList();
    final projectsInMemory = {for (final m in all) ?m.project}.toList()..sort();
    final filtered = notes.where((m) => _shown == '' || (_shown == _everywhere ? m.project == null : m.project == _shown)).toList();
    String whose(Memory m) => switch (m.author) {
      MemoryAuthor.owner => '你记的',
      MemoryAuthor.manager => '管家替它记的',
      MemoryAuthor.agent || MemoryAuthor.farm || null => m.session != null ? '${sessions[m.session] ?? m.session} 记的' : '它自己记的',
    };
    MemorySourceInfo? from(Memory m) => m.source == null ? null : sources[m.source];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: _gap([
        Text('这个 agent 派出去的帮工共用一份记性。每一轮开始，和这一轮有关的几条放在它收到的话前面；一轮结束，它在汇报里写的「记住：」那几行，和这件活做到哪了，记进来。', style: _lead),
        if (sources.length > 1) _SourcesSection(sources: sources.values.toList()),
        WorkbenchSection(
          title: '手上的活',
          count: jobs.length,
          child: jobs.isEmpty
              ? const EmptyNote('它的帮工还没做完过一轮。')
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final m in jobs)
                      Container(
                        margin: const EdgeInsets.only(bottom: 6),
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        decoration: const BoxDecoration(
                          color: Palette.cream100,
                          border: Border(left: BorderSide(color: Palette.leaf500, width: 4)),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Wrap(
                              spacing: 8,
                              children: [
                                Text(m.session != null ? (sessions[m.session] ?? m.session!) : '帮工', style: _meta.copyWith(color: Palette.bark800)),
                                Text(m.project ?? '所有项目', style: _meta),
                                Text(ago(m.at, now), style: _meta),
                              ],
                            ),
                            const SizedBox(height: 2),
                            Text(m.text, style: KitText.sm.copyWith(color: Palette.bark900)),
                          ],
                        ),
                      ),
                  ],
                ),
        ),
        _RecallPreview(agent: widget.agent),
        WriteNote(onWrite: (text, project) => ref.read(memoryProvider(widget.agent).notifier).write(text, project), withProject: true),
        WorkbenchSection(
          title: '记下的',
          count: notes.length,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (projectsInMemory.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Wrap(
                    spacing: 4,
                    runSpacing: 4,
                    children: [
                      for (final (value, label) in [('', '全部'), (_everywhere, '所有项目'), for (final p in projectsInMemory) (p, p)])
                        WorkbenchPill(label: label, on: _shown == value, small: true, onTap: () => setState(() => _shown = value)),
                    ],
                  ),
                ),
              if (filtered.isEmpty)
                EmptyNote(notes.isNotEmpty ? '这一栏没有。' : '还没记下什么。帮工在汇报里写「记住：」，或者你在上面替它记。')
              else
                for (final m in filtered)
                  if (from(m) case final src?)
                    MemoryItem(
                      memory: m,
                      onForget: src.canForget ? () => runAction(() => ref.read(memoryProvider(widget.agent).notifier).forget(m.id)) : null,
                      meta: ['在 ${src.label} 里', if (!src.canForget) '要删到 ${src.label} 里删'],
                    )
                  else
                    MemoryItem(
                      memory: m,
                      faded: m.fading == true,
                      onForget: () => runAction(() => ref.read(memoryProvider(widget.agent).notifier).forget(m.id)),
                      meta: [
                        m.project ?? '所有项目',
                        whose(m),
                        ago(m.at, now),
                        m.recalled > 0 ? '想起过 ${m.recalled.round()} 次${m.recalledAt != null ? '，上次 ${ago(m.recalledAt!, now)}' : ''}' : '还没想起过',
                      ],
                      warning: m.fading == true ? '快忘了：记满 $memoryKeep 条时最先丢' : null,
                    ),
            ],
          ),
        ),
      ]),
    );
  }
}

/// Where its memories live besides the farm's own, and what each lets the tab do (the server's Can()).
class _SourcesSection extends StatelessWidget {
  const _SourcesSection({required this.sources});
  final List<MemorySourceInfo> sources;

  @override
  Widget build(BuildContext context) => WorkbenchSection(
    title: '记性从哪来',
    count: sources.where((src) => src.on).length,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final src in sources)
          Container(
            margin: const EdgeInsets.only(bottom: 6),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            color: Palette.cream100,
            child: Wrap(
              spacing: 8,
              runSpacing: 2,
              children: [
                Text(src.label, style: KitText.sm.copyWith(color: Palette.bark900)),
                Text(src.on ? '在用' : '没接上：${src.off ?? ''}', style: _meta.copyWith(color: src.on ? Palette.leaf700 : Palette.berry)),
                if (src.on) ...[
                  Text(src.canList ? '记下的列在下面' : '不在这里列出', style: _meta),
                  Text(src.canForget ? '能在这里忘掉' : '要删到它那里删', style: _meta),
                  if (src.transcripts) Text('收整段干活的对话', style: _meta),
                ],
              ],
            ),
          ),
        Text('在开头的「设置」里接上、关掉，或改读写。', style: _meta),
      ],
    ),
  );
}

/// The pick the server would make, without counting it (agent.recall).
class _RecallPreview extends ConsumerStatefulWidget {
  const _RecallPreview({required this.agent});
  final String agent;

  @override
  ConsumerState<_RecallPreview> createState() => _RecallPreviewState();
}

class _RecallPreviewState extends ConsumerState<_RecallPreview> {
  String _project = '';
  String _text = '';

  @override
  Widget build(BuildContext context) {
    final projectNames = ref.watch(projectNamesProvider).value ?? const <String>[];
    final where = _project.isNotEmpty ? _project : (projectNames.firstOrNull ?? '');
    final preview = where.isEmpty ? null : ref.watch(recallPreviewProvider((agent: widget.agent, project: where, text: _text))).value;
    final lines = preview?.lines ?? const <String>[];
    return WorkbenchSection(
      title: '下回开工会想起',
      aside: lines.isEmpty ? null : Text('${lines.length} 条 · ${preview!.chars} / ${preview.limit} 字'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              SizedBox(
                width: 160,
                child: PxPick(
                  value: where,
                  onChanged: (p) => setState(() => _project = p),
                  placeholder: '选项目',
                  options: [for (final p in projectNames) PickOption(value: p, label: p)],
                  semanticLabel: '在哪个项目开工',
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: PxTextInput(value: _text, onChanged: (t) => setState(() => _text = t), placeholder: '这一轮的话（可以不填）', semanticLabel: '这一轮的话'),
              ),
            ],
          ),
          const SizedBox(height: 8),
          if (lines.isEmpty)
            EmptyNote(where.isNotEmpty ? '在这个项目里开工，什么也想不起来。' : '还没有项目。')
          else
            Container(
              color: Palette.cream100,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Text(lines.join('\n'), style: KitText.xs.copyWith(height: 1.625, color: Palette.bark800)),
            ),
        ],
      ),
    );
  }
}

class ManagerMemoryPanel extends ConsumerWidget {
  const ManagerMemoryPanel({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final view = ref.watch(memoryProvider(managerAgent)).value;
    if (view == null) return const EmptyNote('在读管家的记性……');
    final now = _now();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: _gap([
        Text('管家开工时和每次压缩后读一遍记性；中间记下、忘掉的，它下一句就知道。', style: _lead),
        WriteNote(onWrite: (text, _) => ref.read(memoryProvider(managerAgent).notifier).write(text)),
        WorkbenchSection(
          title: '记下的',
          count: view.memories.length,
          child: view.memories.isEmpty
              ? const EmptyNote('还没记下什么。跟管家说「记住……」，或者你在上面替它记。')
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final (i, m) in view.memories.indexed)
                      MemoryItem(
                        memory: m,
                        faded: i >= (view.carried ?? view.memories.length),
                        onForget: () => runAction(() => ref.read(memoryProvider(managerAgent).notifier).forget(m.id)),
                        meta: [m.session == managerAgent ? '管家自己记的' : '你交代的', ago(m.at, now)],
                        warning: i >= (view.carried ?? view.memories.length) ? '太旧了，带不进系统提示' : null,
                      ),
                  ],
                ),
        ),
      ]),
    );
  }
}

class ArchivePanel extends ConsumerStatefulWidget {
  const ArchivePanel({super.key});

  @override
  ConsumerState<ArchivePanel> createState() => _ArchivePanelState();
}

class _ArchivePanelState extends ConsumerState<ArchivePanel> {
  String _query = '';
  ArchiveListing? _listing;
  ({String name, String text})? _open;

  @override
  void initState() {
    super.initState();
    _search(null);
  }

  Future<void> _search(String? q) async {
    final listing = await runAction(() => ref.read(apiProvider).manager.listArchive(q: q));
    if (mounted && listing != null) setState(() => _listing = listing);
  }

  Future<void> _show(String name) async {
    if (_open?.name == name) return setState(() => _open = null);
    String text;
    try {
      text = await ref.read(apiProvider).manager.getArchive(name: name);
    } on Object catch (e) {
      text = reasonOf(e);
    }
    if (mounted) setState(() => _open = (name: name, text: text));
  }

  @override
  Widget build(BuildContext context) {
    final listing = _listing;
    final now = _now();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: _gap([
        Text('对话太长时，管家把前面的部分压成一段摘要，原文一字不改地存在这里。摘要里缺了细节，它自己会用 search_archive 来翻；你也可以在这里翻。', style: _lead),
        Row(
          children: [
            Expanded(
              child: PxTextInput(
                value: _query,
                onChanged: (q) => setState(() => _query = q),
                placeholder: '搜一个词',
                icon: 'button-search',
                semanticLabel: '在旧账里搜',
                onSubmitted: (q) => _search(_query),
              ),
            ),
            const SizedBox(width: 8),
            PxButton.text('搜', icon: 'button-search', onPressed: _query.trim().isEmpty ? null : () => _search(_query)),
          ],
        ),
        if (listing != null && listing.hits.isNotEmpty)
          WorkbenchSection(
            title: '搜到的',
            count: listing.hits.length,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final h in listing.hits)
                  Container(
                    margin: const EdgeInsets.only(bottom: 6),
                    color: Palette.cream100,
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('${h.file}:${h.line.round()}', style: KitText.mono.copyWith(color: Palette.bark500)),
                        const SizedBox(height: 2),
                        Text(h.text, style: KitText.xs.copyWith(height: 1.625, color: Palette.bark800)),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        WorkbenchSection(
          title: '压掉的对话',
          count: listing?.files.length ?? 0,
          child: listing == null
              ? const EmptyNote('在读……')
              : listing.files.isEmpty
              ? const EmptyNote('还没有：管家的对话还没长到要压缩。')
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final f in listing.files)
                      Container(
                        margin: const EdgeInsets.only(bottom: 6),
                        color: Palette.cream100,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            KitTappable(
                              onTap: () => _show(f.name),
                              semanticLabel: f.name,
                              builder: (context, s) => Padding(
                                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                                child: Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        f.name,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: KitText.mono.copyWith(color: Palette.bark800),
                                      ),
                                    ),
                                    const SizedBox(width: 8),
                                    Text('${ago(f.at, now)} · ${f.chars.round()} 字', style: _meta),
                                  ],
                                ),
                              ),
                            ),
                            if (_open?.name == f.name)
                              Container(
                                constraints: const BoxConstraints(maxHeight: 384),
                                decoration: const BoxDecoration(
                                  border: Border(top: BorderSide(color: Palette.cream300)),
                                ),
                                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                                child: SingleChildScrollView(
                                  child: SelectableText(_open!.text, style: KitText.xs.copyWith(height: 1.625, color: Palette.bark800)),
                                ),
                              ),
                          ],
                        ),
                      ),
                  ],
                ),
        ),
      ]),
    );
  }
}

class WriteNote extends ConsumerStatefulWidget {
  const WriteNote({super.key, required this.onWrite, this.withProject = false});
  final Future<Answer> Function(String text, String? project) onWrite;
  final bool withProject;

  @override
  ConsumerState<WriteNote> createState() => _WriteNoteState();
}

class _WriteNoteState extends ConsumerState<WriteNote> {
  String _text = '';
  String _project = '';
  String _error = '';

  Future<void> _write() async {
    final answer = await widget.onWrite(_text, _project.trim().isEmpty ? null : _project.trim());
    if (!mounted) return;
    setState(() {
      _error = answer.ok ? '' : answer.text;
      if (answer.ok) _text = '';
    });
  }

  @override
  Widget build(BuildContext context) {
    final projectNames = widget.withProject ? (ref.watch(projectNamesProvider).value ?? const <String>[]) : const <String>[];
    final button = PxButton.text('记下', tone: PxTone.primary, onPressed: _text.trim().isEmpty ? null : _write);
    return PxField(
      label: '替它记一条',
      error: _error.isEmpty ? null : _error,
      hint: Text(widget.withProject ? '写成下次一看就懂的一句话。项目留空就是所有项目都用得上。' : '写成下次一看就懂的一句话。'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          PxTextArea(
            value: _text,
            onChanged: (t) => setState(() => _text = t),
            rows: 2,
            placeholder: widget.withProject ? '比如：clock-in 的测试用 pnpm test，别用 npm' : '比如：提交信息写中文；周末别派夜班',
            semanticLabel: '替它记一条',
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              if (widget.withProject) ...[
                Expanded(
                  child: PxTextInput(
                    value: _project,
                    onChanged: (p) => setState(() => _project = p),
                    placeholder: '项目（可以不填）',
                    mono: true,
                    semanticLabel: '项目',
                    suggestions: projectNames,
                  ),
                ),
                const SizedBox(width: 8),
              ] else
                const Spacer(),
              button,
            ],
          ),
        ],
      ),
    );
  }
}

class MemoryItem extends StatefulWidget {
  const MemoryItem({super.key, required this.memory, required this.onForget, required this.meta, this.faded = false, this.warning});
  final Memory memory;
  // null: the place it lives does not let it be forgotten from here.
  final VoidCallback? onForget;
  final List<String> meta;
  final bool faded;

  final String? warning;

  @override
  State<MemoryItem> createState() => _MemoryItemState();
}

class _MemoryItemState extends State<MemoryItem> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) => MouseRegion(
    onEnter: (_) => setState(() => _hover = true),
    onExit: (_) => setState(() => _hover = false),
    child: Opacity(
      opacity: widget.faded ? .6 : 1,
      child: Container(
        margin: const EdgeInsets.only(bottom: 6),
        color: Palette.cream100,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(widget.memory.text, style: KitText.sm.copyWith(color: Palette.bark900)),
                  const SizedBox(height: 2),
                  Wrap(
                    spacing: 8,
                    children: [
                      for (final m in widget.meta) Text(m, style: _meta),
                      if (widget.warning != null) Text(widget.warning!, style: _meta.copyWith(color: const Color(0xFFB8682A))),
                    ],
                  ),
                ],
              ),
            ),
            if (widget.onForget != null) ...[
              const SizedBox(width: 8),
              KitTappable(
                onTap: widget.onForget,
                semanticLabel: '忘掉',
                builder: (context, s) => Opacity(
                  opacity: _hover || s.focused ? 1 : 0,
                  child: Container(
                    color: s.hovered ? Palette.cream200 : null,
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    child: Text('忘掉', style: _meta.copyWith(color: s.hovered ? Palette.berry : Palette.bark500)),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    ),
  );
}

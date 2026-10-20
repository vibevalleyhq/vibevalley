import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../data/remote.dart';
import '../../gen/vibevalley.dart';
import '../../ui/pro/pro.dart';
import '../shared/widgets.dart';
import 'doc_editor.dart';
import 'doc_editor_model.dart';

String _docPath([String? id]) => id == null ? '/docs' : '/docs/${Uri.encodeComponent(id)}';

/// 文档: the documents on the left, the one open on the right, written block by block.
class DocsPage extends ConsumerStatefulWidget {
  const DocsPage({super.key, this.id});
  final String? id;

  @override
  ConsumerState<DocsPage> createState() => _DocsPageState();
}

class _DocsPageState extends ConsumerState<DocsPage> {
  List<Document>? _docs;
  String? _problem;
  String _title = '';

  @override
  void initState() {
    super.initState();
    Future.microtask(() => ref.read(workbenchConfigProvider.notifier).refresh());
    _list();
  }

  Future<void> _list() async {
    try {
      final docs = await ref.read(apiProvider).doc.list();
      if (mounted) {
        setState(() {
          _docs = docs;
          _problem = null;
        });
      }
    } on Object catch (e) {
      if (mounted) setState(() => _problem = '$e');
    }
  }

  Future<void> _create() async {
    try {
      final made = await ref.read(apiProvider).doc.create(body: DocRequest(title: _title));
      setState(() => _title = '');
      await _list();
      if (mounted) workbenchGo(context, _docPath(made.doc.id));
    } on Object catch (e) {
      if (mounted) setState(() => _problem = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final docs = _docs ?? const <Document>[];
    final id = widget.id ?? docs.firstOrNull?.id;
    Widget nav() => ProPanel(
      padding: const EdgeInsets.all(8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(8, 6, 8, 8),
            child: Text('文档', style: ProText.lg),
          ),
          Row(
            children: [
              Expanded(
                child: ProTextInput(value: _title, onChanged: (v) => setState(() => _title = v), placeholder: '新文档的标题', semanticLabel: '新文档的标题'),
              ),
              const SizedBox(width: 6),
              ProButton.text('新文档', icon: 'button-add', tone: ProTone.primary, size: ProSize.sm, onPressed: _create),
            ],
          ),
          const SizedBox(height: 8),
          if (_problem != null)
            Padding(
              padding: const EdgeInsets.all(8),
              child: Text(_problem!, style: ProText.xs.copyWith(color: Palette.berry)),
            ),
          if (_docs != null && docs.isEmpty)
            Padding(
              padding: const EdgeInsets.all(8),
              child: Text('还没有文档。写个标题，点「新文档」。', style: ProText.meta),
            ),
          for (final d in docs)
            Tappable(
              onTap: () => workbenchGo(context, _docPath(d.id)),
              selected: d.id == id,
              semanticLabel: d.title,
              builder: (context, s) => Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                decoration: BoxDecoration(color: d.id == id ? ProColor.selected : (s.hovered ? ProColor.hover : null), borderRadius: proRadius),
                child: Text(
                  d.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ProText.sm.copyWith(fontWeight: FontWeight.w500),
                ),
              ),
            ),
        ],
      ),
    );
    final editor = id == null ? null : DocView(key: ValueKey(id), id: id);
    return LayoutBuilder(
      builder: (context, box) {
        if (box.maxWidth >= 900) {
          return Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(width: 260, child: SingleChildScrollView(child: nav())),
                const SizedBox(width: 12),
                Expanded(child: editor ?? const SizedBox()),
              ],
            ),
          );
        }
        // Narrow: the list, or the open document with a way back to it.
        return Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
          child: widget.id == null
              ? SingleChildScrollView(child: nav())
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    ProButton.text('全部文档', icon: 'button-back', size: ProSize.sm, onPressed: () => workbenchGo(context, _docPath())),
                    const SizedBox(height: 8),
                    Expanded(child: editor!),
                  ],
                ),
        );
      },
    );
  }
}

/// One document, open for editing.
class DocView extends ConsumerStatefulWidget {
  const DocView({super.key, required this.id});
  final String id;

  @override
  ConsumerState<DocView> createState() => _DocViewState();
}

class _DocViewState extends ConsumerState<DocView> {
  late final DocEditor _editor = DocEditor(ref.read(apiProvider), widget.id);

  @override
  void initState() {
    super.initState();
    _editor.load();
  }

  @override
  void dispose() {
    _editor.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _editor,
    builder: (context, _) {
      final doc = _editor.doc;
      return ProPanel(
        padding: const EdgeInsets.fromLTRB(8, 16, 20, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.only(left: 35, bottom: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(child: Text(doc?.title ?? '', style: ProText.x2l)),
                  const SizedBox(width: 8),
                  ProButton.text('演示：几个帮工一起写', icon: 'button-play', size: ProSize.sm, onPressed: _editor.demo),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(left: 35, bottom: 12),
              child: Text(
                _editor.error ?? (_editor.busy ? '在存……' : ['都存好了', '${_editor.blocks.length} 块', if (_editor.othersWriting) '帮工在写'].join(' · ')),
                style: ProText.meta.copyWith(color: _editor.error != null ? Palette.berry : null),
              ),
            ),
            Expanded(
              child: SingleChildScrollView(child: DocBlocks(editor: _editor)),
            ),
          ],
        ),
      );
    },
  );
}

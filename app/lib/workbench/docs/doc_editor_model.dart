import 'dart:async';
import 'dart:math';

import 'package:flutter/widgets.dart';

import '../../gen/vibevalley.dart';
import '../../rules/doc_blocks.dart';

/// Text edits wait this long after the last key, and no longer than [maxWait] while typing goes on.
const idleWait = Duration(milliseconds: 500);
const maxWait = Duration(seconds: 2);

/// How often an open document asks for what others (helpers) wrote, while nothing of the owner's is waiting: every
/// [pollFast] while another writer was heard in the last [busyPolls] asks (or the demo was just started), else [pollEvery].
const pollEvery = Duration(seconds: 4);
const pollFast = Duration(seconds: 1);
const busyPolls = 4;

/// A block another writer changed shows as being written for this many asks after the change was heard.
const writingPolls = 3;

final _random = Random.secure();

/// A uuid (v4) for a block this client inserts: block ids are the inserter's to make.
String newBlockId() {
  final b = List<int>.generate(16, (_) => _random.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

/// Draws a block's marks in its field; while a word is being composed, the field's own look (with the composing underline).
class BlockTextController extends TextEditingController {
  BlockTextController(this.block, {super.text});
  final EditBlock block;

  @override
  TextSpan buildTextSpan({required BuildContext context, TextStyle? style, required bool withComposing}) {
    final spans = block.spans;
    if (block.composing || plainOf(spans) != text || spans.every((s) => sameMarks(s.marks, const DocMarks()))) {
      return super.buildTextSpan(context: context, style: style, withComposing: withComposing);
    }
    return TextSpan(
      style: style,
      children: [for (final s in spans) TextSpan(text: s.t, style: markStyle(s.marks))],
    );
  }
}

TextStyle markStyle(DocMarks m) => TextStyle(
  fontWeight: (m.bold ?? false) ? FontWeight.w600 : null,
  fontStyle: (m.italic ?? false) ? FontStyle.italic : null,
  fontFamily: (m.code ?? false) ? 'monospace' : null,
  backgroundColor: (m.code ?? false) ? const Color(0x142F1F13) : null,
  decoration: TextDecoration.combine([if (m.strike ?? false) TextDecoration.lineThrough, if (m.link != null) TextDecoration.underline]),
  color: m.link != null ? const Color(0xFF3F6E2A) : null,
);

/// One block as the editor holds it: the server's last word on it (rev, who wrote it) and the owner's text as it is now.
class EditBlock {
  EditBlock(Block b)
    : id = b.id,
      parentId = b.parentId,
      orderKey = b.orderKey,
      type = b.type,
      attrs = b.attrs,
      spans = b.text,
      sent = b.text,
      rev = b.rev,
      updatedBy = b.updatedBy {
    controller = BlockTextController(this, text: plainOf(b.text));
  }

  final String id;
  String? parentId;
  String orderKey;
  String type;
  BlockAttrs attrs;
  List<DocSpan> spans;
  double rev;
  String updatedBy;

  /// The ask that last brought another writer's change to this block (display only: it shows as being written).
  int? heardAt;

  /// The text the server has, as far as this client knows: an update is sent only when the owner's differs.
  List<DocSpan> sent;

  /// Set when the server did not take the owner's text.
  String? problem;
  late final BlockTextController controller;
  final focus = FocusNode();

  bool get composing => controller.value.composing.isValid && !controller.value.composing.isCollapsed;
  String get text => controller.text;

  void dispose() {
    controller.dispose();
    focus.dispose();
  }
}

class _Pending {
  _Pending(this.ids, this.build, {this.base});

  /// The blocks it changes: their text is not replaced by the server's until it has gone.
  final Set<String> ids;

  /// Made when the batch goes: an op written against a rev takes the rev the client knows then.
  final DocOp Function() build;

  /// The block whose rev the op is written against.
  final String? base;
}

/// The document being edited: blocks in order, the owner's edits as ops waiting to go, one batch on the wire at a time.
/// What comes back replaces the blocks, except the text of a block the owner is still typing in or composing a word in.
class DocEditor extends ChangeNotifier {
  DocEditor(this.api, this.docId);

  final VibeValleyApi api;
  final String docId;

  Document? doc;
  String? error;
  final _byId = <String, EditBlock>{};
  List<EditBlock> blocks = const [];
  double _seq = 0;

  final _queue = <_Pending>[];
  final _dirty = <String>{};
  // Removed here before the server has heard: an answer about one does not bring it back.
  final _gone = <String>{};
  ({String id, List<DocOp> ops, Set<String> ids})? _inflight;
  bool _sending = false;
  Timer? _idle;
  Timer? _max;
  Timer? _poll;
  bool _disposed = false;

  // Asks made for what others wrote, and the one that last brought another writer's change.
  int _polls = 0;
  int? _heardAt;
  // Blocks another writer changed while the owner was in them: not replaced, asked for again once the owner has left.
  final _held = <String>{};

  bool get busy => _sending || _queue.isNotEmpty || _dirty.isNotEmpty;

  /// Someone other than the owner changed the document lately (or the demo was just started): asks come every [pollFast].
  bool get othersWriting => _heardAt != null && _polls - _heardAt! < busyPolls;

  /// [b] is being written by a helper now: its change came in one of the last [writingPolls] asks.
  bool writing(EditBlock b) => b.updatedBy != docOwner && b.heardAt != null && _polls - b.heardAt! < writingPolls;

  Future<void> load() async {
    try {
      _take(await api.doc.get(id: docId), replace: true);
      error = null;
    } on Object catch (e) {
      error = '$e';
    }
    _changed();
    _schedule();
  }

  void _schedule() {
    _poll?.cancel();
    if (_disposed) return;
    _poll = Timer(othersWriting ? pollFast : pollEvery, () async {
      await _refresh();
      _schedule();
    });
  }

  Future<void> _refresh() async {
    if (busy || _disposed) return;
    // Drawn as being written before this ask: it may have stopped since.
    var redraw = othersWriting || blocks.any(writing);
    try {
      final snap = await api.doc.get(id: docId);
      _polls++;
      if ((snap.doc.seq != _seq || _held.isNotEmpty) && !busy) {
        _take(snap, replace: true, heard: true);
        redraw = true;
      }
    } on Object {
      // The next tick asks again.
    }
    if (redraw) _changed();
  }

  /// Starts the scripted demo on this document: helpers write their sections at once; asks come every [pollFast] from now.
  Future<void> demo() async {
    try {
      await api.doc.demo(id: docId);
      error = null;
      _heardAt = _polls;
      _schedule();
    } on Object catch (e) {
      error = '$e';
    }
    _changed();
  }

  void _take(DocSnapshot snap, {required bool replace, bool heard = false}) {
    doc = snap.doc;
    _seq = snap.doc.seq;
    _held.clear();
    final seen = <String>{};
    for (final b in snap.blocks) {
      seen.add(b.id);
      _put(b, heard: heard);
    }
    if (replace) {
      for (final id in _byId.keys.where((id) => !seen.contains(id) && !_dirty.contains(id)).toList()) {
        _byId.remove(id)?.dispose();
      }
    }
    _reorder();
  }

  /// The server's block over the client's: all of it, but the text of one the owner has unsent words in or is composing in.
  /// [heard] is a change asked for, not an answer to the owner's batch: one by another writer marks the block as being
  /// written, and the block the owner is in is left as it is until they leave it.
  void _put(Block b, {bool heard = false}) {
    final mine = _byId[b.id];
    if (_gone.contains(b.id)) {
      if (b.deleted ?? false) _gone.remove(b.id);
      return;
    }
    if (b.deleted ?? false) {
      _byId.remove(b.id)?.dispose();
      return;
    }
    final news = heard && b.updatedBy != docOwner && (mine == null || mine.rev != b.rev);
    if (news) _heardAt = _polls;
    if (mine == null) {
      _byId[b.id] = EditBlock(b)..heardAt = news ? _polls : null;
      return;
    }
    if (heard && mine.focus.hasFocus && mine.rev != b.rev) {
      _held.add(b.id);
      return;
    }
    if (news) mine.heardAt = _polls;
    mine
      ..parentId = b.parentId
      ..orderKey = b.orderKey
      ..type = b.type
      ..attrs = b.attrs
      ..rev = b.rev
      ..updatedBy = b.updatedBy
      ..sent = b.text;
    if (_dirty.contains(b.id) || mine.composing || _queued(b.id)) return;
    mine.spans = b.text;
    final text = plainOf(b.text);
    if (mine.controller.text != text) {
      final at = mine.controller.selection.baseOffset.clamp(0, text.length);
      mine.controller.value = TextEditingValue(
        text: text,
        selection: TextSelection.collapsed(offset: at),
      );
    }
  }

  bool _queued(String id) => (_inflight?.ids.contains(id) ?? false) || _queue.any((p) => p.ids.contains(id));

  void _reorder() {
    final kids = <String?, List<EditBlock>>{};
    for (final b in _byId.values) {
      final parent = b.parentId != null && _byId.containsKey(b.parentId) ? b.parentId : null;
      kids.putIfAbsent(parent, () => []).add(b);
    }
    for (final list in kids.values) {
      list.sort((a, b) => a.orderKey == b.orderKey ? a.id.compareTo(b.id) : a.orderKey.compareTo(b.orderKey));
    }
    final out = <EditBlock>[];
    void walk(String? parent) {
      for (final b in kids[parent] ?? const <EditBlock>[]) {
        out.add(b);
        walk(b.id);
      }
    }

    walk(null);
    blocks = out;
  }

  int depthOf(EditBlock b) {
    var d = 0;
    for (var p = b.parentId; p != null && _byId[p] != null; p = _byId[p]!.parentId) {
      d++;
    }
    return d;
  }

  Map<String, int> get numbers => listNumbers([for (final b in blocks) (id: b.id, parentId: b.parentId, type: b.type)]);

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  // The owner's edits.

  /// A field's new value. A line break in a block other than code is Enter: the block splits there.
  void edited(EditBlock b, TextEditingValue v) {
    final before = plainOf(b.spans);
    final text = v.text;
    if (b.composing) {
      // Not sent while composing; the wait is armed so the word goes once it is committed, changed or not.
      b.spans = editSpans(b.spans, text);
      _dirty.add(b.id);
      _arm();
      return;
    }
    if (b.type != blockCode && text.contains('\n')) {
      final at = text.indexOf('\n');
      final joined = text.substring(0, at) + text.substring(at + 1);
      b.spans = editSpans(b.spans, joined);
      b.controller.value = TextEditingValue(
        text: joined,
        selection: TextSelection.collapsed(offset: at),
      );
      // Pasted lines: each becomes a block.
      final added = enter(b, at);
      if (added != null && added.text.contains('\n')) edited(added, added.controller.value);
      return;
    }
    if (b.type == blockParagraph && markdownShortcut(before) == null) {
      final shortcut = markdownShortcut(text);
      if (shortcut != null) {
        final rest = text.substring(shortcut.strip);
        b.spans = editSpans(b.spans, rest);
        b.controller.value = TextEditingValue(text: rest, selection: const TextSelection.collapsed(offset: 0));
        _setType(b, shortcut.type, shortcut.attrs);
        return;
      }
    }
    if (text == before) return;
    b.spans = editSpans(b.spans, text);
    _dirty.add(b.id);
    _arm();
    _changed();
  }

  void _arm() {
    _idle?.cancel();
    _idle = Timer(idleWait, flush);
    _max ??= Timer(maxWait, flush);
  }

  /// Enter at [at] (UTF-16) in [b]: an empty list item leaves the list; otherwise the text after [at] becomes a new block.
  EditBlock? enter(EditBlock b, int at) {
    if (listTypes.contains(b.type) && b.text.isEmpty) {
      _setType(b, blockParagraph, const BlockAttrs());
      return null;
    }
    _textOp(b);
    final (left, right) = splitSpans(b.spans, at);
    final next = _nextSibling(b);
    final keepType = listTypes.contains(b.type) || b.type == blockQuote;
    final type = keepType ? b.type : blockParagraph;
    final attrs = b.type == blockTodo ? const BlockAttrs(checked: false) : const BlockAttrs();
    final nb = Block(
      id: newBlockId(),
      docId: docId,
      parentId: b.parentId,
      orderKey: keyBetween(b.orderKey, next?.orderKey ?? ''),
      type: type,
      attrs: attrs,
      text: const [],
      rev: 0,
      updatedBy: docOwner,
      updated: 0,
    );
    final offset = codePointOffset(b.text, at);
    b.spans = left;
    b.controller.value = TextEditingValue(
      text: plainOf(left),
      selection: TextSelection.collapsed(offset: plainOf(left).length),
    );
    final added = EditBlock(nb)
      ..spans = right
      ..sent = const [];
    added.controller.value = TextEditingValue(text: plainOf(right), selection: const TextSelection.collapsed(offset: 0));
    _byId[nb.id] = added;
    _reorder();
    _queue.add(
      _Pending(
        {b.id, nb.id},
        () => DocOpSplitBlock(blockId: b.id, baseRev: b.rev, offset: offset.toDouble(), newBlock: nb),
        base: b.id,
      ),
    );
    // The split carries none of the text; what the new block has is the server's to give back.
    added.sent = right;
    _changed();
    added.focus.requestFocus();
    _send();
    return added;
  }

  /// Backspace at the start of [b]: a block that is not a paragraph becomes one; a paragraph joins the block before it.
  void backspaceAtStart(EditBlock b) {
    if (b.type != blockParagraph && hasText(b.type)) {
      _setType(b, blockParagraph, const BlockAttrs());
      return;
    }
    final i = blocks.indexOf(b);
    if (i <= 0) return;
    final prev = blocks[i - 1];
    if (!knownTypes.contains(prev.type)) return;
    if (!hasText(prev.type)) {
      _byId.remove(prev.id)?.dispose();
      _gone.add(prev.id);
      _reorder();
      _queue.add(_Pending({prev.id}, () => DocOpDeleteBlock(blockId: prev.id)));
      _changed();
      _send();
      return;
    }
    _textOp(prev);
    _textOp(b);
    final join = prev.text.length;
    prev.spans = normalSpans([...prev.spans, ...b.spans]);
    prev.controller.value = TextEditingValue(
      text: plainOf(prev.spans),
      selection: TextSelection.collapsed(offset: join),
    );
    for (final c in _byId.values.where((c) => c.parentId == b.id)) {
      c.parentId = prev.id;
    }
    _byId.remove(b.id);
    _gone.add(b.id);
    _reorder();
    _queue.add(_Pending({prev.id, b.id}, () => DocOpMergeBlocks(targetId: prev.id, sourceId: b.id)));
    prev.sent = prev.spans;
    _changed();
    prev.focus.requestFocus();
    WidgetsBinding.instance.addPostFrameCallback((_) => b.dispose());
    _send();
  }

  void toggle(EditBlock b) {
    final checked = !(b.attrs.checked ?? false);
    b.attrs = BlockAttrs(checked: checked);
    _queue.add(
      _Pending(
        {b.id},
        () => DocOpSetAttrs(
          blockId: b.id,
          attrs: BlockAttrs(checked: checked),
        ),
      ),
    );
    _changed();
    _send();
  }

  /// A new paragraph at the end, focused: what a click below the last block does.
  void append() {
    final last = blocks.where((b) => b.parentId == null).lastOrNull;
    final nb = Block(
      id: newBlockId(),
      docId: docId,
      orderKey: keyBetween(last?.orderKey ?? '', ''),
      type: blockParagraph,
      attrs: const BlockAttrs(),
      text: const [],
      rev: 0,
      updatedBy: docOwner,
      updated: 0,
    );
    final added = EditBlock(nb);
    _byId[nb.id] = added;
    _reorder();
    _queue.add(_Pending({nb.id}, () => DocOpInsertBlock(block: nb)));
    _changed();
    added.focus.requestFocus();
    _send();
  }

  EditBlock? neighbour(EditBlock b, int step) {
    final i = blocks.indexOf(b) + step;
    for (var j = i; j >= 0 && j < blocks.length; j += step) {
      if (hasText(blocks[j].type)) return blocks[j];
    }
    return null;
  }

  EditBlock? _nextSibling(EditBlock b) {
    final siblings = blocks.where((x) => x.parentId == b.parentId).toList();
    final i = siblings.indexOf(b);
    return i >= 0 && i + 1 < siblings.length ? siblings[i + 1] : null;
  }

  void _setType(EditBlock b, String type, BlockAttrs attrs) {
    _textOp(b);
    b
      ..type = type
      ..attrs = attrs;
    _queue.add(_Pending({b.id}, () => DocOpSetType(blockId: b.id, type: type, attrs: attrs)));
    _textOp(b);
    _changed();
    _send();
  }

  /// Queues the block's text when it is not what the server has: written against the rev known when it goes.
  void _textOp(EditBlock b) {
    _dirty.remove(b.id);
    if (b.composing || !hasText(b.type)) return;
    final spans = b.spans;
    if (plainOf(spans) == plainOf(b.sent) && spans.length == b.sent.length) return;
    b.sent = spans;
    _queue.add(
      _Pending(
        {b.id},
        () => DocOpUpdateText(blockId: b.id, baseRev: b.rev, text: spans),
        base: b.id,
      ),
    );
  }

  /// Sends the waiting text now: the field lost focus, or the wait is over.
  void flush() {
    _idle?.cancel();
    _max?.cancel();
    _idle = _max = null;
    for (final id in _dirty.toList()) {
      final b = _byId[id];
      if (b == null) {
        _dirty.remove(id);
      } else if (b.composing) {
        _arm();
      } else {
        _textOp(b);
      }
    }
    _send();
  }

  Future<void> _send() async {
    if (_sending || _disposed) return;
    _sending = true;
    try {
      while (!_disposed) {
        var batch = _inflight;
        if (batch == null) {
          if (_queue.isEmpty) break;
          // A batch ends before an op written against a block an earlier op in it changes: that op needs the rev the
          // server gives back.
          final ops = <DocOp>[];
          final ids = <String>{};
          while (_queue.isNotEmpty && !(ops.isNotEmpty && _queue.first.base != null && ids.contains(_queue.first.base))) {
            final next = _queue.removeAt(0);
            ops.add(next.build());
            ids.addAll(next.ids);
          }
          batch = _inflight = (id: newBlockId(), ops: ops, ids: ids);
        }
        final DocAck ack;
        try {
          ack = await api.doc.submit(
            id: docId,
            body: DocSubmit(batchId: batch.id, lastSeq: _seq, ops: batch.ops),
          );
        } on Object catch (e) {
          // Kept with its batch id, so sending it again cannot take it twice.
          error = '没存上：$e';
          _changed();
          break;
        }
        _inflight = null;
        error = null;
        _seq = ack.seq;
        for (final r in ack.results) {
          final b = _byId[r.blockId];
          if (b == null) continue;
          b.problem = switch (r.status) {
            DocOpStatus.conflict => '${r.reason ?? '这一块刚被别人改过'}：你写的没存上，留在修订里了',
            DocOpStatus.rejected => '没存上：${r.reason ?? ''}',
            _ => null,
          };
          if (r.status == DocOpStatus.conflict) b.sent = const [];
        }
        for (final b in ack.blocks) {
          _put(b);
        }
        for (final r in ack.results.where((r) => r.status == DocOpStatus.conflict)) {
          final b = _byId[r.blockId];
          final server = ack.blocks.where((x) => x.id == r.blockId).firstOrNull;
          if (b != null && server != null && !b.composing) {
            b.spans = b.sent = server.text;
            b.controller.value = TextEditingValue(
              text: plainOf(server.text),
              selection: TextSelection.collapsed(offset: plainOf(server.text).length),
            );
          }
        }
        _reorder();
        _changed();
      }
    } finally {
      _sending = false;
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _idle?.cancel();
    _max?.cancel();
    _poll?.cancel();
    for (final b in _byId.values) {
      b.dispose();
    }
    super.dispose();
  }
}

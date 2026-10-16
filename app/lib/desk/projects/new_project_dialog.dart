// 新增项目 (web/src/pages/NewProjectDialog.tsx): open a new piece of land under the work directory, or download a public
// GitHub repository into it. The name follows the repository's until it is typed by hand.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../gen/vibevalley.dart';
import '../../ui/kit/kit.dart';
import 'codebase.dart';
import 'projects_state.dart';
import '../shared/widgets.dart';

/// Opens the dialog; on success it closes and the page goes to the new project.
Future<void> showNewProjectDialog(BuildContext context) => showPxDialog<void>(
  context,
  title: const Text('新增项目'),
  builder: (_) => NewProjectForm(onDone: (name) => deskGo(context, '/projects/${Uri.encodeComponent(name)}')),
);

class NewProjectForm extends ConsumerStatefulWidget {
  const NewProjectForm({super.key, required this.onDone});

  /// After the dialog closed, with the new project's name.
  final ValueChanged<String> onDone;

  @override
  ConsumerState<NewProjectForm> createState() => _NewProjectFormState();
}

class _NewProjectFormState extends ConsumerState<NewProjectForm> {
  bool _importing = true;
  String _github = '';
  String _name = '';
  bool _named = false;
  bool _busy = false;
  String? _error;

  NewProject get _request => NewProject(name: _name.trim(), github: _importing ? _github.trim() : null);

  Future<void> _submit() async {
    if (_busy) return;
    final problem = projectProblem(_request);
    if (problem != null) return setState(() => _error = problem);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final project = await ref.read(projectsProvider.notifier).create(_request);
      if (!mounted) return;
      Navigator.of(context).pop();
      widget.onDone(project.name);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = '$e';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final canSubmit = !_busy && _name.trim().isNotEmpty && (!_importing || _github.trim().isNotEmpty);
    return PopScope(
      canPop: !_busy,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              PxButton.text(
                '开一块新地',
                tone: _importing ? PxTone.plain : PxTone.primary,
                onPressed: _busy
                    ? null
                    : () => setState(() {
                        _importing = false;
                        _error = null;
                      }),
              ),
              const SizedBox(width: 8),
              PxButton.text(
                '去别人家看看',
                tone: _importing ? PxTone.primary : PxTone.plain,
                onPressed: _busy
                    ? null
                    : () => setState(() {
                        _importing = true;
                        _error = null;
                      }),
              ),
            ],
          ),
          if (_importing) ...[
            const SizedBox(height: 16),
            PxField(
              label: 'GitHub 地址',
              hint: const Text('公开仓库的主页地址。下载到本地后，就能查看项目和安排帮工。'),
              child: PxTextInput(
                autofocus: true,
                value: _github,
                enabled: !_busy,
                placeholder: 'https://github.com/botiverse/raft-source',
                semanticLabel: 'GitHub 地址',
                onSubmitted: (_) => _submit(),
                onChanged: (value) => setState(() {
                  _github = value;
                  if (!_named) _name = githubRepository(value)?.name ?? '';
                  _error = null;
                }),
              ),
            ),
          ],
          const SizedBox(height: 16),
          PxField(
            label: '项目名',
            hint: const Text('保存在工作目录里；已有同名项目不会被覆盖。'),
            child: PxTextInput(
              value: _name,
              enabled: !_busy,
              placeholder: '比如 raft-source',
              semanticLabel: '项目名',
              onSubmitted: (_) => _submit(),
              onChanged: (value) => setState(() {
                _named = true;
                _name = value;
                _error = null;
              }),
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 16),
            Semantics(
              liveRegion: true,
              child: Text(_error!, style: KitText.sm.copyWith(color: Palette.berry)),
            ),
          ],
          if (_busy) ...[
            const SizedBox(height: 16),
            Text(_importing ? '正在下载仓库… 大仓库需要多等一会儿，最多 3 分钟。' : '正在开地…', style: KitText.sm.copyWith(color: Palette.bark600)),
          ],
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              PxButton.text('取消', onPressed: _busy ? null : () => Navigator.of(context).pop()),
              const SizedBox(width: 8),
              PxButton.text(
                _busy
                    ? '进行中…'
                    : _importing
                    ? '下载到农场'
                    : '创建项目',
                tone: PxTone.primary,
                onPressed: canSubmit ? _submit : null,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// The name follows the repository's until it is typed by hand.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../ui/pro/pro.dart';
import 'codebase.dart';
import '../../data/remote.dart';

Future<ProjectSummary?> showNewProjectDialog(BuildContext context) =>
    showProDialog<ProjectSummary>(context, title: const Text('新增项目'), builder: (_) => const NewProjectForm());

class NewProjectForm extends ConsumerStatefulWidget {
  const NewProjectForm({super.key});

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
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      // The server says what it would refuse; the dialog only shows it.
      final problem = (await ref.read(apiProvider).project.check(body: _request)).problem;
      if (problem != null) {
        if (mounted) {
          setState(() {
            _busy = false;
            _error = problem;
          });
        }
        return;
      }
      final project = await ref.read(projectCatalogProvider.notifier).create(_request);
      if (!mounted) return;
      Navigator.of(context).pop(project);
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
          ProSegmented<bool>(
            value: _importing,
            options: [
              SegmentOption(value: false, label: '开一块新地', disabled: _busy),
              SegmentOption(value: true, label: '去别人家看看', disabled: _busy),
            ],
            onChanged: (importing) => setState(() {
              _importing = importing;
              _error = null;
            }),
          ),
          if (_importing) ...[
            const SizedBox(height: 16),
            ProField(
              label: 'GitHub 地址',
              hint: const Text('公开仓库的主页地址。下载到本地后，就能查看项目和安排帮工。'),
              child: ProTextInput(
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
          ProField(
            label: '项目名',
            hint: const Text('保存在工作目录里；已有同名项目不会被覆盖。'),
            child: ProTextInput(
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
              child: Text(_error!, style: ProText.sm.copyWith(color: Palette.berry)),
            ),
          ],
          if (_busy) ...[
            const SizedBox(height: 16),
            Text(_importing ? '正在下载仓库… 大仓库需要多等一会儿，最多 3 分钟。' : '正在开地…', style: ProText.sm.copyWith(color: ProColor.muted)),
          ],
          const SizedBox(height: 24),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              ProButton.text('取消', onPressed: _busy ? null : () => Navigator.of(context).pop()),
              const SizedBox(width: 8),
              ProButton.text(
                _busy
                    ? '进行中…'
                    : _importing
                    ? '下载到农场'
                    : '创建项目',
                tone: ProTone.primary,
                onPressed: canSubmit ? _submit : null,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/remote.dart';
import '../../ui/kit/kit.dart';

class ConfigProblem extends ConsumerStatefulWidget {
  const ConfigProblem({super.key});

  @override
  ConsumerState<ConfigProblem> createState() => _ConfigProblemState();
}

class _ConfigProblemState extends ConsumerState<ConfigProblem> {
  bool _retrying = false;

  Future<void> _retry() async {
    if (_retrying) return;
    setState(() => _retrying = true);
    try {
      await ref.read(workbenchConfigProvider.notifier).refresh();
    } finally {
      if (mounted) setState(() => _retrying = false);
    }
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(16),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('配置没读到：${ref.watch(workbenchConfigProvider).error ?? '正在重试'}', style: KitText.sm.copyWith(color: Palette.berry)),
        const SizedBox(height: 8),
        PxButton(onPressed: _retrying ? null : _retry, child: Text(_retrying ? '正在重试…' : '重新读取配置')),
      ],
    ),
  );
}

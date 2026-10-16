// The protocol rules ported for the desk pages (lib/desk/shared): agentIssues, recall's pick and nextForgotten, castOf's
// hash (the same animal as the web page picks), installedSkills, mergeSteps, the skill slug and the voice overrides.

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/desk/voice/voice_rules.dart';
import 'package:vibevalley/desk/shared/recall.dart';
import 'package:vibevalley/desk/shared/rules.dart';
import 'package:vibevalley/desk/shared/state.dart';
import 'package:vibevalley/desk/skills/skills_page.dart';
import 'package:vibevalley/gen/vibevalley.dart';

import 'deska_fakes.dart';
import 'package:vibevalley/rules/index.dart';
import 'package:vibevalley/rules/looks.dart';
import 'package:vibevalley/rules/seeds.dart';

void main() {
  group('agentIssues', () {
    test('a runtime it does not know, or one not on this machine, stops it', () {
      expect(agentIssues(agent('a', 'A', runtime: 'nope'), null).single.text, '不认识的 runtime：nope');
      final missing = agentIssues(agent('a', 'A'), runtime('claude', available: false));
      expect(missing.single.level, IssueLevel.error);
      expect(missing.single.text, '这台机器上找不到这个 runtime');
    });

    test('a persona cursor cannot take as a system prompt is an error; written into the job it is fine', () {
      final a = agent('a', 'A', runtime: 'cursor', persona: '你是谁');
      expect(agentIssues(a, runtime('cursor')).map((i) => i.text), ['Cursor SDK 的本地 agent 不支持追加系统提示。把人设改成「写进工单开头」。']);
      expect(agentIssues(a.copyWith(personaMode: PersonaMode.prompt), runtime('cursor')), isEmpty);
    });

    test('a model the runtime does not list warns; an effort the model lacks is an error', () {
      final rt = runtime(
        'claude',
        models: const [
          ModelEntry(id: 'opus', name: 'Opus', effortLevels: ['low', 'high'], isDefault: true),
        ],
      );
      expect(agentIssues(agent('a', 'A').copyWith(model: 'haiku'), rt).single.level, IssueLevel.warn);
      final wrong = agentIssues(agent('a', 'A').copyWith(model: 'opus', effort: 'max'), rt).single;
      expect(wrong.level, IssueLevel.error);
      expect(wrong.text, 'Opus 没有 max 这一档，可选：low、high');
      // No model named: the runtime's default one must take the effort (its settings' when set, else its own).
      final unnamed = agentIssues(agent('a', 'A').copyWith(effort: 'max'), rt).single;
      expect(unnamed.text, 'claude 默认用的 Opus 没有 max 这一档，可选：low、high');
      expect(agentIssues(agent('a', 'A').copyWith(effort: 'high'), rt), isEmpty);
    });

    test('a used-up plan window stops it, with the runtime named', () {
      final rt = RuntimeInfo.fromJson({
        ...runtime('claude').toJson(),
        'usage': {
          'status': 'ok',
          'plan': null,
          'windows': [
            {'label': '5 小时', 'usedPercent': 100, 'resetsAt': null},
          ],
        },
      });
      expect(agentIssues(agent('a', 'A'), rt).single.text, 'Claude Code 的额度用完了（5 小时），到时候再派');
    });
  });

  test('castOf picks the same animal from an id as the web page', () {
    // From the web page: hash(id) % 7 over bear, rabbit, fox, cat, owl, hedgehog, raccoon.
    expect(castOf(null, 'backend').species, Species.cat);
    expect(castOf(null, 'agent-7').species, Species.fox);
    expect(castOf(null, '老周').species, Species.hedgehog);
    expect(castOf(look(species: Species.owl, outfit: Outfit.rain), 'backend'), (species: Species.owl, outfit: Outfit.rain));
  });

  test('runtimeName names the presets and falls back to the id', () {
    expect(runtimeName('claude'), 'Claude Code');
    expect(runtimeName('pi'), 'Pi');
    expect(runtimeName('mystery'), 'mystery');
  });

  group('recall', () {
    test('pick brings this project and every project, never another project\'s job', () {
      final list = [
        memory('a', '跑测试用 pnpm test', project: 'clock'),
        memory('b', '提交信息写中文'),
        memory('c', '修了登录', kind: MemoryKind.job, project: 'other'),
        memory('d', '别的项目的事', project: 'other'),
      ];
      final picked = pick(list, const Cue(helper: '', project: 'clock', text: '', now: 0));
      expect(picked.map((m) => m.id), ['a', 'b']);
      expect(lineOf(picked.first, 'clock'), '- （这个项目）跑测试用 pnpm test');
      expect(lineOf(list[1], 'clock'), '- （所有项目）提交信息写中文');
    });

    test('nextForgotten marks the longest unused once the memory would be full', () {
      final many = [for (var i = 0; i < memoryKeep; i++) memory('m$i', 'x', at: i.toDouble())];
      expect(nextForgotten(many.take(10).toList(), 10), isEmpty);
      expect(nextForgotten(many, 2), {'m0', 'm1'});
    });

    test('termsOf takes Latin words and Chinese pairs, without the common ones', () {
      expect(termsOf('Run the pnpm test 一个测试'), {'run', 'pnpm', 'test', '个测', '测试'});
    });
  });

  test('installedSkills groups the runtimes\' skills by name, A to Z', () {
    final all = installedSkills([
      runtime(
        'claude',
        skills: const [
          InventoryEntry(name: 'pdf', description: 'PDF 工具', source: '/a'),
          InventoryEntry(name: 'docx'),
        ],
      ),
      runtime(
        'pi',
        skills: const [InventoryEntry(name: 'pdf', source: '/b')],
      ),
    ]);
    expect(all.map((s) => s.name), ['docx', 'pdf']);
    expect(all.last.description, 'PDF 工具');
    expect(all.last.runtimes.map((x) => '${x.runtime}:${x.source}'), ['claude:/a', 'pi:/b']);
  });

  test('mergeSteps lays new steps over old by number, in order', () {
    WorkStep step(double n, String text) => WorkStep(n: n, at: n, kind: StepKind.said, text: text);
    final merged = mergeSteps([step(1, 'a'), step(2, 'b')], [step(2, 'B'), step(3, 'c')]);
    expect(merged.map((s) => s.text), ['a', 'B', 'c']);
  });

  test('slug makes an id from the name, numbered when taken', () {
    expect(slug('Tests First!', {}), 'tests-first');
    expect(slug('先写测试', {}), 'skill');
    expect(slug('先写测试', {'skill', 'skill-2'}), 'skill-3');
  });

  test('voiceOverrides keeps only what differs from the defaults; voiceProblem checks the persona', () {
    final defaults = voice();
    expect(voiceOverrides(defaults, defaults).toJson(), isEmpty);
    expect(voiceOverrides(defaults, voice(greeting: '你好')).toJson(), {'greeting': '你好'});
    expect(voiceProblem(SettingsUpdateVoice.fromJson(defaults.toJson())), isNull);
    expect(voiceProblem(SettingsUpdateVoice.fromJson({...defaults.toJson(), 'persona': ' '})), '管家的人设不能空着');
  });
}

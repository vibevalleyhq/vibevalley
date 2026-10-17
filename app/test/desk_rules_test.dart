import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/data/remote.dart';
import 'package:vibevalley/desk/skills/skills_page.dart';
import 'package:vibevalley/gen/vibevalley.dart';

import 'support/desk.dart';
import 'package:vibevalley/rules/looks.dart';
import 'package:vibevalley/rules/seeds.dart';

void main() {
  test('castOf picks the same animal from an id every time', () {
    // hash(id) % 7 over bear, rabbit, fox, cat, owl, hedgehog, raccoon.
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
    Activity step(double n, String text) => Activity(n: n, at: n, kind: ActivityKind.response, text: text);
    final merged = mergeSteps([step(1, 'a'), step(2, 'b')], [step(2, 'B'), step(3, 'c')]);
    expect(merged.map((s) => s.text), ['a', 'B', 'c']);
  });

  test('slug makes an id from the name, numbered when taken', () {
    expect(slug('Tests First!', {}), 'tests-first');
    expect(slug('先写测试', {}), 'skill');
    expect(slug('先写测试', {'skill', 'skill-2'}), 'skill-3');
  });
}

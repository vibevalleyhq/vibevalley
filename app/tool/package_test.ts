import { afterEach, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const tools = resolve(import.meta.dirname)
function command(args: string[], cwd: string, env: Record<string, string> = {}) {
  return Bun.spawnSync(args, { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
}
function ok(args: string[], cwd: string, env: Record<string, string> = {}) {
  const result = command(args, cwd, env)
  if (result.exitCode !== 0) throw new Error(`${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`)
  return new TextDecoder().decode(result.stdout)
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vibevalley package ')); roots.push(root)
  for (const dir of ['app/tool', 'app/lib/host', 'app/macos/Runner', 'server', 'bin']) mkdirSync(join(root, dir), { recursive: true })
  for (const file of ['build-macos.sh', 'agora-voice-only.sh', 'with-lock.sh', 'locked.go', 'publish-macos.c', 'channel.dart']) cpSync(join(tools, file), join(root, 'app/tool', file))
  cpSync(resolve(tools, '../../server/go.mod'), join(root, 'server/go.mod'))
  cpSync(resolve(tools, '../lib/host/channel.dart'), join(root, 'app/lib/host/channel.dart'))
  writeFileSync(join(root, 'LICENSE'), 'license'); writeFileSync(join(root, 'NOTICE'), 'notice')
  writeFileSync(join(root, 'app/pubspec.yaml'), 'name: fixture\nenvironment:\n  sdk: ^3.8.0\ndependencies:\n  agora_rtc_engine: ^6.6.4\n')
  const cache = join(root, 'cache')
  function cached(version: string) {
    for (const [platform, native] of [['macos', 'macOS'], ['ios', 'iOS']]) {
      const dir = join(cache, 'hosted/pub.dev', `agora_rtc_engine-${version}`, platform, 'agora_rtc_engine'); mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'Package.swift'), ['AgoraRtcKit', 'AINS', 'AIAEC', 'VideoCodecEnc'].map(name => `.product(name: "${name}", package: "AgoraRtcEngine_${native}"),`).join('\n') + '\n')
    }
  }
  cached('6.6.4')
  const fake: Record<string, string> = {
    go: 'for last do :; done; case "$last" in */locked.go) exec "$TEST_REAL_GO" "$@";; esac; while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; printf "%s" "$TEST_REV" > "$1"; exit 0; fi; shift; done; exit 1',
    flutter: 'app=build/macos/Build/Products/Release/vibevalley.app; mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"; printf "%s" "$TEST_REV" > "$app/Contents/MacOS/vibevalley"; cp "$TEST_PLIST" "$app/Contents/Info.plist"',
    codesign: '[ "${TEST_FAIL_SIGN:-0}" != 1 ]',
    hdiutil: 'if [ "$1" = verify ]; then test -f "$2"; exit; fi; for last do :; done; printf "%s" "$TEST_REV" > "$last"',
  }
  for (const [name, body] of Object.entries(fake)) writeFileSync(join(root, 'bin', name), '#!/bin/sh\nset -eu\n' + body + '\n', { mode: 0o755 })
  const plist = join(root, 'Info.plist')
  writeFileSync(plist, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.vibevalley.app</string><key>CFBundleName</key><string>vibevalley</string><key>CFBundleDisplayName</key><string>码农场物语</string></dict></plist>')
  const env = { PUB_CACHE: cache, PATH: join(root, 'bin') + ':' + process.env.PATH, TEST_REV: 'one', TEST_PLIST: plist, TEST_REAL_GO: Bun.which('go')!  }
  return { root, env, cached }
}

test('published channel identities stay unchanged', () => {
  for (const [channel, fields] of [
    ['release', ['vibevalley', '码农场物语', 'dev.vibevalley.app', 'vibevalley-arm64.dmg']],
    ['alpha', ['vibevalley Alpha', '码农场物语 Alpha', 'dev.vibevalley.app.alpha', 'vibevalley-alpha-arm64.dmg']],
    ['beta', ['vibevalley Beta', '码农场物语 Beta', 'dev.vibevalley.app.beta', 'vibevalley-beta-arm64.dmg']],
  ] as const) expect(ok(['dart', 'channel.dart', channel], tools).trim().split('\t')).toEqual([...fields])
})

test('dependency preparation owns patching and is idempotent', () => {
  const { root, env, cached } = fixture()
  ok(['sh', 'app/tool/agora-voice-only.sh'], root, env)
  const prepared = join(root, 'app/third_party/agora_rtc_engine')
  expect(readFileSync(join(prepared, 'macos/agora_rtc_engine/Package.swift'), 'utf8')).not.toContain('VideoCodecEnc')
  writeFileSync(join(prepared, 'marker'), 'retained')
  ok(['sh', 'app/tool/agora-voice-only.sh'], root, env)
  expect(existsSync(join(prepared, 'marker'))).toBe(true)
  cached('6.6.5'); writeFileSync(join(root, 'app/pubspec.yaml'), '  agora_rtc_engine: ^6.6.5\n')
  ok(['sh', 'app/tool/agora-voice-only.sh'], root, env)
  expect(readFileSync(join(prepared, '.vibevalley-prepared'), 'utf8').trim()).toBe('6.6.5/voice-only-v1')
  expect(existsSync(join(prepared, 'marker'))).toBe(false)
})

test('packaging preserves prior artifacts on failure and publishes validated replacements', () => {
  const { root, env } = fixture()
  const build = ['sh', 'app/tool/build-macos.sh', '--channel', 'alpha']
  ok(build, root, env)
  const binary = join(root, 'app/build/vibevalley Alpha.app/Contents/MacOS/vibevalley-server')
  const dmg = join(root, 'app/build/vibevalley-alpha-arm64.dmg')
  expect(readFileSync(binary, 'utf8')).toBe('one')
  expect(command(build, root, { ...env, TEST_REV: 'two', TEST_FAIL_SIGN: '1' }).exitCode).not.toBe(0)
  expect(readFileSync(binary, 'utf8')).toBe('one'); expect(readFileSync(dmg, 'utf8')).toBe('one')
  ok(build, root, { ...env, TEST_REV: 'two' })
  expect(readFileSync(binary, 'utf8')).toBe('two'); expect(readFileSync(dmg, 'utf8')).toBe('two')
  expect(ok(['/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleIdentifier', join(root, 'app/build/vibevalley Alpha.app/Contents/Info.plist')], root).trim()).toBe('dev.vibevalley.app.alpha')
}, 30000)

test('publication rolls back the first artifact if the second cannot be published', () => {
  const { root } = fixture()
  ok(['xcrun', 'clang', 'app/tool/publish-macos.c', '-o', 'publish'], root)
  mkdirSync(join(root, 'old.app')); mkdirSync(join(root, 'new.app'))
  writeFileSync(join(root, 'old.app/version'), 'old'); writeFileSync(join(root, 'new.app/version'), 'new'); writeFileSync(join(root, 'new.dmg'), 'new')
  expect(command(['./publish', 'new.app', 'old.app', 'new.dmg', 'missing/target.dmg'], root).exitCode).toBe(1)
  expect(readFileSync(join(root, 'old.app/version'), 'utf8')).toBe('old')
})


test('a hangup during publication preserves recovery artifacts and never deletes the old app', () => {
  const { root, env } = fixture()
  const build = ['sh', 'app/tool/build-macos.sh', '--channel', 'alpha']
  ok(build, root, env)
  const publisher = join(root, 'app/tool/publish-macos.c')
  const source = readFileSync(publisher, 'utf8')
  writeFileSync(publisher, source.replace('  if (publish(argv[3]', '  kill(getppid(), SIGHUP); raise(SIGHUP);\n  if (publish(argv[3]'))
  expect(command(build, root, { ...env, TEST_REV: 'two' }).exitCode).not.toBe(0)
  // A descendant publisher retains the same lock until it has finished both swaps.
  ok(['sh', 'app/tool/with-lock.sh', join(root, 'app/build/.package-macos.lock'), 'true'], root, env)
  const app = join(root, 'app/build/vibevalley Alpha.app/Contents/MacOS/vibevalley-server')
  const dmg = join(root, 'app/build/vibevalley-alpha-arm64.dmg')
  expect(readFileSync(app, 'utf8')).toBe('two'); expect(readFileSync(dmg, 'utf8')).toBe('two')
  const stages = [...new Bun.Glob('app/build/package-alpha.*/vibevalley Alpha.app/Contents/MacOS/vibevalley-server').scanSync({ cwd: root })]
  expect(stages.length).toBe(1)
  expect(readFileSync(join(root, stages[0]), 'utf8')).toBe('one')
}, 30000)

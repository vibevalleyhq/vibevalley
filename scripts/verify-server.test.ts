import { expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runVerification, readyAddress } from './verify-server'

test('only a machine receipt from the owned process announces readiness', () => {
  expect(readyAddress('listening on http://127.0.0.1:9999', 17)).toBeUndefined()
  expect(readyAddress('{"note":"other stdout"}', 17)).toBeUndefined()
  expect(readyAddress('{"pid":18,"url":"http://127.0.0.1:9999"}', 17)).toBeUndefined()
  expect(readyAddress('{"pid":17,"url":"http://0.0.0.0:9999"}', 17)).toBeUndefined()
  expect(readyAddress('{"pid":17,"url":"http://127.0.0.1:0"}', 17)).toBeUndefined()
  expect(readyAddress('{"pid":17,"url":"http://127.0.0.1:9999"}', 17)).toBe('http://127.0.0.1:9999')
})

test('sandbox owns isolation, readiness, validation failure and cleanup', async () => {
  const result = await runVerification(['bun', '-e', `
    const server = process.env.VIBEVALLEY_SERVER;
    const created = await fetch(server + '/api/v1/issues', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'sandbox fixture'})});
    if (!created.ok) throw new Error('create failed: ' + await created.text());
    const issue = await created.json();
    const cli = Bun.spawnSync([process.env.VIBEVALLEY_VERIFY_CLI, 'state'], {env:process.env});
    if (cli.exitCode !== 0) throw new Error('state failed');
    const frame = JSON.parse(new TextDecoder().decode(cli.stdout));
    if (!frame.state.issues.some(i => i.id === issue.id)) throw new Error('fixture absent from state');
    const descendant = Bun.spawn(['sh', '-c', 'sleep 30 & wait'], {stdout:'ignore',stderr:'ignore'});
    console.log(JSON.stringify({issue:issue.id,title:issue.title,address:server,descendant:descendant.pid}));
    process.exit(23);
  `])
  try {
    expect(result.code).toBe(23)
    expect(result.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(JSON.parse(readFileSync(join(result.evidence, 'health.json'), 'utf8')).ok).toBe(true)
    const ready = JSON.parse(readFileSync(join(result.evidence, 'ready.json'), 'utf8'))
    expect(ready.url).toBe(result.address)
    expect(ready.pid).toBeGreaterThan(0)
    expect(readFileSync(join(result.evidence, 'server.stdout.log'), 'utf8')).toContain(JSON.stringify(ready))
    const output = JSON.parse(readFileSync(join(result.evidence, 'command.stdout.log'), 'utf8'))
    expect(output.title).toBe('sandbox fixture')
    let descendantAlive = true
    try { process.kill(output.descendant, 0) } catch { descendantAlive = false }
    expect(descendantAlive).toBe(false)
    for (const path of ['home', 'work', 'bin']) expect(existsSync(join(result.evidence, path))).toBe(false)
    expect(await fetch(result.address + '/api/v1/health', { signal: AbortSignal.timeout(500) }).then(() => true, () => false)).toBe(false)
  } finally { rmSync(result.evidence, { recursive: true, force: true }) }
}, 60_000)

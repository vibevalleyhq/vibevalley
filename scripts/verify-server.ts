import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export interface VerificationResult {
  code: number
  evidence: string
  address: string
}

function isolatedEnvironment(home: string, work: string): Record<string, string> {
  const env: Record<string, string> = {}
  const screenOptions = new Set(['VIBEVALLEY_PAGES', 'VIBEVALLEY_SCREEN', 'VIBEVALLEY_EXTRA', 'VIBEVALLEY_FRAMES'])
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (!key.startsWith('VIBEVALLEY_') || screenOptions.has(key)) && !['DEEPSEEK_API_KEY', 'AGORA_APP_ID', 'AGORA_APP_CERTIFICATE'].includes(key)) env[key] = value
  }
  return { ...env, VIBEVALLEY_HOME: home, VIBEVALLEY_WORK_ROOT: work, VIBEVALLEY_PORT: '0', VIBEVALLEY_VOICE_LINE_PORT: '0', VIBEVALLEY_PATROL_HEARTBEAT_MINUTES: '0' }
}

// The child publishes this protocol.ServerReady receipt after binding its own port.
export function readyAddress(line: string, pid: number): string | undefined {
  try {
    const ready = JSON.parse(line)
    if (ready.pid !== pid || typeof ready.url !== 'string') return
    const url = new URL(ready.url)
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) > 0) return url.origin
  } catch { /* Other stdout is still logged, but is not a readiness receipt. */ }
}

// The validation command owns assertions and fixtures; this owner isolates and releases its server and child process groups.
export async function runVerification(command: string[] = []): Promise<VerificationResult> {
  if (process.platform === 'win32') throw new Error('verification sandbox requires Unix process groups')
  const root = resolve(import.meta.dirname, '..')
  const evidence = mkdtempSync(join(tmpdir(), 'vibevalley-verify-'))
  const home = join(evidence, 'home')
  const work = join(evidence, 'work')
  const binaries = join(evidence, 'bin')
  for (const path of [home, work, binaries]) mkdirSync(path)
  const env = isolatedEnvironment(home, work)
  const server = join(binaries, 'server')
  const cli = join(binaries, 'vv')
  const log = join(evidence, 'server.log')
  type Child = Pick<ReturnType<typeof Bun.spawn>, 'kill' | 'exited' | 'exitCode' | 'pid'>
  const owned = new Set<Child>()
  let child: Child | undefined
  let serverOutputDone: Promise<void> | undefined
  let outputFailure: unknown
  let interrupted = false
  let address = ''
  let code = 1
  const signal = (child: Child, signal: 'SIGTERM' | 'SIGKILL') => {
    try { process.kill(-child.pid, signal); return true }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
      throw error
    }
  }
  const alive = (child: Child) => {
    try { process.kill(-child.pid, 0); return true }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
      throw error
    }
  }
  const interrupt = () => {
    interrupted = true
    for (const child of owned) signal(child, 'SIGTERM')
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  const launch = (args: string[], cwd: string, name: string, environment = env): Child => {
    const child = Bun.spawn(args, { cwd, env: environment, detached: true, stdout: Bun.file(join(evidence, name + '.stdout.log')), stderr: Bun.file(join(evidence, name + '.stderr.log')) })
    owned.add(child)
    return child
  }
  const stop = async (child: Child) => {
    signal(child, 'SIGTERM')
    const deadline = Date.now() + 30_000
    while (alive(child) && Date.now() < deadline) await Bun.sleep(50)
    if (alive(child) && !signal(child, 'SIGKILL')) throw new Error(`cannot stop owned process group ${child.pid}`)
    await child.exited
    owned.delete(child)
  }
  try {
    const build = launch(['go', 'build', '-o', binaries + '/', './cmd/server', './cmd/vibevalley'], join(root, 'server'), 'build')
    const built = await build.exited
    await stop(build)
    if (built !== 0) throw new Error(`build failed; see ${join(evidence, 'build.stderr.log')}`)
    // go build names each command by its directory.
    const { renameSync } = await import('node:fs')
    renameSync(join(binaries, 'vibevalley'), cli)
    if (interrupted) throw new Error('verification interrupted before startup')
    const running = Bun.spawn([server, '--log', log, '--ready-json'], {
      cwd: root, env, detached: true, stdout: 'pipe', stderr: Bun.file(join(evidence, 'server.stderr.log')),
    })
    child = running
    owned.add(running)
    serverOutputDone = (async () => {
      const output = Bun.file(join(evidence, 'server.stdout.log')).writer()
      const decoder = new TextDecoder()
      let pending = ''
      try {
        for await (const chunk of running.stdout) {
          output.write(chunk)
          pending += decoder.decode(chunk, {stream: true})
          let end: number
          while ((end = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, end)
            pending = pending.slice(end + 1)
            const announced = readyAddress(line, running.pid)
            if (!address && announced) {
              address = announced
              writeFileSync(join(evidence, 'ready.json'), line + '\n')
            }
          }
        }
      } finally { await output.end() }
    })().catch(error => { outputFailure = error })
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (interrupted) throw new Error('verification interrupted during startup')
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}; see ${log}`)
      if (outputFailure) throw new Error(`server output failed: ${outputFailure}`)
      if (address) {
        try {
          const response = await fetch(address + '/api/v1/health', { signal: AbortSignal.timeout(1_000) })
          if (response.ok) {
            const health = await response.json()
            if (health.ok === true) { writeFileSync(join(evidence, 'health.json'), JSON.stringify(health, null, 2)); break }
          }
        } catch { /* Retry a transient health failure within the startup deadline. */ }
      }
      await Bun.sleep(100)
    }
    if (!address || !await Bun.file(join(evidence, 'health.json')).exists()) throw new Error(`server did not become healthy; see ${log}`)
    const run = command.length ? command : [cli, 'server', 'health']
    const task = launch(run, root, 'command', { ...env, VIBEVALLEY_SERVER: address, VIBEVALLEY_VERIFY_CLI: cli })
    code = await task.exited
    if (interrupted) code = 130
    return { code, evidence, address }
  } catch (error) {
    writeFileSync(join(evidence, 'failure.txt'), String(error))
    throw new Error(`${error}\nevidence: ${evidence}`)
  } finally {
    const failures: unknown[] = []
    for (const child of [...owned].reverse()) {
      try { await stop(child) } catch (error) { failures.push(error) }
    }
    await serverOutputDone
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    writeFileSync(join(evidence, 'result.json'), JSON.stringify({ code, address, stopped: failures.length === 0, command: command[0] ?? 'server health', cleanupErrors: failures.map(String) }, null, 2))
    if (failures.length === 0) for (const path of [home, work, binaries]) rmSync(path, { recursive: true, force: true })
    console.log(`verification evidence: ${evidence}`)
    if (failures.length) throw new AggregateError(failures, 'verification cleanup failed; temporary data preserved')
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === '--help') {
    console.log('usage: bun scripts/verify-server.ts [-- command args...]')
  } else {
    try { process.exitCode = (await runVerification(args[0] === '--' ? args.slice(1) : args)).code }
    catch (error) { console.error(String(error)); process.exitCode = 1 }
  }
}

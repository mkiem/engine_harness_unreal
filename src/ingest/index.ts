/**
 * Engine ingest: the deterministic pipeline stage between a DCC's export and the engine. It runs the checked-in import
 * script (dcc/unreal/import_pipeline.py) with fixed settings, so every mesh in the project is imported the same way, and
 * the script's own engine-side measurements are compared with the spec once more.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Violation } from '../core/model.ts'
import type { IngestRequest, IngestResult, Ingestor } from '../core/ports.ts'
import { runProcess } from '../executors/agent-cli.ts'

const objectPathOf = (request: IngestRequest) => `${request.plan.contentRoot}/${request.asset.id}`

/** Pretends to import; for dry runs and tests. */
export class SimulatedIngestor implements Ingestor {
  readonly pool: string
  constructor(pool = 'unreal') {
    this.pool = pool
  }
  async ingest(request: IngestRequest): Promise<IngestResult> {
    return { objectPath: objectPathOf(request), facts: { simulated: true }, violations: [] }
  }
}

export interface UnrealIngestorOptions {
  /** UnrealEditor-Cmd(.exe) */
  editorCmd: string
  uproject: string
  repoRoot: string
  pool?: string
  timeoutMinutes?: number
}

/**
 * Imports through a headless editor commandlet: `UnrealEditor-Cmd <uproject> -run=pythonscript -script=...`.
 * It needs the Python Editor Script Plugin enabled. A live editor holding the same project must not save the same packages
 * meanwhile, which is why ingest shares the Unreal workers' pool.
 */
export class UnrealCommandletIngestor implements Ingestor {
  readonly pool: string
  private readonly options: UnrealIngestorOptions
  constructor(options: UnrealIngestorOptions) {
    this.options = options
    this.pool = options.pool ?? 'unreal'
  }

  async ingest(request: IngestRequest): Promise<IngestResult> {
    const exportFile = request.asset.files.find(file => file.role === 'export')
    if (!exportFile && request.asset.kind !== 'audio_event') throw new Error(`${request.asset.id} has no export file to import`)
    const job = join(request.dir, `ingest.${request.asset.id}.json`)
    const out = join(request.dir, `ingest.${request.asset.id}.result.json`)
    writeFileSync(job, JSON.stringify({
      asset: request.asset.id, kind: request.asset.kind, spec: request.spec,
      file: exportFile && exportFile.role !== 'engine' ? resolve(request.dir, exportFile.path) : undefined,
      destination: request.plan.contentRoot, result: out,
    }, null, 2))
    const script = resolve(this.options.repoRoot, 'dcc/unreal/import_pipeline.py')
    // The job travels in the environment: quoting script arguments inside -script= differs between shells and platforms.
    const argv = [this.options.editorCmd, this.options.uproject, '-run=pythonscript', `-script=${script}`, '-unattended', '-nosplash', '-nullrhi', '-stdout']
    const controller = new AbortController()
    const run = await runProcess(argv, { cwd: request.dir, env: { ...process.env, HARNESS_INGEST_JOB: job }, signal: controller.signal, timeoutMs: (this.options.timeoutMinutes ?? 20) * 60_000 })
    writeFileSync(join(request.dir, `ingest.${request.asset.id}.log`), run.output)
    if (!existsSync(out)) throw new Error(`the import script wrote no result (exit ${run.code}); see ingest.${request.asset.id}.log`)
    const result = JSON.parse(readFileSync(out, 'utf8')) as { objectPath: string; facts?: Record<string, unknown>; violations?: Violation[] }
    return { objectPath: result.objectPath, facts: result.facts ?? {}, violations: result.violations ?? [] }
  }
}

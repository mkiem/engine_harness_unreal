/**
 * Structured observability (OpenTelemetry-compatible JSONL spans), token/cost accounting,
 * and plan-level budget enforcement for the orchestrator and MCP server.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

export interface UsageMetrics {
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}

export interface PlanBudget {
  maxTokens?: number
  maxCostUsd?: number
  maxWallMinutes?: number
}

export interface TraceSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  durationMs: number
  status: 'OK' | 'ERROR'
  attributes: Record<string, string | number | boolean>
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex')
const toNano = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`

export class TraceCollector {
  readonly traceId: string
  readonly spans: TraceSpan[] = []
  private readonly file?: string
  private readonly otlpEndpoint?: string

  constructor(options: { file?: string; traceId?: string; otlpEndpoint?: string } = {}) {
    this.traceId = options.traceId ?? hex(16)
    this.file = options.file
    this.otlpEndpoint = options.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  }

  startSpan(name: string, attributes: Record<string, string | number | boolean> = {}, parentSpanId?: string) {
    const spanId = hex(8)
    const startMs = Date.now()
    return {
      spanId,
      end: (status: 'OK' | 'ERROR' = 'OK', extra: Record<string, string | number | boolean> = {}): TraceSpan => {
        const endMs = Date.now()
        const span: TraceSpan = {
          traceId: this.traceId,
          spanId,
          ...(parentSpanId ? { parentSpanId } : {}),
          name,
          startTimeUnixNano: toNano(startMs),
          endTimeUnixNano: toNano(endMs),
          durationMs: Math.max(0, endMs - startMs),
          status,
          attributes: { ...attributes, ...extra },
        }
        this.spans.push(span)
        if (this.file) {
          mkdirSync(dirname(this.file), { recursive: true })
          appendFileSync(this.file, `${JSON.stringify(span)}\n`)
        }
        if (this.otlpEndpoint) this.exportOtlp(span)
        return span
      },
    }
  }

  private exportOtlp(span: TraceSpan): void {
    const url = `${this.otlpEndpoint!.replace(/\/$/, '')}/v1/traces`
    const body = {
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'engine-harness' } }] },
        scopeSpans: [{
          scope: { name: 'engine-harness' },
          spans: [{
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            name: span.name,
            startTimeUnixNano: span.startTimeUnixNano,
            endTimeUnixNano: span.endTimeUnixNano,
            status: { code: span.status === 'OK' ? 1 : 2 },
            attributes: Object.entries(span.attributes).map(([key, value]) => ({
              key,
              value: typeof value === 'boolean' ? { boolValue: value }
                : typeof value === 'number' ? { doubleValue: value }
                  : { stringValue: value },
            })),
          }],
        }],
      }],
    }
    void fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => { /* best-effort telemetry */ })
  }
}

export class BudgetTracker {
  private readonly budget: PlanBudget
  private readonly startedAtMs: number
  inputTokens = 0
  outputTokens = 0
  costUsd = 0

  constructor(budget: PlanBudget = {}, startedAtMs = Date.now()) {
    this.budget = budget
    this.startedAtMs = startedAtMs
  }

  record(usage?: UsageMetrics): void {
    if (!usage) return
    this.inputTokens += usage.inputTokens ?? 0
    this.outputTokens += usage.outputTokens ?? 0
    this.costUsd += usage.costUsd ?? 0
  }

  get totalTokens(): number { return this.inputTokens + this.outputTokens }

  exceeded(nowMs = Date.now()): string | undefined {
    if (this.budget.maxTokens !== undefined && this.totalTokens > this.budget.maxTokens)
      return `token budget exceeded (${this.totalTokens} > ${this.budget.maxTokens})`
    if (this.budget.maxCostUsd !== undefined && this.costUsd > this.budget.maxCostUsd)
      return `cost budget exceeded ($${this.costUsd.toFixed(4)} > $${this.budget.maxCostUsd.toFixed(4)})`
    if (this.budget.maxWallMinutes !== undefined && (nowMs - this.startedAtMs) / 60_000 > this.budget.maxWallMinutes)
      return `wall-time budget exceeded (${((nowMs - this.startedAtMs) / 60_000).toFixed(1)}m > ${this.budget.maxWallMinutes}m)`
    return undefined
  }
}


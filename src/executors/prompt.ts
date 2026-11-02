/**
 * Renders a worker's prompt: the shared worker rules, the domain prompt from its preset, then the ticket itself.
 * Following dsh-superagent's Inline & Spill: specs, inputs and feedback are inlined because the worker needs them at once;
 * input files are referenced by path, never pasted.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Job } from '../core/ports.ts'
import type { Preset } from '../presets/index.ts'

export const RESULT_FILE = 'result.json'

export function renderWorkerPrompt(job: Job, preset: Preset, repoRoot: string): string {
  const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8').trim()
  const section = (title: string, body: string) => `## ${title}\n\n${body.trim()}\n`
  const json = (value: unknown) => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
  const parts = [
    read('prompts/worker.md'),
    read(preset.prompt),
    section('Ticket', [
      `Plan: ${job.plan.id}. Ticket: ${job.ticket.id} (${job.ticket.domain}), assignment ${job.assignmentId}, revision ${job.revision}.`,
      `Engine content root: ${job.plan.contentRoot}.`,
      `Your directory: ${job.dir}`,
      '',
      `**${job.ticket.title}**`,
      '',
      job.ticket.instructions,
      '',
      `The brief this ticket is part of, for context only: ${job.plan.brief}`,
    ].join('\n')),
    section('Assets you must deliver', `Deliver exactly these, each meeting every requirement. The harness measures them; it does not take your word.\n\n${json(job.ticket.produces)}`),
  ]
  if (job.inputs.length) parts.push(section('Inputs', `These assets passed their contracts. Use them as they are; never edit another ticket's files.\n\n${json(job.inputs)}`))
  if (job.feedback.length) {
    parts.push(section('Contract violations to fix', `The previous revision was rejected. Fix each of these, then report ready again:\n\n${job.feedback.map(v => `- \`${v.rule}\` ${v.asset}: ${v.message}`).join('\n')}`))
  }
  if (job.notes.length) parts.push(section('Notes from people and the host', job.notes.map(note => `- ${note}`).join('\n')))
  if (preset.blockedCommands.length) parts.push(section('Commands you may not run', preset.blockedCommands.map(command => `- \`${command}\``).join('\n')))
  parts.push(section('Report', [
    `End by writing \`${RESULT_FILE}\` in your directory, as JSON matching this shape, and nothing else:`,
    json({
      status: 'ready | blocked | failed | dropped',
      summary: 'one or two sentences: what you made, and anything a person should know',
      question: '(optional) one concrete question for a person, only if you cannot continue without the answer',
      assets: [{ id: '<asset id from the list above>', kind: '<its kind>', files: [{ path: 'relative/path', role: 'export | source | recipe | preview | report | engine' }], facts: { '...': 'copied from the inspection script output, never estimated' }, provenance: { method: 'procedural | generative | library | manual', tool: '...', license: '...', recipe: 'path to the script that rebuilds it' } }],
    }),
  ].join('\n')))
  return parts.join('\n')
}

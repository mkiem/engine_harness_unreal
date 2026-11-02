#!/usr/bin/env node
/**
 * Starts the harness MCP server on stdio. Configure it in goose (or any MCP client) as:
 *
 *   command: node   args: [<harness>/src/mcp/main.ts]   env: HARNESS_PROJECT_DIR=<game project>
 *
 * HARNESS_LOCK_MIRROR=perforce|git-lfs also takes each lock in version control, from HARNESS_LOCK_CWD (default: the project).
 */
import { join, resolve } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { FileLockBackend, GitLfsLockBackend, PerforceLockBackend } from '../locks/index.ts'
import { createHarnessServer } from './server.ts'

const projectDir = resolve(process.env.HARNESS_PROJECT_DIR ?? process.cwd())
const cwd = process.env.HARNESS_LOCK_CWD ?? projectDir
const mirror = process.env.HARNESS_LOCK_MIRROR === 'perforce' ? new PerforceLockBackend({ cwd })
  : process.env.HARNESS_LOCK_MIRROR === 'git-lfs' ? new GitLfsLockBackend({ cwd }) : undefined
const locks = new FileLockBackend(join(projectDir, '.harness', 'locks.json'), mirror)

await createHarnessServer({ projectDir, locks }).connect(new StdioServerTransport())

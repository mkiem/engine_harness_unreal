#!/usr/bin/env node
/**
 * Starts the harness MCP server on stdio (default) or Streamable HTTP (--http <port> / HARNESS_MCP_HTTP_PORT).
 * Configure it in goose (or any MCP client) as:
 *
 *   command: node   args: [<harness>/src/mcp/main.ts]   env: HARNESS_PROJECT_DIR=<game project>
 *
 * Environment options:
 *   HARNESS_LOCK_MIRROR=perforce|git-lfs   mirror locks into version control
 *   HARNESS_LOCK_BACKEND=sqlite|file       lock store implementation (default: file)
 *   HARNESS_TOOLSETS=pipeline,studio,godot restrict registered toolsets to cut token overhead
 *   HARNESS_DYNAMIC_TOOLSETS=1             enable progressive toolset loading via harness_toolsets
 *   HARNESS_MCP_HTTP_PORT=3100             serve Streamable HTTP at http://127.0.0.1:<port>/mcp
 */
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { FileLockBackend, GitLfsLockBackend, PerforceLockBackend, SqliteLockBackend } from '../locks/index.ts'
import { createHarnessServer } from './server.ts'

const projectDir = resolve(process.env.HARNESS_PROJECT_DIR ?? process.cwd())
const cwd = process.env.HARNESS_LOCK_CWD ?? projectDir
const mirror = process.env.HARNESS_LOCK_MIRROR === 'perforce' ? new PerforceLockBackend({ cwd })
  : process.env.HARNESS_LOCK_MIRROR === 'git-lfs' ? new GitLfsLockBackend({ cwd }) : undefined
const locks = process.env.HARNESS_LOCK_BACKEND === 'sqlite'
  ? new SqliteLockBackend(join(projectDir, '.harness', 'locks.db'), mirror)
  : new FileLockBackend(join(projectDir, '.harness', 'locks.json'), mirror)

const httpArgIdx = process.argv.indexOf('--http')
const httpPort = httpArgIdx >= 0 ? Number(process.argv[httpArgIdx + 1]) : process.env.HARNESS_MCP_HTTP_PORT ? Number(process.env.HARNESS_MCP_HTTP_PORT) : undefined

if (httpPort && Number.isFinite(httpPort)) {
  const host = process.env.HARNESS_MCP_HTTP_HOST ?? '127.0.0.1'
  const httpServer = createServer(async (req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found; send MCP requests to /mcp' }))
      return
    }
    const server = createHarnessServer({ projectDir, locks })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { void transport.close(); void server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  })
  httpServer.listen(httpPort, host, () => {
    console.error(`engine-harness MCP listening on http://${host}:${httpPort}/mcp`)
  })
} else {
  await createHarnessServer({ projectDir, locks }).connect(new StdioServerTransport())
}

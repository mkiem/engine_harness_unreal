// Builds the payload the studio app ships in its resources (dist/payload):
//   harness-mcp.mjs   the harness MCP server and every dependency in one ES module, run by the app's own runtime
//   dcc/              the Blender, Unreal, Wwise and audio scripts the agent runs
//   recipes/          the game-dev recipes
//   templates/        game templates the studio starts projects from (godot-rpg)
//   skills/           the game studio's agent skills (SKILL.md each), installed by the app where the agent finds them
//   NOTICE.md         licences of what is bundled
// Usage: node scripts/bundle.mjs
import { build } from 'esbuild'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist', 'payload')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

await build({
  entryPoints: [join(root, 'src/mcp/main.ts')],
  outfile: join(out, 'harness-mcp.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'external',
  // Some dependencies are CommonJS and call require(); give the ES module a require of its own.
  banner: { js: "import { createRequire as __harnessRequire } from 'node:module'; const require = __harnessRequire(import.meta.url);" },
  logLevel: 'warning',
})

cpSync(join(root, 'dcc'), join(out, 'dcc'), { recursive: true, filter: path => !/__pycache__|\.pyc$|[\\/]tests([\\/]|$)/.test(path) })
cpSync(join(root, 'distro', 'recipes'), join(out, 'recipes'), { recursive: true })
cpSync(join(root, 'templates'), join(out, 'templates'), { recursive: true, filter: path => !/[\\/]\.godot([\\/]|$)|[\\/]builds([\\/]|$)/.test(path) })
cpSync(join(root, 'skills'), join(out, 'skills'), { recursive: true })

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const licence = name => {
  try { return JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).license } catch { return 'see package' }
}
const deps = Object.keys(pkg.dependencies).sort()
writeFileSync(join(out, 'NOTICE.md'), [
  `# Engine Harness payload ${pkg.version}`,
  '',
  'Bundled into harness-mcp.mjs (each under its own licence; transitive licence texts are in harness-mcp.mjs.LEGAL.txt):',
  ...deps.map(name => `- ${name}: ${licence(name)}`),
  '',
].join('\n'))
writeFileSync(join(out, 'version.json'), JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString() }, null, 2))
console.log(`payload ready: ${out}`)

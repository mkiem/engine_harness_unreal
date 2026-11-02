/**
 * Reads Godot 4 text scenes (.tscn) without Godot: the scene format is plain text sections ([gd_scene], [ext_resource],
 * [sub_resource], [node], [connection]) with key = value lines. The harness answers scene questions from the file in a
 * few dozen tokens, instead of a tool round trip per node.
 */

export interface TscnResource { id: string; type: string; path?: string; uid?: string }
export interface TscnNode {
  name: string
  type?: string
  /** Path of the parent relative to the root: '.' for the root's children, undefined for the root. */
  parent?: string
  /** An instanced scene, as the ext_resource id it refers to. */
  instance?: string
  properties: Record<string, string>
}
export interface TscnScene {
  format?: number
  uid?: string
  extResources: TscnResource[]
  subResources: TscnResource[]
  nodes: TscnNode[]
  connections: { signal: string; from: string; to: string; method: string }[]
}

const HEADER = /^\[(\w+)((?:\s+\w+=(?:"(?:[^"\\]|\\.)*"|[^\s\]]+))*)\s*\]$/
const ATTR = /(\w+)=("(?:[^"\\]|\\.)*"|[^\s\]]+)/g

const unquote = (value: string) => value.startsWith('"') ? value.slice(1, -1).replace(/\\"/g, '"') : value

export function parseTscn(text: string): TscnScene {
  const scene: TscnScene = { extResources: [], subResources: [], nodes: [], connections: [] }
  let current: { properties: Record<string, string> } | undefined
  let pendingKey: string | undefined
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (pendingKey && current) {
      // A value that spans lines (arrays, dictionaries, multi-line strings) continues until its brackets close.
      current.properties[pendingKey] += `\n${line}`
      if (balanced(current.properties[pendingKey]!)) pendingKey = undefined
      continue
    }
    if (!line || line.startsWith(';')) continue
    const header = HEADER.exec(line)
    if (header) {
      const attrs: Record<string, string> = {}
      for (const match of header[2]!.matchAll(ATTR)) attrs[match[1]!] = unquote(match[2]!)
      const kind = header[1]!
      current = undefined
      if (kind === 'gd_scene') {
        scene.format = attrs.format ? Number(attrs.format) : undefined
        scene.uid = attrs.uid
      } else if (kind === 'ext_resource') {
        scene.extResources.push({ id: attrs.id ?? '', type: attrs.type ?? '', path: attrs.path, uid: attrs.uid })
      } else if (kind === 'sub_resource') {
        const resource = { id: attrs.id ?? '', type: attrs.type ?? '', properties: {} as Record<string, string> }
        scene.subResources.push(resource)
        current = resource
      } else if (kind === 'node') {
        const instance = /ExtResource\(\s*"?([^")]+)"?\s*\)/.exec(attrs.instance ?? '')?.[1]
        const node: TscnNode = { name: attrs.name ?? '', type: attrs.type, parent: attrs.parent, instance, properties: {} }
        scene.nodes.push(node)
        current = node
      } else if (kind === 'connection') {
        scene.connections.push({ signal: attrs.signal ?? '', from: attrs.from ?? '', to: attrs.to ?? '', method: attrs.method ?? '' })
      }
      continue
    }
    const property = /^([\w/:.]+)\s*=\s*(.*)$/.exec(line)
    if (property && current) {
      current.properties[property[1]!] = property[2]!
      if (!balanced(property[2]!)) pendingKey = property[1]
    }
  }
  return scene
}

function balanced(value: string): boolean {
  let depth = 0
  let inString = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '[' || ch === '{' || ch === '(') depth++
    else if (ch === ']' || ch === '}' || ch === ')') depth--
  }
  return depth <= 0 && !inString
}

/** The node's path from the root, as Godot writes `parent`: '.' for the root itself. */
export function nodePath(node: TscnNode): string {
  if (node.parent === undefined) return '.'
  return node.parent === '.' ? node.name : `${node.parent}/${node.name}`
}

/**
 * A compact tree: one line per node, `Name (Type) [script.gd]`, indented by depth. The point is tokens: a 30-node scene
 * reads in a few hundred tokens with no tool round trips.
 */
export function sceneTree(scene: TscnScene): string {
  const lines: string[] = []
  const script = (node: TscnNode) => {
    const id = /ExtResource\(\s*"?([^")]+)"?\s*\)/.exec(node.properties.script ?? '')?.[1]
    const path = scene.extResources.find(resource => resource.id === id)?.path
    return path ? ` [${path.replace(/^res:\/\//, '')}]` : ''
  }
  for (const node of scene.nodes) {
    const depth = node.parent === undefined ? 0 : node.parent === '.' ? 1 : node.parent.split('/').length + 1
    const instance = node.instance ? scene.extResources.find(resource => resource.id === node.instance)?.path : undefined
    const type = node.type ?? (instance ? `instance of ${instance.replace(/^res:\/\//, '')}` : '?')
    lines.push(`${'  '.repeat(depth)}${node.name} (${type})${script(node)}`)
  }
  const rootName = scene.nodes.find(node => node.parent === undefined)?.name ?? '.'
  const named = (path: string) => (path === '.' ? rootName : path)
  for (const connection of scene.connections) lines.push(`signal ${named(connection.from)}.${connection.signal} → ${named(connection.to)}.${connection.method}`)
  return lines.join('\n')
}

export function findNode(scene: TscnScene, path: string): TscnNode | undefined {
  const wanted = path.replace(/^\.\//, '').replace(/^\/+/, '')
  return scene.nodes.find(node => nodePath(node) === wanted || (wanted === '.' && node.parent === undefined) || (node.parent === undefined && node.name === wanted))
}

/** res:// paths of every external resource, for checking they exist. */
export function resourcePaths(scene: TscnScene): string[] {
  return scene.extResources.map(resource => resource.path).filter((path): path is string => !!path)
}

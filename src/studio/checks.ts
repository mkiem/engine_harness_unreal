/**
 * The game's data checked as a whole, in plain words a beginner can act on: every reference between the files (a
 * skill a character knows, an item a shop sells, an enemy an event fights), every value the game understands (a
 * skill's type, an item's effect, an equipment slot, a status), maps that are drawn right, warps that do not bounce,
 * story flags that something waits for but nothing sets, and event commands. Mirrors tools/self_test.gd and
 * scripts/world/event_check.gd in the template, so the answer is the same with or without Godot.
 */
import type { ProjectData } from './project.ts'

export const EQUIP_SLOTS = ['weapon', 'armor', 'accessory']
export const SKILL_TYPES = ['physical', 'magic', 'heal', 'support']
export const ITEM_EFFECTS = ['heal', 'mp', 'revive', 'cure', 'damage', 'buff']
export const SCOPES = ['enemy', 'all_enemies', 'ally', 'all_allies', 'self', 'ko_ally']
export const EVENT_COMMANDS = ['say', 'choice', 'if', 'set', 'unset', 'give', 'take', 'gold', 'join', 'leave', 'heal', 'quest', 'move',
  'face', 'hide', 'show', 'wait', 'music', 'sound', 'shop', 'inn', 'battle', 'warp', 'ending', 'event', 'end']
export const CONDITIONS = ['flag', 'not_flag', 'item', 'count', 'gold', 'member', 'quest', 'stage', 'not_stage']
export const AI_CONDITIONS = ['hp_below', 'hp_above', 'turn_every', 'turn_at_least', 'ally_hurt', 'ally_down', 'target_without', 'self_without']
export const MAX_LINE = 90
export const NPC_ROLES = ['inn', 'shop', 'chest', 'battle', 'waystone']
const STATS = ['hp', 'mp', 'atk', 'def', 'mag', 'spd']

type Rows = (map: string) => string[]
type Exists = (path: string) => boolean

export function commandName(command: Record<string, unknown>): string {
  return EVENT_COMMANDS.find(name => name in command) ?? ''
}

/** Every battle an event can start, with where it is, for the simulator and the checks. */
export function eventBattles(events: Record<string, any>): { event: string; enemies: string[]; ending: boolean }[] {
  const out: { event: string; enemies: string[]; ending: boolean }[] = []
  const walk = (event: string, commands: unknown) => {
    if (!Array.isArray(commands)) return
    for (const c of commands) {
      if (!c || typeof c !== 'object') continue
      if (Array.isArray(c.battle)) out.push({ event, enemies: c.battle, ending: !!c.ending })
      for (const key of ['then', 'else', 'lose']) walk(event, c[key])
      for (const option of c.options ?? []) walk(event, option?.then)
    }
  }
  for (const [id, commands] of Object.entries(events)) walk(id, commands)
  return out
}

/** Every command of every event, flattened, with its event id. */
function eventCommands(events: Record<string, any>): { event: string; command: Record<string, any> }[] {
  const out: { event: string; command: Record<string, any> }[] = []
  const walk = (event: string, commands: unknown) => {
    if (!Array.isArray(commands)) return
    for (const c of commands) {
      if (!c || typeof c !== 'object') continue
      out.push({ event, command: c })
      for (const key of ['then', 'else', 'lose']) walk(event, c[key])
      for (const option of c.options ?? []) walk(event, option?.then)
    }
  }
  for (const [id, commands] of Object.entries(events)) walk(id, commands)
  return out
}

export function checkData(d: ProjectData, rows: Rows, exists: Exists, read: (path: string) => string | undefined = () => undefined): string[] {
  const problems: string[] = []
  // A game can teach its code new kinds of things; the checks accept what it declares.
  const extra = (key: string): string[] => Array.isArray(d.rules[key]) ? d.rules[key].map(String) : []
  const SKILL_TYPES_ = [...SKILL_TYPES, ...extra('extra_skill_types')]
  const ITEM_EFFECTS_ = [...ITEM_EFFECTS, ...extra('extra_item_effects')]
  const AI_CONDITIONS_ = [...AI_CONDITIONS, ...extra('extra_ai_conditions')]
  const NPC_ROLES_ = [...NPC_ROLES, ...extra('extra_npc_roles')]
  const runner = read('scripts/world/event_runner.gd')
  const declared = runner ? /const COMMANDS := \[([^\]]*)\]/s.exec(runner)?.[1]?.match(/"([a-z_]+)"/g)?.map(x => x.slice(1, -1)) : undefined
  const COMMANDS_ = declared?.length ? declared : EVENT_COMMANDS
  const nameOf = (command: Record<string, unknown>) => COMMANDS_.find(name => name in command) ?? ''
  const has = (table: Record<string, any> | undefined, id: unknown) => !!table && typeof id === 'string' && Object.prototype.hasOwnProperty.call(table, id)
  const elements: string[] = Array.isArray(d.rules.elements) ? d.rules.elements : []
  const element = (where: string, value: unknown) => {
    if (value && elements.length && !elements.includes(String(value))) problems.push(`${where} uses element ${value}; the elements in rules.json are ${elements.join(', ')}`)
  }
  const statusRef = (where: string, id: unknown) => {
    if (id && !has(d.statuses, id)) problems.push(`${where} names status ${id}, which is not in statuses.json`)
  }

  // Characters and the party
  for (const id of d.party.members ?? []) if (!has(d.characters, id)) problems.push(`party.json starts with ${id}, which is not in characters.json`)
  for (const [id, c] of Object.entries(d.characters)) {
    for (const skill of [...(c.skills ?? []), ...Object.values(c.learns ?? {})] as string[]) if (!has(d.skills, skill)) problems.push(`character ${id} knows skill ${skill}, which is not in skills.json`)
    for (const stat of STATS) if (typeof c.base?.[stat] !== 'number') problems.push(`character ${id} has no base ${stat}`)
    for (const [slot, item] of Object.entries(c.equipment ?? {})) {
      if (!EQUIP_SLOTS.includes(slot)) problems.push(`character ${id} has equipment slot ${slot}; slots are ${EQUIP_SLOTS.join(', ')}`)
      else if (d.items[item as string]?.slot !== slot) problems.push(`character ${id} starts with ${item} as their ${slot}, which is not a ${slot} in items.json`)
      else if (d.items[item as string].users?.length && !d.items[item as string].users.includes(id)) problems.push(`character ${id} starts with ${item}, which only ${d.items[item as string].users.join(', ')} can use`)
    }
  }
  for (const item of Object.keys(d.party.items ?? {})) if (!has(d.items, item)) problems.push(`party.json starts with item ${item}, which is not in items.json`)

  // Skills, items, statuses
  for (const [id, skill] of Object.entries(d.skills)) {
    if (!SKILL_TYPES_.includes(skill.type)) problems.push(`skill ${id} has type ${skill.type}; skill types are ${SKILL_TYPES_.join(', ')}`)
    if (skill.target && !SCOPES.includes(skill.target)) problems.push(`skill ${id} targets ${skill.target}; targets are ${SCOPES.join(', ')}`)
    element(`skill ${id}`, skill.element)
    statusRef(`skill ${id}`, skill.status?.id)
    for (const status of skill.cures ?? []) statusRef(`skill ${id}`, status)
    if (skill.type === 'support' && !skill.status && !skill.cures?.length) problems.push(`skill ${id} is a support skill but neither gives a status nor cures one`)
    if (skill.charge !== undefined && (!Number.isInteger(skill.charge) || skill.charge < 0)) problems.push(`skill ${id} has charge ${skill.charge}; use the number of turns it gathers power, such as 1`)
  }
  for (const [id, item] of Object.entries(d.items)) {
    if (item.slot !== undefined) {
      if (!EQUIP_SLOTS.includes(item.slot)) problems.push(`item ${id} has slot ${item.slot}; slots are ${EQUIP_SLOTS.join(', ')}`)
      for (const user of item.users ?? []) if (!has(d.characters, user)) problems.push(`item ${id} can be used by ${user}, who is not in characters.json`)
      for (const stat of Object.keys(item.stats ?? {})) if (!STATS.includes(stat)) problems.push(`item ${id} changes ${stat}; stats are ${STATS.join(', ')}`)
      element(`item ${id}`, item.element)
      for (const e of item.resist ?? []) element(`item ${id}`, e)
      for (const status of item.immune ?? []) statusRef(`item ${id}`, status)
      statusRef(`item ${id}`, item.status?.id)
    } else if (item.kind === 'key') {
      // Key items only matter to events.
    } else {
      if (!ITEM_EFFECTS_.includes(item.effect)) problems.push(`item ${id} has effect ${item.effect}; effects are ${ITEM_EFFECTS_.join(', ')} (equipment has a "slot", key items "kind": "key")`)
      if (item.target && !SCOPES.includes(item.target)) problems.push(`item ${id} targets ${item.target}; targets are ${SCOPES.join(', ')}`)
      for (const status of item.cures ?? []) statusRef(`item ${id}`, status)
      statusRef(`item ${id}`, item.status?.id)
      element(`item ${id}`, item.element)
    }
  }
  for (const [id, status] of Object.entries(d.statuses)) {
    for (const stat of Object.keys(status.stats ?? {})) if (!STATS.includes(stat)) problems.push(`status ${id} changes ${stat}; stats are ${STATS.join(', ')}`)
    for (const other of status.cancels ?? []) statusRef(`status ${id}`, other)
  }

  // Enemies and encounters
  for (const [id, e] of Object.entries(d.enemies)) {
    for (const skill of e.skills ?? []) if (!has(d.skills, skill)) problems.push(`enemy ${id} uses skill ${skill}, which is not in skills.json`)
    for (const drop of [...(e.drops ?? []), ...(e.drop ? [e.drop] : [])]) if (drop?.item && !has(d.items, drop.item)) problems.push(`enemy ${id} drops ${drop.item}, which is not in items.json`)
    for (const stat of ['hp', 'atk', 'def', 'spd']) if (typeof e.stats?.[stat] !== 'number') problems.push(`enemy ${id} has no ${stat}`)
    for (const list of ['weak', 'resist', 'absorb']) for (const el of e[list] ?? []) element(`enemy ${id}`, el)
    element(`enemy ${id}`, e.element)
    for (const status of [...(e.immune ?? []), ...(e.statuses ?? [])]) statusRef(`enemy ${id}`, status)
    const frames = Number(d.game.enemy_frames ?? 0)
    if (frames && (typeof e.frame !== 'number' || e.frame < 0 || e.frame >= frames)) problems.push(`enemy ${id} uses picture ${e.frame} but art/enemies.png has frames 0 to ${frames - 1} (enemy_frames in game.json)`)
    const rules = [...(e.ai ?? []), ...(e.phases ?? []).flatMap((p: any) => p.ai ?? [])]
    for (const rule of rules) {
      const skill = rule.skill ?? 'attack'
      if (!['attack', 'defend'].includes(skill) && !has(d.skills, skill)) problems.push(`enemy ${id}'s AI uses ${skill}, which is not in skills.json`)
      for (const key of Object.keys(rule.if ?? {})) if (!AI_CONDITIONS_.includes(key)) problems.push(`enemy ${id}'s AI has condition ${key}; conditions are ${AI_CONDITIONS_.join(', ')}`)
    }
    if (rules.length && !rules.some((r: any) => !r.if && (r.chance ?? 1) >= 1)) problems.push(`enemy ${id}'s AI has no rule that always applies; end it with {"skill": "attack"} so it never stands still`)
    if (e.shield !== undefined && (!Number.isInteger(e.shield) || e.shield < 0)) problems.push(`enemy ${id} has shield ${e.shield}; use a whole number of weakness or critical hits that break it, such as 3`)
    if (e.shield && !(e.weak?.length) && !Object.values(d.skills).some((s: any) => s.breaks)) problems.push(`enemy ${id} has a break shield but no weakness, and no skill breaks shields: only critical hits can break it`)
    for (const phase of e.phases ?? []) if (typeof phase.below !== 'number' || phase.below <= 0 || phase.below >= 1) problems.push(`enemy ${id} has a phase with "below" ${phase.below}; use a fraction of HP between 0 and 1, such as 0.5`)
  }
  for (const [zone, info] of Object.entries(d.encounters)) for (const group of info.groups ?? []) for (const enemy of group) if (!has(d.enemies, enemy)) problems.push(`encounter zone ${zone} has enemy ${enemy}, which is not in enemies.json`)
  for (const name of ['physical', 'magic', 'heal', 'xp_to_next', 'run_chance']) if (typeof d.formulas[name] !== 'string') problems.push(`formulas.json has no ${name} formula`)

  // Quests
  for (const [id, quest] of Object.entries(d.quests)) if (!quest.stages || !('start' in quest.stages)) problems.push(`quest ${id} needs a "start" stage (and a "done" stage when it can be finished)`)

  // Maps
  const solid = (r: string[], x: number, y: number) => y < 0 || y >= r.length || x < 0 || x >= (r[y]?.length ?? 0) || !!d.legend[r[y]![x]!]?.solid
  if (!has(d.maps, d.party.map)) problems.push(`party.json starts on map ${d.party.map}, which is not in maps.json`)
  else if (solid(rows(d.party.map), d.party.position?.[0], d.party.position?.[1])) problems.push('the party starts on a solid tile')
  const setFlags = new Set<string>()
  const wanted: [string, string][] = []
  const checkEventRef = (where: string, id: unknown) => { if (id && !has(d.events, id)) problems.push(`${where} runs event ${id}, which is not in events.json`) }
  for (const [id, info] of Object.entries(d.maps)) {
    const r = rows(id)
    if (!r.length) { problems.push(`map ${id} has no file maps/${info.file ?? `${id}.txt`}`); continue }
    const unknown = new Set<string>()
    r.forEach(row => [...row].forEach(ch => { if (!has(d.legend, ch)) unknown.add(ch) }))
    for (const ch of unknown) problems.push(`map ${id} uses '${ch}', which is not in legend.json`)
    const widths = new Set(r.map(row => [...row].length))
    if (widths.size > 1) problems.push(`map ${id} has rows of different lengths (${[...widths].join(', ')}); every row needs the same number of characters`)
    if (info.encounters && !has(d.encounters, info.encounters)) problems.push(`map ${id} uses encounter zone ${info.encounters}, which is not in encounters.json`)
    if (typeof info.music === 'string' && info.music.startsWith('res://') && !exists(info.music.slice(6))) problems.push(`map ${id} plays ${info.music}, which does not exist`)
    if (typeof info.battle_background === 'string' && info.battle_background.startsWith('res://') && !exists(info.battle_background.slice(6))) problems.push(`map ${id}'s battle background ${info.battle_background} does not exist`)
    for (const entry of [...(info.on_enter ?? []), ...(info.triggers ?? [])]) {
      checkEventRef(`map ${id}`, entry.event)
      if (entry.if) for (const [flag, kind] of [[entry.if.flag, 'flag'], [entry.if.not_flag, 'flag']] as const) if (flag) wanted.push([flag, `map ${id}'s ${kind} check`])
    }
    for (const t of info.triggers ?? []) if (solid(r, t.x, t.y)) problems.push(`a trigger on ${id} at ${t.x},${t.y} is on a solid tile, so it can never be stepped on`)
    const npcFrames = Number(d.game.npc_frames ?? 0)
    for (const npc of info.npcs ?? []) {
      const who = `NPC ${npc.id} on ${id}`
      if (npc.event) checkEventRef(who, npc.event)
      else if (npc.role !== 'chest' && npc.role !== 'waystone' && !has(d.dialogue, npc.dialogue ?? '')) problems.push(`${who} says ${npc.dialogue}, which is not in dialogue.json (or give them an "event")`)
      if (npc.role && !NPC_ROLES_.includes(npc.role)) problems.push(`${who} has role ${npc.role}; roles are ${NPC_ROLES_.join(', ')}`)
      if (npc.role === 'waystone' && Array.isArray(npc.arrive) && solid(r, npc.arrive[0], npc.arrive[1])) problems.push(`waystone ${npc.id} on ${id} sends travellers to ${npc.arrive.join(',')}, a solid tile`)
      if (npc.role === 'waystone' && !Array.isArray(npc.arrive) && solid(r, npc.x, npc.y + 1)) problems.push(`waystone ${npc.id} on ${id} has a solid tile below it; give it "arrive": [x, y] for where travellers appear`)
      if (solid(r, npc.x, npc.y)) problems.push(`${who} stands on a solid tile at ${npc.x},${npc.y}`)
      if (npcFrames && (npc.frame ?? 0) >= npcFrames) problems.push(`${who} uses picture ${npc.frame} but art/npcs.png has frames 0 to ${npcFrames - 1} (npc_frames in game.json)`)
      for (const item of npc.stock ?? []) if (!has(d.items, item)) problems.push(`shop ${npc.id} on ${id} sells ${item}, which is not in items.json`)
      if (npc.role === 'battle') {
        if (!npc.enemies?.length) problems.push(`${who} starts a battle but lists no enemies`)
        for (const enemy of npc.enemies ?? []) if (!has(d.enemies, enemy)) problems.push(`${who} fights ${enemy}, which is not in enemies.json`)
        if (npc.ending && !has(d.dialogue, 'ending')) problems.push(`${who} ends the game, but dialogue.json has no "ending" lines`)
        setFlags.add(npc.flag ?? `beat_${npc.id}`)
      }
      if (npc.role === 'chest') {
        if (npc.item && !has(d.items, npc.item)) problems.push(`chest ${npc.id} on ${id} holds ${npc.item}, which is not in items.json`)
        if (!npc.item && !npc.gold) problems.push(`chest ${npc.id} on ${id} holds nothing; give it an item or gold`)
        setFlags.add(npc.flag ?? `chest_${id}_${npc.id}`)
      }
      for (const key of [npc.after, ...Object.values(npc.dialogue_after ?? {})]) if (key && !has(d.dialogue, key)) problems.push(`${who} uses dialogue ${key}, which is not in dialogue.json`)
      if (npc.sets) setFlags.add(npc.sets)
      for (const flag of [npc.only_if, npc.hide_if, ...Object.keys(npc.dialogue_after ?? {})]) if (flag) wanted.push([flag, who])
    }
    for (const warp of info.warps ?? []) {
      if (warp.locked && !has(d.dialogue, warp.locked)) problems.push(`a warp on ${id} says ${warp.locked} when shut, which is not in dialogue.json`)
      if (!has(d.maps, warp.to)) problems.push(`a warp on ${id} leads to map ${warp.to}, which is not in maps.json`)
      else if (solid(rows(warp.to), warp.to_x, warp.to_y)) problems.push(`a warp on ${id} lands on a solid tile of ${warp.to}`)
      else if ((d.maps[warp.to].warps ?? []).some((w: any) => w.x === warp.to_x && w.y === warp.to_y)) problems.push(`a warp on ${id} lands on another warp in ${warp.to} at ${warp.to_x},${warp.to_y}, so the player would bounce; land one step away from it`)
      if (warp.requires) wanted.push([warp.requires, `a warp on ${id}`])
    }
  }

  // Events
  for (const { event, command } of eventCommands(d.events)) {
    const name = nameOf(command)
    const at = `event ${event}`
    if (!name) { problems.push(`${at} has a command (${Object.keys(command).join(', ')}) that is not known; commands are ${COMMANDS_.join(', ')}`); continue }
    switch (name) {
      case 'say':
        for (const line of Array.isArray(command.say) ? command.say : [command.say]) if (String(line).length + String(command.who ?? '').length > MAX_LINE) problems.push(`${at} has a line longer than ${MAX_LINE} characters, which will not fit the text box: "${String(line).slice(0, 40)}..."`)
        break
      case 'choice':
        if (!command.options?.length) problems.push(`${at} offers a choice with no options`)
        break
      case 'if':
        for (const key of Object.keys(command.if ?? {})) if (!CONDITIONS.includes(key)) problems.push(`${at} checks ${key}; conditions are ${CONDITIONS.join(', ')}`)
        if (command.if?.item && !has(d.items, command.if.item)) problems.push(`${at} checks for item ${command.if.item}, which is not in items.json`)
        if (command.if?.member && !has(d.characters, command.if.member)) problems.push(`${at} checks for ${command.if.member}, who is not in characters.json`)
        if (command.if?.quest && !has(d.quests, command.if.quest)) problems.push(`${at} checks quest ${command.if.quest}, which is not in quests.json`)
        for (const flag of [command.if?.flag, command.if?.not_flag]) if (flag) wanted.push([flag, at])
        break
      case 'set': setFlags.add(command.set); break
      case 'give': case 'take':
        if (!has(d.items, command[name])) problems.push(`${at} ${name}s ${command[name]}, which is not in items.json`)
        break
      case 'join': case 'leave':
        if (!has(d.characters, command[name])) problems.push(`${at} names ${command[name]}, who is not in characters.json`)
        break
      case 'quest':
        if (!has(d.quests, command.quest)) problems.push(`${at} names quest ${command.quest}, which is not in quests.json`)
        else if (!(String(command.stage ?? 'start') in (d.quests[command.quest].stages ?? {}))) problems.push(`${at} sets quest ${command.quest} to stage ${command.stage}, which it does not have`)
        break
      case 'battle':
        if (!Array.isArray(command.battle) || !command.battle.length) problems.push(`${at} starts a battle with no enemies`)
        for (const enemy of command.battle ?? []) if (!has(d.enemies, enemy)) problems.push(`${at} fights ${enemy}, which is not in enemies.json`)
        if (command.ending && !has(d.dialogue, 'ending')) problems.push(`${at} ends the game, but dialogue.json has no "ending" lines`)
        if (command.flag) setFlags.add(command.flag)
        break
      case 'shop':
        for (const item of command.shop ?? []) if (!has(d.items, item)) problems.push(`${at} sells ${item}, which is not in items.json`)
        break
      case 'warp':
        if (!has(d.maps, command.warp)) problems.push(`${at} warps to map ${command.warp}, which is not in maps.json`)
        break
      case 'event':
        checkEventRef(at, command.event)
        break
      case 'music':
        if (String(command.music).startsWith('res://') && !exists(String(command.music).slice(6))) problems.push(`${at} plays ${command.music}, which does not exist`)
        break
    }
  }
  // A {"hide": id} sets the hidden flag for that NPC; on_enter and triggers set their own "seen" flags.

  // Story flags: every flag something waits for has to be set by something, or that door never opens.
  for (const [flag, who] of wanted) if (!setFlags.has(flag)) problems.push(`${who} waits for the flag ${flag}, but nothing sets it (an event's "set", an NPC's "sets", a battle's "flag" or a chest's "flag")`)

  for (const [key, path] of Object.entries(d.game)) {
    if (typeof path === 'string' && path.startsWith('res://') && /\.(png)$/.test(path) && !exists(path.slice(6))) problems.push(`game.json ${key} points to ${path}, which does not exist`)
  }
  return problems
}

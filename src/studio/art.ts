/**
 * Placeholder art and sound for a new game, drawn in code: original pixel art (tiles, the hero, NPCs, enemies) and
 * short generated sounds and music loops. Every new project runs, looks like a game and makes noise from minute one;
 * the art-direction and audio phases replace these files one by one.
 */
import { writePngRgba } from '../contracts/png.ts'
import { writeWav16 } from '../contracts/wav.ts'
import { sound } from './make.ts'

type RGB = readonly [number, number, number]

class Canvas {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.data = new Uint8Array(width * height * 4)
  }
  set(x: number, y: number, color: RGB, alpha = 255): void {
    x = Math.round(x)
    y = Math.round(y)
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    const i = (y * this.width + x) * 4
    this.data[i] = color[0]; this.data[i + 1] = color[1]; this.data[i + 2] = color[2]; this.data[i + 3] = alpha
  }
  rect(x: number, y: number, w: number, h: number, color: RGB): void {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) this.set(x + dx, y + dy, color)
  }
  disc(cx: number, cy: number, r: number, color: RGB): void {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r) this.set(cx + x, cy + y, color)
  }
  png(): Buffer {
    return writePngRgba(this.width, this.height, this.data)
  }
}

/** A deterministic noise source, so a project's art is the same every time it is generated. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000)
}

// A small palette in the spirit of classic 16-colour consoles (original colour choices).
const P = {
  ink: [24, 20, 37], night: [29, 43, 83], plum: [126, 37, 83], moss: [0, 135, 81], grass: [76, 160, 72], leaf: [41, 108, 54],
  sand: [222, 196, 140], brown: [131, 84, 52], bark: [92, 58, 36], stone: [128, 124, 128], light: [194, 195, 199],
  white: [255, 241, 232], red: [214, 60, 60], orange: [255, 163, 0], yellow: [255, 236, 39], sky: [41, 173, 255],
  blue: [44, 94, 183], deep: [24, 52, 120], pink: [255, 119, 168], skin: [255, 204, 170],
} satisfies Record<string, RGB>

/** The tile strip the overworld uses: grass, wall, water, tree, tall grass, path, floor, door, roof, flowers. */
export function tilesPng(size = 16): Buffer {
  const names = ['grass', 'wall', 'water', 'tree', 'tallgrass', 'path', 'floor', 'door', 'roof', 'flowers'] as const
  const c = new Canvas(size * names.length, size)
  const r = rng(7)
  names.forEach((name, i) => {
    const ox = i * size
    const fill = (color: RGB) => c.rect(ox, 0, size, size, color)
    const speckle = (color: RGB, n: number) => { for (let k = 0; k < n; k++) c.set(ox + Math.floor(r() * size), Math.floor(r() * size), color) }
    switch (name) {
      case 'grass': fill(P.grass); speckle(P.leaf, 10); break
      case 'wall': fill(P.stone); for (let y = 0; y < size; y += 4) { c.rect(ox, y, size, 1, P.ink); for (let x = (y / 4) % 2 ? 2 : 6; x < size; x += 8) c.rect(ox + x, y, 1, 4, P.ink) } break
      case 'water': fill(P.blue); for (let k = 0; k < 4; k++) { const y = 2 + k * 4; c.rect(ox + 2 + (k % 2) * 6, y, 4, 1, P.sky) } break
      case 'tree': fill(P.grass); c.disc(ox + size / 2, size / 2 - 2, size / 2 - 2, P.leaf); c.disc(ox + size / 2 - 2, size / 2 - 4, 2, P.moss); c.rect(ox + size / 2 - 1, size - 4, 3, 4, P.bark); break
      case 'tallgrass': fill(P.grass); for (let x = 1; x < size; x += 3) { const h = 4 + Math.floor(r() * 5); c.rect(ox + x, size - h, 1, h, P.leaf); c.set(ox + x, size - h, P.moss) } break
      case 'path': fill(P.sand); speckle(P.brown, 8); break
      case 'floor': fill(P.brown); for (let y = 3; y < size; y += 4) c.rect(ox, y, size, 1, P.bark); break
      case 'door': fill(P.stone); c.rect(ox + 3, 2, size - 6, size - 2, P.bark); c.rect(ox + 4, 3, size - 8, size - 3, P.brown); c.set(ox + size - 6, size / 2, P.yellow); break
      case 'roof': fill(P.red); for (let y = 1; y < size; y += 3) c.rect(ox, y, size, 1, P.plum); break
      case 'flowers': fill(P.grass); for (let k = 0; k < 5; k++) { const x = ox + 2 + Math.floor(r() * (size - 4)); const y = 2 + Math.floor(r() * (size - 4)); c.set(x, y, k % 2 ? P.pink : P.yellow); c.set(x, y + 1, P.leaf) } break
    }
  })
  return c.png()
}

/** A small person, facing down, left, right or up, in two walking frames; colours tell characters apart. */
function person(c: Canvas, ox: number, oy: number, facing: 'down' | 'left' | 'right' | 'up', step: number, cloth: RGB, hair: RGB): void {
  const bob = step ? 1 : 0
  c.rect(ox + 5, oy + 2 + bob, 6, 5, P.skin)          // head
  c.rect(ox + 5, oy + 1 + bob, 6, 2, hair)            // hair
  if (facing === 'up') c.rect(ox + 5, oy + 2 + bob, 6, 4, hair)
  if (facing === 'down') { c.set(ox + 6, oy + 4 + bob, P.ink); c.set(ox + 9, oy + 4 + bob, P.ink) }
  if (facing === 'left') c.set(ox + 6, oy + 4 + bob, P.ink)
  if (facing === 'right') c.set(ox + 9, oy + 4 + bob, P.ink)
  c.rect(ox + 4, oy + 7 + bob, 8, 6, cloth)           // body
  c.rect(ox + 4, oy + 12, 8, 1, P.ink)                // belt
  const legs = step ? [[5, 13], [9, 14]] : [[5, 13], [9, 13]]
  for (const [x, y] of legs) c.rect(ox + x!, oy + y!, 2, 16 - y!, P.ink)
}

/** The hero sheet: 2 frames x 4 rows (down, left, right, up), 16x16 each, as the overworld expects. */
export function heroPng(cloth: RGB = P.blue, hair: RGB = P.orange): Buffer {
  const c = new Canvas(32, 64)
  ;(['down', 'left', 'right', 'up'] as const).forEach((facing, row) => { for (let f = 0; f < 2; f++) person(c, f * 16, row * 16, facing, f, cloth, hair) })
  return c.png()
}

/** Map figures, one per 16x16 frame: four townspeople facing down, a closed and an open chest, the great wolf, the
 * blacksmith, the ranger and a waystone. */
export function npcsPng(): Buffer {
  const c = new Canvas(160, 16)
  const looks: [RGB, RGB][] = [[P.plum, P.light], [P.moss, P.brown], [P.red, P.ink], [P.yellow, P.orange]]
  looks.forEach(([cloth, hair], i) => person(c, i * 16, 0, 'down', 0, cloth, hair))
  // chest, closed (frame 4) and open (frame 5)
  for (const [ox, open] of [[64, false], [80, true]] as const) {
    c.rect(ox + 2, 6, 12, 9, P.ink)
    c.rect(ox + 3, 7, 10, 7, P.brown)
    c.rect(ox + 3, 10, 10, 1, P.bark)
    if (open) { c.rect(ox + 3, 7, 10, 3, P.ink); c.rect(ox + 4, 8, 8, 1, P.yellow) } else c.rect(ox + 7, 9, 2, 3, P.yellow)
    c.rect(ox + 2, 3, 12, open ? 2 : 4, P.ink); c.rect(ox + 3, 4, 10, open ? 1 : 2, P.brown)
  }
  // the great wolf (frame 6)
  const wx = 96
  c.rect(wx + 2, 6, 11, 7, P.stone); c.rect(wx + 9, 3, 6, 6, P.stone); c.rect(wx + 9, 1, 2, 2, P.stone); c.rect(wx + 13, 1, 2, 2, P.stone)
  c.set(wx + 12, 5, P.red); c.rect(wx + 14, 7, 2, 1, P.light)
  for (const x of [3, 6, 9, 11]) c.rect(wx + x, 13, 2, 3, P.ink)
  c.rect(wx, 6, 2, 2, P.stone)
  // blacksmith (frame 7): leather apron, dark hair; ranger (frame 8): green hood
  person(c, 112, 0, 'down', 0, P.brown, P.ink)
  c.rect(112 + 5, 8, 6, 5, P.bark)
  person(c, 128, 0, 'down', 0, P.leaf, P.moss)
  c.rect(128 + 4, 1, 8, 2, P.moss)
  // waystone (frame 9): a standing stone with a glowing rune
  const sx = 144
  c.rect(sx + 4, 2, 8, 13, P.ink); c.rect(sx + 5, 3, 6, 11, P.stone); c.rect(sx + 5, 3, 2, 11, P.light)
  c.rect(sx + 7, 6, 2, 5, P.sky); c.set(sx + 6, 8, P.sky); c.set(sx + 9, 8, P.sky)
  c.rect(sx + 3, 14, 10, 2, P.leaf)
  return c.png()
}

/** Six 32x32 enemies, one per frame: slime, bat, wolf, wisp, sporecap, toxic slime. */
export function enemiesPng(): Buffer {
  const c = new Canvas(192, 32)
  // slime
  c.disc(16, 22, 9, P.moss); c.rect(7, 22, 19, 8, P.moss); c.disc(13, 18, 2, P.white); c.disc(20, 18, 2, P.white); c.set(13, 18, P.ink); c.set(20, 18, P.ink); c.disc(11, 15, 1, P.grass)
  // bat
  const bx = 32
  c.disc(bx + 16, 16, 5, P.plum)
  for (let i = 0; i < 10; i++) { c.rect(bx + 6 + i, 12 + Math.abs(5 - i), 1, 4, P.ink); c.rect(bx + 17 + i, 12 + Math.abs(4 - i), 1, 4, P.ink) }
  c.set(bx + 14, 15, P.yellow); c.set(bx + 18, 15, P.yellow)
  // wolf
  const wx = 64
  c.rect(wx + 6, 14, 18, 9, P.stone); c.rect(wx + 20, 9, 8, 8, P.stone); c.rect(wx + 21, 6, 2, 3, P.stone); c.rect(wx + 25, 6, 2, 3, P.stone)
  c.set(wx + 25, 11, P.red); c.rect(wx + 27, 14, 3, 2, P.light)
  for (const x of [7, 11, 17, 21]) c.rect(wx + x, 23, 2, 6, P.ink)
  c.rect(wx + 2, 13, 5, 2, P.stone)
  // wisp
  const px = 96
  c.disc(px + 16, 15, 8, P.sky); c.disc(px + 16, 15, 5, P.white); c.rect(px + 12, 22, 2, 5, P.sky); c.rect(px + 18, 22, 2, 6, P.sky)
  c.set(px + 14, 14, P.ink); c.set(px + 18, 14, P.ink)
  // sporecap: a mushroom with a spotted cap
  const mx = 128
  c.rect(mx + 12, 17, 8, 11, P.sand); c.rect(mx + 11, 27, 10, 2, P.brown)
  c.disc(mx + 16, 14, 10, P.red); c.rect(mx + 6, 14, 21, 4, P.red); c.rect(mx + 6, 17, 21, 1, P.plum)
  for (const [x, y] of [[10, 10], [18, 8], [22, 13], [13, 15]]) c.disc(mx + x!, y!, 1, P.white)
  c.set(mx + 14, 21, P.ink); c.set(mx + 18, 21, P.ink)
  // toxic slime: a purple slime with bubbles
  const tx = 160
  c.disc(tx + 16, 22, 9, P.plum); c.rect(tx + 7, 22, 19, 8, P.plum); c.disc(tx + 13, 18, 2, P.white); c.disc(tx + 20, 18, 2, P.white)
  c.set(tx + 13, 18, P.ink); c.set(tx + 20, 18, P.ink); c.disc(tx + 22, 12, 1, P.pink); c.disc(tx + 25, 8, 1, P.pink); c.set(tx + 10, 15, P.pink)
  return c.png()
}

// ---- sound ----------------------------------------------------------------------------------------------------------

const RATE = 22050

function tone(notes: [number, number][], options: { wave?: 'square' | 'triangle'; volume?: number; decay?: boolean } = {}): Float32Array {
  const total = notes.reduce((sum, [, seconds]) => sum + seconds, 0)
  const out = new Float32Array(Math.round(total * RATE))
  let index = 0
  for (const [frequency, seconds] of notes) {
    const length = Math.round(seconds * RATE)
    for (let i = 0; i < length; i++, index++) {
      if (!frequency) continue
      const phase = (i * frequency / RATE) % 1
      const raw = options.wave === 'triangle' ? 1 - 4 * Math.abs(phase - 0.5) : phase < 0.5 ? 1 : -1
      const envelope = options.decay === false ? Math.min(1, (length - i) / 200) : Math.max(0, 1 - i / length) * Math.min(1, i / 40)
      out[index] = raw * envelope * (options.volume ?? 0.25)
    }
  }
  return out
}

const NOTE: Record<string, number> = { C4: 262, D4: 294, E4: 330, F4: 349, G4: 392, A4: 440, B4: 494, C5: 523, D5: 587, E5: 659, G5: 784, A3: 220, G3: 196, E3: 165, C3: 131, F3: 175, R: 0 }
const melody = (text: string, beat: number): [number, number][] => text.split(' ').map(token => {
  const [note, length] = token.split(':')
  return [NOTE[note!] ?? 0, beat * Number(length ?? 1)]
})

/** Sound effects and short music loops, as 16-bit mono WAV files keyed by file name. */
export function soundFiles(): Record<string, Buffer> {
  const wav = (samples: Float32Array) => writeWav16(samples, RATE)
  return {
    'select.wav': wav(tone([[880, 0.04], [1320, 0.05]])),
    'hit.wav': wav(tone([[180, 0.05], [120, 0.08]], { volume: 0.35 })),
    'heal.wav': wav(tone(melody('C5 E5 G5', 0.07), { wave: 'triangle' })),
    'victory.wav': wav(tone(melody('C5 C5 C5 C5:2 A4:2 B4:2 C5 R B4 C5:4', 0.11))),
    'title.wav': wav(tone(melody('E4:2 G4:2 A4:2 G4:2 E4:2 D4:2 C4:4 E4:2 G4:2 C5:4 B4:2 G4:6', 0.18), { wave: 'triangle', volume: 0.18, decay: false })),
    'town.wav': wav(tone(melody('C4 E4 G4 E4 F4 A4 C5 A4 G4 E4 C4 E4 D4:4', 0.2), { wave: 'triangle', volume: 0.16, decay: false })),
    'field.wav': wav(tone(melody('G4 A4 B4 D5 C5 B4 A4 G4 E4 G4 A4 B4 A4:4', 0.17), { wave: 'triangle', volume: 0.16, decay: false })),
    'battle.wav': wav(tone(melody('A3 A3 C4 A3 D4 A3 E4 D4 A3 A3 C4 A3 G3 A3 E3:2', 0.11), { volume: 0.14, decay: false })),
  }
}

/** Every placeholder file a new project gets, by path relative to the project. */
export function starterArt(options: { heroColors?: [RGB, RGB] } = {}): Record<string, Buffer> {
  const files: Record<string, Buffer> = {
    'art/tiles.png': tilesPng(),
    'art/hero.png': heroPng(...(options.heroColors ?? [P.blue, P.orange])),
    'art/npcs.png': npcsPng(),
    'art/enemies.png': enemiesPng(),
  }
  for (const [name, buffer] of Object.entries(soundFiles())) files[`audio/${name}`] = buffer
  for (const name of ['magic', 'levelup', 'defeat', 'coin', 'cancel', 'item', 'door', 'encounter']) files[`audio/${name}.wav`] = sound(name)
  return files
}

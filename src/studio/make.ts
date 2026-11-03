/**
 * Making art and sound without other software, for developers who have never drawn a sprite or written music:
 * pixel art is painted from text grids (one character per pixel, a palette naming each character's colour) into the
 * game's sprite sheets, previewed enlarged so it can be looked at, and music and sounds are written from notes.
 * Everything is deterministic, so the same request makes the same file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { decodePngRgba, writePngRgba } from '../contracts/png.ts'
import { writeWav16 } from '../contracts/wav.ts'

// ---- pixel art ------------------------------------------------------------------------------------------------------

type RGBA = [number, number, number, number]

/** "#rgb", "#rrggbb", "#rrggbbaa" or "transparent". */
export function parseColor(text: string): RGBA {
  const value = text.trim().toLowerCase()
  if (value === 'transparent' || value === 'none' || value === 'clear') return [0, 0, 0, 0]
  const hex = value.replace(/^#/, '')
  const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(full)) throw new Error(`"${text}" is not a colour; use "#rrggbb" or "transparent"`)
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16), full.length === 8 ? parseInt(full.slice(6, 8), 16) : 255]
}

export interface PaintRequest {
  /** Image file in the project, such as art/enemies.png; created when missing. */
  file: string
  /** One string per pixel row, one character per pixel. */
  rows: string[]
  /** Character to colour. "." and " " are transparent unless named here. */
  palette: Record<string, string>
  /** Where to paint, in frames of `frame` size counted from the top left: [column, row]. Default [0, 0]. */
  at?: [number, number]
  /** Frame size in pixels; default the grid's size. A 16x16 hero frame, 32x32 enemy frame and so on. */
  frame?: [number, number]
}

export interface PaintResult { file: string; width: number; height: number; x: number; y: number; frameWidth: number; frameHeight: number; colors: number; grew: boolean }

/** Paints a text grid into an image, growing the image when the frame lies outside it. */
export function paint(project: string, request: PaintRequest): PaintResult {
  const rows = request.rows
  if (!rows.length) throw new Error('rows is empty: give one string per pixel row')
  const gridWidth = Math.max(...rows.map(row => [...row].length))
  const [frameWidth, frameHeight] = request.frame ?? [gridWidth, rows.length]
  if (gridWidth > frameWidth || rows.length > frameHeight) throw new Error(`the grid is ${gridWidth}x${rows.length} but the frame is ${frameWidth}x${frameHeight}`)
  const colors: Record<string, RGBA> = { '.': [0, 0, 0, 0], ' ': [0, 0, 0, 0] }
  for (const [char, color] of Object.entries(request.palette)) {
    if ([...char].length !== 1) throw new Error(`palette keys are single characters; "${char}" is not`)
    colors[char] = parseColor(color)
  }
  const unknown = new Set([...rows.join('')].filter(char => !(char in colors)))
  if (unknown.size) throw new Error(`the palette has no colour for: ${[...unknown].map(c => JSON.stringify(c)).join(', ')}`)

  const path = join(project, request.file)
  const [col, row] = request.at ?? [0, 0]
  const x = col * frameWidth
  const y = row * frameHeight
  let image = existsSync(path) ? decodePngRgba(readFileSync(path)) : { width: 0, height: 0, rgba: new Uint8Array(0) }
  const width = Math.max(image.width, x + frameWidth)
  const height = Math.max(image.height, y + frameHeight)
  const grew = width !== image.width || height !== image.height
  if (grew) {
    const bigger = new Uint8Array(width * height * 4)
    for (let line = 0; line < image.height; line++) bigger.set(image.rgba.subarray(line * image.width * 4, (line + 1) * image.width * 4), line * width * 4)
    image = { width, height, rgba: bigger }
  }
  // The frame is cleared first, so a repaint replaces it completely.
  for (let dy = 0; dy < frameHeight; dy++) image.rgba.fill(0, ((y + dy) * width + x) * 4, ((y + dy) * width + x + frameWidth) * 4)
  const used = new Set<string>()
  rows.forEach((line, dy) => [...line].forEach((char, dx) => {
    const color = colors[char]!
    if (color[3] === 0) return
    used.add(char)
    image.rgba.set(color, ((y + dy) * width + x + dx) * 4)
  }))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, writePngRgba(width, height, image.rgba))
  return { file: request.file, width, height, x, y, frameWidth, frameHeight, colors: used.size, grew }
}

/**
 * An enlarged copy of an image for looking at (each pixel a scale x scale block, on a checkerboard so transparency
 * shows, with a line between frames), written to .studio/previews/. Answers its path.
 */
export function preview(project: string, file: string, options: { scale?: number; frame?: [number, number] } = {}): { path: string; width: number; height: number } {
  const image = decodePngRgba(readFileSync(join(project, file)))
  const scale = options.scale ?? Math.max(2, Math.min(12, Math.floor(768 / Math.max(image.width, image.height))))
  const [fw, fh] = options.frame ?? [0, 0]
  const width = image.width * scale
  const height = image.height * scale
  const out = new Uint8Array(width * height * 4)
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    const sx = Math.floor(px / scale)
    const sy = Math.floor(py / scale)
    const i = (sy * image.width + sx) * 4
    const alpha = image.rgba[i + 3]! / 255
    const checker = ((Math.floor(px / 8) + Math.floor(py / 8)) % 2) ? 200 : 235
    const o = (py * width + px) * 4
    const line = (fw && px % (fw * scale) === 0 && px > 0) || (fh && py % (fh * scale) === 0 && py > 0)
    for (let c = 0; c < 3; c++) out[o + c] = line ? 255 : Math.round(image.rgba[i + c]! * alpha + checker * (1 - alpha))
    if (line) { out[o] = 255; out[o + 1] = 0; out[o + 2] = 255 }
    out[o + 3] = 255
  }
  const path = join(project, '.studio', 'previews', `${file.replace(/[\\/]/g, '_').replace(/\.png$/i, '')}.png`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, writePngRgba(width, height, out))
  return { path, width, height }
}

// ---- music and sound ------------------------------------------------------------------------------------------------

export const SAMPLE_RATE = 22050
export type Wave = 'square' | 'pulse' | 'triangle' | 'sine' | 'saw' | 'noise'

const SEMITONES: Record<string, number> = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }

/** "A4" is 440 Hz; sharps "C#5", flats "Bb3"; "R" or "-" is a rest (0). */
export function noteFrequency(name: string): number {
  if (name === 'R' || name === '-' || name === 'r') return 0
  const match = /^([A-Ga-g])(#|b)?(-?\d)$/.exec(name)
  if (!match) throw new Error(`"${name}" is not a note; write notes like C4, F#3, Bb4, or R for a rest`)
  const semitone = SEMITONES[match[1]!.toUpperCase()]! + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0) + (Number(match[3]) - 4) * 12
  return 440 * 2 ** (semitone / 12)
}

/** "C4 E4:2 G4:0.5 R" into [frequency, beats]; the number after ":" is the length in beats (default 1). */
export function parseNotes(text: string): [number, number][] {
  return text.trim().split(/\s+/).filter(Boolean).map(token => {
    const [note, length] = token.split(':')
    const beats = length === undefined ? 1 : Number(length)
    if (!Number.isFinite(beats) || beats <= 0) throw new Error(`"${token}" has a bad length; use C4:2 for two beats`)
    return [noteFrequency(note!), beats]
  })
}

export interface Voice {
  notes: string
  wave?: Wave
  volume?: number
  /** "pluck" fades each note out (melodies, bass), "hold" keeps it (pads, chiptune leads), "hit" is very short (drums). */
  envelope?: 'pluck' | 'hold' | 'hit'
}

function oscillator(wave: Wave, phase: number, noise: () => number): number {
  switch (wave) {
    case 'triangle': return 1 - 4 * Math.abs(phase - 0.5)
    case 'sine': return Math.sin(phase * 2 * Math.PI)
    case 'saw': return 2 * phase - 1
    case 'pulse': return phase < 0.25 ? 1 : -1
    case 'noise': return noise() * 2 - 1
    default: return phase < 0.5 ? 1 : -1
  }
}

function renderVoice(voice: Voice, tempo: number, length: number, out: Float32Array): void {
  const secondsPerBeat = 60 / tempo
  const wave = voice.wave ?? 'square'
  const volume = voice.volume ?? 0.2
  const envelope = voice.envelope ?? (wave === 'noise' ? 'hit' : 'pluck')
  let seed = 12345
  const noise = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 0x100000000)
  let start = 0
  for (const [frequency, beats] of parseNotes(voice.notes)) {
    const samples = Math.round(beats * secondsPerBeat * SAMPLE_RATE)
    if (frequency || wave === 'noise') {
      let phase = 0
      let held = 0
      for (let i = 0; i < samples && start + i < length; i++) {
        if (wave === 'noise') { if (i % Math.max(1, Math.round(SAMPLE_RATE / Math.max(frequency, 1) / 4)) === 0) held = oscillator('noise', 0, noise) }
        else phase = (phase + frequency / SAMPLE_RATE) % 1
        const attack = Math.min(1, i / 60)
        const release = Math.min(1, (samples - i) / 220)
        const shape = envelope === 'hold' ? 1 : envelope === 'hit' ? Math.max(0, 1 - i / Math.min(samples, SAMPLE_RATE * 0.12)) : Math.max(0, 1 - 0.85 * i / samples)
        out[start + i]! += (wave === 'noise' ? held : oscillator(wave, phase, noise)) * attack * release * shape * volume
      }
    }
    start += samples
  }
}

/** Mixes voices (melody, bass, drums...) at a tempo into a WAV; every voice starts together. */
export function compose(voices: Voice[], tempo: number, options: { repeat?: number } = {}): { wav: Buffer; seconds: number } {
  if (!voices.length) throw new Error('give at least one voice')
  if (tempo < 20 || tempo > 1200) throw new Error('tempo is beats per minute, between 20 and 1200')
  const beats = Math.max(...voices.map(voice => parseNotes(voice.notes).reduce((sum, [, b]) => sum + b, 0)))
  const once = Math.round(beats * 60 / tempo * SAMPLE_RATE)
  const repeat = Math.max(1, Math.min(16, options.repeat ?? 1))
  const out = new Float32Array(once * repeat)
  const loop = new Float32Array(once)
  for (const voice of voices) renderVoice(voice, tempo, once, loop)
  for (let r = 0; r < repeat; r++) out.set(loop, r * once)
  let peak = 0
  for (const value of out) peak = Math.max(peak, Math.abs(value))
  if (peak > 0.95) for (let i = 0; i < out.length; i++) out[i]! *= 0.95 / peak
  return { wav: writeWav16(out, SAMPLE_RATE), seconds: out.length / SAMPLE_RATE }
}

/** Ready-made sound effects; each is a small composition, so it can be adjusted by writing notes instead. */
export const SOUND_PRESETS: Record<string, { tempo: number; voices: Voice[]; about: string }> = {
  select: { tempo: 600, about: 'menu cursor', voices: [{ notes: 'A5:0.5 E6:0.6', wave: 'pulse', volume: 0.2 }] },
  confirm: { tempo: 400, about: 'menu choice accepted', voices: [{ notes: 'E5:0.5 A5:0.5 E6:1', wave: 'square', volume: 0.2 }] },
  cancel: { tempo: 400, about: 'menu back', voices: [{ notes: 'E5:0.5 A4:1', wave: 'square', volume: 0.2 }] },
  hit: { tempo: 300, about: 'a normal hit', voices: [{ notes: 'C3:0.4', wave: 'noise', volume: 0.45 }, { notes: 'G2:0.3', wave: 'square', volume: 0.15 }] },
  critical: { tempo: 300, about: 'a big hit', voices: [{ notes: 'C4:0.3 C3:0.6', wave: 'noise', volume: 0.5 }, { notes: 'C3:0.3 G2:0.6', wave: 'saw', volume: 0.2 }] },
  miss: { tempo: 500, about: 'an attack that misses', voices: [{ notes: 'G5:0.5 C5:0.5', wave: 'triangle', volume: 0.2 }] },
  magic: { tempo: 480, about: 'casting a spell', voices: [{ notes: 'C5:0.5 E5:0.5 G5:0.5 C6:0.5 E6:0.5 G6:1', wave: 'triangle', volume: 0.22 }] },
  fire: { tempo: 300, about: 'a fire spell', voices: [{ notes: 'C5:0.6 C4:0.6', wave: 'noise', volume: 0.35, envelope: 'pluck' }] },
  ice: { tempo: 600, about: 'an ice spell', voices: [{ notes: 'E6:0.5 B6:0.5 E7:0.5 B6:1', wave: 'sine', volume: 0.25 }] },
  heal: { tempo: 360, about: 'healing', voices: [{ notes: 'C5 E5 G5 C6:2', wave: 'triangle', volume: 0.22 }] },
  levelup: { tempo: 320, about: 'level up', voices: [{ notes: 'C5:0.5 E5:0.5 G5:0.5 C6:0.5 G5:0.5 C6:2', wave: 'square', volume: 0.18 }, { notes: 'C4:2 G4:2', wave: 'triangle', volume: 0.2 }] },
  victory: { tempo: 260, about: 'battle won', voices: [{ notes: 'C5:0.5 C5:0.5 C5:0.5 C5:1.5 Ab4:1.5 Bb4:1.5 C5:0.5 R:0.5 Bb4:0.5 C5:3', wave: 'square', volume: 0.18 }, { notes: 'C3:1.5 G3:1.5 Ab3:1.5 Bb3:1.5 C4:3', wave: 'triangle', volume: 0.22 }] },
  defeat: { tempo: 120, about: 'the party fell', voices: [{ notes: 'G4 F#4 F4 E4:3', wave: 'triangle', volume: 0.22 }] },
  coin: { tempo: 500, about: 'gold or a purchase', voices: [{ notes: 'B5:0.4 E6:1.5', wave: 'square', volume: 0.18 }] },
  item: { tempo: 400, about: 'found an item', voices: [{ notes: 'G5:0.5 C6:0.5 E6:0.5 G6:1.5', wave: 'pulse', volume: 0.2 }] },
  door: { tempo: 240, about: 'a door or warp', voices: [{ notes: 'C3:0.5 G2:0.5', wave: 'noise', volume: 0.3, envelope: 'pluck' }] },
  step: { tempo: 600, about: 'a footstep', voices: [{ notes: 'C2:0.3', wave: 'noise', volume: 0.15 }] },
  encounter: { tempo: 480, about: 'a battle starts', voices: [{ notes: 'C5:0.25 D5:0.25 E5:0.25 F5:0.25 G5:0.25 A5:0.25 B5:0.25 C6:1', wave: 'saw', volume: 0.15 }] },
}

export function sound(preset: string): Buffer {
  const found = SOUND_PRESETS[preset]
  if (!found) throw new Error(`no sound preset "${preset}"; presets: ${Object.keys(SOUND_PRESETS).join(', ')}`)
  return compose(found.voices, found.tempo).wav
}

/** Writes a WAV inside the project and answers its relative path. */
export function writeAudio(project: string, file: string, wav: Buffer): string {
  const relative = file.endsWith('.wav') ? file : `${file}.wav`
  const path = join(project, relative.includes('/') ? relative : join('audio', relative))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, wav)
  return relative.includes('/') ? relative : `audio/${basename(path)}`
}

// ---- palette ----------------------------------------------------------------------------------------------------------

const hex = (rgb: number[]) => `#${rgb.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('')}`
const normal = (color: string) => { const c = parseColor(color); return c[3] === 0 ? '' : hex(c) }

/** The palette colour closest to a colour (by perceptual-ish weighted distance). */
export function nearestColor(color: string, palette: string[]): string {
  const [r, g, b] = parseColor(color)
  let best = palette[0]!
  let bestDistance = Infinity
  for (const candidate of palette) {
    const [pr, pg, pb] = parseColor(candidate)
    const distance = 2 * (r - pr) ** 2 + 4 * (g - pg) ** 2 + 3 * (b - pb) ** 2
    if (distance < bestDistance) { best = candidate; bestDistance = distance }
  }
  return normal(best)
}

/** The colours (as #rrggbb) not in the palette; transparent ones never count. */
export function offPalette(colors: string[], palette: string[]): string[] {
  const allowed = new Set(palette.map(normal))
  return [...new Set(colors.map(normal).filter(c => c && !allowed.has(c)))]
}

/** The distinct visible colours of an image that are not in the palette. */
export function imageOffPalette(project: string, file: string, palette: string[]): { colors: number; off: string[] } {
  const image = decodePngRgba(readFileSync(join(project, file)))
  const seen = new Set<string>()
  for (let i = 0; i < image.rgba.length; i += 4) if (image.rgba[i + 3]! > 0) seen.add(hex([image.rgba[i]!, image.rgba[i + 1]!, image.rgba[i + 2]!]))
  return { colors: seen.size, off: offPalette([...seen], palette) }
}

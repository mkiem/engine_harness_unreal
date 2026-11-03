/**
 * Reference images for a 3D character: what makes a good set (the guide), and a checker that reads the developer's
 * uploads or an image model's turnaround sheet, separates the character from the background, splits a sheet into
 * views, grades every view against the guide in plain words, and writes the views the 3D build reads: each cropped to
 * the character, background transparent, all scaled to the same height so pixels mean the same size in every view.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import jpeg from 'jpeg-js'
import { decodePngRgba, writePngRgba } from '../contracts/png.ts'

export const VIEWS = ['front', 'side', 'back', 'three_quarter'] as const
export type View = typeof VIEWS[number]
export const NORMAL_HEIGHT = 1024

export const REFERENCE_GUIDE = `How to make reference images a 3D character can be built from

Views (one image each, or all in one turnaround sheet, left to right):
- Front (required): the character faces you.
- Side (required): a true 90-degree profile. Say which way the nose points (right is assumed).
- Back (strongly recommended): without it, the back of the character is guessed from the sides.
- Three-quarter (optional): helps you and the agent judge the shape; not used for the shape itself.
How many: two images at the least (front and side), three for a good result (front, side, back), four at most.

Pose: a neutral A-pose. Arms 30 to 45 degrees away from the body with a clear gap between arm and torso; hands open,
fingers together; legs straight and slightly apart (a gap between the feet); head straight; no weapon or prop in the
hands (make props separately).

Camera: straight on and far away (or "orthographic" when generating), no perspective, no tilt. Every view at the same
scale: the top of the head and the soles of the feet line up across views.

Background and light: one plain colour that contrasts with the character (white or light grey; avoid colours the
character wears), or a transparent PNG. Even, soft light from the front; no strong shadows on the character or the
ground, no floor reflections.

Framing: the whole body from head to toe, with a little space around it; nothing cut off at the edges. One character
per view; no text, labels, arrows or colour swatches.

Quality: at least 1024 pixels tall per view (the character itself at least 700 pixels tall); sharp, not blurry; PNG or
JPG. The same outfit, colours and proportions in every view.

Your own art: drawings, paintings, 3D renders and photos of a figure all work if they follow the above. Use images you
made or have the rights to use.`

export interface Img { width: number; height: number; rgba: Uint8Array }

export function loadImage(path: string): Img {
  const data = readFileSync(path)
  const ext = extname(path).toLowerCase()
  if (ext === '.png' || data.subarray(1, 4).toString('ascii') === 'PNG') return decodePngRgba(data)
  if (ext === '.jpg' || ext === '.jpeg' || (data[0] === 0xff && data[1] === 0xd8)) {
    const decoded = jpeg.decode(data, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 })
    return { width: decoded.width, height: decoded.height, rgba: decoded.data }
  }
  throw new Error(`${path}: use a PNG or JPG image (save WEBP, HEIC and others as PNG first)`)
}

/** A box-filtered copy no larger than `max` on its long side. */
export function shrink(img: Img, max: number): Img {
  const factor = Math.max(1, Math.ceil(Math.max(img.width, img.height) / max))
  if (factor === 1) return img
  const width = Math.floor(img.width / factor)
  const height = Math.floor(img.height / factor)
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sum = [0, 0, 0, 0]
    for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) {
      const i = ((y * factor + dy) * img.width + x * factor + dx) * 4
      for (let c = 0; c < 4; c++) sum[c]! += img.rgba[i + c]!
    }
    for (let c = 0; c < 4; c++) rgba[(y * width + x) * 4 + c] = Math.round(sum[c]! / (factor * factor))
  }
  return { width, height, rgba }
}

export interface Segmentation { mask: Uint8Array; method: 'alpha' | 'background'; background: [number, number, number]; uniformity: number; contrast: number }

/** Separates the character from the background: by transparency when the image has it, else by the border colour. */
export function segment(img: Img): Segmentation {
  const { width, height, rgba } = img
  const n = width * height
  let transparent = 0
  for (let i = 0; i < n; i++) if (rgba[i * 4 + 3]! < 250) transparent++
  const mask = new Uint8Array(n)
  let background: [number, number, number] = [255, 255, 255]
  let uniformity = 1
  let method: Segmentation['method'] = 'alpha'
  if (transparent > n * 0.02) {
    for (let i = 0; i < n; i++) mask[i] = rgba[i * 4 + 3]! > 127 ? 1 : 0
  } else {
    method = 'background'
    const margin = Math.max(2, Math.round(Math.min(width, height) * 0.02))
    const border: number[][] = []
    for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
      if (x < margin || y < margin || x >= width - margin || y >= height - margin) {
        const i = (y * width + x) * 4
        border.push([rgba[i]!, rgba[i + 1]!, rgba[i + 2]!])
      }
    }
    const median = (c: number) => border.map(p => p[c]!).sort((a, b) => a - b)[Math.floor(border.length / 2)]!
    background = [median(0), median(1), median(2)]
    const distance = (r: number, g: number, b: number) => Math.hypot(r - background[0], g - background[1], b - background[2])
    const borderDistances = border.map(p => distance(p[0]!, p[1]!, p[2]!)).sort((a, b) => a - b)
    uniformity = borderDistances.filter(d => d < 30).length / Math.max(1, borderDistances.length)
    const threshold = Math.min(120, Math.max(32, borderDistances[Math.floor(borderDistances.length * 0.95)]! * 1.5))
    for (let i = 0; i < n; i++) mask[i] = distance(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!) > threshold ? 1 : 0
  }
  fillHoles(mask, width, height)
  keepMain(mask, width, height)
  let contrastSum = 0
  let count = 0
  for (let i = 0; i < n; i += 7) if (mask[i]) { contrastSum += Math.hypot(rgba[i * 4]! - background[0], rgba[i * 4 + 1]! - background[1], rgba[i * 4 + 2]! - background[2]); count++ }
  return { mask, method, background, uniformity, contrast: method === 'alpha' ? 255 : contrastSum / Math.max(1, count) }
}

/** Background regions not reachable from the image border are holes in the character: fill them. */
function fillHoles(mask: Uint8Array, width: number, height: number): void {
  const outside = new Uint8Array(mask.length)
  const stack: number[] = []
  const push = (i: number) => { if (!mask[i] && !outside[i]) { outside[i] = 1; stack.push(i) } }
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x) }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1) }
  while (stack.length) {
    const i = stack.pop()!
    const x = i % width
    if (x > 0) push(i - 1)
    if (x < width - 1) push(i + 1)
    if (i >= width) push(i - width)
    if (i < mask.length - width) push(i + width)
  }
  for (let i = 0; i < mask.length; i++) if (!outside[i]) mask[i] = 1
}

/** Keeps the connected parts of the character (anything at least 2% of the largest part); drops specks and noise. */
export function components(mask: Uint8Array, width: number, height: number): { label: Int32Array; areas: number[]; boxes: number[][] } {
  const label = new Int32Array(mask.length).fill(-1)
  const areas: number[] = []
  const boxes: number[][] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]! >= 0) continue
    const id = areas.length
    let area = 0
    const box = [width, height, -1, -1]
    const stack = [start]
    label[start] = id
    while (stack.length) {
      const i = stack.pop()!
      area++
      const x = i % width
      const y = (i - x) / width
      if (x < box[0]!) box[0] = x
      if (y < box[1]!) box[1] = y
      if (x > box[2]!) box[2] = x
      if (y > box[3]!) box[3] = y
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i >= width ? i - width : -1, i < mask.length - width ? i + width : -1]) {
        if (j >= 0 && mask[j] && label[j]! < 0) { label[j] = id; stack.push(j) }
      }
    }
    areas.push(area)
    boxes.push(box)
  }
  return { label, areas, boxes }
}

function keepMain(mask: Uint8Array, width: number, height: number): void {
  const { label, areas } = components(mask, width, height)
  const largest = Math.max(0, ...areas)
  for (let i = 0; i < mask.length; i++) if (mask[i] && areas[label[i]!]! < largest * 0.02) mask[i] = 0
}

/** Splits a turnaround sheet into views by the empty columns between them; answers [x0, x1] ranges, left to right. */
export function splitSheet(mask: Uint8Array, width: number, height: number): [number, number][] {
  const filled = new Array(width).fill(0)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y * width + x]) filled[x]++
  const gap = Math.max(4, Math.round(width * 0.015))
  const ranges: [number, number][] = []
  let start = -1
  let empty = 0
  for (let x = 0; x <= width; x++) {
    const on = x < width && filled[x] > 0
    if (on) {
      if (start < 0) start = x
      empty = 0
    } else if (start >= 0) {
      empty++
      if (empty >= gap || x === width) { ranges.push([start, x - empty]); start = -1; empty = 0 }
    }
  }
  const area = (r: [number, number]) => { let a = 0; for (let x = r[0]; x <= r[1]; x++) a += filled[x]; return a }
  const biggest = Math.max(0, ...ranges.map(area))
  return ranges.filter(r => area(r) >= biggest * 0.08)
}

export interface Check { id: string; level: 'error' | 'warning' | 'ok'; message: string; fix?: string }
export interface ViewReport {
  view: View; source: string; file: string; width: number; height: number; heightPx: number; widthPx: number
  checks: Check[]; metrics: Record<string, number | boolean>
}
export interface ReferenceReport { ready: boolean; sideFacing: 'right' | 'left'; views: Partial<Record<View, ViewReport>>; checks: Check[]; dir: string }

function bboxOf(mask: Uint8Array, width: number, height: number, x0 = 0, x1 = width - 1): [number, number, number, number] | undefined {
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) for (let x = x0; x <= x1; x++) if (mask[y * width + x]) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return maxX < 0 ? undefined : [minX, minY, maxX, maxY]
}

/** Runs of filled pixels along one row of the crop. */
function runs(mask: Uint8Array, width: number, y: number, x0: number, x1: number): [number, number][] {
  const out: [number, number][] = []
  let start = -1
  for (let x = x0; x <= x1 + 1; x++) {
    const on = x <= x1 && mask[y * width + x]
    if (on && start < 0) start = x
    if (!on && start >= 0) { out.push([start, x - 1]); start = -1 }
  }
  return out
}

function sharpness(img: Img, box: [number, number, number, number]): number {
  const gray = (x: number, y: number) => { const i = (y * img.width + x) * 4; return 0.299 * img.rgba[i]! + 0.587 * img.rgba[i + 1]! + 0.114 * img.rgba[i + 2]! }
  const values: number[] = []
  const step = Math.max(1, Math.floor((box[3] - box[1]) / 300))
  for (let y = box[1] + 1; y < box[3]; y += step) for (let x = box[0] + 1; x < box[2]; x += step) {
    values.push(4 * gray(x, y) - gray(x - 1, y) - gray(x + 1, y) - gray(x, y - 1) - gray(x, y + 1))
  }
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)
  return values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, values.length)
}

/** Grades one view and writes its normalized cut-out. */
function analyzeView(view: View, source: string, img: Img, seg: Segmentation, range: [number, number] | undefined, outDir: string): ViewReport | Check {
  const { width, height } = img
  const box = bboxOf(seg.mask, width, height, range?.[0] ?? 0, range?.[1] ?? width - 1)
  if (!box) return { id: `${view}.empty`, level: 'error', message: `The ${view} view has no character the checker can find.`, fix: 'Use a plain background that contrasts with the character, or a transparent PNG.' }
  const [x0, y0, x1, y1] = box
  const heightPx = y1 - y0 + 1
  const widthPx = x1 - x0 + 1
  const checks: Check[] = []
  const add = (id: string, level: Check['level'], message: string, fix?: string) => checks.push({ id: `${view}.${id}`, level, message, fix })
  const metrics: Record<string, number | boolean> = { heightPx, widthPx, aspect: widthPx / heightPx }

  if (heightPx < 300) add('resolution', 'error', `The character is only ${heightPx} pixels tall in the ${view} view.`, 'Use an image where the character is at least 700 pixels tall (1024 or more is best).')
  else if (heightPx < 700) add('resolution', 'warning', `The character is ${heightPx} pixels tall in the ${view} view; details will be soft.`, 'At least 700 pixels tall (1024 or more) gives sharper textures.')
  const edge = Math.max(1, Math.round(Math.min(width, height) * 0.004))
  if (y0 <= edge || y1 >= height - 1 - edge || (!range && (x0 <= edge || x1 >= width - 1 - edge))) {
    add('framing', 'error', `The character touches the edge of the ${view} image, so part of it may be cut off.`, 'Show the whole body from head to toe with some space around it.')
  }
  if (seg.method === 'background') {
    if (seg.uniformity < 0.85) add('background', 'warning', `The ${view} background is not one plain colour (${Math.round(seg.uniformity * 100)}% uniform), so the outline may be wrong.`, 'Use a plain white or light grey background, or a transparent PNG.')
    if (seg.contrast < 45) add('contrast', 'error', `The character's colours are too close to the background in the ${view} view.`, 'Pick a background colour the character does not wear.')
  }
  const sharp = sharpness(img, box)
  metrics.sharpness = Math.round(sharp)
  if (sharp < 12) add('sharpness', 'warning', `The ${view} view looks blurry.`, 'Use a sharper image; avoid upscaled or heavily compressed pictures.')

  const mask = seg.mask
  const cx = Math.round((x0 + x1) / 2)
  if (view === 'front' || view === 'back') {
    // Symmetry: a front or back view of a character in a neutral pose is close to mirror-symmetric.
    let same = 0
    let total = 0
    for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) {
      const mirror = 2 * cx - x
      const a = mask[y * width + x]
      const b = mirror >= 0 && mirror < width ? mask[y * width + mirror] : 0
      if (a || b) { total++; if (a && b) same++ }
    }
    metrics.symmetry = Math.round(same / Math.max(1, total) * 100) / 100
    if ((metrics.symmetry as number) < 0.75) add('symmetry', 'warning', `The ${view} view is quite asymmetric (${Math.round((metrics.symmetry as number) * 100)}%): a turned body or a one-sided pose.`, 'Face the camera squarely, with arms in the same position on both sides.')
    // Arms away from the body: at chest height there should be three runs (arm, torso, arm).
    let separated = 0
    let rows = 0
    for (let f = 0.3; f <= 0.5; f += 0.02) {
      const y = Math.round(y0 + heightPx * f)
      rows++
      if (runs(mask, width, y, x0, x1).length >= 3) separated++
    }
    metrics.armsApart = separated / rows >= 0.3
    metrics.armSpan = widthPx / heightPx
    if (view === 'front' && !metrics.armsApart) add('pose', 'error', 'In the front view the arms touch the body, so they would be built as one block with the torso.', 'Use an A-pose: arms 30 to 45 degrees away from the body with a clear gap at the armpits.')
    else if (view === 'front' && widthPx / heightPx > 1.05) add('pose', 'warning', 'The arms are held very wide (a T-pose); an A-pose bends better when animated.', 'Lower the arms to 30 to 45 degrees from the body.')
    // Legs apart: two runs near the feet.
    const legs = runs(mask, width, Math.round(y0 + heightPx * 0.93), x0, x1).length
    metrics.legsApart = legs >= 2
    if (view === 'front' && legs < 2) add('legs', 'warning', 'The feet touch in the front view, so the legs may be built joined.', 'Stand with the feet slightly apart.')
  }

  // The cut-out: cropped to the character with the background transparent, scaled to the normal height.
  const scale = NORMAL_HEIGHT / heightPx
  const outWidth = Math.max(1, Math.round(widthPx * scale))
  const out = new Uint8Array(outWidth * NORMAL_HEIGHT * 4)
  for (let y = 0; y < NORMAL_HEIGHT; y++) for (let x = 0; x < outWidth; x++) {
    const sx = Math.min(x1, x0 + Math.floor(x / scale))
    const sy = Math.min(y1, y0 + Math.floor(y / scale))
    const i = sy * width + sx
    if (!mask[i]) continue
    out.set([img.rgba[i * 4]!, img.rgba[i * 4 + 1]!, img.rgba[i * 4 + 2]!, 255], (y * outWidth + x) * 4)
  }
  const file = join(outDir, `${view}.png`)
  writeFileSync(file, writePngRgba(outWidth, NORMAL_HEIGHT, out))
  if (!checks.some(c => c.level !== 'ok')) add('ok', 'ok', `The ${view} view looks good (${heightPx} px tall).`)
  return { view, source, file, width: outWidth, height: NORMAL_HEIGHT, heightPx, widthPx, checks, metrics }
}

export interface ReferenceInput {
  /** One file per view. */
  files?: Partial<Record<View, string>>
  /** Or a turnaround sheet with the views side by side. */
  sheet?: string
  /** The views in the sheet, left to right. */
  order?: View[]
  /** Which way the nose points in the side view. */
  sideFacing?: 'right' | 'left'
}

/** Checks the references and writes the normalized views and references.json into `outDir`. */
export function checkReferences(input: ReferenceInput, outDir: string): ReferenceReport {
  mkdirSync(outDir, { recursive: true })
  const views: Partial<Record<View, ViewReport>> = {}
  const checks: Check[] = []
  const record = (result: ViewReport | Check) => { if ('view' in result) views[result.view] = result; else checks.push(result) }
  if (input.sheet) {
    if (!existsSync(input.sheet)) throw new Error(`no image at ${input.sheet}`)
    const img = shrink(loadImage(input.sheet), 4096)
    const seg = segment(img)
    const ranges = splitSheet(seg.mask, img.width, img.height)
    const order = input.order ?? (['front', 'side', 'back', 'three_quarter'] as View[]).slice(0, ranges.length)
    if (ranges.length < 2) checks.push({ id: 'sheet.views', level: 'error', message: `The sheet shows ${ranges.length} separate figure(s); at least a front and a side view are needed.`, fix: 'Leave clear space between the views, or upload one image per view.' })
    if (ranges.length !== order.length) checks.push({ id: 'sheet.order', level: 'warning', message: `The sheet has ${ranges.length} views but the order names ${order.length}: ${order.join(', ')}.`, fix: 'Give the order of the views, left to right.' })
    ranges.slice(0, order.length).forEach((range, i) => record(analyzeView(order[i]!, input.sheet!, img, seg, range, outDir)))
  }
  for (const [view, file] of Object.entries(input.files ?? {}) as [View, string][]) {
    if (!file) continue
    if (!existsSync(file)) throw new Error(`no image at ${file}`)
    const img = shrink(loadImage(file), 4096)
    record(analyzeView(view, file, img, segment(img), undefined, outDir))
  }
  if (!views.front) checks.push({ id: 'views.front', level: 'error', message: 'There is no front view.', fix: 'Add a front view: the character facing the camera.' })
  if (!views.side) checks.push({ id: 'views.side', level: 'error', message: 'There is no side view.', fix: 'Add a side view: a 90-degree profile at the same scale.' })
  if (!views.back) checks.push({ id: 'views.back', level: 'warning', message: 'There is no back view, so the back is guessed from the sides.', fix: 'Add a back view for a better back.' })
  if (views.front && views.side) {
    const ratio = views.side.heightPx / views.front.heightPx
    if (Math.abs(ratio - 1) > 0.06) checks.push({ id: 'views.scale', level: 'warning', message: `The character is ${Math.round(Math.abs(ratio - 1) * 100)}% ${ratio > 1 ? 'taller' : 'shorter'} in the side view than in the front view; the build lines them up by height, but different poses or crops will distort the shape.`, fix: 'Keep the camera distance and pose the same in every view.' })
    if (views.side.widthPx / views.side.heightPx > views.front.widthPx / views.front.heightPx * 1.1) checks.push({ id: 'views.side', level: 'warning', message: 'The side view is wider than the front view; is it really the profile?', fix: 'Check the order of the views.' })
  }
  const all = [...checks, ...Object.values(views).flatMap(v => v!.checks)]
  const report: ReferenceReport = { ready: !all.some(c => c.level === 'error'), sideFacing: input.sideFacing ?? 'right', views, checks, dir: outDir }
  writeFileSync(join(outDir, 'references.json'), `${JSON.stringify({ ...report, views: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, { ...v, file: `${k}.png` }])) }, null, 2)}\n`)
  return report
}

export function describeReport(report: ReferenceReport): string {
  const lines: string[] = []
  for (const view of VIEWS) {
    const v = report.views[view]
    if (!v) continue
    lines.push(`${view}: ${v.heightPx}x${v.widthPx} px from ${v.source}`)
    for (const c of v.checks) lines.push(`  ${c.level === 'ok' ? '✓' : c.level === 'warning' ? '!' : '✗'} ${c.message}${c.fix ? ` Fix: ${c.fix}` : ''}`)
  }
  for (const c of report.checks) lines.push(`${c.level === 'warning' ? '!' : '✗'} ${c.message}${c.fix ? ` Fix: ${c.fix}` : ''}`)
  lines.push('', report.ready ? `Ready to build. The views are in ${report.dir}.` : 'Not ready: fix the errors (✗) and check again.')
  return lines.join('\n')
}

export const dirOf = dirname

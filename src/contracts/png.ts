/**
 * A small PNG reader for the pixel-art contracts: it decodes the image itself (8-bit greyscale, RGB, RGBA, grey+alpha
 * and indexed; non-interlaced) and measures what pixel art cares about: size, palette size, and whether alpha is hard
 * (fully opaque or fully transparent, as crisp sprites need). Like the WAV reader, it trusts the file, not the worker.
 */
import { deflateSync, inflateSync } from 'node:zlib'

export interface PngFacts {
  width: number
  height: number
  colorType: 'grey' | 'rgb' | 'indexed' | 'grey-alpha' | 'rgba'
  bitDepth: number
  interlaced: boolean
  /** Distinct colours among the visible pixels (alpha > 0), counted up to `colorLimit` + 1. */
  colors: number
  /** Every pixel fully opaque or fully transparent. */
  hardAlpha: boolean
  /** No visible pixel at all. */
  empty: boolean
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const COLOR_TYPES: Record<number, { name: PngFacts['colorType']; channels: number }> = {
  0: { name: 'grey', channels: 1 }, 2: { name: 'rgb', channels: 3 }, 3: { name: 'indexed', channels: 1 },
  4: { name: 'grey-alpha', channels: 2 }, 6: { name: 'rgba', channels: 4 },
}

interface Parsed {
  header: { width: number; height: number; bitDepth: number; colorType: number; interlace: number }
  kind: { name: PngFacts['colorType']; channels: number }
  palette?: Buffer
  transparency?: Buffer
  data: Buffer[]
}

function parse(buffer: Buffer): Parsed {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file')
  let offset = 8
  let header: { width: number; height: number; bitDepth: number; colorType: number; interlace: number } | undefined
  let palette: Buffer | undefined
  let transparency: Buffer | undefined
  const data: Buffer[] = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), bitDepth: body[8]!, colorType: body[9]!, interlace: body[12]! }
    else if (type === 'PLTE') palette = body
    else if (type === 'tRNS') transparency = body
    else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (!header) throw new Error('PNG has no IHDR chunk')
  const kind = COLOR_TYPES[header.colorType]
  if (!kind) throw new Error(`unknown PNG colour type ${header.colorType}`)
  return { header, kind, palette, transparency, data }
}

/** Unfilters the image data into one byte array of samples per row (8-bit, non-interlaced only). */
function samples({ header, kind, data }: Parsed): Buffer {
  const raw = inflateSync(Buffer.concat(data))
  const bpp = kind.channels
  const stride = header.width * bpp
  const pixels = Buffer.alloc(stride * header.height)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)]!
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp]! : 0
      const b = previous[x]!
      const c = x >= bpp ? previous[x - bpp]! : 0
      const value = line[x]!
      switch (filter) {
        case 0: out[x] = value; break
        case 1: out[x] = (value + a) & 0xff; break
        case 2: out[x] = (value + b) & 0xff; break
        case 3: out[x] = (value + ((a + b) >> 1)) & 0xff; break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          out[x] = (value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
          break
        }
        default: throw new Error(`bad PNG filter ${filter} on row ${y}`)
      }
    }
    previous = out
  }
  return pixels
}

/** The pixel at index i as [r, g, b, alpha]. */
function pixelAt(parsed: Parsed, pixels: Buffer, i: number): [number, number, number, number] {
  const p = i * parsed.kind.channels
  const { palette, transparency } = parsed
  switch (parsed.header.colorType) {
    case 0: return [pixels[p]!, pixels[p]!, pixels[p]!, 255]
    case 2: return [pixels[p]!, pixels[p + 1]!, pixels[p + 2]!, 255]
    case 3: {
      const index = pixels[p]!
      return [palette?.[index * 3] ?? 0, palette?.[index * 3 + 1] ?? 0, palette?.[index * 3 + 2] ?? 0, transparency && index < transparency.length ? transparency[index]! : 255]
    }
    case 4: return [pixels[p]!, pixels[p]!, pixels[p]!, pixels[p + 1]!]
    default: return [pixels[p]!, pixels[p + 1]!, pixels[p + 2]!, pixels[p + 3]!]
  }
}

export function readPng(buffer: Buffer, colorLimit = 4096): PngFacts {
  const parsed = parse(buffer)
  const { header, kind } = parsed
  const facts = { width: header.width, height: header.height, colorType: kind.name, bitDepth: header.bitDepth, interlaced: header.interlace === 1 }
  if (header.interlace === 1 || header.bitDepth !== 8) {
    // Measured size only; pixel art is 8-bit and non-interlaced in practice, and the contract says so.
    return { ...facts, colors: 0, hardAlpha: false, empty: false }
  }
  const pixels = samples(parsed)
  const seen = new Set<number>()
  let hardAlpha = true
  let visible = 0
  for (let i = 0; i < header.width * header.height; i++) {
    const [r, g, b, alpha] = pixelAt(parsed, pixels, i)
    if (alpha !== 0 && alpha !== 255) hardAlpha = false
    if (alpha === 0) continue
    visible++
    if (seen.size <= colorLimit) seen.add((r << 16) | (g << 8) | b)
  }
  return { ...facts, colors: seen.size, hardAlpha, empty: visible === 0 }
}

/** Decodes a PNG (8-bit, non-interlaced) into RGBA bytes, for tools that edit pixel art. */
export function decodePngRgba(buffer: Buffer): { width: number; height: number; rgba: Uint8Array } {
  const parsed = parse(buffer)
  const { width, height, bitDepth, interlace } = parsed.header
  if (interlace === 1 || bitDepth !== 8) throw new Error('only 8-bit, non-interlaced PNGs can be edited; re-save it as an ordinary 8-bit PNG')
  const pixels = samples(parsed)
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) rgba.set(pixelAt(parsed, pixels, i), i * 4)
  return { width, height, rgba }
}

/** Writes an 8-bit RGBA PNG (filter 0); for the simulated sprite worker and tests. */
export function writePngRgba(width: number, height: number, rgba: Uint8Array): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, 'ascii')
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])), 0)
    return Buffer.concat([head, body, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(rows, y * (width * 4 + 1) + 1)
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

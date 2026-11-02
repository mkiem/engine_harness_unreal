/**
 * A minimal RIFF/WAVE reader for the audio contract. It measures the clip itself rather than trusting what the worker
 * says: format, length, peak and RMS level, and for loops the jump between the last and first sample.
 */

export interface WavFacts {
  format: 'pcm' | 'float' | 'other'
  sampleRate: number
  channels: number
  bitDepth: number
  frames: number
  seconds: number
  peakDb: number
  rmsDb: number
  /** Absolute difference between the last and first sample of channel 0, in full-scale units; a click at the loop seam if large. */
  loopSeam: number
}

const toDb = (linear: number): number => linear <= 0 ? -Infinity : 20 * Math.log10(linear)

export function readWav(buffer: Buffer): WavFacts {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('not a RIFF/WAVE file')
  let offset = 12
  let fmt: { code: number; channels: number; sampleRate: number; bitDepth: number } | undefined
  let data: Buffer | undefined
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = buffer.subarray(offset + 8, Math.min(buffer.length, offset + 8 + size))
    if (id === 'fmt ') {
      let code = body.readUInt16LE(0)
      // WAVE_FORMAT_EXTENSIBLE carries the real format code in its sub-format GUID.
      if (code === 0xfffe && body.length >= 26) code = body.readUInt16LE(24)
      fmt = { code, channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bitDepth: body.readUInt16LE(14) }
    } else if (id === 'data') {
      data = body
    }
    offset += 8 + size + (size % 2) // chunks are word-aligned
  }
  if (!fmt) throw new Error('WAVE file has no fmt chunk')
  if (!data) throw new Error('WAVE file has no data chunk')

  const format = fmt.code === 1 ? 'pcm' : fmt.code === 3 ? 'float' : 'other'
  const bytes = fmt.bitDepth / 8
  const frameBytes = bytes * fmt.channels
  const frames = frameBytes > 0 ? Math.floor(data.length / frameBytes) : 0
  const sample = (frame: number, channel: number): number => {
    const at = frame * frameBytes + channel * bytes
    if (format === 'float' && bytes === 4) return data!.readFloatLE(at)
    if (format === 'float' && bytes === 8) return data!.readDoubleLE(at)
    switch (bytes) {
      case 1: return (data!.readUInt8(at) - 128) / 128
      case 2: return data!.readInt16LE(at) / 32768
      case 3: return data!.readIntLE(at, 3) / 8388608
      case 4: return data!.readInt32LE(at) / 2147483648
      default: return 0
    }
  }

  let peak = 0
  let sumSquares = 0
  if (format !== 'other') {
    for (let frame = 0; frame < frames; frame++) {
      for (let channel = 0; channel < fmt.channels; channel++) {
        const value = sample(frame, channel)
        const magnitude = Math.abs(value)
        if (magnitude > peak) peak = magnitude
        sumSquares += value * value
      }
    }
  }
  const count = frames * fmt.channels
  return {
    format,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitDepth: fmt.bitDepth,
    frames,
    seconds: fmt.sampleRate ? frames / fmt.sampleRate : 0,
    peakDb: toDb(peak),
    rmsDb: count ? toDb(Math.sqrt(sumSquares / count)) : -Infinity,
    loopSeam: frames > 1 && format !== 'other' ? Math.abs(sample(frames - 1, 0) - sample(0, 0)) : 0,
  }
}

/** Writes 16-bit PCM; used by the simulated audio worker and the tests. */
export function writeWav16(samples: Float32Array, sampleRate: number, channels = 1): Buffer {
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((value, index) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), index * 2))
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

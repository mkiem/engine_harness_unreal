/**
 * A minimal RIFF/WAVE reader for the audio contract. It measures the clip itself rather than trusting what the worker
 * says: format, length, sample peak, 4x-oversampled true peak (dBTP), RMS, ITU-R BS.1770-4 K-weighted integrated
 * loudness (LUFS), and for loops the jump between the last and first sample.
 */

export interface WavFacts {
  format: 'pcm' | 'float' | 'other'
  sampleRate: number
  channels: number
  bitDepth: number
  frames: number
  seconds: number
  peakDb: number
  /** 4x linear-interpolated / sinc-approximated true peak in dBTP. */
  truePeakDb: number
  rmsDb: number
  /** ITU-R BS.1770-4 K-weighted integrated loudness in LUFS (LKFS). */
  lufs: number
  /** Absolute difference between the last and first sample of channel 0, in full-scale units; a click at the loop seam if large. */
  loopSeam: number
}

const toDb = (linear: number): number => linear <= 0 ? -Infinity : 20 * Math.log10(linear)

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

/** ITU-R BS.1770-4 Stage 1 (high-shelf) & Stage 2 (RLB high-pass) K-weighting coefficients. */
function kWeightingFilters(fs: number): [Biquad, Biquad] {
  if (fs === 48000) {
    return [
      { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 },
      { b0: 1.0, b1: -2.0, b2: 1.0, a1: -1.99004745483398, a2: 0.99007225036621 },
    ]
  }
  // Bilinear transform for arbitrary sample rates (e.g. 44.1 kHz, 96 kHz).
  const db = 3.999843853973347
  const f0 = 1681.974450955533
  const Q = 0.7071752369554196
  const K = Math.tan((Math.PI * f0) / fs)
  const Vh = Math.pow(10, db / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  const a0s = 1 + K / Q + K * K
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0s,
    b1: (2 * (K * K - Vh)) / a0s,
    b2: (Vh - (Vb * K) / Q + K * K) / a0s,
    a1: (2 * (K * K - 1)) / a0s,
    a2: (1 - K / Q + K * K) / a0s,
  }
  const f1 = 38.13547087602444
  const Q1 = 0.5003270373238773
  const K1 = Math.tan((Math.PI * f1) / fs)
  const a0h = 1 + K1 / Q1 + K1 * K1
  const hp: Biquad = {
    b0: 1 / a0h,
    b1: -2 / a0h,
    b2: 1 / a0h,
    a1: (2 * (K1 * K1 - 1)) / a0h,
    a2: (1 - K1 / Q1 + K1 * K1) / a0h,
  }
  return [shelf, hp]
}

function applyBiquad(input: Float64Array, f: Biquad): Float64Array {
  const out = new Float64Array(input.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i]!
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2
    out[i] = y0
    x2 = x1; x1 = x0; y2 = y1; y1 = y0
  }
  return out
}

/** Computes ITU-R BS.1770-4 gated integrated loudness in LUFS. */
function measureLufs(channelData: Float64Array[], sampleRate: number): number {
  const channels = channelData.length
  const frames = channelData[0]?.length ?? 0
  if (!channels || !frames || !sampleRate) return -Infinity
  const [shelf, hp] = kWeightingFilters(sampleRate)
  const weighted = channelData.map(ch => applyBiquad(applyBiquad(ch, shelf), hp))
  // Channel weights per BS.1770: L/R/C = 1.0, Ls/Rs = 1.41, LFE = 0
  const gain = (ch: number) => (channels >= 5 && (ch === 4 || ch === 5) ? 1.41 : channels >= 4 && ch === 3 ? 0 : 1.0)

  const blockFrames = Math.max(1, Math.round(sampleRate * 0.4))
  const hopFrames = Math.max(1, Math.round(sampleRate * 0.1))
  const energies: number[] = []

  if (frames < blockFrames) {
    let z = 0
    for (let ch = 0; ch < channels; ch++) {
      let sum = 0
      const arr = weighted[ch]!
      for (let i = 0; i < frames; i++) sum += arr[i]! * arr[i]!
      z += gain(ch) * (sum / frames)
    }
    return z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity
  }

  for (let start = 0; start + blockFrames <= frames; start += hopFrames) {
    let z = 0
    for (let ch = 0; ch < channels; ch++) {
      let sum = 0
      const arr = weighted[ch]!
      for (let i = start; i < start + blockFrames; i++) sum += arr[i]! * arr[i]!
      z += gain(ch) * (sum / blockFrames)
    }
    const loudness = z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity
    if (loudness > -70) energies.push(z)
  }
  if (!energies.length) return -Infinity
  const meanAbs = energies.reduce((a, b) => a + b, 0) / energies.length
  const relThreshold = -0.691 + 10 * Math.log10(meanAbs) - 10
  const gated = energies.filter(z => -0.691 + 10 * Math.log10(z) > relThreshold)
  if (!gated.length) return -Infinity
  const meanGated = gated.reduce((a, b) => a + b, 0) / gated.length
  return -0.691 + 10 * Math.log10(meanGated)
}

/** 4x Catmull-Rom cubic interpolation true-peak approximation across all channels. */
function measureTruePeak(channelData: Float64Array[]): number {
  let maxPeak = 0
  for (const ch of channelData) {
    const n = ch.length
    for (let i = 0; i < n; i++) {
      const a = Math.abs(ch[i]!)
      if (a > maxPeak) maxPeak = a
      if (i > 0 && i + 2 < n) {
        const y0 = ch[i - 1]!, y1 = ch[i]!, y2 = ch[i + 1]!, y3 = ch[i + 2]!
        for (const t of [0.25, 0.5, 0.75]) {
          const t2 = t * t, t3 = t2 * t
          const interp = 0.5 * ((2 * y1) + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3)
          const mag = Math.abs(interp)
          if (mag > maxPeak) maxPeak = mag
        }
      }
    }
  }
  return toDb(maxPeak)
}

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
      if (code === 0xfffe && body.length >= 26) code = body.readUInt16LE(24)
      fmt = { code, channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bitDepth: body.readUInt16LE(14) }
    } else if (id === 'data') {
      data = body
    }
    offset += 8 + size + (size % 2)
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
  const channelData = format !== 'other' ? Array.from({ length: fmt.channels }, () => new Float64Array(frames)) : []
  if (format !== 'other') {
    for (let frame = 0; frame < frames; frame++) {
      for (let channel = 0; channel < fmt.channels; channel++) {
        const value = sample(frame, channel)
        channelData[channel]![frame] = value
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
    truePeakDb: channelData.length ? measureTruePeak(channelData) : -Infinity,
    rmsDb: count ? toDb(Math.sqrt(sumSquares / count)) : -Infinity,
    lufs: channelData.length ? measureLufs(channelData, fmt.sampleRate) : -Infinity,
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

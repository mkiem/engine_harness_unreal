/**
 * A sample turnaround sheet drawn in code: a simple adventurer in an A-pose, front, side (facing right) and back views
 * on a white background, following the reference guide. It lets a developer try the 3D character pipeline before
 * they have their own art, and it is what the tests and the end-to-end run build.
 */
import { writePngRgba } from '../contracts/png.ts'

type RGB = [number, number, number]
const C = {
  skin: [242, 194, 155], hair: [96, 58, 34], shirt: [58, 110, 198], trim: [235, 196, 70], belt: [40, 32, 30],
  pants: [70, 70, 86], boots: [96, 60, 32], eye: [20, 20, 28], white: [255, 255, 255],
} satisfies Record<string, RGB>

class Sheet {
  readonly rgba: Uint8Array
  readonly width: number
  readonly height: number
  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.rgba = new Uint8Array(width * height * 4).fill(255)
  }
  set(x: number, y: number, c: RGB) {
    x = Math.round(x); y = Math.round(y)
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    this.rgba.set([c[0], c[1], c[2], 255], (y * this.width + x) * 4)
  }
  rect(x: number, y: number, w: number, h: number, c: RGB) { for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) this.set(x + dx, y + dy, c) }
  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB) {
    for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) if ((x / rx) ** 2 + (y / ry) ** 2 <= 1) this.set(cx + x, cy + y, c)
  }
  /** A thick segment with round ends (limbs). */
  limb(x0: number, y0: number, x1: number, y1: number, r: number, c: RGB) {
    const len = Math.hypot(x1 - x0, y1 - y0)
    for (let t = 0; t <= len; t += 0.5) {
      const x = x0 + (x1 - x0) * t / len
      const y = y0 + (y1 - y0) * t / len
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) this.set(x + dx, y + dy, c)
    }
  }
  png() { return writePngRgba(this.width, this.height, this.rgba) }
}

/** Front, side and back views side by side, each 640 x 1024, character 880 px tall. */
export function sampleSheet(): Buffer {
  const W = 640
  const H = 1024
  const s = new Sheet(W * 3, H)
  const top = 72
  const unit = 880 / 8 // eight heads tall-ish, chunky adventurer
  const y = (heads: number) => top + heads * unit

  // ---- front ----
  {
    const cx = W / 2
    // legs (apart), boots
    for (const side of [-1, 1]) {
      s.limb(cx + side * 40, y(4.1), cx + side * 62, y(7.3), 30, C.pants)
      s.rect(cx + side * 62 - 32, y(7.3), 64, unit * 0.7, C.boots)
    }
    // arms in an A-pose: shoulder to hand, sleeves then skin
    for (const side of [-1, 1]) {
      s.limb(cx + side * 92, y(1.7), cx + side * 175, y(3.0), 26, C.shirt)
      s.limb(cx + side * 175, y(3.0), cx + side * 245, y(4.2), 22, C.skin)
      s.ellipse(cx + side * 252, y(4.35), 26, 30, C.skin)
    }
    // torso, belt, trim
    s.rect(cx - 105, y(1.5), 210, unit * 2.6, C.shirt)
    s.rect(cx - 105, y(1.5), 210, 14, C.trim)
    s.rect(cx - 105, y(3.9), 210, 26, C.belt)
    s.rect(cx - 18, y(3.9) + 4, 36, 18, C.trim)
    // neck, head, hair, eyes
    s.rect(cx - 26, y(1.15), 52, unit * 0.45, C.skin)
    s.ellipse(cx, y(0.62), 80, 70, C.skin)
    s.ellipse(cx, y(0.35), 86, 45, C.hair)
    s.rect(cx - 86, y(0.35), 30, 70, C.hair)
    s.rect(cx + 56, y(0.35), 30, 70, C.hair)
    s.ellipse(cx - 28, y(0.68), 8, 11, C.eye)
    s.ellipse(cx + 28, y(0.68), 8, 11, C.eye)
  }
  // ---- side (facing right) ----
  {
    const cx = W + W / 2
    s.limb(cx - 10, y(4.1), cx - 18, y(7.3), 32, C.pants)
    s.limb(cx + 10, y(4.1), cx + 22, y(7.3), 32, C.pants)
    s.rect(cx - 50, y(7.3), 120, unit * 0.7, C.boots)
    s.rect(cx - 60, y(1.5), 120, unit * 2.6, C.shirt)
    s.rect(cx - 60, y(1.5), 120, 14, C.trim)
    s.rect(cx - 60, y(3.9), 120, 26, C.belt)
    // arm hangs a little forward (it is out to the side, so the profile shows it over the body)
    s.limb(cx + 5, y(1.75), cx + 18, y(3.0), 24, C.shirt)
    s.limb(cx + 18, y(3.0), cx + 26, y(4.2), 20, C.skin)
    s.ellipse(cx + 28, y(4.35), 22, 28, C.skin)
    s.rect(cx - 24, y(1.15), 48, unit * 0.45, C.skin)
    s.ellipse(cx + 4, y(0.62), 72, 70, C.skin)
    s.ellipse(cx - 12, y(0.42), 80, 52, C.hair)
    s.rect(cx - 92, y(0.42), 40, 110, C.hair)
    s.ellipse(cx + 76, y(0.7), 10, 12, C.skin) // nose
    s.ellipse(cx + 44, y(0.66), 7, 10, C.eye)
  }
  // ---- back ----
  {
    const cx = 2 * W + W / 2
    for (const side of [-1, 1]) {
      s.limb(cx + side * 40, y(4.1), cx + side * 62, y(7.3), 30, C.pants)
      s.rect(cx + side * 62 - 32, y(7.3), 64, unit * 0.7, C.boots)
      s.limb(cx + side * 92, y(1.7), cx + side * 175, y(3.0), 26, C.shirt)
      s.limb(cx + side * 175, y(3.0), cx + side * 245, y(4.2), 22, C.skin)
      s.ellipse(cx + side * 252, y(4.35), 26, 30, C.skin)
    }
    s.rect(cx - 105, y(1.5), 210, unit * 2.6, C.shirt)
    s.rect(cx - 105, y(3.9), 210, 26, C.belt)
    s.rect(cx - 26, y(1.15), 52, unit * 0.45, C.skin)
    s.ellipse(cx, y(0.62), 82, 72, C.hair)
    s.rect(cx - 70, y(0.62), 140, 70, C.hair)
  }
  return s.png()
}

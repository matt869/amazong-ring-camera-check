/**
 * Webcam motion detection, run entirely on the sensor device. Frames are
 * shrunk to a tiny grayscale grid and compared with the previous one; only
 * "there was movement at <time>" ever leaves the device, never images.
 *
 * Browser-safe: no Node imports.
 */

export const FRAME_WIDTH = 64;
export const FRAME_HEIGHT = 48;

/** RGBA pixels -> grayscale luma (0-255). */
export function toGray(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length / 4);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
  return out;
}

/** Fraction (0-1) of pixels whose brightness changed by more than `pixelThreshold`. */
export function changedFraction(prev: Uint8ClampedArray, cur: Uint8ClampedArray, pixelThreshold = 25): number {
  if (prev.length !== cur.length || cur.length === 0) return 0;
  let changed = 0;
  for (let i = 0; i < cur.length; i++) {
    if (Math.abs(cur[i] - prev[i]) > pixelThreshold) changed++;
  }
  return changed / cur.length;
}

/** Average brightness 0-255; very dark rooms can't show motion to a webcam. */
export function meanBrightness(gray: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  return gray.length ? sum / gray.length : 0;
}

export type Sensitivity = 'low' | 'medium' | 'high';

/** Share of the picture that must change. Lower = more sensitive. */
export const SENSITIVITY_FRACTION: Record<Sensitivity, number> = {
  low: 0.06,
  medium: 0.025,
  high: 0.01,
};

export interface MotionUpdate {
  /** Share of the frame that changed since the last one. */
  fraction: number;
  /** Movement is happening (sustained over consecutive frames). */
  moving: boolean;
  /** Report a motion event now (first frame of movement, then at most once per cooldown). */
  report: boolean;
  /** The room is too dark for the camera to see movement. */
  dark: boolean;
}

/**
 * Turns a stream of grayscale frames into motion reports.
 * - Needs `confirmFrames` consecutive changed frames (about 1.5 s at the
 *   sensor's 2 frames/second). A one-frame flicker changes two diffs (on and
 *   off), so the default of 3 keeps flickers and noise from counting.
 * - While movement continues, reports at most once per `cooldownMs`.
 */
export class MotionDetector {
  private prev: Uint8ClampedArray | null = null;
  private streak = 0;
  private lastReportAt = -Infinity;

  constructor(
    public sensitivity: Sensitivity = 'medium',
    private readonly confirmFrames = 3,
    private readonly cooldownMs = 60_000,
  ) {}

  update(gray: Uint8ClampedArray, now: number): MotionUpdate {
    const dark = meanBrightness(gray) < 18;
    const fraction = this.prev ? changedFraction(this.prev, gray) : 0;
    this.prev = gray;

    const changed = fraction >= SENSITIVITY_FRACTION[this.sensitivity];
    this.streak = changed ? this.streak + 1 : 0;
    const moving = this.streak >= this.confirmFrames;
    const report = moving && now - this.lastReportAt >= this.cooldownMs;
    if (report) this.lastReportAt = now;
    return { fraction, moving, report, dark };
  }

  reset(): void {
    this.prev = null;
    this.streak = 0;
  }
}

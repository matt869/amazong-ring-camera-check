import { describe, expect, it } from 'vitest';
import { changedFraction, meanBrightness, MotionDetector, toGray } from '../lib/sensor/motion';

const frame = (fill: number, n = 100) => new Uint8ClampedArray(n).fill(fill);
/** A frame where the first `count` pixels differ strongly from the background. */
const withBlob = (count: number, n = 100) => {
  const f = frame(120, n);
  for (let i = 0; i < count; i++) f[i] = 220;
  return f;
};

describe('frame helpers', () => {
  it('converts RGBA to grayscale', () => {
    expect([...toGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]))]).toEqual([255, 0]);
  });

  it('measures the share of pixels that changed beyond the noise threshold', () => {
    expect(changedFraction(frame(120), frame(130))).toBe(0); // small brightness drift is noise
    expect(changedFraction(frame(120), withBlob(10))).toBeCloseTo(0.1);
    expect(changedFraction(frame(120, 10), frame(120, 20))).toBe(0); // size mismatch
  });

  it('measures brightness', () => {
    expect(meanBrightness(frame(10))).toBe(10);
  });
});

describe('MotionDetector', () => {
  it('ignores a one-frame flicker (it changes two diffs: on, then off)', () => {
    const d = new MotionDetector('medium');
    const seq = [frame(120), withBlob(20), frame(120), frame(120), frame(120)];
    expect(seq.map((f, i) => d.update(f, i * 500)).some((u) => u.moving || u.report)).toBe(false);
  });

  it('reports sustained movement once, then waits out the cooldown', () => {
    const d = new MotionDetector('medium', 3, 60_000);
    // Something moving: every frame differs from the last.
    const moving = (t: number) => d.update(t % 1000 === 0 ? frame(120) : withBlob(20), t);
    moving(0);
    expect(moving(500).report).toBe(false); // streak 1
    expect(moving(1000).report).toBe(false); // streak 2
    const third = moving(1500); // streak 3: confirmed
    expect(third.moving).toBe(true);
    expect(third.report).toBe(true);
    for (let t = 2000; t < 61_500; t += 500) expect(moving(t).report).toBe(false); // cooldown
    expect(moving(61_500).report).toBe(true); // 60 s after the first report
  });

  it('respects sensitivity', () => {
    // A small object (3% of the picture) moving continuously.
    const run = (s: 'low' | 'high') => {
      const d = new MotionDetector(s);
      return [frame(120), withBlob(3), frame(120), withBlob(3)].map((f, i) => d.update(f, i * 500)).at(-1)!.moving;
    };
    expect(run('low')).toBe(false); // 3% < low's 6%
    expect(run('high')).toBe(true); // 3% > high's 1%
  });

  it('flags a room too dark to see', () => {
    expect(new MotionDetector().update(frame(5), 0).dark).toBe(true);
    expect(new MotionDetector().update(frame(120), 0).dark).toBe(false);
  });
});

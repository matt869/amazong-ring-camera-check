import { describe, expect, it } from 'vitest';
import { predictScenarioAlert } from '../lib/demo';
import type { DemoScenario } from '../lib/ring/mock';
import { at, devices, settings } from './helpers';

const predict = (scenario: DemoScenario, now: number) =>
  predictScenarioAlert({ now, settings, devices, scenario, anchor: now });

describe('demo scenario timing', () => {
  it('says when a scenario applied in the small hours will show its alert', () => {
    const morning = predict('quiet-morning', at('01:00'))!;
    expect(morning).toBeGreaterThanOrEqual(at('08:00'));
    expect(morning).toBeLessThanOrEqual(at('10:30'));

    const door = predict('night-door', at('01:00'))!;
    expect(door).toBeGreaterThanOrEqual(at('02:40'));
    expect(door).toBeLessThanOrEqual(at('02:45'));

    const outing = predict('long-outing', at('01:00'))!;
    expect(outing).toBeGreaterThanOrEqual(at('19:00'));
    expect(outing).toBeLessThanOrEqual(at('19:05'));
  });

  it('fires at once when the moment has already passed', () => {
    expect(predict('quiet-morning', at('11:00'))).toBe(at('11:00'));
  });

  it('is null when the scenario cannot show today, or has no alert of its own', () => {
    // Applied at 1am, "sleeps in and gets up 10 minutes from now" is before any morning.
    expect(predict('late-start', at('01:00'))).toBeNull();
    expect(predict('normal', at('11:00'))).toBeNull();
    expect(predict('gradual-decline', at('11:00'))).toBeNull();
  });
});

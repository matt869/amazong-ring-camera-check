import { describe, expect, it } from 'vitest';
import { detectOutings, inferPresence } from '../lib/routine/presence';
import { at, devices, ev, motion } from './helpers';

const out = (id: string, hhmm: string) => ev(id, 'door_open', 'back-door', at(hhmm));

describe('detectOutings', () => {
  it('pairs a departure with the next door opening after a quiet house', () => {
    const events = [motion('a', at('13:50')), out('o1', '14:00'), out('o2', '15:10'), motion('b', at('15:12'))];
    expect(detectOutings(events, devices, at('16:00'))).toEqual([{ left: at('14:00'), leftEventId: 'o1', returned: at('15:10') }]);
  });

  it('ignores door openings followed by indoor motion (taking out the trash)', () => {
    const events = [out('o1', '14:00'), motion('b', at('14:10')), out('o2', '16:00')];
    // (the 16:00 opening is too recent to call an outing yet)
    expect(detectOutings(events, devices, at('16:10'))).toEqual([]);
  });

  it('allows a little motion right as they leave', () => {
    const events = [out('o1', '14:00'), motion('b', at('14:01')), out('o2', '15:00')];
    expect(detectOutings(events, devices, at('16:00'))).toHaveLength(1);
  });

  it('does not count outdoor doorbell motion as being inside', () => {
    const events = [out('o1', '14:00'), ev('d', 'motion', 'front-door', at('14:30'))];
    expect(detectOutings(events, devices, at('15:00'))).toEqual([{ left: at('14:00'), leftEventId: 'o1', returned: null }]);
  });

  it('needs at least 20 quiet minutes before calling it an outing', () => {
    expect(detectOutings([out('o1', '14:00')], devices, at('14:15'))).toEqual([]);
  });
});

describe('inferPresence', () => {
  it('is away while an outing is open', () => {
    const p = inferPresence([motion('a', at('13:00')), out('o1', '14:00')], devices, at('15:00'));
    expect(p.state).toBe('away');
    expect(p.since).toBe(at('14:00'));
  });

  it('is home after they come back', () => {
    const p = inferPresence([out('o1', '14:00'), out('o2', '15:00'), motion('b', at('15:05'))], devices, at('16:00'));
    expect(p.state).toBe('home');
    expect(p.lastActivity?.id).toBe('b');
  });

  it('is unknown without any activity', () => {
    expect(inferPresence([ev('d', 'ding', 'front-door', at('09:00'))], devices, at('10:00')).state).toBe('unknown');
  });
});

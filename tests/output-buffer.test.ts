import { describe, it, expect } from 'vitest';
import { OutputBuffer, type BufferedEvent } from '../src/session/output-buffer.js';

function ev(data: string, type: BufferedEvent['type'] = 'text'): BufferedEvent {
  return { type, data, createdAt: Date.now() };
}

describe('OutputBuffer', () => {
  it('append basic — events appear in drain order', () => {
    const buf = new OutputBuffer(50_000);
    buf.append(ev('a'));
    buf.append(ev('b'));
    buf.append(ev('c'));
    expect(buf.size()).toBe(3);
    expect(buf.isEmpty()).toBe(false);
    const drained = buf.drain();
    expect(drained.map((e) => e.data)).toEqual(['a', 'b', 'c']);
  });

  it('drain resets bytes and events', () => {
    const buf = new OutputBuffer(50_000);
    buf.append(ev('hello'));
    buf.append(ev('world'));
    expect(buf.bytesUsed()).toBe(10);
    expect(buf.size()).toBe(2);
    const drained = buf.drain();
    expect(drained).toHaveLength(2);
    expect(buf.size()).toBe(0);
    expect(buf.bytesUsed()).toBe(0);
    expect(buf.isEmpty()).toBe(true);
    // Second drain should return empty array
    expect(buf.drain()).toEqual([]);
  });

  it('cap not exceeded — small events fit, no drop', () => {
    const buf = new OutputBuffer(1000);
    for (let i = 0; i < 10; i++) buf.append(ev(`line-${i}`));
    expect(buf.size()).toBe(10);
    // Should be exact sum of bytes
    const expectedBytes = Array.from({ length: 10 }, (_, i) => `line-${i}`.length).reduce(
      (a, b) => a + b,
      0,
    );
    expect(buf.bytesUsed()).toBe(expectedBytes);
    const drained = buf.drain();
    expect(drained).toHaveLength(10);
    expect(drained.every((e) => e.type === 'text')).toBe(true);
  });

  it('cap exceeded — middle dropped, first 2 + marker + last 2 remain', () => {
    // Cap = 100 bytes. Push 10 events of 20 bytes each => 200 bytes total.
    const buf = new OutputBuffer(100);
    const payload = 'x'.repeat(20); // 20 bytes
    for (let i = 0; i < 10; i++) {
      buf.append(ev(`${i.toString().padStart(2, '0')}-${payload.slice(0, 17)}`));
      // each event data is exactly 20 bytes
    }
    expect(buf.size()).toBe(5); // first 2 + marker + last 2
    const drained = buf.drain();
    expect(drained).toHaveLength(5);
    // First two preserved
    expect(drained[0].data.startsWith('00-')).toBe(true);
    expect(drained[1].data.startsWith('01-')).toBe(true);
    // Marker in the middle
    expect(drained[2].type).toBe('status');
    expect(drained[2].data).toMatch(/^… \[\d+ chunks omitted\] …$/);
    // Last two preserved
    expect(drained[3].data.startsWith('08-')).toBe(true);
    expect(drained[4].data.startsWith('09-')).toBe(true);
  });

  it('cap exceeded MULTIPLE TIMES — recursive trimming works', () => {
    // Use a tiny cap so each append after fill triggers another trim.
    const buf = new OutputBuffer(50);
    // First load up to 6 events of 15 bytes => 90 bytes, will trim once.
    for (let i = 0; i < 6; i++) buf.append(ev(`evt-${i}-zzz`.padEnd(15, '_')));
    expect(buf.size()).toBe(5); // collapsed: first 2 + marker + last 2

    // Snapshot marker count before more appends
    const beforeMarker = buf.drain().find((e) => e.type === 'status');
    expect(beforeMarker).toBeDefined();

    // Now stress: append in batches and ensure each trim collapses correctly.
    const buf2 = new OutputBuffer(50);
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 6; i++) {
        buf2.append(ev(`r${round}i${i}`.padEnd(15, '_')));
      }
      // After each batch, buffer must satisfy invariant
      expect(buf2.size()).toBeLessThanOrEqual(5);
    }
    // Final state: still bounded
    expect(buf2.size()).toBeLessThanOrEqual(5);
    const drained2 = buf2.drain();
    // Must contain at least one status marker since we trimmed
    expect(drained2.some((e) => e.type === 'status')).toBe(true);
    // First two events should be from the very first round
    expect(drained2[0].data.startsWith('r0i0')).toBe(true);
    expect(drained2[1].data.startsWith('r0i1')).toBe(true);
    // Last event should be from final round
    expect(drained2[drained2.length - 1].data.startsWith('r4i5')).toBe(true);
  });

  it('byte tracking correctness after multiple appends + drops', () => {
    const buf = new OutputBuffer(60);
    // Append small events first (sum below cap)
    buf.append(ev('aa')); // 2
    buf.append(ev('bb')); // 2
    buf.append(ev('cc')); // 2
    expect(buf.bytesUsed()).toBe(6);

    // Add more to exceed cap (cap 60)
    for (let i = 0; i < 8; i++) buf.append(ev('z'.repeat(10))); // 8 * 10 = 80
    // Total before trim would be 86 bytes across 11 events; trim must run
    expect(buf.size()).toBe(5);

    // bytesUsed should equal sum of remaining event.data lengths
    const drained = buf.drain();
    const expected = drained.reduce((s, e) => s + e.data.length, 0);
    // After drain, internal bytes are 0 — verify mid-state via re-append
    const buf2 = new OutputBuffer(60);
    drained.forEach((e) => buf2.append(e));
    expect(buf2.bytesUsed()).toBe(expected);
  });

  it('empty buffer drain returns []', () => {
    const buf = new OutputBuffer();
    expect(buf.isEmpty()).toBe(true);
    expect(buf.size()).toBe(0);
    expect(buf.bytesUsed()).toBe(0);
    expect(buf.drain()).toEqual([]);
  });

  it('very large single event > cap — at least keep the marker (edge case)', () => {
    const buf = new OutputBuffer(100);
    // First fill with some small events
    buf.append(ev('a'));
    buf.append(ev('b'));
    buf.append(ev('c'));
    buf.append(ev('d'));
    buf.append(ev('e'));
    // Now append a huge single event well above cap
    const huge = 'X'.repeat(500);
    buf.append(ev(huge));

    // Buffer must trim down. With 6 events, drop count = 2 → length = 5.
    // The huge event is preserved (it's the last one).
    expect(buf.size()).toBe(5);
    const drained = buf.drain();
    // First two preserved
    expect(drained[0].data).toBe('a');
    expect(drained[1].data).toBe('b');
    // Marker present
    expect(drained[2].type).toBe('status');
    expect(drained[2].data).toMatch(/chunks omitted/);
    // Huge event preserved as last
    expect(drained[4].data).toBe(huge);
    expect(drained[4].data.length).toBe(500);
  });

  it('event count below 5 is never trimmed even if oversized', () => {
    const buf = new OutputBuffer(10);
    // Append 4 events totalling far more than 10 bytes
    buf.append(ev('aaaaaaaaaa')); // 10
    buf.append(ev('bbbbbbbbbb')); // 10
    buf.append(ev('cccccccccc')); // 10
    buf.append(ev('dddddddddd')); // 10
    // events.length must be > 4 to trim, so all 4 remain
    expect(buf.size()).toBe(4);
    expect(buf.bytesUsed()).toBe(40);
    // Add the 5th — now length is 5, still not > 4? Yes 5 > 4 — trim kicks in
    buf.append(ev('eeeeeeeeee')); // 10
    expect(buf.size()).toBe(5);
    const drained = buf.drain();
    // 5 events: first 2 + marker (replacing 1 middle event) + last 2
    expect(drained[0].data).toBe('aaaaaaaaaa');
    expect(drained[1].data).toBe('bbbbbbbbbb');
    expect(drained[2].type).toBe('status');
    expect(drained[3].data).toBe('dddddddddd');
    expect(drained[4].data).toBe('eeeeeeeeee');
  });
});

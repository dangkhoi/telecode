/**
 * Per-session in-RAM output buffer (v0.8 §3.1).
 *
 * Holds formatted event lines while the owning session is BACKGROUND
 * (not the currently active session for its chat). When the user switches
 * to the session, the buffer is drained and flushed as a catch-up message.
 *
 * Overflow policy (when bytes exceed cap):
 *   - Keep first 2 + last 2 events.
 *   - Replace middle slice with a single `status` marker:
 *       `… [N chunks omitted] …`
 *     where N is the number of dropped events.
 *   - Recalculate byte count from the dropped events plus the marker.
 *   - The loop may execute multiple times if a single very large append
 *     still leaves the buffer over cap; eventually the buffer collapses
 *     to length 4 (first 2 + last 2) and the marker keeps the user
 *     informed that data was lost.
 *   - Edge case: a single event larger than cap cannot be trimmed away
 *     (we never drop user events entirely). The buffer keeps it and
 *     reports bytesUsed > capBytes — flush callers decide how to split.
 *
 * Pure data structure: no I/O, no logger, no time provider other than
 * `Date.now()` for marker `createdAt` (acceptable; not part of contract).
 */

export interface BufferedEvent {
  type: 'text' | 'tool_use' | 'status';
  data: string; // formatted line ready to flush to chat
  createdAt: number; // unix ms
}

export class OutputBuffer {
  private events: BufferedEvent[] = [];
  private bytes = 0;

  constructor(private readonly capBytes: number = 50_000) {}

  /** Append an event, trimming the middle if total bytes exceed the cap. */
  append(event: BufferedEvent): void {
    this.events.push(event);
    this.bytes += event.data.length;

    // Trim middle while over cap. We need events.length > 4 to keep
    // (first 2 + marker + last 2). After one trim length collapses to 5.
    // If still over cap (e.g. cap < marker size + 4 huge events, or
    // last event is itself > cap), no further trim helps — break to avoid
    // an infinite loop where marker overhead cancels each iteration's gain.
    while (this.bytes > this.capBytes && this.events.length > 4) {
      const dropCount = this.events.length - 4;
      const marker: BufferedEvent = {
        type: 'status',
        data: `… [${dropCount} chunks omitted] …`,
        createdAt: Date.now(),
      };
      const dropped = this.events.splice(2, dropCount, marker);
      const droppedBytes = dropped.reduce((sum, e) => sum + e.data.length, 0);
      const before = this.bytes;
      this.bytes = this.bytes - droppedBytes + marker.data.length;
      // Guarantee progress: if the marker is no smaller than what we
      // removed (only possible when dropCount==1 and the dropped event
      // was tinier than the marker text), stop trimming. The buffer is
      // already collapsed to the canonical 5-event shape.
      if (this.bytes >= before) break;
    }
  }

  /** Return all events and reset internal state. */
  drain(): BufferedEvent[] {
    const out = this.events;
    this.events = [];
    this.bytes = 0;
    return out;
  }

  /** Number of buffered events (includes marker if trimmed). */
  size(): number {
    return this.events.length;
  }

  /** Current bytes accounted for in the buffer (sum of event.data lengths). */
  bytesUsed(): number {
    return this.bytes;
  }

  /** True when no events are buffered. */
  isEmpty(): boolean {
    return this.events.length === 0;
  }
}

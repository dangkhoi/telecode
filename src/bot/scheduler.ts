import { logger } from '../util/logger.js';
import type { SessionStore } from '../session/store.js';

export interface SchedulerDeps {
  store: SessionStore;
  onTrigger: (schedule: ScheduleRow) => Promise<void>;
}

export interface ScheduleRow {
  id: number;
  chat_id: number;
  name: string;
  cron: string;
  agent: string;
  prompt: string;
  project_id: number | null;
  enabled: number;
  last_run_at: number | null;
  created_at: number;
}

/**
 * Simple cron parser supporting 5-field format: min hour dom mon dow
 * Supports: numbers, *, *​/N (step), comma-separated values
 */
export function cronMatches(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minF, hourF, domF, monF, dowF] = parts;
  return (
    fieldMatches(minF!, date.getMinutes()) &&
    fieldMatches(hourF!, date.getHours()) &&
    fieldMatches(domF!, date.getDate()) &&
    fieldMatches(monF!, date.getMonth() + 1) &&
    fieldMatches(dowF!, date.getDay())
  );
}

function fieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return !isNaN(step) && step > 0 && value % step === 0;
  }
  const values = field.split(',').map(s => parseInt(s, 10));
  return values.includes(value);
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastTickMinute = -1;

  constructor(private readonly deps: SchedulerDeps) {}

  /** Start the scheduler. Ticks every 30s, fires at most once per minute per schedule. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 30_000);
    logger.info('scheduler started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const currentMinute = now.getHours() * 60 + now.getMinutes();
    if (currentMinute === this.lastTickMinute) return;
    this.lastTickMinute = currentMinute;

    const schedules = this.deps.store.getEnabledSchedules() as ScheduleRow[];
    for (const sched of schedules) {
      if (!cronMatches(sched.cron, now)) continue;
      try {
        this.deps.store.updateScheduleLastRun(sched.id);
        await this.deps.onTrigger(sched);
      } catch (err) {
        logger.warn({ err: String(err), schedule: sched.name }, 'scheduler trigger failed');
      }
    }
  }
}

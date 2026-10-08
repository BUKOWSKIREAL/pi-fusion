import { randomUUID } from 'node:crypto';
import type { Usage } from '@earendil-works/pi-ai';
import { addUsage, parseModel, zeroUsage, type Checkpoint, type FusionState, type RunRecord } from './state.ts';

export interface DriverResult { report: string; failed: boolean; usage: Usage }
export interface MaintenanceResult { usage: Usage; error?: string }
export interface SidekickDriver {
  run(message: string, onProgress: (text: string) => void, onActivity?: (active: boolean) => void): Promise<DriverResult>;
  // False means the run settled before the update could be delivered.
  steer(message: string): Promise<boolean>;
  abort(): Promise<void>;
  checkpoint(): Checkpoint | undefined;
  usage?(): Usage;
  modelInfo?(): { model: string; thinking: string };
  // Idle-only maintenance; both reject while a handoff is in flight.
  assignModel?(model: string): Promise<void>;
  compact?(): Promise<MaintenanceResult>;
  dispose(): void;
}
export interface ControllerHooks {
  create(): Promise<SidekickDriver>;
  changed(): void;
  completed(run: RunRecord): void;
}
interface Job {
  record: RunRecord;
  done: Promise<void>;
  background: boolean;
  waiters: number;
  notified: boolean;
  cancelReason?: string;
}
export interface WaitResult { run?: RunRecord; timedOut?: boolean; interrupted?: boolean }

export class FusionController {
  private driver?: SidekickDriver;
  private active?: Job;
  private gate: Promise<unknown> = Promise.resolve();
  private closed = false;
  private maintaining = false;
  private listeners = new Set<(text: string) => void>();
  progress = '';
  modelActive = false;
  constructor(readonly state: FusionState, private hooks: ControllerHooks) {}
  get running() { return !!this.active || this.maintaining; }
  get modelInfo() { return this.driver?.modelInfo?.(); }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.gate.then(fn, fn);
    this.gate = next.catch(() => {});
    return next;
  }
  private save() {
    this.state.checkpoint = this.driver?.checkpoint() ?? this.state.checkpoint;
    this.hooks.changed();
  }
  subscribe(listener: (text: string) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async dispatch(message: string, background: boolean): Promise<{ run: RunRecord; steered: boolean }> {
    if (!message.trim()) throw new Error('A non-empty brief is required.');
    return this.exclusive(async () => {
      if (this.closed) throw new Error('Fusion session is closed.');
      if (!this.state.enabled) throw new Error('Fusion is off. Enable it with /fusion on.');
      if (!this.driver) this.driver = await this.hooks.create();
      if (this.closed) { this.driver.dispose(); throw new Error('Fusion session closed during startup.'); }
      if (this.active) {
        const job = this.active;
        if (await this.driver.steer(message)) {
          job.background ||= background;
          return { run: structuredClone(job.record), steered: true };
        }
        await job.done;
      }
      const record: RunRecord = { id: randomUUID(), status: 'running', startedAt: Date.now(),
        report: '', usage: zeroUsage(), claimed: false };
      const job: Job = { record, done: Promise.resolve(), background, waiters: 0, notified: false };
      this.active = job;
      this.state.last = record;
      this.progress = 'Starting handoff';
      this.save();
      job.done = this.execute(job, message);
      return { run: structuredClone(record), steered: false };
    });
  }
  private async execute(job: Job, message: string) {
    const timer = setTimeout(() => { void this.stop('Handoff time limit reached.').catch(() => {}); }, this.state.config.timeoutMs);
    try {
      const result = await this.driver!.run(message, (text) => {
        this.progress = text;
        job.record.usage = this.driver?.usage?.() ?? job.record.usage;
        this.save();
        for (const listener of this.listeners) listener(text);
      }, (active) => {
        this.modelActive = active;
        this.hooks.changed();
      });
      job.record.status = job.cancelReason ? 'cancelled' : result.failed ? 'failed' : 'completed';
      job.record.report = job.cancelReason ? `${job.cancelReason}\n${result.report}` : result.report;
      job.record.usage = result.usage;
    } catch (error) {
      job.record.status = job.cancelReason ? 'cancelled' : 'failed';
      job.record.report = job.cancelReason ?? String(error);
      job.record.usage = this.driver?.usage?.() ?? job.record.usage;
    } finally {
      clearTimeout(timer);
      this.modelActive = false;
      job.record.endedAt = Date.now();
      this.state.pendingUsage = addUsage(this.state.pendingUsage, job.record.usage);
      this.active = undefined;
      this.progress = job.record.status;
      this.save();
      this.notify(job);
    }
  }
  private notify(job: Job) {
    if (!this.closed && job.background && !job.waiters && !job.notified && job.record.status !== 'running') {
      job.notified = true;
      this.hooks.completed(structuredClone(job.record));
    }
  }
  async wait(timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    const job = this.active;
    if (!job) return { run: this.state.last && structuredClone(this.state.last) };
    job.waiters++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const outcome = await Promise.race([
        job.done.then(() => 'done' as const),
        new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); }),
        new Promise<'abort'>(resolve => {
          onAbort = () => {
            void this.stop('Lead interrupted the blocking handoff. Context retained.').catch(() => {});
            resolve('abort');
          };
          if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      if (outcome === 'timeout') job.background = true;
      if (outcome === 'done') job.notified = true;
      return { run: structuredClone(job.record), timedOut: outcome === 'timeout', interrupted: outcome === 'abort' };
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      job.waiters--;
      // A blocking caller receives the report itself. A timed-out wait becomes background work.
      if (!signal?.aborted) this.notify(job);
    }
  }
  async stop(reason: string) {
    if (this.maintaining) {
      await this.driver?.abort();
      await this.gate;
      // Fall through: a dispatch queued behind maintenance must not escape this stop.
    }
    const job = this.active;
    if (!job) return;
    job.cancelReason = reason;
    // Never wake the lead solely because the user cancelled a handoff.
    job.background = false;
    await this.driver?.abort();
    await job.done;
  }
  // Branch-local physical model for the persistent child; the default is untouched.
  async assignModel(model: string) {
    const reference = parseModel(model);
    return this.exclusive(async () => {
      if (this.closed) throw new Error('Fusion session is closed.');
      if (this.active) throw new Error('Stop the active sidekick before changing its assignment.');
      if (this.driver) {
        if (!this.driver.assignModel) throw new Error('Sidekick model assignment is unsupported.');
        await this.driver.assignModel(reference);
      }
      this.state.assignment = { model: reference };
      this.save();
    });
  }
  // Pi scheduled compaction: summary requests under the current model (a split turn uses two), with the
  // delivered handoff text pinned by the child extension. Not an async apply.
  async compact() {
    return this.exclusive(async () => {
      if (this.closed) throw new Error('Fusion session is closed.');
      if (this.active) throw new Error('Stop the active sidekick before compacting its context.');
      if (!this.state.enabled) throw new Error('Fusion is off. Enable it with /fusion on.');
      if (!this.driver) this.driver = await this.hooks.create();
      if (this.closed) { this.driver.dispose(); this.driver = undefined; throw new Error('Fusion session closed during startup.'); }
      if (!this.driver.compact) throw new Error('Sidekick compaction is unsupported.');
      this.maintaining = true;
      this.progress = 'Compacting sidekick';
      this.hooks.changed();
      try {
        const result = await this.driver.compact();
        this.state.pendingUsage = addUsage(this.state.pendingUsage, result.usage);
        if (result.error) throw new Error(result.error);
      } finally {
        this.maintaining = false;
        this.progress = this.state.last?.status ?? 'ready';
        this.save();
      }
    });
  }
  claimUsage(): Usage {
    const usage = this.state.pendingUsage;
    this.state.pendingUsage = zeroUsage();
    if (this.state.last?.status !== 'running' && this.state.last) this.state.last.claimed = true;
    this.save();
    return usage;
  }
  async release() {
    await this.exclusive(async () => {
      if (this.active) throw new Error('Stop the active sidekick before changing its configuration.');
      this.save();
      this.driver?.dispose();
      this.driver = undefined;
    });
  }
  async close() {
    this.closed = true;
    // Aborting the maintenance operation lets its queued exclusive block unwind.
    if (this.maintaining) await this.driver?.abort();
    await this.gate;
    await this.stop('Session closed; handoff cancelled. Context retained.');
    this.save();
    this.driver?.dispose();
    this.driver = undefined;
    this.listeners.clear();
  }
}

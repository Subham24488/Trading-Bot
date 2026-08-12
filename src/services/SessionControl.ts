import type { SessionInstrument } from '../domain.js';

export class SessionControl {
  private running = false;
  private instruments: SessionInstrument[] = [];
  private startedAt: Date | null = null;
  private lastSnapshotAt: Date | null = null;

  public isRunning(): boolean {
    return this.running;
  }

  public getInstruments(): SessionInstrument[] {
    return [...this.instruments];
  }

  public getStartedAt(): Date | null {
    return this.startedAt;
  }

  public getLastSnapshotAt(): Date | null {
    return this.lastSnapshotAt;
  }

  public start(instruments: SessionInstrument[]): void {
    this.running = true;
    this.instruments = [...instruments];
    this.startedAt = new Date();
    this.lastSnapshotAt = null;
  }

  public markSnapshot(at: Date = new Date()): void {
    this.lastSnapshotAt = at;
  }

  public stop(): void {
    this.running = false;
    this.instruments = [];
    this.startedAt = null;
    this.lastSnapshotAt = null;
  }
}

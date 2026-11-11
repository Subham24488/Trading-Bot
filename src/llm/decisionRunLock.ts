export type DecisionRunKind = 'live' | 'simulation';

const RUN_LABELS: Record<DecisionRunKind, string> = {
  live: 'The live decision loop',
  simulation: 'A simulated replay',
};

/** Only one decision run at a time: the live loop or a simulated replay. */
export class DecisionRunLock {
  private holder: DecisionRunKind | null = null;

  public current(): DecisionRunKind | null {
    return this.holder;
  }

  /** Throws 409 while another run holds the lock. */
  public acquire(kind: DecisionRunKind): void {
    if (this.holder) {
      throw Object.assign(
        new Error(
          `${RUN_LABELS[this.holder]} is running; only one decision run is allowed at a time.`,
        ),
        { statusCode: 409 },
      );
    }
    this.holder = kind;
  }

  public release(kind: DecisionRunKind): void {
    if (this.holder === kind) {
      this.holder = null;
    }
  }
}

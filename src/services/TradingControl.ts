export class TradingControl {
  private paused = true;
  private reason: string | null =
    'Awaiting supported daily broker authorisation and readiness check.';

  public pause(reason: string): void {
    this.paused = true;
    this.reason = reason;
  }

  public resume(): void {
    this.paused = false;
    this.reason = null;
  }

  public snapshot(): { paused: boolean; reason: string | null } {
    return { paused: this.paused, reason: this.reason };
  }
}

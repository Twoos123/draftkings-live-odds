import type { LatencyStats } from "./odds/types";

/** Fixed-size window of recent samples with percentile readout. */
export class RollingWindow {
  private samples: number[] = [];

  constructor(private readonly size = 200) {}

  push(value: number) {
    if (!Number.isFinite(value)) return;
    this.samples.push(value);
    if (this.samples.length > this.size) this.samples.shift();
  }

  clear() {
    this.samples = [];
  }

  stats(): LatencyStats | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    return { p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), n: sorted.length };
  }
}

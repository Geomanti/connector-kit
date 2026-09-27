/**
 * Minimal Prometheus text-exposition metrics.
 *
 * Deliberately dependency-free: the same design decision as the Python
 * service this mirrors — instrument the code path, but do not make the
 * instrumentation a deployment prerequisite.
 *
 * Note on the histogram: Prometheus semantics require *cumulative* buckets,
 * i.e. `le="0.5"` counts every observation <= 0.5, not just those in (0.1, 0.5].
 * Counts are therefore stored per-bucket and accumulated at render time.
 */

export interface MetricLabels {
  [key: string]: string | number;
}

function labelKey(labels: MetricLabels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`).join(",");
}

export class Counter {
  private values = new Map<string, number>();
  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: string[] = [],
  ) {}

  inc(labels: MetricLabels = {}, by = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
      return lines;
    }
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${key ? `{${key}}` : ""} ${value}`);
    }
    return lines;
  }
}

/**
 * Histogram with fixed buckets, rendered with cumulative counts so percentile
 * latency is computable at scrape time.
 */
export class Histogram {
  /** Per-bucket (non-cumulative) counts, plus a trailing +Inf slot. */
  private counts = new Map<string, number[]>();
  private sums = new Map<string, number>();
  private totals = new Map<string, number>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    buckets: number[],
    public readonly labelNames: string[] = [],
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  public readonly buckets: number[];

  observe(value: number, labels: MetricLabels = {}): void {
    const key = labelKey(labels);
    let row = this.counts.get(key);
    if (!row) {
      row = new Array<number>(this.buckets.length + 1).fill(0);
      this.counts.set(key, row);
    }
    // Find the first bucket whose upper bound contains the value.
    let idx = this.buckets.length;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) {
        idx = i;
        break;
      }
    }
    row[idx] = (row[idx] ?? 0) + 1;
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.totals.set(key, (this.totals.get(key) ?? 0) + 1);
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, row] of this.counts) {
      // Accumulate: bucket i reports the count of everything <= its bound.
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative += row[i] ?? 0;
        const labels = key ? `${key},le="${this.buckets[i]}"` : `le="${this.buckets[i]}"`;
        lines.push(`${this.name}_bucket{${labels}} ${cumulative}`);
      }
      const total = this.totals.get(key) ?? 0;
      const infLabels = key ? `${key},le="+Inf"` : `le="+Inf"`;
      lines.push(`${this.name}_bucket{${infLabels}} ${total}`);
      lines.push(`${this.name}_sum${key ? `{${key}}` : ""} ${this.sums.get(key) ?? 0}`);
      lines.push(`${this.name}_count${key ? `{${key}}` : ""} ${total}`);
    }
    return lines;
  }
}

export class Registry {
  private metrics: { render(): string[] }[] = [];

  register<T extends { render(): string[] }>(metric: T): T {
    this.metrics.push(metric);
    return metric;
  }

  render(): string {
    return this.metrics.map((m) => m.render().join("\n")).join("\n") + "\n";
  }
}

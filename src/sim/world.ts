import type { z } from "zod";
import type { Clock } from "../core/clock.js";
import { VirtualClock } from "../core/clock.js";
import { createRng, type Rng } from "../core/rng.js";
import {
  BASELINE,
  INITIAL_CONFIG,
  INITIAL_FLAGS,
  INITIAL_VERSIONS,
  MINUTE_MS,
  NOISE,
  REPORTED_METRICS,
  SIM_EPOCH_MS,
  cloneMetrics,
  type MinuteMetrics,
} from "./baseline.js";
import type { DistributiveOmit, EffectContext, IncidentScript } from "./incident.js";
import {
  SERVICES,
  TimelineEventSchema,
  type Alert,
  type GroundTruth,
  type LogLevel,
  type LogLine,
  type MetricName,
  type MetricPoint,
  type Service,
  type Source,
  type TimelineEvent,
  type WorldState,
} from "./types.js";

/**
 * An event to record "now" (time and id are assigned by the world). Input
 * type, so fields with zod defaults (deploy `config`) may be omitted.
 */
export type NewEvent = DistributiveOmit<z.input<typeof TimelineEventSchema>, "t" | "id">;

export interface MetricQuery {
  service: Service;
  metric: MetricName;
  from: number;
  to: number;
  source?: Source;
}

export interface LogQuery {
  from: number;
  to: number;
  service?: Service;
  level?: LogLevel;
  contains?: string;
}

export interface EventQuery {
  from: number;
  to: number;
  kind?: TimelineEvent["kind"];
  service?: Service;
}

interface MinuteSample {
  metrics: MetricPoint[];
  logs: LogLine[];
}

export interface WorldOptions {
  incident: IncidentScript;
  seed: number;
  /** Defaults to a VirtualClock set to the moment the alert fires. */
  clock?: Clock;
}

/**
 * Deterministic simulation of one incident.
 *
 * Every minute of telemetry is a pure function of (seed, incident, state at
 * that minute). Nothing is pre-generated: queries compute minutes on demand
 * and cache those that can no longer change. Writes (rollback, flag flip, ...)
 * append timeline events stamped with the current clock time, so they change
 * the telemetry from that point onward — just like a real fix would.
 */
export class World {
  readonly incident: IncidentScript;
  readonly seed: number;
  readonly clock: Clock;
  readonly startMs = SIM_EPOCH_MS;
  readonly alert: Alert;
  readonly groundTruth: GroundTruth;

  readonly #rng: Rng;
  readonly #events: TimelineEvent[];
  readonly #cache = new Map<number, MinuteSample>();
  #nextEventId = 1;

  constructor(options: WorldOptions) {
    this.incident = options.incident;
    this.seed = options.seed;
    this.#rng = createRng(options.seed);

    const { alert, rootCause } = options.incident;
    this.alert = {
      id: `alert-${options.incident.id}`,
      title: alert.title,
      service: alert.service,
      metric: alert.metric,
      comparator: alert.comparator,
      threshold: alert.threshold,
      firedAt: this.minuteToMs(alert.minute),
    };
    this.groundTruth = {
      ...rootCause,
      onset: this.minuteToMs(options.incident.onsetMinute),
    };
    this.clock = options.clock ?? new VirtualClock(this.alert.firedAt);

    this.#events = options.incident.timeline
      .map(({ minute, ...event }) => TimelineEventSchema.parse({ ...event, t: this.minuteToMs(minute) }))
      .sort((a, b) => a.t - b.t);
  }

  now(): number {
    return this.clock.now();
  }

  minuteToMs(minute: number): number {
    return this.startMs + minute * MINUTE_MS;
  }

  // ---- Queries ------------------------------------------------------------

  metrics(query: MetricQuery): MetricPoint[] {
    return this.#allMinutes()
      .flatMap((sample) => sample.metrics)
      .filter(
        (p) =>
          p.service === query.service &&
          p.metric === query.metric &&
          (query.source === undefined || p.source === query.source) &&
          p.t >= query.from &&
          p.t <= query.to,
      )
      .sort((a, b) => a.t - b.t || a.source.localeCompare(b.source));
  }

  logs(query: LogQuery): LogLine[] {
    const needle = query.contains?.toLowerCase();
    return this.#allMinutes()
      .flatMap((sample) => sample.logs)
      .filter(
        (l) =>
          l.t >= query.from &&
          l.t <= query.to &&
          (query.service === undefined || l.service === query.service) &&
          (query.level === undefined || l.level === query.level) &&
          (needle === undefined || l.message.toLowerCase().includes(needle)),
      );
  }

  /** Timeline events that have already happened (t <= now). */
  events(query: EventQuery): TimelineEvent[] {
    const now = this.now();
    return this.#events.filter(
      (e) =>
        e.t <= now &&
        e.t >= query.from &&
        e.t <= query.to &&
        (query.kind === undefined || e.kind === query.kind) &&
        (query.service === undefined || ("service" in e && e.service === query.service)),
    );
  }

  /** World state at time t: initial state with every event up to t applied. */
  stateAt(t: number): WorldState {
    const init = this.incident.initialState;
    const state: WorldState = {
      versions: { ...INITIAL_VERSIONS, ...init?.versions },
      flags: { ...INITIAL_FLAGS, ...init?.flags },
      config: { ...INITIAL_CONFIG, ...init?.config },
      lastRestart: {},
      dbPrimary: "db-1",
    };
    for (const e of this.#events) {
      if (e.t > t) break;
      switch (e.kind) {
        case "deploy":
          state.versions[e.service] = e.version;
          Object.assign(state.config, e.config);
          break;
        case "flag":
          state.flags[e.flag] = e.enabled;
          break;
        case "config":
          state.config[e.key] = e.value;
          break;
        case "restart":
          state.lastRestart[e.service] = e.t;
          break;
        case "failover":
          state.dbPrimary = e.to;
          break;
      }
    }
    return state;
  }

  /** The most recent deploy of `service` at or before t. */
  lastDeploy(service: Service, t = this.now()): Extract<TimelineEvent, { kind: "deploy" }> | undefined {
    let found: Extract<TimelineEvent, { kind: "deploy" }> | undefined;
    for (const e of this.#events) {
      if (e.t > t) break;
      if (e.kind === "deploy" && e.service === service) found = e;
    }
    return found;
  }

  // ---- Writes ---------------------------------------------------------------

  /**
   * Append an event at the current time. Only the tools layer (behind policy)
   * should call this; the simulator itself has no permission checks.
   */
  record(event: NewEvent): TimelineEvent {
    const parsed = TimelineEventSchema.parse({
      ...event,
      id: `evt-${String(this.#nextEventId++).padStart(4, "0")}`,
      t: this.now(),
    });
    this.#events.push(parsed);
    // stateAt() relies on time order; sort is stable so same-time events keep insertion order.
    this.#events.sort((a, b) => a.t - b.t);
    return parsed;
  }

  /** Serializable view of everything observable so far. Used for determinism tests. */
  snapshot(): { metrics: MetricPoint[]; logs: LogLine[]; events: TimelineEvent[] } {
    const samples = this.#allMinutes();
    return {
      metrics: samples.flatMap((s) => s.metrics),
      logs: samples.flatMap((s) => s.logs),
      events: this.events({ from: this.startMs, to: this.now() }),
    };
  }

  // ---- Generation -----------------------------------------------------------

  #allMinutes(): MinuteSample[] {
    const last = Math.floor((this.now() - this.startMs) / MINUTE_MS);
    const out: MinuteSample[] = [];
    for (let m = 0; m <= last; m++) out.push(this.#minute(m));
    return out;
  }

  #minute(m: number): MinuteSample {
    const cached = this.#cache.get(m);
    if (cached) return cached;

    const sample = this.#generate(m);
    // New events are always stamped >= now, so a minute that started strictly
    // before now can never change again and is safe to cache.
    if (this.minuteToMs(m) < this.now()) this.#cache.set(m, sample);
    return sample;
  }

  #generate(m: number): MinuteSample {
    const t = this.minuteToMs(m);
    const state = this.stateAt(t);
    const metrics = cloneMetrics(BASELINE);
    const rawLogs: Omit<LogLine, "id" | "source">[] = [];
    const logRng = this.#rng.fork(`logs:${m}`);

    const log = (service: Service, level: LogLevel, message: string) => {
      rawLogs.push({ t: t + logRng.int(0, MINUTE_MS - 1), service, level, message });
    };

    const ctx: EffectContext = {
      minute: m,
      t,
      state,
      metrics,
      minutesSince: (ms) => (t - ms) / MINUTE_MS,
      atMinute: (minute) => this.minuteToMs(minute),
      deployedAt: (service) => this.lastDeploy(service, t)?.t,
      log,
      rng: this.#rng.fork(`effects:${m}`),
    };
    this.incident.effects(ctx);
    propagate(metrics, log);
    clamp(metrics);
    baselineLogs(metrics, log, logRng);

    const logs: LogLine[] = rawLogs
      .sort((a, b) => a.t - b.t)
      .map((l, i) => ({ ...l, id: `log-${m}-${i}`, source: "loki" }));

    return { metrics: this.#observe(m, t, metrics), logs };
  }

  /** Turn true values into what each source reports: add noise and clock skew. */
  #observe(m: number, t: number, metrics: MinuteMetrics): MetricPoint[] {
    const points: MetricPoint[] = [];
    for (const [source, perService] of Object.entries(REPORTED_METRICS) as [Source, Partial<Record<Service, MetricName[]>>][]) {
      const skew = this.incident.sourceSkewMs?.[source] ?? 0;
      for (const service of SERVICES) {
        for (const metric of perService[service] ?? []) {
          // One fork per value keeps every number independent of query order.
          const rng = this.#rng.fork(`metric:${source}:${service}:${metric}:${m}`);
          const noisy = metrics[service][metric] * (1 + rng.float(-NOISE[metric], NOISE[metric]));
          points.push({ service, metric, t: t + skew, value: round(clampValue(metric, noisy)), source });
        }
      }
    }
    return points;
  }
}

/**
 * Push downstream degradation upstream: a slow or failing database makes
 * payments slow/failing, which makes the api slow/failing. Incidents only
 * describe the direct effect; this produces the knock-on symptoms (and the
 * red herrings they create).
 */
function propagate(m: MinuteMetrics, log: (s: Service, l: LogLevel, msg: string) => void): void {
  const dbLatency = Math.max(0, m.database.db_query_p95_ms - BASELINE.database.db_query_p95_ms);
  const dbErrors = Math.max(0, m.database.error_rate - BASELINE.database.error_rate);
  m.payments.latency_p95_ms += dbLatency;
  m.payments.latency_p50_ms += dbLatency * 0.5;
  m.payments.error_rate += dbErrors * 0.8;
  propagatedLogs("payments", "database", dbErrors * 0.8, dbLatency, log);

  const payLatency = Math.max(0, m.payments.latency_p95_ms - BASELINE.payments.latency_p95_ms);
  const payErrors = Math.max(0, m.payments.error_rate - BASELINE.payments.error_rate);
  m.api.latency_p95_ms += payLatency;
  m.api.latency_p50_ms += payLatency * 0.5;
  m.api.error_rate += payErrors * 0.9;
  propagatedLogs("api", "payments", payErrors * 0.9, payLatency, log);
}

function propagatedLogs(
  service: Service,
  upstream: Service,
  errorDelta: number,
  latencyDelta: number,
  log: (s: Service, l: LogLevel, msg: string) => void,
): void {
  const errorLines = Math.min(5, Math.ceil(errorDelta * 20));
  for (let i = 0; i < errorLines && errorDelta > 0.02; i++) {
    log(service, "ERROR", `upstream ${upstream} request failed: 503 Service Unavailable`);
  }
  if (latencyDelta > 500) {
    log(service, "WARN", `slow upstream ${upstream}: +${Math.round(latencyDelta)}ms over baseline`);
  }
}

function baselineLogs(m: MinuteMetrics, log: (s: Service, l: LogLevel, msg: string) => void, rng: Rng): void {
  log("api", "INFO", `GET /v1/checkout 200 in ${Math.round(m.api.latency_p50_ms)}ms`);
  log("payments", "INFO", `POST /charges 201 in ${Math.round(m.payments.latency_p50_ms)}ms`);
  if (rng.chance(0.2)) log("database", "INFO", "checkpoint complete");
}

function clamp(m: MinuteMetrics): void {
  for (const service of SERVICES) {
    for (const metric of Object.keys(m[service]) as MetricName[]) {
      m[service][metric] = clampValue(metric, m[service][metric]);
    }
  }
}

function clampValue(metric: MetricName, value: number): number {
  if (metric === "error_rate") return Math.min(1, Math.max(0, value));
  if (metric.endsWith("_pct")) return Math.min(100, Math.max(0, value));
  return Math.max(0, value);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

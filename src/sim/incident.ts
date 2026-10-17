import type { z } from "zod";
import type { Rng } from "../core/rng.js";
import type { MinuteMetrics } from "./baseline.js";
import type {
  Config,
  LogLevel,
  MetricName,
  RemediationRef,
  RootCauseKind,
  Service,
  Source,
  TimelineEventSchema,
  WorldState,
} from "./types.js";

/** Like Omit, but applied to each member of a union separately. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * A timeline event as written in an incident script: positioned by minute
 * offset instead of absolute time. Uses the zod *input* type so defaulted
 * fields (like `config`) can be left out.
 */
export type ScriptedEvent = DistributiveOmit<z.input<typeof TimelineEventSchema>, "t"> & {
  minute: number;
};

/** What an incident's effects() function sees for one simulated minute. */
export interface EffectContext {
  minute: number;
  /** Epoch ms at the start of this minute. */
  t: number;
  state: WorldState;
  /** Mutable metric values for this minute; start at the healthy baseline. */
  metrics: MinuteMetrics;
  /** Minutes elapsed since `ms` (negative if `ms` is in the future). */
  minutesSince(ms: number): number;
  /** Epoch ms of a script minute offset, e.g. atMinute(30). */
  atMinute(minute: number): number;
  /** When the currently running version of `service` was deployed, if known. */
  deployedAt(service: Service): number | undefined;
  log(service: Service, level: LogLevel, message: string): void;
  /** Random stream unique to this incident + minute. */
  rng: Rng;
}

/**
 * One scripted incident. Authored in minutes relative to the simulation start
 * (minute 0 = SIM_EPOCH_MS) so the scripts read like a story.
 */
export interface IncidentScript {
  id: string;
  title: string;
  description: string;
  onsetMinute: number;
  alert: {
    title: string;
    service: Service;
    metric: MetricName;
    comparator: ">" | "<";
    threshold: number;
    minute: number;
  };
  rootCause: {
    kind: RootCauseKind;
    service: Service;
    ref?: string;
    summary: string;
    remediations: RemediationRef[];
  };
  initialState?: {
    versions?: Partial<Record<Service, string>>;
    flags?: Record<string, boolean>;
    config?: Config;
  };
  timeline: ScriptedEvent[];
  /** Per-source clock skew in ms (positive = source reports later times). */
  sourceSkewMs?: Partial<Record<Source, number>>;
  /** A log substring that appears only once the incident is under way. */
  signatureLog: string;
  effects(ctx: EffectContext): void;
}

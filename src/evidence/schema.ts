import { z } from "zod";
import { LogLevelSchema, MetricNameSchema, ServiceSchema, SourceSchema } from "../sim/types.js";

/**
 * Typed statements extracted from tool output. Each has a `kind`, a
 * `subject` (what it is about) and a `value` (what was observed). The
 * resolver reasons over claims only; it never re-reads raw tool output.
 */
const ChangeClaim = z.object({
  kind: z.literal("change"),
  subject: z.object({
    type: z.enum(["deploy", "flag", "config"]),
    /** Deploy id, flag name or config key. */
    ref: z.string(),
    service: ServiceSchema.optional(),
  }),
  value: z.object({
    at: z.number().int(),
    description: z.string(),
    actor: z.string(),
    /** deploy: code | config | migration | rollback. */
    changeType: z.string().optional(),
    from: z.unknown().optional(),
    to: z.unknown().optional(),
    /** Config keys a deploy changed. */
    config: z.record(z.string(), z.unknown()).optional(),
  }),
});

const MetricAnomalyClaim = z.object({
  kind: z.literal("metric_anomaly"),
  subject: z.object({ service: ServiceSchema, metric: MetricNameSchema }),
  value: z.object({
    direction: z.enum(["up", "down"]),
    baseline: z.number(),
    /** Most deviant value in the sustained deviation. */
    peak: z.number(),
    latest: z.number(),
    /** Start of the first sustained deviation (skew-corrected). */
    onset: z.number().int(),
  }),
});

const MetricNormalClaim = z.object({
  kind: z.literal("metric_normal"),
  subject: z.object({ service: ServiceSchema, metric: MetricNameSchema }),
  value: z.object({ baseline: z.number(), latest: z.number() }),
});

/** Counters like `restarts`: notable whenever non-zero. */
const MetricEventsClaim = z.object({
  kind: z.literal("metric_events"),
  subject: z.object({ service: ServiceSchema, metric: MetricNameSchema }),
  value: z.object({ count: z.number(), times: z.array(z.number().int()) }),
});

const LogPatternClaim = z.object({
  kind: z.literal("log_pattern"),
  subject: z.object({ service: ServiceSchema, template: z.string() }),
  value: z.object({
    level: LogLevelSchema,
    count: z.number().int(),
    firstSeen: z.number().int(),
    lastSeen: z.number().int(),
    sample: z.string(),
  }),
});

/**
 * Text in a log line that tries to instruct the investigator. Recorded as
 * evidence of attempted manipulation; never treated as a cause or acted on.
 */
const SuspiciousInstructionClaim = z.object({
  kind: z.literal("suspicious_instruction"),
  subject: z.object({ service: ServiceSchema, logId: z.string() }),
  value: z.object({ text: z.string(), matched: z.string() }),
});

const ServiceStateClaim = z.object({
  kind: z.literal("service_state"),
  subject: z.object({ service: ServiceSchema }),
  value: z.object({
    version: z.string(),
    lastDeployAt: z.number().int().nullable(),
    lastRestartAt: z.number().int().nullable(),
  }),
});

const ClockSkewClaim = z.object({
  kind: z.literal("clock_skew"),
  subject: z.object({ source: SourceSchema, reference: SourceSchema }),
  value: z.object({
    /** Positive: the source stamps events later than they happened. */
    offsetMs: z.number().int(),
    /** Metrics the estimate was based on. */
    basis: z.array(z.string()),
  }),
});

export const ClaimSchema = z.discriminatedUnion("kind", [
  ChangeClaim,
  MetricAnomalyClaim,
  MetricNormalClaim,
  MetricEventsClaim,
  LogPatternClaim,
  SuspiciousInstructionClaim,
  ServiceStateClaim,
  ClockSkewClaim,
]);
export type Claim = z.infer<typeof ClaimSchema>;
export type ClaimKind = Claim["kind"];

/** Where a claim came from: a telemetry source, or TriageMesh's own cross-checks. */
export const EvidenceSourceSchema = z.union([SourceSchema, z.literal("derived")]);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export const EvidenceSchema = z.object({
  id: z.string(),
  claim: ClaimSchema,
  /** When the observed thing happened (corrected for known clock skew). */
  timestamp: z.number().int(),
  source: EvidenceSourceSchema,
  /** 0..1: how much to trust this source for this claim. */
  reliability: z.number().min(0).max(1),
  /** Plan step that produced it. */
  stepId: z.string(),
  /** A small excerpt of the tool output backing the claim. Untrusted. */
  rawData: z.unknown(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * Prior trust per source. Change records from the deploy and flag services
 * are authoritative; metrics are noisy; logs are free text and may be
 * attacker-influenced. Cross-checks (e.g. detected skew) lower these.
 */
export const SOURCE_RELIABILITY: Record<EvidenceSource, number> = {
  "deploy-service": 0.95,
  "flag-service": 0.95,
  prometheus: 0.9,
  "db-agent": 0.85,
  loki: 0.75,
  derived: 0.8,
};

/** How much a source's reliability drops once its clock is shown to be off. */
export const SKEWED_SOURCE_PENALTY = 0.3;

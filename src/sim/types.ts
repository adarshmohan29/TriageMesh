import { z } from "zod";

// ---- Topology -------------------------------------------------------------

/** Request flow: api -> payments -> database. */
export const ServiceSchema = z.enum(["api", "payments", "database"]);
export type Service = z.infer<typeof ServiceSchema>;
export const SERVICES = ServiceSchema.options;

export const MetricNameSchema = z.enum([
  "latency_p50_ms",
  "latency_p95_ms",
  "error_rate", // fraction 0..1
  "rps",
  "cpu_pct",
  "mem_pct",
  "disk_pct",
  "db_pool_in_use", // payments: connections checked out of its pool
  "db_connections", // database: open client connections
  "db_query_p95_ms",
  "restarts", // process restarts during the minute
]);
export type MetricName = z.infer<typeof MetricNameSchema>;

/** Which sources report telemetry. Different sources may disagree (Phase 8). */
export const SourceSchema = z.enum([
  "prometheus", // primary metrics
  "db-agent", // host agent on the database box
  "loki", // logs
  "deploy-service",
  "flag-service",
]);
export type Source = z.infer<typeof SourceSchema>;

// ---- Telemetry ------------------------------------------------------------

export const MetricPointSchema = z.object({
  service: ServiceSchema,
  metric: MetricNameSchema,
  /** Timestamp as reported by the source (may be skewed). */
  t: z.number().int(),
  value: z.number(),
  source: SourceSchema,
});
export type MetricPoint = z.infer<typeof MetricPointSchema>;

export const LogLevelSchema = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const LogLineSchema = z.object({
  id: z.string(),
  t: z.number().int(),
  service: ServiceSchema,
  level: LogLevelSchema,
  message: z.string(),
  source: z.literal("loki"),
});
export type LogLine = z.infer<typeof LogLineSchema>;

// ---- Timeline events (things that change world state) --------------------

const ConfigValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export const ConfigSchema = z.record(z.string(), ConfigValueSchema);
export type Config = z.infer<typeof ConfigSchema>;

const EventBase = {
  id: z.string(),
  t: z.number().int(),
  actor: z.string(),
};

export const DeployEventSchema = z.object({
  ...EventBase,
  kind: z.literal("deploy"),
  service: ServiceSchema,
  version: z.string(),
  previousVersion: z.string(),
  changeType: z.enum(["code", "config", "migration", "rollback"]),
  description: z.string(),
  /** Config keys this deploy sets; a rollback restores the previous values. */
  config: ConfigSchema.default({}),
  previousConfig: ConfigSchema.default({}),
});

export const FlagEventSchema = z.object({
  ...EventBase,
  kind: z.literal("flag"),
  flag: z.string(),
  enabled: z.boolean(),
  previous: z.boolean(),
});

export const ConfigEventSchema = z.object({
  ...EventBase,
  kind: z.literal("config"),
  key: z.string(),
  value: ConfigValueSchema,
  previous: ConfigValueSchema.optional(),
});

export const RestartEventSchema = z.object({
  ...EventBase,
  kind: z.literal("restart"),
  service: ServiceSchema,
});

export const FailoverEventSchema = z.object({
  ...EventBase,
  kind: z.literal("failover"),
  from: z.string(),
  to: z.string(),
});

export const TimelineEventSchema = z.discriminatedUnion("kind", [
  DeployEventSchema,
  FlagEventSchema,
  ConfigEventSchema,
  RestartEventSchema,
  FailoverEventSchema,
]);
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
export type DeployEvent = z.infer<typeof DeployEventSchema>;
export type FlagEvent = z.infer<typeof FlagEventSchema>;

// ---- World state ----------------------------------------------------------

export interface WorldState {
  versions: Record<Service, string>;
  flags: Record<string, boolean>;
  config: Config;
  /** Epoch ms of the most recent manual restart per service, if any. */
  lastRestart: Partial<Record<Service, number>>;
  dbPrimary: string;
}

// ---- Alerts and ground truth ---------------------------------------------

export const AlertSchema = z.object({
  id: z.string(),
  title: z.string(),
  service: ServiceSchema,
  metric: MetricNameSchema,
  comparator: z.enum([">", "<"]),
  threshold: z.number(),
  firedAt: z.number().int(),
});
export type Alert = z.infer<typeof AlertSchema>;

export const RootCauseKindSchema = z.enum([
  "bad_deploy",
  "flag_change",
  "config_change",
  "schema_migration",
  "external_dependency",
  "cert_expiry",
  "memory_leak",
  "disk_full",
]);
export type RootCauseKind = z.infer<typeof RootCauseKindSchema>;

export const RemediationRefSchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
});
export type RemediationRef = z.infer<typeof RemediationRefSchema>;

export const GroundTruthSchema = z.object({
  kind: RootCauseKindSchema,
  service: ServiceSchema,
  /** Deploy id, flag name, etc. that the root cause points at, when there is one. */
  ref: z.string().optional(),
  onset: z.number().int(),
  summary: z.string(),
  /** Remediations that actually fix the cause (first one is preferred). */
  remediations: z.array(RemediationRefSchema).min(1),
});
export type GroundTruth = z.infer<typeof GroundTruthSchema>;

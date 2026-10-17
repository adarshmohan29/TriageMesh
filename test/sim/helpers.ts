import { VirtualClock } from "../../src/core/clock.js";
import { MINUTE_MS, SIM_EPOCH_MS } from "../../src/sim/baseline.js";
import { getIncident } from "../../src/sim/incidents/index.js";
import type { IncidentScript } from "../../src/sim/incident.js";
import { World } from "../../src/sim/world.js";

/** A world plus its VirtualClock (typed concretely so tests can advance it). */
export function makeWorld(incident: string | IncidentScript, seed = 1): { world: World; clock: VirtualClock } {
  const script = typeof incident === "string" ? getIncident(incident) : incident;
  if (!script) throw new Error(`unknown incident ${String(incident)}`);
  const clock = new VirtualClock(SIM_EPOCH_MS + script.alert.minute * MINUTE_MS);
  return { world: new World({ incident: script, seed, clock }), clock };
}

/** The prometheus value of a metric at an exact minute. */
export function valueAt(world: World, service: Parameters<World["metrics"]>[0]["service"], metric: Parameters<World["metrics"]>[0]["metric"], t: number): number {
  const [point] = world.metrics({ service, metric, from: t, to: t, source: "prometheus" });
  if (!point) throw new Error(`no ${service}.${metric} point at ${t}`);
  return point.value;
}

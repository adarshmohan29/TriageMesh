import { createHash } from "node:crypto";

/**
 * JSON with object keys sorted at every level. JSON.stringify keeps insertion
 * order, so two equal objects built differently would hash differently; the
 * audit chain needs one canonical byte string per value.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const obj = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
  });
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

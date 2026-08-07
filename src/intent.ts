/**
 * Stable JSON representation used for action-intent binding.
 * Object keys are sorted recursively; array order is preserved.
 */
export function canonicalizeIntent(value: unknown): string {
  if (value === null) return "null";

  const type = typeof value;
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type === "number") {
    if (!Number.isFinite(value as number)) {
      throw new TypeError("[keelstack/guard] intent numbers must be finite.");
    }
    return JSON.stringify(value);
  }
  if (type === "bigint") return JSON.stringify(`${String(value)}n`);
  if (type === "undefined") return '"__undefined__"';

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeIntent(item)).join(",")}]`;
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  if (type === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalizeIntent(object[key])}`)
      .join(",")}}`;
  }

  throw new TypeError(
    `[keelstack/guard] intent contains unsupported value of type "${type}".`
  );
}

/** SHA-256 fingerprint of the canonical intent using the Web Crypto API. */
export async function fingerprintIntent(intent: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeIntent(intent));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

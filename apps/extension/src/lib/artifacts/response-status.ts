// apps/extension/src/lib/artifacts/response-status.ts
//
// Pure helpers describing how a brokered fetch result must be turned back
// into a Response in the artifact sandbox. Kept in a normal module (not the
// shim string) so it can be unit-tested without relying on the test
// environment's Response implementation, which is non-conformant in jsdom /
// happy-dom (they do NOT throw for 204+body or status 0, unlike real Chrome).

/**
 * Status codes for which the Fetch spec forbids a response body. Constructing
 * `new Response(body, { status })` with a non-null body for these throws in
 * conformant engines (Chrome). The broker must pass a null body instead.
 */
export const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/** True when a Response for this status must be built with a null body. */
export function isNullBodyStatus(status: number): boolean {
  return NULL_BODY_STATUSES.has(status);
}

/**
 * The body to hand to `new Response(...)` given the broker's status + body.
 * Returns null for null-body statuses (101/204/205/304), otherwise the body
 * unchanged. Mirrors the inline logic in BRIDGE_SHIM_SOURCE.
 */
export function bodyForStatus<T>(status: number, body: T): T | null {
  return isNullBodyStatus(status) ? null : body;
}

/**
 * Static AST check that verifies a `kind: "read"` claim on an `executeOnPage`
 * call. The script body is wrapped in `(async function() { ... })()` at run
 * time but the user-supplied `code` string is what we parse here.
 *
 * "Read" here means **no side effects on the page or its surroundings** —
 * the script returns data without mutating the DOM, modifying storage,
 * issuing network requests, navigating, or otherwise changing observable
 * state. It does NOT mean "no exposure of sensitive data": a read script
 * CAN return cookie strings, localStorage contents, or any DOM text the
 * page exposes. That exfiltration surface is identical to the existing
 * `snapshot` / `readPage` / `extract` tools, all of which run ungated on
 * any origin. Defending against data exfiltration is an outbound-side
 * concern (the network/Python tools) — see the spec's "Non-goals"
 * section. This file's job is to keep "read" scripts from quietly
 * mutating the page.
 *
 * If any of the following appear in the AST, we reject the read claim and
 * the call is gated as if it were `kind: "write"`:
 *
 *   - Network: fetch, XMLHttpRequest, WebSocket, EventSource, navigator.sendBeacon
 *   - Storage WRITES: localStorage/sessionStorage setItem/removeItem/clear,
 *     document.cookie =. (Reads via `.getItem` / cookie reads are NOT
 *     blocked — see the comment on threat model above.)
 *   - IndexedDB: any access (the API doesn't cleanly separate reads from writes)
 *   - DOM mutation: .click(), .submit(), .dispatchEvent(), .requestSubmit(),
 *     and assignments to .value/.checked/.selected/.innerHTML/.outerHTML/
 *     .textContent/.innerText, plus appendChild/removeChild/replaceChild/
 *     insertBefore/replaceWith/remove/setAttribute/removeAttribute/append/
 *     insertAdjacentHTML/insertAdjacentElement/insertAdjacentText, and
 *     document.write / document.writeln.
 *   - Navigation: location.* assignments and method calls (href, pathname,
 *     host, hostname, protocol, search, hash, plus assign/replace);
 *     whole-object `window.location = "..."`; history.*; window.open/close.
 *   - Cross-frame: postMessage
 *   - Code generation: eval, new Function, Function(...) (defeats static analysis)
 *   - Dynamic call-position member access: obj[expr](...) (also defeats analysis)
 *
 * Mutation patterns are checked across both dot-notation (`el.innerHTML`)
 * and string-literal computed access (`el["innerHTML"]`). Fully dynamic
 * computed access (`el[propName]`) is rejected outright in call position
 * and accepted in non-call position (the dynamic value is opaque to us;
 * read-shaped scripts shouldn't need it).
 *
 * The check is an APPROXIMATION. It defends against accidental misclassification,
 * not adversarial code. If the model writes `window["fe" + "tch"]` it bypasses
 * the check — but bypassing the check only matters if the model is also lying
 * about kind, which moves the threat model out of "honest mistake" territory
 * and into "active prompt injection."
 */

import { Parser } from "acorn";
import type { Node } from "acorn";

export type StaticCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Method names whose call is always a write.
 *
 * Receiver-aware exceptions:
 *   - `assign` and `replace` are NOT in this set because they collide with
 *     extremely common read-time idioms (`Object.assign({}, src)`,
 *     `s.replace(/x/, y)`). They are handled separately below: rejection
 *     only fires when the receiver is `location`.
 *
 * Known over-approximations (kept in the set as conservative defaults):
 *   - `open`: collides with `IDBFactory.open`, but indexedDB itself is
 *     blocked via FORBIDDEN_IDENTIFIERS, so the practical false-positive
 *     surface is `window.open`-shaped calls on unrelated objects. Accepted.
 *   - `close`: collides with `IDBDatabase.close` etc. Same reasoning.
 *   - `back` / `forward`: rare property names elsewhere. Low FP risk.
 */
const FORBIDDEN_METHOD_CALLS = new Set([
  "click",
  "submit",
  "requestSubmit",
  "dispatchEvent",
  "setAttribute",
  "removeAttribute",
  "appendChild",
  "removeChild",
  "replaceChild",
  "insertBefore",
  "replaceWith",
  "remove",
  "append", // el.append(child) — sibling of appendChild for nodes/strings
  "insertAdjacentHTML",
  "insertAdjacentElement",
  "insertAdjacentText",
  "write", // document.write
  "writeln", // document.writeln
  "pushState", // history.pushState
  "replaceState", // history.replaceState
  "back", // history.back
  "forward", // history.forward
  "open", // window.open (over-approximates IDBFactory.open)
  "close", // window.close (over-approximates IDBDatabase.close)
  "postMessage",
  "sendBeacon", // navigator.sendBeacon
  "setItem", // localStorage/sessionStorage
  "removeItem",
  "clear",
]);

/**
 * Methods that are only writes when called on `location` (or `window.location`).
 * Checked separately so we don't reject `Object.assign` / `String.replace`.
 */
const LOCATION_ONLY_METHOD_CALLS = new Set(["assign", "replace"]);

/**
 * Property names that are writes only when assigned on a `location`
 * receiver. Assigning to `pathname` / `host` / `hostname` / `protocol` /
 * `search` / `hash` on `location` navigates the page; the same property
 * name on an arbitrary element is a benign string write. Checked
 * separately from {@link FORBIDDEN_ASSIGNED_PROPS}.
 *
 * `href` is intentionally NOT in this set — it's in the catch-all
 * FORBIDDEN_ASSIGNED_PROPS because `el.href = url` (anchor element)
 * is also DOM mutation worth gating.
 */
const LOCATION_ONLY_ASSIGNED_PROPS = new Set([
  "pathname",
  "host",
  "hostname",
  "protocol",
  "search",
  "hash",
]);

/** Property names that, when assigned to, are writes. */
const FORBIDDEN_ASSIGNED_PROPS = new Set([
  "value",
  "checked",
  "selected",
  "innerHTML",
  "outerHTML",
  "textContent",
  "innerText",
  "href", // location.href
]);

/** Identifier names whose mere appearance signals a write capability. */
const FORBIDDEN_IDENTIFIERS = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "indexedDB",
  "eval",
  "Function",
]);

export function staticReadCheck(code: string): StaticCheckResult {
  let ast: Node;
  try {
    // Wrap to match the runtime wrapper so `return` and `await` parse legally.
    // The runtime evaluates `(async function() { <code> })()`; we parse the
    // same shape here so top-level `return` / `await` are valid.
    //
    // Newlines around the user code prevent a trailing `// line comment`
    // from swallowing our closing `})()`.
    ast = Parser.parse(`(async function() {\n${code}\n})()`, {
      ecmaVersion: 2024,
      sourceType: "script",
    });
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to parse script body: ${(err as Error).message}`,
    };
  }

  let rejection: string | null = null;

  walk(ast, (node, parent) => {
    if (rejection) return;

    // Identifier in non-property position: bare reference to a forbidden global.
    if (node.type === "Identifier") {
      const id = node as unknown as { type: "Identifier"; name: string };
      if (FORBIDDEN_IDENTIFIERS.has(id.name)) {
        // Allow when used as a property key:
        //   - obj.fetch (MemberExpression's non-computed `property`)
        //   - { fetch: 1 } (Property's non-computed `key`, including
        //     shorthand and method shorthand)
        //   - class { fetch() {} } (MethodDefinition / PropertyDefinition's
        //     non-computed `key`)
        // The dangerous case in those positions is the assignment itself,
        // caught separately by the AssignmentExpression branch.
        let isPropertyKey = false;
        if (parent) {
          if (parent.type === "MemberExpression") {
            const p = parent as unknown as {
              property: Node;
              computed: boolean;
            };
            isPropertyKey = p.property === node && !p.computed;
          } else if (
            parent.type === "Property" ||
            parent.type === "MethodDefinition" ||
            parent.type === "PropertyDefinition"
          ) {
            const p = parent as unknown as {
              key: Node;
              computed: boolean;
            };
            isPropertyKey = p.key === node && !p.computed;
          }
        }
        if (!isPropertyKey) {
          rejection = `Forbidden identifier in read script: ${id.name}`;
        }
      }
      return;
    }

    // Method calls: obj.method(...) — check the method name.
    if (node.type === "CallExpression") {
      const call = node as unknown as {
        type: "CallExpression";
        callee: Node;
      };
      if (call.callee.type === "MemberExpression") {
        const m = call.callee as unknown as {
          type: "MemberExpression";
          object: Node;
          property: Node;
          computed: boolean;
        };
        // Dynamic member access in call position: obj[expr](...).
        if (m.computed) {
          rejection =
            "Dynamic property access in call position is not allowed in read scripts (defeats static analysis)";
          return;
        }
        if (m.property.type === "Identifier") {
          const name = (m.property as unknown as { name: string }).name;
          if (FORBIDDEN_METHOD_CALLS.has(name)) {
            rejection = `Forbidden method call in read script: .${name}()`;
            return;
          }
          // Receiver-aware: location.assign / location.replace.
          // We don't reject Object.assign or String.prototype.replace.
          if (
            LOCATION_ONLY_METHOD_CALLS.has(name) &&
            isLocationReceiver(m.object)
          ) {
            rejection = `Forbidden method call in read script: location.${name}()`;
            return;
          }
          // Member-expression callee invoking a forbidden global identifier:
          // window.fetch(...), globalThis.eval(...), self.Function(...), etc.
          if (FORBIDDEN_IDENTIFIERS.has(name)) {
            rejection = `Forbidden method call in read script: .${name}() (forbidden global accessed via member expression)`;
            return;
          }
        }
      }
      return;
    }

    // new Function(...) / new XMLHttpRequest() / new x.WebSocket(...) etc.
    if (node.type === "NewExpression") {
      const ne = node as unknown as { type: "NewExpression"; callee: Node };
      if (ne.callee.type === "Identifier") {
        const name = (ne.callee as unknown as { name: string }).name;
        if (FORBIDDEN_IDENTIFIERS.has(name)) {
          rejection = `Forbidden constructor in read script: new ${name}`;
          return;
        }
      } else if (ne.callee.type === "MemberExpression") {
        // new x.WebSocket(...), new window.Function(...), etc.
        const m = ne.callee as unknown as {
          type: "MemberExpression";
          property: Node;
          computed: boolean;
        };
        if (!m.computed && m.property.type === "Identifier") {
          const name = (m.property as unknown as { name: string }).name;
          if (FORBIDDEN_IDENTIFIERS.has(name)) {
            rejection = `Forbidden constructor in read script: new …${name} (forbidden global accessed via member expression)`;
            return;
          }
        }
      }
      return;
    }

    // Assignments: obj.prop = … where prop is a forbidden mutable property.
    // Handles both dot-notation (`a.b`) and string-literal computed access
    // (`a["b"]`); fully dynamic computed access (`a[expr]`) is opaque so
    // we let it through (caller can re-classify as write if they care).
    if (node.type === "AssignmentExpression") {
      const a = node as unknown as {
        type: "AssignmentExpression";
        left: Node;
      };
      if (a.left.type === "MemberExpression") {
        const m = a.left as unknown as {
          type: "MemberExpression";
          object: Node;
          property: Node;
          computed: boolean;
        };
        const propName = readMemberPropertyName(m);
        if (propName !== null) {
          if (FORBIDDEN_ASSIGNED_PROPS.has(propName)) {
            rejection = `Forbidden assignment in read script: .${propName} = …`;
            return;
          }
          // document.cookie = …
          if (
            propName === "cookie" &&
            m.object.type === "Identifier" &&
            (m.object as unknown as { name: string }).name === "document"
          ) {
            rejection = "Forbidden assignment in read script: document.cookie = …";
            return;
          }
          // Receiver-aware: navigation via location.{pathname,host,…} = …
          // Only rejected on a `location` receiver (or `window.location`,
          // `globalThis.location`, etc.) so a benign `obj.pathname = …`
          // on an arbitrary object isn't flagged.
          if (
            LOCATION_ONLY_ASSIGNED_PROPS.has(propName) &&
            isLocationReceiver(m.object)
          ) {
            rejection = `Forbidden assignment in read script: location.${propName} = … (navigation)`;
            return;
          }
          // Whole-object location replacement: `window.location = "..."`,
          // `globalThis.location = "..."`, `self.location = "..."`. The
          // bare `location = "..."` form is an Identifier-target
          // assignment — different AST shape — and we don't reach it
          // here (rare; not handled).
          if (
            propName === "location" &&
            m.object.type === "Identifier" &&
            (() => {
              const name = (m.object as unknown as { name: string }).name;
              return (
                name === "window" ||
                name === "globalThis" ||
                name === "self" ||
                name === "top" ||
                name === "parent"
              );
            })()
          ) {
            rejection = "Forbidden assignment in read script: …location = … (navigation)";
            return;
          }
        }
      }
      return;
    }

    // Update expression: el.value++, el.innerHTML--, etc. The argument is
    // mutated in place, so this is functionally an assignment.
    if (node.type === "UpdateExpression") {
      const u = node as unknown as {
        type: "UpdateExpression";
        argument: Node;
        operator: string;
      };
      if (u.argument.type === "MemberExpression") {
        const m = u.argument as unknown as {
          type: "MemberExpression";
          object: Node;
          property: Node;
          computed: boolean;
        };
        const propName = readMemberPropertyName(m);
        if (propName !== null) {
          if (FORBIDDEN_ASSIGNED_PROPS.has(propName)) {
            rejection = `Forbidden update (${u.operator}) in read script: .${propName}`;
            return;
          }
          if (
            propName === "cookie" &&
            m.object.type === "Identifier" &&
            (m.object as unknown as { name: string }).name === "document"
          ) {
            rejection = `Forbidden update (${u.operator}) in read script: document.cookie`;
            return;
          }
        }
      }
      return;
    }

    // delete obj.prop — also a mutation.
    if (node.type === "UnaryExpression") {
      const ux = node as unknown as {
        type: "UnaryExpression";
        operator: string;
        argument: Node;
      };
      if (ux.operator === "delete" && ux.argument.type === "MemberExpression") {
        const m = ux.argument as unknown as {
          type: "MemberExpression";
          object: Node;
          property: Node;
          computed: boolean;
        };
        const propName = readMemberPropertyName(m);
        if (propName !== null) {
          if (FORBIDDEN_ASSIGNED_PROPS.has(propName)) {
            rejection = `Forbidden delete in read script: delete …${propName}`;
            return;
          }
          if (
            propName === "cookie" &&
            m.object.type === "Identifier" &&
            (m.object as unknown as { name: string }).name === "document"
          ) {
            rejection = "Forbidden delete in read script: delete document.cookie";
            return;
          }
        }
      }
      return;
    }
  });

  if (rejection) return { ok: false, reason: rejection };
  return { ok: true };
}

/**
 * True if the given AST node refers to `location` or `window.location` /
 * `globalThis.location` / `self.location`. Used to scope receiver-aware
 * rejection of `.assign(…)` / `.replace(…)` so we don't flag
 * `Object.assign({}, …)` or `String.prototype.replace`.
 */
function isLocationReceiver(node: Node): boolean {
  if (node.type === "Identifier") {
    return (node as unknown as { name: string }).name === "location";
  }
  if (node.type === "MemberExpression") {
    const m = node as unknown as {
      property: Node;
      computed: boolean;
    };
    if (!m.computed && m.property.type === "Identifier") {
      return (m.property as unknown as { name: string }).name === "location";
    }
  }
  return false;
}

/**
 * Read the property name from a MemberExpression whether the access is
 * dot-notation (`a.b` → `b`) or string-literal computed (`a["b"]` → `b`).
 * Returns `null` for fully dynamic computed access (`a[expr]`); the caller
 * decides what to do with that case (typically: skip — the dynamic
 * value is opaque to static analysis, and we already reject computed
 * call-position elsewhere).
 */
function readMemberPropertyName(member: {
  property: Node;
  computed: boolean;
}): string | null {
  if (!member.computed) {
    if (member.property.type === "Identifier") {
      return (member.property as unknown as { name: string }).name;
    }
    return null;
  }
  // Computed: only string-literal access is statically resolvable.
  if (member.property.type === "Literal") {
    const lit = member.property as unknown as { value: unknown };
    if (typeof lit.value === "string") return lit.value;
  }
  return null;
}

/**
 * Minimal AST walker. We don't need full estree-walker semantics — just
 * pre-order traversal with parent tracking. Unknown node shapes are walked
 * generically by visiting every object-valued child key.
 */
function walk(node: Node, visit: (n: Node, parent: Node | null) => void): void {
  const stack: Array<{ node: Node; parent: Node | null }> = [
    { node, parent: null },
  ];
  while (stack.length > 0) {
    const { node: n, parent } = stack.pop()!;
    visit(n, parent);
    for (const key of Object.keys(n)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") {
        continue;
      }
      const child = (n as unknown as Record<string, unknown>)[key];
      if (child && typeof child === "object") {
        if (Array.isArray(child)) {
          for (const c of child) {
            if (c && typeof c === "object" && "type" in c) {
              stack.push({ node: c as Node, parent: n });
            }
          }
        } else if ("type" in child) {
          stack.push({ node: child as Node, parent: n });
        }
      }
    }
  }
}

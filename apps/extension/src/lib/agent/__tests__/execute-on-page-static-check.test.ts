import { describe, it, expect } from "vitest";
import { staticReadCheck } from "../execute-on-page-static-check";

describe("staticReadCheck — passing (read-shaped) scripts", () => {
  it("accepts a simple querySelector + map read", () => {
    const code = `
      const items = document.querySelectorAll("a.item");
      return Array.from(items).map(a => ({ href: a.href, text: a.textContent }));
    `;
    expect(staticReadCheck(code)).toEqual({ ok: true });
  });

  it("accepts attribute reads via getAttribute", () => {
    const code = `
      return document.querySelector("[data-id]").getAttribute("data-id");
    `;
    expect(staticReadCheck(code)).toEqual({ ok: true });
  });

  it("accepts pure object construction with no DOM mutation", () => {
    const code = `
      const a = { foo: 1 };
      a.foo = 2;
      return a;
    `;
    expect(staticReadCheck(code)).toEqual({ ok: true });
  });

  it("accepts JSON.stringify and Array methods", () => {
    const code = `
      const rows = Array.from(document.querySelectorAll("tr"));
      return JSON.stringify(rows.map(r => r.innerText));
    `;
    expect(staticReadCheck(code)).toEqual({ ok: true });
  });
});

describe("staticReadCheck — rejected (write-shaped) scripts", () => {
  it("rejects fetch", () => {
    const r = staticReadCheck(`return fetch("/api").then(r => r.json());`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/fetch/i);
  });

  it("rejects XMLHttpRequest", () => {
    const r = staticReadCheck(`new XMLHttpRequest().open("GET", "/x");`);
    expect(r.ok).toBe(false);
  });

  it("rejects WebSocket / EventSource / sendBeacon", () => {
    expect(staticReadCheck(`new WebSocket("/ws");`).ok).toBe(false);
    expect(staticReadCheck(`new EventSource("/sse");`).ok).toBe(false);
    expect(staticReadCheck(`navigator.sendBeacon("/x", "y");`).ok).toBe(false);
  });

  it("rejects localStorage / sessionStorage writes", () => {
    expect(staticReadCheck(`localStorage.setItem("k", "v");`).ok).toBe(false);
    expect(staticReadCheck(`sessionStorage.removeItem("k");`).ok).toBe(false);
    expect(staticReadCheck(`localStorage.clear();`).ok).toBe(false);
  });

  it("rejects document.cookie assignment", () => {
    const r = staticReadCheck(`document.cookie = "x=1";`);
    expect(r.ok).toBe(false);
  });

  it("rejects indexedDB access (any)", () => {
    const r = staticReadCheck(`const r = indexedDB.open("x"); return r;`);
    expect(r.ok).toBe(false);
  });

  it("rejects DOM mutation methods", () => {
    expect(staticReadCheck(`document.querySelector("a").click();`).ok).toBe(false);
    expect(staticReadCheck(`document.querySelector("form").submit();`).ok).toBe(false);
    expect(staticReadCheck(`el.dispatchEvent(new Event("click"));`).ok).toBe(false);
    expect(staticReadCheck(`el.requestSubmit();`).ok).toBe(false);
  });

  it("rejects assignments to mutable DOM properties", () => {
    expect(staticReadCheck(`el.value = "x";`).ok).toBe(false);
    expect(staticReadCheck(`el.checked = true;`).ok).toBe(false);
    expect(staticReadCheck(`el.innerHTML = "<x/>";`).ok).toBe(false);
    expect(staticReadCheck(`el.textContent = "y";`).ok).toBe(false);
  });

  it("rejects DOM tree mutation calls", () => {
    expect(staticReadCheck(`el.appendChild(x);`).ok).toBe(false);
    expect(staticReadCheck(`el.removeChild(x);`).ok).toBe(false);
    expect(staticReadCheck(`el.replaceWith(y);`).ok).toBe(false);
    expect(staticReadCheck(`el.remove();`).ok).toBe(false);
    expect(staticReadCheck(`el.setAttribute("x", "y");`).ok).toBe(false);
  });

  it("rejects navigation", () => {
    expect(staticReadCheck(`location.href = "/";`).ok).toBe(false);
    expect(staticReadCheck(`location.assign("/x");`).ok).toBe(false);
    expect(staticReadCheck(`history.pushState({}, "", "/x");`).ok).toBe(false);
    expect(staticReadCheck(`window.open("/x");`).ok).toBe(false);
  });

  it("rejects postMessage", () => {
    expect(staticReadCheck(`window.postMessage("x", "*");`).ok).toBe(false);
  });

  it("rejects eval / new Function / Function(...)", () => {
    expect(staticReadCheck(`eval("1+1");`).ok).toBe(false);
    expect(staticReadCheck(`new Function("return 1")();`).ok).toBe(false);
    expect(staticReadCheck(`Function("return 1")();`).ok).toBe(false);
  });

  it("rejects dynamic property access in call position", () => {
    expect(staticReadCheck(`obj[name]();`).ok).toBe(false);
    expect(staticReadCheck(`obj["fetch"]("/x");`).ok).toBe(false);
  });

  it("rejects syntactically invalid code", () => {
    const r = staticReadCheck(`if (`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/parse|syntax/i);
  });
});

describe("staticReadCheck — property-key allowance", () => {
  it("allows forbidden identifier names when used as a property key", () => {
    // obj.fetch = 1 is benign — assigning a literal to an arbitrary property
    // happens to be named "fetch". The dangerous case (calling fetch) is
    // caught by the bare-identifier check.
    expect(staticReadCheck(`obj.fetch = 1; return obj;`).ok).toBe(true);
    expect(staticReadCheck(`return { fetch: 1 };`).ok).toBe(true);
  });
});

describe("staticReadCheck — boundary inputs", () => {
  it("accepts empty string", () => {
    expect(staticReadCheck("").ok).toBe(true);
  });

  it("accepts whitespace-only input", () => {
    expect(staticReadCheck("   \n\n  ").ok).toBe(true);
  });

  it("accepts comment-only input", () => {
    expect(staticReadCheck("// just a comment").ok).toBe(true);
    expect(staticReadCheck("/* block comment */").ok).toBe(true);
  });
});

describe("staticReadCheck — UpdateExpression rejection", () => {
  it("rejects ++/-- on forbidden assigned property", () => {
    expect(staticReadCheck(`el.value++;`).ok).toBe(false);
    expect(staticReadCheck(`el.innerHTML--;`).ok).toBe(false);
  });
});

describe("staticReadCheck — delete rejection", () => {
  it("rejects delete on forbidden assigned property", () => {
    expect(staticReadCheck(`delete location.href;`).ok).toBe(false);
    expect(staticReadCheck(`delete el.innerHTML;`).ok).toBe(false);
  });

  it("rejects delete document.cookie", () => {
    expect(staticReadCheck(`delete document.cookie;`).ok).toBe(false);
  });
});

describe("staticReadCheck — member-expression callee with forbidden identifier", () => {
  it("rejects new x.WebSocket()", () => {
    expect(staticReadCheck(`new x.WebSocket("/ws");`).ok).toBe(false);
  });

  it("rejects window.Function('...')", () => {
    expect(staticReadCheck(`window.Function("return 1")();`).ok).toBe(false);
  });

  it("rejects globalThis.eval(...)", () => {
    expect(staticReadCheck(`globalThis.eval("1+1");`).ok).toBe(false);
  });

  it("rejects window.fetch(...)", () => {
    expect(staticReadCheck(`window.fetch("/x");`).ok).toBe(false);
  });
});

describe("staticReadCheck — receiver-aware method check", () => {
  it("accepts Object.assign (read-time composition)", () => {
    expect(staticReadCheck(`return Object.assign({}, src);`).ok).toBe(true);
  });

  it("accepts String.prototype.replace (read-time string transform)", () => {
    expect(staticReadCheck(`return s.replace(/x/g, "y");`).ok).toBe(true);
  });

  it("accepts arr.replace-like benign uses on non-location receivers", () => {
    expect(staticReadCheck(`return obj.replace("x", "y");`).ok).toBe(true);
  });

  it("rejects location.assign('/x')", () => {
    expect(staticReadCheck(`location.assign("/x");`).ok).toBe(false);
  });

  it("rejects location.replace('/x')", () => {
    expect(staticReadCheck(`location.replace("/x");`).ok).toBe(false);
  });
});

describe("staticReadCheck — extended DOM-mutation method calls", () => {
  it("rejects el.append(...)", () => {
    expect(staticReadCheck(`el.append(child);`).ok).toBe(false);
  });

  it("rejects el.insertAdjacentHTML(...)", () => {
    expect(staticReadCheck(`el.insertAdjacentHTML("beforeend", "<x/>");`).ok).toBe(false);
  });

  it("rejects el.insertAdjacentElement(...)", () => {
    expect(staticReadCheck(`el.insertAdjacentElement("beforeend", child);`).ok).toBe(false);
  });

  it("rejects el.insertAdjacentText(...)", () => {
    expect(staticReadCheck(`el.insertAdjacentText("beforeend", "x");`).ok).toBe(false);
  });

  it("rejects document.write(...)", () => {
    expect(staticReadCheck(`document.write("<x/>");`).ok).toBe(false);
  });

  it("rejects document.writeln(...)", () => {
    expect(staticReadCheck(`document.writeln("x");`).ok).toBe(false);
  });
});

describe("staticReadCheck — string-literal computed property assignment", () => {
  // `el["innerHTML"] = "x"` is the computed-access form of `el.innerHTML = "x"`.
  // Equivalent at runtime; must be rejected the same way.
  it("rejects el[\"innerHTML\"] = ...", () => {
    expect(staticReadCheck(`el["innerHTML"] = "<x/>";`).ok).toBe(false);
  });

  it("rejects el[\"value\"] = ...", () => {
    expect(staticReadCheck(`el["value"] = "x";`).ok).toBe(false);
  });

  it("rejects el[\"textContent\"] = ...", () => {
    expect(staticReadCheck(`el["textContent"] = "x";`).ok).toBe(false);
  });

  it("rejects update on string-literal computed access (el[\"value\"]++)", () => {
    expect(staticReadCheck(`el["value"]++;`).ok).toBe(false);
  });

  it("rejects delete on string-literal computed access (delete el[\"innerHTML\"])", () => {
    expect(staticReadCheck(`delete el["innerHTML"];`).ok).toBe(false);
  });

  it("accepts string-literal computed access on a non-forbidden prop", () => {
    // `el["foo"] = 1` should pass — `foo` isn't in the forbidden list.
    expect(staticReadCheck(`el["foo"] = 1;`).ok).toBe(true);
  });
});

describe("staticReadCheck — location property assignments (navigation)", () => {
  it("rejects location.pathname = ...", () => {
    expect(staticReadCheck(`location.pathname = "/x";`).ok).toBe(false);
  });

  it("rejects location.host = ...", () => {
    expect(staticReadCheck(`location.host = "example.com";`).ok).toBe(false);
  });

  it("rejects location.hostname = ...", () => {
    expect(staticReadCheck(`location.hostname = "example.com";`).ok).toBe(false);
  });

  it("rejects location.protocol = ...", () => {
    expect(staticReadCheck(`location.protocol = "https:";`).ok).toBe(false);
  });

  it("rejects location.search = ...", () => {
    expect(staticReadCheck(`location.search = "?q=x";`).ok).toBe(false);
  });

  it("rejects location.hash = ...", () => {
    expect(staticReadCheck(`location.hash = "#x";`).ok).toBe(false);
  });

  it("rejects window.location.pathname = ...", () => {
    expect(staticReadCheck(`window.location.pathname = "/x";`).ok).toBe(false);
  });

  it("accepts el.pathname = ... on a non-location receiver", () => {
    // `pathname` on an arbitrary object isn't a navigation; only flag
    // when the receiver is `location` (or a *.location alias).
    expect(staticReadCheck(`el.pathname = "x";`).ok).toBe(true);
  });

  it("accepts el.host = ... on a non-location receiver", () => {
    expect(staticReadCheck(`el.host = "x";`).ok).toBe(true);
  });
});

describe("staticReadCheck — whole-object location replacement", () => {
  it("rejects window.location = ...", () => {
    expect(staticReadCheck(`window.location = "/x";`).ok).toBe(false);
  });

  it("rejects globalThis.location = ...", () => {
    expect(staticReadCheck(`globalThis.location = "/x";`).ok).toBe(false);
  });

  it("rejects self.location = ...", () => {
    expect(staticReadCheck(`self.location = "/x";`).ok).toBe(false);
  });

  it("rejects top.location = ...", () => {
    expect(staticReadCheck(`top.location = "/x";`).ok).toBe(false);
  });
});

"use strict";

const STDOUT_CAP_BYTES = 1_048_576; // 1 MB
const TRUNC_MARKER = "\n…[output truncated, exceeded 1MB]";

let pyodide = null;
let allowNetworkForCurrentCall = false;

// Mount roots used by the previous RUN, so we can clean them up on reset.
// We only clear the conversation workspace; /skills and the shared space
// workspace are read-only context that don't need scrubbing between runs
// (they are re-written from the host on every RUN).
let lastConversationWorkspaceRoot = null;
let lastSpaceWorkspaceRoot = null;
let lastSkillsRoot = null;

// We bundle pyodide locally, so the iframe will load it from the extension URL
async function initPyodide() {
  if (pyodide) return pyodide;
  
  // Since we are in a sandboxed iframe, we can't use chrome.runtime.getURL.
  // But location.origin is the sandbox origin (null), and location.href is the full URL.
  // We can extract the base URL from location.href.
  const url = new URL(location.href);
  const baseURL = url.href.substring(0, url.href.lastIndexOf('/') + 1);
  const indexURL = baseURL + "pyodide/";
  const moduleURL = indexURL + "pyodide.mjs";

  // Install network gate before loading pyodide
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    let urlString = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let isExtensionUrl = urlString.startsWith(baseURL) || urlString.startsWith("/") || urlString.startsWith("./") || urlString.startsWith("blob:") || urlString.startsWith("data:");
    
    if (!allowNetworkForCurrentCall && !isExtensionUrl) {
      throw new Error("NetworkBlocked: network access is disabled for this call. Re-call executePython with allow_network: true to enable it.");
    }
    return originalFetch(input, init);
  };

  const mod = await import(moduleURL);
  pyodide = await mod.loadPyodide({ 
    indexURL,
    // By default, pyodide tries to fetch wheel packages from indexURL.
    // Since we only bundle the core WASM/stdlib and not all the packages (like micropip),
    // we instruct pyodide to fetch packages from the CDN.
    // We use the version that matches our installed pyodide.
    packageBaseUrl: "https://cdn.jsdelivr.net/pyodide/v0.29.4/full/"
  });

  // Guard /skills as read-only. The actual mount happens per-RUN under the
  // real path "/skills". Paths to mount-roots like the per-conversation
  // workspace and per-space workspace are also created per-RUN.
  await pyodide.runPythonAsync(`
import builtins, os
_orig_open = builtins.open
_orig_os_open = os.open
_WRITE_MODES = ('w', 'a', 'x', '+')
def _is_skills_path(path):
    try:
        s = os.fspath(path)
    except TypeError:
        return False
    return s.startswith('/skills/') or s == '/skills'
def _is_space_workspace_path(path):
    try:
        s = os.fspath(path)
    except TypeError:
        return False
    # /spaces/<id>/workspace is read-only context shared across the space's
    # conversations. The agent's fs tools deny writes here too.
    return s.startswith('/spaces/') and ('/workspace' in s)
def _is_readonly(path):
    return _is_skills_path(path) or _is_space_workspace_path(path)
def _guarded_open(file, mode='r', *args, **kwargs):
    if any(c in mode for c in _WRITE_MODES) and _is_readonly(file):
        raise PermissionError(f"path is read-only: {file!r}")
    return _orig_open(file, mode, *args, **kwargs)
_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC
def _guarded_os_open(path, flags, *args, **kwargs):
    if (flags & _WRITE_FLAGS) and _is_readonly(path):
        raise PermissionError(f"path is read-only: {path!r}")
    return _orig_os_open(path, flags, *args, **kwargs)
builtins.open = _guarded_open
os.open = _guarded_os_open
`);
  return pyodide;
}

function writeFilesToMemfs(files, basePath) {
  for (const [path, content] of Object.entries(files)) {
    const fullPath = basePath + "/" + path;
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
    if (dir !== basePath) {
      pyodide.FS.mkdirTree(dir);
    }
    pyodide.FS.writeFile(fullPath, content);
  }
}

function readFilesFromMemfs(basePath) {
  const result = {};
  
  function walk(dir, relPath) {
    let entries;
    try {
      entries = pyodide.FS.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "." || entry === "..") continue;
      const fullPath = dir + "/" + entry;
      const stat = pyodide.FS.stat(fullPath);
      const entryRelPath = relPath ? relPath + "/" + entry : entry;
      
      if (pyodide.FS.isDir(stat.mode)) {
        walk(fullPath, entryRelPath);
      } else if (pyodide.FS.isFile(stat.mode)) {
        // No `encoding` option -> returns Uint8Array. Binary-safe:
        // PDFs, images, etc. round-trip without UTF-8 corruption. The host
        // postMessage uses structured clone, which carries Uint8Array
        // natively.
        const content = pyodide.FS.readFile(fullPath);
        result[entryRelPath] = content;
      }
    }
  }
  
  walk(basePath, "");
  return result;
}

function clearMemfsDir(dir) {
  let entries;
  try {
    entries = pyodide.FS.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "." || entry === "..") continue;
    const fullPath = dir + "/" + entry;
    const stat = pyodide.FS.stat(fullPath);
    if (pyodide.FS.isDir(stat.mode)) {
      clearMemfsDir(fullPath);
      pyodide.FS.rmdir(fullPath);
    } else {
      pyodide.FS.unlink(fullPath);
    }
  }
}

function joinCapped(chunks) {
  const joined = chunks.join("\n");
  if (joined.length <= STDOUT_CAP_BYTES) return joined;
  return joined.slice(0, STDOUT_CAP_BYTES - TRUNC_MARKER.length) + TRUNC_MARKER;
}

window.addEventListener("message", async (e) => {
  const msg = e.data;
  if (!msg || !msg.id || msg.type !== "RUN") return;

  const t0 = performance.now();
  let loadMs = 0;
  
  const stdout = [];
  const stderr = [];

  function reply(response) {
    e.source.postMessage(response, e.origin);
  }

  try {
    if (!pyodide) {
      await initPyodide();
      loadMs = Math.round(performance.now() - t0);
    }

    // Set up stdout/stderr capture
    pyodide.setStdout({ batched: (s) => stdout.push(s) });
    pyodide.setStderr({ batched: (s) => stderr.push(s) });

    // 1. On reset, scrub the previous run's mount roots.
    //
    // We clear the conversation workspace AND the previous space/skills
    // mounts so a fresh RUN sees only what the host posted. The host
    // re-sends the full skills + space trees on every RUN, so wiping them
    // here is safe (and avoids stale files leaking across resets).
    if (msg.resetState) {
      if (lastConversationWorkspaceRoot) clearMemfsDir(lastConversationWorkspaceRoot);
      if (lastSpaceWorkspaceRoot) clearMemfsDir(lastSpaceWorkspaceRoot);
      if (lastSkillsRoot) clearMemfsDir(lastSkillsRoot);
    }

    // 2. Ensure mount directories exist for THIS run. Paths come from the
    // host as absolute MEMFS paths (e.g. "/conversations/<id>/workspace").
    if (msg.conversationWorkspaceRoot) pyodide.FS.mkdirTree(msg.conversationWorkspaceRoot);
    if (msg.skillsRoot) pyodide.FS.mkdirTree(msg.skillsRoot);
    if (msg.spaceWorkspaceRoot) pyodide.FS.mkdirTree(msg.spaceWorkspaceRoot);

    // 3. Mount file maps. Each map is keyed by relative path inside its
    // mount root; writeFilesToMemfs joins (basePath + "/" + relPath).
    if (msg.workspaceFiles && msg.conversationWorkspaceRoot) {
      writeFilesToMemfs(msg.workspaceFiles, msg.conversationWorkspaceRoot);
    }
    if (msg.skillsFiles && msg.skillsRoot) {
      writeFilesToMemfs(msg.skillsFiles, msg.skillsRoot);
    }
    if (msg.spaceFiles && msg.spaceWorkspaceRoot) {
      writeFilesToMemfs(msg.spaceFiles, msg.spaceWorkspaceRoot);
    }

    // 4. chdir into the conversation workspace so relative paths in user
    // code (e.g. open("data.csv")) keep resolving to the conversation's
    // workspace, even though the absolute path is now the real OPFS path.
    if (msg.conversationWorkspaceRoot) {
      pyodide.FS.chdir(msg.conversationWorkspaceRoot);
    }

    // 5. Track mount roots so the next reset can scrub them.
    lastConversationWorkspaceRoot = msg.conversationWorkspaceRoot ?? null;
    lastSpaceWorkspaceRoot = msg.spaceWorkspaceRoot ?? null;
    lastSkillsRoot = msg.skillsRoot ?? null;

    if (msg.resetState) {
      await pyodide.runPythonAsync(`
import sys as _sys
_g = _sys.modules['__main__'].__dict__
_keep = {'__name__', '__doc__', '__package__', '__loader__', '__spec__',
         '__builtins__', '__file__', '__path__', '__cached__'}
for _k in [k for k in list(_g.keys()) if k not in _keep]:
    del _g[_k]
del _sys, _g, _keep
`);
    }

    allowNetworkForCurrentCall = !!msg.allowNetwork;

    let result;
    try {
      if (allowNetworkForCurrentCall) {
        await pyodide.loadPackagesFromImports(msg.code);
      }
      result = await pyodide.runPythonAsync(msg.code);
    } finally {
      allowNetworkForCurrentCall = false;
    }

    // Read back ONLY the conversation workspace. /skills and the shared
    // space workspace are read-only mounts; modifications to them stay
    // inside MEMFS and are discarded on the next run.
    const updatedWorkspaceFiles = msg.conversationWorkspaceRoot
      ? readFilesFromMemfs(msg.conversationWorkspaceRoot)
      : {};

    let serialized = result;
    const proxy = result;
    if (proxy && typeof proxy === "object" && typeof proxy.toJs === "function") {
      try {
        serialized = proxy.toJs({ create_proxies: false, dict_converter: Object.fromEntries });
      } catch {
        serialized = String(result);
      } finally {
        try { proxy.destroy?.(); } catch { /* noop */ }
      }
    }

    try {
      JSON.stringify(serialized);
    } catch {
      serialized = String(result);
    }

    const stdoutStr = joinCapped(stdout);
    const stderrStr = joinCapped(stderr);
    
    let errorKind = undefined;
    if (stdoutStr.endsWith(TRUNC_MARKER) || stderrStr.endsWith(TRUNC_MARKER)) {
      errorKind = "OutputTooLarge";
    }

    reply({
      type: "RESULT",
      id: msg.id,
      result: serialized,
      stdout: stdoutStr,
      stderr: stderrStr,
      errorKind,
      workspaceFiles: updatedWorkspaceFiles,
      timings: { loadMs, runMs: Math.round(performance.now() - t0 - loadMs) }
    });

  } catch (err) {
    const message_ = err instanceof Error ? err.message : String(err);
    const isNetworkBlocked = message_.startsWith("NetworkBlocked");
    
    // We still try to extract files in case it partially succeeded before crashing
    let updatedWorkspaceFiles = {};
    if (pyodide && msg.conversationWorkspaceRoot) {
      try {
        updatedWorkspaceFiles = readFilesFromMemfs(msg.conversationWorkspaceRoot);
      } catch { /* noop */ }
    }

    reply({
      type: "RESULT",
      id: msg.id,
      stdout: joinCapped(stdout),
      stderr: joinCapped(stderr),
      error: message_,
      errorKind: isNetworkBlocked ? "NetworkBlocked" : "PythonError",
      workspaceFiles: updatedWorkspaceFiles,
      timings: { loadMs, runMs: Math.round(performance.now() - t0 - loadMs) }
    });
  }
});

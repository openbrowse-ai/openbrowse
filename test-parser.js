const trimmed = "https://github.com/anthropics/claude-plugins-official --skill math-olympiad";
let parsed;
if (trimmed.startsWith("https://github.com/")) {
  try {
    const url = new URL(trimmed);
    const parts = url.pathname.replace(/^\//, '').split('/');
    
    if (parts.length < 2) {
      parsed = { kind: "invalid", reason: "Invalid GitHub URL. Expected https://github.com/owner/repo" };
    } else {
      const owner = parts[0];
      const repo = parts[1];
      
      if (parts.length >= 4 && parts[2] === 'tree') {
        const ref = parts[3];
        const subpath = parts.slice(4).join('/');
        parsed = { kind: "github", owner, repo, ref, subpath: subpath || undefined };
      } else {
        parsed = { kind: "github", owner, repo };
      }
    }
  } catch (e) {
    parsed = { kind: "invalid", reason: "Invalid URL format" };
  }
}
console.log(parsed);

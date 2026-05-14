async function run() {
  const url = "https://api.github.com/repos/anthropics/claude-plugins-official%20--skill%20math-olympiad";
  const res = await fetch(url);
  console.log(res.status, res.statusText);
}
run();

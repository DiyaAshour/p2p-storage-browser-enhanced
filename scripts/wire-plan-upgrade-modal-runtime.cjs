const fs = require("node:fs");

const p = "scripts/electron-dev-cloud.cjs";
let s = fs.readFileSync(p, "utf8");

const needle = "runOptionalScript('scripts/apply-audit-ipc-runtime.cjs');";
const insert = needle + "\nrunOptionalScript('scripts/apply-plan-upgrade-modal-runtime.cjs');";

if (!s.includes("apply-plan-upgrade-modal-runtime.cjs")) {
  if (!s.includes(needle)) throw new Error("Could not find audit runtime line");
  s = s.replace(needle, insert);
  fs.writeFileSync(p, s, "utf8");
}

console.log("OK plan upgrade modal runtime wired");

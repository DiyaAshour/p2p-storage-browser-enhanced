const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = process.cwd();
const file = path.join(root, 'TESTING.md');

function sh(cmd, args) {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();
}

function todayAmman() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Amman',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function machineName() {
  return process.env.COMPUTERNAME || process.env.HOSTNAME || 'DiyaA Windows dev machine';
}

const commit = sh('git', ['rev-parse', '--short', 'HEAD']);
const date = todayAmman();
const machine = machineName();

let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

const verificationRow = `| ${date} | ${commit} | Diya Ashour | PASS | Full \`pnpm run verify\` passed: secrets, security, production, IPC, renderer, large-files, manifest-auth, storage-peer, bootstrap, wallet-payment, encryption, release, smoke-plan, enterprise, and runtime checks. |`;
const devRow = `| ${date} | ${commit} | ${machine} | WATCH | \`pnpm run electron:dev\` started Vite on 127.0.0.1:3000, installed company/seed IPC, started P2P listener on ws://0.0.0.0:8787, advertised ws://172.23.192.1:8787, storage OK with ~320.95GB free, and scheduled auto-repair. Follow-up: startup log printed \`Replicas: 3\`; verify/runtime constants are 4, so dev bootstrap env must be checked. |`;

text = text.replace(
  '| Static verification | Pending run | `pnpm run verify` output |',
  '| Static verification | PASS | `pnpm run verify` passed on latest local/GitHub commit |'
);
text = text.replace(
  '| P2P replication | Pending run | 4 confirmed P2P replicas or AWS safety fallback when peers are missing |',
  '| P2P replication | WATCH | Dev startup reached P2P listener; follow-up needed because cloud-dev log printed `Replicas: 3` while enterprise target is 4 |'
);
text = text.replace(
  '| Payments | Pending run | PayPal subscription success/failure/webhook/plan unlock token |',
  '| Payments | Static PASS / live Pending | Wallet/payment guard passed static verification; live PayPal subscription flow still needs T-020/T-021/T-022 |'
);

text = text.replace(
  '|  |  |  | Pending |  |',
  verificationRow
);
text = text.replace(
  '|  |  |  | Pending |  |',
  devRow
);

const latestSection = `\n## Latest recorded run — ${date}\n\n| Test | Commit | Result | Evidence | Follow-up |\n| --- | --- | --- | --- | --- |\n| T-000 Static enterprise verification | ${commit} | PASS | \`pnpm run verify\` completed successfully through \`verify-runtime\`. | None for static gate. |\n| T-001 Fresh app start / dev run | ${commit} | WATCH | \`pnpm run electron:dev\` started renderer and P2P node successfully. | Investigate why \`electron-dev-cloud.cjs\` prints \`Replicas: 3\` even though enterprise/runtime constants are 4. |\n\n`;

if (!text.includes(`## Latest recorded run — ${date}`)) {
  text = text.replace('\n## Release gate status\n', latestSection + '\n## Release gate status\n');
}

fs.writeFileSync(file, text, 'utf8');
console.log(`[record-latest-testing-results] recorded TESTING.md results for ${date} commit ${commit}`);

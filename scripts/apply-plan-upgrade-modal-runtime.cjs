#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const rendererPath = path.join(process.cwd(), 'client', 'src', 'NativeP2PAppLive.tsx');
let source = fs.readFileSync(rendererPath, 'utf8');
const before = source;

function replaceOnce(from, to) {
  if (!source.includes(from)) return false;
  source = source.replace(from, to);
  return true;
}

function replaceRegex(pattern, to) {
  if (!pattern.test(source)) return false;
  source = source.replace(pattern, to);
  return true;
}

function warn(message) {
  console.warn(`[plan-upgrade-modal-runtime] ${message}`);
}

function removeDuplicatePlanPickers() {
  const marker = 'Choose your Chunknet plan';
  const first = source.indexOf(marker);
  if (first < 0) return;
  const second = source.indexOf(marker, first + marker.length);
  if (second < 0) return;
  warn('multiple plan pickers detected; keeping existing JSX and only fixing helpers');
}

// 1) State: make sure the modal state exists. Do not detect by JSX usage only.
if (!/const \[planPickerOpen,\s*setPlanPickerOpen\]/.test(source)) {
  const inserted = replaceOnce(
    `  const [payingPlanId, setPayingPlanId] = useState<string>("");`,
    `  const [payingPlanId, setPayingPlanId] = useState<string>("");
  const [planPickerOpen, setPlanPickerOpen] = useState(false);`
  );
  if (!inserted) warn('could not insert planPickerOpen state');
}

const helperBlock = `

  const defaultPaidPlans = useMemo<Plan[]>(
    () => [
      { id: "starter", name: "Starter", quotaBytes: 100 * 1024 ** 3, priceUsd: 2.99, locked: true, description: "100 GB storage plan" },
      { id: "personal", name: "Personal", quotaBytes: 1 * 1024 ** 4, priceUsd: 7.99, locked: true, description: "1 TB storage plan" },
      { id: "plus", name: "Plus", quotaBytes: 3 * 1024 ** 4, priceUsd: 14.99, locked: true, description: "3 TB storage plan" },
      { id: "pro", name: "Pro", quotaBytes: 7 * 1024 ** 4, priceUsd: 24.99, locked: true, description: "7 TB storage plan" },
      { id: "ultra", name: "Ultra", quotaBytes: 10 * 1024 ** 4, priceUsd: 34.99, locked: true, description: "10 TB storage plan" },
    ],
    []
  );

  const visiblePaidPlans = useMemo(() => {
    const remotePlans = (wallet?.plans || [])
      .filter((plan) => Number(plan.priceUsd || 0) > 0)
      .filter((plan) => !["tb1", "tb3", "tb7", "tb10"].includes(plan.id));

    const plans = remotePlans.length ? remotePlans : defaultPaidPlans;
    return plans.slice().sort((a, b) => Number(a.quotaBytes || 0) - Number(b.quotaBytes || 0));
  }, [wallet?.plans, defaultPaidPlans]);

  const currentPlanName = wallet?.plan?.name || "Free";
  const currentPlanId = wallet?.planId || wallet?.plan?.id || "free";
  const usedBytes = Number(wallet?.usedBytes || 0);

  const canSelectPlan = (plan: Plan) => {
    const active = currentPlanId === plan.id || wallet?.plan?.id === plan.id;
    return active || Number(plan.quotaBytes || 0) >= usedBytes;
  };

  const planSize = (plan: Plan) => {
    const size = Number(plan.quotaBytes || 0);
    if (size >= 1024 ** 4) return \`\${Math.round(size / 1024 ** 4)} TB\`;
    return \`\${Math.round(size / 1024 ** 3)} GB\`;
  };`;

// 2) Remove any previous helper block that had no fallback, then insert the fixed helper block.
if (/const\s+visiblePaidPlans\s*=\s*useMemo/.test(source) && !/const\s+defaultPaidPlans\s*=\s*useMemo/.test(source)) {
  const removed = replaceRegex(
    /\n\s*const visiblePaidPlans = useMemo\([\s\S]*?\n\s*const folderById = useMemo\(/m,
    `${helperBlock}\n\n  const folderById = useMemo(`
  );
  if (!removed) warn('could not replace old visiblePaidPlans helper block');
}

if (!/const\s+currentPlanName\s*=/.test(source)) {
  let inserted = replaceOnce(
    `  const quota = wallet?.plan?.quotaBytes
    ? Math.min(100, (wallet.usedBytes / wallet.plan.quotaBytes) * 100)
    : 0;`,
    `  const quota = wallet?.plan?.quotaBytes
    ? Math.min(100, (wallet.usedBytes / wallet.plan.quotaBytes) * 100)
    : 0;${helperBlock}`
  );

  if (!inserted) {
    inserted = replaceOnce(
      `  const peerCount = summary?.connectedPeers ?? 0;`,
      `  const peerCount = summary?.connectedPeers ?? 0;${helperBlock}`
    );
  }

  if (!inserted) {
    inserted = replaceRegex(/\n\s*const folderById = useMemo\(/, `${helperBlock}\n\n  const folderById = useMemo(`);
  }

  if (!inserted) warn('could not insert plan helper variables');
}

// 3) If defaultPaidPlans was not inserted because a partial helper existed, add it before visiblePaidPlans and rewrite visiblePaidPlans.
if (/const\s+visiblePaidPlans\s*=\s*useMemo/.test(source) && !/const\s+defaultPaidPlans\s*=\s*useMemo/.test(source)) {
  const fixedHelpers = helperBlock.replace(/^\n\n/, '');
  const replaced = replaceRegex(
    /\s*const visiblePaidPlans = useMemo\([\s\S]*?\n\s*const currentPlanName\s*=\s*wallet\?\.plan\?\.name \|\| ["'](?:Trial|Free)["'];/m,
    `\n\n  ${fixedHelpers}\n\n  const currentPlanName = wallet?.plan?.name || "Free";`
  );
  if (!replaced) warn('fallback plan list still could not be inserted');
}

// 4) Close modal after successful activation.
source = source.replace(
  `        toast.success(\`\${captured.plan?.name || plan.name} plan activated\`);`,
  `        setPlanPickerOpen(false);
        toast.success(\`\${captured.plan?.name || plan.name} plan activated\`);`
);

// 5) Remove the old always-visible plan buttons when the exact block is still present.
const oldButtons = `          {wallet?.plans?.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {wallet.plans
                .filter((plan) => plan.priceUsd > 0)
                .map((plan) => {
                  const active = wallet.planId === plan.id || wallet.plan?.id === plan.id;

                  return (
                    <Button
                      key={plan.id}
                      size="sm"
                      variant={active ? "default" : "outline"}
                      disabled={busy || payingPlanId === plan.id}
                      onClick={() => buyPlan(plan)}
                      className="text-xs"
                    >
                      <Cloud className="size-3" />
                      {active
                        ? \`\${plan.name} Active\`
                        : \`\${plan.name} · $\${plan.priceUsd}/mo\`}
                    </Button>
                  );
                })}
            </div>
          ) : null}

`;
source = source.replace(oldButtons, '');

const newPlanPicker = `          {wallet?.connected && (
            <span className="flex items-center gap-2">
              <span className="flex items-center gap-1">
                <Cloud className="size-3" />
                {currentPlanName}
              </span>

              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setPlanPickerOpen(true)}
                className="h-7 px-3 text-xs"
              >
                {Number(wallet?.plan?.priceUsd || 0) > 0 ? "Change plan" : "Upgrade plan"}
              </Button>
            </span>
          )}

          {planPickerOpen && (
            <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/70 p-4">
              <div className="w-full max-w-3xl rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Choose your Chunknet plan</h2>
                    <p className="mt-1 text-sm text-zinc-400">
                      Current plan: {currentPlanName} · Used: {bytes(usedBytes)}
                    </p>
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPlanPickerOpen(false)}
                    disabled={busy}
                  >
                    Close
                  </Button>
                </div>

                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                  {visiblePaidPlans.map((plan) => {
                    const active = currentPlanId === plan.id || wallet?.plan?.id === plan.id;
                    const allowed = canSelectPlan(plan);
                    const isBusy = payingPlanId === plan.id;

                    return (
                      <Card
                        key={plan.id}
                        className={\`rounded-2xl border-zinc-800 bg-zinc-900 \${active ? "ring-2 ring-blue-500" : ""}\`}
                      >
                        <CardContent className="space-y-3 p-4">
                          <div>
                            <p className="text-base font-semibold">{plan.name}</p>
                            <p className="text-xs text-zinc-400">{planSize(plan)} storage</p>
                          </div>

                          <div>
                            <p className="text-2xl font-bold">
                              $\${Number(plan.priceUsd || 0).toFixed(2)}
                              <span className="text-xs font-normal text-zinc-400"> / month</span>
                            </p>
                            <p className="mt-1 text-xs text-zinc-500">
                              Auto-renewing monthly PayPal subscription
                            </p>
                          </div>

                          {!allowed && (
                            <p className="rounded-lg border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
                              You are using {bytes(usedBytes)}. Delete files first to switch to this lower plan.
                            </p>
                          )}

                          <Button
                            className="w-full"
                            variant={active ? "default" : "outline"}
                            disabled={busy || isBusy || active || !allowed}
                            onClick={() => buyPlan(plan)}
                          >
                            {active
                              ? "Current plan"
                              : isBusy
                                ? "Opening PayPal..."
                                : allowed
                                  ? "Subscribe"
                                  : "Delete files first"}
                          </Button>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>

                <p className="mt-4 text-xs text-zinc-500">
                  Downgrades are allowed only when your used storage fits inside the lower plan.
                </p>
              </div>
            </div>
          )}`;

// 6) Insert picker only if not already inserted.
if (!source.includes('Choose your Chunknet plan')) {
  const oldPlanLabelExact = `          {wallet?.plan && (
            <span className="flex items-center gap-1">
              <Cloud className="size-3" />
              {wallet.plan.name}
            </span>
          )}`;

  let inserted = replaceOnce(oldPlanLabelExact, newPlanPicker);

  if (!inserted) {
    inserted = replaceRegex(
      /\s*\{wallet\?\.plan\s*&&\s*\(\s*<span className="flex items-center gap-1">\s*<Cloud className="size-3"\s*\/>\s*\{wallet\.plan\.name\}\s*<\/span>\s*\)\}/m,
      `\n${newPlanPicker}`
    );
  }

  if (!inserted) {
    inserted = replaceRegex(
      /(\s*<span className="flex items-center gap-1">\s*<Wifi className="size-3"\s*\/>\s*\{peerCount\} peers\s*<\/span>)/m,
      `$1\n\n${newPlanPicker}`
    );
  }

  if (!inserted) warn('header anchor not found; skipped plan picker insertion');
}

removeDuplicatePlanPickers();

if (before !== source) fs.writeFileSync(rendererPath, source, 'utf8');
console.log('[plan-upgrade-modal-runtime] applied', { renderer: before !== source });

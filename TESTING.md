# Chunknet Enterprise Testing Log

This file is the official testing register for the `big-file-upload-safe` branch. Every experiment must be recorded here before the build is treated as enterprise-ready.

> Rule: a feature is not considered production-ready because the code exists. It is considered ready only when the test case below has a dated result, tester name, environment, evidence, and PASS status.

## Release gate status

| Area | Current gate | Required evidence |
| --- | --- | --- |
| Static verification | Pending run | `pnpm run verify` output |
| Large files | Pending run | Upload + download + hash match for 2 GB, 5 GB, 10 GB |
| P2P replication | Pending run | 4 confirmed P2P replicas or AWS safety fallback when peers are missing |
| Safety peer | Pending run | Upload when peers < 4, delete after P2P protection, delete on file delete |
| Repair | Pending run | Under-replicated file returns to protected state |
| Company Drive | Pending run | Roles, invites, folders, audit logs, backend permission checks |
| Payments | Pending run | PayPal subscription success/failure/webhook/plan unlock token |
| Installer | Pending run | Fresh install, firewall rule, tray/background mode, packaged renderer load |
| Long run | Pending run | 24-hour run without data loss or stuck repair loop |

## Environment record template

Copy this block for every new test machine.

```text
Date:
Tester:
Machine name:
OS:
CPU/RAM/GPU:
Disk free space:
Network type: same LAN / different LAN / mobile hotspot / VPS
Branch:
Commit SHA:
Node version:
pnpm version:
Electron mode: dev / packaged
Bootstrap URL:
Safety peer URL:
P2P public URL:
P2P_TARGET_REPLICAS:
P2P_CHUNK_SIZE_BYTES:
Result summary:
Evidence path/screenshots/logs:
```

## Standard setup commands

### Clean clone

```powershell
git clone https://github.com/DiyaAshour/p2p-cloud.git C:\T\chunknet-enterprise-test
cd C:\T\chunknet-enterprise-test
git checkout big-file-upload-safe
git pull
pnpm install
```

### Enterprise verification

```powershell
pnpm run verify
```

Expected result:

```text
[verify-enterprise-consistency] ok: IPC preload, enterprise channels, and replica target are consistent
```

### Dev run

```powershell
pnpm run electron:dev
```

### Recommended runtime environment

```powershell
$env:P2P_TARGET_REPLICAS="4"
$env:P2P_SAFETY_PEER_MODE="emergency"
$env:P2P_BOOTSTRAP_URL="ws://54.166.171.208:8788"
# set this only when using a real safety peer
# $env:P2P_SAFETY_PEER_URL="http://YOUR-SAFETY-PEER:PORT"
```

## Test result symbols

| Symbol | Meaning |
| --- | --- |
| PASS | Fully passed with evidence |
| FAIL | Failed; must include logs and fix issue |
| BLOCKED | Could not run because dependency/env missing |
| RETEST | Fix was made and case needs to be rerun |
| WATCH | Passed but needs longer observation |

## Test cases

### T-000 — Static enterprise verification

Purpose: prove that safety checks, IPC contract, renderer safety, large-file safety, wallet payment checks, and enterprise consistency checks are wired.

Steps:

1. Run `pnpm run verify`.
2. Save the full terminal output.
3. Confirm `verify:enterprise` runs before `verify-runtime.cjs`.

Pass criteria:

- Command exits with code `0`.
- No missing IPC channels.
- No renderer large-file memory path.
- No replica target mismatch.

Result log:

| Date | Commit | Tester | Result | Evidence |
| --- | --- | --- | --- | --- |
|  |  |  | Pending |  |

---

### T-001 — Fresh app start

Purpose: prove the app opens cleanly after fresh install or fresh dev run.

Steps:

1. Delete old test app data if this is a destructive test.
2. Run `pnpm run electron:dev`.
3. Confirm the window opens.
4. Confirm no `No handler registered` errors for startup calls.
5. Open diagnostics if available.

Pass criteria:

- Renderer loads.
- `p2p:start` works.
- Network summary appears.
- No `Blocked unsafe IPC channel` error.

Result log:

| Date | Commit | Machine | Result | Notes/Evidence |
| --- | --- | --- | --- | --- |
|  |  |  | Pending |  |

---

### T-002 — Seed account create/login/recover

Purpose: prove non-wallet users can create and use a secure identity.

Steps:

1. Create seed account.
2. Save recovery seed externally.
3. Logout.
4. Login with username/password.
5. Recover using recovery seed and a new password.
6. Restart the app and confirm identity persists.

Pass criteria:

- Create works.
- Login works.
- Recovery works.
- Failed attempts trigger cooldown/lockout where applicable.
- Old local clock changes do not bypass lockout if network-time guard is active.

Result log:

| Date | Commit | Tester | Result | Evidence |
| --- | --- | --- | --- | --- |
|  |  |  | Pending |  |

---

### T-003 — WalletConnect login

Purpose: prove wallet login is real and signature-bound.

Steps:

1. Connect wallet by QR.
2. Sign login message.
3. Confirm wallet status in app.
4. Restart app and confirm state.
5. Try stale login signature if possible.

Pass criteria:

- Valid signature accepted.
- Invalid/stale/future timestamp signature rejected.
- Wallet identity matches signed address.

Result log:

| Date | Commit | Wallet | Result | Evidence |
| --- | --- | --- | --- | --- |
|  |  |  | Pending |  |

---

### T-004 — Small file upload/download/hash

Purpose: prove baseline file flow before large tests.

Steps:

1. Upload a small text file.
2. Upload a PNG/JPG.
3. Download both to disk.
4. Compare original and downloaded hashes.
5. Restart app and download again.

PowerShell hash command:

```powershell
Get-FileHash .\original.file -Algorithm SHA256
Get-FileHash .\downloaded.file -Algorithm SHA256
```

Pass criteria:

- Hashes match.
- Files survive restart.
- File cards show correct size, status, and folder.

Result log:

| Date | Commit | File | Size | Result | Hash match | Evidence |
| --- | --- | --- | ---: | --- | --- | --- |
|  |  |  |  | Pending |  |  |

---

### T-005 — Big file 2 GB streaming upload/download

Purpose: prove large files do not load fully into renderer memory.

Steps:

1. Prepare a 2 GB test file.
2. Upload it using normal UI.
3. Watch RAM usage during upload.
4. Confirm progress: chunks done, percent, speed, ETA.
5. Download to a new path using Download to file.
6. Compare hashes.
7. Restart app and download again.

Create test file:

```powershell
fsutil file createnew C:\T\chunknet-tests\2gb.bin 2147483648
```

Pass criteria:

- Upload completes.
- Download completes.
- Hashes match.
- Renderer does not receive file bytes.
- RAM stays stable and no heap out-of-memory.

Result log:

| Date | Commit | File size | Chunk count | Upload RAM peak | Download RAM peak | Result | Evidence |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
|  |  | 2 GB |  |  |  | Pending |  |

---

### T-006 — Big file 5 GB streaming upload/download

Purpose: prove disk-first design handles files above common memory limits.

Steps:

```powershell
fsutil file createnew C:\T\chunknet-tests\5gb.bin 5368709120
```

1. Upload file.
2. Confirm app remains responsive.
3. Download file.
4. Compare hashes.
5. Record chunk count and transfer time.

Pass criteria:

- No app crash.
- No corrupted download.
- Status becomes Protected or aws-safety protected when peer count is low.

Result log:

| Date | Commit | File size | Chunk size | Chunk count | Upload time | Download time | Result | Evidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
|  |  | 5 GB |  |  |  |  | Pending |  |

---

### T-007 — Big file 10 GB streaming upload/download

Purpose: minimum enterprise large-file acceptance test.

Steps:

```powershell
fsutil file createnew C:\T\chunknet-tests\10gb.bin 10737418240
```

1. Upload file.
2. Keep Task Manager open and record memory/disk/network peaks.
3. Download to another folder.
4. Compare SHA256 hashes.
5. Restart and verify file still appears and downloads.

Pass criteria:

- No crash.
- No memory blowup.
- Hashes match.
- Manifest/chunk state survives restart.

Result log:

| Date | Commit | File size | Upload time | Download time | Hash match | Result | Evidence |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
|  |  | 10 GB |  |  |  | Pending |  |

---

### T-008 — Upload cancel rollback

Purpose: prove cancel does not leave broken partial state.

Steps:

1. Start uploading a 5 GB or 10 GB file.
2. Cancel during upload.
3. Confirm upload stops.
4. Check local chunk directory.
5. Check safety peer cleanup if safety upload already happened.
6. Restart app and confirm no broken file card remains.

Pass criteria:

- UI shows cancelled.
- Partial local chunks are removed or not referenced.
- Safety chunks are deleted if they were uploaded for cancelled file.
- No corrupt manifest remains.

Result log:

| Date | Commit | Cancel point | Local cleanup | Safety cleanup | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  | Pending |  |

---

### T-009 — No peers safety peer protection

Purpose: prove emergency safety peer protects files when no P2P peers exist.

Steps:

1. Run one client only.
2. Confirm connected peers = 0.
3. Upload small file and 2 GB file.
4. Confirm chunks are uploaded to safety peer.
5. Confirm file status is Protected or aws-safety protected.
6. Download after restart with no peers.

Pass criteria:

- Safety peer is used immediately.
- File is recoverable from safety peer.
- UI does not show false P2P protection when only safety exists.

Result log:

| Date | Commit | File | Peers | Safety status | Download after restart | Result | Evidence |
| --- | --- | --- | ---: | --- | --- | --- | --- |
|  |  |  | 0 |  |  | Pending |  |

---

### T-010 — Two peer LAN replication

Purpose: prove chunks move between two real devices on same LAN.

Setup:

- Device A: Windows
- Device B: Kali/Linux or second Windows
- Same bootstrap URL
- Firewalls open for TCP 8787

Steps:

1. Start Device A.
2. Start Device B.
3. Confirm connectedPeers >= 1 on both.
4. Upload a small file from A.
5. Upload a 2 GB file from A.
6. Confirm B receives replicas.
7. Close A and try download from B if identity and manifest access allow it.

Pass criteria:

- Peers discover each other.
- Replicas include both peer IDs.
- Files remain downloadable when one peer is unavailable if safety peer or another replica exists.

Result log:

| Date | Commit | Device A | Device B | Connected peers | File | Result | Evidence |
| --- | --- | --- | --- | ---: | --- | --- | --- |
|  |  |  |  |  |  | Pending |  |

---

### T-011 — Four peer enterprise replication

Purpose: prove target 4 replicas is real.

Setup:

- 4 clients on LAN or mixed networks.
- Same bootstrap server.
- `P2P_TARGET_REPLICAS=4`.

Steps:

1. Start all 4 clients.
2. Confirm each sees peers.
3. Upload file from Client 1.
4. Confirm each chunk gets 4 P2P replicas if possible.
5. Confirm safety peer is not needed after 4 good replicas.

Pass criteria:

- `confirmedReplicas >= 4` for chunks.
- File status Protected.
- Protection mode P2P.
- Safety peer copy deleted after peer protection if it was previously used.

Result log:

| Date | Commit | Clients online | File | Target replicas | Confirmed replicas | Safety deleted | Result | Evidence |
| --- | --- | ---: | --- | ---: | ---: | --- | --- | --- |
|  |  | 4 |  | 4 |  |  | Pending |  |

---

### T-012 — Repair after peer loss

Purpose: prove under-replication repairs automatically or through Repair Now.

Steps:

1. Upload file with 4 peers.
2. Stop one peer.
3. Confirm file becomes under-replicated/protecting if only 3 P2P replicas remain.
4. Start a new peer or restart old peer.
5. Run repair or wait for protection retry.
6. Confirm file returns to Protected.

Pass criteria:

- Under-replicated state is detected.
- Repair increases confirmed replicas.
- No duplicate/corrupt chunk state.

Result log:

| Date | Commit | Before replicas | After peer loss | After repair | Result | Evidence |
| --- | --- | ---: | ---: | ---: | --- | --- |
|  |  | 4 | 3 | 4 | Pending |  |

---

### T-013 — Delete propagation and tombstones

Purpose: prove deletes remove files/chunks from local, peers, safety peer, and remote manifests.

Steps:

1. Upload file.
2. Confirm it exists locally, in manifest, and on safety peer if used.
3. Delete from UI.
4. Confirm card disappears.
5. Restart app.
6. Pull manifests and confirm file does not return.
7. Confirm safety peer chunk is deleted.
8. Confirm peers receive delete/tombstone.

Pass criteria:

- File does not reappear after sync.
- Safety peer does not retain deleted chunk.
- Peers do not serve deleted chunk unless retained for unrelated file dedupe policy.

Result log:

| Date | Commit | File | Safety before | Safety after | Reappeared after restart | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  | Pending |  |

---

### T-014 — Folder tree persistence

Purpose: prove folder metadata is not local-only and survives restart/device change.

Steps:

1. Create nested folders: `Root / A / B / C`.
2. Upload file into C.
3. Rename B.
4. Move C under A or Root.
5. Restart app.
6. Open second device with same identity and pull manifests.
7. Confirm folder tree matches.

Pass criteria:

- Folders keep IDs.
- Renames and moves persist.
- File remains in correct folder.
- Second device sees the same structure.

Result log:

| Date | Commit | Operations | Same after restart | Same on second device | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  | Pending |  |

---

### T-015 — Company workspace create/invite/join

Purpose: prove Company Drive onboarding works.

Steps:

1. Create workspace as owner.
2. Invite member with role viewer.
3. Copy invite token.
4. Join from second device/identity.
5. Confirm workspace appears.
6. Change member role.
7. Remove member.

Pass criteria:

- Workspace is signed and signatureValid is true.
- Invite token works.
- Joined member appears.
- Role change persists.
- Removed member loses access.

Result log:

| Date | Commit | Owner device | Member device | Invite method | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  | Offline token | Pending |  |

---

### T-016 — Company Drive roles and backend permissions

Purpose: prove roles are enforced outside the UI.

Role matrix:

| Action | owner | admin | manager | editor | viewer | guest |
| --- | --- | --- | --- | --- | --- | --- |
| Invite member | PASS | PASS | PASS/Policy | FAIL/Policy | FAIL | FAIL |
| Change role | PASS | PASS/Policy | FAIL/Policy | FAIL | FAIL | FAIL |
| Remove member | PASS | PASS/Policy | FAIL/Policy | FAIL | FAIL | FAIL |
| Upload file | PASS | PASS | PASS | PASS | FAIL | FAIL |
| Download visible file | PASS | PASS | PASS | PASS | PASS | Policy |
| Create folder | PASS | PASS | PASS | PASS/Policy | FAIL | FAIL |
| Delete file | PASS | PASS | PASS/Policy | Own only/Policy | FAIL | FAIL |

Steps:

1. Attempt every action from every role.
2. Record UI result.
3. Attempt direct IPC call if possible.
4. Confirm backend denies unauthorized role.

Pass criteria:

- Backend enforces permissions.
- UI does not show forbidden actions.
- Direct IPC cannot bypass role restrictions.

Result log:

| Date | Commit | Role | Action | Expected | Actual | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
|  |  | viewer | upload | denied |  | Pending |  |

---

### T-017 — Company files and audit log

Purpose: prove Company Drive actions are auditable.

Steps:

1. Upload company file.
2. Download company file.
3. Move company file.
4. Rename/update company file.
5. Delete company file.
6. Open audit panel.
7. Confirm actor, action, time, workspace, and file identifiers.

Pass criteria:

- Audit entries exist for all actions.
- Actor is not `Unknown` when identity exists.
- Audit survives restart and manifest sync.

Result log:

| Date | Commit | Action | Actor shown | Audit entry found | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
|  |  | upload |  |  | Pending |  |

---

### T-018 — Move from My Drive to Company Drive

Purpose: prove personal/company separation is correct.

Steps:

1. Upload file to My Drive.
2. Add/move/share it into Company Drive.
3. Confirm it appears in Company Drive.
4. Confirm desired policy: original remains in My Drive unless explicit delete.
5. Delete from My Drive.
6. Confirm Company Drive copy remains if policy says independent.
7. Delete from Company Drive.
8. Confirm My Drive copy remains if policy says independent.

Pass criteria:

- My Drive and Company Drive do not accidentally delete each other.
- Company metadata contains uploader and workspace info.
- Audit records move/add/delete.

Result log:

| Date | Commit | Policy tested | My Drive after move | Company after My delete | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
|  |  | Keep original |  |  | Pending |  |

---

### T-019 — Shared link import

Purpose: prove shared link download/save flow works.

Steps:

1. Create/get a shared link.
2. Import shared link on a second identity/device.
3. Download file.
4. Save to My Drive if supported.
5. Confirm hash match.

Pass criteria:

- Link imports correctly.
- Unauthorized private data is not exposed.
- Download hash matches.

Result log:

| Date | Commit | Link source | Import device | Hash match | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  | Pending |  |

---

### T-020 — PayPal successful subscription

Purpose: prove paid plan activates only after PayPal confirmation.

Steps:

1. Start PayPal server with credentials and plan unlock secret.
2. Login with wallet or seed identity.
3. Select paid plan.
4. Complete PayPal approval.
5. Confirm subscription.
6. Confirm `wallet:setPlan` receives valid unlock token.
7. Restart app and confirm paid plan persists.

Pass criteria:

- Payment success activates selected plan.
- Quota increases immediately after confirmation.
- Plan unlock token is verified.
- No paid plan without valid token.

Result log:

| Date | Commit | Identity | Plan | Subscription ID | Quota updated | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  | Pending |  |

---

### T-021 — PayPal failed/cancelled payment

Purpose: prove paid plan does not unlock on failure.

Steps:

1. Start checkout.
2. Cancel PayPal flow.
3. Try failed payment case if sandbox supports it.
4. Restart app.
5. Confirm plan remains unchanged.

Pass criteria:

- No paid quota after cancelled payment.
- No local bypass through `wallet:setPlan` without token.
- Error message is clear.

Result log:

| Date | Commit | Scenario | Plan before | Plan after | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
|  |  | Cancelled |  |  | Pending |  |

---

### T-022 — PayPal webhook refresh

Purpose: prove backend tracks subscription status after approval/cancel/suspend.

Steps:

1. Configure `PAYPAL_WEBHOOK_ID`.
2. Trigger PayPal webhook in sandbox.
3. Confirm signature verification.
4. Confirm subscription record updates.
5. Confirm expired/cancelled subscription does not keep plan active after refresh.

Pass criteria:

- Invalid webhook signature rejected.
- Valid webhook updates subscription store.
- Plan state follows subscription status.

Result log:

| Date | Commit | Event type | Signature verified | Store updated | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  | Pending |  |

---

### T-023 — Installer/package test

Purpose: prove packaged app works like dev app.

Steps:

```powershell
pnpm run package:win
```

1. Install generated setup.
2. Launch app.
3. Confirm renderer loads.
4. Confirm firewall rule is installed or clear admin warning appears.
5. Close window and confirm tray/background mode.
6. Reopen from tray.
7. Restart Windows and confirm expected startup behavior if enabled.

Pass criteria:

- No `chrome-error://chromewebdata/`.
- No missing preload.
- App keeps running in background when window is closed.
- P2P port can accept inbound connections if firewall rule installed.

Result log:

| Date | Commit | Installer file | Fresh machine | Firewall | Tray | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  | Pending |  |

---

### T-024 — Different-network discovery

Purpose: prove global discovery works beyond one LAN.

Setup examples:

- Device A: home network
- Device B: mobile hotspot
- Device C: VPS

Steps:

1. Start bootstrap server or use configured bootstrap URL.
2. Start peers on different networks.
3. Confirm registry/peer list.
4. Try direct connection.
5. Upload and replicate.

Pass criteria:

- Peers register with bootstrap.
- App reports connected peers when reachable.
- If NAT blocks direct P2P, app must show clear state and safety peer must protect files.

Result log:

| Date | Commit | Network A | Network B | Bootstrap | Connected | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  | Pending |  |

---

### T-025 — 24-hour endurance run

Purpose: prove app stays stable over time.

Steps:

1. Start at least two peers.
2. Upload mixed files.
3. Leave app running for 24 hours.
4. Periodically upload/download/delete.
5. Record memory usage every 2 hours.
6. Check logs for retry storms, repair loops, stuck transfers, or sync failures.

Pass criteria:

- No crash.
- No runaway memory.
- No infinite repair loop.
- Files remain downloadable.

Result log:

| Date | Commit | Duration | Peer count | Uploads | Downloads | Deletes | Result | Evidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
|  |  | 24h |  |  |  |  | Pending |  |

---

### T-026 — Crash/restart recovery

Purpose: prove unexpected shutdown does not corrupt manifests/chunks.

Steps:

1. Start upload of 5 GB file.
2. Force-close app mid-upload.
3. Restart app.
4. Confirm no corrupted complete file appears.
5. Upload again.
6. Download and hash-check.
7. Repeat during download.

Pass criteria:

- Partial upload is cleaned or marked incomplete.
- No corrupted manifest treated as valid.
- Retried upload succeeds.

Result log:

| Date | Commit | Crash phase | Recovery behavior | Result | Evidence |
| --- | --- | --- | --- | --- | --- |
|  |  | upload |  | Pending |  |

---

### T-027 — Security baseline

Purpose: prove release does not contain obvious secrets or unsafe renderer behavior.

Steps:

1. Run `pnpm run audit:secrets`.
2. Run `pnpm run security:scan`.
3. Run `pnpm run production:scan`.
4. Confirm no private key/API secret is committed.
5. Confirm renderer has no Node integration.
6. Confirm preload only exposes safe bridge.

Pass criteria:

- All scans pass.
- No raw secrets in repo.
- No dangerous renderer IPC bypass.

Result log:

| Date | Commit | audit:secrets | security:scan | production:scan | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  | Pending |  |

---

### T-028 — Quota enforcement

Purpose: prove free/paid storage limits are enforced.

Steps:

1. Use free plan.
2. Upload until near quota.
3. Try upload beyond quota.
4. Activate paid plan.
5. Try same upload again.
6. Try downgrade below current used bytes.

Pass criteria:

- Free quota blocks extra upload.
- Paid quota allows larger upload after valid payment.
- Downgrade below used bytes is blocked.

Result log:

| Date | Commit | Plan | Used bytes | Attempted upload | Expected | Actual | Result |
| --- | --- | --- | ---: | ---: | --- | --- | --- |
|  |  | free |  |  | blocked |  | Pending |

---

### T-029 — File integrity and Merkle proof

Purpose: prove chunk integrity checks catch corruption.

Steps:

1. Upload file.
2. Download and hash-check.
3. Manually corrupt one local chunk in a test-only environment.
4. Try download.
5. Confirm integrity failure or network/safety repair fetches a valid copy.
6. Test prepare proof if UI exposes it.

Pass criteria:

- Corrupted chunk is not silently accepted.
- Download either repairs from another replica/safety or fails safely.

Result log:

| Date | Commit | Corruption type | Repair source | Result | Evidence |
| --- | --- | --- | --- | --- | --- |
|  |  | local chunk bytes |  | Pending |  |

---

## Historical experiments to re-run and confirm

These are scenarios previously discussed during development. They must be rerun on the current commit before final release.

| Scenario | Target result | Current release status |
| --- | --- | --- |
| 2.24 GB file producing ~1000+ chunks | Upload/download/hash pass without memory crash | Pending rerun |
| 0 peers at upload time | Immediate AWS safety protection | Pending rerun |
| 1 peer Windows + Kali | Connected peer count >= 1 and chunk exchange | Pending rerun |
| Cancel upload | Rollback local and safety partial chunks | Pending rerun |
| Delete file | Immediate local/peer/safety cleanup and no resurrection after sync | Pending rerun |
| Company workspace create/invite/join | Workspace signed, member joins, roles persist | Pending rerun |
| Audit log empty issue | Audit entries appear for company actions | Pending rerun |
| PayPal paid plan | Plan updates only after confirmed payment token | Pending rerun |
| Packaged EXE startup | No handler missing, no chrome-error page | Pending rerun |

## Final release decision

A build can be called Enterprise Candidate only when:

- T-000 through T-014 are PASS.
- T-015 through T-018 are PASS for Company Drive release.
- T-020 through T-022 are PASS for paid plans release.
- T-023 is PASS for Windows release.
- T-025 is PASS for stability.
- No open FAIL remains without a linked fix commit.

Final sign-off:

```text
Release candidate version:
Commit SHA:
Date:
Tester:
All required tests passed: yes/no
Known limitations:
Approved for pilot company: yes/no
Approved for public release: yes/no
```

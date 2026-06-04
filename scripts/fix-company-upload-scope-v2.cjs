const fs = require('node:fs');
const path = require('node:path');

let changed = false;

function patchFile(filePath, patcher) {
  const file = path.join(...filePath.split('/'));
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, 'utf8');
  const after = patcher(before);
  if (after !== before) {
    fs.writeFileSync(file, after, 'utf8');
    changed = true;
    console.log(`[fix-company-upload-scope-v2] patched ${filePath}`);
  }
}

function replaceAll(text, from, to) {
  return text.split(from).join(to);
}

patchFile('electron/stream-upload-override.js', (text) => {
  if (text.includes("companyOnly: Boolean(payload.companyOnly || payload.workspaceId)")) return text;

  const from = `    visibility: 'private',
    isPublic: false,
`;
  const to = `    visibility: 'private',
    isPublic: false,
    workspaceId: String(payload.workspaceId || ''),
    driveScope: payload.companyOnly || payload.workspaceId ? 'company' : 'personal',
    companyOnly: Boolean(payload.companyOnly || payload.workspaceId),
`;

  return text.includes(from) ? text.replace(from, to) : text;
});

patchFile('electron/company-workspace-store.js', (text) => {
  let next = text;

  next = next.replace(
    `  addFile({ workspaceId, file, folder = '', folderId = '', folderPath = '' } = {}) {`,
    `  addFile({ workspaceId, file, folder = '', folderId = '', folderPath = '', companyOnly = false, source = '', driveScope = '' } = {}) {`
  );

  if (!next.includes('companyOnly: Boolean(companyOnly || file?.companyOnly')) {
    next = next.replace(
      `      hidden: false,
      deleted: false,
`,
      `      hidden: false,
      deleted: false,
      source: source || (companyOnly || file?.companyOnly || file?.driveScope === 'company' || file?.workspaceId === workspaceId ? 'company-upload' : 'my-drive-add-to-company'),
      driveScope: driveScope || (companyOnly || file?.companyOnly || file?.driveScope === 'company' || file?.workspaceId === workspaceId ? 'company' : 'shared-from-my-drive'),
      companyOnly: Boolean(companyOnly || file?.companyOnly || file?.driveScope === 'company' || file?.workspaceId === workspaceId),
`
    );
  }

  return next;
});

patchFile('client/src/NativeP2PAppLive.tsx', (text) => {
  let next = text;

  // Direct file upload while in Company Drive: mark uploaded manifest as company-only.
  next = next.replace(
    `          workspaceId:
            view === "company" || view === "admin" ? activeWorkspace?.workspaceId : null,

          folderId: activeFolderId || "",`,
    `          workspaceId:
            view === "company" || view === "admin" ? activeWorkspace?.workspaceId : null,
          companyOnly: view === "company" || view === "admin",
          source: view === "company" || view === "admin" ? "company-upload" : "personal-upload",
          driveScope: view === "company" || view === "admin" ? "company" : "personal",

          folderId: activeFolderId || "",`
  );

  // Folder upload while in Company Drive: mark uploaded manifests as company-only.
  next = next.replace(
    `          isEncrypted: true,
          drivePassword: password(),
          folderId: activeFolderId || "",`,
    `          isEncrypted: true,
          drivePassword: password(),
          workspaceId:
            view === "company" || view === "admin" ? activeWorkspace?.workspaceId : null,
          companyOnly: view === "company" || view === "admin",
          source: view === "company" || view === "admin" ? "company-upload" : "personal-upload",
          driveScope: view === "company" || view === "admin" ? "company" : "personal",
          folderId: activeFolderId || "",`
  );

  // Direct company upload -> company file record is company-only.
  next = next.replace(
    `            workspaceId: activeWorkspace.workspaceId,
            file,
            folderId: activeFolderId || "",`,
    `            workspaceId: activeWorkspace.workspaceId,
            file,
            companyOnly: true,
            source: "company-upload",
            driveScope: "company",
            folderId: activeFolderId || "",`
  );

  // Add to Company from My Drive -> keep visible in both.
  next = next.replace(
    `      workspaceId: activeWorkspace.workspaceId,
      file,
      folderId: activeFolderId || "",`,
    `      workspaceId: activeWorkspace.workspaceId,
      file,
      companyOnly: false,
      source: "my-drive-add-to-company",
      driveScope: "shared-from-my-drive",
      folderId: activeFolderId || "",`
  );

  const oldPersonal = `const personalFiles = useMemo(
  () =>
    files.filter(
      (file) =>
        isRealFileManifest(file) &&
        !personalHiddenCompanyFileKeys.has(keyFor(file)) &&
        !personalHiddenCompanyFileKeys.has(file.hash)
    ),
  [files, personalHiddenCompanyFileKeys]
);`;

  const newPersonal = `const personalFiles = useMemo(
  () =>
    files.filter((file) => {
      if (!isRealFileManifest(file)) return false;
      if (personalHiddenCompanyFileKeys.has(keyFor(file))) return false;
      if (personalHiddenCompanyFileKeys.has(file.hash)) return false;

      const fileAny = file as any;
      const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);
      const cf = match?.companyFile as any;
      const companyOnly = Boolean(
        fileAny.companyOnly ||
          fileAny.driveScope === "company" ||
          fileAny.workspaceId ||
          cf?.companyOnly ||
          cf?.driveScope === "company" ||
          cf?.source === "company-upload"
      );

      return !companyOnly;
    }),
  [files, personalHiddenCompanyFileKeys, companyFileByKey]
);`;

  if (next.includes(oldPersonal)) {
    next = next.replace(oldPersonal, newPersonal);
  }

  return next;
});

patchFile('scripts/electron-dev-cloud.cjs', (text) => {
  if (text.includes("scripts/fix-company-upload-scope-v2.cjs")) return text;

  const line = "runOptionalScript('scripts/fix-company-upload-scope-v2.cjs');\n";

  if (text.includes("runOptionalScript('scripts/fix-company-upload-scope.cjs');")) {
    return text.replace(
      "runOptionalScript('scripts/fix-company-upload-scope.cjs');\n",
      "runOptionalScript('scripts/fix-company-upload-scope.cjs');\n" + line
    );
  }

  if (text.includes("runOptionalScript('scripts/fix-audit-record-main-no-duplicate.cjs');")) {
    return text.replace(
      "runOptionalScript('scripts/fix-audit-record-main-no-duplicate.cjs');\n",
      "runOptionalScript('scripts/fix-audit-record-main-no-duplicate.cjs');\n" + line
    );
  }

  if (text.includes("runOptionalScript('scripts/ensure-image-preview-ipc.cjs');")) {
    return text.replace(
      "runOptionalScript('scripts/ensure-image-preview-ipc.cjs');\n",
      "runOptionalScript('scripts/ensure-image-preview-ipc.cjs');\n" + line
    );
  }

  return text;
});

console.log(changed ? '[fix-company-upload-scope-v2] done' : '[fix-company-upload-scope-v2] already fixed');

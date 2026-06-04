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
    console.log(`[fix-company-upload-scope] patched ${filePath}`);
  }
}

patchFile('electron/stream-upload-override.js', (text) => {
  if (text.includes("companyOnly: Boolean(payload.workspaceId)")) return text;

  return text.replace(
`    visibility: 'private',
    isPublic: false,
`,
`    visibility: 'private',
    isPublic: false,
    workspaceId: String(payload.workspaceId || ''),
    driveScope: payload.workspaceId ? 'company' : 'personal',
    companyOnly: Boolean(payload.workspaceId),
`
  );
});

patchFile('electron/company-workspace-store.js', (text) => {
  let next = text;

  next = next.replace(
`  addFile({ workspaceId, file, folder = '', folderId = '', folderPath = '' } = {}) {`,
`  addFile({ workspaceId, file, folder = '', folderId = '', folderPath = '', companyOnly = false, source = '' } = {}) {`
  );

  if (!next.includes('companyOnly: Boolean(companyOnly || file?.companyOnly || file?.driveScope === \'company\'')) {
    next = next.replace(
`      hidden: false,
      deleted: false,
`,
`      hidden: false,
      deleted: false,
      source: source || (companyOnly || file?.companyOnly || file?.driveScope === 'company' ? 'company-upload' : 'my-drive-add-to-company'),
      driveScope: companyOnly || file?.companyOnly || file?.driveScope === 'company' ? 'company' : 'shared-from-my-drive',
      companyOnly: Boolean(companyOnly || file?.companyOnly || file?.driveScope === 'company' || file?.workspaceId === workspaceId),
`
    );
  }

  return next;
});

patchFile('client/src/NativeP2PAppLive.tsx', (text) => {
  let next = text;

  // Company Drive direct upload: company-only. This should not show in My Drive.
  next = next.replace(
`            file,
            folderId: activeFolderId || "",`,
`            file,
            companyOnly: true,
            source: "company-upload",
            driveScope: "company",
            folderId: activeFolderId || "",`
  );

  // Same for folder upload while inside Company Drive.
  next = next.replace(
`            file,
            folderId: activeFolderId || "",`,
`            file,
            companyOnly: true,
            source: "company-upload",
            driveScope: "company",
            folderId: activeFolderId || "",`
  );

  // Add to Company from My Drive: shared, keep visible in both drives.
  next = next.replace(
`      file,
      folderId: activeFolderId || "",`,
`      file,
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

      const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);
      const cf = match?.companyFile as any;
      const fileAny = file as any;
      const directCompanyUpload = Boolean(
        fileAny.companyOnly ||
          fileAny.driveScope === "company" ||
          fileAny.workspaceId ||
          cf?.companyOnly ||
          cf?.driveScope === "company" ||
          cf?.source === "company-upload"
      );

      return !directCompanyUpload;
    }),
  [files, personalHiddenCompanyFileKeys, companyFileByKey]
);`;

  if (next.includes(oldPersonal)) {
    next = next.replace(oldPersonal, newPersonal);
  }

  return next;
});

patchFile('scripts/electron-dev-cloud.cjs', (text) => {
  if (text.includes("scripts/fix-company-upload-scope.cjs")) return text;
  if (text.includes("runOptionalScript('scripts/fix-audit-record-main-no-duplicate.cjs');")) {
    return text.replace(
      "runOptionalScript('scripts/fix-audit-record-main-no-duplicate.cjs');\n",
      "runOptionalScript('scripts/fix-audit-record-main-no-duplicate.cjs');\nrunOptionalScript('scripts/fix-company-upload-scope.cjs');\n"
    );
  }
  if (text.includes("runOptionalScript('scripts/ensure-image-preview-ipc.cjs');")) {
    return text.replace(
      "runOptionalScript('scripts/ensure-image-preview-ipc.cjs');\n",
      "runOptionalScript('scripts/ensure-image-preview-ipc.cjs');\nrunOptionalScript('scripts/fix-company-upload-scope.cjs');\n"
    );
  }
  return text;
});

console.log(changed ? '[fix-company-upload-scope] done' : '[fix-company-upload-scope] already fixed');

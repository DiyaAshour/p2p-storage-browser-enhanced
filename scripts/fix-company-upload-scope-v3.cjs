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
    console.log(`[fix-company-upload-scope-v3] patched ${filePath}`);
  }
}

function replaceBetween(text, startMarker, endMarker, patcher) {
  const start = text.indexOf(startMarker);
  if (start < 0) return text;
  const end = text.indexOf(endMarker, start);
  if (end < 0) return text;
  const before = text.slice(0, start);
  const block = text.slice(start, end);
  const after = text.slice(end);
  return before + patcher(block) + after;
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

  // Mark direct uploads from Company/Admin view at upload-manifest level.
  if (!next.includes('companyOnly: view === "company" || view === "admin"')) {
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

    next = replaceBetween(
      next,
      '  const uploadFolder = () =>',
      '  const addFileToCompanyDrive =',
      (block) => block.replace(
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
      )
    );
  }

  // Direct company upload -> company record is company-only.
  next = replaceBetween(
    next,
    '      if ((view === "company" || view === "admin") && activeWorkspace && result?.files?.length) {',
    '      if (!result?.cancelled) {',
    (block) => block.replaceAll(
      `            workspaceId: activeWorkspace.workspaceId,
            file,
            folderId: activeFolderId || "",`,
      `            workspaceId: activeWorkspace.workspaceId,
            file,
            companyOnly: true,
            source: "company-upload",
            driveScope: "company",
            folderId: activeFolderId || "",`
    )
  );

  next = replaceBetween(
    next,
    '      if ((view === "company" || view === "admin") && activeWorkspace && result?.files?.length) {',
    '      if (!result?.cancelled) {',
    (block) => block.replaceAll(
      `            workspaceId: activeWorkspace.workspaceId,
            file,
            companyOnly: true,
            source: "company-upload",
            driveScope: "company",
            companyOnly: true,`,
      `            workspaceId: activeWorkspace.workspaceId,
            file,
            companyOnly: true,`
    )
  );

  // Add to Company from My Drive -> shared, should remain in both.
  next = replaceBetween(
    next,
    '  const addFileToCompanyDrive = (file: P2PFile) =>',
    '  const download = (file: P2PFile) =>',
    (block) => block.replace(
      `      workspaceId: activeWorkspace.workspaceId,
      file,
      folderId: activeFolderId || "",`,
      `      workspaceId: activeWorkspace.workspaceId,
      file,
      companyOnly: false,
      source: "my-drive-add-to-company",
      driveScope: "shared-from-my-drive",
      folderId: activeFolderId || "",`
    )
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

  if (next.includes(oldPersonal)) next = next.replace(oldPersonal, newPersonal);

  // If a company-only file is deleted from Company Drive, also delete its underlying P2P manifest/chunks.
  if (!next.includes('const companyOnlyDelete = Boolean(')) {
    next = next.replace(
      `if (match) {
  await api.invoke("company:updateFile", {
    workspaceId: match.workspace.workspaceId,
    rootHash: match.companyFile.rootHash,
    patch: { deleted: true },
  });`,
      `if (match) {
  const companyOnlyDelete = Boolean(
    (file as any).companyOnly ||
      (file as any).driveScope === "company" ||
      (file as any).workspaceId ||
      (match.companyFile as any).companyOnly ||
      (match.companyFile as any).driveScope === "company" ||
      (match.companyFile as any).source === "company-upload"
  );

  await api.invoke("company:updateFile", {
    workspaceId: match.workspace.workspaceId,
    rootHash: match.companyFile.rootHash,
    patch: { deleted: true },
  });

  if (companyOnlyDelete) {
    try {
      await api.invoke("p2p:delete", {
        hash: file.hash,
        rootHash: file.rootHash,
        id: file.id,
        itemId: itemIdFor(file),
      });
    } catch {}
  }`
    );

    next = next.replace(
      `  toast.success("Removed from company manifest.");`,
      `  toast.success(companyOnlyDelete ? "Deleted company-only file." : "Removed from company manifest.");`
    );
  }

  return next;
});

patchFile('scripts/electron-dev-cloud.cjs', (text) => {
  if (text.includes("scripts/fix-company-upload-scope-v3.cjs")) return text;
  return text.replace(
    "runOptionalScript('scripts/ensure-image-preview-ipc.cjs');\n",
    "runOptionalScript('scripts/ensure-image-preview-ipc.cjs');\nrunOptionalScript('scripts/fix-company-upload-scope-v3.cjs');\n"
  );
});

console.log(changed ? '[fix-company-upload-scope-v3] done' : '[fix-company-upload-scope-v3] already fixed');

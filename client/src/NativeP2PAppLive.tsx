import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Cloud,
  Download,
  Eye,
  EyeOff,
  FileCheck2,
  FolderOpen,
  HardDrive,
  KeyRound,
  Lock,
  Pencil,
  RefreshCw,
  Search,
  Share2,
  ShieldCheck,
  Trash2,
  Upload,
  UserPlus,
  Users,
  Wallet,
  Wifi,
  Zap,
  FolderPlus,
  MoveRight,
} from "lucide-react";
import { toast } from "sonner";
import SignClient from "@walletconnect/sign-client";
import { WalletConnectModal } from "@walletconnect/modal";

// ─── Channel Types ────────────────────────────────────────────────────────────
type Channel =
  | "p2p:start"
  | "p2p:listFiles"
  | "p2p:listFolders"
  | "p2p:createFolder"
  | "p2p:deleteItem"
  | "p2p:renameItem"
  | "p2p:moveItem"
  | "p2p:uploadFiles"
  | "p2p:uploadFolder"
  | "p2p:getUiPrefs"
  | "p2p:setUiPrefs"
  | "p2p:downloadToPath"
  | "p2p:delete"
  | "p2p:deleteFolder"
  | "p2p:networkSummary"
  | "p2p:pauseProtectionRetry"
  | "p2p:resumeProtectionRetry"
  | "p2p:prepareProof"
  | "wallet:status"
  | "wallet:connect"
  | "wallet:disconnect"  | "paypal:createSubscription"
  | "paypal:openCheckout"
  | "paypal:confirmSubscription"
  | "seed:create"
  | "seed:login"
  | "seed:recover"
  | "company:state"
  | "company:deviceIdentity"
  | "company:createWorkspace"
  | "company:inviteMember"
  | "company:joinWorkspace"
  | "company:changeMemberRole"
  | "company:removeMember"
  | "company:addFile"
  | "company:updateFile"
  | "company:createFolder"
  | "company:updateFolder"
  | "company:deleteFolder"
  | "audit:list"
  | "audit:record"
  | "audit:clear"
  | "audit:listManifests"
  | "wallet:setPlan";

// ─── Types ────────────────────────────────────────────────────────────────────
type Bridge = { invoke: <T>(channel: Channel, payload?: unknown) => Promise<T> };
type Plan = {
  id: string;
  name: string;
  quotaBytes: number;
  priceUsd: number;
  locked?: boolean;
  description?: string;
};

type WalletState = {
  connected: boolean;
  address: string;
  planId?: string;
  accountId?: string;
  authMode?: "wallet" | "seed" | null;
  username?: string | null;
  seedFingerprint?: string | null;
  usedBytes: number;
  remainingBytes: number;
  plan: Plan;
  plans: Plan[];
  minDrivePasswordLength?: number;
};

type Summary = {
  totalFiles: number;
  encryptedFiles: number;
  totalBytes: number;
  connectedPeers: number;
  safetyPeerUrl?: string;
};

type Role = "owner" | "admin" | "manager" | "editor" | "viewer" | "guest";

type DeviceIdentity = {
  deviceId: string;
  displayName?: string;
  email?: string;
};

type Member = {
  memberId: string;
  deviceId: string;
  email: string;
  displayName?: string;
  role: Role;
  status: "active" | "invited";
  inviteToken?: string;
};

type CompanyFile = {
  fileId: string;
  rootHash: string;
  hash?: string;
  name: string;
  size: number;
  totalChunks: number;
  folder?: string;
  folderId?: string;
  parentFolderId?: string;
  folderPath?: string;
  uploadedAt: string;
  uploadedByDeviceId: string;
  uploadedByName?: string;
  hidden?: boolean;
  deleted?: boolean;
};

type Workspace = {
  workspaceId: string;
  name: string;
  ownerWallet?: string;
  signatureValid?: boolean;
  members: Member[];
  files: CompanyFile[];
  folders?: DriveFolder[];
  createdAt: string;
  updatedAt?: string;
};

type CompanyState = {
  ok: boolean;
  deviceIdentity: DeviceIdentity;
  workspaces: Workspace[];
};

type AuditEvent = {
  auditId: string;
  action: string;
  actor: string;
  at: string;
  details?: Record<string, unknown>;
  p2p?: unknown;
};

type P2PFile = {
  id?: string;
  name: string;
  size: number;
  hash: string;
  rootHash: string;
  uploadedAt: string;
  isEncrypted: boolean;
  totalChunks: number;
  ownerWallet?: string;
  uploadedByName?: string;
  uploadedByWallet?: string;
  uploadedByDeviceId?: string;
  replicas?: string[];
  replicationStatus?: string;
  protectedChunks?: number;
  needsRepairChunks?: number;
  folderId?: string;
  parentFolderId?: string;
  folderName?: string;
  folder?: string;
};

type DriveFolder = {
  id?: string;
  hash?: string;
  rootHash?: string;
  kind?: string;
  isFolder?: boolean;
  folderId: string;
  name: string;
  parentFolderId?: string | null;
};

type CreateFolderResponse =
  | DriveFolder
  | {
      ok?: boolean;
      folder?: DriveFolder;
      folders?: DriveFolder[];
    };

type View = "personal" | "company" | "shared" | "admin";

declare global {
  interface Window {
    electron?: Bridge;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────
const ALL_FILES = "All files";
const UNCATEGORIZED = "Uncategorized";
const ACTIVE_WORKSPACE_KEY = "chunknet.ui.activeWorkspace";
const PERSONAL_HIDDEN_COMPANY_FILES_KEY = "chunknet.ui.personalHiddenCompanyFiles";

const WALLETCONNECT_PROJECT_ID =
  (import.meta as any).env?.VITE_WALLETCONNECT_PROJECT_ID ||
  "821b9d64c996dc59c7d18583fc7081f0";


// ─── Helpers ──────────────────────────────────────────────────────────────────
function getBridge(): Bridge | null {
  return typeof window !== "undefined" && typeof window.electron?.invoke === "function"
    ? window.electron
    : null;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function bytes(n = 0) {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(2)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${n} B`;
}

function short(value = "") {
  return value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "Guest";
}

function date(value?: string) {
  const d = new Date(value || "");
  return Number.isNaN(d.getTime()) ? "unknown" : d.toLocaleString();
}

function err(error: unknown) {
  return error instanceof Error ? error.message : "Operation failed";
}

function canManage(role?: Role | null) {
  return role === "owner" || role === "admin" || role === "manager";
}

function canUpload(role?: Role | null) {
  return role === "owner" || role === "admin" || role === "manager" || role === "editor";
}

function keyFor(file: P2PFile) {
  return file.rootHash || file.hash;
}

function itemIdFor(file: P2PFile) {
  return file.id || file.rootHash || file.hash;
}

function fileKeyMatches(companyFile: CompanyFile, file: P2PFile) {
  return (
    companyFile.rootHash === file.rootHash ||
    companyFile.hash === file.hash ||
    companyFile.rootHash === file.hash
  );
}

function protection(file: P2PFile) {
  if (!file.totalChunks || file.totalChunks <= 0) {
    return {
      label: "No chunks",
      tone: "text-zinc-400",
      details: "0/0 chunks",
    };
  }

  const status = file.replicationStatus || "protecting";

  if (status === "protected") {
    return {
      label: "Protected",
      tone: "text-emerald-300",
      details: `${file.protectedChunks ?? file.totalChunks}/${file.totalChunks} chunks`,
    };
  }

  if (status === "needs-repair") {
    return {
      label: "Needs repair",
      tone: "text-amber-300",
      details: `${file.needsRepairChunks ?? 0} chunk(s) need repair`,
    };
  }

  return {
    label: "Protecting",
    tone: "text-blue-300",
    details: `${file.protectedChunks ?? 0}/${file.totalChunks} protected`,
  };
}

function isRealFileManifest(file: P2PFile): boolean {
  const anyFile = file as any;

  if (anyFile.kind === "folder") return false;
  if (anyFile.type === "folder") return false;
  if (anyFile.isFolder === true) return false;

  if (String(file.hash || "").startsWith("folder:")) return false;
  if (String(file.rootHash || "").startsWith("folder:")) return false;

  if (String(file.hash || "").startsWith("ui:prefs:")) return false;
  if (String(file.rootHash || "").startsWith("ui:prefs:")) return false;
  if (String(anyFile.type || "") === "ui-prefs") return false;

  const name = String(file.name || "").replace(/\\/g, "/").split("/").pop() || "";
  if (name === ".p2p-folder") return false;

  if (!file.hash && !file.rootHash) return false;

  if (!file.totalChunks || file.totalChunks <= 0) return false;

  return true;
}

// ─── Component ────────────────────────────────────────────────────────────────
type AskTextOptions = {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  inputType?: "text" | "password";
  confirmText?: string;
  danger?: boolean;
  hideInput?: boolean;
};

function askText(options: AskTextOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className =
      "fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4";

    const card = document.createElement("div");
    card.className =
      "w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-5 text-zinc-50 shadow-2xl";

    const title = document.createElement("h2");
    title.className = "text-base font-semibold";
    title.textContent = options.title;
    card.appendChild(title);

    if (options.message) {
      const message = document.createElement("p");
      message.className = "mt-2 whitespace-pre-wrap text-sm text-zinc-400";
      message.textContent = options.message;
      card.appendChild(message);
    }

    let input: HTMLInputElement | null = null;

    if (!options.hideInput) {
      input = document.createElement("input");
      input.type = options.inputType || "text";
      input.value = options.defaultValue || "";
      input.placeholder = options.placeholder || "";
      input.className =
        "mt-4 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-50 outline-none";
      card.appendChild(input);
    }

    const actions = document.createElement("div");
    actions.className = "mt-4 flex justify-end gap-2";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className =
      "rounded-xl border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800";
    cancel.textContent = "Cancel";

    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = options.danger
      ? "rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
      : "rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500";
    ok.textContent = options.confirmText || "OK";

    const close = (value: string | null) => {
      overlay.remove();
      resolve(value);
    };

    cancel.onclick = () => close(null);
    ok.onclick = () => close(options.hideInput ? "" : input?.value ?? "");

    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close(null);
      if (event.key === "Enter" && !options.hideInput) close(input?.value ?? "");
    });

    actions.appendChild(cancel);
    actions.appendChild(ok);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    setTimeout(() => input?.focus(), 0);
  });
}

function showInfo(titleText: string, messageText: string): Promise<string | null> {
  return askText({
    title: titleText,
    message: messageText,
    hideInput: true,
    confirmText: "OK",
  });
}

export default function NativeP2PAppLive() {
  const api = getBridge();

  // Core state
  const [summary, setSummary] = useState<Summary | null>(null);
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [files, setFiles] = useState<P2PFile[]>([]);
  const [manifestFolders, setManifestFolders] = useState<DriveFolder[]>([]);
  const [company, setCompany] = useState<CompanyState | null>(null);
const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
const [busy, setBusy] = useState(false);
const [planPickerOpen, setPlanPickerOpen] = useState(false);
const [payingPlanId, setPayingPlanId] = useState("");
  const [view, setView] = useState<View>("personal");
  const [search, setSearch] = useState("");
  const isEncrypted = true;
  const [drivePassword, setDrivePassword] = useState("");
  const [activeFolder, setActiveFolder] = useState(ALL_FILES);
  const [activeFolderId, setActiveFolderId] = useState<string>("");
  const [newFolder, setNewFolder] = useState("");
  const [workspaceNameInput, setWorkspaceNameInput] = useState("");

const [memberEmail, setMemberEmail] = useState("");
const [memberRole, setMemberRole] = useState<Role>("viewer");
const [joinInviteToken, setJoinInviteToken] = useState("");
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(
    () => readJson(ACTIVE_WORKSPACE_KEY, "")
  );

  // Bulk select state
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [bulkTargetFolderId, setBulkTargetFolderId] = useState<string>("");
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
  const [personalHiddenCompanyFileKeys, setPersonalHiddenCompanyFileKeys] = useState<Set<string>>(
  () => new Set(readJson<string[]>(PERSONAL_HIDDEN_COMPANY_FILES_KEY, []))
);

  const walletConnected = Boolean(
    wallet?.connected && wallet.authMode !== "seed" && (wallet.accountId || wallet.address)
  );

  const seedConnected = Boolean(
    wallet?.connected &&
      wallet.authMode === "seed" &&
      (wallet.accountId || wallet.username || wallet.seedFingerprint)
  );

  const identityConnected = walletConnected || seedConnected;

  const identityLabel = seedConnected
    ? `Seed: ${wallet?.username || short(wallet?.seedFingerprint || "")}`
    : walletConnected
      ? short(wallet?.accountId || wallet?.address || "")
      : "Guest";

  const workspaces = company?.workspaces || [];
  const activeWorkspace =
    workspaces.find((w) => w.workspaceId === activeWorkspaceId) || workspaces[0] || null;

  // ─── UPDATED: Save activeWorkspaceId to localStorage ────────────────────────
  useEffect(() => {
    if (!activeWorkspace?.workspaceId) return;

    localStorage.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify(activeWorkspace.workspaceId));
  }, [activeWorkspace?.workspaceId]);

  const deviceId = company?.deviceIdentity?.deviceId || "";
  const localMember = activeWorkspace?.members?.find((m) => m.deviceId === deviceId) || null;
  const localRole = localMember?.role || null;
  const minPasswordLength = wallet?.minDrivePasswordLength || 12;

  const peerCount = summary?.connectedPeers ?? 0;

  const quota = wallet?.plan?.quotaBytes
    ? Math.min(100, (wallet.usedBytes / wallet.plan.quotaBytes) * 100)
    : 0;

  const defaultPaidPlans = useMemo<Plan[]>(
  () => [
    {
      id: "starter",
      name: "Starter",
      quotaBytes: 100 * 1024 ** 3,
      priceUsd: 2.99,
      locked: true,
      description: "100 GB storage plan",
    },
    {
      id: "personal",
      name: "Personal",
      quotaBytes: 1 * 1024 ** 4,
      priceUsd: 7.99,
      locked: true,
      description: "1 TB storage plan",
    },
    {
      id: "plus",
      name: "Plus",
      quotaBytes: 3 * 1024 ** 4,
      priceUsd: 14.99,
      locked: true,
      description: "3 TB storage plan",
    },
    {
      id: "pro",
      name: "Pro",
      quotaBytes: 7 * 1024 ** 4,
      priceUsd: 24.99,
      locked: true,
      description: "7 TB storage plan",
    },
    {
      id: "ultra",
      name: "Ultra",
      quotaBytes: 10 * 1024 ** 4,
      priceUsd: 34.99,
      locked: true,
      description: "10 TB storage plan",
    },
  ],
  []
);

const visiblePaidPlans = useMemo(() => {
  const remotePlans = (wallet?.plans || [])
    .filter((plan) => Number(plan.priceUsd || 0) > 0)
    .filter((plan) => !["tb1", "tb3", "tb7", "tb10"].includes(plan.id));

  return (remotePlans.length ? remotePlans : defaultPaidPlans)
    .slice()
    .sort((a, b) => Number(a.quotaBytes || 0) - Number(b.quotaBytes || 0));
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
  if (size >= 1024 ** 4) return `${Math.round(size / 1024 ** 4)} TB`;
  return `${Math.round(size / 1024 ** 3)} GB`;
};
  
  const folderById = useMemo(() => {
    const map = new Map<string, DriveFolder>();
    for (const folder of manifestFolders) {
      if (folder.folderId) map.set(folder.folderId, folder);
      if (folder.id) map.set(folder.id, folder);
      if (folder.hash) map.set(folder.hash, folder);
      if (folder.rootHash) map.set(folder.rootHash, folder);
    }
    return map;
  }, [manifestFolders]);

  const folderChildren = useMemo(() => {
    const map = new Map<string, DriveFolder[]>();

    for (const folder of manifestFolders) {
      const parent = String(folder.parentFolderId || "");
      map.set(parent, [...(map.get(parent) || []), folder]);
    }

    for (const list of map.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }

    return map;
  }, [manifestFolders]);

  function folderPath(folder: DriveFolder): string {
    const names: string[] = [];
    const seen = new Set<string>();
    let cursor: DriveFolder | undefined = folder;

    while (cursor) {
      const id = cursor.folderId || cursor.id || cursor.name;
      if (seen.has(id)) break;
      seen.add(id);
      names.unshift(cursor.name);
      cursor = cursor.parentFolderId ? folderById.get(cursor.parentFolderId) : undefined;
    }

    return names.join(" / ");
  }

  function folderByNameOrPath(value: string): DriveFolder | null {
    const target = value.trim();
    if (!target) return null;

    return (
      manifestFolders.find((folder) => folder.name === target || folderPath(folder) === target) ||
      null
    );
  }

  const companyFolders = useMemo(() => {
    if (!activeWorkspace?.folders) return [];

    const map = new Map<string, DriveFolder>();

    for (const folder of activeWorkspace.folders) {
      if (!folder?.folderId || !folder?.name) continue;

      map.set(folder.folderId, {
        ...folder,
        folderId: String(folder.folderId),
        name: String(folder.name),
        parentFolderId: String(folder.parentFolderId || ""),
      });
    }

    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [activeWorkspace]);

  const companyFolderById = useMemo(() => {
    const map = new Map<string, DriveFolder>();

    for (const folder of companyFolders) {
      map.set(folder.folderId, folder);
      if (folder.id) map.set(folder.id, folder);
      if (folder.hash) map.set(folder.hash, folder);
      if (folder.rootHash) map.set(folder.rootHash, folder);
    }

    return map;
  }, [companyFolders]);

  const companyFolderChildren = useMemo(() => {
    const map = new Map<string, DriveFolder[]>();

    for (const folder of companyFolders) {
      const parent = String(folder.parentFolderId || "");
      map.set(parent, [...(map.get(parent) || []), folder]);
    }

    for (const list of map.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }

    return map;
  }, [companyFolders]);

  function companyFolderPath(folder: DriveFolder): string {
    const names: string[] = [];
    const seen = new Set<string>();
    let cursor: DriveFolder | undefined = folder;

    while (cursor) {
      const id = cursor.folderId || cursor.id || cursor.name;
      if (seen.has(id)) break;

      seen.add(id);
      names.unshift(cursor.name);
      cursor = cursor.parentFolderId ? companyFolderById.get(cursor.parentFolderId) : undefined;
    }

    return names.join(" / ");
  }

  function companyFolderByNameOrPath(value: string): DriveFolder | null {
    const target = value.trim();
    if (!target) return null;

    return (
      companyFolders.find(
        (folder) => folder.name === target || companyFolderPath(folder) === target
      ) || null
    );
  }

  // Company file lookup map
  const companyFileByKey = useMemo(() => {
    const map = new Map<string, { workspace: Workspace; companyFile: CompanyFile }>();

    for (const workspace of workspaces) {
      for (const companyFile of workspace.files || []) {
        if (companyFile.deleted) continue;
        map.set(companyFile.rootHash, { workspace, companyFile });
        if (companyFile.hash) map.set(companyFile.hash, { workspace, companyFile });
      }
    }

    return map;
  }, [workspaces]);

  // ─── File groups ────────────────────────────────────────────────────────────

const personalFiles = useMemo(
  () =>
    files.filter(
      (file) =>
        isRealFileManifest(file) &&
        !personalHiddenCompanyFileKeys.has(keyFor(file)) &&
        !personalHiddenCompanyFileKeys.has(file.hash)
    ),
  [files, personalHiddenCompanyFileKeys]
);
  
  const companyFiles = useMemo(() => {
    if (!activeWorkspace) return [];

    const allowed = (activeWorkspace.files || []).filter((file) => !file.deleted);

    return files
      .filter(isRealFileManifest)
      .filter((file) => allowed.some((companyFile) => fileKeyMatches(companyFile, file)));
  }, [files, activeWorkspace]);

  const sharedFiles = useMemo(
    () =>
      files.filter(
        (file) =>
          isRealFileManifest(file) &&
          (companyFileByKey.has(keyFor(file)) || companyFileByKey.has(file.hash))
      ),
    [files, companyFileByKey]
  );

  const realFilesCount = useMemo(
    () => files.filter(isRealFileManifest).length,
    [files]
  );

  const baseFiles =
    view === "company" || view === "admin"
      ? companyFiles
      : view === "shared"
        ? sharedFiles
        : personalFiles;

  function getPersonalFileFolderObject(file: P2PFile): DriveFolder | null {
    const directId = String(file.parentFolderId || file.folderId || "").trim();

    if (directId) {
      const byId = folderById.get(directId);
      if (byId) return byId;
    }

    const legacyName = String(file.folderName || file.folder || "").trim();

    if (legacyName) {
      const byName = manifestFolders.find((folder) => folder.name === legacyName);
      if (byName) return byName;
    }

    return null;
  }

  function getPersonalFileFolderId(file: P2PFile): string {
    return getPersonalFileFolderObject(file)?.folderId || "";
  }

  function getPersonalFileFolder(file: P2PFile): string {
    const folder = getPersonalFileFolderObject(file);
    return folder ? folderPath(folder) : UNCATEGORIZED;
  }

  const visibleFiles = useMemo(() => {
    const q = search.trim().toLowerCase();

    return baseFiles.filter((file) => {
      const fileName = String(file.name || "").replace(/\\/g, "/");
      if ((fileName.split("/").pop() || fileName) === ".p2p-folder") return false;

      const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);
      const cf = match?.companyFile;
      const displayName = cf?.name || file.name;

      const personalFolderId = match ? "" : getPersonalFileFolderId(file);
      const companyFolderId = String(cf?.folderId || cf?.parentFolderId || "").trim();
      const folderLabel = cf
        ? cf.folderPath || cf.folder || UNCATEGORIZED
        : getPersonalFileFolder(file);

      const folderOk = match
        ? activeFolder === ALL_FILES ||
          (activeFolder === UNCATEGORIZED && !companyFolderId && (!folderLabel || folderLabel === UNCATEGORIZED)) ||
          (activeFolderId ? companyFolderId === activeFolderId : activeFolder === folderLabel)
        : activeFolder === ALL_FILES ||
          (activeFolder === UNCATEGORIZED && !personalFolderId) ||
          (activeFolderId ? personalFolderId === activeFolderId : activeFolder === folderLabel);

      const queryOk =
        !q ||
        [displayName, file.hash, file.rootHash, folderLabel, match?.workspace.name, file.replicationStatus].some(
          (value) => String(value || "").toLowerCase().includes(q)
        );

      return folderOk && queryOk;
    }).sort((a, b) => {
      const am = companyFileByKey.get(keyFor(a)) || companyFileByKey.get(a.hash);
      const bm = companyFileByKey.get(keyFor(b)) || companyFileByKey.get(b.hash);

      const aName = String(am?.companyFile?.name || a.name || "").toLowerCase();
      const bName = String(bm?.companyFile?.name || b.name || "").toLowerCase();

      if (aName !== bName) return aName.localeCompare(bName);

      const aTime = new Date(am?.companyFile?.uploadedAt || a.uploadedAt || 0).getTime();
      const bTime = new Date(bm?.companyFile?.uploadedAt || b.uploadedAt || 0).getTime();

      if (aTime !== bTime) return aTime - bTime;

      return String(a.rootHash || a.hash || "").localeCompare(String(b.rootHash || b.hash || ""));
    });
  }, [
    baseFiles,
    search,
    activeFolder,
    activeFolderId,
    manifestFolders,
    folderById,
    companyFileByKey,
  ]);

  const visibleFolders = useMemo(() => {
    if (view !== "personal") return [];
    if (activeFolder === UNCATEGORIZED) return [];

    const q = search.trim().toLowerCase();
    const parentId = activeFolder === ALL_FILES ? "" : activeFolderId;

    return manifestFolders
      .filter((folder) => String(folder.parentFolderId || "") === parentId)
      .filter((folder) => {
        if (!q) return true;

        return [folder.name, folderPath(folder), folder.folderId, folder.hash, folder.rootHash].some(
          (value) => String(value || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [view, activeFolder, activeFolderId, search, manifestFolders, folderById]);

  const companyBytes = companyFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);

  useEffect(() => {
    if (!api || !wallet?.connected) return;

    api
      .invoke<{ expandedFolderIds?: string[] }>("p2p:getUiPrefs")
      .then((prefs) => {
        if (prefs?.expandedFolderIds?.length) {
          setExpandedFolderIds(new Set(prefs.expandedFolderIds));
        }
      })
      .catch(() => {});
  }, [api, wallet?.connected]);

  useEffect(() => {
    if (!api || !wallet?.connected) return;

    const t = setTimeout(() => {
      api
        .invoke("p2p:setUiPrefs", {
          expandedFolderIds: Array.from(expandedFolderIds),
        })
        .catch(() => {});
    }, 800);

    return () => clearTimeout(t);
  }, [api, expandedFolderIds, wallet?.connected]);

  const refreshAudit = async (workspaceId?: string) => {
  if (!api) return;

  try {
    const result = await api.invoke<{ events: AuditEvent[] }>("audit:list", {
      workspaceId: workspaceId || activeWorkspace?.workspaceId || "",
      limit: 200,
    });

    setAuditEvents(Array.isArray(result.events) ? result.events : []);
  } catch {
    setAuditEvents([]);
  }
};

const recordAudit = async (action: string, details: Record<string, unknown> = {}) => {
  if (!api) return;

  try {
    await api.invoke("audit:record", {
      action,
      details: {
        view,
        workspaceId: activeWorkspace?.workspaceId || "",
        workspaceName: activeWorkspace?.name || "",
        actorLabel: identityLabel,
        ...details,
      },
    });

    await refreshAudit(String(details.workspaceId || activeWorkspace?.workspaceId || ""));
  } catch {}
};

const uploaderLabel = (file: P2PFile, cf?: CompanyFile | null): string => {
  const raw = String(
    cf?.uploadedByName ||
      cf?.uploadedByDeviceId ||
      file.uploadedByName ||
      file.uploadedByWallet ||
      file.uploadedByDeviceId ||
      file.ownerWallet ||
      ""
  ).trim();

  const currentId = String(wallet?.accountId || wallet?.address || "").trim().toLowerCase();
  const currentName = wallet?.username ? `Seed: ${wallet.username}` : identityLabel;

  if (!raw) return currentName || "Unknown";
  if (raw.toLowerCase() === currentId) return currentName || "You";
  if (raw.startsWith("seed:") || raw.startsWith("0x")) return short(raw);
  return raw.length > 36 ? short(raw) : raw;
};

const showCompanyFileInfo = (file: P2PFile) => {
  const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);
  const cf = match?.companyFile;
  const workspace = match?.workspace || activeWorkspace;

  const details = [
    "File: " + (cf?.name || file.name),
    "Company Drive: " + (workspace?.name || "Unknown"),
    "Uploaded by: " + uploaderLabel(file, cf),
    "Uploaded at: " + date(cf?.uploadedAt || file.uploadedAt),
    "Size: " + bytes(file.size),
    "Folder: " + (cf?.folderPath || cf?.folder || file.folderName || file.folder || UNCATEGORIZED),
    "Root hash: " + (cf?.rootHash || file.rootHash || file.hash),
    "Hash: " + (cf?.hash || file.hash || ""),
    "Total chunks: " + String(file.totalChunks || cf?.totalChunks || 0),
    "Encrypted: " + (file.isEncrypted ? "Yes" : "No"),
    "Replication: " + (file.replicationStatus || "unknown"),
    "Workspace ID: " + (workspace?.workspaceId || ""),
    "File ID: " + (cf?.fileId || file.id || file.rootHash || file.hash),
  ].join("\n");

  void showInfo("Company file details", details);

  if (match) {
    void recordAudit("company:file-info-viewed", {
      workspaceId: match.workspace.workspaceId,
      workspaceName: match.workspace.name,
      fileName: cf?.name || file.name,
      rootHash: cf?.rootHash || file.rootHash || file.hash,
    });
  }
};
  
  const run = async (work: () => Promise<void>) => {
    setBusy(true);

    try {
      await work();
    } catch (error) {
      toast.error(err(error));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!api) return;

    const nextWallet = await api.invoke<WalletState>("wallet:status");
    setWallet(nextWallet);

    const [nextSummary, nextFiles, nextCompany] = await Promise.all([
      api.invoke<Summary>("p2p:networkSummary"),
      api.invoke<P2PFile[]>("p2p:listFiles", { query: search }),
      api.invoke<CompanyState>("company:state"),
    ]);

    let nextFolders: DriveFolder[] = [];

    if (nextWallet?.connected) {
      try {
        nextFolders = await api.invoke<DriveFolder[]>("p2p:listFolders");
      } catch {
        nextFolders = [];
      }
    }

    setSummary(nextSummary);
    setFiles(Array.isArray(nextFiles) ? nextFiles : []);
    setCompany(nextCompany);
    setManifestFolders(Array.isArray(nextFolders) ? nextFolders : []);

    try {
      const audit = await api.invoke<{ events: AuditEvent[] }>("audit:list", {
        workspaceId: activeWorkspaceId || nextCompany.workspaces?.[0]?.workspaceId || "",
        limit: 200,
      });

      setAuditEvents(Array.isArray(audit.events) ? audit.events : []);
    } catch {
      setAuditEvents([]);
    }

    if (!activeWorkspaceId && nextCompany.workspaces?.[0]?.workspaceId) {
      setActiveWorkspaceId(nextCompany.workspaces[0].workspaceId);
    }
  };

  useEffect(() => {
    if (!api) return;

    void run(async () => {
      await api.invoke("p2p:start");
      await api.invoke("company:deviceIdentity", {});
      await refresh();
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!api) {
    return (
      <div className="min-h-screen bg-zinc-950 p-8 text-zinc-50">
        Electron required. Run pnpm run electron:dev
      </div>
    );
  }

  // ─── Actions ────────────────────────────────────────────────────────────────
  const password = () => {
    const value = drivePassword.trim();

    if (value.length < minPasswordLength) {
      throw new Error(`Drive Password must be at least ${minPasswordLength} characters.`);
    }

    return value;
  };

  const connectWallet = () =>
    run(async () => {
      if (!WALLETCONNECT_PROJECT_ID) {
        throw new Error("Missing VITE_WALLETCONNECT_PROJECT_ID in .env");
      }

      const signClient = await SignClient.init({
        projectId: WALLETCONNECT_PROJECT_ID,
        metadata: {
          name: "Chunknet",
          description: "Chunknet P2P Cloud Wallet Login",
          url: "https://chunknet.local",
          icons: [],
        },
      });

      const modal = new WalletConnectModal({
        projectId: WALLETCONNECT_PROJECT_ID,
        chains: [WALLETCONNECT_CHAIN_ID],
      });

      const { uri, approval } = await signClient.connect({
        requiredNamespaces: {
          eip155: {
            methods: ["personal_sign"],
            chains: [WALLETCONNECT_CHAIN_ID],
            events: ["accountsChanged", "chainChanged"],
          },
        },
      });

      if (uri) {
        await modal.openModal({ uri });
      }

      const session = await approval();
      modal.closeModal();

      const account = session.namespaces.eip155?.accounts?.[0];
      if (!account) {
        throw new Error("No wallet account returned from WalletConnect");
      }

      const address = account.split(":").pop()?.toLowerCase();
      if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
        throw new Error("Invalid wallet address returned from WalletConnect");
      }

      const loginMessage = [
        "p2p.cloud login",
        `Wallet: ${address}`,
        `Time: ${new Date().toISOString()}`,
        "Purpose: unlock encrypted P2P cloud storage",
      ].join("\n");

      const signature = await signClient.request<string>({
        topic: session.topic,
        chainId: WALLETCONNECT_CHAIN_ID,
        request: {
          method: "personal_sign",
          params: [loginMessage, address],
        },
      });

      setWallet(
        await api.invoke<WalletState>("wallet:connect", {
          address,
          loginMessage,
          signature,
        })
      );

      await refresh();
    });

  const seedLogin = () =>
    run(async () => {
      const username = (
        await askText({
          title: "Seed Login",
          message: "Enter seed username",
          placeholder: "username",
          confirmText: "Next",
        })
      )?.trim();

      if (!username) return;

      const pw = (
        await askText({
          title: "Seed Login",
          message: "Enter seed password",
          inputType: "password",
          confirmText: "Login",
        })
      )?.trim();

      if (!pw) return;

      setWallet(await api.invoke<WalletState>("seed:login", { username, password: pw }));
      await refresh();
    });

  const seedCreate = () =>
    run(async () => {
      const username = (
        await askText({
          title: "Create Seed Account",
          message: "Choose seed username",
          placeholder: "username",
          confirmText: "Next",
        })
      )?.trim();

      if (!username) return;

      const pw = (
        await askText({
          title: "Create Seed Account",
          message: "Choose seed password / drive password",
          inputType: "password",
          confirmText: "Create",
        })
      )?.trim();

      if (!pw) return;

      const result = await api.invoke<WalletState & { seed?: string }>("seed:create", {
        username,
        password: pw,
      });

      setWallet(result);
      await api.invoke("p2p:start");
      await refresh();

      if (result.seed) {
        await showInfo("Recovery seed — save it now", result.seed);
      }
    });

  const seedRecover = () =>
    run(async () => {
      const username = (
        await askText({
          title: "Recover Seed Account",
          message: "Enter seed username",
          placeholder: "username",
          confirmText: "Next",
        })
      )?.trim();

      if (!username) return;

      const seed = (
        await askText({
          title: "Recover Seed Account",
          message: "Enter recovery seed",
          placeholder: "recovery seed",
          confirmText: "Next",
        })
      )?.trim();

      if (!seed) return;

      const pw = (
        await askText({
          title: "Recover Seed Account",
          message: "Enter new seed password / drive password",
          inputType: "password",
          confirmText: "Recover",
        })
      )?.trim();

      if (!pw) return;

      const result = await api.invoke<WalletState>("seed:recover", {
        username,
        seed,
        password: pw,
      });

      setWallet(result);
      await api.invoke("p2p:start");
      await refresh();
    });

  const disconnectWallet = () =>
    run(async () => {
      setWallet(await api.invoke<WalletState>("wallet:disconnect"));
      setManifestFolders([]);
      setActiveFolder(ALL_FILES);
      setActiveFolderId("");
      setSelectedItemIds(new Set());
      await refresh();
    });

  const createWorkspace = () =>
    run(async () => {
      const name = workspaceNameInput.trim();
      if (!name) return;

      const ws = await api.invoke<Workspace>("company:createWorkspace", {
        name,
        ownerWallet: wallet?.address || wallet?.accountId || "",
      });

      setActiveWorkspaceId(ws.workspaceId);
      setWorkspaceNameInput("");
      // ─── UPDATED: switch to admin view after create ────────────────────────
      setView("admin");
      await refresh();
      toast.success("Company workspace created and signed");
    });
const paidIdentity = () => {
  const account = String(wallet?.accountId || "").trim();
  const address = String(wallet?.address || "").trim();
  const username = String(wallet?.username || "").trim();

  if (account) return account;
  if (address) return address;
  if (username) return `seed:${username}`;

  return "";
};

const buyPlan = (plan: Plan) =>
  run(async () => {
    if (!identityConnected) {
      throw new Error("Connect wallet or sign in with Seed Account before subscribing");
    }

    if (!api) throw new Error("Electron bridge is not available");

    const identity = paidIdentity();
    if (!identity) {
      throw new Error("Valid wallet or seed account identity required");
    }

    if (!canSelectPlan(plan)) {
      throw new Error("Delete files first before switching to this lower plan");
    }

    setPayingPlanId(plan.id);

    try {
      const created = await api.invoke<any>("paypal:createSubscription", {
        planId: plan.id,
        wallet: identity,
        accountId: identity,
        identity,
        username: wallet?.username || "",
      });

      if (!created?.approveUrl) {
        throw new Error(created?.error || "Could not create PayPal subscription");
      }

      const checkout = await api.invoke<{ ok: boolean; cancelled?: boolean }>("paypal:openCheckout", {
        approveUrl: created.approveUrl,
      });

      if (!checkout?.ok) {
        throw new Error(checkout?.cancelled ? "PayPal subscription cancelled" : "PayPal subscription was not completed");
      }

      const confirmed = await api.invoke<any>("paypal:confirmSubscription", {
        subscriptionId: created.subscriptionId || created.orderId || created.id,
        orderId: created.orderId || created.subscriptionId || created.id,
        planId: plan.id,
        wallet: identity,
        accountId: identity,
        identity,
        username: wallet?.username || "",
      });

      if (!confirmed?.ok) {
        throw new Error(confirmed?.error || "Subscription was not activated");
      }

      const nextWallet = await api.invoke<WalletState>("wallet:setPlan", {
        planId: confirmed.planId || plan.id,
        paidUntil: confirmed.paidUntil,
        subscriptionId: confirmed.subscriptionId || confirmed.orderId || created.subscriptionId || created.id,
        txHash: confirmed.subscriptionId || confirmed.orderId || created.subscriptionId || created.id,
        planUnlockToken: confirmed.planUnlockToken,
      });

      setWallet(nextWallet);
      setPlanPickerOpen(false);
      await refresh();

      toast.success((confirmed.plan?.name || plan.name) + " plan activated");
    } finally {
      setPayingPlanId("");
    }
  });
  const joinWorkspace = () =>
    run(async () => {
      const inviteToken = joinInviteToken.trim();

      if (!inviteToken) {
        throw new Error("Paste company invite token first");
      }

      const result = await api.invoke<{ ok: boolean; workspace: Workspace }>(
        "company:joinWorkspace",
        {
          inviteToken,
          displayName: wallet?.username || identityLabel,
        }
      );

      setActiveWorkspaceId(result.workspace.workspaceId);
      setJoinInviteToken("");
      setView("admin");
      await refresh();

      toast.success(`Joined ${result.workspace.name}`);
    });
  
  const inviteMember = () =>
    run(async () => {
      if (!activeWorkspace) throw new Error("Select a company first");

      const email = memberEmail.trim();
      if (!email) return;

      const result = await api.invoke<{ workspace: Workspace; inviteToken: string }>(
        "company:inviteMember",
        { workspaceId: activeWorkspace.workspaceId, email, role: memberRole }
      );

      await navigator.clipboard.writeText(result.inviteToken);
      setMemberEmail("");
      await refresh();
      toast.success("Invite token copied.");
    });

  const changeMemberRole = (memberId: string, role: Role) =>
    run(async () => {
      if (!activeWorkspace) return;

      await api.invoke("company:changeMemberRole", {
        workspaceId: activeWorkspace.workspaceId,
        memberId,
        role,
      });

      await refresh();
    });

  const removeMember = (memberId: string) =>
    run(async () => {
      if (!activeWorkspace) return;

      await api.invoke("company:removeMember", {
        workspaceId: activeWorkspace.workspaceId,
        memberId,
      });

      await refresh();
    });

  const createFolder = () =>
    run(async () => {
      const name = newFolder.trim();
      if (!name) return;

      if (view === "company" || view === "admin") {
        if (!activeWorkspace) throw new Error("Create or select a Company Drive first");

        const response = await api.invoke<CreateFolderResponse>("company:createFolder", {
          workspaceId: activeWorkspace.workspaceId,
          name,
          parentFolderId: activeFolderId || "",
        });

        const folder =
          "folder" in response && response.folder ? response.folder : (response as DriveFolder);

        setNewFolder("");

        if (folder?.folderId) {
          setActiveFolder(folder.name);
          setActiveFolderId(folder.folderId);
        }

        await refresh();
        toast.success(`Company folder "${name}" created`);
        return;
      }

      const response = await api.invoke<CreateFolderResponse>("p2p:createFolder", {
        name,
        parentFolderId: activeFolderId || "",
      });

      const folder =
        "folder" in response && response.folder ? response.folder : (response as DriveFolder);

      if (!folder?.folderId) {
        throw new Error("Folder was created but backend did not return folderId");
      }

      setNewFolder("");

      if ("folders" in response && Array.isArray(response.folders)) {
        setManifestFolders(response.folders);
      } else {
        setManifestFolders((prev) => [
          ...prev.filter((existing) => existing.folderId !== folder.folderId),
          folder,
        ]);
      }

      setActiveFolder(folderPath(folder));
      setActiveFolderId(folder.folderId);
      await refresh();
      toast.success(`Folder "${name}" created`);
    });

  const renameFolder = (folder: DriveFolder) =>
    run(async () => {
      const name = (
        await askText({
          title: "Rename Folder",
          message: `Rename "${folder.name}"`,
          defaultValue: folder.name,
          placeholder: "New folder name",
          confirmText: "Rename",
        })
      )?.trim();

      if (!name || name === folder.name) return;

      await api.invoke("p2p:renameItem", { itemId: folder.folderId, name });
      await refresh();

      if (activeFolderId === folder.folderId) {
        setActiveFolder(name);
      }

      toast.success("Folder renamed");
    });

  const moveFolder = (folder: DriveFolder) =>
    run(async () => {
      const target = await askText({
        title: "Move Folder",
        message: `Move "${folderPath(folder)}" inside folder.

Leave empty = Root
Type folder name or full path = move inside it`,
        placeholder: "Target folder name/path",
        confirmText: "Move",
      });

      if (target === null) return;

      const targetFolder = folderByNameOrPath(target);
      const targetFolderId = target.trim() ? targetFolder?.folderId || "" : "";

      if (target.trim() && !targetFolder) {
        throw new Error("Target folder not found");
      }

      if (targetFolderId === folder.folderId) {
        throw new Error("Cannot move folder into itself");
      }

      await api.invoke("p2p:moveItem", {
        itemId: folder.folderId,
        targetFolderId,
      });

      await refresh();
      toast.success("Folder moved");
    });

  const deleteFolder = (folder: DriveFolder) =>
    run(async () => {
      const disposition = await askText({
        title: "Delete Folder",
        message: `Files inside "${folderPath(folder)}":

Leave empty → Uncategorized
Type a folder name/path → move files there
Type DELETE → delete files too`,
        placeholder: "empty / folder name / DELETE",
        confirmText: "Delete Folder",
        danger: true,
      });

      if (disposition === null) return;

      const trimmed = disposition.trim();
      const isDelete = trimmed.toUpperCase() === "DELETE";
      const targetFolder = isDelete || !trimmed ? null : folderByNameOrPath(trimmed);

      if (trimmed && !isDelete && !targetFolder) {
        throw new Error("Target folder not found");
      }

      const folderAny = folder as any;

      const deleteFolderId = String(
        folderAny.folderId ||
          folderAny.id ||
          folderAny.hash ||
          folderAny.rootHash ||
          folderAny.path ||
          folder.name ||
          folderPath(folder) ||
          ""
      ).trim();

      if (!deleteFolderId) {
        throw new Error(`Cannot delete folder: missing folder identity. folder=${JSON.stringify(folder)}`);
      }

      await api.invoke("p2p:deleteItem", {
        itemId: deleteFolderId,
        folderId: deleteFolderId,
        id: deleteFolderId,
        name: folder.name,
        folderPath: folderPath(folder),
        fileDisposition: isDelete ? "delete" : "move",
        targetFolderId: targetFolder?.folderId || "",
      });

      await refresh();

      if (activeFolderId === folder.folderId) {
        setActiveFolder(ALL_FILES);
        setActiveFolderId("");
      }

      toast.success(`Folder "${folder.name}" deleted`);
    });

  const renameCompanyFolder = (folder: DriveFolder) =>
    run(async () => {
      if (!activeWorkspace) throw new Error("Select a Company Drive first");

      const name = (
        await askText({
          title: "Rename Company Folder",
          message: `Rename "${companyFolderPath(folder)}"`,
          defaultValue: folder.name,
          placeholder: "New folder name",
          confirmText: "Rename",
        })
      )?.trim();

      if (!name || name === folder.name) return;

      await api.invoke("company:updateFolder", {
        workspaceId: activeWorkspace.workspaceId,
        folderId: folder.folderId,
        patch: { name },
      });

      await refresh();

      if (activeFolderId === folder.folderId) {
        setActiveFolder(name);
      }

      toast.success("Company folder renamed");
    });

  const moveCompanyFolder = (folder: DriveFolder) =>
    run(async () => {
      if (!activeWorkspace) throw new Error("Select a Company Drive first");

      const target = await askText({
        title: "Move Company Folder",
        message: `Move "${companyFolderPath(folder)}" inside folder.

Leave empty = Root
Type folder name or full path = move inside it`,
        placeholder: "Target folder name/path",
        confirmText: "Move",
      });

      if (target === null) return;

      const targetFolder = companyFolderByNameOrPath(target);
      const targetFolderId = target.trim() ? targetFolder?.folderId || "" : "";

      if (target.trim() && !targetFolder) {
        throw new Error("Target company folder not found");
      }

      if (targetFolderId === folder.folderId) {
        throw new Error("Cannot move folder into itself");
      }

      await api.invoke("company:updateFolder", {
        workspaceId: activeWorkspace.workspaceId,
        folderId: folder.folderId,
        patch: { parentFolderId: targetFolderId },
      });

      await refresh();
      toast.success("Company folder moved");
    });

  const deleteCompanyFolder = (folder: DriveFolder) =>
    run(async () => {
      if (!activeWorkspace) throw new Error("Select a Company Drive first");

      const disposition = await askText({
        title: "Delete Company Folder",
        message: `Files inside "${companyFolderPath(folder)}":

Leave empty → Uncategorized
Type a folder name/path → move files there
Type DELETE → delete files too`,
        placeholder: "empty / folder name / DELETE",
        confirmText: "Delete Folder",
        danger: true,
      });

      if (disposition === null) return;

      const trimmed = disposition.trim();
      const isDelete = trimmed.toUpperCase() === "DELETE";
      const targetFolder = isDelete || !trimmed ? null : companyFolderByNameOrPath(trimmed);

      if (trimmed && !isDelete && !targetFolder) {
        throw new Error("Target company folder not found");
      }

      await api.invoke("company:deleteFolder", {
        workspaceId: activeWorkspace.workspaceId,
        folderId: folder.folderId,
        fileDisposition: isDelete ? "delete" : "move",
        targetFolderId: targetFolder?.folderId || "",
      });

      await refresh();

      if (activeFolderId === folder.folderId) {
        setActiveFolder(ALL_FILES);
        setActiveFolderId("");
      }

      toast.success(`Company folder "${folder.name}" deleted`);
    });

  const upload = () =>
    run(async () => {
      if (!identityConnected) {
        throw new Error("Connect wallet or sign in with Seed Account before uploading");
      }

      if ((view === "company" || view === "admin") && !activeWorkspace) {
        throw new Error("Create or select a company first");
      }

      if ((view === "company" || view === "admin") && !canUpload(localRole)) {
        throw new Error("Your company role cannot upload files");
      }

      const targetFolder = activeFolderId ? folderById.get(activeFolderId) : null;

      const result = await api.invoke<{ cancelled?: boolean; files?: P2PFile[] }>(
        "p2p:uploadFiles",
        {
          isEncrypted: true,
          drivePassword: password(),

          workspaceId:
            view === "company" || view === "admin" ? activeWorkspace?.workspaceId : null,

          folderId: activeFolderId || "",
          parentFolderId: activeFolderId || "",
          folderName: targetFolder?.name || "",
          folderPath:
            activeFolderId && activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED
              ? activeFolder
              : "",
        }
      );

      if ((view === "company" || view === "admin") && activeWorkspace && result?.files?.length) {
        for (const file of result.files) {
          await api.invoke("company:addFile", {
            workspaceId: activeWorkspace.workspaceId,
            file,
            folderId: activeFolderId || "",
            parentFolderId: activeFolderId || "",
            folderPath:
              activeFolderId && activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED
                ? activeFolder
                : "",
            folder:
              activeFolderId && activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED
                ? activeFolder
                : "",
          });
        }
      }

      if (!result?.cancelled) {
        toast.success(`${result?.files?.length || 1} file(s) stored safely`);
      }

      await refresh();
    });

  const uploadFolder = () =>
    run(async () => {
      if (!identityConnected) {
        throw new Error("Connect wallet or sign in with Seed Account before uploading");
      }

      if ((view === "company" || view === "admin") && !activeWorkspace) {
        throw new Error("Create or select a company first");
      }

      if ((view === "company" || view === "admin") && !canUpload(localRole)) {
        throw new Error("Your company role cannot upload files");
      }

      const result = await api.invoke<{ cancelled?: boolean; files?: P2PFile[] }>(
        "p2p:uploadFolder",
        {
          isEncrypted: true,
          drivePassword: password(),
          folderId: activeFolderId || "",
        }
      );

      if ((view === "company" || view === "admin") && activeWorkspace && result?.files?.length) {
        for (const file of result.files) {
          await api.invoke("company:addFile", {
            workspaceId: activeWorkspace.workspaceId,
            file,
            folderId: activeFolderId || "",
            parentFolderId: activeFolderId || "",
            folderPath:
              activeFolderId && activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED
                ? activeFolder
                : "",
            folder:
              activeFolderId && activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED
                ? activeFolder
                : "",
          });
        }
      }

      if (!result?.cancelled) {
        toast.success(`${result?.files?.length || 0} file(s) uploaded from folder`);
      }

      await refresh();
    });

  const addFileToCompanyDrive = (file: P2PFile) =>
  run(async () => {
    if (!identityConnected) throw new Error("Connect wallet or sign in first");
    if (!activeWorkspace) throw new Error("Create or select a Company Drive first");
    if (!canUpload(localRole)) throw new Error("Your company role cannot add files");

    await api.invoke("company:addFile", {
      workspaceId: activeWorkspace.workspaceId,
      file,
      folderId: activeFolderId || "",
      parentFolderId: activeFolderId || "",
      folderPath:
        activeFolderId && activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED
          ? activeFolder
          : "",
      folder:
        activeFolderId && activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED
          ? activeFolder
          : "",
    });

    await recordAudit("company:file-added", {
      workspaceId: activeWorkspace.workspaceId,
      workspaceName: activeWorkspace.name,
      fileName: file.name,
      rootHash: file.rootHash || file.hash,
      folder: activeFolderId && activeFolder !== ALL_FILES && activeFolder !== UNCATEGORIZED ? activeFolder : "",
    });

    await refresh();
    toast.success(`File "${file.name}" added to Company Drive`);
  });

  const download = (file: P2PFile) =>
    run(async () => {
      await api.invoke("p2p:downloadToPath", {
        hash: file.hash,
        rootHash: file.rootHash,
        name: file.name,
        isEncrypted: file.isEncrypted,
        drivePassword: file.isEncrypted ? password() : null,
      });

      toast.success(`Download started for ${file.name}`);
    });

  const renameCompanyFile = (file: P2PFile) =>
  run(async () => {
    const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);
    if (!match) return;

    const oldName = match.companyFile.name || file.name;

    const name = window.prompt("New file name", oldName)?.trim();
    if (!name || name === oldName) return;

    await api.invoke("company:updateFile", {
      workspaceId: match.workspace.workspaceId,
      rootHash: match.companyFile.rootHash,
      patch: { name },
    });

    await recordAudit("company:file-renamed", {
      workspaceId: match.workspace.workspaceId,
      workspaceName: match.workspace.name,
      rootHash: match.companyFile.rootHash,
      oldName,
      newName: name,
    });

    await refresh();
    toast.success("Company file renamed");
  });

  const toggleHideCompanyFile = (file: P2PFile) =>
    run(async () => {
      const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);
      if (!match) return;

      await api.invoke("company:updateFile", {
        workspaceId: match.workspace.workspaceId,
        rootHash: match.companyFile.rootHash,
        patch: { hidden: !match.companyFile.hidden },
      });

      await refresh();
    });

const remove = (file: P2PFile) =>
  run(async () => {
    const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);

    const deletedKeys = new Set(
      [itemIdFor(file), file.id, file.hash, file.rootHash].filter(Boolean)
    );

    // Optimistic UI: hide immediately
    setFiles((prev) =>
      prev.filter((item) => {
        const keys = [itemIdFor(item), item.id, item.hash, item.rootHash].filter(Boolean);
        return !keys.some((key) => deletedKeys.has(key));
      })
    );

    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      for (const key of deletedKeys) next.delete(String(key));
      return next;
    });

if (view === "personal" && match) {
  const keysToHide = [keyFor(file), file.hash, file.rootHash, file.id].filter(Boolean) as string[];

  setPersonalHiddenCompanyFileKeys((prev) => {
    const next = new Set(prev);

    for (const key of keysToHide) next.add(String(key));

    localStorage.setItem(PERSONAL_HIDDEN_COMPANY_FILES_KEY, JSON.stringify(Array.from(next)));

    return next;
  });

  await recordAudit("drive:file-removed-from-my-drive-view", {
    workspaceId: match.workspace.workspaceId,
    workspaceName: match.workspace.name,
    fileName: match.companyFile.name || file.name,
    rootHash: match.companyFile.rootHash || file.rootHash || file.hash,
    keptInCompanyDrive: true,
  });

await refresh();
toast.success("Removed from My Drive view. Company Drive keeps the file.");
return;
}

if (match) {
  await api.invoke("company:updateFile", {
    workspaceId: match.workspace.workspaceId,
    rootHash: match.companyFile.rootHash,
    patch: { deleted: true },
  });

  await recordAudit("company:file-deleted", {
    workspaceId: match.workspace.workspaceId,
    workspaceName: match.workspace.name,
    fileName: match.companyFile.name || file.name,
    rootHash: match.companyFile.rootHash || file.rootHash || file.hash,
  });

  await refresh();
  toast.success("Removed from company manifest.");
  return;
}

    toast.success("Deleting file in background...");

    try {
      await api.invoke("p2p:pauseProtectionRetry", {
        ms: 5 * 60 * 1000,
        reason: "single-delete",
      });
    } catch {}

    try {
      await api.invoke("p2p:delete", {
        hash: file.hash,
        rootHash: file.rootHash,
        id: file.id,
        itemId: itemIdFor(file),
      });
    } finally {
      try {
        await api.invoke("p2p:resumeProtectionRetry", {
          reason: "single-delete-finished",
        });
      } catch {}

      await refresh();
    }
  });

const proof = (file: P2PFile) =>
  run(async () => {
    const result = await api.invoke<{ proof: unknown }>("p2p:prepareProof", {
      hash: file.hash,
    });

    await navigator.clipboard.writeText(JSON.stringify(result.proof, null, 2));
    toast.success("Proof copied");
  });

const share = (file: P2PFile) => {
  const link = `chunknet://file/${file.rootHash || file.hash}`;
  void navigator.clipboard.writeText(link).then(() => toast.success("Share link copied"));
};

const movePersonalFileTo = async (file: P2PFile, targetFolderId: string) => {
  await api.invoke("p2p:moveItem", {
    itemId: itemIdFor(file),
    hash: file.hash,
    rootHash: file.rootHash,
    targetFolderId,
  });
};

  const bulkDelete = () =>
    run(async () => {
      if (selectedItemIds.size === 0) return;

      const filesToDelete = visibleFiles.filter(
        (file) =>
          selectedItemIds.has(itemIdFor(file)) &&
          !companyFileByKey.has(keyFor(file)) &&
          !companyFileByKey.has(file.hash)
      );

      if (filesToDelete.length === 0) {
        toast.error("No personal files selected.");
        return;
      }

      const confirmed = await askText({
        title: "Delete selected files",
        message: `This will delete ${filesToDelete.length} selected file(s).

Type DELETE to confirm.`,
        placeholder: "DELETE",
        confirmText: "Delete selected",
        danger: true,
      });

      if (confirmed?.trim().toUpperCase() !== "DELETE") return;

      const deletedKeys = new Set(
        filesToDelete.flatMap((file) =>
          [itemIdFor(file), file.id, file.hash, file.rootHash].filter(Boolean)
        )
      );

      // Optimistic UI: hide selected files immediately
      setFiles((prev) =>
        prev.filter((file) => {
          const keys = [itemIdFor(file), file.id, file.hash, file.rootHash].filter(Boolean);
          return !keys.some((key) => deletedKeys.has(key));
        })
      );

      setSelectedItemIds(new Set());

      toast.success(`Deleting ${filesToDelete.length} file(s) in background...`);

let results: PromiseSettledResult<unknown>[] = [];

try {
  await api.invoke("p2p:pauseProtectionRetry", {
    ms: 5 * 60 * 1000,
    reason: "bulk-delete",
  });
} catch {}

try {
  results = await Promise.allSettled(
    filesToDelete.map((file) =>
      api.invoke("p2p:delete", {
        hash: file.hash,
        rootHash: file.rootHash,
        id: file.id,
        itemId: itemIdFor(file),
      })
    )
  );
} finally {
  try {
    await api.invoke("p2p:resumeProtectionRetry", {
      reason: "bulk-delete-finished",
    });
  } catch {}

  await refresh();
}

const failed = results.filter((result) => result.status === "rejected");

      if (failed.length > 0) {
        toast.error(`Deleted with ${failed.length} error(s). Check logs.`);
      } else {
        toast.success(`Deleted ${filesToDelete.length} file(s)`);
      }
    });

  const bulkMove = () =>
    run(async () => {
      if (selectedItemIds.size === 0) return;

      const filesToMove = visibleFiles.filter(
        (file) =>
          selectedItemIds.has(itemIdFor(file)) &&
          !companyFileByKey.has(keyFor(file)) &&
          !companyFileByKey.has(file.hash)
      );

      for (const file of filesToMove) {
        await movePersonalFileTo(file, bulkTargetFolderId);
      }

      setSelectedItemIds(new Set());
      setBulkTargetFolderId("");
      await refresh();
      toast.success(`Moved ${filesToMove.length} file(s)`);
    });

  const toggleSelect = (itemId: string) => {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);

      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);

      return next;
    });
  };

  const selectAll = () => {
    const personalVisible = visibleFiles.filter(
      (file) => !companyFileByKey.has(keyFor(file)) && !companyFileByKey.has(file.hash)
    );

    setSelectedItemIds(new Set(personalVisible.map((file) => itemIdFor(file))));
  };

  const clearSelection = () => {
    setSelectedItemIds(new Set());
  };

  const renderCompanyFolderNode = (folder: DriveFolder, depth = 0) => {
    const selected = activeFolderId === folder.folderId;
    const children = companyFolderChildren.get(folder.folderId) || [];
    const hasChildren = children.length > 0;
    const expanded = expandedFolderIds.has(folder.folderId);

    const toggleExpanded = () => {
      setExpandedFolderIds((prev) => {
        const next = new Set(prev);
        if (next.has(folder.folderId)) next.delete(folder.folderId);
        else next.add(folder.folderId);
        return next;
      });
    };

    return (
      <div key={`company-folder-node:${folder.folderId}`} className="space-y-1">
        <div className="group flex items-center gap-1" style={{ marginLeft: depth * 12 }}>
          {hasChildren ? (
            <button
              type="button"
              onClick={toggleExpanded}
              className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              title={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </button>
          ) : (
            <span className="w-5" />
          )}

          <button
            onClick={() => {
              setActiveFolder(companyFolderPath(folder));
              setActiveFolderId(folder.folderId);
            }}
            className={`flex-1 rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
              selected ? "bg-blue-600 text-white" : "text-zinc-400 hover:bg-zinc-800"
            }`}
          >
            <FolderOpen className="mr-1.5 inline size-3" />
            {folder.name}
            <Badge variant="outline" className="ml-1 px-1 py-0 text-[10px]">
              company
            </Badge>
          </button>

          <button
            onClick={() => renameCompanyFolder(folder)}
            className="hidden px-1 text-zinc-500 hover:text-zinc-300 group-hover:block"
            title="Rename"
          >
            <Pencil className="size-3" />
          </button>

          <button
            onClick={() => moveCompanyFolder(folder)}
            className="hidden px-1 text-zinc-500 hover:text-blue-300 group-hover:block"
            title="Move"
          >
            <MoveRight className="size-3" />
          </button>

          <button
            onClick={() => deleteCompanyFolder(folder)}
            className="hidden px-1 text-zinc-500 hover:text-red-400 group-hover:block"
            title="Delete"
          >
            <Trash2 className="size-3" />
          </button>
        </div>

        {expanded && children.map((child) => renderCompanyFolderNode(child, depth + 1))}
      </div>
    );
  };

  const renderFolderNode = (folder: DriveFolder, depth = 0) => {
    const selected = activeFolderId === folder.folderId;
    const children = folderChildren.get(folder.folderId) || [];
    const hasChildren = children.length > 0;
    const expanded = expandedFolderIds.has(folder.folderId);

    const toggleExpanded = () => {
      setExpandedFolderIds((prev) => {
        const next = new Set(prev);

        if (next.has(folder.folderId)) {
          next.delete(folder.folderId);
        } else {
          next.add(folder.folderId);
        }

        return next;
      });
    };

    return (
      <div key={folder.folderId} className="space-y-1">
        <div className="group flex items-center gap-1" style={{ marginLeft: depth * 12 }}>
          {hasChildren ? (
            <button
              type="button"
              onClick={toggleExpanded}
              className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              title={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </button>
          ) : (
            <span className="w-5" />
          )}

          <button
            onClick={() => {
              setActiveFolder(folderPath(folder));
              setActiveFolderId(folder.folderId);
            }}
            className={`flex-1 rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
              selected ? "bg-blue-600 text-white" : "text-zinc-400 hover:bg-zinc-800"
            }`}
          >
            <FolderOpen className="mr-1.5 inline size-3" />
            {folder.name}
            <Badge variant="outline" className="ml-1 px-1 py-0 text-[10px]">
              manifest
            </Badge>
          </button>

          <button
            onClick={() => renameFolder(folder)}
            className="hidden px-1 text-zinc-500 hover:text-zinc-300 group-hover:block"
            title="Rename"
          >
            <Pencil className="size-3" />
          </button>

          <button
            onClick={() => moveFolder(folder)}
            className="hidden px-1 text-zinc-500 hover:text-blue-300 group-hover:block"
            title="Move"
          >
            <MoveRight className="size-3" />
          </button>

          <button
            onClick={() => deleteFolder(folder)}
            className="hidden px-1 text-zinc-500 hover:text-red-400 group-hover:block"
            title="Delete"
          >
            <Trash2 className="size-3" />
          </button>
        </div>

        {expanded && children.map((child) => renderFolderNode(child, depth + 1))}
      </div>
    );
  };

  function collectChildFolderIds(folderId: string): Set<string> {
    const ids = new Set<string>([folderId]);
    let changed = true;

    while (changed) {
      changed = false;

      for (const folder of manifestFolders) {
        const parent = String(folder.parentFolderId || "");

        if (parent && ids.has(parent) && !ids.has(folder.folderId)) {
          ids.add(folder.folderId);
          changed = true;
        }
      }
    }

    return ids;
  }

  function folderStats(folder: DriveFolder) {
    const ids = collectChildFolderIds(folder.folderId);

    const nestedFiles = personalFiles.filter((file) => {
      const folderId = getPersonalFileFolderId(file);
      return folderId && ids.has(folderId);
    });

    const totalBytes = nestedFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);
    const totalChunks = nestedFiles.reduce((sum, file) => sum + Number(file.totalChunks || 0), 0);
    const protectedChunks = nestedFiles.reduce(
      (sum, file) => sum + Number(file.protectedChunks ?? file.totalChunks ?? 0),
      0
    );

    return {
      files: nestedFiles.length,
      bytes: totalBytes,
      totalChunks,
      protectedChunks,
    };
  }

  const openFolder = (folder: DriveFolder) => {
    setActiveFolder(folderPath(folder));
    setActiveFolderId(folder.folderId);

    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      next.add(folder.folderId);
      return next;
    });
  };

  const renderFolderCard = (folder: DriveFolder) => {
    const stats = folderStats(folder);
    const isProtected = stats.totalChunks > 0 && stats.protectedChunks >= stats.totalChunks;

    return (
      <Card
        key={`folder-card:${folder.folderId}`}
        onDoubleClick={() => openFolder(folder)}
        className="cursor-pointer rounded-2xl border-zinc-800 bg-zinc-900 transition-all hover:border-blue-500"
      >
        <CardContent className="space-y-4 p-5">
          <div className="flex h-20 items-center justify-center rounded-2xl bg-zinc-950">
            <FolderOpen className="size-10 text-blue-400" />
          </div>

          <div>
            <p className="truncate text-sm font-semibold">{folder.name}</p>

            <p className="text-xs text-zinc-400">
              {stats.files} file(s) · {bytes(stats.bytes)}
            </p>

            <p className="mt-1 text-xs text-zinc-500">
              <FolderOpen className="mr-1 inline size-3" />
              {folder.parentFolderId ? folderPath(folder) : "Root folder"}
            </p>

            <div className="mt-2 flex flex-wrap gap-1">
              {stats.totalChunks > 0 ? (
                <Badge
                  variant="outline"
                  className={`text-xs ${isProtected ? "text-emerald-300" : "text-blue-300"}`}
                >
                  <ShieldCheck className="mr-1 size-3" />
                  {isProtected ? "Folder Protected" : "Folder Protecting"}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-xs text-zinc-400">
                  No chunks
                </Badge>
              )}
            </div>

            <p className="mt-1 text-xs text-zinc-600">
              {stats.protectedChunks}/{stats.totalChunks} chunks
            </p>
          </div>

          <div className="flex flex-wrap gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => renameFolder(folder)}
              disabled={busy}
              className="text-xs"
            >
              <Pencil className="size-3" />
              Rename
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => moveFolder(folder)}
              disabled={busy}
              className="text-xs"
            >
              <MoveRight className="size-3" />
              Move
            </Button>

            <Button
              variant="destructive"
              size="sm"
              onClick={() => deleteFolder(folder)}
              disabled={busy}
              className="text-xs"
            >
              <Trash2 className="size-3" />
              Delete
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  };

  const renderFileCard = (file: P2PFile) => {
    const p = protection(file);
    const match = companyFileByKey.get(keyFor(file)) || companyFileByKey.get(file.hash);
    const cf = match?.companyFile;
    const displayName = cf?.name || file.name;
    const folderLabel = cf ? cf.folder || UNCATEGORIZED : getPersonalFileFolder(file);
    const role = match?.workspace.members.find((m) => m.deviceId === deviceId)?.role;
    const canControl = Boolean(
      cf && (cf.uploadedByDeviceId === deviceId || role === "owner" || role === "admin")
    );
    const isPersonal = !match;
    const isSelected = selectedItemIds.has(itemIdFor(file));
    const currentPersonalFolderId = isPersonal ? getPersonalFileFolderId(file) : "";

    return (
      <Card
        key={`${file.hash}:${file.uploadedAt}`}
        className={`rounded-2xl border-zinc-800 bg-zinc-900 transition-all ${
          isSelected ? "ring-2 ring-blue-500" : ""
        }`}
      >
<CardContent className="relative space-y-4 p-5">
  {match && (
    <button
      type="button"
      onClick={() => showCompanyFileInfo(file)}
      className="absolute right-3 top-3 flex size-7 items-center justify-center rounded-full border border-blue-500/60 bg-blue-500/10 text-xs font-bold text-blue-300 hover:bg-blue-500/20"
      title="Company file info"
      aria-label="Company file info"
    >
      !
    </button>
  )}
          {isPersonal && view === "personal" && (
            <button
              type="button"
              onClick={() => toggleSelect(itemIdFor(file))}
              className={`flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-xs transition-all ${
                isSelected
                  ? "border-blue-500 bg-blue-500/15 text-blue-300 ring-1 ring-blue-500/40"
                  : "border-zinc-700 bg-zinc-950 text-zinc-400 hover:border-blue-500 hover:text-blue-300"
              }`}
              aria-label={isSelected ? "Unselect file" : "Select file"}
            >
              <span
                className={`flex size-3.5 items-center justify-center rounded-full border ${
                  isSelected ? "border-blue-400 bg-blue-500" : "border-zinc-600"
                }`}
              >
                {isSelected && <span className="size-1.5 rounded-full bg-white" />}
              </span>
              {isSelected ? "Selected" : "Select"}
            </button>
          )}

          <div className="flex h-20 items-center justify-center rounded-2xl bg-zinc-950">
            <FileCheck2 className="size-9 text-zinc-500" />
          </div>

          <div>
            <p className="truncate text-sm font-semibold">{displayName}</p>
            <p className="text-xs text-zinc-400">
              {bytes(file.size)} · {date(file.uploadedAt)}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              <FolderOpen className="mr-1 inline size-3" />
              {folderLabel}
            </p>

<p className="text-[11px] text-zinc-500">
  Uploaded by {uploaderLabel(file, cf)}
</p>

            <div className="mt-2 flex flex-wrap gap-1">
              {file.isEncrypted && (
                <Badge variant="secondary" className="text-xs">
                  <Lock className="mr-1 size-3" />
                  Encrypted
                </Badge>
              )}

              <Badge variant="outline" className={`text-xs ${p.tone}`}>
                <ShieldCheck className="mr-1 size-3" />
                {p.label}
              </Badge>

              {match && (
                <Badge variant="outline" className="text-xs">
                  <Building2 className="mr-1 size-3" />
                  {match.workspace.name}
                </Badge>
              )}

              {cf?.hidden && (
                <Badge variant="outline" className="text-xs text-amber-300">
                  <EyeOff className="mr-1 size-3" />
                  Hidden
                </Badge>
              )}
            </div>

            <p className="mt-1 text-xs text-zinc-600">{p.details}</p>
          </div>

          <div className="flex flex-wrap gap-1">
            <Button size="sm" onClick={() => download(file)} disabled={busy} className="text-xs">
              <Download className="size-3" />
              Download
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => share(file)}
              disabled={busy}
              className="text-xs"
            >
              <Share2 className="size-3" />
              Share
            </Button>

            {isPersonal && view === "personal" && activeWorkspace && (
  <Button
    variant="outline"
    size="sm"
    onClick={() => addFileToCompanyDrive(file)}
    disabled={busy || !identityConnected || !canUpload(localRole)}
    className="text-xs"
  >
    <Building2 className="size-3" />
    Add to Company
  </Button>
)}
            
            {match && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => renameCompanyFile(file)}
                disabled={busy || !canControl}
                className="text-xs"
              >
                <Pencil className="size-3" />
                Rename
              </Button>
            )}

            {match && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => toggleHideCompanyFile(file)}
                disabled={busy || !canControl}
                className="text-xs"
              >
                {cf?.hidden ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
                {cf?.hidden ? "Unhide" : "Hide"}
              </Button>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={() => proof(file)}
              disabled={busy}
              className="text-xs"
            >
              Proof
            </Button>

            <Button
              variant="destructive"
              size="sm"
              onClick={() => remove(file)}
              disabled={busy || (Boolean(match) && !canControl)}
              className="text-xs"
            >
              <Trash2 className="size-3" />
              Delete
            </Button>
          </div>

          <select
            value={match ? folderLabel : currentPersonalFolderId}
            onChange={(event) => {
              const picked = event.target.value;

              if (match) {
                void api
                  .invoke("company:updateFile", {
                    workspaceId: match.workspace.workspaceId,
                    rootHash: match.companyFile.rootHash,
                    patch: { folder: picked === UNCATEGORIZED ? "" : picked },
                  })
                  .then(refresh)
                  .catch((error) => toast.error(err(error)));
                return;
              }

              void run(async () => {
                await movePersonalFileTo(file, picked);
                await refresh();
              });
            }}
            className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-300"
          >
            {match ? (
              <>
                <option value={UNCATEGORIZED}>{UNCATEGORIZED}</option>
                {Array.from(
                  new Set(
                    (activeWorkspace?.files || [])
                      .map((item) => item.folder)
                      .filter(Boolean) as string[]
                  )
                )
                  .sort()
                  .map((folderName) => (
                    <option key={folderName} value={folderName}>
                      {folderName}
                    </option>
                  ))}
              </>
            ) : (
              <>
                <option value="">{UNCATEGORIZED}</option>
                {manifestFolders
                  .slice()
                  .sort((a, b) => folderPath(a).localeCompare(folderPath(b)))
                  .map((folder) => (
                    <option key={folder.folderId} value={folder.folderId}>
                      {folderPath(folder)}
                    </option>
                  ))}
              </>
            )}
          </select>
        </CardContent>
      </Card>
    );
  };

  const planPickerModal = (
  <>
    {planPickerOpen && (
<div className="absolute inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4">
        <div className="mx-auto my-4 w-full max-w-5xl rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl">
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

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visiblePaidPlans.map((plan) => {
              const active = currentPlanId === plan.id || wallet?.plan?.id === plan.id;
              const allowed = canSelectPlan(plan);
              const isBusy = payingPlanId === plan.id;

              return (
                <Card
                  key={plan.id}
                  className={`rounded-2xl border-zinc-800 bg-zinc-900 ${
                    active ? "ring-2 ring-blue-500" : ""
                  }`}
                >
                  <CardContent className="space-y-3 p-4">
                    <div>
                      <p className="text-base font-semibold">{plan.name}</p>
                      <p className="text-xs text-zinc-400">{planSize(plan)} storage</p>
                    </div>

                    <div>
                      <p className="text-2xl font-bold">
                        ${Number(plan.priceUsd || 0).toFixed(2)}
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
    )}
  </>
);
  
  // ─── JSX ────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50">
      <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/90 px-6 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Cloud className="size-6 text-blue-400" />
            <div>
              <p className="text-sm font-bold leading-none">Native P2P Cloud</p>
              <p className="mt-0.5 text-xs text-zinc-500">
                Live Electron P2P drive with company manifests and chunk protection.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono text-xs">
              {identityLabel}
            </Badge>

            {identityConnected ? (
              <Button variant="outline" size="sm" onClick={disconnectWallet} disabled={busy}>
                Disconnect
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" onClick={connectWallet} disabled={busy}>
                  <Wallet className="size-4" />
                  Connect Wallet
                </Button>

                <Button variant="outline" size="sm" onClick={seedLogin} disabled={busy}>
                  <KeyRound className="size-4" />
                  Seed Login
                </Button>

                <Button variant="outline" size="sm" onClick={seedCreate} disabled={busy}>
                  Create Seed
                </Button>

                <Button variant="outline" size="sm" onClick={seedRecover} disabled={busy}>
                  Recover
                </Button>
              </div>
            )}

            <Button variant="ghost" size="sm" onClick={() => run(refresh)} disabled={busy}>
              <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap gap-4 text-xs text-zinc-400">
          <span className="flex items-center gap-1">
            <HardDrive className="size-3" />
            {realFilesCount} Files
          </span>

          <span className="flex items-center gap-1">
            <Zap className="size-3" />
            {bytes(wallet?.usedBytes)} used
          </span>

{wallet?.plan?.quotaBytes && (
  <span className="flex items-center gap-1">
    <span className="inline-block h-1.5 w-20 rounded-full bg-zinc-800">
      <span
        className="block h-full rounded-full bg-blue-500 transition-all"
        style={{ width: `${quota}%` }}
      />
    </span>
    {quota.toFixed(0)}%
  </span>
)}

<span className="flex items-center gap-1">
  <ShieldCheck className="size-3" />
  Smart
</span>

<span className="flex items-center gap-1">
  <Wifi className="size-3" />
  {peerCount} peers
</span>

{wallet?.connected && (
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
          
        </div>
      </header>

      <div className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-900 px-6 py-2">
        <KeyRound className="size-4 shrink-0 text-emerald-400" />

        <Input
          type="password"
          placeholder={`Drive password (min ${minPasswordLength} chars)`}
          value={drivePassword}
          onChange={(event) => setDrivePassword(event.target.value)}
          className="h-8 max-w-xs border-zinc-700 bg-zinc-950 text-xs"
        />

        <span className="rounded-full border border-emerald-800 bg-emerald-950/40 px-3 py-1 text-xs text-emerald-300">
          Always encrypted before upload
        </span>
      </div>

      <div className="flex min-h-[calc(100vh-120px)]">
        <aside className="w-72 shrink-0 space-y-4 border-r border-zinc-800 bg-zinc-900 p-4">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase text-zinc-500">
              {activeFolderId ? `Create inside: ${activeFolder}` : "Create inside: Root"}
            </p>

            <div className="flex gap-1">
              <Input
                placeholder="New folder"
                value={newFolder}
                onChange={(event) => setNewFolder(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && createFolder()}
                className="h-8 border-zinc-700 bg-zinc-950 text-xs"
              />

              <Button size="sm" onClick={createFolder} disabled={busy || !newFolder.trim()}>
                <FolderPlus className="size-4" />
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            <p className="mb-2 text-xs font-semibold uppercase text-zinc-500">Folders</p>

            {[ALL_FILES, UNCATEGORIZED].map((label) => (
              <button
                key={label}
                onClick={() => {
                  setActiveFolder(label);
                  setActiveFolderId("");
                }}
                className={`w-full rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
                  activeFolder === label
                    ? "bg-blue-600 text-white"
                    : "text-zinc-400 hover:bg-zinc-800"
                }`}
              >
                <FolderOpen className="mr-1.5 inline size-3" />
                {label}
              </button>
            ))}

              {view === "company" || view === "admin"
                ? (companyFolderChildren.get("") || []).map((folder) =>
                    renderCompanyFolderNode(folder)
                  )
                : (folderChildren.get("") || []).map((folder) => renderFolderNode(folder))}
          </div>
        </aside>

<main className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-zinc-950">
          <Tabs
            value={view}
            onValueChange={(v) => {
              setView(v as View);
              setActiveFolder(ALL_FILES);
              setActiveFolderId("");
              clearSelection();
            }}
            className="w-full"
          >
            <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-6 py-2">
              <TabsList className="bg-zinc-950">
                <TabsTrigger value="personal">My Drive</TabsTrigger>
                <TabsTrigger value="company">Company Drive</TabsTrigger>
                <TabsTrigger value="shared">Shared with me</TabsTrigger>
                {/* ─── UPDATED: tab label ──────────────────────────────────────── */}
                <TabsTrigger value="admin">Company Control Panel</TabsTrigger>
              </TabsList>

              <div className="flex items-center gap-3">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 size-4 text-zinc-500" />
                  <Input
                    placeholder="Search files..."
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    className="h-9 w-64 border-zinc-800 bg-zinc-950 pl-9 text-sm"
                  />
                </div>

                <Button size="sm" onClick={upload} disabled={busy}>
                  <Upload className="size-4" />
                  Upload
                </Button>

                <Button variant="outline" size="sm" onClick={uploadFolder} disabled={busy}>
                  <FolderPlus className="size-4" />
                  Upload Folder
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between border-b border-zinc-900 bg-zinc-950/50 px-6 py-2">
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <FolderOpen className="size-4" />
                <span>{activeFolder}</span>
                <span className="mx-1">/</span>
                <span>{visibleFiles.length} file(s)</span>
              </div>

              {view === "personal" && (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={selectAll}
                    className="text-xs text-zinc-500 hover:underline"
                  >
                    Select All
                  </button>
                  <button
                    type="button"
                    onClick={clearSelection}
                    className="text-xs text-zinc-500 hover:underline"
                  >
                    Clear
                  </button>

                  {selectedItemIds.size > 0 && (
                    <>
                      <select
                        value={bulkTargetFolderId}
                        onChange={(event) => setBulkTargetFolderId(event.target.value)}
                        className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs"
                      >
                        <option value="">Uncategorized</option>
                        {manifestFolders
                          .slice()
                          .sort((a, b) => folderPath(a).localeCompare(folderPath(b)))
                          .map((folder) => (
                            <option key={folder.folderId} value={folder.folderId}>
                              {folderPath(folder)}
                            </option>
                          ))}
                      </select>

                      <Button size="sm" onClick={bulkMove} disabled={busy} className="text-xs">
                        <MoveRight className="size-3" />
                        Move selected
                      </Button>

                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={bulkDelete}
                        disabled={busy}
                        className="text-xs"
                      >
                        <Trash2 className="size-3" />
                        Delete selected
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>

            <TabsContent value="personal" className="p-6">
              {personalFiles.length === 0 && manifestFolders.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 py-24 text-zinc-600">
                  <HardDrive className="size-12" />
                  <p>No personal files yet. Upload to get started.</p>
                </div>
              ) : visibleFiles.length > 0 || visibleFolders.length > 0 ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {visibleFolders.map((folder) => renderFolderCard(folder))}
                  {visibleFiles.map((file) => renderFileCard(file))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center gap-3 py-24 text-zinc-600">
                  <Search className="size-12" />
                  <p>No files match this folder/search.</p>
                </div>
              )}
            </TabsContent>

            {/* ─── UPDATED: Company Drive view logic ─────────────────────────── */}
            <TabsContent value="company" className="space-y-6 p-6">
              {!activeWorkspace ? (
                <div className="flex flex-col items-center gap-3 py-16 text-zinc-600">
                  <Building2 className="size-12" />
                  <p>No company workspace. Create or join one from Company Control Panel.</p>
                </div>
              ) : visibleFiles.length > 0 || companyFolders.length > 0 ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {visibleFiles.map((file) => renderFileCard(file))}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 py-16 text-zinc-600">
                  <Building2 className="size-12" />
                  <p>No company files. Upload to the company drive.</p>
                </div>
              )}
            </TabsContent>

            <TabsContent value="shared" className="p-6">
              {sharedFiles.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-24 text-zinc-600">
                  <Share2 className="size-12" />
                  <p>No shared files yet.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {visibleFiles.map((file) => renderFileCard(file))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="admin" className="space-y-6 p-6">
              {activeWorkspace ? (
                <Card className="border-zinc-800 bg-zinc-900">
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex items-center gap-2">
                        <Building2 className="size-4" />
                        Workspace Actions
                      </span>

                      <Badge variant="outline" className="text-xs">
                        Current: {activeWorkspace.name}
                      </Badge>
                    </CardTitle>
                  </CardHeader>

                  <CardContent className="grid gap-3 md:grid-cols-2">
                    <div className="flex gap-2">
                      <Input
                        placeholder="New workspace name"
                        value={workspaceNameInput}
                        onChange={(event) => setWorkspaceNameInput(event.target.value)}
                        className="border-zinc-700 bg-zinc-950"
                      />

                      <Button
                        onClick={createWorkspace}
                        disabled={busy || !workspaceNameInput.trim()}
                      >
                        <Building2 className="size-4" />
                        Create New
                      </Button>
                    </div>

                    <div className="flex gap-2">
                      <Input
                        value={joinInviteToken}
                        onChange={(event) => setJoinInviteToken(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && joinInviteToken.trim() && !busy) {
                            joinWorkspace();
                          }
                        }}
                        placeholder="Invite token to join another workspace"
                        className="border-zinc-700 bg-zinc-950"
                      />

                      <Button
                        variant="outline"
                        onClick={joinWorkspace}
                        disabled={busy || !joinInviteToken.trim()}
                      >
                        Join Another
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <>
                  <Card className="border-zinc-800 bg-zinc-900">
                    <CardHeader>
                      <CardTitle className="text-sm">Create Company Workspace</CardTitle>
                    </CardHeader>

                    <CardContent className="flex gap-2">
                      <Input
                        placeholder="Company name"
                        value={workspaceNameInput}
                        onChange={(event) => setWorkspaceNameInput(event.target.value)}
                        className="border-zinc-700 bg-zinc-950"
                      />

                      <Button
                        onClick={createWorkspace}
                        disabled={busy || !workspaceNameInput.trim()}
                      >
                        <Building2 className="size-4" />
                        Create
                      </Button>
                    </CardContent>
                  </Card>

                  <Card className="border-zinc-800 bg-zinc-900">
                    <CardHeader>
                      <CardTitle className="text-sm">Join Company Workspace</CardTitle>
                    </CardHeader>

                    <CardContent className="flex gap-2">
                      <Input
                        value={joinInviteToken}
                        onChange={(event) => setJoinInviteToken(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && joinInviteToken.trim() && !busy) {
                            joinWorkspace();
                          }
                        }}
                        placeholder="Paste company invite token"
                        className="border-zinc-700 bg-zinc-950"
                      />

                      <Button
                        variant="outline"
                        onClick={joinWorkspace}
                        disabled={busy || !joinInviteToken.trim()}
                      >
                        Join
                      </Button>
                    </CardContent>
                  </Card>
                </>
              )}

              {activeWorkspace && (
                <>
                  <div className="flex flex-wrap gap-2">
                    {workspaces.map((workspace) => (
                      <Button
                        key={workspace.workspaceId}
                        variant={
                          activeWorkspace?.workspaceId === workspace.workspaceId
                            ? "default"
                            : "outline"
                        }
                        size="sm"
                        onClick={() => {
  setActiveWorkspaceId(workspace.workspaceId);
  setActiveFolder(ALL_FILES);
  setActiveFolderId("");
  clearSelection();
}}
                      >
                        <Building2 className="size-4" />
                        {workspace.name}
                        {workspace.signatureValid === false && (
                          <Badge variant="destructive" className="ml-1 text-xs">
                            !
                          </Badge>
                        )}
                      </Button>
                    ))}
                  </div>

                  <Card className="border-zinc-800 bg-zinc-900">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <Users className="size-4" />
                        Members — {activeWorkspace.name}
                        {activeWorkspace.signatureValid === false && (
                          <Badge variant="destructive">Signature invalid</Badge>
                        )}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {activeWorkspace.members.map((member) => (
                        <div
                          key={member.memberId}
                          className="flex items-center justify-between gap-2 rounded-lg bg-zinc-950 p-2"
                        >
                          <div>
                            <p className="text-sm font-medium">
                              {member.displayName || member.email}
                            </p>
                            <p className="text-xs text-zinc-500">
                              {member.email} · {member.status}
                            </p>

                            {member.inviteToken && (
                              <button
                                onClick={() =>
                                  void navigator.clipboard
                                    .writeText(member.inviteToken!)
                                    .then(() => toast.success("Token copied"))
                                }
                                className="text-xs text-blue-400 hover:underline"
                              >
                                Copy invite token
                              </button>
                            )}
                          </div>

                          <div className="flex items-center gap-2">
                            {canManage(localRole) && member.deviceId !== deviceId && (
                              <>
                                <select
                                  value={member.role}
                                  onChange={(event) =>
                                    changeMemberRole(member.memberId, event.target.value as Role)
                                  }
                                  className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs"
                                >
                                  {(["owner", "admin", "manager", "editor", "viewer", "guest"] as Role[]).map(
                                    (role) => (
                                      <option key={role}>{role}</option>
                                    )
                                  )}
                                </select>

                                <Button
                                  variant="destructive"
                                  size="sm"
                                  onClick={() => removeMember(member.memberId)}
                                  disabled={busy}
                                >
                                  <Trash2 className="size-3" />
                                </Button>
                              </>
                            )}

                            {(!canManage(localRole) || member.deviceId === deviceId) && (
                              <Badge variant="outline" className="text-xs">
                                {member.role}
                              </Badge>
                            )}
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  </Card>

                  {canManage(localRole) && (
                    <Card className="border-zinc-800 bg-zinc-900">
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-sm">
                          <UserPlus className="size-4" />
                          Invite Member
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="flex flex-wrap gap-2">
                        <Input
                          placeholder="Email"
                          value={memberEmail}
                          onChange={(event) => setMemberEmail(event.target.value)}
                          className="max-w-xs border-zinc-700 bg-zinc-950"
                        />

                        <select
                          value={memberRole}
                          onChange={(event) => setMemberRole(event.target.value as Role)}
                          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
                        >
                          {(["admin", "manager", "editor", "viewer", "guest"] as Role[]).map(
                            (role) => (
                              <option key={role}>{role}</option>
                            )
                          )}
                        </select>

                        <Button onClick={inviteMember} disabled={busy}>
                          <UserPlus className="size-4" />
                          Invite
                        </Button>
                      </CardContent>
                    </Card>
                  )}

                  <Card className="border-zinc-800 bg-zinc-900">
                    <CardHeader>
                      <CardTitle className="flex items-center justify-between gap-2 text-sm">
                        <span className="flex items-center gap-2">
                          <ShieldCheck className="size-4" />
                          Company Drive Audit Log
                        </span>

                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void refreshAudit(activeWorkspace.workspaceId)}
                          disabled={busy}
                        >
                          <RefreshCw className="size-3" />
                          Refresh
                        </Button>
                      </CardTitle>
                    </CardHeader>

                    <CardContent className="space-y-2">
                      {auditEvents.length === 0 ? (
                        <p className="text-sm text-zinc-500">No audit events yet.</p>
                      ) : (
                        <div className="max-h-80 space-y-2 overflow-auto pr-1">
                          {auditEvents.map((event) => (
                            <div key={event.auditId} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-sm font-medium text-zinc-100">{event.action}</p>
                                <p className="text-xs text-zinc-500">{date(event.at)}</p>
                              </div>

                              <p className="mt-1 text-xs text-zinc-400">
                                Actor: <span className="font-mono">{short(event.actor || "")}</span>
                              </p>

                              {event.details && (
                                <pre className="mt-2 max-h-24 overflow-auto rounded bg-zinc-900 p-2 text-[11px] text-zinc-400">
                                  {JSON.stringify(event.details, null, 2)}
                                </pre>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </>
              )}
            </TabsContent>
          </Tabs>
    {planPickerModal}
        </main>
      </div>
    </div>
  );
}

import express from "express";
import cors from "cors";
import helmet from "helmet";
import fs from "fs";
import crypto from "node:crypto";

const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json({ limit: process.env.MANIFEST_SYNC_JSON_LIMIT || "25mb" }));

const DB_FILE = process.env.MANIFEST_SYNC_DB_FILE || "./manifests.json";
const PORT = Number(process.env.PORT || process.env.MANIFEST_SYNC_PORT || 3001);
const AUTH_VERSION = "hmac-sha256-v1";
const AUTH_MAX_AGE_MS = Math.max(30_000, Number(process.env.MANIFEST_SYNC_AUTH_MAX_AGE_MS || 5 * 60 * 1000));
const REQUIRE_AUTH = String(process.env.MANIFEST_SYNC_REQUIRE_AUTH ?? "true").toLowerCase() !== "false";
const usedNonces = new Map();

function normalizeIdentity(value = "") {
  return String(value || "").trim().toLowerCase();
}

function validWallet(address = "") {
  return /^0x[a-f0-9]{40}$/.test(normalizeIdentity(address));
}

function validIdentity(identity = "") {
  const value = normalizeIdentity(identity);
  return validWallet(value) || /^seed:[a-f0-9]{16,128}$/.test(value);
}

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return {};
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function authSecret() {
  return String(process.env.MANIFEST_SYNC_AUTH_SECRET || process.env.P2P_MANIFEST_SYNC_AUTH_SECRET || "").trim();
}

function normalizeAuthBody(req) {
  if (req.method === "GET" || req.method === "DELETE" || req.body === undefined) return "";
  return JSON.stringify(req.body || {});
}

function sha256Hex(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function timingSafeEqualHex(a = "", b = "") {
  const left = Buffer.from(String(a || ""), "hex");
  const right = Buffer.from(String(b || ""), "hex");
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function pruneNonces(now = Date.now()) {
  for (const [key, timestamp] of usedNonces.entries()) {
    if (now - timestamp > AUTH_MAX_AGE_MS) usedNonces.delete(key);
  }
}

function canonicalAuthString({ method, path, identity, bodySha256, timestamp, nonce }) {
  return [
    AUTH_VERSION,
    String(method || "GET").toUpperCase(),
    String(path || ""),
    normalizeIdentity(identity),
    String(bodySha256 || ""),
    String(timestamp || ""),
    String(nonce || ""),
  ].join("\n");
}

function verifyManifestAuth(req, expectedIdentity) {
  if (!REQUIRE_AUTH) return { ok: true, skipped: true };

  const secret = authSecret();
  if (!secret) {
    return { ok: false, status: 500, error: "Manifest sync auth secret is not configured" };
  }

  const version = String(req.get("x-manifest-auth-version") || "");
  const identity = normalizeIdentity(req.get("x-manifest-identity") || "");
  const timestamp = String(req.get("x-manifest-timestamp") || "");
  const nonce = String(req.get("x-manifest-nonce") || "");
  const bodySha256 = String(req.get("x-manifest-body-sha256") || "");
  const signature = String(req.get("x-manifest-signature") || "");

  if (version !== AUTH_VERSION) return { ok: false, status: 401, error: "Invalid manifest auth version" };
  if (!validIdentity(identity)) return { ok: false, status: 401, error: "Invalid manifest auth identity" };
  if (identity !== normalizeIdentity(expectedIdentity)) return { ok: false, status: 403, error: "Manifest auth identity mismatch" };
  if (!/^\d{10,}$/.test(timestamp)) return { ok: false, status: 401, error: "Invalid manifest auth timestamp" };
  if (!nonce || nonce.length < 16 || nonce.length > 128) return { ok: false, status: 401, error: "Invalid manifest auth nonce" };
  if (!/^[a-f0-9]{64}$/.test(bodySha256)) return { ok: false, status: 401, error: "Invalid manifest body hash" };
  if (!/^[a-f0-9]{64}$/.test(signature)) return { ok: false, status: 401, error: "Invalid manifest signature" };

  const now = Date.now();
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > AUTH_MAX_AGE_MS) {
    return { ok: false, status: 401, error: "Manifest auth timestamp expired" };
  }

  pruneNonces(now);
  const nonceKey = `${identity}:${nonce}`;
  if (usedNonces.has(nonceKey)) return { ok: false, status: 409, error: "Manifest auth nonce replayed" };

  const actualBodySha256 = sha256Hex(normalizeAuthBody(req));
  if (actualBodySha256 !== bodySha256) return { ok: false, status: 401, error: "Manifest body hash mismatch" };

  const canonical = canonicalAuthString({
    method: req.method,
    path: req.path,
    identity,
    bodySha256,
    timestamp,
    nonce,
  });

  const expectedSignature = crypto.createHmac("sha256", secret).update(canonical).digest("hex");
  if (!timingSafeEqualHex(signature, expectedSignature)) {
    return { ok: false, status: 401, error: "Manifest signature mismatch" };
  }

  usedNonces.set(nonceKey, now);
  return { ok: true, identity };
}

function requireManifestAuth(req, res, next) {
  const address = normalizeIdentity(req.params.address || "");
  const result = verifyManifestAuth(req, address);
  if (!result.ok) return res.status(result.status || 401).json({ ok: false, error: result.error || "Manifest auth failed" });
  return next();
}

function sanitizeManifest(address, manifest) {
  if (!manifest || typeof manifest !== "object" || !manifest.hash) return null;
  const ownerWallet = normalizeIdentity(manifest.ownerWallet || address);
  if (ownerWallet !== address) return null;
  return {
    ...manifest,
    ownerWallet,
    updatedAt: manifest.updatedAt || new Date().toISOString(),
  };
}

app.get("/health", (req, res) => {
  res.json({ ok: true, authRequired: REQUIRE_AUTH, authConfigured: Boolean(authSecret()) });
});

app.get("/wallet/:address/manifests", requireManifestAuth, (req, res) => {
  const db = loadDB();
  const address = normalizeIdentity(req.params.address);
  if (!validIdentity(address)) return res.status(400).json({ ok: false, error: "Invalid identity" });
  res.json({ ok: true, manifests: db[address] || [] });
});

app.post("/wallet/:address/manifests", requireManifestAuth, (req, res) => {
  const db = loadDB();
  const address = normalizeIdentity(req.params.address);
  if (!validIdentity(address)) return res.status(400).json({ ok: false, error: "Invalid identity" });

  const manifest = sanitizeManifest(address, req.body?.manifest);
  if (!manifest) return res.status(400).json({ ok: false, error: "Invalid manifest" });

  db[address] = db[address] || [];
  db[address] = db[address].filter((m) => m.hash !== manifest.hash);
  db[address].push(manifest);

  saveDB(db);
  res.json({ ok: true });
});

app.delete("/wallet/:address/manifests/:hash", requireManifestAuth, (req, res) => {
  const db = loadDB();
  const address = normalizeIdentity(req.params.address);
  if (!validIdentity(address)) return res.status(400).json({ ok: false, error: "Invalid identity" });

  const { hash } = req.params;
  if (!hash) return res.status(400).json({ ok: false, error: "Hash is required" });

  db[address] = (db[address] || []).filter((m) => m.hash !== hash && m.rootHash !== hash && m.id !== hash);
  saveDB(db);

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Manifest Sync Server running on port ${PORT} authRequired=${REQUIRE_AUTH} authConfigured=${Boolean(authSecret())}`);
});

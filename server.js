const http = require("http");
const { parse } = require("url");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const PORT = process.env.PORT || 3000;
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 12;

const envPath = path.join(ROOT_DIR, ".env");
if (fsSync.existsSync(envPath)) {
  const envRaw = fsSync.readFileSync(envPath, "utf8");
  envRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .forEach((line) => {
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) return;
      const key = line.slice(0, eqIndex).trim();
      const value = line.slice(eqIndex + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    });
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "";
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment variables.");
  process.exit(1);
}
const SUPABASE_REST_URL = `${SUPABASE_URL}/rest/v1`;
const SESSION_SECRET = process.env.SESSION_SECRET || SUPABASE_KEY;
const ICECAT_API_URL = process.env.ICECAT_API_URL || "https://live.icecat.biz/api";
const ICECAT_LANG = process.env.ICECAT_LANG || "EN";

function sanitizeFilename(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_.-]/g, "")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

function sendJSON(res, status, payload, extraHeaders = {}, req = null) {
  const origin = req?.headers?.origin;
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extraHeaders,
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Vary"] = "Origin";
  } else {
    headers["Access-Control-Allow-Origin"] = "*";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text, contentType = "text/plain") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(text);
}

function parseCookies(header = "") {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const eqIndex = part.indexOf("=");
      if (eqIndex === -1) return acc;
      const key = part.slice(0, eqIndex);
      const value = part.slice(eqIndex + 1);
      try {
        acc[key] = decodeURIComponent(value);
      } catch (error) {
        acc[key] = value;
      }
      return acc;
    }, {});
}

function serializeCookie(name, value, options = {}) {
  let cookie = `${name}=${encodeURIComponent(value)}`;
  cookie += `; Path=${options.path || "/"}`;
  if (options.maxAge != null) cookie += `; Max-Age=${options.maxAge}`;
  if (options.httpOnly) cookie += "; HttpOnly";
  if (options.sameSite) cookie += `; SameSite=${options.sameSite}`;
  if (options.secure) cookie += "; Secure";
  return cookie;
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function signSession(payload) {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(`${header}.${body}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${header}.${body}.${signature}`;
}

function parseSessionToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(`${header}.${body}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  if (signature !== expected) return null;
  let payload = null;
  try {
    payload = JSON.parse(base64UrlDecode(body));
  } catch (error) {
    return null;
  }
  if (!payload || !payload.exp || Number(payload.exp) * 1000 < Date.now()) {
    return null;
  }
  return payload;
}

function createSession(user) {
  const now = Math.floor(Date.now() / 1000);
  return signSession({
    sub: user.id,
    username: user.username,
    role: user.role,
    fullName: user.fullName || "",
    iat: now,
    exp: now + Math.floor(SESSION_MAX_AGE_MS / 1000),
  });
}

function destroySession() {
  // Stateless sessions are cleared by expiring the cookie on the client.
}

function destroySessionsForUser() {
  // Stateless sessions cannot be revoked server-side without a backing store.
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error("Payload too large"));
        req.connection.destroy();
      }
    });
    req.on("end", () => {
      if (!data) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (error) => reject(error));
  });
}

async function sb(pathname, { method = "GET", params = {}, headers = {}, body } = {}) {
  const url = new URL(`${SUPABASE_REST_URL}/${pathname}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, value);
    }
  });
  const response = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    const err = new Error(text || `Supabase request failed with status ${response.status}`);
    err.status = response.status;
    throw err;
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!text) return null;
  if (contentType.includes("application/json")) {
    return JSON.parse(text);
  }
  return text;
}

async function storeImage(finalName, base64Payload, mime) {
  if (!SUPABASE_STORAGE_BUCKET) {
    throw new Error("SUPABASE_STORAGE_BUCKET is not configured.");
  }
  const buffer = Buffer.from(base64Payload, "base64");
  const target = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(
    SUPABASE_STORAGE_BUCKET
  )}/${finalName}`;
  const response = await fetch(target, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": mime || "application/octet-stream",
      "x-upsert": "true",
    },
    body: buffer,
  });
  if (!response.ok) {
    const text = await response.text();
    const err = new Error(text || "Failed to upload image to Supabase Storage");
    err.status = response.status;
    throw err;
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_STORAGE_BUCKET}/${finalName}`;
}

function extractStoragePath(url) {
  if (!SUPABASE_STORAGE_BUCKET || !url) return null;
  const prefix = `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_STORAGE_BUCKET}/`;
  if (!url.startsWith(prefix)) return null;
  return url.slice(prefix.length);
}

async function deleteStoredImage(url) {
  if (!SUPABASE_STORAGE_BUCKET) {
    if (url && url.startsWith("/uploads/")) {
      const relative = url.replace(/^\/?uploads\//, "");
      try {
        await fs.unlink(path.join(UPLOAD_DIR, relative));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return;
  }
  const objectPath = extractStoragePath(url);
  if (!objectPath) return;
  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${objectPath}`,
    {
      method: "DELETE",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    }
  );
  if (!response.ok && response.status !== 404) {
    const text = await response.text();
    const err = new Error(text || "Failed to delete image from Supabase Storage");
    err.status = response.status;
    throw err;
  }
}

function mapCompany(record) {
  if (!record) return null;
  return {
    id: record.id,
    name: record.name,
    description: record.description || "",
  };
}

function normalizeSpecsRaw(value) {
  if (value == null || value === "") return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeSpecKey(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[_/-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSpecPrimitive(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function pickIcecatValue(value, depth = 0) {
  if (depth > 4) return "";
  const primitive = normalizeSpecPrimitive(value);
  if (primitive) return primitive;
  if (Array.isArray(value)) {
    return value
      .map((item) => pickIcecatValue(item, depth + 1))
      .filter(Boolean)
      .slice(0, 8)
      .join(", ");
  }
  if (!value || typeof value !== "object") return "";
  const priorityKeys = [
    "Presentation_Value",
    "PresentationValue",
    "LocalValue",
    "Value",
    "value",
    "DisplayValue",
    "Name",
    "Label",
    "Text",
    "text",
  ];
  for (const key of priorityKeys) {
    if (value[key] !== undefined) {
      const picked = pickIcecatValue(value[key], depth + 1);
      if (picked) return picked;
    }
  }
  for (const nested of Object.values(value)) {
    const picked = pickIcecatValue(nested, depth + 1);
    if (picked) return picked;
  }
  return "";
}

function humanizeSpecKey(value = "") {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function addFlatSpec(out, key, value) {
  const cleanKey = humanizeSpecKey(key);
  const cleanValue = normalizeSpecPrimitive(value);
  if (!cleanKey || !cleanValue) return;
  if (out[cleanKey]) {
    if (!out[cleanKey].includes(cleanValue)) out[cleanKey] += ` | ${cleanValue}`;
    return;
  }
  out[cleanKey] = cleanValue;
}

function flattenIcecatSpecs(node, out = {}, context = { count: 0 }, trail = [], depth = 0) {
  if (context.count >= 450 || depth > 8 || node == null) return out;
  const primitive = normalizeSpecPrimitive(node);
  if (primitive) {
    addFlatSpec(out, trail.join(" / "), primitive);
    context.count += 1;
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((item) => flattenIcecatSpecs(item, out, context, trail, depth + 1));
    return out;
  }
  if (typeof node !== "object") return out;

  const nameCandidate =
    pickIcecatValue(node.Name) ||
    pickIcecatValue(node.Feature) ||
    pickIcecatValue(node.FeatureName) ||
    pickIcecatValue(node.Label);
  const valueCandidate =
    pickIcecatValue(node.Presentation_Value) ||
    pickIcecatValue(node.PresentationValue) ||
    pickIcecatValue(node.Value) ||
    pickIcecatValue(node.LocalValue) ||
    pickIcecatValue(node.DisplayValue);
  if (nameCandidate && valueCandidate) {
    addFlatSpec(out, nameCandidate, valueCandidate);
    context.count += 1;
  }

  Object.entries(node).forEach(([key, value]) => {
    if (context.count >= 450) return;
    flattenIcecatSpecs(value, out, context, trail.concat([humanizeSpecKey(key)]), depth + 1);
  });
  return out;
}

function mapIcecatPayload(payload, fallbackId = "") {
  const dataRoot = payload?.data || payload || {};
  const data =
    dataRoot?.Product ||
    dataRoot?.product ||
    dataRoot?.Data ||
    dataRoot?.data ||
    dataRoot ||
    {};
  const general =
    data?.GeneralInfo || data?.generalInfo || data?.General || data?.general || {};
  const flattened =
    flattenIcecatSpecs(
      data?.FeaturesGroups ||
        data?.FeatureGroups ||
        data?.featureGroups ||
        data?.Features ||
        data?.features ||
        []
    ) || {};
  const fallbackSpecs = Object.keys(flattened).length
    ? flattened
    : flattenIcecatSpecs(general || data || {}) || {};
  const mapped = {
    id: String(general.IcecatId || data?.IcecatId || fallbackId || ""),
    lang: ICECAT_LANG,
    shopname: process.env.ICECAT_SHOPNAME || process.env.ICECAT_USERNAME || "openIcecat-live",
    title: pickIcecatValue(data?.Title) || pickIcecatValue(general?.Title) || "",
    brand: pickIcecatValue(general?.Brand) || "",
    category: pickIcecatValue(general?.Category) || "",
    productCode:
      pickIcecatValue(general?.BrandPartCode) || pickIcecatValue(general?.ProductCode) || "",
    summary:
      pickIcecatValue(data?.SummaryDescription) || pickIcecatValue(data?.MarketingText) || "",
    syncedAt: new Date().toISOString(),
    specs: fallbackSpecs,
  };
  if (!mapped.id && payload?.id) mapped.id = String(payload.id);
  return mapped;
}

async function fetchIcecatById(icecatId = "") {
  const id = String(icecatId || "").trim();
  if (!id) throw new Error("Icecat product ID is required.");
  if (!process.env.ICECAT_API_TOKEN) throw new Error("ICECAT_API_TOKEN is not configured.");
  const url = new URL(ICECAT_API_URL);
  url.searchParams.set("lang", ICECAT_LANG);
  url.searchParams.set("shopname", process.env.ICECAT_SHOPNAME || "openIcecat-live");
  url.searchParams.set("username", process.env.ICECAT_SHOPNAME || "openIcecat-live");
  url.searchParams.set("content", process.env.ICECAT_CONTENT_QUERY ?? "");
  url.searchParams.set("icecat_id", id);
  if (process.env.ICECAT_APP_KEY) {
    url.searchParams.set("app_key", process.env.ICECAT_APP_KEY);
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Api-Token": process.env.ICECAT_API_TOKEN,
      ...(process.env.ICECAT_CONTENT_TOKEN
        ? {
            "Content-Token": process.env.ICECAT_CONTENT_TOKEN,
          }
        : {}),
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const error = new Error(
      payload?.msg ||
        payload?.Message ||
        payload?.Error ||
        text ||
        `Icecat request failed ${response.status}`
    );
    error.status = response.status;
    throw error;
  }
  if (payload?.msg && String(payload.msg).toLowerCase() !== "ok") {
    throw new Error(payload.msg);
  }
  const mapped = mapIcecatPayload(payload, id);
  const specCount = Object.keys(mapped.specs || {}).length;
  if (!mapped.id && !mapped.title && specCount === 0) {
    throw new Error("Icecat returned no usable product data");
  }
  return mapped;
}

function findSpecValue(specsRaw, candidates = []) {
  if (!specsRaw || typeof specsRaw !== "object") return "";
  const normalizedCandidates = candidates.map(normalizeSpecKey).filter(Boolean);
  const queue = [specsRaw];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      current.forEach((item) => {
        if (item && typeof item === "object") queue.push(item);
      });
      continue;
    }

    for (const [key, value] of Object.entries(current)) {
      const normalizedKey = normalizeSpecKey(key);
      const isCandidate = normalizedCandidates.some(
        (candidate) => normalizedKey === candidate || normalizedKey.includes(candidate)
      );
      const primitive = normalizeSpecPrimitive(value);
      if (isCandidate && primitive) return primitive;
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return "";
}

function getSpecValue(specs = {}, keys = []) {
  return findSpecValue(specs, keys);
}

function titleIncludes(title = "", pattern) {
  return pattern.test(String(title || ""));
}

function formatCapacityToken(value = "", unit = "") {
  const numeric = String(value || "").trim();
  const suffix = String(unit || "").trim().toUpperCase();
  if (!numeric || !suffix) return "";
  return suffix === "T" ? `${numeric}TB` : `${numeric}GB`;
}

function inferLaptopTitleSpecs(title = "") {
  const raw = String(title || "").replace(/\s+/g, " ").trim();
  if (!raw) return {};

  const inferred = {};

  const slashLayout = raw.match(/\b(\d{1,3})\s*G(?:B)?\s*\/\s*(\d+(?:\.\d+)?)\s*([GT])(?:B)?\b/i);
  if (slashLayout) {
    inferred.ram = `${slashLayout[1]}GB`;
    inferred.storage = formatCapacityToken(slashLayout[2], slashLayout[3]);
  }

  if (!inferred.ram) {
    const ramMatch =
      raw.match(/\b(?:RAM\s*)?(\d{1,3})\s*GB(?:\s*RAM)?\b/i) ||
      raw.match(/\b(\d{1,3})\s*G(?:B)?\s+RAM\b/i);
    if (ramMatch) inferred.ram = `${ramMatch[1]}GB`;
  }

  if (!inferred.storage) {
    const storageMatch =
      raw.match(/\b(\d+(?:\.\d+)?)\s*(TB|GB)\s*(?:SSD|HDD|NVME|PCIE)?\b/i) ||
      raw.match(/\bSSD\s*(\d+(?:\.\d+)?)\s*(TB|GB)\b/i) ||
      raw.match(/\b(\d+(?:\.\d+)?)\s*([GT])\b/i);
    if (storageMatch) {
      const unit = storageMatch[2].toUpperCase();
      inferred.storage = unit.length === 1 ? formatCapacityToken(storageMatch[1], unit) : `${storageMatch[1]}${unit}`;
    }
  }

  const intelCoreMatch = raw.match(/\bI([3579])[-\s]?(\d{4,5}[A-Z]{0,3})\b/i);
  if (intelCoreMatch) {
    inferred.cpu = `Intel Core i${intelCoreMatch[1]}-${intelCoreMatch[2].toUpperCase()}`;
  }

  if (!inferred.cpu) {
    const intelCoreNewMatch =
      raw.match(/\bC([3579])[-\s]?(\d{3,5}[A-Z]{0,3})\b/i) ||
      raw.match(/\bCORE\s+([3579])[-\s]?(\d{3,5}[A-Z]{0,3})\b/i);
    if (intelCoreNewMatch) {
      inferred.cpu = `Intel Core ${intelCoreNewMatch[1]} ${intelCoreNewMatch[2].toUpperCase()}`;
    }
  }

  if (!inferred.cpu) {
    const ultraMatch =
      raw.match(/\bU([579])[-\s]?(\d{3,5}[A-Z]{0,3})\b/i) ||
      raw.match(/\bULTRA\s+([579])[-\s]?(\d{3,5}[A-Z]{0,3})\b/i) ||
      raw.match(/\bCORE\s+ULTRA\s+([579])[-\s]?(\d{3,5}[A-Z]{0,3})\b/i);
    if (ultraMatch) {
      inferred.cpu = `Intel Core Ultra ${ultraMatch[1]} ${ultraMatch[2].toUpperCase()}`;
    }
  }

  if (!inferred.cpu) {
    const ryzenAiMatch =
      raw.match(/\bR\s*AI\s*([3579])[-\s]?(\d{3,5}[A-Z]{0,3})\b/i) ||
      raw.match(/\bRYZEN\s*AI\s*([3579])[-\s]?(\d{3,5}[A-Z]{0,3})\b/i);
    if (ryzenAiMatch) {
      inferred.cpu = `AMD Ryzen AI ${ryzenAiMatch[1]} ${ryzenAiMatch[2].toUpperCase()}`;
    }
  }

  if (!inferred.cpu) {
    const ryzenMatch =
      raw.match(/\bR([3579])[-\s]?(\d{3,5}[A-Z]{0,3})\b/i) ||
      raw.match(/\bRYZEN\s*([3579])[-\s]?(\d{3,5}[A-Z]{0,3})\b/i);
    if (ryzenMatch) {
      inferred.cpu = `AMD Ryzen ${ryzenMatch[1]} ${ryzenMatch[2].toUpperCase()}`;
    }
  }

  if (!inferred.cpu) {
    const snapdragonMatch = raw.match(/\bSNAPDRAGON\s+([A-Z0-9+\s]+?\d{4,5})\b/i);
    if (snapdragonMatch) {
      inferred.cpu = `Qualcomm Snapdragon ${snapdragonMatch[1].replace(/\s+/g, " ").trim()}`;
    }
  }

  const rtxMatch = raw.match(/\bRTX\s*(\d{3,4})(\s*TI)?(?:\s*(\d{1,2})\s*G(?:B)?)?\b/i);
  if (rtxMatch) {
    inferred.gpu = `NVIDIA GeForce RTX ${rtxMatch[1]}${rtxMatch[2] ? " Ti" : ""}${rtxMatch[3] ? ` ${rtxMatch[3]}GB` : ""}`;
  }

  if (!inferred.gpu) {
    const gtxMatch = raw.match(/\bGTX\s*(\d{3,4})(?:\s*(\d{1,2})\s*G(?:B)?)?\b/i);
    if (gtxMatch) {
      inferred.gpu = `NVIDIA GeForce GTX ${gtxMatch[1]}${gtxMatch[2] ? ` ${gtxMatch[2]}GB` : ""}`;
    }
  }

  if (!inferred.gpu) {
    const mxMatch = raw.match(/\bMX\s*(\d{3,4})\b/i);
    if (mxMatch) inferred.gpu = `NVIDIA GeForce MX${mxMatch[1]}`;
  }

  if (!inferred.gpu) {
    const rxMatch = raw.match(/\bRX\s*(\d{4,5}[A-Z]{0,2})\b/i);
    if (rxMatch) inferred.gpu = `AMD Radeon RX ${rxMatch[1].toUpperCase()}`;
  }

  if (!inferred.gpu) {
    const radeonMatch = raw.match(/\bRADEON\s+([A-Z0-9 ]{3,20})\b/i);
    if (radeonMatch) inferred.gpu = `AMD Radeon ${radeonMatch[1].replace(/\s+/g, " ").trim()}`;
  }

  const displayMatch = raw.match(/\b(\d{1,2}(?:\.\d)?)\s*(?:["`]|INCH)/i);
  if (displayMatch) inferred.display = `${displayMatch[1]}-inch`;

  if (titleIncludes(raw, /\bW11\b|\bWINDOWS\s*11\b/i)) inferred.operatingSystem = "Windows 11";
  else if (titleIncludes(raw, /\bW10\b|\bWINDOWS\s*10\b/i)) inferred.operatingSystem = "Windows 10";
  else if (titleIncludes(raw, /\bDOS\b|\bFREE\s*DOS\b|\bNO\s*OS\b/i)) inferred.operatingSystem = "DOS";

  return inferred;
}

function inferGpuTitleSpecs(title = "") {
  const raw = String(title || "").replace(/\s+/g, " ").trim();
  if (!raw) return {};
  const inferred = {};
  const rtxMatch = raw.match(/\bRTX\s*(\d{3,4})(\s*TI)?(?:\s*(\d{1,2})\s*G(?:B)?)?\b/i);
  if (rtxMatch) inferred.gpu = `NVIDIA GeForce RTX ${rtxMatch[1]}${rtxMatch[2] ? " Ti" : ""}`;
  const rxMatch = raw.match(/\bRX\s*(\d{4,5}[A-Z]{0,2})\b/i);
  if (!inferred.gpu && rxMatch) inferred.gpu = `AMD Radeon RX ${rxMatch[1].toUpperCase()}`;
  const memoryMatch = raw.match(/\b(\d{1,2})\s*G(?:B)?\b/i);
  if (memoryMatch) inferred.memory = `${memoryMatch[1]}GB`;
  const memoryTypeMatch = raw.match(/\b(GDDR[3567X]*)\b/i);
  if (memoryTypeMatch) inferred.memoryType = memoryTypeMatch[1].toUpperCase();
  return inferred;
}

function inferMonitorTitleSpecs(title = "") {
  const raw = String(title || "").replace(/\s+/g, " ").trim();
  if (!raw) return {};
  const inferred = {};
  const sizeMatch = raw.match(/\b(\d{2}(?:\.\d)?)\s*(?:["`]|INCH)/i);
  if (sizeMatch) inferred.display = `${sizeMatch[1]}-inch`;
  const refreshMatch = raw.match(/\b(\d{2,3})\s*HZ\b/i);
  if (refreshMatch) inferred.refreshRate = `${refreshMatch[1]}Hz`;
  if (titleIncludes(raw, /\b4K\b|\bUHD\b/i)) inferred.resolution = "3840 x 2160";
  else if (titleIncludes(raw, /\bQHD\b|\b2K\b/i)) inferred.resolution = "2560 x 1440";
  else if (titleIncludes(raw, /\bFHD\b|\b1080P\b/i)) inferred.resolution = "1920 x 1080";
  return inferred;
}

function inferRamTitleSpecs(title = "") {
  const raw = String(title || "").replace(/\s+/g, " ").trim();
  if (!raw) return {};
  const inferred = {};
  const capacityMatch = raw.match(/\b(\d{1,3})\s*G(?:B)?\b/i);
  if (capacityMatch) inferred.ram = `${capacityMatch[1]}GB`;
  const typeMatch = raw.match(/\b(DDR[345])\b/i);
  if (typeMatch) inferred.memoryType = typeMatch[1].toUpperCase();
  const speedMatch = raw.match(/\b(\d{4,5})\s*(?:MHZ|MT\/S)\b/i);
  if (speedMatch) inferred.speed = `${speedMatch[1]} MT/s`;
  return inferred;
}

function inferStorageTitleSpecs(title = "") {
  const raw = String(title || "").replace(/\s+/g, " ").trim();
  if (!raw) return {};
  const inferred = {};
  const capacityMatch = raw.match(/\b(\d+(?:\.\d+)?)\s*(TB|GB)\b/i);
  if (capacityMatch) inferred.storage = `${capacityMatch[1]}${capacityMatch[2].toUpperCase()}`;
  if (titleIncludes(raw, /\bNVME\b/i)) inferred.interface = "NVMe";
  else if (titleIncludes(raw, /\bSATA\b/i)) inferred.interface = "SATA";
  if (titleIncludes(raw, /\bM\.?2\b/i)) inferred.formFactor = "M.2";
  else if (raw.match(/\b2\.5["']?\b/i)) inferred.formFactor = "2.5-inch";
  return inferred;
}

function inferMotherboardTitleSpecs(title = "") {
  const raw = String(title || "").replace(/\s+/g, " ").trim();
  if (!raw) return {};
  const inferred = {};
  const socketMatch = raw.match(/\b(LGA\s*1\d{3}|AM[45])\b/i);
  if (socketMatch) inferred.socket = socketMatch[1].replace(/\s+/g, "");
  const chipsetMatch = raw.match(/\b([ABHXZ]\d{3,4}[A-Z]?)\b/i);
  if (chipsetMatch) inferred.chipset = chipsetMatch[1].toUpperCase();
  const formFactorMatch = raw.match(/\b(E-ATX|ATX|M-ATX|MATX|MICRO-ATX|MINI-ITX|ITX)\b/i);
  if (formFactorMatch) {
    const value = formFactorMatch[1].toUpperCase();
    inferred.formFactor = value === "MATX" ? "Micro ATX" : value;
  }
  if (titleIncludes(raw, /\bDDR5\b/i)) inferred.memoryType = "DDR5";
  else if (titleIncludes(raw, /\bDDR4\b/i)) inferred.memoryType = "DDR4";
  return inferred;
}

function inferTitleSpecs(title = "", type = "") {
  const normalizedType = normalizeProductType(type);
  if (normalizedType === "laptop" || normalizedType === "desktop") return inferLaptopTitleSpecs(title);
  if (normalizedType === "gpu") return inferGpuTitleSpecs(title);
  if (normalizedType === "monitor") return inferMonitorTitleSpecs(title);
  if (normalizedType === "ram") return inferRamTitleSpecs(title);
  if (normalizedType === "storage") return inferStorageTitleSpecs(title);
  if (normalizedType === "motherboard") return inferMotherboardTitleSpecs(title);
  return {};
}

function mergeInferredSpecs(specs = {}, inferred = {}, type = "") {
  const merged = { ...(specs && typeof specs === "object" ? specs : {}) };
  const normalizedType = normalizeProductType(type);
  const put = (label, value) => {
    if (!value || merged[label]) return;
    merged[label] = value;
  };

  if (normalizedType === "laptop" || normalizedType === "desktop") {
    put("Processor", inferred.cpu);
    put("Graphics", inferred.gpu);
    put("Memory", inferred.ram);
    put("Storage", inferred.storage);
    put("Display", inferred.display);
    put("Operating System", inferred.operatingSystem);
  } else if (normalizedType === "gpu") {
    put("Graphics Processor", inferred.gpu);
    put("Memory", inferred.memory);
    put("Memory Type", inferred.memoryType);
  } else if (normalizedType === "monitor") {
    put("Display", inferred.display);
    put("Display resolution", inferred.resolution);
    put("Maximum refresh rate", inferred.refreshRate);
  } else if (normalizedType === "ram") {
    put("Internal memory", inferred.ram);
    put("Memory type", inferred.memoryType);
    put("Memory clock speed", inferred.speed);
  } else if (normalizedType === "storage") {
    put("Storage", inferred.storage);
    put("Interface", inferred.interface);
    put("SSD form factor", inferred.formFactor);
  } else if (normalizedType === "motherboard") {
    put("Processor socket", inferred.socket);
    put("Motherboard chipset", inferred.chipset);
    put("Motherboard form factor", inferred.formFactor);
    put("Supported memory types", inferred.memoryType);
  }

  return merged;
}

function buildSpecsPayload(body = {}, existingSpecs = {}) {
  const manual =
    existingSpecs.manual && typeof existingSpecs.manual === "object" ? existingSpecs.manual : {};
  const incomingManual = body.specs && typeof body.specs === "object" ? body.specs : {};
  const existingIcecat =
    existingSpecs.icecat && typeof existingSpecs.icecat === "object" ? existingSpecs.icecat : null;
  const specs = {
    ...existingSpecs,
    cpu: body.cpu || existingSpecs.cpu || "",
    gpu: body.gpu || existingSpecs.gpu || "",
    ram: body.ram || existingSpecs.ram || "",
    storage: body.storage || existingSpecs.storage || "",
    display: body.display || existingSpecs.display || "",
  };
  if (existingIcecat) specs.icecat = existingIcecat;
  if (body.icecatId) {
    specs.icecat = {
      ...(existingIcecat || {}),
      id: String(body.icecatId).trim(),
    };
  }
  const nextManual = body.replaceManualSpecs ? { ...incomingManual } : { ...manual, ...incomingManual };
  if (body.capacity) nextManual.capacity = body.capacity;
  if (body.memoryType) nextManual.memoryType = body.memoryType;
  if (body.chipset) nextManual.chipset = body.chipset;
  if (Object.keys(nextManual).length) specs.manual = nextManual;
  else delete specs.manual;
  return specs;
}

const PRODUCT_TYPES = {
  laptop: { table: "laptops", label: "Laptop" },
  gpu: { table: "gpus", label: "GPU" },
  cpu: { table: "cpus", label: "CPU" },
  storage: { table: "hdds", label: "Storage" },
  motherboard: { table: "motherboards", label: "Motherboard" },
  ram: { table: "products", label: "Memory" },
  monitor: { table: "products", label: "Monitor" },
  printer: { table: "products", label: "Printer" },
  desktop: { table: "products", label: "Desktop" },
  power: { table: "products", label: "Power" },
  accessory: { table: "products", label: "Accessory" },
  other: { table: "products", label: "Product" },
};

function normalizeProductType(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "laptops") return "laptop";
  if (raw === "gpus") return "gpu";
  if (raw === "cpus") return "cpu";
  if (raw === "hdd" || raw === "hdds" || raw === "ssd" || raw === "storage") return "storage";
  if (raw === "motherboards") return "motherboard";
  if (PRODUCT_TYPES[raw]) return raw;
  return "";
}

function mapProduct(record, type) {
  if (!record) return null;
  const company = record.brands ? mapCompany(record.brands) : null;
  const normalizedType = normalizeProductType(type);
  const specsRaw = normalizeSpecsRaw(record.specs_raw);
  const manualSpecs =
    specsRaw.manual && typeof specsRaw.manual === "object" ? specsRaw.manual : {};
  const icecat =
    specsRaw.icecat && typeof specsRaw.icecat === "object" && !Array.isArray(specsRaw.icecat)
      ? specsRaw.icecat
      : null;
  const icecatSpecs =
    icecat?.specs && typeof icecat.specs === "object" && !Array.isArray(icecat.specs)
      ? icecat.specs
      : {};
  const webSpecs =
    specsRaw.web?.specs && typeof specsRaw.web.specs === "object" && !Array.isArray(specsRaw.web.specs)
      ? specsRaw.web.specs
      : {};
  const productId = record.product_id || record.id;
  const fallbackTitle = `${PRODUCT_TYPES[normalizedType]?.label || "Product"} ${String(productId || "").slice(0, 8)}`;
  const resolvedTitle = record.title || record.name || fallbackTitle;
  const inferred = inferTitleSpecs(resolvedTitle, normalizedType || type);
  const mergedSpecs = mergeInferredSpecs({ ...webSpecs, ...icecatSpecs, ...manualSpecs }, inferred, normalizedType || type);
  const product = {
    id: productId,
    type: normalizedType || type,
    companyId: record.brand_id,
    shortName: record.short_name || "",
    title: resolvedTitle,
    price: record.price != null ? Number(record.price) : 0,
    description: record.description || "",
    images: Array.isArray(record.images) ? record.images : record.images ? [record.images] : [],
    warranty: record.warranty != null ? Number(record.warranty) : 0,
    specs: mergedSpecs,
    specsRaw,
    icecatId: icecat?.id ? String(icecat.id) : "",
    icecatTitle: icecat?.title || "",
    icecatCategory: icecat?.category || "",
    company,
  };
  product.gpu =
    record.gpu ||
    getSpecValue(specsRaw, [
      "gpu",
      "graphics",
      "vga",
      "graphics processor",
      "discrete graphics card model",
      "graphics adapter",
    ]) ||
    inferred.gpu ||
    inferred.memory;
  product.cpu =
    record.cpu ||
    getSpecValue(specsRaw, ["cpu", "processor model", "processor family", "processor cores"]) ||
    inferred.cpu;
  product.ram =
    record.ram ||
    getSpecValue(specsRaw, ["ram", "internal memory", "system memory", "memory"]) ||
    inferred.ram ||
    inferred.memory;
  product.storage =
    record.storage ||
    getSpecValue(specsRaw, [
      "storage",
      "total storage capacity",
      "ssd capacity",
      "hdd capacity",
      "capacity",
    ]) ||
    inferred.storage;
  product.display =
    record.display ||
    getSpecValue(specsRaw, ["display diagonal", "display resolution", "display", "screen", "monitor"]) ||
    inferred.display ||
    inferred.resolution;
  return product;
}

function mapUser(record) {
  if (!record) return null;
  return {
    id: record.id,
    username: record.username,
    fullName: record.full_name || "",
    role: record.admin ? "admin" : "staff",
  };
}

function filterProducts(products, filters) {
  const normalizedCategory = normalizeProductType(filters.category || filters.type || "");
  return products.filter((product) => {
    const search = filters.search?.toLowerCase() || "";
    const companyName = product.company?.name || "";
    const title = product.title || "";
    const matchesSearch =
      !search ||
      title.toLowerCase().includes(search) ||
      (product.shortName || "").toLowerCase().includes(search) ||
      (product.description || "").toLowerCase().includes(search) ||
      companyName.toLowerCase().includes(search) ||
      (product.type || "").toLowerCase().includes(search) ||
      (product.gpu || "").toLowerCase().includes(search) ||
      (product.cpu || "").toLowerCase().includes(search) ||
      (product.ram || "").toLowerCase().includes(search) ||
      (product.storage || "").toLowerCase().includes(search) ||
      (product.display || "").toLowerCase().includes(search) ||
      Object.values(product.specs || {}).some((value) =>
        String(value || "").toLowerCase().includes(search)
      );
    const matchesCompany = !filters.companyId || product.companyId === filters.companyId;
    const matchesCategory =
      !normalizedCategory || normalizeProductType(product.type) === normalizedCategory;
    const matchesIds =
      !filters.ids || (Array.isArray(filters.ids) && filters.ids.includes(product.id));
    return matchesSearch && matchesCompany && matchesCategory && matchesIds;
  });
}

async function handleAuthMe(session, reply) {
  if (!session) {
    reply(200, { authenticated: false });
    return;
  }
  const data = await sb("users", {
    params: { select: "id,username,full_name,admin", id: `eq.${session.userId}` },
  });
  const record = data?.[0];
  if (!record) {
    destroySession(session.token);
    reply(200, { authenticated: false });
    return;
  }
  const user = mapUser(record);
  reply(200, { authenticated: true, user });
}

async function fetchContact() {
  const data = await sb("contact", { params: { select: "*", id: "eq.1" } });
  return data?.[0] || {
    sales_hotline: "+1 (000) 000-0000",
    whatsapp: "+1 (000) 000-0001",
    support_email: "support@compumagic.example",
    address: "Add your operations office address here",
    availability: [],
  };
}

function buildProductSelect(type) {
  const fields = [
    "product_id",
    "brand_id",
    "title",
    "description",
    "images",
    "warranty",
    "short_name",
    "created_at",
    "brands(*)",
  ];
  if (type === "laptop") {
    fields.push("gpu", "cpu", "ram", "storage", "display");
  }
  return fields.join(",");
}

async function fetchProducts({ ids = [], category = "", companyId = "" } = {}) {
  const normalizedCategory = normalizeProductType(category);
  const params = { select: "*,brands(*)", order: "title.asc" };
  if (ids.length) {
    params.id = `in.(${ids.join(",")})`;
  }
  if (normalizedCategory && normalizedCategory !== "storage") {
    params.type = `eq.${normalizedCategory}`;
  }
  if (companyId) {
    params.brand_id = `eq.${companyId}`;
  }
  const records = await sb("products", { params });
  return records.map((record) => mapProduct(record, record.type)).filter(Boolean);
}

function requireAuth(req, res, session, { admin = false } = {}) {
  if (!session) {
    sendJSON(res, 401, { error: "Unauthorized" }, {}, req);
    return false;
  }
  if (admin && session.role !== "admin") {
    sendJSON(res, 403, { error: "Forbidden" }, {}, req);
    return false;
  }
  return true;
}

async function handleApi(req, res, pathname, searchParams) {
  const method = req.method;
  const segments = pathname.split("/").filter(Boolean);
  const resource = segments[1] || "";
  const slug = segments[2] || "";
  const cookies = parseCookies(req.headers.cookie || "");
  const sessionId = cookies.sessionId;
  const sessionPayload = parseSessionToken(sessionId);
  const session = sessionPayload
    ? {
        userId: sessionPayload.sub,
        username: sessionPayload.username,
        role: sessionPayload.role,
        fullName: sessionPayload.fullName,
        token: sessionId,
      }
    : null;

  const reply = (status, payload, headers = {}) => sendJSON(res, status, payload, headers, req);

  try {
    if (method === "OPTIONS") {
      reply(204, {});
      return;
    }
    switch (resource) {
      case "auth": {
        const action = slug || "";
        if (action === "signup" && method === "POST") {
          const body = await parseBody(req);
          if (!body || !body.username || !body.password) {
            reply(400, { error: "Missing username or password" });
            return;
          }
          const username = String(body.username).trim().toLowerCase();
          const existing = await sb("users", {
            params: { select: "id", username: `eq.${username}` },
          });
          if (existing.length) {
            reply(409, { error: "Username already exists" });
            return;
          }
          const payload = {
            username,
            is_registered: true,
            admin: false,
            hashed_password: hashPassword(body.password),
            full_name: body.fullName || "",
          };
          const created = await sb("users", {
            method: "POST",
            headers: { Prefer: "return=representation" },
            body: payload,
          });
          const record = created?.[0];
          const user = mapUser(record);
          const token = createSession(user);
          const cookie = serializeCookie("sessionId", token, {
            path: "/",
            httpOnly: true,
            sameSite: "Lax",
            maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
          });
          reply(201, user, { "Set-Cookie": cookie });
          return;
        }
        if (action === "login" && method === "POST") {
          const body = await parseBody(req);
          if (!body || !body.username || !body.password) {
            reply(400, { error: "Missing username or password" });
            return;
          }
          const username = String(body.username).trim().toLowerCase();
          const users = await sb("users", {
            params: { select: "id,username,full_name,admin,hashed_password", username: `eq.${username}` },
          });
          const record = users?.[0];
          if (!record || hashPassword(body.password) !== record.hashed_password) {
            reply(401, { error: "Invalid username or password" });
            return;
          }
          const user = mapUser(record);
          const token = createSession(user);
          const cookie = serializeCookie("sessionId", token, {
            path: "/",
            httpOnly: true,
            sameSite: "Lax",
            maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
          });
          reply(200, user, { "Set-Cookie": cookie });
          return;
        }
        if (action === "logout" && method === "POST") {
          const cookie = serializeCookie("sessionId", "", {
            path: "/",
            httpOnly: true,
            sameSite: "Lax",
            maxAge: 0,
          });
          if (session?.token) destroySession(session.token);
          reply(200, { success: true }, { "Set-Cookie": cookie });
          return;
        }
        if (action === "me" && method === "GET") {
          await handleAuthMe(session, reply);
          return;
        }
        break;
      }
      case "companies": {
        if (method === "GET") {
          const brands = await sb("brands", { params: { select: "*", order: "name.asc" } });
          reply(200, brands.map(mapCompany));
          return;
        }
        if (method === "POST") {
          if (!requireAuth(req, res, session, { admin: true })) return;
          const body = await parseBody(req);
          if (!body || !body.name) {
            reply(400, { error: "Missing company name" });
            return;
          }
          const created = await sb("brands", {
            method: "POST",
            headers: { Prefer: "return=representation" },
            body: { name: body.name, description: body.description || "" },
          });
          reply(201, mapCompany(created?.[0]));
          return;
        }
        if (method === "DELETE" && slug) {
          if (!requireAuth(req, res, session, { admin: true })) return;
          const removedImages = [];
          const rows = await sb("products", {
            params: { select: "id,images", brand_id: `eq.${slug}` },
          });
          rows.forEach((row) => {
            const images = Array.isArray(row.images) ? row.images : row.images ? [row.images] : [];
            images.filter(Boolean).forEach((image) => removedImages.push(image));
          });
          await sb("products", { method: "DELETE", params: { brand_id: `eq.${slug}` } });
          await sb("brands", { method: "DELETE", params: { id: `eq.${slug}` } });
          for (const image of removedImages) {
            try {
              await deleteStoredImage(image);
            } catch (error) {
              console.error("Failed to delete stored image", image, error.message);
            }
          }
          reply(200, { success: true });
          return;
        }
        break;
      }
      case "products":
      case "laptops": {
        const forcedCategory = resource === "laptops" ? "laptop" : "";
        const action = segments[3] || "";
        if (method === "POST" && slug && action === "icecat") {
          if (!requireAuth(req, res, session, { admin: true })) return;
          const body = await parseBody(req);
          const icecatId = String(body?.icecatId || "").trim();
          if (!icecatId) {
            reply(400, { error: "Icecat product ID is required." });
            return;
          }
          const current = await sb("products", { params: { select: "id,type,specs_raw", id: `eq.${slug}` } });
          if (!current.length) {
            reply(404, { error: "Product not found" });
            return;
          }
          const existingSpecs = normalizeSpecsRaw(current[0].specs_raw);
          const icecat = await fetchIcecatById(icecatId);
          const specsRaw = {
            ...existingSpecs,
            icecat,
          };
          const updated = await sb("products", {
            method: "PATCH",
            params: { id: `eq.${slug}` },
            headers: { Prefer: "return=representation" },
            body: { specs_raw: specsRaw },
          });
          reply(200, mapProduct(updated?.[0], current[0].type));
          return;
        }
        if (method === "GET" && slug) {
          const products = await fetchProducts({ ids: [slug], category: forcedCategory });
          const record = products?.[0];
          if (!record) {
            reply(404, { error: "Product not found" });
            return;
          }
          reply(200, record);
          return;
        }
        if (method === "GET") {
          const idsRaw = (searchParams.get("ids") || "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);
          const category = normalizeProductType(
            searchParams.get("category") || searchParams.get("type") || forcedCategory
          );
          const companyId = searchParams.get("companyId") || "";
          const products = await fetchProducts({
            ids: idsRaw,
            category,
            companyId,
          });
          const results = filterProducts(products, {
            search: searchParams.get("search") || "",
            companyId,
            category,
            ids: idsRaw.length ? idsRaw : null,
          });
          reply(200, results);
          return;
        }
        if (method === "POST") {
          if (!requireAuth(req, res, session, { admin: true })) return;
          const body = await parseBody(req);
          const incomingType = normalizeProductType(body?.category || body?.type || forcedCategory);
          if (!body || !incomingType || !body.companyId || !body.title) {
            reply(400, { error: "Missing category, companyId, or title" });
            return;
          }
          const brands = await sb("brands", { params: { select: "id", id: `eq.${body.companyId}` } });
          if (!brands.length) {
            reply(404, { error: "Brand not found" });
            return;
          }
          const images = Array.isArray(body.images)
            ? body.images.filter(Boolean)
            : typeof body.images === "string" && body.images
            ? body.images.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean)
            : [];
          const payload = {
            type: incomingType,
            brand_id: body.companyId,
            short_name: body.shortName || "",
            title: body.title,
            price: body.price != null ? Number(body.price) : 0,
            description: body.description || "",
            warranty: body.warranty != null ? Number(body.warranty) : 0,
            images,
            specs_raw: buildSpecsPayload(body),
          };
          const createdProduct = await sb("products", {
            method: "POST",
            headers: { Prefer: "return=representation" },
            body: payload,
          });
          reply(201, mapProduct(createdProduct?.[0], incomingType));
          return;
        }
        if (method === "PATCH" && slug) {
          if (!requireAuth(req, res, session, { admin: true })) return;
          const body = await parseBody(req);
          if (!body) {
            reply(400, { error: "Missing payload" });
            return;
          }
          const current = await sb("products", { params: { select: "id,type,specs_raw", id: `eq.${slug}` } });
          if (!current.length) {
            reply(404, { error: "Product not found" });
            return;
          }
          const existingType = normalizeProductType(current[0].type);
          const nextType = normalizeProductType(body.category || body.type || existingType);
          if (nextType && existingType !== nextType) {
            reply(400, { error: "Category changes require creating a new product." });
            return;
          }
          const payload = {
            brand_id: body.companyId,
            short_name: body.shortName,
            title: body.title,
            price: body.price != null ? Number(body.price) : undefined,
            description: body.description,
            warranty: body.warranty != null ? Number(body.warranty) : undefined,
            images: Array.isArray(body.images)
              ? body.images.filter(Boolean)
              : typeof body.images === "string" && body.images
              ? body.images.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean)
              : undefined,
            specs_raw: buildSpecsPayload(body, current[0].specs_raw || {}),
          };
          Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key]);
          if (payload.brand_id) {
            const brands = await sb("brands", { params: { select: "id", id: `eq.${payload.brand_id}` } });
            if (!brands.length) {
              reply(404, { error: "Brand not found" });
              return;
            }
          }
          const updated = await sb("products", {
            method: "PATCH",
            params: { id: `eq.${slug}` },
            headers: { Prefer: "return=representation" },
            body: payload,
          });
          if (!updated.length) {
            reply(404, { error: "Product not found" });
            return;
          }
          reply(200, mapProduct(updated?.[0], existingType));
          return;
        }
        if (method === "DELETE" && slug) {
          if (!requireAuth(req, res, session, { admin: true })) return;
          const current = await sb("products", { params: { select: "id,images", id: `eq.${slug}` } });
          if (!current.length) {
            reply(404, { error: "Product not found" });
            return;
          }
          const record = current[0];
          await sb("products", { method: "DELETE", params: { id: `eq.${slug}` } });
          if (record?.images) {
            const images = Array.isArray(record.images) ? record.images : [record.images];
            for (const image of images.filter(Boolean)) {
              try {
                await deleteStoredImage(image);
              } catch (error) {
                console.error("Failed to delete stored image", image, error.message);
              }
            }
          }
          reply(200, { success: true });
          return;
        }
        break;
      }
      case "users": {
        if (!requireAuth(req, res, session, { admin: true })) return;
        if (method === "GET") {
          const users = await sb("users", {
            params: { select: "id,username,full_name,admin" },
          });
          reply(200, users.map(mapUser));
          return;
        }
        if (method === "DELETE" && slug) {
          await sb("users", { method: "DELETE", params: { id: `eq.${slug}` } });
          destroySessionsForUser(slug);
          reply(200, { success: true });
          return;
        }
        break;
      }
      case "contact": {
        if (method === "GET") {
          const record = await fetchContact();
          reply(200, {
            salesHotline: record.sales_hotline || "",
            whatsapp: record.whatsapp || "",
            supportEmail: record.support_email || "",
            address: record.address || "",
            availability: record.availability || [],
          });
          return;
        }
        if (method === "PUT") {
          if (!requireAuth(req, res, session, { admin: true })) return;
          const body = await parseBody(req);
          const payload = {
            sales_hotline: body.salesHotline || "",
            whatsapp: body.whatsapp || "",
            support_email: body.supportEmail || "",
            address: body.address || "",
            availability: Array.isArray(body.availability)
              ? body.availability
              : typeof body.availability === "string"
              ? body.availability.split("\n").map((line) => line.trim()).filter(Boolean)
              : [],
          };
          await sb("contact", {
            method: "PATCH",
            params: { id: "eq.1" },
            headers: { Prefer: "return=representation" },
            body: payload,
          });
          const updated = await fetchContact();
          reply(200, {
            salesHotline: updated.sales_hotline || "",
            whatsapp: updated.whatsapp || "",
            supportEmail: updated.support_email || "",
            address: updated.address || "",
            availability: updated.availability || [],
          });
          return;
        }
        break;
      }
      case "uploads": {
        if (!requireAuth(req, res, session, { admin: true })) return;
        if (method === "POST") {
          const body = await parseBody(req);
          if (!body || !body.data) {
            reply(400, { error: "Missing base64 data" });
            return;
          }
          let mime = "";
          let base64Payload = "";
          if (body.data.startsWith("data:")) {
            const match = body.data.match(/^data:([^;]+);base64,(.+)$/);
            if (!match) {
              reply(400, { error: "Invalid data URI format" });
              return;
            }
            mime = match[1];
            base64Payload = match[2];
          } else {
            base64Payload = body.data;
          }
          if (!base64Payload) {
            reply(400, { error: "Empty image payload" });
            return;
          }
          let extension = "";
          if (body.filename && body.filename.includes(".")) {
            extension = path.extname(body.filename).toLowerCase();
          } else if (mime) {
            const subtype = mime.split("/")[1];
            extension = subtype ? `.${subtype.replace(/[^\w]/g, "")}` : "";
          }
          if (!extension) extension = ".png";
          const allowed = new Set([".png", ".jpg", ".jpeg", ".webp"]);
          if (!allowed.has(extension)) {
            reply(400, { error: "Unsupported image type" });
            return;
          }
          const safeBase = sanitizeFilename(body.filename || `upload${extension}`);
          const baseName = safeBase.endsWith(extension)
            ? safeBase.slice(0, -extension.length)
            : safeBase;
          const finalName = `${Date.now()}-${baseName || "upload"}${extension}`;
          const url = await storeImage(finalName, base64Payload, mime);
          reply(201, { url });
          return;
        }
        break;
      }
      default:
        break;
    }
  } catch (error) {
    const status = error.status && Number.isInteger(error.status) ? error.status : 500;
    reply(status, { error: error.message || "Internal Server Error" });
    return;
  }

  reply(404, { error: "Not Found" });
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname);
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
  } catch (error) {
    if (pathname === "/") {
      filePath = path.join(PUBLIC_DIR, "index.html");
    } else {
      throw error;
    }
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
  const content = await fs.readFile(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  const { pathname, query } = parse(req.url);
  const searchParams = new URLSearchParams(query || "");
  if (pathname.startsWith("/api/")) {
    await handleApi(req, res, pathname, searchParams);
    return;
  }
  try {
    const normalized = pathname === "/" ? "/" : path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    await serveStatic(res, normalized);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendText(res, 404, "Not Found");
    } else {
      sendText(res, 500, "Internal Server Error");
    }
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

server.mapProduct = mapProduct;
server.inferTitleSpecs = inferTitleSpecs;
module.exports = server;

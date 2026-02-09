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

const PRODUCT_TYPES = {
  laptop: { table: "laptops", label: "Laptop" },
  gpu: { table: "gpus", label: "GPU" },
  cpu: { table: "cpus", label: "CPU" },
  hdd: { table: "hdds", label: "HDD" },
  motherboard: { table: "motherboards", label: "Motherboard" },
};

function normalizeProductType(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "laptops") return "laptop";
  if (raw === "gpus") return "gpu";
  if (raw === "cpus") return "cpu";
  if (raw === "hdds") return "hdd";
  if (raw === "motherboards") return "motherboard";
  if (PRODUCT_TYPES[raw]) return raw;
  return "";
}

function mapProduct(record, type) {
  if (!record) return null;
  const company = record.brands ? mapCompany(record.brands) : null;
  const normalizedType = normalizeProductType(type);
  const product = {
    id: record.product_id || record.id,
    type: normalizedType || type,
    companyId: record.brand_id,
    shortName: record.short_name || "",
    title: record.title,
    description: record.description || "",
    images: Array.isArray(record.images) ? record.images : record.images ? [record.images] : [],
    warranty: record.warranty != null ? Number(record.warranty) : 0,
    company,
  };
  if (normalizedType === "laptop") {
    product.gpu = record.gpu || "";
    product.cpu = record.cpu || "";
    product.ram = record.ram || "";
    product.storage = record.storage || "";
    product.display = record.display || "";
  }
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
    const matchesSearch =
      !search ||
      product.title.toLowerCase().includes(search) ||
      (product.shortName || "").toLowerCase().includes(search) ||
      (product.description || "").toLowerCase().includes(search) ||
      companyName.toLowerCase().includes(search) ||
      (product.type || "").toLowerCase().includes(search) ||
      (product.type === "laptop" &&
        ((product.gpu || "").toLowerCase().includes(search) ||
          (product.cpu || "").toLowerCase().includes(search) ||
          (product.ram || "").toLowerCase().includes(search) ||
          (product.storage || "").toLowerCase().includes(search) ||
          (product.display || "").toLowerCase().includes(search)));
    const matchesCompany = !filters.companyId || product.companyId === filters.companyId;
    const matchesCategory = !normalizedCategory || product.type === normalizedCategory;
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
  const params = { select: "id,type" };
  if (ids.length) {
    params.id = `in.(${ids.join(",")})`;
  }
  if (normalizedCategory) {
    params.type = `eq.${normalizedCategory}`;
  }
  const records = await sb("products", { params });
  if (!records.length) return [];
  const idsByType = new Map();
  records.forEach((record) => {
    const type = normalizeProductType(record.type);
    if (!type || !PRODUCT_TYPES[type]) return;
    if (!idsByType.has(type)) {
      idsByType.set(type, []);
    }
    idsByType.get(type).push(record.id);
  });
  const output = [];
  for (const [type, typeIds] of idsByType.entries()) {
    if (!typeIds.length) continue;
    const info = PRODUCT_TYPES[type];
    const tableParams = {
      select: buildProductSelect(type),
      order: "title.asc",
      product_id: `in.(${typeIds.join(",")})`,
    };
    if (companyId) {
      tableParams.brand_id = `eq.${companyId}`;
    }
    const rows = await sb(info.table, { params: tableParams });
    rows.forEach((row) => output.push(mapProduct(row, type)));
  }
  return output;
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
          const removedProductIds = new Set();
          const removedImages = [];
          for (const [type, info] of Object.entries(PRODUCT_TYPES)) {
            const rows = await sb(info.table, {
              params: { select: "product_id,images", brand_id: `eq.${slug}` },
            });
            rows.forEach((row) => {
              if (row.product_id) removedProductIds.add(row.product_id);
              if (row.images) {
                const images = Array.isArray(row.images) ? row.images : [row.images];
                images.filter(Boolean).forEach((image) => removedImages.push(image));
              }
            });
            await sb(info.table, { method: "DELETE", params: { brand_id: `eq.${slug}` } });
          }
          if (removedProductIds.size) {
            await sb("products", {
              method: "DELETE",
              params: { id: `in.(${Array.from(removedProductIds).join(",")})` },
            });
          }
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
          const info = PRODUCT_TYPES[incomingType];
          if (!info) {
            reply(400, { error: "Unsupported product category" });
            return;
          }
          const brands = await sb("brands", { params: { select: "id", id: `eq.${body.companyId}` } });
          if (!brands.length) {
            reply(404, { error: "Brand not found" });
            return;
          }
          const createdProduct = await sb("products", {
            method: "POST",
            headers: { Prefer: "return=representation" },
            body: { type: incomingType },
          });
          const productRecord = createdProduct?.[0];
          if (!productRecord) {
            reply(500, { error: "Failed to create product" });
            return;
          }
          const images = Array.isArray(body.images)
            ? body.images.filter(Boolean)
            : typeof body.images === "string" && body.images
            ? body.images.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean)
            : [];
          const payload = {
            product_id: productRecord.id,
            brand_id: body.companyId,
            short_name: body.shortName || "",
            title: body.title,
            price: body.price != null ? Number(body.price) : 0,
            description: body.description || "",
            warranty: body.warranty != null ? Number(body.warranty) : 0,
            images,
          };
          if (incomingType === "laptop") {
            payload.gpu = body.gpu || "";
            payload.cpu = body.cpu || "";
            payload.ram = body.ram || "";
            payload.storage = body.storage || "";
            payload.display = body.display || "";
          }
          await sb(info.table, {
            method: "POST",
            headers: { Prefer: "return=representation" },
            body: payload,
          });
          const hydrated = await sb(info.table, {
            params: { select: buildProductSelect(incomingType), product_id: `eq.${productRecord.id}` },
          });
          reply(201, mapProduct(hydrated?.[0], incomingType));
          return;
        }
        if (method === "PATCH" && slug) {
          if (!requireAuth(req, res, session, { admin: true })) return;
          const body = await parseBody(req);
          if (!body) {
            reply(400, { error: "Missing payload" });
            return;
          }
          const current = await sb("products", { params: { select: "id,type", id: `eq.${slug}` } });
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
          const info = PRODUCT_TYPES[existingType];
          const payload = {
            brand_id: body.companyId,
            short_name: body.shortName,
            title: body.title,
            description: body.description,
            warranty: body.warranty != null ? Number(body.warranty) : undefined,
            images: Array.isArray(body.images)
              ? body.images.filter(Boolean)
              : typeof body.images === "string" && body.images
              ? body.images.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean)
              : undefined,
          };
          if (existingType === "laptop") {
            payload.gpu = body.gpu;
            payload.cpu = body.cpu;
            payload.ram = body.ram;
            payload.storage = body.storage;
            payload.display = body.display;
          }
          Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key]);
          if (payload.brand_id) {
            const brands = await sb("brands", { params: { select: "id", id: `eq.${payload.brand_id}` } });
            if (!brands.length) {
              reply(404, { error: "Brand not found" });
              return;
            }
          }
          await sb(info.table, {
            method: "PATCH",
            params: { product_id: `eq.${slug}` },
            headers: { Prefer: "return=representation" },
            body: payload,
          });
          const hydrated = await sb(info.table, {
            params: { select: buildProductSelect(existingType), product_id: `eq.${slug}` },
          });
          if (!hydrated.length) {
            reply(404, { error: "Product not found" });
            return;
          }
          reply(200, mapProduct(hydrated?.[0], existingType));
          return;
        }
        if (method === "DELETE" && slug) {
          if (!requireAuth(req, res, session, { admin: true })) return;
          const current = await sb("products", { params: { select: "id,type", id: `eq.${slug}` } });
          if (!current.length) {
            reply(404, { error: "Product not found" });
            return;
          }
          const existingType = normalizeProductType(current[0].type);
          const info = PRODUCT_TYPES[existingType];
          const records = await sb(info.table, {
            params: { select: "product_id,images", product_id: `eq.${slug}` },
          });
          const record = records?.[0];
          await sb(info.table, { method: "DELETE", params: { product_id: `eq.${slug}` } });
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

module.exports = server;

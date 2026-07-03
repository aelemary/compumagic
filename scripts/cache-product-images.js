#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = path.join(__dirname, "..");
const STORAGE_PREFIX = "catalog-image";
const IMAGE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
  accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
};

function loadEnv() {
  const envPath = path.join(ROOT_DIR, ".env");
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .forEach((line) => {
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) return;
      const key = line.slice(0, eqIndex).trim();
      const value = line.slice(eqIndex + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    });
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    force: false,
    limit: 0,
    offset: 0,
    verifyOnly: false,
  };
  argv.forEach((arg) => {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--verify-only") args.verifyOnly = true;
    else if (arg.startsWith("--limit=")) args.limit = Number(arg.slice("--limit=".length));
    else if (arg.startsWith("--offset=")) args.offset = Number(arg.slice("--offset=".length));
  });
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function storageBaseUrl() {
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/${process.env.SUPABASE_STORAGE_BUCKET}/`;
}

function isStoredImage(url = "") {
  return Boolean(url && url.startsWith(storageBaseUrl()));
}

function normalizeUrl(url = "") {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:") parsed.protocol = "https:";
    return parsed.toString();
  } catch {
    return url;
  }
}

function cleanQuery(value = "") {
  return value
    .replace(/[®™]/g, "")
    .replace(/[^\w\s.+"/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extensionFor(mime = "", url = "") {
  const normalizedMime = String(mime || "").split(";")[0].trim().toLowerCase();
  if (normalizedMime === "image/jpeg") return ".jpg";
  if (normalizedMime === "image/png") return ".png";
  if (normalizedMime === "image/webp") return ".webp";
  if (normalizedMime === "image/gif") return ".gif";
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) return ext === ".jpeg" ? ".jpg" : ext;
  } catch {
    // ignore malformed source URLs
  }
  return ".jpg";
}

function imagePath(product, buffer, mime, sourceUrl) {
  const ext = extensionFor(mime, sourceUrl);
  const hash = crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 10);
  return `${STORAGE_PREFIX}-${product.id}-${hash}${ext}`;
}

async function sb(pathname, { method = "GET", params = {}, body, headers = {} } = {}) {
  const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/${pathname}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.append(key, value);
  });
  const response = await fetch(url, {
    method,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Supabase request failed with status ${response.status}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function fetchProducts() {
  const products = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/products`);
    url.searchParams.set("select", "id,title,type,images,brands(name)");
    url.searchParams.set("order", "title.asc");
    const response = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        Range: `${from}-${from + pageSize - 1}`,
      },
    });
    if (!response.ok) throw new Error(await response.text());
    const batch = await response.json();
    products.push(...batch);
    if (batch.length < pageSize) break;
  }
  return products;
}

async function ensureStorageBucket() {
  const bucket = process.env.SUPABASE_STORAGE_BUCKET;
  const getResponse = await fetch(`${process.env.SUPABASE_URL}/storage/v1/bucket/${encodeURIComponent(bucket)}`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (getResponse.ok) return;
  if (getResponse.status !== 404) {
    const text = await getResponse.text();
    throw new Error(text || `bucket check failed ${getResponse.status}`);
  }

  const createResponse = await fetch(`${process.env.SUPABASE_URL}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: bucket,
      name: bucket,
      public: true,
      file_size_limit: 10485760,
      allowed_mime_types: ["image/jpeg", "image/png", "image/webp", "image/gif"],
    }),
  });
  if (!createResponse.ok) {
    const text = await createResponse.text();
    throw new Error(text || `bucket creation failed ${createResponse.status}`);
  }
  console.log(`Created public storage bucket: ${bucket}`);
}

async function fetchImage(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) throw new Error("missing image URL");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(normalized, {
      signal: controller.signal,
      headers: IMAGE_HEADERS,
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`image request failed ${response.status}`);
    const mime = response.headers.get("content-type") || "";
    if (!mime.toLowerCase().startsWith("image/")) {
      throw new Error(`non-image response ${mime || "unknown"}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length < 1024) throw new Error("image response too small");
    return { buffer, mime, sourceUrl: normalized };
  } finally {
    clearTimeout(timer);
  }
}

async function duckDuckGoImages(query) {
  const page = await fetch(
    `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
    { headers: IMAGE_HEADERS }
  );
  if (!page.ok) throw new Error(`image search page failed ${page.status}`);
  const html = await page.text();
  const vqd = html.match(/vqd=['"]([^'"]+)/)?.[1] || html.match(/vqd=([^&"']+)/)?.[1];
  if (!vqd) return [];
  const response = await fetch(
    `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${encodeURIComponent(vqd)}&f=,,,&p=1`,
    {
      headers: {
        ...IMAGE_HEADERS,
        referer: "https://duckduckgo.com/",
      },
    }
  );
  if (!response.ok) throw new Error(`image result request failed ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.results) ? data.results : [];
}

function scoreResult(result, product) {
  const image = result.image || "";
  if (!/^https?:\/\//i.test(image)) return -100;
  if (/\.svg($|\?)/i.test(image)) return -20;
  if (/logo|icon|sprite|favicon|placeholder/i.test(image)) return -20;
  if ((result.width && result.width < 220) || (result.height && result.height < 180)) return -10;

  let score = 0;
  const haystack = `${result.title || ""} ${result.source || ""} ${result.url || ""}`.toLowerCase();
  const titleTokens = cleanQuery(product.title)
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 2)
    .slice(0, 9);
  titleTokens.forEach((token) => {
    if (haystack.includes(token)) score += 1;
  });
  const brand = product.brands?.name || "";
  if (brand && haystack.includes(brand.toLowerCase())) score += 4;
  if (/product|shop|store|official|amazon|newegg|asus|dell|lenovo|hp|msi|western|kingston|crucial|samsung/i.test(haystack)) {
    score += 2;
  }
  if (/\.(jpg|jpeg|png|webp)($|\?)/i.test(image)) score += 2;
  return score;
}

async function findReplacementImage(product) {
  const brand = product.brands?.name || "";
  const query = cleanQuery(`${brand} ${product.title} product image`);
  const results = await duckDuckGoImages(query);
  return results
    .map((result) => ({ ...result, score: scoreResult(result, product) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

async function resolveDownload(product) {
  const currentImages = Array.isArray(product.images) ? product.images : [];
  const current = currentImages[0] || "";
  if (current) {
    try {
      return await fetchImage(current);
    } catch (error) {
      console.log(`current failed: ${product.title} (${error.message})`);
    }
  }

  const replacements = await findReplacementImage(product);
  for (const result of replacements) {
    try {
      const downloaded = await fetchImage(result.image);
      return { ...downloaded, searchSource: result.url || result.source || "", score: result.score };
    } catch {
      // keep trying ranked candidates
    }
    await sleep(150);
  }
  throw new Error("no downloadable image found");
}

async function uploadImage(product, downloaded) {
  const objectPath = imagePath(product, downloaded.buffer, downloaded.mime, downloaded.sourceUrl);
  const target = `${process.env.SUPABASE_URL}/storage/v1/object/${encodeURIComponent(
    process.env.SUPABASE_STORAGE_BUCKET
  )}/${objectPath}`;
  const response = await fetch(target, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": downloaded.mime,
      "x-upsert": "true",
    },
    body: downloaded.buffer,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `storage upload failed ${response.status}`);
  }
  return `${storageBaseUrl()}${objectPath}`;
}

async function publicImageWorks(url) {
  const response = await fetch(url, { headers: IMAGE_HEADERS });
  if (!response.ok) return false;
  const mime = response.headers.get("content-type") || "";
  return mime.toLowerCase().startsWith("image/");
}

async function updateProductImage(product, imageUrl) {
  await sb("products", {
    method: "PATCH",
    params: { id: `eq.${product.id}` },
    headers: { Prefer: "return=minimal" },
    body: { images: [imageUrl] },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnv();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY || !process.env.SUPABASE_STORAGE_BUCKET) {
    throw new Error("SUPABASE_URL, SUPABASE_SERVICE_KEY, and SUPABASE_STORAGE_BUCKET are required.");
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = path.join(ROOT_DIR, "backups", `image-cache-${stamp}`);
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "report.json");

  if (!args.verifyOnly && !args.dryRun) {
    await ensureStorageBucket();
  }

  const products = await fetchProducts();
  const selected = products
    .filter((product) => {
      const current = Array.isArray(product.images) ? product.images[0] || "" : "";
      return args.force || !isStoredImage(current);
    })
    .slice(args.offset, args.limit ? args.offset + args.limit : undefined);

  console.log(`Products: ${products.length}; selected: ${selected.length}; dryRun: ${args.dryRun}; verifyOnly: ${args.verifyOnly}`);
  const report = [];

  for (let index = 0; index < selected.length; index += 1) {
    const product = selected[index];
    const current = Array.isArray(product.images) ? product.images[0] || "" : "";
    try {
      if (args.verifyOnly) {
        const works = current ? await publicImageWorks(normalizeUrl(current)) : false;
        report.push({ id: product.id, title: product.title, status: works ? "verified" : "broken", image: current });
        console.log(`${index + 1}/${selected.length} ${works ? "verified" : "broken"}: ${product.title}`);
      } else {
        const downloaded = await resolveDownload(product);
        const storedUrl = args.dryRun ? "" : await uploadImage(product, downloaded);
        if (!args.dryRun) {
          const works = await publicImageWorks(storedUrl);
          if (!works) throw new Error("uploaded image is not publicly readable");
          await updateProductImage(product, storedUrl);
        }
        report.push({
          id: product.id,
          title: product.title,
          status: args.dryRun ? "dry-run" : "cached",
          previousImage: current,
          storedImage: storedUrl,
          sourceImage: downloaded.sourceUrl,
          searchSource: downloaded.searchSource || "",
          score: downloaded.score || 0,
        });
        console.log(`${index + 1}/${selected.length} cached: ${product.title}`);
      }
    } catch (error) {
      report.push({ id: product.id, title: product.title, status: "error", image: current, error: error.message });
      console.log(`${index + 1}/${selected.length} error: ${product.title} (${error.message})`);
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    await sleep(180);
  }

  const counts = report.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  console.log(`Report: ${reportDir}`);
  console.log(JSON.stringify(counts, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

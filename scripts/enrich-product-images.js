#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
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
    limit: 0,
    offset: 0,
    dryRun: false,
    force: false,
    fixBroken: false,
  };
  argv.forEach((arg) => {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--fix-broken") args.fixBroken = true;
    else if (arg.startsWith("--limit=")) args.limit = Number(arg.slice("--limit=".length));
    else if (arg.startsWith("--offset=")) args.offset = Number(arg.slice("--offset=".length));
  });
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlaceholder(url = "") {
  return !url || /placehold\.co|placeholder/i.test(url);
}

function optimizedImageUrl(url = "", { width = 420, height = 315, quality = 68 } = {}) {
  if (!url || /placehold\.co/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("images.weserv.nl")) return url;
    const target = `${parsed.hostname}${parsed.pathname}${parsed.search}`;
    return `https://images.weserv.nl/?url=${encodeURIComponent(target)}&w=${width}&h=${height}&fit=contain&output=webp&q=${quality}`;
  } catch (error) {
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

async function duckDuckGoImages(query) {
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
  };
  const page = await fetch(
    `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
    { headers }
  );
  if (!page.ok) throw new Error(`Image search page failed ${page.status}`);
  const html = await page.text();
  const vqd = html.match(/vqd=['"]([^'"]+)/)?.[1] || html.match(/vqd=([^&"']+)/)?.[1];
  if (!vqd) return [];
  const response = await fetch(
    `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(
      query
    )}&vqd=${encodeURIComponent(vqd)}&f=,,,&p=1`,
    {
      headers: {
        ...headers,
        referer: "https://duckduckgo.com/",
      },
    }
  );
  if (!response.ok) throw new Error(`Image result request failed ${response.status}`);
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
    .slice(0, 8);
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

async function findImage(product) {
  const brand = product.brands?.name || "";
  const query = cleanQuery(`${brand} ${product.title} product image`);
  const results = await duckDuckGoImages(query);
  return results
    .map((result) => ({ ...result, score: scoreResult(result, product) }))
    .sort((a, b) => b.score - a.score)
    .find((result) => result.score > 0);
}

async function imageWorks(url) {
  if (!url) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(optimizedImageUrl(url), {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
    });
    return response.ok;
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnv();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required.");
  }

  const allProducts = await fetchProducts();
  let candidates = allProducts.filter((product) => {
    const images = Array.isArray(product.images) ? product.images : [];
    return args.force || !images.length || images.every(isPlaceholder);
  });
  if (args.fixBroken) {
    candidates = [];
    for (let index = 0; index < allProducts.length; index += 1) {
      const product = allProducts[index];
      const images = Array.isArray(product.images) ? product.images : [];
      const current = images[0] || "";
      const works = current && !isPlaceholder(current) ? await imageWorks(current) : false;
      if (!works) candidates.push(product);
      console.log(`checked ${index + 1}/${allProducts.length}${works ? "" : " broken"}`);
      await sleep(120);
    }
  }
  const selected = candidates.slice(args.offset, args.limit ? args.offset + args.limit : undefined);
  console.log(`Products: ${allProducts.length}; image candidates: ${candidates.length}; selected: ${selected.length}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = path.join(process.cwd(), "backups", `image-enrichment-${stamp}`);
  fs.mkdirSync(reportDir, { recursive: true });
  const report = [];

  for (let index = 0; index < selected.length; index += 1) {
    const product = selected[index];
    try {
      const result = await findImage(product);
      if (!result) {
        console.log(`${index + 1}/${selected.length} miss: ${product.title}`);
        report.push({ id: product.id, title: product.title, status: "miss" });
      } else {
        if (!args.dryRun) {
          await sb("products", {
            method: "PATCH",
            params: { id: `eq.${product.id}` },
            headers: { Prefer: "return=minimal" },
            body: { images: [result.image] },
          });
        }
        console.log(`${index + 1}/${selected.length} image: ${product.title}`);
        report.push({
          id: product.id,
          title: product.title,
          status: args.dryRun ? "dry-run" : "updated",
          image: result.image,
          source: result.url || result.source || "",
          score: result.score,
        });
      }
    } catch (error) {
      console.log(`${index + 1}/${selected.length} error: ${product.title} (${error.message})`);
      report.push({ id: product.id, title: product.title, status: "error", error: error.message });
    }
    fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2));
    await sleep(650);
  }

  const updated = report.filter((item) => item.status === "updated" || item.status === "dry-run").length;
  const missed = report.filter((item) => item.status === "miss").length;
  const errored = report.filter((item) => item.status === "error").length;
  console.log(`Report: ${reportDir}`);
  console.log(`Done. Images: ${updated}; misses: ${missed}; errors: ${errored}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

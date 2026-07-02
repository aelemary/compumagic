#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ICECAT_API_URL = process.env.ICECAT_API_URL || "https://live.icecat.biz/api";
const DEFAULT_LANG = process.env.ICECAT_LANG || "EN";
const webSpecCache = new Map();

function parseArgs(argv) {
  const args = {
    limit: 0,
    offset: 0,
    dryRun: false,
    force: false,
    idsOnly: false,
    category: "",
    skipWeb: false,
    printQueries: false,
  };
  argv.forEach((arg) => {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--ids-only") args.idsOnly = true;
    else if (arg === "--skip-web") args.skipWeb = true;
    else if (arg === "--print-queries") args.printQueries = true;
    else if (arg.startsWith("--category=")) args.category = arg.slice("--category=".length).trim();
    else if (arg.startsWith("--limit=")) args.limit = Number(arg.slice("--limit=".length));
    else if (arg.startsWith("--offset=")) args.offset = Number(arg.slice("--offset=".length));
  });
  return args;
}

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    lang: DEFAULT_LANG,
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
  if (!response.ok) throw new Error((await response.text()) || `Supabase ${response.status}`);
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function fetchProducts() {
  const products = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/products`);
    url.searchParams.set("select", "id,title,type,brand_id,specs_raw,brands(name)");
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

async function fetchIcecat(params, fallbackId = "") {
  const url = new URL(process.env.ICECAT_API_URL || ICECAT_API_URL);
  url.searchParams.set("lang", DEFAULT_LANG);
  url.searchParams.set("shopname", process.env.ICECAT_SHOPNAME || "openIcecat-live");
  url.searchParams.set("username", process.env.ICECAT_SHOPNAME || "openIcecat-live");
  url.searchParams.set("content", process.env.ICECAT_CONTENT_QUERY ?? "");
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });
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
    error.payload = payload;
    throw error;
  }
  if (payload?.msg && String(payload.msg).toLowerCase() !== "ok") {
    const error = new Error(payload.msg);
    error.payload = payload;
    throw error;
  }
  const mapped = mapIcecatPayload(payload, fallbackId);
  const specCount = Object.keys(mapped.specs || {}).length;
  if (!mapped.id && !mapped.title && specCount === 0) {
    throw new Error("Icecat returned no usable product data");
  }
  return mapped;
}

function cleanTitle(value = "") {
  return String(value || "")
    .replace(/[®™]/g, "")
    .replace(/[()[\]{},;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function productBrandName(product) {
  const title = String(product.title || "");
  if (/^\s*(?:LAP|VGA|MOTHERBOARD|PC)?\s*ASUS\b/i.test(title)) return "ASUS";
  if (/^\s*LAP\s+ALIENN?WARE\b/i.test(title)) return "Alienware";
  if (/^\s*LAP\s+DELL\b/i.test(title)) return "Dell";
  if (/^\s*LAP\s+HP\b/i.test(title)) return "HP";
  if (/^\s*LAP\s+LENOVO\b/i.test(title)) return "Lenovo";
  if (/^\s*LAP\s+MSI\b/i.test(title)) return "MSI";
  return product.brands?.name || "";
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function productCodeCandidates(product) {
  const brand = productBrandName(product);
  const title = cleanTitle(product.title).replace(new RegExp(`\\b${escapeRegExp(brand)}\\b`, "ig"), " ");
  const candidates = new Set();
  const patterns = [
    /\b[A-Z]{1,5}\d{2,5}[A-Z0-9/-]{0,12}\b/g,
    /\b[A-Z0-9]{2,8}-[A-Z0-9/-]{2,16}\b/g,
    /\b[A-Z]{1,4}\d{1,4}[A-Z]{1,4}\b/g,
    /\b\d{2,5}[A-Z]{1,4}\b/g,
  ];
  patterns.forEach((pattern) => {
    [...title.toUpperCase().matchAll(pattern)].forEach((match) => {
      const code = match[0].replace(/^[/-]+|[/-]+$/g, "");
      if (code.length >= 3 && !/^(DDR|RTX|GTX|SSD|HDD|CPU|RAM|VGA)$/.test(code)) {
        candidates.add(code);
      }
    });
  });
  return [...candidates].slice(0, 8);
}

function uniqueList(values) {
  return values
    .map((value) => String(value || "").replace(/[®™]/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((value, index, list) => list.findIndex((item) => item.toLowerCase() === value.toLowerCase()) === index);
}

function canonicalSearchTerms(product) {
  const brand = String(productBrandName(product) || "").trim();
  const title = cleanTitle(product.title);
  const upper = title.toUpperCase();
  const type = String(product.type || "").toLowerCase();
  const terms = [];
  const add = (...parts) => {
    terms.push(parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim());
  };

  if (type === "printer") {
    const lj = upper.match(/\b(?:LJ|LASERJET)[\s-]*([A-Z]?\d{3,5}[A-Z]*)\b/)?.[1];
    const tank = upper.match(/\b(?:INKTANK|INK\s*TANK|SMART\s+W\/L\s+INKTANK|SMART\s+TANK)[\s-]*([A-Z0-9-]+)\b/)?.[1];
    if (lj) add("HP LaserJet", lj.toLowerCase());
    if (tank) add("HP Smart Tank", tank.toLowerCase());
  } else if (type === "laptop") {
    const laptopCodes = [
      upper.match(/\b([A-Z]{1,4}\d{3,4}[A-Z]{0,3}-[A-Z0-9]{2,8})\b/)?.[1],
      upper.match(/\b([A-Z]{1,4}\d{3,4}[A-Z]{0,3})\b/)?.[1],
      upper.match(/\b(LATITUDE\s+\d{4})\b/)?.[1],
      upper.match(/\b(VOSTRO\s+\d{4})\b/)?.[1],
      upper.match(/\b(PROBOOK\s+\d{3}\s+G\d{1,2})\b/)?.[1],
      upper.match(/\b(VICTUS\s+[A-Z0-9-]+)\b/)?.[1],
      upper.match(/\b(LOQ)\b/)?.[1],
      upper.match(/\b(LEGION\s+(?:PRO\s+)?[57])\b/)?.[1],
      upper.match(/\b(THINKPAD\s+E\d{2}\s+G\d)\b/)?.[1],
      upper.match(/\b(CYBORG\s+15\s+[A-Z0-9]+)\b/)?.[1],
      upper.match(/\b(PC\d{5})\b/)?.[1],
      upper.match(/\b(PB\d{5})\b/)?.[1],
      upper.match(/\b(16[- ]AC\d{5})\b/)?.[1],
      upper.match(/\b(16X[- ]AC\d{5})\b/)?.[1],
    ].filter(Boolean);
    laptopCodes.forEach((code) => add(brand, code));
  } else if (type === "motherboard") {
    const rawModel = title
      .replace(/^MOTHERBOARD[\/\s-]*/i, "")
      .replace(/^ASUS[\/\s-]*/i, "")
      .replace(/\bAMD\b/gi, "")
      .replace(/\bATX\b|\bAM5\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (rawModel) add("ASUS", rawModel);
  } else if (type === "monitor") {
    const model =
      upper.match(/\bMODEL\s*NO\.?\s*([A-Z0-9-]+)\b/)?.[1] ||
      upper.match(/\b(LS\d{2}[A-Z0-9]+)\b/)?.[1] ||
      upper.match(/\b(S\d{2}[A-Z0-9]+)\b/)?.[1] ||
      upper.match(/\b(P\d{2}[A-Z0-9]+)\b/)?.[1] ||
      upper.match(/\b(E\d{4}[A-Z]+)\b/)?.[1] ||
      upper.match(/\b(SE\d{4}[A-Z]+)\b/)?.[1];
    if (model) add(brand, model);
  } else if (type === "cpu") {
    const cpu =
      title.match(/\bRyzen\s+[3579]\s+\d{4}[A-Z0-9]*\b/i)?.[0] ||
      title.match(/\bCore\s*i[3579][-\s]?\d{4,5}[A-Z]*\b/i)?.[0] ||
      title.match(/\bi[3579][-\s]?\d{4,5}[A-Z]*\b/i)?.[0] ||
      title.match(/\bCore\s*Ultra\s*[579][-\s]?\d{3}[A-Z]*\b/i)?.[0];
    if (cpu) add(brand, cpu.replace(/^i/i, "Core i"));
  } else if (type === "storage") {
    const model =
      upper.match(/\b(RE100|SA100|E100|P510|P310|P3|T705|BX500|X9|NV3|XS1000|XS2000|LXD20K\d+TG8|NQ700|NM610\s*PRO|NM610|NQ780|NS100|NQ100|SN5000)\b/)?.[1] ||
      upper.match(/\b(T300S|WAVE\s*S|ELITE)\b/)?.[1];
    const capacity = title.match(/\b(\d+(?:\.\d+)?\s?TB|\d{3,4}\s?GB|\d+\s?TGB|\d+\s?T)\b/i)?.[1];
    if (model) add(brand, model, capacity);
  } else if (type === "ram") {
    const capacity = title.match(/\b(\d{1,3})\s?G(?:B)?\b/i)?.[1];
    const speed = title.match(/\b(DDR[345])\b/i)?.[1] || title.match(/\b(\d{4,5})\b/)?.[1];
    if (capacity || speed) add(brand, capacity ? `${capacity}GB` : "", speed);
  } else if (type === "gpu") {
    const family = upper.match(/\b(DUAL|PRIME|TUF|ROG\s+STRIX|PHOENIX)\b/)?.[1];
    const chip = upper.match(/\b(RTX\s*\d{4}\s*TI|RTX\s*\d{4}|RX\s*\d{4}\s*XT|GTX\s*\d{4})\b/)?.[1];
    const memory = title.match(/\b(\d{1,2}\s?GB)\b/i)?.[1];
    if (chip) add(brand, family, chip, memory);
  }

  add(normalizedSearchModel(product));
  add(brand, title);
  return uniqueList(terms).slice(0, 6);
}

function normalizedSearchModel(product) {
  const title = cleanTitle(product.title);
  const brand = productBrandName(product);
  const type = String(product.type || "").toLowerCase();
  const withoutPrefixes = title
    .replace(/\b(LAP|VGA|RAM|PC|CPU|POWER SUPPLAY|POWER SUPPLY|SSD Storage|LED Monitors?)\b/gi, " ")
    .replace(/\b(Storage|Processor|Printer|Model No\.?)\b/gi, " ")
    .replace(/[™®]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const modelNo = withoutPrefixes.match(/\b(?:Model\s*No\.?\s*)?([A-Z]{1,5}\d{2,5}[A-Z0-9/-]{0,12})\b/i)?.[1];
  const codes = productCodeCandidates(product);
  const cpu =
    withoutPrefixes.match(/\b(?:AMD\s*)?Ryzen\s*[3579]\s*\d{4}[A-Z0-9]*\b/i)?.[0] ||
    withoutPrefixes.match(/\b(?:Intel\s*)?(?:Core\s*)?i[3579][-\s]?\d{4,5}[A-Z]*\b/i)?.[0] ||
    withoutPrefixes.match(/\b(?:Intel\s*)?Core\s*Ultra\s*[579][-\s]?\d{3}[A-Z]*\b/i)?.[0];
  const gpu =
    withoutPrefixes.match(/\b(?:GeForce\s*)?RTX\s*\d{4}(?:\s*(?:Ti|Super))?\b/i)?.[0] ||
    withoutPrefixes.match(/\b(?:GeForce\s*)?GTX\s*\d{4}\b/i)?.[0] ||
    withoutPrefixes.match(/\bRadeon\s+[A-Z0-9\s-]{3,20}\b/i)?.[0];
  const storageModel =
    withoutPrefixes.match(/\b(BX500|P310|P510|P3|T705|X9|NV3|XS1000|XS2000|SN5000|RE100|SA100)\b/i)?.[0] ||
    codes[0];

  if (type === "cpu" && cpu) return `${brand} ${cpu}`.trim();
  if (type === "gpu" && gpu) return `${brand} ${withoutPrefixes.match(/\b(Dual|TUF|ROG|Ventus|Gaming|Eagle|Windforce|Phoenix)\b/i)?.[0] || ""} ${gpu}`.trim();
  if (type === "monitor" && (modelNo || codes[0])) return `${brand} ${modelNo || codes[0]}`.trim();
  if (type === "storage" && storageModel) return `${brand} ${storageModel} ${withoutPrefixes.match(/\b\d+(?:\.\d+)?\s?(?:TB|GB)\b/i)?.[0] || ""}`.trim();
  if (type === "laptop" && codes[0]) return `${brand} ${codes[0]}`.trim();
  if (modelNo || codes[0]) return `${brand} ${modelNo || codes[0]}`.trim();
  return `${brand} ${withoutPrefixes}`.trim();
}

function normalizeToken(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[™®]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function productIdentityTokens(product) {
  const brand = normalizeToken(productBrandName(product));
  const model = normalizeToken(normalizedSearchModel(product));
  const codes = productCodeCandidates(product).map(normalizeToken).filter(Boolean);
  return {
    brand,
    model,
    codes,
    modelParts: model.split(/\s+/).filter((part) => part.length >= 3),
  };
}

function sourceLooksRelevant(product, sourceText = "", url = "") {
  const { brand, codes, modelParts } = productIdentityTokens(product);
  const haystack = normalizeToken(`${url} ${sourceText}`);
  if (brand && !haystack.includes(brand)) return false;
  if (codes.some((code) => code && haystack.includes(code))) return true;
  const hits = modelParts.filter((part) => haystack.includes(part)).length;
  return hits >= Math.min(2, modelParts.length);
}

function resultPriority(result) {
  const url = result.url || "";
  if (/\/support\/|\/download|driver|manual|youtube|facebook|instagram|pinterest|reddit/i.test(url)) {
    return -20;
  }
  if (/asus\.com|dell\.com|hp\.com|lenovo\.com|msi\.com|gigabyte\.com|zotac\.com|pny\.com|amd\.com|intel\.com|crucial\.com|kingston\.com|lexar\.com|wd\.com|westerndigital\.com|samsung\.com|canon\.com|epson\.com|brother/i.test(url)) {
    return 30;
  }
  if (/icecat\.biz|productindetail|displayspecifications|nanoreview|notebookcheck|versus|gsmarena|techpowerup/i.test(url)) {
    return 20;
  }
  if (/amazon|noon|jumia|ebay|walmart|bestbuy|newegg/i.test(url)) {
    return 5;
  }
  return 0;
}

function extractResultLinks(html = "") {
  const links = [];
  const decodeHref = (input = "") => {
    let href = input.replace(/&amp;/g, "&");
    try {
      const parsed = href.startsWith("//") ? new URL(`https:${href}`) : new URL(href);
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) href = decodeURIComponent(uddg);
    } catch {
      // Keep raw href if URL decoding fails.
    }
    return href;
  };
  const linkPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [...html.matchAll(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)].map((match) =>
    htmlToText(match[1])
  );
  [...html.matchAll(linkPattern)].forEach((match, index) => {
    links.push({
      url: decodeHref(match[1]),
      title: htmlToText(match[2]),
      snippet: snippets[index] || "",
    });
  });
  const litePattern =
    /<a[^>]+href="([^"]+)"[^>]+class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>[\s\S]*?<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;
  const liteMatches = [...html.matchAll(litePattern)];
  liteMatches.forEach((match) => {
    links.push({ url: decodeHref(match[1]), title: htmlToText(match[2]), snippet: htmlToText(match[3]) });
  });
  if (!liteMatches.length) {
    const liteLinks = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]+class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi)];
    const liteSnippets = [...html.matchAll(/<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi)];
    liteLinks.forEach((match, index) => {
      links.push({
        url: decodeHref(match[1]),
        title: htmlToText(match[2]),
        snippet: htmlToText(liteSnippets[index]?.[1] || ""),
      });
    });
  }
  return links;
}

function htmlToText(value = "") {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeIcecatProductUrl(value = "") {
  let decoded = String(value || "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the original URL if a search result contains malformed escapes.
  }
  decoded = decodeHtmlEntities(decoded);
  if (!decoded) return "";
  if (decoded.startsWith("//")) return `https:${decoded}`;
  if (decoded.startsWith("/")) return `https://icecat.biz${decoded}`;
  return decoded;
}

function pushIcecatResult(results, value, title = "") {
  const url = normalizeIcecatProductUrl(value);
  const id = extractIcecatIdFromUrl(url || value);
  if (!id || results.some((result) => result.id === id)) return false;
  results.push({ id, url, title: htmlToText(title) });
  return true;
}

async function searchIcecatResults(product, { quick = false } = {}) {
  const directQueries = canonicalSearchTerms(product);
  for (const query of directQueries) {
    const directResults = await searchIcecatSiteResults(query);
    if (directResults.length) return directResults;
    if (quick) break;
  }

  const queries = [
    ...canonicalSearchTerms(product).map((term) => `site:icecat.biz/en/p ${term}`),
    ...canonicalSearchTerms(product).map((term) => `${term} Icecat`),
  ]
    .map((query) => query.replace(/\s+/g, " ").trim())
    .filter((query, index, list) => query && list.indexOf(query) === index);
  if (quick) queries.splice(1);
  const results = [];

  for (const query of queries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), quick ? 5000 : 12000);
    let html = "";
    try {
      const response = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        },
      });
      if (!response.ok) continue;
      html = await response.text();
    } catch {
      continue;
    } finally {
      clearTimeout(timer);
    }

    const icecatLinks = extractResultLinks(html).filter((result) =>
      /https?:\/\/(?:www\.)?icecat\.biz\/en\/p\//i.test(result.url)
    );
    for (const result of icecatLinks) {
      pushIcecatResult(results, result.url, result.title);
      if (results.length >= 5) return results;
    }

    const patterns = [
      /icecat[_-]id[=/:%3D-]*(\d{4,})/gi,
      /-(\d{5,})\.html/gi,
      /%2D(\d{5,})\.html/gi,
    ];
    patterns.forEach((pattern) => {
      [...html.matchAll(pattern)].forEach((match) => {
        if (!results.some((result) => result.id === match[1])) {
          results.push({ id: match[1], url: "", title: "" });
        }
      });
    });
    if (results.length) return results.slice(0, 5);
  }
  return results.slice(0, 5);
}

async function searchIcecatIds(product, options = {}) {
  return (await searchIcecatResults(product, options)).map((result) => result.id);
}

async function searchIcecatSiteResults(query) {
  const url = `https://icecat.biz/en/search?keyword=${encodeURIComponent(query)}&userclick=true`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        referer: "https://icecat.biz/en/search?keyword=&userclick=true",
      },
    });
    if (!response.ok) return [];
    const html = await response.text();
    const results = [];
    const productLinks = [
      ...html.matchAll(/<a[^>]+href=["']([^"']*\/en\/p\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),
      ...html.matchAll(/<a[^>]+href=["']([^"']*\/p\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),
    ];
    for (const match of productLinks) {
      pushIcecatResult(results, match[1], match[2]);
      if (results.length >= 5) break;
    }
    if (!results.length) {
      [...html.matchAll(/-(\d{5,})\.html/gi)].forEach((match) => {
        if (!results.some((result) => result.id === match[1])) {
          results.push({ id: match[1], url: "", title: "" });
        }
      });
    }
    return results.slice(0, 5);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function extractIcecatIdFromUrl(url = "") {
  let decoded = String(url || "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the original URL if a search result contains malformed escapes.
  }
  return decoded.match(/-(\d{5,})\.html/i)?.[1] || "";
}

function icecatCategoryFromUrl(url = "") {
  let decoded = String(url || "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the original URL if a search result contains malformed escapes.
  }
  decoded = decodeHtmlEntities(decoded);
  const match = decoded.match(/\/p\/[^/]+\/[^/]+\/([^/]+)-/i);
  return match ? match[1].replace(/\+/g, " ").replace(/\s+/g, " ").trim() : "";
}

function icecatProductCodeFromUrl(url = "") {
  let decoded = String(url || "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the original URL if a search result contains malformed escapes.
  }
  decoded = decodeHtmlEntities(decoded);
  const match = decoded.match(/\/p\/[^/]+\/([^/]+)\//i);
  return match ? match[1].replace(/\+/g, " ").trim() : "";
}

function tidyIcecatTitle(value = "") {
  return String(value || "")
    .replace(/^Specs\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchIcecatPageSpecs(product, result, apiError = "") {
  if (!result?.url) return null;
  const page = await fetchPageText(result.url);
  const title = tidyIcecatTitle(page.title || result.title || "");
  const visibleSpecs = extractVisibleKeyValueSpecs(page.html || "");
  const categorySpecs = extractCategorySpecs(product, `${title}. ${page.text || ""}`);
  const specs = { ...visibleSpecs, ...categorySpecs };
  if (!Object.keys(specs).length && title) {
    const titleSpecs = extractCategorySpecs(product, title);
    Object.assign(specs, titleSpecs);
  }
  if (!Object.keys(specs).length && !title) return null;

  return {
    id: String(result.id || ""),
    lang: DEFAULT_LANG,
    shopname: process.env.ICECAT_SHOPNAME || process.env.ICECAT_USERNAME || "openIcecat-live",
    title,
    brand: productBrandName(product),
    category: icecatCategoryFromUrl(result.url),
    productCode: icecatProductCodeFromUrl(result.url),
    summary: "",
    sourceUrl: result.url,
    source: "icecat-product-page",
    apiError,
    syncedAt: new Date().toISOString(),
    specs,
  };
}

async function searchWebSpecs(product) {
  if (["accessory", "other"].includes(String(product.type || "").toLowerCase())) {
    return null;
  }

  const directSpecs = await searchDirectSourceSpecs(product);
  if (directSpecs) return directSpecs;

  const model = normalizedSearchModel(product);
  const canonicalTerms = canonicalSearchTerms(product);
  const queries = [
    ...canonicalTerms.map((term) => `${term} official specifications`),
    ...canonicalTerms.map((term) => `${term} specs`),
    `${model} ${product.type || ""} specifications`,
    `${model} manufacturer specifications`,
  ]
    .map((query) => query.replace(/\s+/g, " ").trim())
    .filter((query, index, list) => query && list.indexOf(query) === index);

  for (const query of queries) {
    if (webSpecCache.has(query)) {
      const cached = webSpecCache.get(query);
      if (cached) return { ...cached, syncedAt: new Date().toISOString() };
      continue;
    }
    const webSpecs = await searchWebSpecsForQuery(product, query);
    if (webSpecs) {
      webSpecCache.set(query, webSpecs);
      return webSpecs;
    }
    await sleep(150);
  }
  return null;
}

async function searchDirectSourceSpecs(product) {
  const candidates = directSourceCandidates(product);
  for (const candidate of candidates) {
    const page = await fetchPageText(candidate.url);
    const sourceText = `${candidate.title}. ${page.text}`;
    const structuredAsusLaptop =
      candidate.extract === "asus-laptop-column" || candidate.extract === "asus-rog-laptop-column";
    if (!page.text || (!structuredAsusLaptop && !sourceLooksRelevant(product, sourceText, candidate.url))) {
      await sleep(120);
      continue;
    }
    const specs =
      candidate.extract === "asus-laptop-column"
        ? extractAsusLaptopColumnSpecs(product, page.html || "", candidate.url)
        : candidate.extract === "asus-rog-laptop-column"
        ? extractAsusRogLaptopColumnSpecs(product, page.html || "", candidate.url)
        : extractCategorySpecs(product, sourceText);
    if (Object.keys(specs).length >= 2) {
      return {
        source: "web-search",
        query: "direct-source",
        syncedAt: new Date().toISOString(),
        specs,
        sources: [{ title: candidate.title, url: candidate.url }],
      };
    }
    await sleep(120);
  }
  return null;
}

function directSourceCandidates(product) {
  const type = String(product.type || "").toLowerCase();
  const brand = normalizeToken(productBrandName(product));
  if (brand === "asus" && type === "gpu") return asusGpuSourceCandidates(product);
  if (brand === "asus" && type === "laptop") return asusLaptopSourceCandidates(product);
  if (brand === "asus" && type === "motherboard") return asusMotherboardSourceCandidates(product);
  if (brand === "amd" && type === "cpu") return amdCpuSourceCandidates(product);
  if (brand === "crucial" && type === "storage") return crucialStorageSourceCandidates(product);
  return [];
}

function crucialStorageSourceCandidates(product) {
  const title = normalizeToken(product.title);
  const capacityMatch = title.match(/\b(\d+(?:\.\d+)?)\s*(tb|tgb|gb)\b/);
  const seriesMatch = title.match(/\b(p510|p310|p3|t705|e100|bx500|x9)\b/);
  if (!capacityMatch || !seriesMatch) return [];
  const amount = Number(capacityMatch[1]);
  const unit = capacityMatch[2];
  const gb = unit === "gb" ? amount : amount * 1000;
  const series = seriesMatch[1].toLowerCase();
  const codePrefix = String(Math.round(gb)).padStart(4, "0");
  const candidates = [];
  const add = (urlSeries, code, labelSeries = series.toUpperCase()) => {
    candidates.push({
      title: `Crucial ${labelSeries} ${capacityMatch[1]}${unit.toUpperCase().replace("TGB", "TB")} specifications`,
      url: `https://www.crucial.com/ssd/${urlSeries}/${code}`,
    });
  };

  if (series === "p510") add("p510", `CT${codePrefix}P510SSD8`);
  if (series === "p310") add("p310", `CT${codePrefix}P310SSD8`);
  if (series === "p3") add("p3", `CT${codePrefix}P3SSD8`);
  if (series === "t705") add("t705", `CT${codePrefix}T705SSD3`);
  if (series === "bx500") add("bx500", `CT${codePrefix}BX500SSD1`);
  if (series === "x9") add("x9", `CT${codePrefix}X9SSD9`, "X9");
  if (series === "e100") {
    add("e100", `CT${codePrefix}E100SSD8`);
    add("e100", `CT${codePrefix}E100SSD9`);
  }
  return candidates;
}

function asusLaptopModel(product) {
  const title = normalizeToken(product.title).toUpperCase();
  const tufShort = title.match(/\bTUF\s+(\d{3}[A-Z]{2,4})(?:-[A-Z0-9]+)?\b/)?.[1];
  if (tufShort) return `FX${tufShort}`;
  const model =
    title.match(/\b((?:FX|FA|G|N|S|V|X)\d{3,4}[A-Z]{0,4})(?:-[A-Z0-9]+)?\b/)?.[1] ||
    title.match(/\b([A-Z]{1,3}\d{3,4}[A-Z]{0,4})(?:-[A-Z0-9]+)?\b/)?.[1];
  if (model) return model;
  return "";
}

function asusLaptopSourceCandidates(product) {
  const model = asusLaptopModel(product);
  if (!model) return [];
  const sources = {
    FX607: ["laptops/for-gaming/tuf-gaming/asus-tuf-gaming-f16-2024"],
    FA506: ["laptops/for-gaming/tuf-gaming/asus-tuf-gaming-a15"],
    FA401: [
      "laptops/for-gaming/tuf-gaming/asus-tuf-gaming-a14-2025",
      "laptops/for-gaming/tuf-gaming/asus-tuf-gaming-a14-2024",
    ],
    FX608: ["laptops/for-gaming/tuf-gaming/asus-tuf-gaming-f16-2025"],
    G614: [
      "https://rog.asus.com/laptops/rog-strix/rog-strix-g16-2025-g614/spec/",
      "https://rog.asus.com/laptops/rog-strix/rog-strix-g16-2024/spec/",
      "laptops/for-gaming/rog-republic-of-gamers/rog-strix-g16-2025",
      "laptops/for-gaming/rog-republic-of-gamers/rog-strix-g16-2024",
    ],
    G615: [
      "https://rog.asus.com/laptops/rog-strix/rog-strix-g16-2025/spec/",
      "laptops/for-gaming/rog-republic-of-gamers/rog-strix-g16-2025",
    ],
    G635: [
      "https://rog.asus.com/laptops/rog-strix/rog-strix-scar-16-2025/spec/",
      "laptops/for-gaming/rog-republic-of-gamers/rog-strix-scar-16-2025",
    ],
    G835: [
      "https://rog.asus.com/laptops/rog-strix/rog-strix-scar-18-2025/spec/",
      "laptops/for-gaming/rog-republic-of-gamers/rog-strix-scar-18-2025",
    ],
    N650: ["laptops/for-creators/vivobook/asus-vivobook-pro-15-oled-n6506"],
    S340: ["laptops/for-home/vivobook/asus-vivobook-s14-s3407"],
    S360: ["laptops/for-home/vivobook/asus-vivobook-s16-s3607"],
    V360: ["laptops/for-home/vivobook/asus-v16-v3607"],
    X1607Q: ["laptops/for-home/vivobook/asus-vivobook-16-x1607q"],
    X160: ["laptops/for-home/vivobook/asus-vivobook-16-x1607"],
  };
  const sourceKey = Object.keys(sources)
    .sort((a, b) => b.length - a.length)
    .find((key) => model.startsWith(key));
  const slugs = sourceKey ? sources[sourceKey] : [];
  return slugs.map((slug) => {
    const url = /^https?:\/\//i.test(slug) ? slug : `https://www.asus.com/${slug}/techspec/`;
    return {
      title: `ASUS ${model} official tech specs`,
      url,
      extract: url.includes("rog.asus.com") ? "asus-rog-laptop-column" : "asus-laptop-column",
    };
  });
}

function extractAsusLaptopColumnSpecs(product, html = "", sourceUrl = "") {
  const model = asusLaptopModel(product);
  if (!model) return {};
  const modelMatches = [
    ...html.matchAll(/<div class="pdName">\s*([\s\S]*?)\s*<\/div>/gi),
    ...html.matchAll(/<div class="TechSpec__itemName__[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/div>/gi),
  ]
    .map((match) => htmlToText(match[1]).toUpperCase())
    .filter(Boolean);
  const models = modelMatches.filter(
    (item, index, list) => list.indexOf(item) === index
  );
  let columnIndex = models.findIndex((item) => item === model);
  if (columnIndex < 0) columnIndex = models.findIndex((item) => item.startsWith(`${model}-`));
  if (columnIndex < 0) return {};

  const specs = { Model: model };
  const rows = [
    ...html.matchAll(
      /<div class="TechSpec__rowTable__1LR9D[\s\S]*?(?=<div class="TechSpec__rowTable__1LR9D|<\/section>)/gi
    ),
  ].map((match) => match[0]);
  for (const row of rows) {
    const label = htmlToText(row.match(/<div class="rowTableTitle">\s*([\s\S]*?)<\/div>/i)?.[1] || "");
    if (!label || label.toLowerCase() === "model") continue;
    const cells = [...row.matchAll(/<div class="TechSpec__rowTableItems__KYWXp[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)]
      .map((match) =>
        htmlToText(match[1])
          .replace(/\s*,\s*/g, ", ")
          .replace(/\s+/g, " ")
          .trim()
      )
      .filter((value, index) => value || index <= columnIndex);
    const value = cells[columnIndex];
    if (value) addSpec(specs, label, value);
  }

  if (sourceUrl) addSpec(specs, "Official source", sourceUrl);
  return specs;
}

function extractAsusRogLaptopColumnSpecs(product, html = "", sourceUrl = "") {
  const model = asusLaptopModel(product);
  if (!model) return {};
  const target = model.toUpperCase();
  const skuMatches = [...html.matchAll(/<div class="ProductSpec__specProductNameWrapper__[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)]
    .map((match) =>
      [...match[1].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
        .map((item) => htmlToText(item[1]).toUpperCase())
        .filter(Boolean)
        .find((value) => /^[A-Z]{1,4}\d{3,4}[A-Z0-9-]+$/.test(value))
    )
    .filter(Boolean);
  const skus = skuMatches.filter((item, index, list) => list.indexOf(item) === index);
  let columnIndex = skus.findIndex((item) => item === target || item.startsWith(`${target}-`));
  if (columnIndex < 0) columnIndex = skus.findIndex((item) => item.startsWith(target));
  if (columnIndex < 0) return {};

  const specs = { Model: target, "Matched official SKU": skus[columnIndex] };
  const rowPattern = /<div class="ProductSpec__row__[^"]*ProductSpec__productSpecList__[^"]*"[^>]*>/gi;
  const starts = [...html.matchAll(rowPattern)].map((match) => match.index);
  for (let i = 0; i < starts.length; i += 1) {
    const row = html.slice(starts[i], starts[i + 1] || html.length);
    const label = htmlToText(row.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1] || "");
    if (!label) continue;
    const chunks = row
      .split(/<div role="group" aria-label="\d+\s+of\s+\d+" class="ProductSpec__rowItem__[^"]*"[^>]*>/i)
      .slice(1);
    const cells = chunks
      .map((chunk) =>
        htmlToText(chunk)
          .replace(/\bComing Soon\b/gi, "")
          .replace(/\s+/g, " ")
          .trim()
      )
      .map((value) => value.replace(/\s*(?:Learn more|Buy|Where to buy).*$/i, "").trim());
    const value = cells[columnIndex];
    if (value) addSpec(specs, label, value);
  }

  if (sourceUrl) addSpec(specs, "Official source", sourceUrl);
  return specs;
}

function amdCpuSourceCandidates(product) {
  const title = normalizeToken(product.title);
  const match = title.match(/\bryzen\s+([3579])\s+(\d{4}[a-z0-9]*)\b/);
  if (!match) return [];
  const family = match[1];
  const model = match[2];
  const series = `${model[0]}000-series`;
  const slug = `amd-ryzen-${family}-${model}`;
  const bases = [
    "desktops/ryzen",
    "laptop/ryzen",
  ];
  return bases.map((base) => ({
    title: `AMD Ryzen ${family} ${model} specifications`,
    url: `https://www.amd.com/en/products/processors/${base}/${series}/${slug}.html`,
  }));
}

function asusGpuSourceCandidates(product) {
  const title = normalizeToken(product.title);
  const chipMatch =
    title.match(/\brtx\s*(\d{4})\s*(ti)?\b/) ||
    title.match(/\bgeforce\s+rtx\s*(\d{4})\s*(ti)?\b/) ||
    title.match(/\brx\s*(\d{4})\s*(xt)?\b/);
  if (!chipMatch) return [];
  const isRadeon = /\bradeon\b|\brx\s*\d{4}/.test(title);
  const chip = isRadeon
    ? `rx${chipMatch[1]}${chipMatch[2] ? "xt" : ""}`
    : `rtx${chipMatch[1]}${chipMatch[2] ? "ti" : ""}`;
  const memory = title.match(/\b(\d{1,2})\s*gb\b/)?.[1] || "";
  const family = title.includes("tuf")
    ? "tuf-gaming"
    : title.includes("prime")
    ? "prime"
    : title.includes("rog") || title.includes("strix")
    ? "rog-strix"
    : title.includes("phoenix")
    ? "phoenix"
    : "dual";
  const slugBase = family === "tuf-gaming" ? "tuf" : family;
  const memoryParts = memory ? [`o${memory}g`, `${memory}g`] : [""];
  const suffixes = ["", "-gaming", "-white", "-white-oc-edition"];
  const slugs = new Set();
  memoryParts.forEach((mem) => {
    const core = [slugBase, chip, mem].filter(Boolean).join("-");
    slugs.add(core);
    suffixes.forEach((suffix) => slugs.add(`${core}${suffix}`));
  });
  return [...slugs].map((slug) => ({
    title: `ASUS ${slug} tech specs`,
    url: `https://www.asus.com/motherboards-components/graphics-cards/${family}/${slug}/techspec/`,
  }));
}

function asusMotherboardSourceCandidates(product) {
  const raw = String(product.title || "")
    .replace(/^MOTHERBOARD\s+/i, "")
    .replace(/^ASUS\s+/i, "")
    .trim();
  const model = raw
    .replace(/\s+-\s+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .replace(/-+/g, "-")
    .toLowerCase();
  if (!model) return [];
  const families = [];
  if (model.startsWith("prime-")) families.push("prime");
  if (model.startsWith("tuf-gaming-")) families.push("tuf-gaming");
  if (model.startsWith("rog-") || model.includes("strix")) families.push("rog-strix");
  families.push("others", "prime", "tuf-gaming");
  return [...new Set(families)].map((family) => ({
    title: `ASUS ${model} tech specs`,
    url: `https://www.asus.com/motherboards-components/motherboards/${family}/${model}/techspec/`,
  }));
}

async function searchWebSpecsForQuery(product, query) {
  let html = "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      },
    });
    if (!response.ok) return null;
    html = await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  const results = extractResultLinks(html)
    .filter((result) => !/youtube|facebook|instagram|pinterest|reddit/i.test(result.url))
    .map((result) => ({
      ...result,
      priority: resultPriority(result),
    }))
    .filter((result) => result.priority > -20)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 8);
  const sources = [];
  for (const result of results.slice(0, 6)) {
    const page = await fetchPageText(result.url);
    const sourceText = `${result.title}. ${result.snippet}. ${page.text}`;
    if (page.text && sourceLooksRelevant(product, sourceText, result.url)) {
      sources.push({
        title: result.title,
        url: result.url,
        text: sourceText,
      });
    }
    await sleep(150);
  }
  const aggregate = [
    ...results.map((result) => `${result.title}. ${result.snippet}`),
    ...sources.map((source) => source.text),
  ].join("\n");
  const specs = extractCategorySpecs(product, aggregate);
  if (Object.keys(specs).length < 2 || !sources.length) {
    return null;
  }
  return {
    source: "web-search",
    query,
    syncedAt: new Date().toISOString(),
    specs,
    sources: sources.slice(0, 4).map(({ title, url }) => ({ title, url })),
  };
}

async function fetchPageText(url) {
  if (!/^https?:\/\//i.test(url)) return { text: "" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.includes("text/html")) return { text: "" };
    const html = await response.text();
    return {
      html,
      text: pageTextFromHtml(html).slice(0, 45000),
      title: extractHtmlTitle(html),
    };
  } catch {
    return { text: "" };
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function extractHtmlTitle(html = "") {
  return htmlToText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
}

function pageTextFromHtml(html = "") {
  const meta = [...html.matchAll(/<meta[^>]+(?:name|property)=["'](?:description|og:title|og:description|twitter:title|twitter:description)["'][^>]+content=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1])
    .join(". ");
  const rows = [...html.matchAll(/<tr[\s\S]*?<\/tr>/gi)]
    .map((row) =>
      [...row[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((cell) => htmlToText(cell[1]))
        .filter(Boolean)
        .join(": ")
    )
    .filter(Boolean)
    .join(". ");
  const dts = [...html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)]
    .map((match) => `${htmlToText(match[1])}: ${htmlToText(match[2])}`)
    .join(". ");
  const stripped = htmlToText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .slice(0, 220000)
  );
  return `${meta}. ${rows}. ${dts}. ${stripped}`;
}

function addVisibleSpec(specs, label, value) {
  const cleanLabel = htmlToText(label).replace(/\s+/g, " ").trim().replace(/:$/, "");
  const cleanValue = htmlToText(value).replace(/\s+/g, " ").trim();
  if (
    cleanLabel &&
    cleanValue &&
    cleanLabel.length <= 80 &&
    cleanValue.length <= 240 &&
    !specs[cleanLabel]
  ) {
    specs[cleanLabel] = cleanValue;
  }
}

function extractVisibleKeyValueSpecs(html = "") {
  const specs = {};
  [...html.matchAll(/<tr[\s\S]*?<\/tr>/gi)].forEach((row) => {
    const cells = [...row[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((cell) => htmlToText(cell[1]))
      .filter(Boolean);
    if (cells.length >= 2) addVisibleSpec(specs, cells[0], cells.slice(1).join(" "));
  });
  [...html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)].forEach(
    (match) => addVisibleSpec(specs, match[1], match[2])
  );
  return specs;
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return (match[1] || match[0]).replace(/\s+/g, " ").trim();
  }
  return "";
}

function addSpec(specs, label, value) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (clean && !specs[label]) specs[label] = clean;
}

function extractCategorySpecs(product, text) {
  const specs = {};
  const raw = String(text || "").replace(/[™®]/g, "").replace(/\s+/g, " ");
  const type = String(product.type || "").toLowerCase();
  const cpu = firstMatch(raw, [
    /\b((?:AMD\s*)?Ryzen\s*[3579]\s*\d{4}[A-Z0-9]*)\b/i,
    /\b((?:Intel\s*)?(?:Core\s*)?i[3579][-\s]?\d{4,5}[A-Z]*)\b/i,
    /\b((?:Intel\s*)?Core\s*Ultra\s*[579][-\s]?\d{3}[A-Z]*)\b/i,
    /\b(i[3579]\s+[0-9]{4,5}[A-Z])\b/i,
    /\b(\d{4,5}[A-Z])\b/i,
    /\b([CU]\s?[579]\s?\d{3}[A-Z]?)\b/i,
  ]);
  const gpu = firstMatch(raw, [
    /\b((?:NVIDIA\s+)?(?:GeForce\s*)?RTX\s*\d{4}(?:\s*(?:Ti|SUPER))?)\b/i,
    /\b((?:NVIDIA\s+)?(?:GeForce\s*)?GTX\s*\d{4})\b/i,
    /\b((?:AMD\s+)?Radeon\s+[A-Z0-9\s-]{3,22})\b/i,
    /\b(Intel\s+Arc\s+[A-Z0-9\s-]{2,16})\b/i,
    /\b(Intel\s+Iris(?:\s+Xe)?)\b/i,
  ]);
  const ram = firstMatch(raw, [
    /\b(\d{1,3}\s?GB)\s+(?:RAM|DDR[345]|memory)\b/i,
    /\b(\d{1,3}\s?G)(?:\/|-|\s)(?:\d+\s?(?:GB|TB)|RTX|SSD)/i,
    /\b(\d{1,3})(?=\/\d{3,4}\s?SSD\b)/i,
    /\b(\d{1,3})(?=\/\d{3,4}\b)/i,
  ]);
  const storage = firstMatch(raw, [
    /\b(\d+(?:\.\d+)?\s?TB|\d{3,4}\s?GB)\s+(?:SSD|HDD|NVMe|storage)\b/i,
    /\b(?:SSD|HDD|NVMe|storage)[\s:-]*(\d+(?:\.\d+)?\s?TB|\d{3,4}\s?GB)\b/i,
    /\b(\d+\s?T|\d{3,4}\s?G)(?=[\/\-\s](?:RTX|GTX|INTEL|W\s?11|DOS|SSD|HDD|NVMe))/i,
    /\b(\d{3,4})(?=\s?SSD\b)/i,
    /\/(\d{3,4})(?=\/|\s|")/i,
  ]);
  const displaySize = firstMatch(raw, [/\b(\d{2}(?:\.\d)?\s?(?:"|inch|in))\b/i]);
  const refresh = firstMatch(raw, [/\b(\d{2,3}\s?Hz)\b/i]);
  const resolution = firstMatch(raw, [/\b(\d{3,4}\s?[x×]\s?\d{3,4})\b/i, /\b(Full HD|FHD|QHD|UHD|4K)\b/i]);
  const capacity = firstMatch(raw, [/\b(\d+(?:\.\d+)?\s?TB|\d{3,4}\s?GB)\b/i]);
  const memoryType = firstMatch(raw, [/\b(GDDR[56X]+|DDR[345])\b/i]);
  const interfaceType = firstMatch(raw, [/\b(PCIe\s*(?:Gen\s*)?\d(?:\.\d)?|PCI Express\s*\d(?:\.\d)?|NVMe|SATA\s*(?:III|6Gb\/s)?|USB\s*3\.\d)\b/i]);
  const readSpeed = firstMatch(raw, [/\b(?:read speed|sequential read)[^\d]{0,20}(\d{3,5}\s?MB\/s)\b/i, /\b(\d{3,5}\s?MB\/s)\s+read\b/i]);
  const writeSpeed = firstMatch(raw, [/\b(?:write speed|sequential write)[^\d]{0,20}(\d{3,5}\s?MB\/s)\b/i, /\b(\d{3,5}\s?MB\/s)\s+write\b/i]);

  if (type === "laptop" || type === "desktop") {
    addSpec(specs, "Processor model", cpu);
    addSpec(specs, "Graphics adapter", gpu);
    addSpec(specs, "Internal memory", ram);
    addSpec(specs, "Total storage capacity", storage);
    addSpec(specs, "Display diagonal", displaySize);
    addSpec(specs, "Display resolution", resolution);
    addSpec(specs, "Operating system installed", /\bW(?:indows)?\s*11\b/i.test(raw) ? "Windows 11" : "");
  } else if (type === "gpu") {
    addSpec(specs, "Graphics processor", gpu);
    addSpec(specs, "Discrete graphics card memory", firstMatch(raw, [/\b(\d{1,2}\s?GB)\s+(?:GDDR|graphics|VRAM)/i]));
    addSpec(specs, "Graphics card memory type", memoryType);
    addSpec(specs, "Interface type", interfaceType);
    addSpec(specs, "CUDA", /\bCUDA\b/i.test(raw) ? "Yes" : "");
  } else if (type === "cpu") {
    addSpec(specs, "Processor model", cpu);
    addSpec(specs, "Processor cores", firstMatch(raw, [/\b(\d{1,2})\s?(?:cores?|C)\b/i, /\bCPU Cores\s*[: ]\s*(\d{1,2})\b/i]));
    addSpec(specs, "Processor threads", firstMatch(raw, [/\b(\d{1,2})\s?(?:threads?|T)\b/i, /\bThreads\s*[: ]\s*(\d{1,2})\b/i]));
    addSpec(specs, "Processor boost frequency", firstMatch(raw, [/\b(?:up to|max turbo|max\.?\s*boost|boost)[^\d]{0,30}(\d(?:\.\d+)?\s?GHz)\b/i]));
    addSpec(specs, "Processor base frequency", firstMatch(raw, [/\b(?:base clock|base frequency|processor base frequency)[^\d]{0,30}(\d(?:\.\d+)?\s?GHz)\b/i]));
    addSpec(specs, "Processor cache", firstMatch(raw, [/\b(\d{1,3}\s?MB)\s+(?:cache|L3)\b/i, /\bL3 Cache\s*[: ]\s*(\d{1,3}\s?MB)\b/i]));
    addSpec(specs, "Processor socket", firstMatch(raw, [/\b(AM[45]|LGA\s?\d{4})\b/i, /\bCPU Socket\s*[: ]\s*(AM[45]|LGA\s?\d{4})\b/i]));
    addSpec(specs, "TDP", firstMatch(raw, [/\b(?:default TDP|TDP|processor base power)[^\d]{0,30}(\d{1,3}\s?W)\b/i]));
  } else if (type === "storage") {
    addSpec(
      specs,
      "Capacity",
      capacity || firstMatch(raw, [/\b(\d+\s?TGB|\d+\s?T)\b/i])
    );
    addSpec(specs, "Interface", interfaceType);
    addSpec(specs, "Form factor", firstMatch(raw, [/\b(2\.5\s?inch|M\.2|portable|external)\b/i]));
    addSpec(specs, "Read speed", readSpeed);
    addSpec(specs, "Write speed", writeSpeed);
    addSpec(specs, "NVMe", /\bNVMe\b/i.test(raw) ? "Yes" : "");
  } else if (type === "monitor") {
    addSpec(specs, "Model", firstMatch(raw, [/\bModel\s*No\.?\s*([A-Z0-9-]+)\b/i]));
    addSpec(specs, "Display diagonal", displaySize);
    addSpec(specs, "Display resolution", resolution);
    addSpec(specs, "Maximum refresh rate", refresh);
    addSpec(specs, "Panel type", firstMatch(raw, [/\b(IPS|VA|TN|OLED)\b/i]));
    addSpec(specs, "Response time", firstMatch(raw, [/\b(\d+(?:\.\d+)?\s?ms)\b/i]));
  } else if (type === "printer") {
    addSpec(specs, "Model", firstMatch(raw, [/\b(?:LJ|LaserJet|INKTANK|Tank)[\s-]*([A-Z0-9-]+)\b/i]));
    addSpec(
      specs,
      "Print technology",
      firstMatch(raw, [/\b(LaserJet|Laser|Inkjet|Ink Tank)\b/i]) || (/\bLJ\b/i.test(raw) ? "LaserJet" : "")
    );
    addSpec(specs, "Colour", /\bcolor|colour\b/i.test(raw) ? "Colour" : /\bmono|monochrome\b/i.test(raw) ? "Monochrome" : "");
    addSpec(specs, "Print speed", firstMatch(raw, [/\b(\d{1,3}\s?ppm)\b/i]));
    addSpec(specs, "Duplex printing", /\bduplex\b/i.test(raw) ? "Yes" : "");
    addSpec(specs, "Wi-Fi", /\bWi-?Fi|wireless\b/i.test(raw) ? "Yes" : "");
  } else if (type === "motherboard") {
    addSpec(specs, "Processor socket", firstMatch(raw, [/\b(AM[45]|LGA\s?\d{4})\b/i]));
    addSpec(specs, "Motherboard chipset", firstMatch(raw, [/\b([ABHZ]\d{3}[A-Z]?|X\d{3}[A-Z]?)\b/i]));
    addSpec(specs, "Supported memory types", memoryType);
    addSpec(specs, "Form factor", firstMatch(raw, [/\b(ATX|Micro ATX|Mini ITX|mATX)\b/i]));
    addSpec(specs, "Wi-Fi", /\bWi-?Fi\b/i.test(raw) ? "Yes" : "");
  } else if (type === "ram") {
    addSpec(specs, "Internal memory", capacity || ram);
    addSpec(specs, "Internal memory type", memoryType);
    addSpec(specs, "Memory clock speed", firstMatch(raw, [/\b(\d{4,5}\s?MHz|DDR[345]-?\d{4,5})\b/i]));
  }

  return specs;
}

function categoryCompatible(product, icecat) {
  const type = String(product.type || "").toLowerCase();
  const category = String(icecat.category || "").toLowerCase();
  const fallback = String(icecat.title || "").toLowerCase();
  const haystack = category || fallback;
  if (!haystack) return true;
  const rules = {
    laptop: /notebook|laptop|mobile workstation/,
    gpu: /graphics|video card|vga|gpu/,
    cpu: /processor|cpu/,
    storage: /solid state|ssd|hard drive|hdd|storage|disk/,
    motherboard: /motherboard|mainboard/,
    ram: /memory module|internal memory|ram|ddr/,
    monitor: /monitor|display/,
    printer: /printer|multifunction/,
    desktop: /desktop|pc\/workstation|workstation|tower/,
    power: /power supply|ups|psu/,
  };
  return !rules[type] || rules[type].test(haystack);
}

function scoreIcecatMatch(product, icecat) {
  if (!categoryCompatible(product, icecat)) return -100;
  const brand = String(productBrandName(product) || "").toLowerCase();
  const title = cleanTitle(product.title).toLowerCase();
  const codeCandidates = productCodeCandidates(product).map((code) => code.toLowerCase());
  const haystack = `${icecat.title || ""} ${icecat.brand || ""} ${icecat.productCode || ""}`.toLowerCase();
  let score = 0;
  if (brand && haystack.includes(brand)) score += 8;
  codeCandidates.forEach((code) => {
    if (code && haystack.includes(code)) score += 10;
  });
  cleanTitle(product.title)
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 3)
    .slice(0, 12)
    .forEach((token) => {
      if (haystack.includes(token)) score += 1;
    });
  if (icecat.category && title.includes(String(product.type || "").toLowerCase())) score += 2;
  score += Math.min(Object.keys(icecat.specs || {}).length / 20, 5);
  return score;
}

function shouldTryIcecat(product) {
  return !["accessory", "other"].includes(String(product.type || "").toLowerCase());
}

async function resolveIcecat(product, options = {}) {
  if (!shouldTryIcecat(product)) return null;
  const brand = productBrandName(product);
  const candidates = [];

  for (const result of await searchIcecatResults(product, { quick: options.quick })) {
    try {
      const icecat = await fetchIcecat({ icecat_id: result.id }, result.id);
      if (!categoryCompatible(product, icecat)) {
        await sleep(200);
        continue;
      }
      if (result.url && !icecat.sourceUrl) icecat.sourceUrl = result.url;
      return { icecat, source: `icecat-search:${result.id}`, score: 100 };
    } catch (error) {
      const pageIcecat = await fetchIcecatPageSpecs(product, result, error.message || String(error));
      if (pageIcecat && !categoryCompatible(product, pageIcecat)) {
        await sleep(200);
        continue;
      }
      if (pageIcecat) {
        return { icecat: pageIcecat, source: `icecat-page:${result.id}`, score: 100 };
      }
    }
    await sleep(200);
  }

  for (const code of productCodeCandidates(product)) {
    const attempts = [
      { Brand: brand, ProductCode: code },
      { Brand: brand, BrandPartCode: code },
    ];
    for (const params of attempts) {
      try {
        const icecat = await fetchIcecat(params);
        candidates.push({ icecat, source: `code:${code}` });
      } catch {
        // Continue through alternate lookup shapes.
      }
      await sleep(options.quick ? 50 : 200);
    }
  }

  return candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreIcecatMatch(product, candidate.icecat),
    }))
    .sort((a, b) => b.score - a.score)[0];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnv();
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required.");
  }
  if (!process.env.ICECAT_API_TOKEN) {
    throw new Error("ICECAT_API_TOKEN is required.");
  }

  const allProducts = await fetchProducts();
  const candidates = allProducts.filter((product) => {
    const specsRaw =
      product.specs_raw && typeof product.specs_raw === "object" ? product.specs_raw : {};
    const matchesCategory = !args.category || String(product.type || "") === args.category;
    return matchesCategory && (args.force || (!specsRaw.icecat?.id && !specsRaw.web?.specs));
  });
  const selected = candidates.slice(args.offset, args.limit ? args.offset + args.limit : undefined);
  console.log(`Products: ${allProducts.length}; Icecat candidates: ${candidates.length}; selected: ${selected.length}`);

  if (args.printQueries) {
    selected.forEach((product, index) => {
      console.log(`${index + 1}. ${product.title}`);
      canonicalSearchTerms(product).forEach((term) => console.log(`   - ${term}`));
    });
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = path.join(process.cwd(), "backups", `icecat-enrichment-${stamp}`);
  fs.mkdirSync(reportDir, { recursive: true });
  const report = [];

  for (let index = 0; index < selected.length; index += 1) {
    const product = selected[index];
    try {
      let resolved = null;
      let icecatError = "";
      try {
        resolved = await resolveIcecat(product, { quick: true });
      } catch (error) {
        icecatError = error.message || String(error);
      }
      if (!resolved || resolved.score < 8) {
        const webSpecs = args.skipWeb ? null : await searchWebSpecs(product);
        if (!webSpecs) {
          console.log(`${index + 1}/${selected.length} miss: ${product.title}`);
          report.push({
            id: product.id,
            title: product.title,
            status: "miss",
            ...(icecatError ? { icecatError } : {}),
          });
        } else {
          const existing =
            product.specs_raw && typeof product.specs_raw === "object" ? product.specs_raw : {};
          const nextSpecs = { ...existing, web: webSpecs };
          if (!args.dryRun) {
            await sb("products", {
              method: "PATCH",
              params: { id: `eq.${product.id}` },
              headers: { Prefer: "return=minimal" },
              body: { specs_raw: nextSpecs },
            });
          }
          console.log(
            `${index + 1}/${selected.length} ${args.dryRun ? "web dry-run" : "web updated"}: ${product.title}`
          );
          report.push({
            id: product.id,
            title: product.title,
            status: args.dryRun ? "web-dry-run" : "web-updated",
            query: webSpecs.query,
            ...(icecatError ? { icecatError } : {}),
            specCount: Object.keys(webSpecs.specs || {}).length,
            sources: webSpecs.sources,
          });
        }
      } else {
        const existing =
          product.specs_raw && typeof product.specs_raw === "object" ? product.specs_raw : {};
        const nextSpecs = args.idsOnly
          ? { ...existing, icecat: { id: resolved.icecat.id, syncedAt: new Date().toISOString() } }
          : { ...existing, icecat: resolved.icecat };
        if (!args.dryRun) {
          await sb("products", {
            method: "PATCH",
            params: { id: `eq.${product.id}` },
            headers: { Prefer: "return=minimal" },
            body: { specs_raw: nextSpecs },
          });
        }
        console.log(
          `${index + 1}/${selected.length} ${args.dryRun ? "dry-run" : "updated"}: ${product.title} -> ${resolved.icecat.id}`
        );
        report.push({
          id: product.id,
          title: product.title,
          status: args.dryRun ? "dry-run" : "updated",
          icecatId: resolved.icecat.id,
          icecatTitle: resolved.icecat.title,
          source: resolved.source,
          score: resolved.score,
          specCount: Object.keys(resolved.icecat.specs || {}).length,
        });
      }
    } catch (error) {
      console.log(`${index + 1}/${selected.length} error: ${product.title} (${error.message})`);
      report.push({ id: product.id, title: product.title, status: "error", error: error.message });
    }
    fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2));
    await sleep(650);
  }

  const updated = report.filter((item) =>
    ["updated", "dry-run", "web-updated", "web-dry-run"].includes(item.status)
  ).length;
  const missed = report.filter((item) => item.status === "miss").length;
  const errored = report.filter((item) => item.status === "error").length;
  console.log(`Report: ${reportDir}`);
  console.log(`Done. Icecat matches: ${updated}; misses: ${missed}; errors: ${errored}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

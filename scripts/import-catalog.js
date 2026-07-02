#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const DEFAULT_XLSX = "/home/amrelemary/Downloads/27-6-2026.xlsx";

function parseArgs(argv) {
  const args = {
    xlsx: DEFAULT_XLSX,
    replace: false,
    confirm: false,
    dryRun: false,
    imageManifest: "",
  };
  argv.forEach((arg) => {
    if (arg === "--replace") args.replace = true;
    else if (arg === "--confirm") args.confirm = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg.startsWith("--xlsx=")) args.xlsx = arg.slice("--xlsx=".length);
    else if (arg.startsWith("--image-manifest=")) {
      args.imageManifest = arg.slice("--image-manifest=".length);
    }
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

function xmlDecode(value = "") {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function readZipEntries(filePath) {
  const buffer = fs.readFileSync(filePath);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("Invalid xlsx zip: EOCD not found");
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = {};
  let ptr = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) throw new Error("Invalid central directory");
    const method = buffer.readUInt16LE(ptr + 10);
    const compressedSize = buffer.readUInt32LE(ptr + 20);
    const nameLength = buffer.readUInt16LE(ptr + 28);
    const extraLength = buffer.readUInt16LE(ptr + 30);
    const commentLength = buffer.readUInt16LE(ptr + 32);
    const localOffset = buffer.readUInt32LE(ptr + 42);
    const name = buffer.slice(ptr + 46, ptr + 46 + nameLength).toString("utf8");

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw new Error(`Unsupported zip compression method ${method}`);
    entries[name] = data.toString("utf8");
    ptr += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function sharedStrings(xml = "") {
  const values = [];
  const items = xml.match(/<si[\s\S]*?<\/si>/g) || [];
  items.forEach((item) => {
    const text = [...item.matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((match) => xmlDecode(match[1]))
      .join("");
    values.push(text);
  });
  return values;
}

function columnNumber(cellRef) {
  const letters = String(cellRef || "").match(/[A-Z]+/)?.[0] || "";
  return letters.split("").reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
}

function parseSheetRows(sheetXml, shared) {
  const rows = [];
  const rowMatches = sheetXml.match(/<row\b[\s\S]*?<\/row>/g) || [];
  rowMatches.forEach((rowXml) => {
    const row = {};
    const cells = rowXml.match(/<c\b[\s\S]*?<\/c>/g) || [];
    cells.forEach((cellXml) => {
      const ref = cellXml.match(/\br="([^"]+)"/)?.[1] || "";
      const type = cellXml.match(/\bt="([^"]+)"/)?.[1] || "";
      const col = columnNumber(ref);
      let value = "";
      if (type === "inlineStr") {
        value = [...cellXml.matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)]
          .map((match) => xmlDecode(match[1]))
          .join("");
      } else {
        const raw = cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] || "";
        value = type === "s" ? shared[Number(raw)] || "" : raw;
      }
      if (col && value !== "") row[col] = String(value).trim();
    });
    if (Object.keys(row).length) rows.push(row);
  });
  return rows;
}

function parseXlsxProducts(filePath) {
  const entries = readZipEntries(filePath);
  const shared = sharedStrings(entries["xl/sharedStrings.xml"] || "");
  const sheet = entries["xl/worksheets/sheet1.xml"];
  if (!sheet) throw new Error("Expected xl/worksheets/sheet1.xml in workbook");
  return parseSheetRows(sheet, shared)
    .map((row) => ({ title: row[1], price: row[13] ? Number(row[13]) : 0 }))
    .filter((row) => row.title);
}

function titleCase(value) {
  const overrides = new Map([
    ["HP", "HP"],
    ["MSI", "MSI"],
    ["AMD", "AMD"],
    ["ASUS", "ASUS"],
    ["ADATA", "ADATA"],
    ["HIKSEMI", "HIKSEMI"],
    ["KIOXIA", "KIOXIA"],
    ["SANDISK", "SanDisk"],
    ["KINGSTON", "Kingston"],
    ["WESTERN DIGITAL", "Western Digital"],
  ]);
  const upper = value.toUpperCase();
  if (overrides.has(upper)) return overrides.get(upper);
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferBrand(title) {
  const cleaned = title.replace(/\u00ae|\u2122/g, "").trim();
  const upper = cleaned.toUpperCase();
  const known = [
    "Western Digital",
    "HIKSEMI",
    "Lexar",
    "Crucial",
    "ADATA",
    "KIOXIA",
    "SanDisk",
    "Kingston",
    "Samsung",
    "Transcend",
    "Intel",
    "AMD",
    "ASUS",
    "Dell",
    "HP",
    "Lenovo",
    "Acer",
    "MSI",
    "Gigabyte",
    "Zotac",
    "PNY",
    "Canon",
    "Epson",
    "Brother",
  ];
  const match = known.find((brand) => upper.includes(brand.toUpperCase()));
  if (match) return match;
  const afterPrefix = cleaned.match(/^(?:LAP|VGA|RAM|MOTHERBOARD|PC|POWER SUPPLAY)\s+([A-Z0-9]+)/i);
  if (afterPrefix) return titleCase(afterPrefix[1]);
  const first = cleaned.split(/[\/-]/)[0].trim().split(/\s+/).slice(0, 2).join(" ");
  return titleCase(first || "Compu Magic");
}

function inferCategory(title) {
  const text = title.toLowerCase();
  if (/\b(lap|laptop|notebook)\b|thinkpad|ideapad|latitude|vostro|victus|nitro|legion|cyborg|vivobook/.test(text)) return "laptop";
  if (/\b(vga|gpu)\b|geforce|rtx|gtx|radeon|graphics card/.test(text)) return "gpu";
  if (/\b(cpu|processor)\b|\b(core i[3579]|ultra [3579]|ryzen [3579])\b/.test(text)) return "cpu";
  if (/hard disk|hard drive|\bssd\b|nvme|passport|portable|storage/.test(text)) return "storage";
  if (/motherboard|\b(b760|b650|z790|a620|h610|h510|b550)\b/.test(text)) return "motherboard";
  if (/\bram\b|\bddr[345]\b/.test(text)) return "ram";
  if (/monitor|led monitors|\b[0-9]{2}"/.test(text)) return "monitor";
  if (/printer|laserjet|deskjet|inkjet/.test(text)) return "printer";
  if (/\bpc\b|desktop/.test(text)) return "desktop";
  if (/power supply|power supplay|\bpsu\b|ups/.test(text)) return "power";
  if (/case|keyboard|mouse|adapter|charger|cable/.test(text)) return "accessory";
  return "other";
}

function inferSpecs(title, category) {
  const specs = { manual: { sourceTitle: title } };
  const cpu = title.match(/\b(?:core\s*)?i[3579][-\s]?\d{4,5}[a-z]*\b|ultra\s+[3579]\s+\d{3}[a-z]?|ryzen\s+[3579]\s+\d{4}[a-z]*/i)?.[0];
  const gpu = title.match(/\brtx\s*\d{4}(?:\s*\d+g)?|gtx\s*\d{4}|radeon\s+[a-z0-9\s]+/i)?.[0];
  const ram = title.match(/\b(?:\d{1,3}\s?g|\d{1,3}\s?gb)\b(?=.*(?:ram|ddr|\/))/i)?.[0];
  const storage = title.match(/\b\d+(?:\.\d+)?\s?(?:tb|gb)\b(?=.*(?:ssd|hdd|storage|nvme|passport|\/))/i)?.[0];
  const display = title.match(/\b\d{2}(?:\.\d)?\s?(?:"|inch|in)\b/i)?.[0];
  if (cpu) specs.cpu = cpu.toUpperCase();
  if (gpu) specs.gpu = gpu.toUpperCase();
  if (ram || category === "ram") specs.ram = ram || title;
  if (storage || category === "storage") specs.storage = storage || title;
  if (display || category === "monitor") specs.display = display || "";
  return specs;
}

function placeholderImage(title, category) {
  const text = encodeURIComponent(`${category} ${title}`.slice(0, 42));
  return `https://placehold.co/800x600/e0e9f6/0a2e5d?text=${text}`;
}

function loadImageManifest(filePath) {
  if (!filePath) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key.trim().toLowerCase(), value])
  );
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

async function deleteAllIfExists(table) {
  try {
    await sb(table, { method: "DELETE", params: { id: "not.is.null" } });
    return true;
  } catch (error) {
    if (String(error.message || "").includes("PGRST205")) return false;
    throw error;
  }
}

function passwordHash(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

async function ensureAdmin() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return;
  const existing = await sb("users", { params: { select: "id", username: `eq.${username}` } });
  if (existing.length) return;
  await sb("users", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: {
      username,
      full_name: process.env.ADMIN_FULL_NAME || "Compu Magic Admin",
      admin: true,
      is_registered: true,
      hashed_password: passwordHash(password),
    },
  });
  console.log(`Seeded admin user ${username}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnv();
  const rows = parseXlsxProducts(args.xlsx);
  console.log(`Parsed ${rows.length} products from ${args.xlsx}`);
  if (args.dryRun) {
    const categories = rows.reduce((acc, row) => {
      const category = inferCategory(row.title);
      acc[category] = (acc[category] || 0) + 1;
      return acc;
    }, {});
    const brands = new Set(rows.map((row) => inferBrand(row.title)));
    console.log("Category counts:", categories);
    console.log(`Inferred ${brands.size} brands.`);
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required.");
  }
  if (!args.confirm && process.env.COMPUMAGIC_IMPORT_CONFIRM !== "1") {
    throw new Error("Refusing to import without --confirm or COMPUMAGIC_IMPORT_CONFIRM=1.");
  }

  const imageManifest = loadImageManifest(args.imageManifest);
  console.log(`Target Supabase: ${process.env.SUPABASE_URL}`);

  if (args.replace) {
    await deleteAllIfExists("order_items");
    await deleteAllIfExists("orders");
    await deleteAllIfExists("products");
    await deleteAllIfExists("brands");
    console.log("Cleared existing orders, products, and brands.");
  }

  await ensureAdmin();

  const existingBrands = await sb("brands", { params: { select: "id,name" } });
  const brandMap = new Map(existingBrands.map((brand) => [brand.name.toLowerCase(), brand.id]));
  const neededBrands = [...new Set(rows.map((row) => inferBrand(row.title)))].sort((a, b) =>
    a.localeCompare(b)
  );
  for (const brandName of neededBrands) {
    if (brandMap.has(brandName.toLowerCase())) continue;
    const created = await sb("brands", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: { name: brandName, description: "" },
    });
    brandMap.set(brandName.toLowerCase(), created[0].id);
  }
  console.log(`Prepared ${neededBrands.length} brands.`);

  const products = rows.map((row) => {
    const brandName = inferBrand(row.title);
    const type = inferCategory(row.title);
    const specs = inferSpecs(row.title, type);
    const image = imageManifest[row.title.trim().toLowerCase()] || placeholderImage(row.title, type);
    return {
      type,
      brand_id: brandMap.get(brandName.toLowerCase()),
      title: row.title,
      short_name: row.title.slice(0, 80),
      price: row.price || 0,
      description: row.title,
      warranty: 0,
      images: [image],
      specs_raw: specs,
    };
  });

  for (let i = 0; i < products.length; i += 100) {
    const batch = products.slice(i, i + 100);
    await sb("products", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: batch,
    });
    console.log(`Imported ${Math.min(i + batch.length, products.length)} / ${products.length}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

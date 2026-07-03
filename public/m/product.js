const API_BASE = "/api";
const TYPE_LABELS = {
  laptop: "Laptop",
  gpu: "Graphics",
  cpu: "Processor",
  hdd: "Storage",
  storage: "Storage",
  motherboard: "Motherboard",
  ram: "Memory",
  monitor: "Monitor",
  printer: "Printer",
  desktop: "Desktop",
  power: "Power",
  accessory: "Accessory",
  other: "Product",
};

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, { credentials: "include", ...options });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const data = JSON.parse(text);
      if (data && data.error) message = data.error;
    } catch (error) {
      // ignore parse errors
    }
    const err = new Error(message || `Request failed with status ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

function setYear() {
  const yearEl = document.getElementById("year");
  if (yearEl) {
    yearEl.textContent = new Date().getFullYear();
  }
}

function renderImages(images = [], title = "Product image") {
  if (!images.length) {
    images = ["https://placehold.co/800x500?text=Product+Preview"];
  }
  const hasMultiple = images.length > 1;
  const slides = images
    .map(
      (url, index) => {
        const imageUrl = window.catalogImageUrl
          ? window.catalogImageUrl(url, { width: 760, height: 570, quality: 72 })
          : url;
        return `<figure class="gallery-slide" data-index="${index}">
          <img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)} ${index + 1}" data-fallback="${escapeHtml(window.catalogPlaceholder ? window.catalogPlaceholder(title) : "https://placehold.co/800x500?text=Product+Preview")}" loading="${index === 0 ? "eager" : "lazy"}" decoding="async" referrerpolicy="no-referrer" />
        </figure>`;
      }
    )
    .join("");
  return `
    <div class="gallery-slider" data-gallery tabindex="0" aria-label="Product images">
      <button class="gallery-nav prev" type="button" aria-label="Previous image"${hasMultiple ? "" : " disabled"}>‹</button>
      <div class="gallery-window">
        <div class="gallery-track">
          ${slides}
        </div>
      </div>
      <button class="gallery-nav next" type="button" aria-label="Next image"${hasMultiple ? "" : " disabled"}>›</button>
    </div>
  `;
}

function renderSpec(label, value) {
  if (!value) return "";
  return `<div class="spec-sheet-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function normalizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeProductSpecLabel(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[_/-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalSpecLabel(label = "") {
  const normalized = normalizeProductSpecLabel(label);
  if (["cpu", "processor", "processor model", "processor family"].includes(normalized)) return "processor";
  if (["gpu", "graphics", "graphics adapter", "graphics processor", "discrete graphics card model"].includes(normalized)) return "graphics";
  if (["ram", "memory", "internal memory", "system memory"].includes(normalized)) return "memory";
  if (["storage", "ssd capacity", "hdd capacity", "total storage capacity", "capacity"].includes(normalized)) return "storage";
  if (["display", "screen", "display diagonal", "display resolution"].includes(normalized)) return "display";
  if (["operating system", "operating system installed", "os"].includes(normalized)) return "operating system";
  if (["type", "memory type", "internal memory type", "graphics card memory type"].includes(normalized)) return "memory type";
  if (["speed", "memory clock speed"].includes(normalized)) return "speed";
  if (["size", "display size"].includes(normalized)) return "display";
  return normalized;
}

function normalizeSpecValue(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[®™]/g, "")
    .replace(/\b(gb)\b/g, "g")
    .replace(/\b(tb)\b/g, "t")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();
}

function formatSpecValue(label, value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return "";
  if (/official source|xbox game pass|included in the box|microsoft office/i.test(label)) return "";
  const canonical = canonicalSpecLabel(label);
  const directCompact = {
    processor: text.match(/(?:Intel|AMD|Qualcomm|Snapdragon|Core|Ryzen)[^,;]*/i)?.[0],
    graphics: text.match(/(?:NVIDIA|AMD|Intel|GeForce|Radeon|RTX|GTX|Arc)[^,;]*/i)?.[0],
    memory: text.match(/\b\d+\s*(?:GB|G)\b(?:\s*(?:DDR\d|LPDDR\dX?))?/i)?.[0],
    storage: text.match(/\b\d+(?:\.\d+)?\s*(?:TB|GB|T|G)\b[^,;]*/i)?.[0],
    display: text.match(/\b\d{1,2}(?:\.\d)?\s*(?:-?\s*inch|["`])[^,;]*/i)?.[0],
    "operating system": text.match(/\bWindows\s+\d+(?:\s+\w+)?\b|\bDOS\b|\bNo preinstalled OS\b/i)?.[0],
  }[canonical];
  if (directCompact) return directCompact.replace(/\s+/g, " ").trim();
  if (text.length <= 92) return text;
  const compactParts = text
    .split(/,|;/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^https?:\/\//i.test(part));
  if (!compactParts.length) return "";
  const shortlist = [];
  for (const part of compactParts) {
    const next = shortlist.length ? `${shortlist.join(" · ")} · ${part}` : part;
    if (next.length > 92) break;
    shortlist.push(part);
    if (shortlist.length === 3) break;
  }
  return shortlist.join(" · ");
}

function extraSpecKeys(type = "") {
  const extras = {
    laptop: [
      "Battery",
      "Weight",
      "Panel type",
      "Refresh Rate",
      "Display resolution",
      "Dimensions",
      "Keyboard and Touchpad",
      "I/O Ports",
      "Network and Communication",
    ],
    gpu: ["Graphics card memory type", "Memory bus", "HDMI ports quantity", "DisplayPorts quantity", "Cooling type"],
    monitor: ["Panel type", "Maximum refresh rate", "Response time", "Display brightness"],
    storage: ["Interface", "SSD form factor", "Sequential read speed", "Sequential write speed", "NVMe"],
    ram: ["Internal memory type", "Memory clock speed", "Memory layout", "CAS latency"],
    motherboard: ["Processor socket", "Motherboard chipset", "Motherboard form factor", "Supported memory types"],
  };
  return extras[type] || [];
}

function getKeySpecEntries(product) {
  const fields = window.catalogSpecFields ? window.catalogSpecFields(product.type) : [];
  const entries = [];
  const seen = new Set();
  const seenLabels = new Set();
  fields.forEach((field) => {
    const value = window.catalogPickSpec ? window.catalogPickSpec(product, field.keys) : "";
    const valueText = formatSpecValue(field.label, value);
    if (!valueText) return;
    const canonicalLabel = canonicalSpecLabel(field.label);
    const normalizedValue = normalizeSpecValue(valueText);
    const fingerprint = `${canonicalLabel}:${normalizedValue}`;
    if (seen.has(fingerprint) || seenLabels.has(canonicalLabel)) return;
    seen.add(fingerprint);
    seenLabels.add(canonicalLabel);
    entries.push({ label: field.label, value: valueText });
  });
  return entries;
}

function buildFullSpecs(product, keySpecEntries, warrantyLabel, titleNormalized) {
  const fullSpecs = [];
  const seen = new Set();
  const seenLabels = new Set();
  const seenValues = new Set();
  const preferredLabels = [
    ...(window.catalogSpecFields ? window.catalogSpecFields(product.type).map((field) => field.label) : []),
    ...extraSpecKeys(product.type),
    "Model",
    "Warranty",
  ];
  const normalizedPreferred = preferredLabels.map(normalizeProductSpecLabel).filter(Boolean);
  const addSpec = (label, value) => {
    const valueText = formatSpecValue(label, value);
    if (!label || !valueText || valueText.toLowerCase() === titleNormalized) return;
    if (String(label).trim() === "sourceTitle") return;
    const canonicalLabel = canonicalSpecLabel(label);
    const normalizedValue = normalizeSpecValue(valueText);
    const fingerprint = `${canonicalLabel}:${normalizedValue}`;
    if (seen.has(fingerprint) || seenLabels.has(canonicalLabel) || seenValues.has(normalizedValue)) return;
    seen.add(fingerprint);
    seenLabels.add(canonicalLabel);
    seenValues.add(normalizedValue);
    fullSpecs.push(renderSpec(label, valueText));
  };

  keySpecEntries.forEach((entry) => addSpec(entry.label, entry.value));
  if (product.specs && typeof product.specs === "object") {
    Object.entries(product.specs).forEach(([label, value]) => {
      const normalized = normalizeProductSpecLabel(label);
      if (!normalizedPreferred.some((item) => normalized === item || normalized.includes(item) || item.includes(normalized))) {
        return;
      }
      addSpec(label, value);
    });
  }
  if (normalizeText(product.shortName) !== normalizeText(product.title)) {
    addSpec("Model", product.shortName);
  }
  addSpec("Warranty", warrantyLabel);
  return fullSpecs;
}

function renderProduct(product) {
  const layout = document.getElementById("product-detail");
  const specList = document.getElementById("spec-list");
  const typeLabel = TYPE_LABELS[product.type] || "Product";
  const warrantyLabel =
    product.warranty && product.warranty > 0
      ? `${product.warranty} year${product.warranty > 1 ? "s" : ""}`
      : "";
  const displayTitle = product.title || product.shortName;
  const titleNormalized = String(product.title || "").trim().toLowerCase();
  const description = product.description && String(product.description).trim().toLowerCase() !== titleNormalized
    ? `<p class="detail-description">${escapeHtml(product.description)}</p>`
    : "";

  const keySpecEntries = getKeySpecEntries(product);
  const keySpecs = keySpecEntries.map((entry) => renderSpec(entry.label, entry.value));
  if (product.shortName && normalizeText(product.shortName) !== normalizeText(product.title)) {
    keySpecs.push(renderSpec("Model", product.shortName));
  }
  if (product.price) {
    keySpecs.push(renderSpec("Reference Price", Number(product.price).toLocaleString()));
  }
  if (warrantyLabel) {
    keySpecs.push(renderSpec("Warranty", warrantyLabel));
  }

  if (layout) {
    layout.innerHTML = `
      <span class="mobile-badge">${escapeHtml(product.company?.name || "Unassigned")} • ${escapeHtml(typeLabel)}</span>
      <h1 class="detail-title">${escapeHtml(displayTitle)}</h1>
      ${description}
      ${renderImages(product.images, product.title)}
      <div class="spec-list">
        ${keySpecs.join("") || `<div class="field-hint">No specifications listed yet.</div>`}
      </div>
    `;
  }

  if (specList) {
    const fullSpecs = buildFullSpecs(product, keySpecEntries, warrantyLabel, titleNormalized);
    specList.innerHTML = fullSpecs.join("");
  }

  initGallery();
}

function initGallery() {
  const slider = document.querySelector("[data-gallery]");
  if (!slider) return;
  const track = slider.querySelector(".gallery-track");
  const slides = Array.from(slider.querySelectorAll(".gallery-slide"));
  if (!track || !slides.length) return;
  const prev = slider.querySelector(".gallery-nav.prev");
  const next = slider.querySelector(".gallery-nav.next");
  let index = 0;

  const clampIndex = (value) => Math.min(Math.max(value, 0), slides.length - 1);

  const setIndex = (value) => {
    index = clampIndex(value);
    track.style.transform = `translateX(-${index * 100}%)`;
    if (prev) prev.disabled = index === 0;
    if (next) next.disabled = index === slides.length - 1;
  };

  if (prev) {
    prev.addEventListener("click", () => setIndex(index - 1));
  }
  if (next) {
    next.addEventListener("click", () => setIndex(index + 1));
  }

  slider.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setIndex(index - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setIndex(index + 1);
    }
  });

  setIndex(0);

  slider.querySelectorAll("img").forEach((img) => {
    img.addEventListener(
      "error",
      () => {
        const fallback = img.dataset.fallback;
        if (fallback && img.src !== fallback) {
          img.src = fallback;
        }
      },
      { once: true }
    );
  });
}

function createRelatedCard(product) {
  const card = document.createElement("article");
  card.className = "mobile-card";
  const typeLabel = TYPE_LABELS[product.type] || "Product";
  const brandLabel = product.company?.name || "Unassigned";
  const rawImage =
    product.images?.[0] || (window.catalogPlaceholder ? window.catalogPlaceholder(typeLabel) : `https://placehold.co/600x450?text=${encodeURIComponent(typeLabel)}`);
  const image = window.catalogImageUrl
    ? window.catalogImageUrl(rawImage, { width: 300, height: 225, quality: 60 })
    : rawImage;
  const displayTitle = product.shortName || product.title;
  card.innerHTML = `
    <img class="mobile-thumb" src="${escapeHtml(image)}" alt="${escapeHtml(product.title)}" data-fallback="${escapeHtml(window.catalogPlaceholder ? window.catalogPlaceholder(typeLabel) : "https://placehold.co/600x450?text=Product")}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
    <div class="mobile-content">
      <span class="mobile-badge">${escapeHtml(brandLabel)} • ${escapeHtml(typeLabel)}</span>
      <h3 class="mobile-title">${escapeHtml(displayTitle)}</h3>
    </div>
  `;
  const cardImage = card.querySelector("img");
  if (cardImage) {
    cardImage.addEventListener(
      "error",
      () => {
        const fallback = cardImage.dataset.fallback;
        if (fallback && cardImage.src !== fallback) {
          cardImage.src = fallback;
        }
      },
      { once: true }
    );
  }
  const detailUrl = `/m/product.html?id=${encodeURIComponent(product.id)}`;
  card.addEventListener("click", () => {
    window.location.href = detailUrl;
  });
  return card;
}

async function loadRelated(product) {
  if (!product.type) return;
  const panel = document.getElementById("related-panel");
  const grid = document.getElementById("related-grid");
  if (!panel || !grid) return;
  try {
    const related = await fetchJSON(
      `${API_BASE}/products?category=${encodeURIComponent(product.type)}`
    );
    const filtered = related.filter((item) => item.id !== product.id).slice(0, 3);
    if (!filtered.length) {
      panel.hidden = true;
      return;
    }
    grid.innerHTML = "";
    filtered.forEach((item) => grid.appendChild(createRelatedCard(item)));
    panel.hidden = false;
  } catch (error) {
    console.error(error);
    panel.hidden = true;
  }
}

async function init() {
  setYear();
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  const layout = document.getElementById("product-detail");

  if (!id) {
    if (layout) {
      layout.innerHTML = `<div class="toast error">Missing product ID. Return to the <a href="/m/index.html" style="color: inherit; text-decoration: underline;">catalog list</a>.</div>`;
    }
    return;
  }

  try {
    const product = await fetchJSON(`${API_BASE}/products/${encodeURIComponent(id)}`);
    renderProduct(product);
    loadRelated(product);
  } catch (error) {
    console.error(error);
    if (layout) {
      layout.innerHTML = `<div class="toast error">We couldn't find that product. Please return to the catalog.</div>`;
    }
  }
}

document.addEventListener("DOMContentLoaded", init);

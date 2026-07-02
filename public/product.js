const API_BASE = "/api";
let statusTimer = null;
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
          ? window.catalogImageUrl(url, { width: 900, height: 680, quality: 74 })
          : url;
        return `<figure class="gallery-slide" data-index="${index}">
          <img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)} ${index + 1}" loading="${index === 0 ? "eager" : "lazy"}" decoding="async" referrerpolicy="no-referrer" />
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
  return `<div class="spec-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderSpecRow(label, value) {
  if (!value) return "";
  return `<div class="detail-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function normalizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function getKeySpecEntries(product) {
  const fields = window.catalogSpecFields ? window.catalogSpecFields(product.type) : [];
  const entries = [];
  const seen = new Set();
  fields.forEach((field) => {
    const value = window.catalogPickSpec ? window.catalogPickSpec(product, field.keys) : "";
    const valueText = String(value || "").trim();
    if (!valueText) return;
    const fingerprint = `${normalizeText(field.label)}:${normalizeText(valueText)}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    entries.push({ label: field.label, value: valueText });
  });
  return entries;
}

function buildFullSpecs(product, keySpecEntries, warrantyLabel, titleNormalized) {
  const fullSpecs = [];
  const seen = new Set();
  const addSpec = (label, value) => {
    const valueText = String(value || "").trim();
    if (!label || !valueText || valueText.toLowerCase() === titleNormalized) return;
    if (String(label).trim() === "sourceTitle") return;
    const fingerprint = `${normalizeText(label)}:${normalizeText(valueText)}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    fullSpecs.push(renderSpec(label, valueText));
  };

  keySpecEntries.forEach((entry) => addSpec(entry.label, entry.value));
  if (product.specs && typeof product.specs === "object") {
    Object.entries(product.specs).forEach(([label, value]) => addSpec(label, value));
  }
  if (normalizeText(product.shortName) !== normalizeText(product.title)) {
    addSpec("Model", product.shortName);
  }
  if (product.icecatId) addSpec("Icecat ID", product.icecatId);
  if (product.price) addSpec("Reference Price", Number(product.price).toLocaleString());
  addSpec("Warranty", warrantyLabel);
  return fullSpecs;
}

function showStatus(message, type = "success") {
  const container = document.getElementById("detail-status");
  if (!container) return;
  if (statusTimer) {
    clearTimeout(statusTimer);
  }
  container.innerHTML = `<div class="toast ${type === "error" ? "error" : ""}">${message}</div>`;
  statusTimer = window.setTimeout(() => {
    container.innerHTML = "";
  }, 3000);
}

function renderProduct(product) {
  const layout = document.getElementById("detail-layout");
  const specList = document.getElementById("spec-list");
  const typeLabel = TYPE_LABELS[product.type] || "Product";
  const warrantyLabel =
    product.warranty && product.warranty > 0
      ? `${product.warranty} year${product.warranty > 1 ? "s" : ""}`
      : "";
  const titleNormalized = String(product.title || "").trim().toLowerCase();
  const description = product.description && String(product.description).trim().toLowerCase() !== titleNormalized
    ? `<p class="detail-description">${escapeHtml(product.description)}</p>`
    : "";

  const keySpecEntries = getKeySpecEntries(product);
  const keySpecs = keySpecEntries.map((entry) => renderSpecRow(entry.label, entry.value));
  if (product.shortName && normalizeText(product.shortName) !== normalizeText(product.title)) {
    keySpecs.push(renderSpecRow("Model", product.shortName));
  }
  if (product.price) {
    keySpecs.push(renderSpecRow("Reference Price", Number(product.price).toLocaleString()));
  }
  if (warrantyLabel) {
    keySpecs.push(renderSpecRow("Warranty", warrantyLabel));
  }

  if (layout) {
    layout.innerHTML = `
      <div class="product-detail-page">
        <div class="detail-gallery">
          ${renderImages(product.images, product.title)}
        </div>
        <div class="detail-buybox">
          <p class="badge">${escapeHtml(product.company?.name || "Unassigned")} • ${escapeHtml(typeLabel)}</p>
          <h1>${escapeHtml(product.title)}</h1>
          ${description}
          <div class="detail-key-specs">
            ${keySpecs.join("") || `<div class="field-hint">No specifications listed yet.</div>`}
          </div>
          <a class="btn btn-outline detail-back" href="/index.html">Back to catalog</a>
        </div>
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
}

function createRelatedCard(product) {
  const card = document.createElement("article");
  card.className = "product-card";
  const typeLabel = TYPE_LABELS[product.type] || "Product";
  const brandLabel = product.company?.name || "Unassigned";
  const rawImage =
    product.images?.[0] || (window.catalogPlaceholder ? window.catalogPlaceholder(typeLabel) : `https://placehold.co/600x450?text=${encodeURIComponent(typeLabel)}`);
  const image = window.catalogImageUrl
    ? window.catalogImageUrl(rawImage, { width: 360, height: 270, quality: 62 })
    : rawImage;
  const summary = window.catalogSummary ? window.catalogSummary(product) : "";
  card.innerHTML = `
    <div class="product-media">
      <img src="${image}" alt="${product.title}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
    </div>
    <div class="product-body">
      <span class="badge">${brandLabel} • ${typeLabel}</span>
      <h3 class="product-title">${product.title}</h3>
      ${summary ? `<p class="product-summary">${summary}</p>` : ""}
    </div>
  `;
  const detailUrl = `/product.html?id=${encodeURIComponent(product.id)}`;
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
  const layout = document.getElementById("detail-layout");

  if (!id) {
    if (layout) {
      layout.innerHTML = `<div class="toast error">Missing product ID. Return to the <a href="/index.html" style="color: inherit; text-decoration: underline;">catalog list</a>.</div>`;
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

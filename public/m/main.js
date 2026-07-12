const API_BASE = "/api";
const state = {
  catalog: [],
};
const CATEGORY_ORDER = (window.CATALOG_CATEGORIES || []).map((category) => category.type);

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, { credentials: "include", ...options });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const data = JSON.parse(text);
      if (data && data.error) message = data.error;
    } catch (error) {
      // ignore parse errors
    }
    throw new Error(message || `Request failed with status ${res.status}`);
  }
  return res.json();
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setYear() {
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
}

function setupHeaderSearch() {
  const form = document.getElementById("mobile-search");
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const search = new FormData(form).get("search") || "";
    const url = new URL("/m/category.html", window.location.origin);
    if (String(search).trim()) url.searchParams.set("search", String(search).trim());
    window.location.href = url.toString();
  });
}

function createProductTile(product) {
  const card = document.createElement("article");
  card.className = "mobile-card";
  const category = window.getCatalogCategory(product.type);
  const brandLabel = product.company?.name || "Unassigned";
  const image = window.catalogImageUrl(
    product.images?.[0] ||
      window.catalogPlaceholder(category.label),
    { width: 300, height: 225, quality: 60 }
  );
  const displayTitle = product.shortName || product.title;
  card.innerHTML = `
    <img class="mobile-thumb" src="${escapeHtml(image)}" alt="${escapeHtml(product.title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
    <div class="mobile-content">
      <span class="mobile-badge">${escapeHtml(brandLabel)} • ${escapeHtml(category.singular)}</span>
      <h3 class="mobile-title">${escapeHtml(displayTitle)}</h3>
    </div>
  `;
  card.addEventListener("click", () => {
    window.location.href = `/m/product.html?id=${encodeURIComponent(product.id)}`;
  });
  return card;
}

function groupedProducts(products) {
  return products.reduce((acc, product) => {
    const type = window.getCatalogCategory(product.type).type || "other";
    if (!acc[type]) acc[type] = [];
    acc[type].push(product);
    return acc;
  }, {});
}

function renderProducts(products) {
  const results = document.getElementById("results");
  const empty = document.getElementById("empty");
  if (!results) return;
  results.innerHTML = "";
  if (!products.length) {
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  const grouped = groupedProducts(products);
  CATEGORY_ORDER.forEach((type) => {
    const items = grouped[type] || [];
    if (!items.length) return;
    const category = window.getCatalogCategory(type);
    const section = document.createElement("section");
    section.className = "catalog-section";
    section.innerHTML = `
      <div class="catalog-heading">
        <h3>${escapeHtml(category.label)}</h3>
        <div class="rail-heading-actions">
          <button class="rail-button" type="button" data-rail-prev aria-label="Scroll ${escapeHtml(category.label)} left">‹</button>
          <button class="rail-button" type="button" data-rail-next aria-label="Scroll ${escapeHtml(category.label)} right">›</button>
          <a href="/m/category.html?type=${encodeURIComponent(type)}">View all ${items.length}</a>
        </div>
      </div>
      <div class="mobile-rail"></div>
    `;
    const rail = section.querySelector(".mobile-rail");
    items.slice(0, 12).forEach((product) => rail.appendChild(createProductTile(product)));
    const prev = section.querySelector("[data-rail-prev]");
    const next = section.querySelector("[data-rail-next]");
    const scrollRail = (direction) => {
      rail.scrollBy({
        left: direction * Math.max(rail.clientWidth * 0.85, 260),
        behavior: "smooth",
      });
    };
    if (prev) prev.addEventListener("click", () => scrollRail(-1));
    if (next) next.addEventListener("click", () => scrollRail(1));
    results.appendChild(section);
  });
}

async function init() {
  setYear();
  setupHeaderSearch();
  try {
    state.catalog = await fetchJSON(`${API_BASE}/products`);
    renderProducts(state.catalog);
  } catch (error) {
    console.error(error);
    const results = document.getElementById("results");
    if (results) {
      results.innerHTML = `<div class="toast error">Catalog data isn't available yet. Please try again shortly.</div>`;
    }
  }
}

document.addEventListener("DOMContentLoaded", init);

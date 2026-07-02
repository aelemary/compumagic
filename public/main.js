const API_BASE = "/api";
const state = {
  catalog: [],
  companies: [],
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
    const err = new Error(message || `Request failed with status ${res.status}`);
    err.status = res.status;
    throw err;
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
  const form = document.getElementById("header-search");
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const search = new FormData(form).get("search") || "";
    const url = new URL("/category.html", window.location.origin);
    if (String(search).trim()) url.searchParams.set("search", String(search).trim());
    window.location.href = url.toString();
  });
}

async function loadInventory() {
  return fetchJSON(`${API_BASE}/products`);
}

async function loadCompanies() {
  return fetchJSON(`${API_BASE}/companies`);
}

function productImage(product) {
  const category = window.getCatalogCategory(product.type);
  const image =
    product.images?.[0] ||
    window.catalogPlaceholder(category.label);
  return window.catalogImageUrl(image, { width: 360, height: 270, quality: 62 });
}

function createProductCard(product) {
  const card = document.createElement("article");
  card.className = "product-card rail-card";
  const category = window.getCatalogCategory(product.type);
  const brandLabel = product.company?.name || "Unassigned";
  const summary = window.catalogSummary(product);
  const image = productImage(product);
  card.innerHTML = `
    <div class="product-media">
      <img src="${escapeHtml(image)}" alt="${escapeHtml(product.title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
    </div>
    <div class="product-body">
      <span class="badge">${escapeHtml(brandLabel)} • ${escapeHtml(category.singular)}</span>
      <h3 class="product-title">${escapeHtml(product.title)}</h3>
      ${summary ? `<p class="product-summary">${escapeHtml(summary)}</p>` : ""}
    </div>
  `;
  card.addEventListener("click", () => {
    window.location.href = `/product.html?id=${encodeURIComponent(product.id)}`;
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

function renderCategoryTiles(products) {
  const container = document.getElementById("category-tiles");
  if (!container) return;
  const grouped = groupedProducts(products);
  container.innerHTML = "";
  const fragment = document.createDocumentFragment();
  CATEGORY_ORDER.forEach((type) => {
    const items = grouped[type] || [];
    if (!items.length) return;
    const category = window.getCatalogCategory(type);
    const tile = document.createElement("a");
    tile.className = "category-tile";
    tile.href = `/category.html?type=${encodeURIComponent(type)}`;
    tile.innerHTML = `
      <span>${escapeHtml(category.label)}</span>
      <strong>${items.length}</strong>
    `;
    fragment.appendChild(tile);
  });
  container.appendChild(fragment);
}

function renderProductRails(products) {
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
  const fragment = document.createDocumentFragment();
  CATEGORY_ORDER.forEach((type) => {
    const items = grouped[type] || [];
    if (!items.length) return;
    const category = window.getCatalogCategory(type);
    const section = document.createElement("section");
    section.className = "catalog-section product-rail-section";
    section.innerHTML = `
      <div class="catalog-heading">
        <h3>${escapeHtml(category.label)}</h3>
        <div class="rail-heading-actions">
          <button class="rail-button" type="button" data-rail-prev aria-label="Scroll ${escapeHtml(category.label)} left">‹</button>
          <button class="rail-button" type="button" data-rail-next aria-label="Scroll ${escapeHtml(category.label)} right">›</button>
          <a href="/category.html?type=${encodeURIComponent(type)}">View all ${items.length}</a>
        </div>
      </div>
      <div class="product-rail"></div>
    `;
    const rail = section.querySelector(".product-rail");
    items.slice(0, 16).forEach((product) => rail.appendChild(createProductCard(product)));
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
    fragment.appendChild(section);
  });
  results.appendChild(fragment);
}

async function init() {
  setYear();
  setupHeaderSearch();
  try {
    const [inventory, companies] = await Promise.all([
      loadInventory(),
      loadCompanies().catch(() => []),
    ]);
    state.catalog = inventory || [];
    state.companies = companies || [];
    renderCategoryTiles(state.catalog);
    renderProductRails(state.catalog);
  } catch (error) {
    console.error(error);
    const results = document.getElementById("results");
    if (results) {
      results.innerHTML = `<div class="toast error">Catalog data isn't available yet. Please try again shortly.</div>`;
    }
  }
}

document.addEventListener("DOMContentLoaded", init);

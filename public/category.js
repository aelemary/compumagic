const API_BASE = "/api";
const state = {
  products: [],
  companies: [],
  initialType: "",
};

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

function getProductText(product) {
  return [
    product.title,
    product.shortName,
    product.description,
    product.company?.name,
    product.type,
    product.cpu,
    product.gpu,
    product.ram,
    product.storage,
    product.display,
    ...Object.values(product.specs || {}),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function includesText(value, search) {
  if (!search) return true;
  return String(value || "").toLowerCase().includes(search);
}

function productImage(product) {
  const category = window.getCatalogCategory(product.type);
  const image =
    product.images?.[0] ||
    window.catalogPlaceholder(category.label);
  return window.catalogImageUrl(image, { width: 420, height: 315, quality: 64 });
}

function createProductCard(product) {
  const card = document.createElement("article");
  card.className = "product-card";
  const category = window.getCatalogCategory(product.type);
  const brandLabel = product.company?.name || "Unassigned";
  const image = productImage(product);
  const summary = window.catalogSummary(product);
  const price = product.price ? `<div class="price-note">${Number(product.price).toLocaleString()}</div>` : "";
  card.innerHTML = `
    <div class="product-media">
      <img src="${escapeHtml(image)}" alt="${escapeHtml(product.title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
    </div>
    <div class="product-body">
      <span class="badge">${escapeHtml(brandLabel)} • ${escapeHtml(category.singular)}</span>
      <h3 class="product-title">${escapeHtml(product.title)}</h3>
      ${summary ? `<p class="product-summary">${escapeHtml(summary)}</p>` : ""}
      ${price}
    </div>
  `;
  card.addEventListener("click", () => {
    window.location.href = `/product.html?id=${encodeURIComponent(product.id)}`;
  });
  return card;
}

function populateCategorySelect() {
  const select = document.getElementById("filter-category");
  if (!select) return;
  const current = select.value;
  (window.CATALOG_CATEGORIES || []).forEach((category) => {
    const option = document.createElement("option");
    option.value = category.type;
    option.textContent = category.label;
    select.appendChild(option);
  });
  if (current) select.value = current;
}

function populateCompanySelect() {
  const select = document.getElementById("filter-company");
  if (!select) return;
  const current = select.value;
  state.companies.forEach((company) => {
    const option = document.createElement("option");
    option.value = company.id;
    option.textContent = company.name;
    select.appendChild(option);
  });
  if (current) select.value = current;
}

function readFilters() {
  const form = document.getElementById("category-filter-form");
  const data = form ? Object.fromEntries(new FormData(form).entries()) : {};
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, typeof value === "string" ? value.trim() : value])
  );
}

function filterProducts(products, filters) {
  const search = (filters.search || "").toLowerCase();
  const min = filters.priceMin ? Number(filters.priceMin) : null;
  const max = filters.priceMax ? Number(filters.priceMax) : null;
  return products.filter((product) => {
    const type = window.getCatalogCategory(product.type).type;
    if (filters.category && type !== filters.category) return false;
    if (filters.companyId && product.companyId !== filters.companyId) return false;
    if (search && !getProductText(product).includes(search)) return false;
    if (min != null && Number(product.price || 0) < min) return false;
    if (max != null && Number(product.price || 0) > max) return false;
    if (!includesText(product.cpu || product.specs?.cpu || product.description, filters.cpu?.toLowerCase())) return false;
    if (!includesText(product.gpu || product.specs?.gpu || product.description, filters.gpu?.toLowerCase())) return false;
    if (!includesText(product.ram || product.specs?.ram || product.description, filters.ram?.toLowerCase())) return false;
    if (!includesText(product.storage || product.specs?.storage || product.specs?.capacity || product.description, filters.storage?.toLowerCase())) return false;
    return true;
  });
}

function updateHead(filters, count) {
  const title = document.getElementById("category-title");
  const subtitle = document.getElementById("category-subtitle");
  const resultCount = document.getElementById("result-count");
  const resultContext = document.getElementById("result-context");
  const category = filters.category ? window.getCatalogCategory(filters.category) : null;
  if (title) title.textContent = category ? category.label : "Catalog Results";
  if (subtitle) {
    subtitle.textContent = category
      ? `Browse ${category.label.toLowerCase()} with brand, price, and spec filters.`
      : "Browse all products with brand, price, and spec filters.";
  }
  if (resultCount) resultCount.textContent = `${count} product${count === 1 ? "" : "s"}`;
  if (resultContext) {
    resultContext.textContent = filters.search ? `Search: "${filters.search}"` : "";
  }
  document.title = `Compu Magic | ${category ? category.label : "Catalog Results"}`;
}

function renderProducts() {
  const results = document.getElementById("category-results");
  const empty = document.getElementById("category-empty");
  if (!results) return;
  const filters = readFilters();
  const filtered = filterProducts(state.products, filters);
  results.innerHTML = "";
  if (!filtered.length) {
    if (empty) empty.hidden = false;
  } else {
    if (empty) empty.hidden = true;
    const fragment = document.createDocumentFragment();
    filtered.forEach((product) => fragment.appendChild(createProductCard(product)));
    results.appendChild(fragment);
  }
  updateHead(filters, filtered.length);
}

function applyInitialParams() {
  const params = new URLSearchParams(window.location.search);
  const type = params.get("type") || "";
  const search = params.get("search") || "";
  const categoryInput = document.getElementById("filter-category");
  const searchInput = document.getElementById("filter-search");
  const headerInput = document.querySelector("#header-search input[name='search']");
  if (categoryInput && type) {
    state.initialType = window.getCatalogCategory(type).type;
    categoryInput.value = state.initialType;
  }
  if (searchInput && search) searchInput.value = search;
  if (headerInput && search) headerInput.value = search;
}

async function init() {
  setYear();
  setupHeaderSearch();
  populateCategorySelect();
  applyInitialParams();
  const form = document.getElementById("category-filter-form");
  const resetButton = document.getElementById("filter-reset");
  try {
    const [products, companies] = await Promise.all([
      fetchJSON(`${API_BASE}/products`),
      fetchJSON(`${API_BASE}/companies`).catch(() => []),
    ]);
    state.products = products || [];
    state.companies = companies || [];
    populateCompanySelect();
    renderProducts();
  } catch (error) {
    console.error(error);
    const status = document.getElementById("category-status");
    if (status) status.innerHTML = `<div class="toast error">Could not load catalog data.</div>`;
  }
  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      renderProducts();
    });
  }
  if (resetButton && form) {
    resetButton.addEventListener("click", () => {
      form.reset();
      if (state.initialType) {
        const select = document.getElementById("filter-category");
        if (select) select.value = state.initialType;
      }
      renderProducts();
    });
  }
}

document.addEventListener("DOMContentLoaded", init);

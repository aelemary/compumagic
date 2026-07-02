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
  const price = product.price ? `<p class="mobile-summary">${Number(product.price).toLocaleString()}</p>` : "";
  card.innerHTML = `
    <img class="mobile-thumb" src="${escapeHtml(image)}" alt="${escapeHtml(product.title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
    <div class="mobile-content">
      <span class="mobile-badge">${escapeHtml(brandLabel)} • ${escapeHtml(category.singular)}</span>
      <h3 class="mobile-title">${escapeHtml(displayTitle)}</h3>
      ${price}
    </div>
  `;
  card.addEventListener("click", () => {
    window.location.href = `/m/product.html?id=${encodeURIComponent(product.id)}`;
  });
  return card;
}

function populateCategorySelect() {
  const select = document.getElementById("filter-category");
  if (!select) return;
  (window.CATALOG_CATEGORIES || []).forEach((category) => {
    const option = document.createElement("option");
    option.value = category.type;
    option.textContent = category.label;
    select.appendChild(option);
  });
}

function populateCompanySelect() {
  const select = document.getElementById("filter-company");
  if (!select) return;
  state.companies.forEach((company) => {
    const option = document.createElement("option");
    option.value = company.id;
    option.textContent = company.name;
    select.appendChild(option);
  });
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
      ? `Browse ${category.label.toLowerCase()} with practical filters.`
      : "Browse all products with practical filters.";
  }
  if (resultCount) resultCount.textContent = `${count} product${count === 1 ? "" : "s"}`;
  if (resultContext) resultContext.textContent = filters.search ? `Search: "${filters.search}"` : "";
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
    filtered.forEach((product) => results.appendChild(createProductTile(product)));
  }
  updateHead(filters, filtered.length);
}

function applyInitialParams() {
  const params = new URLSearchParams(window.location.search);
  const type = params.get("type") || "";
  const search = params.get("search") || "";
  const categoryInput = document.getElementById("filter-category");
  const searchInput = document.getElementById("filter-search");
  if (categoryInput && type) {
    state.initialType = window.getCatalogCategory(type).type;
    categoryInput.value = state.initialType;
  }
  if (searchInput && search) searchInput.value = search;
}

async function init() {
  setYear();
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

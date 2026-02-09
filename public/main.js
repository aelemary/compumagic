const API_BASE = "/api";
const state = {
  catalog: [],
  companies: [],
};
let inventoryStatusEl = null;
let statusTimer = null;
const CATEGORY_LABELS = {
  laptop: "Laptops",
  gpu: "Graphics",
  cpu: "Processors",
  hdd: "Storage",
  motherboard: "Motherboards",
};
const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);

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

function setYear() {
  const yearEl = document.getElementById("year");
  if (yearEl) {
    yearEl.textContent = new Date().getFullYear();
  }
}

function showInventoryStatus(message, type = "success") {
  if (!inventoryStatusEl) return;
  if (statusTimer) {
    clearTimeout(statusTimer);
  }
  inventoryStatusEl.innerHTML = `<div class="toast ${type === "error" ? "error" : ""}">${message}</div>`;
  statusTimer = window.setTimeout(() => {
    inventoryStatusEl.innerHTML = "";
  }, 3000);
}

function populateCompanyFilter(companies = []) {
  const select = document.getElementById("filter-company");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">Any manufacturer</option>`;
  companies.forEach((company) => {
    const option = document.createElement("option");
    option.value = company.id;
    option.textContent = company.name;
    select.appendChild(option);
  });
  if (current && companies.find((company) => company.id === current)) {
    select.value = current;
  }
}

function createProductCard(product) {
  const card = document.createElement("article");
  card.className = "product-card";
  const typeLabel = CATEGORY_LABELS[product.type] || "Products";
  const brandLabel = product.company?.name || "Unassigned";
  const image =
    product.images?.[0] || `https://placehold.co/600x450?text=${encodeURIComponent(typeLabel)}`;
  const summary = product.shortName || product.description || "—";
  const specLeft =
    product.type === "laptop"
      ? `GPU: ${product.gpu || "n/a"}`
      : `Details: ${summary}`;
  const specRight =
    product.type === "laptop"
      ? `CPU: ${product.cpu || "n/a"}`
      : `Warranty: ${product.warranty ? `${product.warranty} yr` : "—"}`;
  card.innerHTML = `
    <div class="product-media">
      <img src="${image}" alt="${product.title}" loading="lazy" />
    </div>
    <div class="product-body">
      <span class="badge">${brandLabel} • ${typeLabel}</span>
      <h3 class="product-title">${product.title}</h3>
      <p class="product-summary">${summary}</p>
      <div class="product-meta">
        <div class="meta-row"><span>${specLeft}</span><span>${specRight}</span></div>
      </div>
    </div>
  `;
  const detailUrl = `/product.html?id=${encodeURIComponent(product.id)}`;
  card.dataset.href = detailUrl;
  card.addEventListener("click", () => {
    window.location.href = detailUrl;
  });
  return card;
}

function toggleEmptyState(hasResults) {
  const empty = document.getElementById("empty");
  if (!empty) return;
  empty.hidden = hasResults;
}

function updateStats() {
  const brandEl = document.getElementById("stat-brands");
  const productEl = document.getElementById("stat-products");
  const categoryEl = document.getElementById("stat-categories");
  const categories = new Set(state.catalog.map((item) => item.type).filter(Boolean));
  if (brandEl) brandEl.textContent = state.companies.length;
  if (productEl) productEl.textContent = state.catalog.length;
  if (categoryEl) categoryEl.textContent = categories.size;
}

function renderCategoryJumps(products) {
  const container = document.getElementById("category-jumps");
  if (!container) return;
  container.innerHTML = "";
  if (!products.length) {
    container.hidden = true;
    return;
  }

  const available = new Set(products.map((item) => item.type).filter(Boolean));
  const makeLink = (label, href, active = false) => {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = label;
    if (active) link.classList.add("active");
    return link;
  };

  container.appendChild(makeLink("All", "#catalog", true));
  CATEGORY_ORDER.forEach((type) => {
    if (!available.has(type)) return;
    container.appendChild(makeLink(CATEGORY_LABELS[type], `#category-${type}`));
  });

  const hasOther = products.some((item) => item.type && !CATEGORY_LABELS[item.type]);
  if (hasOther) {
    container.appendChild(makeLink("Other", "#category-other"));
  }

  const links = Array.from(container.querySelectorAll("a"));
  links.forEach((link) => {
    link.addEventListener("click", () => {
      links.forEach((item) => item.classList.remove("active"));
      link.classList.add("active");
    });
  });

  container.hidden = false;
}

async function loadInventory(params = {}) {
  const url = new URL(`${API_BASE}/products`, window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== "" && value != null) {
      url.searchParams.set(key, value);
    }
  });
  return fetchJSON(url.toString());
}

async function loadCompanies() {
  return fetchJSON(`${API_BASE}/companies`);
}

function renderProducts(products) {
  const results = document.getElementById("results");
  results.innerHTML = "";
  if (!products.length) {
    toggleEmptyState(false);
    return;
  }
  toggleEmptyState(true);
  const fragment = document.createDocumentFragment();
  const grouped = products.reduce((acc, product) => {
    const type = product.type || "other";
    if (!acc[type]) acc[type] = [];
    acc[type].push(product);
    return acc;
  }, {});
  Object.keys(CATEGORY_LABELS).forEach((type) => {
    const items = grouped[type] || [];
    if (!items.length) return;
    const section = document.createElement("section");
    section.className = "catalog-section";
    section.id = `category-${type}`;
    section.innerHTML = `
      <div class="catalog-heading">
        <h3>${CATEGORY_LABELS[type]}</h3>
        <span>${items.length} item${items.length > 1 ? "s" : ""}</span>
      </div>
      <div class="catalog-grid"></div>
    `;
    const grid = section.querySelector(".catalog-grid");
    items.forEach((product) => grid.appendChild(createProductCard(product)));
    fragment.appendChild(section);
  });
  const otherItems = Object.entries(grouped)
    .filter(([type]) => !CATEGORY_LABELS[type])
    .flatMap(([, items]) => items);
  if (otherItems.length) {
    const section = document.createElement("section");
    section.className = "catalog-section";
    section.id = "category-other";
    section.innerHTML = `
      <div class="catalog-heading">
        <h3>Other Products</h3>
        <span>${otherItems.length} item${otherItems.length > 1 ? "s" : ""}</span>
      </div>
      <div class="catalog-grid"></div>
    `;
    const grid = section.querySelector(".catalog-grid");
    otherItems.forEach((product) => grid.appendChild(createProductCard(product)));
    fragment.appendChild(section);
  }
  results.appendChild(fragment);
}

async function init() {
  setYear();
  inventoryStatusEl = document.getElementById("inventory-status");
  try {
    const inventoryPromise = loadInventory();
    const companiesPromise = loadCompanies().catch(() => []);
    const [inventory, companies] = await Promise.all([inventoryPromise, companiesPromise]);
    state.companies = companies || [];
    state.catalog = inventory || [];
    populateCompanyFilter(state.companies);
    renderProducts(state.catalog);
    renderCategoryJumps(state.catalog);
    updateStats();

    const form = document.getElementById("filter-form");
    const resetButton = document.getElementById("filter-reset");
    if (form) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const formData = new FormData(form);
        const params = Object.fromEntries(formData.entries());
        showInventoryStatus("Refreshing catalog…");
        const results = await loadInventory(params);
        state.catalog = results;
        renderProducts(results);
        renderCategoryJumps(results);
        updateStats();
        if (!results.length) {
          showInventoryStatus("No products matched that search.", "error");
        } else {
          showInventoryStatus("Catalog updated.");
        }
      });
    }
    if (resetButton && form) {
      resetButton.addEventListener("click", async () => {
        form.reset();
        populateCompanyFilter(state.companies);
        showInventoryStatus("Resetting filters…");
        const results = await loadInventory();
        state.catalog = results;
        renderProducts(results);
        renderCategoryJumps(results);
        updateStats();
        showInventoryStatus("Showing full catalog.");
      });
    }
  } catch (error) {
    console.error(error);
    showInventoryStatus("Could not load the catalog right now.", "error");
    const results = document.getElementById("results");
    results.innerHTML = `<div class="toast error">Catalog data isn't available yet. Please try again shortly.</div>`;
    toggleEmptyState(true);
  }
}

document.addEventListener("DOMContentLoaded", init);

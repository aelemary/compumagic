const API_BASE = "/api";
const TYPE_LABELS = {
  laptop: "Laptop",
  gpu: "Graphics",
  cpu: "Processor",
  hdd: "Storage",
  motherboard: "Motherboard",
};

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
      (url, index) =>
        `<figure class="gallery-slide" data-index="${index}">
          <img src="${url}" alt="${title} ${index + 1}" loading="${index === 0 ? "eager" : "lazy"}" />
        </figure>`
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
  return `<div class="spec-item"><span>${label}</span><strong>${value}</strong></div>`;
}

function renderProduct(product) {
  const layout = document.getElementById("product-detail");
  const specList = document.getElementById("spec-list");
  const typeLabel = TYPE_LABELS[product.type] || "Product";
  const warrantyLabel =
    product.warranty && product.warranty > 0
      ? `${product.warranty} year${product.warranty > 1 ? "s" : ""}`
      : "";
  const description = product.description
    ? `<p class="detail-description">${product.description}</p>`
    : "";

  const keySpecs = [];
  if (product.type === "laptop") {
    keySpecs.push(renderSpec("GPU", product.gpu));
    keySpecs.push(renderSpec("CPU", product.cpu));
    keySpecs.push(renderSpec("Memory", product.ram));
    keySpecs.push(renderSpec("Storage", product.storage));
    keySpecs.push(renderSpec("Display", product.display));
  }
  if (product.shortName) {
    keySpecs.push(renderSpec("Model", product.shortName));
  }
  if (warrantyLabel) {
    keySpecs.push(renderSpec("Warranty", warrantyLabel));
  }

  if (layout) {
    layout.innerHTML = `
      <span class="mobile-badge">${product.company?.name || "Unassigned"} • ${typeLabel}</span>
      <h1 class="detail-title">${product.title}</h1>
      ${description}
      ${renderImages(product.images, product.title)}
      <div class="spec-list">
        ${keySpecs.join("") || `<div class="field-hint">No specifications listed yet.</div>`}
      </div>
      <div class="hero-actions">
        <a class="btn btn-primary" href="/m/contact.html">Contact Operations</a>
        <a class="btn btn-outline" href="/m/index.html">Back to Catalog</a>
      </div>
    `;
  }

  if (specList) {
    const fullSpecs = [];
    if (product.type === "laptop") {
      fullSpecs.push(renderSpec("GPU", product.gpu || "—"));
      fullSpecs.push(renderSpec("CPU", product.cpu || "—"));
      fullSpecs.push(renderSpec("Memory", product.ram || "—"));
      fullSpecs.push(renderSpec("Storage", product.storage || "—"));
      fullSpecs.push(renderSpec("Display", product.display || "—"));
    }
    fullSpecs.push(renderSpec("Model", product.shortName || "—"));
    fullSpecs.push(renderSpec("Warranty", warrantyLabel || "—"));
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
  card.className = "mobile-card";
  const typeLabel = TYPE_LABELS[product.type] || "Product";
  const brandLabel = product.company?.name || "Unassigned";
  const image =
    product.images?.[0] || `https://placehold.co/600x450?text=${encodeURIComponent(typeLabel)}`;
  const summary = product.shortName || product.description || "—";
  card.innerHTML = `
    <img class="mobile-thumb" src="${image}" alt="${product.title}" loading="lazy" />
    <div class="mobile-content">
      <span class="mobile-badge">${brandLabel} • ${typeLabel}</span>
      <h3 class="mobile-title">${product.title}</h3>
      <p class="mobile-summary">${summary}</p>
    </div>
  `;
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

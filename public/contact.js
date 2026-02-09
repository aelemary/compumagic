const API_BASE = "/api";
const state = {
  contact: null,
  isAdmin: false,
};
let statusTimer = null;

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, { credentials: "include", ...options });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const data = JSON.parse(text);
      if (data && data.error) message = data.error;
    } catch (error) {
      // ignore parse issues
    }
    const error = new Error(message || `Request failed with status ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

function setYear() {
  const yearEl = document.getElementById("year");
  if (yearEl) {
    yearEl.textContent = new Date().getFullYear();
  }
}

function showStatus(message, type = "success") {
  const container = document.getElementById("contact-status");
  if (!container) return;
  if (statusTimer) {
    clearTimeout(statusTimer);
  }
  container.innerHTML = `<div class="toast ${type === "error" ? "error" : ""}">${message}</div>`;
  statusTimer = window.setTimeout(() => {
    container.innerHTML = "";
  }, 3000);
}

function renderContactDetails(contact) {
  document.querySelectorAll("[data-contact-field]").forEach((node) => {
    const field = node.getAttribute("data-contact-field");
    node.textContent = contact[field] || "—";
  });
  const availability = Array.isArray(contact.availability) ? contact.availability : [];
  const list = document.getElementById("contact-availability");
  if (list) {
    list.innerHTML = "";
    if (!availability.length) {
      const item = document.createElement("li");
      item.className = "field-hint";
      item.textContent = "No availability details published yet.";
      list.appendChild(item);
    } else {
      availability.forEach((line) => {
        const item = document.createElement("li");
        item.textContent = line;
        list.appendChild(item);
      });
    }
  }
}

function populateForm(contact) {
  const form = document.getElementById("contact-form");
  if (!form) return;
  form.elements.salesHotline.value = contact.salesHotline || "";
  form.elements.whatsapp.value = contact.whatsapp || "";
  form.elements.supportEmail.value = contact.supportEmail || "";
  form.elements.address.value = contact.address || "";
  form.elements.availability.value = Array.isArray(contact.availability)
    ? contact.availability.join("\n")
    : "";
}

function toggleEditor() {
  const panel = document.getElementById("contact-admin-panel");
  if (!panel) return;
  panel.hidden = !state.isAdmin;
}

function gatherFormData(form) {
  const formData = new FormData(form);
  const lines = (formData.get("availability") || "").split("\n");
  const availability = lines.map((line) => line.trim()).filter(Boolean);
  return {
    salesHotline: formData.get("salesHotline") || "",
    whatsapp: formData.get("whatsapp") || "",
    supportEmail: formData.get("supportEmail") || "",
    address: formData.get("address") || "",
    availability,
  };
}

async function saveContact(event) {
  event.preventDefault();
  if (!state.isAdmin) {
    showStatus("Only admins can update contact info.", "error");
    return;
  }
  const form = event.currentTarget;
  const payload = gatherFormData(form);
  try {
    showStatus("Saving contact info…");
    const updated = await fetchJSON(`${API_BASE}/contact`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.contact = updated;
    renderContactDetails(updated);
    populateForm(updated);
    showStatus("Contact details updated.");
  } catch (error) {
    console.error(error);
    if (error.status === 401 || error.status === 403) {
      showStatus("Please sign in as an admin to save these changes.", "error");
    } else {
      showStatus("Couldn't update contact info right now.", "error");
    }
  }
}

async function loadContact() {
  try {
    const contact = await fetchJSON(`${API_BASE}/contact`);
    state.contact = contact;
    renderContactDetails(contact);
    populateForm(contact);
  } catch (error) {
    console.error(error);
    const list = document.getElementById("contact-availability");
    if (list) {
      list.innerHTML = "";
      const item = document.createElement("li");
      item.className = "field-hint";
      item.textContent = "Contact info isn't loading right now.";
      list.appendChild(item);
    }
    showStatus("Couldn't load contact info.", "error");
  }
}

document.addEventListener("app:user", (event) => {
  state.isAdmin = event.detail && event.detail.role === "admin";
  toggleEditor();
});

document.addEventListener("DOMContentLoaded", () => {
  setYear();
  loadContact();
  const form = document.getElementById("contact-form");
  if (form) {
    form.addEventListener("submit", saveContact);
  }
  state.isAdmin = window.appUser && window.appUser.role === "admin";
  toggleEditor();
});

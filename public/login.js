function setYear() {
  const yearEl = document.getElementById("year");
  if (yearEl) {
    yearEl.textContent = new Date().getFullYear();
  }
}

function showStatus(message, type = "info") {
  const container = document.getElementById("login-status");
  if (!container) return;
  container.innerHTML = `<div class="toast${type === "error" ? " error" : ""}">${message}</div>`;
}

async function submitLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  try {
    showStatus("Signing in…");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      let message = text;
      try {
        const data = JSON.parse(text);
        if (data && data.error) message = data.error;
      } catch (error) {
        // ignore JSON parse errors
      }
      showStatus(message || "Login failed.", "error");
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const next = params.get("next") || "/";
    window.location.href = next;
  } catch (error) {
    showStatus("Network error while signing in. Please try again.", "error");
  }
}

function checkExistingUser() {
  if (window.appUser) {
    const params = new URLSearchParams(window.location.search);
    const next = params.get("next") || "/";
    window.location.replace(next);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  setYear();
  const form = document.getElementById("login-form");
  if (form) {
    form.addEventListener("submit", submitLogin);
  }
  if (window.appUser) {
    checkExistingUser();
  }
});

document.addEventListener("app:user", () => {
  checkExistingUser();
});

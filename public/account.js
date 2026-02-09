function setYear() {
  const yearEl = document.getElementById("year");
  if (yearEl) {
    yearEl.textContent = new Date().getFullYear();
  }
}

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

function showStatus(message, type = "info") {
  const container = document.getElementById("account-status");
  if (!container) return;
  container.innerHTML = message
    ? `<div class="toast${type === "error" ? " error" : ""}">${message}</div>`
    : "";
}

function renderProfile(user) {
  const details = document.getElementById("account-details");
  if (!details) return;
  details.hidden = false;
  details.querySelector("[data-account-field='username']").textContent = user.username || "—";
  details.querySelector("[data-account-field='fullName']").textContent = user.fullName || "—";
  details.querySelector("[data-account-field='role']").textContent = user.role || "—";
}

async function loadProfile() {
  try {
    const data = await fetchJSON("/api/auth/me");
    if (!data.authenticated || !data.user) {
      showStatus(
        'Please <a href="/login.html?next=/account.html" style="color: inherit; text-decoration: underline;">sign in</a> to view your profile.',
        "error"
      );
      return;
    }
    showStatus("");
    renderProfile(data.user);
  } catch (error) {
    if (error.status === 401) {
      showStatus(
        'Please <a href="/login.html?next=/account.html" style="color: inherit; text-decoration: underline;">sign in</a> to view your profile.',
        "error"
      );
    } else {
      showStatus("Could not load your profile. Please try again later.", "error");
    }
  }
}

function handleUserUpdate(event) {
  const user = event.detail;
  if (!user) {
    showStatus(
      'Please <a href="/login.html?next=/account.html" style="color: inherit; text-decoration: underline;">sign in</a> to view your profile.',
      "error"
    );
    return;
  }
  showStatus("");
  renderProfile(user);
}

document.addEventListener("DOMContentLoaded", () => {
  setYear();
  loadProfile();
});

document.addEventListener("app:user", handleUserUpdate);

(function () {
  const state = {
    user: null,
  };

  function setUser(user) {
    state.user = user;
    window.appUser = user;
    document.dispatchEvent(new CustomEvent("app:user", { detail: user }));
    updateNav();
  }

  async function fetchCurrentUser() {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (!res.ok) {
        setUser(null);
        return;
      }
      const data = await res.json();
      setUser(data.authenticated ? data.user : null);
    } catch (error) {
      setUser(null);
    }
  }

  function updateNav() {
    const authLink = document.getElementById("nav-auth");
    const adminLinks = document.querySelectorAll("[data-requires-role='admin']");
    const signupLink = document.getElementById("nav-signup");
    const userLabel = document.getElementById("nav-user");

    if (authLink) {
      if (state.user) {
        authLink.textContent = "Logout";
        authLink.href = "#";
        authLink.setAttribute("data-action", "logout");
      } else {
        authLink.textContent = "Login";
        authLink.href = "/login.html";
        authLink.removeAttribute("data-action");
      }
    }

    if (signupLink) {
      signupLink.style.display = state.user ? "none" : "";
    }

    if (userLabel) {
      if (state.user) {
        const name = state.user.fullName || state.user.username;
        userLabel.textContent = `Signed in: ${name}`;
        userLabel.hidden = false;
      } else {
        userLabel.textContent = "";
        userLabel.hidden = true;
      }
    }

    adminLinks.forEach((link) => {
      link.style.display = state.user && state.user.role === "admin" ? "" : "none";
    });
  }

  async function handleLogout(event) {
    event.preventDefault();
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch (error) {
      // ignore network errors on logout
    }
    setUser(null);
    window.location.href = "/login.html";
  }

  function handleAuthLinkClick(event) {
    const authLink = event.currentTarget;
    if (authLink.getAttribute("data-action") === "logout") {
      handleLogout(event);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const authLink = document.getElementById("nav-auth");
    if (authLink) {
      authLink.addEventListener("click", handleAuthLinkClick);
    }
    updateNav();
    fetchCurrentUser();
  });
})();

(() => {
  const links = document.querySelectorAll("[data-desktop-link]");
  if (!links.length) return;

  const current = window.location.pathname.startsWith("/m/")
    ? window.location.pathname.replace("/m", "")
    : window.location.pathname;

  const basePath = current === "/" ? "/index.html" : current;
  const params = new URLSearchParams(window.location.search);
  params.set("view", "desktop");
  const qs = params.toString();
  const target = `${basePath}${qs ? `?${qs}` : ""}`;

  links.forEach((link) => {
    link.setAttribute("href", target);
  });
})();

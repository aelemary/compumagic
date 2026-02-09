(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("view") === "desktop") return;
  if (window.location.pathname.startsWith("/m/")) return;

  const isMobile =
    window.matchMedia("(max-width: 820px)").matches ||
    window.matchMedia("(pointer: coarse)").matches;

  if (!isMobile) return;

  const currentPath = window.location.pathname === "/" ? "/index.html" : window.location.pathname;
  const target = `/m${currentPath}`;
  params.delete("view");
  const next = new URL(target, window.location.origin);
  const qs = params.toString();
  next.search = qs ? `?${qs}` : "";
  window.location.replace(next.toString());
})();

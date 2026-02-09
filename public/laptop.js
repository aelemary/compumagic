(() => {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  if (id) {
    window.location.replace(`/product.html?id=${encodeURIComponent(id)}`);
  } else {
    window.location.replace("/index.html");
  }
})();

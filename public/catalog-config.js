window.CATALOG_CATEGORIES = [
  { type: "laptop", label: "Laptops", singular: "Laptop" },
  { type: "gpu", label: "Graphics Cards", singular: "Graphics" },
  { type: "cpu", label: "Processors", singular: "Processor" },
  { type: "storage", label: "Storage", singular: "Storage" },
  { type: "motherboard", label: "Motherboards", singular: "Motherboard" },
  { type: "ram", label: "Memory", singular: "Memory" },
  { type: "monitor", label: "Monitors", singular: "Monitor" },
  { type: "printer", label: "Printers", singular: "Printer" },
  { type: "desktop", label: "Desktops", singular: "Desktop" },
  { type: "power", label: "Power", singular: "Power" },
  { type: "accessory", label: "Accessories", singular: "Accessory" },
  { type: "other", label: "Other Products", singular: "Product" },
];

window.getCatalogCategory = (type) => {
  const normalized = type === "hdd" ? "storage" : type;
  return (
    window.CATALOG_CATEGORIES.find((category) => category.type === normalized) || {
      type: normalized || "other",
      label: "Other Products",
      singular: "Product",
    }
  );
};

window.catalogPlaceholder = (label = "Product") =>
  `https://placehold.co/600x450/e0e9f6/0a2e5d?text=${encodeURIComponent(label)}`;

window.catalogImageUrl = (url, { width = 420, height = 315, quality = 68 } = {}) => {
  if (!url) return "";
  if (/placehold\.co/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("images.weserv.nl")) return url;
    const target = `${parsed.hostname}${parsed.pathname}${parsed.search}`;
    return `https://images.weserv.nl/?url=${encodeURIComponent(target)}&w=${width}&h=${height}&fit=contain&output=webp&q=${quality}`;
  } catch (error) {
    return url;
  }
};

window.catalogSummary = (product) => {
  const title = String(product.title || "").trim().toLowerCase();
  const values = [product.shortName, product.description, product.storage, product.ram]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return values.find((value) => value.toLowerCase() !== title) || "";
};

const normalizeSpecLabel = (value = "") =>
  String(value || "")
    .toLowerCase()
    .replace(/[_/-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

window.catalogSpecFields = (type = "") => {
  const normalized = window.getCatalogCategory(type).type;
  const fields = {
    laptop: [
      { label: "Processor", keys: ["Processor model", "Processor family", "CPU"] },
      { label: "Graphics", keys: ["Discrete graphics card model", "Graphics adapter", "GPU"] },
      { label: "Memory", keys: ["Internal memory", "RAM"] },
      { label: "Storage", keys: ["Total storage capacity", "SSD capacity", "Storage"] },
      { label: "Display", keys: ["Display diagonal", "Display resolution", "Display"] },
      { label: "Operating System", keys: ["Operating system installed"] },
      { label: "Battery", keys: ["Battery capacity", "Battery technology"] },
      { label: "Weight", keys: ["Weight"] },
    ],
    gpu: [
      { label: "Graphics Processor", keys: ["Graphics processor", "Graphics processor family", "GPU"] },
      { label: "Memory", keys: ["Discrete graphics card memory", "Graphics card memory", "Memory"] },
      { label: "Memory Type", keys: ["Graphics card memory type", "GDDR", "Memory type"] },
      { label: "Memory Bus", keys: ["Memory bus"] },
      { label: "Interface", keys: ["Interface type", "PCI Express"] },
      { label: "CUDA", keys: ["CUDA"] },
      { label: "HDMI", keys: ["HDMI ports quantity"] },
      { label: "DisplayPort", keys: ["DisplayPorts quantity"] },
      { label: "Power", keys: ["Minimum system power supply", "Supplementary power connectors"] },
      { label: "Cooling", keys: ["Cooling type"] },
    ],
    cpu: [
      { label: "Family", keys: ["Processor family"] },
      { label: "Model", keys: ["Processor model", "CPU"] },
      { label: "Cores", keys: ["Processor cores"] },
      { label: "Threads", keys: ["Processor threads"] },
      { label: "Socket", keys: ["Processor socket"] },
      { label: "Cache", keys: ["Processor cache"] },
      { label: "Base Frequency", keys: ["Processor base frequency"] },
      { label: "Boost Frequency", keys: ["Processor boost frequency"] },
      { label: "TDP", keys: ["Thermal Design Power", "Processor base power"] },
    ],
    storage: [
      { label: "Capacity", keys: ["SSD capacity", "HDD capacity", "Total storage capacity", "Storage"] },
      { label: "Interface", keys: ["Interface"] },
      { label: "Form Factor", keys: ["SSD form factor", "HDD size"] },
      { label: "Read Speed", keys: ["Read speed", "Sequential read speed"] },
      { label: "Write Speed", keys: ["Write speed", "Sequential write speed"] },
      { label: "NVMe", keys: ["NVMe"] },
      { label: "Component For", keys: ["Component for"] },
    ],
    motherboard: [
      { label: "Socket", keys: ["Processor socket"] },
      { label: "Chipset", keys: ["Motherboard chipset"] },
      { label: "Form Factor", keys: ["Motherboard form factor"] },
      { label: "Memory Slots", keys: ["Memory slots"] },
      { label: "Memory Type", keys: ["Supported memory types"] },
      { label: "Max Memory", keys: ["Maximum internal memory"] },
      { label: "Networking", keys: ["Ethernet LAN", "Wi-Fi"] },
    ],
    ram: [
      { label: "Capacity", keys: ["Internal memory", "RAM"] },
      { label: "Type", keys: ["Internal memory type", "Memory type"] },
      { label: "Speed", keys: ["Memory clock speed"] },
      { label: "Layout", keys: ["Memory layout"] },
      { label: "CAS Latency", keys: ["CAS latency"] },
      { label: "Component For", keys: ["Component for"] },
    ],
    monitor: [
      { label: "Size", keys: ["Display diagonal", "Display"] },
      { label: "Resolution", keys: ["Display resolution"] },
      { label: "Panel", keys: ["Panel type"] },
      { label: "HD Type", keys: ["HD type"] },
      { label: "Refresh Rate", keys: ["Maximum refresh rate"] },
      { label: "Response Time", keys: ["Response time"] },
      { label: "Brightness", keys: ["Display brightness"] },
    ],
    printer: [
      { label: "Technology", keys: ["Print technology"] },
      { label: "Colour", keys: ["Colour"] },
      { label: "Resolution", keys: ["Maximum resolution"] },
      { label: "Speed", keys: ["Print speed"] },
      { label: "Duplex", keys: ["Duplex printing"] },
      { label: "Wireless", keys: ["Wi-Fi"] },
      { label: "Ethernet", keys: ["Ethernet LAN"] },
    ],
    desktop: [
      { label: "Processor", keys: ["Processor model", "Processor family", "CPU"] },
      { label: "Memory", keys: ["Internal memory", "RAM"] },
      { label: "Storage", keys: ["Total storage capacity", "SSD capacity", "Storage"] },
      { label: "Graphics", keys: ["Discrete graphics card model", "Graphics card", "GPU"] },
      { label: "Operating System", keys: ["Operating system installed"] },
    ],
    power: [
      { label: "Power", keys: ["Total power"] },
      { label: "Efficiency", keys: ["80 PLUS certification"] },
      { label: "Connector", keys: ["Motherboard power connector"] },
      { label: "Cooling", keys: ["Cooling type"] },
    ],
  };
  return (
    fields[normalized] || [
      { label: "Model", keys: ["Model", "Product name"] },
      { label: "Brand", keys: ["Brand"] },
      { label: "Category", keys: ["Category"] },
      { label: "Key Feature", keys: ["Product colour", "Colour"] },
    ]
  );
};

window.catalogPickSpec = (product, keys = []) => {
  const specs = product?.specs && typeof product.specs === "object" ? product.specs : {};
  const normalizedKeys = keys.map(normalizeSpecLabel).filter(Boolean);
  const entries = Object.entries(specs);
  for (const key of keys) {
    const direct = product?.[String(key).toLowerCase()];
    if (direct) return direct;
  }
  for (const [label, value] of entries) {
    const valueText = String(value || "").trim();
    if (!valueText) continue;
    const normalizedLabel = normalizeSpecLabel(label);
    if (normalizedKeys.some((key) => normalizedLabel === key)) return valueText;
  }
  for (const [label, value] of entries) {
    const valueText = String(value || "").trim();
    if (!valueText) continue;
    const normalizedLabel = normalizeSpecLabel(label);
    if (normalizedKeys.some((key) => normalizedLabel.includes(key))) return valueText;
  }
  return "";
};

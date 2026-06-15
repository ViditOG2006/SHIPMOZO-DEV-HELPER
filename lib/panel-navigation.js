const fs = require("fs");
const path = require("path");

const NAV_MAP_PATH = path.join(__dirname, "..", "data", "panel-navigation.json");
const PANEL_BASE = process.env.SHIPMOZO_PANEL_URL || "https://panel.appiify.com";

/** Minimal fallback when JSON is missing; full map lives in data/panel-navigation.json */
function defaultNavigationMap() {
  const pages = [
    { text: "Dashboard", href: `${PANEL_BASE}/dashboard`, keywords: ["dashboard", "home", "analytics"] },
    { text: "New Orders", href: `${PANEL_BASE}/orders/new`, keywords: ["new", "orders", "order"] },
    { text: "All Orders", href: `${PANEL_BASE}/orders/all`, keywords: ["all", "orders"] },
    { text: "Billing", href: `${PANEL_BASE}/billing`, keywords: ["billing", "invoice", "payment"] },
    { text: "Wallet", href: `${PANEL_BASE}/wallet`, keywords: ["wallet", "recharge"] },
    { text: "Channels", href: `${PANEL_BASE}/channels`, keywords: ["channels", "channel"] },
    { text: "Shopify", href: `${PANEL_BASE}/channels/shopify`, keywords: ["shopify", "store"] },
    { text: "Integrations", href: `${PANEL_BASE}/integrations`, keywords: ["integrations"] },
    { text: "NDR", href: `${PANEL_BASE}/ndr`, keywords: ["ndr", "delivery"] },
    { text: "Settings", href: `${PANEL_BASE}/settings`, keywords: ["settings", "account"] },
    { text: "Tickets", href: `${PANEL_BASE}/tickets`, keywords: ["tickets", "support"] },
  ];
  return { version: 1, baseUrl: PANEL_BASE, source: "default", pageCount: pages.length, pages };
}

function loadNavigationMap() {
  try {
    if (fs.existsSync(NAV_MAP_PATH)) {
      const data = JSON.parse(fs.readFileSync(NAV_MAP_PATH, "utf-8"));
      if (data.pages?.length) return data;
    }
  } catch {
    /* use default */
  }
  return defaultNavigationMap();
}

function getNavigationMapPath() {
  return NAV_MAP_PATH;
}

module.exports = {
  loadNavigationMap,
  getNavigationMapPath,
  defaultNavigationMap,
  PANEL_BASE,
};

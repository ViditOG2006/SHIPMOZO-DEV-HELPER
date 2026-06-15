/** Default frontend scenarios paired with Postman collection folders. */

const FOLDER_UI_PAIRS = {
  "00_Setup_And_Auth": [
    {
      id: "UI-LOGIN-SMOKE",
      title: "Panel login — dashboard after sign in",
      category: "e2e",
      type: "happy_path",
      priority: "critical",
      module: "Login & Auth",
      description: "UI validation paired with Login API tests",
      inputs: {
        e2eFlow: "panel_login_smoke",
        useLivePanel: true,
        pairedApiFolder: "00_Setup_And_Auth",
      },
      expectedResults: {
        uiMustContain: ["order", "dashboard"],
      },
      tags: ["frontend-paired", "login"],
    },
  ],
  "02_Order_APIs": [
    {
      id: "UI-ORDERS-LIST",
      title: "New Orders — list and filters visible",
      category: "e2e",
      type: "happy_path",
      priority: "high",
      module: "Orders",
      description: "UI check paired with Order API tests",
      inputs: {
        e2eFlow: "panel_ui_check",
        moduleQuery: "new orders",
        verifyTexts: ["order", "filter", "search"],
        checkNotes: "New Orders page loads with list/filters",
        pairedApiFolder: "02_Order_APIs",
        useLivePanel: true,
      },
      tags: ["frontend-paired", "orders"],
    },
  ],
  "01_Warehouse_APIs": [
    {
      id: "UI-WAREHOUSE",
      title: "Warehouses — settings page opens",
      category: "e2e",
      type: "happy_path",
      priority: "medium",
      module: "Warehouse",
      inputs: {
        e2eFlow: "panel_ui_check",
        moduleQuery: "warehouse",
        verifyTexts: ["warehouse", "address", "pin"],
        pairedApiFolder: "01_Warehouse_APIs",
        useLivePanel: true,
      },
      tags: ["frontend-paired"],
    },
  ],
  "05_Utility_APIs": [
    {
      id: "UI-RATE-CALC",
      title: "Rate Calculator — form opens",
      category: "e2e",
      type: "happy_path",
      priority: "critical",
      module: "Rate Calculator",
      description: "UI check paired with Rate Calculator API tests",
      inputs: {
        e2eFlow: "rate_calculator_open",
        moduleName: "Rate Calculator",
        pairedApiFolder: "05_Utility_APIs",
        useLivePanel: true,
      },
      expectedResults: {
        uiMustContain: ["pincode", "calculate"],
      },
      tags: ["frontend-paired", "rate-calculator"],
    },
    {
      id: "UI-RATE-CALC-DOM",
      title: "Rate Calculator — domestic happy path",
      category: "e2e",
      type: "happy_path",
      priority: "high",
      module: "Rate Calculator",
      description: "Fill domestic form and calculate rates",
      inputs: {
        e2eFlow: "rate_calculator_domestic_happy",
        moduleName: "Rate Calculator",
        formData: {
          serviceType: "domestic",
          originPincode: "110059",
          deliveryPincode: "110058",
          weightKg: "20",
          invoiceValue: "20000",
          length: "100",
          width: "100",
          height: "100",
        },
        pairedApiFolder: "05_Utility_APIs",
        useLivePanel: true,
        captureScreens: true,
      },
      expectedResults: {
        uiMustContain: ["courier", "rate"],
      },
      tags: ["frontend-paired", "rate-calculator"],
    },
  ],
};

function uiScenariosForFolders(folderIds = [], { startId = 1 } = {}) {
  const out = [];
  let n = startId;
  for (const fid of folderIds) {
    const key = String(fid || "").trim();
    const templates = FOLDER_UI_PAIRS[key];
    if (!templates?.length) continue;
    for (const t of templates) {
      out.push({
        ...t,
        id: t.id || `UI-PAIR-${String(n).padStart(3, "0")}`,
        inputs: { ...t.inputs, pairedApiFolder: key },
      });
      n += 1;
    }
  }
  return out;
}

module.exports = { FOLDER_UI_PAIRS, uiScenariosForFolders };

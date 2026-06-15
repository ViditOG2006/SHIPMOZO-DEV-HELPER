const { buildRateCalculatorE2eDataset } = require("../lib/rate-calculator-dataset");
const { saveDataset } = require("../lib/test-dataset-store");

const dataset = buildRateCalculatorE2eDataset();
saveDataset(dataset);
console.log(`Saved Rate Calculator E2E dataset: ${dataset.id}`);
console.log(`Scenarios: ${dataset.scenarioCount} (${dataset.coverageMatrix.byCategory.e2e} E2E + ${dataset.coverageMatrix.byCategory.chat} Chat)`);

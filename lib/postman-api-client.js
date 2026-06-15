const POSTMAN_API = "https://api.getpostman.com";

function postmanApiKey() {
  const key = String(process.env.POSTMAN_API_KEY || "").trim();
  if (!key) throw new Error("POSTMAN_API_KEY is required");
  return key;
}

async function postmanGet(path) {
  const res = await fetch(`${POSTMAN_API}${path}`, {
    headers: { "X-Api-Key": postmanApiKey() },
    signal: AbortSignal.timeout(Number(process.env.POSTMAN_API_TIMEOUT_MS || 120000)),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    throw new Error(data?.error?.message || data?.message || `Postman API ${res.status}: ${path}`);
  }
  return data;
}

async function fetchPostmanCollection(collectionId) {
  const id = String(collectionId || "").trim();
  if (!id) throw new Error("collectionId is required");
  const data = await postmanGet(`/collections/${encodeURIComponent(id)}`);
  const collection = data.collection || data;
  if (!collection?.item?.length && !collection?.requests?.length) {
    throw new Error(`Postman collection ${id} has no requests`);
  }
  return collection;
}

async function fetchPostmanEnvironment(environmentId) {
  const id = String(environmentId || "").trim();
  if (!id) return null;
  const data = await postmanGet(`/environments/${encodeURIComponent(id)}`);
  return data.environment || data;
}

module.exports = {
  fetchPostmanCollection,
  fetchPostmanEnvironment,
};

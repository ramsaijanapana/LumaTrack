async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message =
      typeof payload === "object" && payload && typeof payload.error === "string"
        ? payload.error
        : `Request failed with status ${response.status}.`;
    throw new Error(message);
  }

  return payload;
}

export function fetchBootstrap() {
  return requestJson("./api/bootstrap");
}

export function registerAccount(input) {
  return requestJson("./api/auth/register", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function loginAccount(input) {
  return requestJson("./api/auth/login", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function logoutAccount() {
  return requestJson("./api/auth/logout", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function fetchState() {
  return requestJson("./api/state");
}

export function saveState(state) {
  return requestJson("./api/state", {
    method: "PUT",
    body: JSON.stringify({ state })
  });
}

export function searchMetadata(query, kind = "all") {
  const params = new URLSearchParams({ q: query, kind });
  return requestJson(`./api/metadata/search?${params.toString()}`);
}

export function fetchTokens() {
  return requestJson("./api/tokens");
}

export function createToken(label) {
  return requestJson("./api/tokens", {
    method: "POST",
    body: JSON.stringify({ label })
  });
}

export function deleteToken(tokenId) {
  return requestJson(`./api/tokens/${tokenId}`, {
    method: "DELETE"
  });
}

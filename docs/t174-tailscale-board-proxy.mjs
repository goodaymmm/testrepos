import http from "node:http";

const listenHost = "127.0.0.1";
const listenPort = readPort(process.env.KAIRON_T174_BOARD_PROXY_PORT, 18779);
const upstreamBaseUrl = readHttpUrl(
  "KAIRON_T174_BOARD_UPSTREAM",
  process.env.KAIRON_T174_BOARD_UPSTREAM ?? "http://127.0.0.1:18778/"
);
const externalBaseUrl = readHttpsUrl(
  "KAIRON_T174_BOARD_EXTERNAL_URL",
  process.env.KAIRON_T174_BOARD_EXTERNAL_URL
);
const boardToken = readRequired("KAIRON_T174_BOARD_TOKEN");

const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, "Method not allowed");
      return;
    }

    const identity = readSingleHeader(
      request.headers["tailscale-user-login"]
    )?.trim();
    if (!identity) {
      send(response, 401, "Tailscale identity required");
      return;
    }

    const incomingUrl = new URL(request.url ?? "/", "http://proxy.invalid");
    const upstreamUrl = new URL(
      `${incomingUrl.pathname}${incomingUrl.search}`,
      upstreamBaseUrl
    );
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: {
        Accept: readSingleHeader(request.headers.accept) ?? "text/html,*/*;q=0.8",
        Authorization: `Bearer ${boardToken}`,
        Origin: externalBaseUrl.origin,
        "Tailscale-User-Login": identity,
        "User-Agent":
          readSingleHeader(request.headers["user-agent"]) ??
          "kairon-t174-tailscale-board-proxy",
        "X-Forwarded-Host": externalBaseUrl.host,
        "X-Forwarded-Port": String(externalBaseUrl.port || "443"),
        "X-Forwarded-Proto": "https"
      },
      redirect: "manual"
    });

    copyResponseHeader(upstreamResponse, response, "content-type");
    copyResponseHeader(upstreamResponse, response, "cache-control");
    copyResponseHeader(upstreamResponse, response, "retry-after");
    response.setHeader("X-Kairon-Identity-Enforced", "verified");
    response.writeHead(upstreamResponse.status);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    response.end(Buffer.from(await upstreamResponse.arrayBuffer()));
  } catch {
    send(response, 502, "Upstream unavailable");
  }
});

server.listen(listenPort, listenHost, () => {
  console.log("Kairon T174 Tailscale Board proxy started.");
  console.log(`proxy.url=http://${listenHost}:${listenPort}/`);
  console.log(`proxy.external_origin=${externalBaseUrl.origin}`);
  console.log(`proxy.upstream=${upstreamBaseUrl.origin}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

function readRequired(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function readPort(value, fallback) {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("KAIRON_T174_BOARD_PROXY_PORT is invalid.");
  }
  return parsed;
}

function readHttpUrl(name, value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTP URL without credentials.`);
  }
  return parsed;
}

function readHttpsUrl(name, value) {
  const parsed = new URL(readRequired(name));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTPS URL without credentials.`);
  }
  return parsed;
}

function readSingleHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function copyResponseHeader(source, target, name) {
  const value = source.headers.get(name);
  if (value !== null) {
    target.setHeader(name, value);
  }
}

function send(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(body);
}

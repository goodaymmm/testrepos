import http from "node:http";

const listenHost = "127.0.0.1";
const listenPort = readPort(
  process.env.KAIRON_T174_DISCORD_PROXY_PORT,
  18776
);
const upstream = new URL(
  process.env.KAIRON_T174_DISCORD_UPSTREAM ??
    "http://127.0.0.1:18777/"
);
const externalHost = readRequired("KAIRON_T174_DISCORD_EXTERNAL_HOST");

if (upstream.protocol !== "http:" || upstream.username || upstream.password) {
  throw new Error(
    "KAIRON_T174_DISCORD_UPSTREAM must be an HTTP URL without credentials."
  );
}

const server = http.createServer((request, response) => {
  const headers = { ...request.headers };
  delete headers.host;
  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-port"];
  delete headers["x-forwarded-proto"];

  headers.host = upstream.host;
  headers["x-forwarded-host"] = externalHost;
  headers["x-forwarded-port"] = "443";
  headers["x-forwarded-proto"] = "https";

  const upstreamRequest = http.request(
    new URL(request.url ?? "/", upstream),
    {
      method: request.method,
      headers
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.headers
      );
      upstreamResponse.pipe(response);
    }
  );

  upstreamRequest.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      });
    }
    response.end('{"error":"upstream_unavailable"}');
  });

  request.pipe(upstreamRequest);
});

server.listen(listenPort, listenHost, () => {
  console.log("Kairon T174 Tailscale Discord proxy started.");
  console.log(`proxy.url=http://${listenHost}:${listenPort}/`);
  console.log(`proxy.upstream=${upstream.origin}`);
  console.log(`proxy.external_host=${externalHost}`);
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
    throw new Error("KAIRON_T174_DISCORD_PROXY_PORT is invalid.");
  }
  return parsed;
}

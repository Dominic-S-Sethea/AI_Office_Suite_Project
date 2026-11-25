import { createApiApp } from "./app.ts";

const port = Number.parseInt(process.env.PORT ?? "4100", 10);
const host = (process.env.HOST || "127.0.0.1").trim();

const ALLOWED_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
if (process.env.NODE_ENV === "production" || !ALLOWED_LOOPBACK_HOSTS.has(host)) {
  throw new Error(
    `PROVISIONAL_AUTH_LOOPBACK_ONLY: Phase D1 prototype header authentication cannot bind to '${host}' or run in production mode.`,
  );
}

const app = createApiApp();
app.listen(port, host, () => {
  console.log(`AI Office Suite API (Phase D1 Prototype — Loopback Only) listening on http://${host}:${port}`);
});

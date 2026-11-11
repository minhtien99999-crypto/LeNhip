// Điểm chạy máy chủ tham chiếu LeNhip.
//   LENHIP_DEV=1 node src/main.ts          chạy thử cục bộ: issuer phát triển, dữ liệu tổng hợp, lịch và đèn giả lập
//   node src/main.ts                       cần LENHIP_OIDC_ISSUER, LENHIP_OIDC_AUDIENCE, LENHIP_OIDC_JWKS_FILE (khóa EC P-256)
// Biến khác: PORT (8787), HOST (127.0.0.1), LENHIP_DATA_DIR (./data), LENHIP_LOG=1 (log truy cập không có thân/query).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { publicKeyFromJwk } from "./core/crypto.ts";
import { createApp } from "./server/app.ts";

const dev = process.env.LENHIP_DEV === "1";
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
if (dev && !["127.0.0.1", "::1", "localhost"].includes(host)) {
  console.error("LENHIP_DEV=1 chỉ chạy trên localhost: issuer phát triển không được mở ra mạng.");
  process.exit(1);
}

let oidc;
if (!dev) {
  const issuer = process.env.LENHIP_OIDC_ISSUER;
  const audience = process.env.LENHIP_OIDC_AUDIENCE;
  const jwksFile = process.env.LENHIP_OIDC_JWKS_FILE;
  if (!issuer || !audience || !jwksFile) {
    console.error("Thiếu LENHIP_OIDC_ISSUER, LENHIP_OIDC_AUDIENCE hoặc LENHIP_OIDC_JWKS_FILE (hoặc đặt LENHIP_DEV=1 để chạy thử).");
    process.exit(1);
  }
  const jwks = JSON.parse(readFileSync(jwksFile, "utf8")) as { keys: { kid: string; kty: string; crv: string; x: string; y: string }[] };
  oidc = { issuer, audience, keys: new Map(jwks.keys.map((k) => [k.kid, publicKeyFromJwk(k)])) };
}

const app = createApp({ dataDir: process.env.LENHIP_DATA_DIR ?? "./data", dev, seed: dev, oidc });
const stop = app.start(1000);
const server = createServer((req, res) => void app.handle(req, res));
server.listen(port, host, () => console.log(`LeNhip ${dev ? "(chạy thử, dữ liệu tổng hợp) " : ""}tại http://${host}:${port}`));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stop();
    server.close(() => {
      app.close();
      process.exit(0);
    });
  });
}

import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "vite";

export const LAN_HOST = "10.21.1.227";
export const LAN_PORT = 5217;

export function isAllowedAddress(address) {
  if (typeof address !== "string") return false;
  const ipv4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return isIP(ipv4) === 4 && ipv4.startsWith("10.21.1.");
}

export function requireLanSource(req, res, next) {
  // Authorize only the actual socket peer; never Host, Forwarded or XFF.
  if (isAllowedAddress(req.socket.remoteAddress)) return next();
  res.writeHead(403, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end("Forbidden\n");
}

export async function startLanPreview() {
  return preview({
    root: fileURLToPath(new URL("../", import.meta.url)),
    // No project plugins/proxies can precede the ACL or widen the listener.
    configFile: false,
    envDir: false,
    plugins: [{
      name: "lan-socket-source-acl",
      enforce: "pre",
      configurePreviewServer(server) {
        server.middlewares.use(requireLanSource);
      },
    }],
    build: { outDir: "dist" },
    preview: {
      host: LAN_HOST,
      port: LAN_PORT,
      strictPort: true,
      open: false,
      cors: false,
      proxy: {},
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = await startLanPreview();
    console.log(`LAN preview: http://${LAN_HOST}:${LAN_PORT} (socket peers 10.21.1.0/24 only)`);
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        server.httpServer.close(() => process.exit(0));
        server.httpServer.closeAllConnections();
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "LAN preview failed");
    process.exitCode = 1;
  }
}

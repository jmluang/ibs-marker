import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const sw = readFileSync(new URL("../public/sw.js", import.meta.url));
const shell = '<!doctype html><html><body><h1>Native SW fixture shell</h1></body></html>';
let fault = "none";
createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:15007");
  res.setHeader("cache-control", "no-store");
  if (url.pathname === "/__fixture/state" && req.method === "PUT") {
    let body = ""; for await (const chunk of req) body += chunk;
    fault = JSON.parse(body).fault;
    res.end("ok"); return;
  }
  if (url.pathname === "/external") {
    res.setHeader("content-type", "text/html");
    res.end('<a href="http://127.0.0.1:15007/?external=1">Open known app</a>'); return;
  }
  if (url.pathname === "/sw.js" && url.search === "?build=native-fixture") {
    res.setHeader("content-type", "text/javascript"); res.end(sw); return;
  }
  if (url.pathname === "/asset-manifest.json") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ buildId: "native-fixture", assets: ["/index.html"] })); return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    if (fault !== "none") {
      res.statusCode = fault === "non-html" ? 200 : fault === "unavailable" ? 503 : 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: "SYNTHETIC_DOCUMENT_FAILURE" })); return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8"); res.end(shell); return;
  }
  res.statusCode = 403; res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ code: "SYNTHETIC_BOUNDARY_DENIED" }));
}).listen(15007, "127.0.0.1");

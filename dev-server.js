/* Local dev server: serves the QuantPulse static bundle and mirrors the
   Netlify function at /api/quotes so live updates work without deploying.
   Usage:  node dev-server.js   →  http://localhost:8888                      */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || 8888;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Load the Netlify function as a module (exports.handler)
const fn = require(path.join(ROOT, "netlify/functions/quotes.js"));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  // API routes
  if (url.pathname === "/api/quotes" || url.pathname.startsWith("/.netlify/functions/")) {
    const qs = Object.fromEntries(url.searchParams.entries());
    const event = { httpMethod: "GET", queryStringParameters: qs, path: url.pathname };
    try {
      const result = await fn.handler(event);
      res.writeHead(result.statusCode, result.headers);
      res.end(result.body);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }
  // Static files
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  const full = path.join(ROOT, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, () => {
  console.log("QuantPulse test server → http://localhost:" + PORT);
  console.log("API mirror: http://localhost:" + PORT + "/api/quotes?symbols=AAPL&range=5d&interval=1d");
});

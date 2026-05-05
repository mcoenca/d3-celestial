const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright");

const HOST = "127.0.0.1";
const PORT = 4174;
const ROOT = path.resolve(__dirname, "..");

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "application/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    default: return "application/octet-stream";
  }
}

function serveStatic(req, res) {
  const requestPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const normalizedPath = requestPath === "/" ? "/demo/editor2.html" : requestPath;
  const fullPath = path.resolve(ROOT, "." + normalizedPath);

  if (!fullPath.startsWith(ROOT)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  fs.readFile(fullPath, (error, data) => {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": getMimeType(fullPath) });
    res.end(data);
  });
}

async function dispatchTouchDrag(client, from, to, steps) {
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from.x, y: from.y, radiusX: 4, radiusY: 4, force: 1 }]
  });

  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        radiusX: 4,
        radiusY: 4,
        force: 1
      }]
    });
  }

  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: []
  });
}

async function main() {
  const server = http.createServer(serveStatic);
  await new Promise((resolve) => server.listen(PORT, HOST, resolve));

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();

  try {
    await page.goto(`http://${HOST}:${PORT}/demo/editor2.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#draw-overlay", { timeout: 30000 });
    await page.waitForFunction(
      () => {
        const overlay = document.getElementById("draw-overlay");
        return !!(
          window.Celestial &&
          Celestial.mapProjection &&
          typeof Celestial.mapProjection.invert === "function" &&
          document.querySelector("#celestial-map canvas") &&
          overlay &&
          Number(overlay.getAttribute("width")) > 0
        );
      },
      { timeout: 30000 }
    );

    await page.evaluate(() => {
      const overlay = document.getElementById("draw-overlay");
      const width = Number(overlay.getAttribute("width"));
      const height = Number(overlay.getAttribute("height"));
      const p1 = Celestial.mapProjection.invert([width * 0.42, height * 0.54]);
      const p2 = Celestial.mapProjection.invert([width * 0.60, height * 0.46]);
      const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='26' fill='white'/></svg>";

      editorState.name = "Mobile icon drag";
      editorState.stars = [p1, p2];
      editorState.links = [[0, 1]];
      editorState.image = "data:image/svg+xml;base64," + btoa(svg);
      editorState.iconColor = "#ffffff";
      editorState.iconPlacement = { x: 0.5, y: 0, size: 1.2, rotation: 0 };
      selectedStarIndex = null;
      syncIconInputsFromPlacement();
      updateIconLabel();
      updateEditorBackgroundImage();
      Celestial.redraw();
    });

    await page.waitForSelector("#draw-overlay .icon-handle-pos", { timeout: 30000 });

    const before = await page.evaluate(() => ({
      stars: editorState.stars.length,
      placement: Object.assign({}, editorState.iconPlacement)
    }));
    assert.strictEqual(before.stars, 2, "Le scénario doit démarrer avec deux étoiles");

    const handleBox = await page.locator("#draw-overlay .icon-handle-pos").boundingBox();
    assert.ok(handleBox, "La poignée de position de l'icône est introuvable");

    const client = await context.newCDPSession(page);
    await dispatchTouchDrag(
      client,
      { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 },
      { x: handleBox.x + handleBox.width / 2 + 55, y: handleBox.y + handleBox.height / 2 + 32 },
      10
    );

    await page.waitForTimeout(300);

    const after = await page.evaluate(() => ({
      stars: editorState.stars.length,
      placement: Object.assign({}, editorState.iconPlacement),
      inputX: document.getElementById("icon-deltax").value,
      inputY: document.getElementById("icon-deltay").value
    }));

    assert.strictEqual(after.stars, 2, "Le drag tactile d'icône ne doit pas ajouter d'étoile");
    assert.ok(
      Math.abs(after.placement.x - before.placement.x) > 0.05 ||
      Math.abs(after.placement.y - before.placement.y) > 0.05,
      "Le drag tactile doit déplacer le vecteur de position de l'icône"
    );
    assert.strictEqual(Number(after.inputX).toFixed(2), Number(after.placement.x).toFixed(2));
    assert.strictEqual(Number(after.inputY).toFixed(2), Number(after.placement.y).toFixed(2));

    console.log("PASS editor2-mobile-icon-handles");
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error("FAIL editor2-mobile-icon-handles");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

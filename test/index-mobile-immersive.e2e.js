const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright");

const HOST = "127.0.0.1";
const PORT = 4175;
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
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
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
    touchPoints: [{ x: from.x, y: from.y, radiusX: 6, radiusY: 6, force: 1 }]
  });

  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        radiusX: 6,
        radiusY: 6,
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
    await page.goto(`http://${HOST}:${PORT}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#celestial-map canvas", { timeout: 30000 });
    await page.waitForFunction(
      () => !!(
        window.Celestial &&
        Celestial.mapProjection &&
        typeof Celestial.zoomBy === "function" &&
        document.querySelector("#celestial-map canvas") &&
        document.getElementById("celestial-map").__touchNavigationBound
      ),
      { timeout: 30000 }
    );

    const layout = await page.evaluate(() => {
      const menu = document.getElementById("top-menu").getBoundingClientRect();
      const mapWrap = document.getElementById("celestial-map-wrapper").getBoundingClientRect();
      const title = document.querySelector("h1").getBoundingClientRect();
      const info = document.querySelector(".info").getBoundingClientRect();
      return {
        menuTop: menu.top,
        menuHeight: menu.height,
        mapHeight: mapWrap.height,
        titleHidden: title.width <= 1 && title.height <= 1,
        infoHidden: info.width <= 1 && info.height <= 1,
        hasEditorLink: document.querySelector(".menu-link").getAttribute("href") === "demo/editor2.html",
        hasAlgoLink: Array.from(document.querySelectorAll(".menu-link")).some(
          (link) => link.getAttribute("href") === "demo/matching-lab.html"
        ),
        hasHomeIcon: !!document.querySelector(".sky-home .sky-icon")
      };
    });

    assert.strictEqual(Math.round(layout.menuTop), 0, "Le menu mobile doit rester collé en haut");
    assert.ok(layout.menuHeight <= 64, "Le menu mobile doit rester compact");
    assert.ok(layout.mapHeight >= 760, "La carte doit occuper presque toute la hauteur disponible");
    assert.ok(layout.titleHidden, "Le titre ne doit pas prendre de place sur mobile");
    assert.ok(layout.infoHidden, "La description ne doit pas prendre de place sur mobile");
    assert.ok(layout.hasEditorLink, "Le menu doit exposer le lien Éditeur");
    assert.ok(layout.hasAlgoLink, "Le menu doit exposer le lien Algo live");
    assert.ok(layout.hasHomeIcon, "Le menu doit exposer l'icône Ciel de Paris");

    const panelBefore = await page.evaluate(() => ({
      open: document.body.classList.contains("params-open"),
      expanded: document.getElementById("params-toggle").getAttribute("aria-expanded")
    }));
    assert.strictEqual(panelBefore.open, false);
    assert.strictEqual(panelBefore.expanded, "false");

    await page.click("#params-toggle");
    const panelOpen = await page.evaluate(() => ({
      open: document.body.classList.contains("params-open"),
      expanded: document.getElementById("params-toggle").getAttribute("aria-expanded"),
      visible: getComputedStyle(document.getElementById("celestial-params")).display !== "none"
    }));
    assert.strictEqual(panelOpen.open, true, "Le bouton doit ouvrir le tiroir de paramètres");
    assert.strictEqual(panelOpen.expanded, "true");
    assert.strictEqual(panelOpen.visible, true);

    await page.click("#params-close");
    const panelClosed = await page.evaluate(() => document.body.classList.contains("params-open"));
    assert.strictEqual(panelClosed, false, "Le bouton fermer doit refermer le tiroir");

    await page.evaluate(() => {
      const canvas = document.querySelector("#celestial-map canvas");
      const rect = canvas.getBoundingClientRect();
      Celestial.zoomBy(2, [rect.width / 2, rect.height / 2]);
    });

    const beforePan = await page.evaluate(() => ({
      zoom: Celestial.zoomBy(),
      translate: Celestial.mapProjection.translate().slice()
    }));
    assert.ok(beforePan.zoom > 1.8, "Le scénario doit être zoomé avant le pan tactile");

    const canvasBox = await page.locator("#celestial-map canvas").boundingBox();
    assert.ok(canvasBox, "Le canvas du ciel est introuvable");

    const client = await context.newCDPSession(page);
    await dispatchTouchDrag(
      client,
      { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 },
      { x: canvasBox.x + canvasBox.width / 2 + 58, y: canvasBox.y + canvasBox.height / 2 - 42 },
      10
    );

    await page.waitForTimeout(250);

    const afterPan = await page.evaluate(() => ({
      zoom: Celestial.zoomBy(),
      translate: Celestial.mapProjection.translate().slice()
    }));

    assert.ok(Math.abs(afterPan.zoom - beforePan.zoom) < 0.1, "Le drag à un doigt ne doit pas changer le zoom");
    assert.ok(
      Math.abs(afterPan.translate[0] - beforePan.translate[0]) > 10 ||
      Math.abs(afterPan.translate[1] - beforePan.translate[1]) > 10,
      "Le drag à un doigt doit déplacer la carte zoomée"
    );

    console.log("PASS index-mobile-immersive");
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error("FAIL index-mobile-immersive");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

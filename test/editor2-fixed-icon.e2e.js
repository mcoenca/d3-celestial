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
    default: return "application/octet-stream";
  }
}

function serveStatic(req, res) {
  const requestPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const fullPath = path.resolve(ROOT, "." + (requestPath === "/" ? "/demo/editor2.html" : requestPath));

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

async function main() {
  const server = http.createServer(serveStatic);
  await new Promise((resolve) => server.listen(PORT, HOST, resolve));

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const transparentIcon = "data:image/svg+xml;base64," + Buffer.from(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path fill='white' d='M32 4 60 60H4z'/></svg>"
  ).toString("base64");

  try {
    await page.goto(`http://${HOST}:${PORT}/demo/editor2.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#draw-overlay", { timeout: 30000 });
    await page.waitForFunction(
      () => !!document.querySelector("#draw-overlay rect.overlay-hit"),
      { timeout: 30000 }
    );

    await page.evaluate((icon) => {
      localStorage.clear();
      window.editorState.image = icon;
      window.editorState.iconColor = "#ffffff";
      window.updateEditorBackgroundImage();
      window.updateIconLabel();
      window.Celestial.redraw();
    }, transparentIcon);
    await page.waitForTimeout(500);

    const iconInfoBefore = await page.evaluate(() => window.getEditorIconRenderInfo());
    assert.ok(iconInfoBefore, "L'icône fixe doit être rendue avant le dessin");

    const overlay = page.locator("#draw-overlay");
    const clickAt = async (relX, relY) => {
      const box = await overlay.boundingBox();
      assert.ok(box, "Overlay non mesurable");
      await page.mouse.click(box.x + box.width * relX, box.y + box.height * relY);
    };

    await clickAt(0.35, 0.55);
    await clickAt(0.62, 0.42);
    await page.waitForTimeout(300);

    const iconInfoAfter = await page.evaluate(() => window.getEditorIconRenderInfo());
    assert.strictEqual(iconInfoAfter.cx, iconInfoBefore.cx, "Le centre X de l'icône doit rester fixe");
    assert.strictEqual(iconInfoAfter.cy, iconInfoBefore.cy, "Le centre Y de l'icône doit rester fixe");
    assert.strictEqual(iconInfoAfter.angle, iconInfoBefore.angle, "L'orientation de l'icône doit rester fixe");
    assert.strictEqual(iconInfoAfter.size, iconInfoBefore.size, "La taille ne change pas quand on pose des points");

    await page.fill("#constellation-name", "Editor2 Fixed Icon");
    const initialPlacement = await page.evaluate(() => {
      const placement = window.updateComputedIconPlacement();
      return Object.assign({}, placement);
    });
    assert.ok(initialPlacement, "Le dessin initial doit produire un placement d'icône");

    await page.evaluate(() => {
      const source = window.editorState.stars.map((point) => point.slice());
      const rotated = [
        source[0],
        [source[0][0] - (source[1][1] - source[0][1]), source[0][1] + (source[1][0] - source[0][0])]
      ];
      window.searchResults = [{ coords: rotated, ratio: 1, rms: 0, visibility: "visible" }];
      window.applyResult(0);
    });
    const placementAfterApply = await page.evaluate(() => Object.assign({}, window.editorState.iconPlacement));
    assert.deepStrictEqual(
      placementAfterApply,
      initialPlacement,
      "Appliquer une correspondance ne doit pas recalculer le placement de l'icône fixe"
    );

    const feature = await page.evaluate(() => window.buildFeature());
    assert.ok(feature && feature.properties && feature.properties.iconPlacement, "La sauvegarde doit calculer iconPlacement");
    assert.strictEqual(feature.properties.image, transparentIcon, "L'image doit être conservée");
    assert.strictEqual(typeof feature.properties.iconPlacement.x, "number");
    assert.strictEqual(typeof feature.properties.iconPlacement.y, "number");
    assert.strictEqual(typeof feature.properties.iconPlacement.size, "number");
    assert.strictEqual(typeof feature.properties.iconPlacement.rotation, "number");
    assert.ok(feature.properties.iconPlacement.size > 0, "La taille relative sauvegardée doit être positive");
    assert.deepStrictEqual(
      feature.properties.iconPlacement,
      initialPlacement,
      "La sauvegarde finale doit conserver le placement issu du dessin initial"
    );

    console.log("PASS editor2-fixed-icon");
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error("FAIL editor2-fixed-icon");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

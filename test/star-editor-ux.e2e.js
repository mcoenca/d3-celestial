const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const HOST = "127.0.0.1";
const PORT = 4173;
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
  const normalizedPath = requestPath === "/" ? "/demo/constellation-editor.html" : requestPath;
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

async function main() {
  const server = http.createServer(serveStatic);
  await new Promise((resolve) => server.listen(PORT, HOST, resolve));

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  try {
    await page.goto(`http://${HOST}:${PORT}/demo/constellation-editor.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#constellation-overlay", { timeout: 30000 });
    await page.waitForFunction(
      () => !!document.querySelector("#constellation-overlay rect.overlay-hit"),
      { timeout: 30000 }
    );

    // L'éditeur initialise son overlay après plusieurs timeouts; on laisse finir le rendu.
    await page.waitForTimeout(2000);

    const overlay = page.locator("#constellation-overlay");
    const overlayBox = await overlay.boundingBox();
    assert.ok(overlayBox, "Overlay introuvable");

    const clickAt = async (relX, relY, options) => {
      const box = await overlay.boundingBox();
      assert.ok(box, "Overlay non mesurable");
      const x = box.x + box.width * relX;
      const y = box.y + box.height * relY;
      await page.mouse.click(x, y, options);
    };

    const getStarCount = async () => {
      const raw = await page.locator("#star-count").textContent();
      return Number((raw || "").trim());
    };

    // 1) Ajout d'étoiles par clic.
    await clickAt(0.45, 0.55);
    await clickAt(0.58, 0.48);
    assert.strictEqual(await getStarCount(), 2, "Le compteur après ajout doit être 2");

    // 2) Drag d'une étoile.
    const beforeDrag = await page.evaluate(() => {
      const c = document.querySelector("#constellation-overlay .star-circle");
      return c ? { cx: Number(c.getAttribute("cx")), cy: Number(c.getAttribute("cy")) } : null;
    });
    assert.ok(beforeDrag, "Aucune étoile à déplacer");

    const start = {
      x: overlayBox.x + beforeDrag.cx,
      y: overlayBox.y + beforeDrag.cy
    };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 35, start.y + 25, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const afterDrag = await page.evaluate(() => {
      const c = document.querySelector("#constellation-overlay .star-circle");
      return c ? { cx: Number(c.getAttribute("cx")), cy: Number(c.getAttribute("cy")) } : null;
    });
    assert.ok(afterDrag, "Étoile absente après drag");
    const moved = Math.abs(afterDrag.cx - beforeDrag.cx) > 3 || Math.abs(afterDrag.cy - beforeDrag.cy) > 3;
    assert.ok(moved, "Le drag ne modifie pas la position visuelle de l'étoile");
    assert.strictEqual(await getStarCount(), 2, "Le compteur doit rester à 2 après drag");

    // 3) Suppression par clic droit.
    await page.locator("#constellation-overlay .star-circle").nth(1).click({ button: "right" });
    await page.waitForTimeout(200);
    assert.strictEqual(await getStarCount(), 1, "Le clic droit doit supprimer la dernière étoile");

    // 4) Re-ajout + sauvegarde.
    await clickAt(0.62, 0.40);
    assert.strictEqual(await getStarCount(), 2, "Le compteur après ré-ajout doit être 2");
    await page.fill("#constellation-name", "Test UX");
    await page.click("#btn-save");
    await page.waitForTimeout(150);
    assert.ok(
      dialogs.some((msg) => msg.includes("sauvegardée")),
      "La sauvegarde doit afficher un message de confirmation"
    );

    const savedCount = await page.evaluate(() => {
      const raw = localStorage.getItem("customConstellations");
      if (!raw) return 0;
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.length : 0;
      } catch (error) {
        return -1;
      }
    });
    assert.ok(savedCount >= 1, "La constellation n'a pas été persistée dans localStorage");

    // 5) Export JSON.
    const downloadPromise = page.waitForEvent("download", { timeout: 10000 });
    await page.click("#btn-export");
    const download = await downloadPromise;
    assert.strictEqual(download.suggestedFilename(), "custom-stars.json");

    const downloadPath = path.join(os.tmpdir(), "custom-stars.json");
    await download.saveAs(downloadPath);
    const content = JSON.parse(fs.readFileSync(downloadPath, "utf8"));
    assert.ok(Array.isArray(content.constellations), "Le JSON exporté doit contenir un tableau constellations");

    console.log("PASS star-editor-ux");
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error("FAIL star-editor-ux");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

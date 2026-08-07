const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright");

const HOST = "127.0.0.1";
const PORT = 4177;
const ROOT = path.resolve(__dirname, "..");

function mimeType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "application/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function serve(req, res) {
  const requestPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const normalized = requestPath === "/" ? "/demo/matching-lab.html" : requestPath;
  const filePath = path.resolve(ROOT, "." + normalized);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": mimeType(filePath) });
    res.end(content);
  });
}

async function main() {
  const server = http.createServer(serve);
  await new Promise((resolve) => server.listen(PORT, HOST, resolve));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.addInitScript(() => {
    localStorage.setItem("customConstellationDraftV2", JSON.stringify({
      name: "Forme test live",
      stars: [[12, 18], [17.2, 20.2], [14.1, 25.1], [9.8, 23.1]],
      links: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 2]]
    }));
  });

  try {
    await page.goto(`http://${HOST}:${PORT}/demo/matching-lab.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => window.matchingLabTestApi && window.matchingLabTestApi.getState().ready,
      { timeout: 30000 }
    );

    const preview = await page.evaluate(() => window.matchingLabTestApi.getState());
    assert.ok(preview.starCount > 4000, "Le catalogue de magnitude 6 doit être chargé");
    assert.ok(preview.pairCount > 25, "La plage par défaut doit produire des paires");
    assert.strictEqual(preview.previewCount, 50, "Les 50 premières orientations doivent être prévisualisées");
    assert.strictEqual(browserErrors.length, 0, `Erreur navigateur : ${browserErrors.join(" · ")}`);

    await page.click("#btn-step");
    await page.waitForTimeout(500);
    const started = await page.evaluate(() => window.matchingLabTestApi.getState());
    assert.strictEqual(started.currentPair, 0, "Le pas initial doit sélectionner la première paire");
    assert.strictEqual(started.cameraZoom, 4, "La caméra doit appliquer le zoom de suivi");
    assert.ok(
      Math.abs(started.cameraFocus[0]) + Math.abs(started.cameraFocus[1]) > 0.01,
      "La caméra doit suivre le centre de la paire courante"
    );

    await page.click("#btn-step");
    const stepped = await page.evaluate(() => window.matchingLabTestApi.getState());
    assert.ok(stepped.revealed >= 1, "Un pas doit révéler un test d’étoile");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    const mobile = await page.evaluate(() => {
      const stage = document.getElementById("stage").getBoundingClientRect();
      const sidebar = document.querySelector(".sidebar").getBoundingClientRect();
      return { stageWidth: stage.width, stageHeight: stage.height, sidebarTop: sidebar.top, stageTop: stage.top };
    });
    assert.strictEqual(Math.round(mobile.stageWidth), 390, "La carte mobile doit occuper toute la largeur");
    assert.ok(mobile.stageHeight >= 390, "La carte mobile doit garder une hauteur exploitable");
    assert.ok(mobile.sidebarTop >= mobile.stageTop + mobile.stageHeight - 1, "Les paramètres doivent passer sous la carte");

    console.log("PASS matching-lab");
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error("FAIL matching-lab");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

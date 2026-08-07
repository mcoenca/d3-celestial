(function() {
  "use strict";

  var DRAFT_KEY = "customConstellationDraftV2";
  var PARIS_GEOPOS = [48.8566, 2.3522];
  var GRID_STEP = 3;
  var PREVIEW_LIMIT = 50;
  var PAIR_CHUNK_SIZE = 65536;
  var PAIR_LINE_LIMIT = 450;
  var LAMBDA_RATIOS_ANGLES = 0.02;
  var DEFAULT_DRAFT = {
    name: "Triangle de démonstration",
    stars: [[12, 18], [17.2, 20.2], [14.1, 25.1], [9.8, 23.1]],
    links: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 2]]
  };

  var ui = {
    canvas: document.getElementById("sky-canvas"),
    stage: document.getElementById("stage"),
    loading: document.getElementById("loading"),
    loadingText: document.getElementById("loading-text"),
    draftDot: document.getElementById("draft-dot"),
    draftName: document.getElementById("draft-name"),
    draftMeta: document.getElementById("draft-meta"),
    algorithm: document.getElementById("algorithm"),
    scaleMin: document.getElementById("scale-min"),
    scaleMax: document.getElementById("scale-max"),
    scaleValue: document.getElementById("scale-value"),
    tolerance: document.getElementById("tolerance"),
    toleranceNumber: document.getElementById("tolerance-number"),
    toleranceValue: document.getElementById("tolerance-value"),
    magnitude: document.getElementById("magnitude"),
    magnitudeValue: document.getElementById("magnitude-value"),
    sizeWeight: document.getElementById("size-weight"),
    sizeWeightValue: document.getElementById("size-weight-value"),
    statStars: document.getElementById("stat-stars"),
    statPairs: document.getElementById("stat-pairs"),
    statPreview: document.getElementById("stat-preview"),
    statEdge: document.getElementById("stat-edge"),
    btnReset: document.getElementById("btn-reset"),
    btnPlay: document.getElementById("btn-play"),
    btnStep: document.getElementById("btn-step"),
    playIcon: document.getElementById("play-icon"),
    playLabel: document.getElementById("play-label"),
    playTitle: document.getElementById("play-title"),
    playDetail: document.getElementById("play-detail"),
    speed: document.getElementById("speed"),
    zoom: document.getElementById("zoom"),
    zoomValue: document.getElementById("zoom-value"),
    progress: document.getElementById("play-progress")
  };

  var ctx = ui.canvas.getContext("2d");
  var state = {
    width: 0,
    height: 0,
    dpr: 1,
    draft: null,
    draftIsDemo: false,
    model: null,
    catalog: [],
    stars: [],
    grid: {},
    pairChunks: [],
    pairCount: 0,
    pairMembers: null,
    pairLineIndices: [],
    previewAttempts: [],
    worker: null,
    generation: 0,
    ready: false,
    playing: false,
    timer: null,
    current: null,
    pairCursor: 0,
    mirrorCursor: false,
    completed: 0,
    accepted: 0,
    rejected: 0,
    bestScore: Infinity,
    bestPair: -1,
    recomputeTimer: null,
    camera: {
      focus: [0, 0],
      targetFocus: [0, 0],
      zoom: 1,
      targetZoom: 1,
      animating: false
    }
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("fr-FR");
  }

  function formatDecimal(value, digits) {
    return Number(value).toLocaleString("fr-FR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  }

  function normalizeRa(ra) {
    ra %= 360;
    return ra < 0 ? ra + 360 : ra;
  }

  function angularDistanceDeg(ra1, dec1, ra2, dec2) {
    var d2r = Math.PI / 180;
    var a1 = ra1 * d2r;
    var b1 = dec1 * d2r;
    var a2 = ra2 * d2r;
    var b2 = dec2 * d2r;
    var x = Math.sin((a2 - a1) / 2) * Math.sin((a2 - a1) / 2) +
      Math.cos(a1) * Math.cos(a2) * Math.sin((b2 - b1) / 2) * Math.sin((b2 - b1) / 2);
    return 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x))) / d2r;
  }

  function angleBetweenVectorsDeg(v1, v2) {
    var dot = v1[0] * v2[0] + v1[1] * v2[1];
    var n1 = Math.sqrt(v1[0] * v1[0] + v1[1] * v1[1]);
    var n2 = Math.sqrt(v2[0] * v2[0] + v2[1] * v2[1]);
    if (n1 < 1e-10 || n2 < 1e-10) return 0;
    return Math.acos(clamp(dot / (n1 * n2), -1, 1)) * 180 / Math.PI;
  }

  function getParisDate() {
    var date = new Date();
    date.setUTCHours(21, 0, 0, 0);
    return date;
  }

  function raDecToParisView(ra, dec) {
    if (typeof Celestial === "undefined" || typeof Celestial.horizontal !== "function") return [ra, dec];
    var horizontal = Celestial.horizontal(getParisDate(), [ra, dec], PARIS_GEOPOS);
    var altitude = horizontal[0] * Math.PI / 180;
    var azimuth = horizontal[1] * Math.PI / 180;
    var radius = 2 * Math.tan((Math.PI / 2 - altitude) / 2);
    return [radius * Math.cos(azimuth), radius * Math.sin(azimuth)];
  }

  function parisViewToRaDec(x, y) {
    if (typeof Celestial === "undefined" || !Celestial.horizontal || !Celestial.horizontal.inverse) return [x, y];
    var radius = Math.sqrt(x * x + y * y);
    var azimuth = Math.atan2(y, x) * 180 / Math.PI;
    if (azimuth < 0) azimuth += 360;
    var altitude = 90 - 2 * Math.atan(radius / 2) * 180 / Math.PI;
    var result = Celestial.horizontal.inverse(getParisDate(), [altitude, azimuth], PARIS_GEOPOS);
    return [normalizeRa(result[0]), clamp(result[1], -90, 90)];
  }

  function validPoint(point) {
    return Array.isArray(point) && point.length >= 2 && isFinite(point[0]) && isFinite(point[1]);
  }

  function loadDraft() {
    var parsed = null;
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      if (raw) parsed = JSON.parse(raw);
    } catch (error) {}

    var valid = parsed && Array.isArray(parsed.stars) && parsed.stars.length >= 2 &&
      parsed.stars.every(validPoint) && Array.isArray(parsed.links);
    if (!valid) {
      state.draftIsDemo = true;
      state.draft = {
        name: DEFAULT_DRAFT.name,
        stars: DEFAULT_DRAFT.stars.map(function(point) { return point.slice(); }),
        links: DEFAULT_DRAFT.links.map(function(link) { return link.slice(); })
      };
    } else {
      state.draftIsDemo = false;
      state.draft = {
        name: parsed.name || "Brouillon sans nom",
        stars: parsed.stars.map(function(point) { return [normalizeRa(Number(point[0])), clamp(Number(point[1]), -90, 90)]; }),
        links: parsed.links.map(function(link) { return [Number(link[0]), Number(link[1])]; })
      };
    }

    state.draft.links = state.draft.links.filter(function(link) {
      return link[0] >= 0 && link[0] < state.draft.stars.length &&
        link[1] >= 0 && link[1] < state.draft.stars.length && link[0] !== link[1];
    });
    if (!state.draft.links.length) state.draft.links.push([0, 1]);

    ui.draftDot.classList.toggle("demo", state.draftIsDemo);
    ui.draftName.textContent = state.draftIsDemo ? state.draft.name + " · mode démo" : state.draft.name;
    ui.draftMeta.textContent = state.draft.stars.length + " étoiles";
    state.model = buildNormalizedModel();
    var ref = state.model.refEdge;
    var edge = angularDistanceDeg(
      state.draft.stars[ref[0]][0], state.draft.stars[ref[0]][1],
      state.draft.stars[ref[1]][0], state.draft.stars[ref[1]][1]
    );
    state.model.refEdgeDeg = edge;
    ui.statEdge.textContent = formatDecimal(edge, 2) + "°";
  }

  function buildNormalizedModel() {
    var stars = state.draft.stars;
    var link = state.draft.links[0];
    var points = stars.map(function(point) { return raDecToParisView(point[0], point[1]); });
    var cx = 0;
    var cy = 0;
    points.forEach(function(point) {
      cx += point[0];
      cy += point[1];
    });
    cx /= points.length;
    cy /= points.length;
    var dx = points[link[1]][0] - points[link[0]][0];
    var dy = points[link[1]][1] - points[link[0]][1];
    var length = Math.sqrt(dx * dx + dy * dy);
    if (length < 1e-6) length = 1e-6;
    return {
      points: points.map(function(point) { return [(point[0] - cx) / length, (point[1] - cy) / length]; }),
      refEdge: link.slice(),
      L_ref: length,
      refEdgeDeg: 0
    };
  }

  function showLoading(message) {
    ui.loadingText.textContent = message;
    ui.loading.classList.add("visible");
  }

  function hideLoading() {
    ui.loading.classList.remove("visible");
  }

  function setError(message) {
    hideLoading();
    ui.playTitle.textContent = "Impossible de préparer le matching";
    ui.playTitle.classList.add("status-error");
    ui.playDetail.textContent = message;
    ui.btnPlay.disabled = true;
    ui.btnStep.disabled = true;
  }

  function loadCatalog() {
    showLoading("Chargement du catalogue d’étoiles…");
    fetch("../data/stars.6.json")
      .then(function(response) {
        if (!response.ok) throw new Error("Réponse " + response.status);
        return response.json();
      })
      .then(function(json) {
        state.catalog = (json.features || []).filter(function(feature) {
          return feature.properties && typeof feature.properties.mag === "number" &&
            feature.geometry && validPoint(feature.geometry.coordinates);
        }).map(function(feature) {
          var coords = feature.geometry.coordinates;
          var ra = normalizeRa(Number(coords[0]));
          var dec = clamp(Number(coords[1]), -90, 90);
          var raRad = ra * Math.PI / 180;
          var decRad = dec * Math.PI / 180;
          return {
            id: feature.id,
            coords: [ra, dec],
            mag: Number(feature.properties.mag),
            unit: [
              Math.cos(decRad) * Math.cos(raRad),
              Math.cos(decRad) * Math.sin(raRad),
              Math.sin(decRad)
            ],
            parisView: raDecToParisView(ra, dec)
          };
        });
        state.catalog.sort(function(a, b) { return a.mag - b.mag; });
        scheduleRecompute(0);
      })
      .catch(function(error) {
        setError("Catalogue non chargé : " + (error.message || error));
      });
  }

  function currentParameters() {
    var min = clamp(parseFloat(ui.scaleMin.value) || 0.9, 0.1, 50);
    var max = clamp(parseFloat(ui.scaleMax.value) || 1.1, 0.1, 100);
    if (max < min) {
      var swap = min;
      min = max;
      max = swap;
    }
    return {
      scaleMin: min,
      scaleMax: max,
      tolerance: clamp(parseFloat(ui.tolerance.value) || 0.4, 0.1, 3),
      magnitude: clamp(parseFloat(ui.magnitude.value) || 6, 3, 6),
      sizeWeight: clamp(parseFloat(ui.sizeWeight.value) || 0.3, 0, 1),
      algorithm: ui.algorithm.value
    };
  }

  function syncParameterLabels() {
    var p = currentParameters();
    ui.scaleValue.textContent = "×" + formatDecimal(p.scaleMin, 1) + " – ×" + formatDecimal(p.scaleMax, 1);
    ui.toleranceValue.textContent = formatDecimal(p.tolerance, 1) + "°";
    ui.toleranceNumber.value = p.tolerance.toFixed(1);
    ui.magnitudeValue.textContent = formatDecimal(p.magnitude, p.magnitude % 1 ? 2 : 1);
    ui.sizeWeightValue.textContent = formatDecimal(p.sizeWeight, 2);
  }

  function scheduleRecompute(delay) {
    syncParameterLabels();
    if (state.recomputeTimer) clearTimeout(state.recomputeTimer);
    state.recomputeTimer = setTimeout(recomputePairs, delay == null ? 220 : delay);
  }

  function makePairWorker() {
    var source = [
      '"use strict";',
      "self.onmessage=function(event){",
      "var data=event.data, units=data.units, n=data.count, chunkPairs=data.chunkPairs;",
      "var minRad=data.minDeg*Math.PI/180,maxRad=Math.min(180,data.maxDeg)*Math.PI/180;",
      "var cosMin=Math.cos(minRad),cosMax=Math.cos(maxRad);",
      "var chunk=new Uint16Array(chunkPairs*2),used=0,total=0;",
      "function flush(){if(!used)return;var output=used===chunk.length?chunk:chunk.slice(0,used);",
      "self.postMessage({type:'chunk',pairs:output},[output.buffer]);chunk=new Uint16Array(chunkPairs*2);used=0;}",
      "for(var i=0;i<n;i++){var ix=units[i*3],iy=units[i*3+1],iz=units[i*3+2];",
      "for(var j=i+1;j<n;j++){var dot=ix*units[j*3]+iy*units[j*3+1]+iz*units[j*3+2];",
      "if(dot<=cosMin&&dot>=cosMax){chunk[used++]=i;chunk[used++]=j;total++;if(used===chunk.length)flush();}}",
      "if(i%160===0)self.postMessage({type:'progress',value:i/Math.max(1,n-1),total:total});}",
      "flush();self.postMessage({type:'done',total:total});",
      "};"
    ].join("");
    var blob = new Blob([source], { type: "application/javascript" });
    return new Worker(URL.createObjectURL(blob));
  }

  function recomputePairs() {
    if (!state.catalog.length || !state.model) return;
    pausePlayback();
    clearTimeout(state.timer);
    if (state.worker) {
      state.worker.terminate();
      state.worker = null;
    }

    var params = currentParameters();
    state.generation += 1;
    state.ready = false;
    state.current = null;
    state.pairCursor = 0;
    state.mirrorCursor = false;
    state.pairChunks = [];
    state.pairCount = 0;
    state.pairLineIndices = [];
    state.previewAttempts = [];
    state.stars = state.catalog.filter(function(star) { return star.mag <= params.magnitude; });
    state.grid = buildGrid(state.stars);
    state.pairMembers = new Uint8Array(state.stars.length);
    resetRunStats();
    ui.statStars.textContent = formatNumber(state.stars.length);
    ui.statPairs.textContent = "calcul…";
    ui.statPreview.textContent = "—";
    ui.playTitle.classList.remove("status-error");
    ui.playTitle.textContent = "Calcul des paires de départ…";
    ui.playDetail.textContent = "Filtre de distance sur " + formatNumber(state.stars.length) + " étoiles.";
    ui.btnPlay.disabled = true;
    ui.btnStep.disabled = true;
    showLoading("Analyse des paires… 0 %");
    requestDraw();

    var units = new Float64Array(state.stars.length * 3);
    state.stars.forEach(function(star, index) {
      units[index * 3] = star.unit[0];
      units[index * 3 + 1] = star.unit[1];
      units[index * 3 + 2] = star.unit[2];
    });
    var minDistance = Math.max(0.05, state.model.refEdgeDeg * params.scaleMin);
    var maxDistance = Math.min(180, state.model.refEdgeDeg * params.scaleMax);
    var worker = makePairWorker();
    state.worker = worker;
    worker.onmessage = function(event) {
      var message = event.data;
      if (message.type === "progress") {
        var percent = Math.round(message.value * 100);
        showLoading("Analyse des paires… " + percent + " %");
        ui.statPairs.textContent = "~" + formatNumber(message.total);
        return;
      }
      if (message.type === "chunk") {
        var chunk = message.pairs;
        state.pairChunks.push(chunk);
        state.pairCount += chunk.length / 2;
        for (var i = 0; i < chunk.length; i += 2) {
          state.pairMembers[chunk[i]] = 1;
          state.pairMembers[chunk[i + 1]] = 1;
        }
        return;
      }
      if (message.type === "done") {
        worker.terminate();
        if (state.worker === worker) state.worker = null;
        finishPairGeneration(minDistance, maxDistance);
      }
    };
    worker.onerror = function(error) {
      if (state.worker === worker) state.worker = null;
      worker.terminate();
      setError("Le calcul des paires a échoué : " + error.message);
    };
    worker.postMessage({
      units: units,
      count: state.stars.length,
      minDeg: minDistance,
      maxDeg: maxDistance,
      chunkPairs: PAIR_CHUNK_SIZE
    }, [units.buffer]);
  }

  function finishPairGeneration(minDistance, maxDistance) {
    state.ready = true;
    hideLoading();
    ui.statPairs.textContent = formatNumber(state.pairCount);
    ui.btnPlay.disabled = state.pairCount === 0;
    ui.btnStep.disabled = state.pairCount === 0;
    buildPairLineSample();
    buildPreviewAttempts();
    resetPlayback();
    if (!state.pairCount) {
      ui.playTitle.textContent = "Aucune paire dans cette plage";
      ui.playDetail.textContent = formatDecimal(minDistance, 2) + "° à " + formatDecimal(maxDistance, 2) + "° · élargissez l’échelle.";
    } else {
      ui.playTitle.textContent = formatNumber(state.pairCount) + " paires prêtes";
      ui.playDetail.textContent = "Lancez la lecture : la caméra suivra chaque paire et chaque étoile testée.";
    }
    requestDraw();
    publishTestState();
  }

  function pairAt(index) {
    if (index < 0 || index >= state.pairCount) return null;
    var chunkIndex = Math.floor(index / PAIR_CHUNK_SIZE);
    var local = (index % PAIR_CHUNK_SIZE) * 2;
    var chunk = state.pairChunks[chunkIndex];
    return chunk && local + 1 < chunk.length ? [chunk[local], chunk[local + 1]] : null;
  }

  function buildPairLineSample() {
    state.pairLineIndices = [];
    var count = Math.min(PAIR_LINE_LIMIT, state.pairCount);
    if (!count) return;
    for (var i = 0; i < count; i++) {
      state.pairLineIndices.push(Math.floor(i * (state.pairCount - 1) / Math.max(1, count - 1)));
    }
  }

  function buildPreviewAttempts() {
    state.previewAttempts = [];
    var attemptCount = Math.min(PREVIEW_LIMIT, state.pairCount * 2);
    var valid = 0;
    for (var i = 0; i < attemptCount; i++) {
      var pairIndex = Math.floor(i / 2);
      var attempt = createAttempt(pairIndex, i % 2 === 1);
      if (!attempt) continue;
      state.previewAttempts.push(attempt);
      if (attempt.success) valid += 1;
    }
    var rejected = state.previewAttempts.length - valid;
    ui.statPreview.textContent = valid + " ✓ · " + rejected + " ×";
  }

  function buildGrid(stars) {
    var grid = {};
    stars.forEach(function(star, index) {
      var key = Math.floor(star.coords[0] / GRID_STEP) + "," + Math.floor(star.coords[1] / GRID_STEP);
      if (!grid[key]) grid[key] = [];
      grid[key].push(index);
    });
    return grid;
  }

  function gridNearest(ra, dec, excluded, maxDistance) {
    var cellRa = Math.floor(normalizeRa(ra) / GRID_STEP);
    var cellDec = Math.floor(dec / GRID_STEP);
    var bestIndex = -1;
    var bestDistance = Infinity;
    for (var di = -1; di <= 1; di++) {
      var wrappedRa = cellRa + di;
      var maxRaCell = Math.ceil(360 / GRID_STEP);
      if (wrappedRa < 0) wrappedRa += maxRaCell;
      if (wrappedRa >= maxRaCell) wrappedRa -= maxRaCell;
      for (var dj = -1; dj <= 1; dj++) {
        var cell = state.grid[wrappedRa + "," + (cellDec + dj)];
        if (!cell) continue;
        for (var c = 0; c < cell.length; c++) {
          var index = cell[c];
          if (excluded[index]) continue;
          var coords = state.stars[index].coords;
          var distance = angularDistanceDeg(ra, dec, coords[0], coords[1]);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
          }
        }
      }
    }
    return bestDistance <= maxDistance ? { index: bestIndex, distance: bestDistance } : null;
  }

  function createAttempt(pairIndex, mirror) {
    var pair = pairAt(pairIndex);
    if (!pair) return null;
    var params = currentParameters();
    var model = state.model;
    var norm = model.points;
    var ref = model.refEdge;
    var pointA = state.stars[pair[0]].parisView;
    var pointB = state.stars[pair[1]].parisView;
    var dx = pointB[0] - pointA[0];
    var dy = pointB[1] - pointA[1];
    var pairLength = Math.sqrt(dx * dx + dy * dy);
    var modelAngle = Math.atan2(norm[ref[1]][1] - norm[ref[0]][1], norm[ref[1]][0] - norm[ref[0]][0]);
    var rotation = Math.atan2(dy, dx) - modelAngle;
    var cosRotation = Math.cos(rotation);
    var sinRotation = Math.sin(rotation);
    var excluded = {};
    excluded[pair[0]] = true;
    excluded[pair[1]] = true;
    var matched = [];
    for (var m = 0; m < norm.length; m++) matched[m] = -1;
    matched[ref[0]] = pair[0];
    matched[ref[1]] = pair[1];
    var checks = [];
    var success = true;

    for (var k = 0; k < norm.length; k++) {
      if (k === ref[0] || k === ref[1]) continue;
      var vx = norm[k][0] - norm[ref[0]][0];
      var vy = norm[k][1] - norm[ref[0]][1];
      if (mirror) vy = -vy;
      var predicted = parisViewToRaDec(
        pointA[0] + pairLength * (vx * cosRotation - vy * sinRotation),
        pointA[1] + pairLength * (vx * sinRotation + vy * cosRotation)
      );
      var nearest = gridNearest(predicted[0], predicted[1], excluded, params.tolerance);
      var check = {
        modelIndex: k,
        predicted: predicted,
        matchedIndex: nearest ? nearest.index : -1,
        distance: nearest ? nearest.distance : Infinity,
        ok: !!nearest
      };
      checks.push(check);
      if (!nearest) {
        success = false;
        break;
      }
      excluded[nearest.index] = true;
      matched[k] = nearest.index;
    }

    return {
      pairIndex: pairIndex,
      pair: pair,
      mirror: mirror,
      checks: checks,
      matched: matched,
      success: success && matched.indexOf(-1) === -1,
      ratio: pairLength / model.L_ref
    };
  }

  function resetRunStats() {
    state.completed = 0;
    state.accepted = 0;
    state.rejected = 0;
    state.bestScore = Infinity;
    state.bestPair = -1;
    ui.progress.style.width = "0%";
  }

  function resetPlayback() {
    pausePlayback();
    state.current = null;
    state.pairCursor = 0;
    state.mirrorCursor = false;
    resetRunStats();
    state.camera.targetFocus = [0, 0];
    state.camera.targetZoom = 1;
    animateCamera();
    updatePlaybackText();
    requestDraw();
  }

  function startCurrentAttempt() {
    if (!state.ready || !state.pairCount) return false;
    var attempt = createAttempt(state.pairCursor, state.mirrorCursor);
    if (!attempt) return false;
    state.current = {
      attempt: attempt,
      revealed: 0,
      resultRecorded: false
    };
    focusCurrentPair();
    updatePlaybackText();
    requestDraw();
    return true;
  }

  function advancePlayback() {
    if (!state.current) {
      startCurrentAttempt();
      return;
    }
    var current = state.current;
    var checks = current.attempt.checks;
    if (current.revealed < checks.length) {
      current.revealed += 1;
      var latest = checks[current.revealed - 1];
      if (!latest.ok || current.revealed === checks.length) recordCurrentResult();
      updatePlaybackText();
      requestDraw();
      return;
    }
    if (!current.resultRecorded) {
      recordCurrentResult();
      updatePlaybackText();
      requestDraw();
      return;
    }
    moveToNextAttempt();
  }

  function moveToNextAttempt() {
    if (!state.mirrorCursor) {
      state.mirrorCursor = true;
    } else {
      state.mirrorCursor = false;
      state.pairCursor += 1;
    }
    if (state.pairCursor >= state.pairCount) {
      pausePlayback();
      state.current = null;
      ui.playTitle.textContent = "Catalogue terminé";
      ui.playDetail.textContent = state.accepted + " correspondances complètes sur " + formatNumber(state.completed) + " orientations.";
      ui.progress.style.width = "100%";
      requestDraw();
      return;
    }
    startCurrentAttempt();
  }

  function recordCurrentResult() {
    if (!state.current || state.current.resultRecorded) return;
    state.current.resultRecorded = true;
    state.completed += 1;
    if (state.current.attempt.success) {
      state.accepted += 1;
      var score = scoreAttempt(state.current.attempt);
      if (score < state.bestScore) {
        state.bestScore = score;
        state.bestPair = state.current.attempt.pairIndex;
      }
    } else {
      state.rejected += 1;
    }
    var total = state.pairCount * 2;
    ui.progress.style.width = Math.min(100, 100 * state.completed / Math.max(1, total)) + "%";
    publishTestState();
  }

  function scoreAttempt(attempt) {
    if (!attempt.success) return Infinity;
    var errors = attempt.checks.map(function(check) { return check.distance; });
    var rms = 0;
    errors.forEach(function(error) { rms += error * error; });
    rms = errors.length ? Math.sqrt(rms / errors.length) : 0;
    var params = currentParameters();
    var sizePenalty = Math.abs(Math.log(attempt.ratio || 1)) * params.sizeWeight;
    if (params.algorithm === "rms") return rms + sizePenalty;
    var coords = attempt.matched.map(function(index) { return state.stars[index].coords.slice(); });
    if (params.algorithm === "rms-angles") {
      var differences = computeAngleDiffAtVertices(state.draft.stars, coords, state.draft.links);
      var maxDifference = differences.length ? Math.max.apply(null, differences) : 0;
      return rms + maxDifference / 100 + sizePenalty;
    }
    var referenceParis = state.draft.stars.map(function(point) { return raDecToParisView(point[0], point[1]); });
    var candidateParis = attempt.matched.map(function(index) { return state.stars[index].parisView.slice(); });
    var refDescriptors = buildSegmentDescriptors(state.draft.links, referenceParis);
    var candDescriptors = buildSegmentDescriptors(state.draft.links, candidateParis);
    var sumRatios = 0;
    var sumAngles = 0;
    var count = Math.min(refDescriptors.ratios.length, candDescriptors.ratios.length);
    for (var i = 0; i < count; i++) {
      var ratioDiff = refDescriptors.ratios[i] - candDescriptors.ratios[i];
      var angleDiff = angleDiffNorm(refDescriptors.angles[i], candDescriptors.angles[i]);
      sumRatios += ratioDiff * ratioDiff;
      sumAngles += angleDiff * angleDiff;
    }
    var rmsRatios = count ? Math.sqrt(sumRatios / count) : 0;
    var rmsAngles = count ? Math.sqrt(sumAngles / count) : 0;
    return rmsRatios + LAMBDA_RATIOS_ANGLES * rmsAngles + sizePenalty;
  }

  function computeAngleDiffAtVertices(starsA, starsB, links) {
    var neighbors = [];
    var differences = [];
    for (var i = 0; i < starsA.length; i++) neighbors[i] = [];
    links.forEach(function(link) {
      if (neighbors[link[0]].indexOf(link[1]) === -1) neighbors[link[0]].push(link[1]);
      if (neighbors[link[1]].indexOf(link[0]) === -1) neighbors[link[1]].push(link[0]);
    });
    for (var vertex = 0; vertex < starsA.length; vertex++) {
      if (neighbors[vertex].length < 2) {
        differences[vertex] = 0;
        continue;
      }
      var a = neighbors[vertex][0];
      var b = neighbors[vertex][1];
      var angleA = angleBetweenVectorsDeg(
        [starsA[a][0] - starsA[vertex][0], starsA[a][1] - starsA[vertex][1]],
        [starsA[b][0] - starsA[vertex][0], starsA[b][1] - starsA[vertex][1]]
      );
      var angleB = angleBetweenVectorsDeg(
        [starsB[a][0] - starsB[vertex][0], starsB[a][1] - starsB[vertex][1]],
        [starsB[b][0] - starsB[vertex][0], starsB[b][1] - starsB[vertex][1]]
      );
      var difference = Math.abs(angleA - angleB);
      differences[vertex] = difference > 180 ? 360 - difference : difference;
    }
    return differences;
  }

  function buildSegmentDescriptors(links, coords) {
    if (!links.length) return { ratios: [], angles: [] };
    function distance(a, b) {
      var dx = coords[b][0] - coords[a][0];
      var dy = coords[b][1] - coords[a][1];
      return Math.sqrt(dx * dx + dy * dy);
    }
    var firstLength = distance(links[0][0], links[0][1]);
    if (firstLength < 1e-8) return { ratios: [], angles: [] };
    var firstVector = [
      coords[links[0][1]][0] - coords[links[0][0]][0],
      coords[links[0][1]][1] - coords[links[0][0]][1]
    ];
    var ratios = [];
    var angles = [];
    links.forEach(function(link) {
      ratios.push(distance(link[0], link[1]) / firstLength);
      angles.push(angleBetweenVectorsDeg(firstVector, [
        coords[link[1]][0] - coords[link[0]][0],
        coords[link[1]][1] - coords[link[0]][1]
      ]));
    });
    return { ratios: ratios, angles: angles };
  }

  function angleDiffNorm(first, second) {
    var difference = first - second;
    while (difference > 180) difference -= 360;
    while (difference < -180) difference += 360;
    return difference;
  }

  function setPlaying(playing) {
    if (playing && (!state.ready || !state.pairCount)) return;
    state.playing = playing;
    ui.playIcon.textContent = playing ? "Ⅱ" : "▶";
    ui.playLabel.textContent = playing ? "Pause" : (state.current ? "Reprendre" : "Lancer");
    if (playing) {
      if (!state.current && !startCurrentAttempt()) return;
      scheduleTick();
    } else if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function pausePlayback() {
    setPlaying(false);
  }

  function scheduleTick() {
    if (!state.playing) return;
    if (state.timer) clearTimeout(state.timer);
    var speed = parseFloat(ui.speed.value) || 1;
    state.timer = setTimeout(function() {
      state.timer = null;
      if (!state.playing) return;
      advancePlayback();
      scheduleTick();
    }, Math.max(45, 850 / speed));
  }

  function updatePlaybackText() {
    if (!state.current) {
      if (state.ready && state.pairCount) {
        ui.playTitle.textContent = "Prévisualisation des " + Math.min(PREVIEW_LIMIT, state.pairCount * 2) + " premiers essais";
        ui.playDetail.textContent = "Vert = forme complète trouvée · rouge = rejet au premier échec.";
      }
      return;
    }
    var current = state.current;
    var attempt = current.attempt;
    var orientation = attempt.mirror ? "miroir" : "directe";
    var prefix = "Paire " + formatNumber(attempt.pairIndex + 1) + " / " + formatNumber(state.pairCount) + " · " + orientation;
    if (!current.revealed) {
      ui.playTitle.textContent = prefix;
      ui.playDetail.textContent = "Paire fixée : recherche de l’étoile suivante…";
      return;
    }
    var check = attempt.checks[current.revealed - 1];
    if (check) {
      ui.playTitle.textContent = "Étoile " + (check.modelIndex + 1) + " / " + state.draft.stars.length + " · " + (check.ok ? "trouvée" : "introuvable");
      ui.playDetail.textContent = prefix + " · " + (check.ok ? "écart " + formatDecimal(check.distance, 2) + "°" : "aucune étoile dans la tolérance");
    }
    if (current.resultRecorded) {
      ui.playTitle.textContent = attempt.success ? "✓ Orientation acceptée" : "× Orientation rejetée";
      var best = isFinite(state.bestScore) ? " · meilleur score " + formatDecimal(state.bestScore, 3) : "";
      ui.playDetail.textContent = prefix + " · " + state.accepted + " match(s)" + best;
    }
  }

  function skyPoint(coords) {
    var angle = normalizeRa(coords[0]) * Math.PI / 180;
    var radius = clamp((90 - coords[1]) / 180, 0, 1);
    return [radius * Math.sin(angle), -radius * Math.cos(angle)];
  }

  function baseRadius() {
    return Math.min(state.width, state.height) * 0.43;
  }

  function worldToScreen(point) {
    var scale = baseRadius() * state.camera.zoom;
    return [
      state.width / 2 + (point[0] - state.camera.focus[0]) * scale,
      state.height / 2 + (point[1] - state.camera.focus[1]) * scale
    ];
  }

  function coordsToScreen(coords) {
    return worldToScreen(skyPoint(coords));
  }

  function pointVisible(point, margin) {
    return point[0] >= -margin && point[0] <= state.width + margin &&
      point[1] >= -margin && point[1] <= state.height + margin;
  }

  function drawLineBetweenCoords(first, second, color, width, alpha, dash) {
    var a = coordsToScreen(first);
    var b = coordsToScreen(second);
    if (!pointVisible(a, 60) && !pointVisible(b, 60)) return;
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    ctx.restore();
  }

  function drawGrid() {
    var center = worldToScreen([0, 0]);
    var scale = baseRadius() * state.camera.zoom;
    ctx.save();
    ctx.strokeStyle = "rgba(101,123,154,.18)";
    ctx.lineWidth = 1;
    [60, 30, 0, -30, -60].forEach(function(dec) {
      var radius = ((90 - dec) / 180) * scale;
      ctx.beginPath();
      ctx.arc(center[0], center[1], radius, 0, Math.PI * 2);
      ctx.stroke();
    });
    for (var ra = 0; ra < 360; ra += 30) {
      var edge = worldToScreen(skyPoint([ra, -90]));
      ctx.beginPath();
      ctx.moveTo(center[0], center[1]);
      ctx.lineTo(edge[0], edge[1]);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(148,180,224,.52)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(center[0], center[1], scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawStars() {
    var zoom = state.camera.zoom;
    state.stars.forEach(function(star, index) {
      var point = coordsToScreen(star.coords);
      if (!pointVisible(point, 5)) return;
      var radius = clamp((6.4 - star.mag) * 0.52 + 0.45, 0.45, 2.7) * Math.min(1.6, Math.sqrt(zoom));
      ctx.globalAlpha = clamp(1.05 - star.mag * 0.1, 0.35, 1);
      ctx.fillStyle = "#edf5ff";
      ctx.beginPath();
      ctx.arc(point[0], point[1], radius, 0, Math.PI * 2);
      ctx.fill();
      if (state.pairMembers && state.pairMembers[index]) {
        ctx.globalAlpha = 0.24;
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(point[0], point[1], radius + 2.2, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
    ctx.globalAlpha = 1;
  }

  function drawEligiblePairs() {
    state.pairLineIndices.forEach(function(pairIndex) {
      var pair = pairAt(pairIndex);
      if (!pair) return;
      drawLineBetweenCoords(state.stars[pair[0]].coords, state.stars[pair[1]].coords, "#38bdf8", 0.7, 0.12);
    });
  }

  function drawPreviewAttempts() {
    if (state.current) return;
    state.previewAttempts.forEach(function(attempt) {
      var first = coordsToScreen(state.stars[attempt.pair[0]].coords);
      var second = coordsToScreen(state.stars[attempt.pair[1]].coords);
      if (!pointVisible(first, 50) && !pointVisible(second, 50)) return;
      var color = attempt.success ? "#34d399" : "#fb7185";
      var dx = second[0] - first[0];
      var dy = second[1] - first[1];
      var length = Math.sqrt(dx * dx + dy * dy) || 1;
      var offset = attempt.mirror ? 3.5 : -3.5;
      var ox = -dy / length * offset;
      var oy = dx / length * offset;
      ctx.save();
      ctx.globalAlpha = attempt.success ? 0.8 : 0.55;
      ctx.strokeStyle = color;
      ctx.lineWidth = attempt.success ? 2 : 1.5;
      ctx.setLineDash(attempt.success ? [] : [4, 3]);
      ctx.beginPath();
      ctx.moveTo(first[0] + ox, first[1] + oy);
      ctx.lineTo(second[0] + ox, second[1] + oy);
      ctx.stroke();
      ctx.restore();
    });
  }

  function drawDraft() {
    state.draft.links.forEach(function(link) {
      drawLineBetweenCoords(state.draft.stars[link[0]], state.draft.stars[link[1]], "#a78bfa", 2, 0.86, [6, 4]);
    });
    state.draft.stars.forEach(function(coords) {
      var point = coordsToScreen(coords);
      if (!pointVisible(point, 10)) return;
      ctx.fillStyle = "#c4b5fd";
      ctx.beginPath();
      ctx.arc(point[0], point[1], 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function drawCurrentAttempt() {
    if (!state.current) return;
    var current = state.current;
    var attempt = current.attempt;
    var starA = state.stars[attempt.pair[0]].coords;
    var starB = state.stars[attempt.pair[1]].coords;
    drawLineBetweenCoords(starA, starB, "#fbbf24", 4, 0.96);
    [starA, starB].forEach(function(coords, index) {
      var point = coordsToScreen(coords);
      ctx.save();
      ctx.shadowColor = "#fbbf24";
      ctx.shadowBlur = 13;
      ctx.fillStyle = "#fde68a";
      ctx.beginPath();
      ctx.arc(point[0], point[1], 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#111827";
      ctx.font = "bold 8px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(index ? "B" : "A", point[0], point[1] + 0.5);
      ctx.restore();
    });

    for (var i = 0; i < current.revealed; i++) {
      var check = attempt.checks[i];
      var predicted = coordsToScreen(check.predicted);
      var color = check.ok ? "#34d399" : "#fb7185";
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(check.ok ? [3, 3] : [2, 3]);
      if (check.ok) {
        var matched = coordsToScreen(state.stars[check.matchedIndex].coords);
        ctx.beginPath();
        ctx.moveTo(predicted[0], predicted[1]);
        ctx.lineTo(matched[0], matched[1]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(matched[0], matched[1], 5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(predicted[0], predicted[1], check.ok ? 8 : 10, 0, Math.PI * 2);
      ctx.stroke();
      if (!check.ok) {
        ctx.beginPath();
        ctx.moveTo(predicted[0] - 5, predicted[1] - 5);
        ctx.lineTo(predicted[0] + 5, predicted[1] + 5);
        ctx.moveTo(predicted[0] + 5, predicted[1] - 5);
        ctx.lineTo(predicted[0] - 5, predicted[1] + 5);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function draw() {
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, state.width, state.height);
    var gradient = ctx.createRadialGradient(
      state.width * 0.5, state.height * 0.46, 0,
      state.width * 0.5, state.height * 0.5, Math.max(state.width, state.height) * 0.7
    );
    gradient.addColorStop(0, "#0b1425");
    gradient.addColorStop(0.6, "#050912");
    gradient.addColorStop(1, "#010207");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, state.width, state.height);
    drawGrid();
    drawEligiblePairs();
    drawStars();
    drawPreviewAttempts();
    drawDraft();
    drawCurrentAttempt();
  }

  var drawRequested = false;
  function requestDraw() {
    if (drawRequested) return;
    drawRequested = true;
    requestAnimationFrame(function() {
      drawRequested = false;
      draw();
    });
  }

  function focusCurrentPair() {
    if (!state.current) return;
    var pair = state.current.attempt.pair;
    var first = skyPoint(state.stars[pair[0]].coords);
    var second = skyPoint(state.stars[pair[1]].coords);
    state.camera.targetFocus = [(first[0] + second[0]) / 2, (first[1] + second[1]) / 2];
    state.camera.targetZoom = parseFloat(ui.zoom.value) || 4;
    animateCamera();
  }

  function animateCamera() {
    if (state.camera.animating) return;
    state.camera.animating = true;
    function frame() {
      var camera = state.camera;
      camera.focus[0] += (camera.targetFocus[0] - camera.focus[0]) * 0.2;
      camera.focus[1] += (camera.targetFocus[1] - camera.focus[1]) * 0.2;
      camera.zoom += (camera.targetZoom - camera.zoom) * 0.2;
      requestDraw();
      var remaining = Math.abs(camera.targetFocus[0] - camera.focus[0]) +
        Math.abs(camera.targetFocus[1] - camera.focus[1]) +
        Math.abs(camera.targetZoom - camera.zoom);
      if (remaining > 0.002) {
        requestAnimationFrame(frame);
      } else {
        camera.focus = camera.targetFocus.slice();
        camera.zoom = camera.targetZoom;
        camera.animating = false;
        requestDraw();
      }
    }
    requestAnimationFrame(frame);
  }

  function resizeCanvas() {
    var rect = ui.stage.getBoundingClientRect();
    state.width = Math.max(1, rect.width);
    state.height = Math.max(1, rect.height);
    state.dpr = Math.min(2, window.devicePixelRatio || 1);
    ui.canvas.width = Math.round(state.width * state.dpr);
    ui.canvas.height = Math.round(state.height * state.dpr);
    ui.canvas.style.width = state.width + "px";
    ui.canvas.style.height = state.height + "px";
    requestDraw();
  }

  function bindCanvasNavigation() {
    ui.canvas.addEventListener("wheel", function(event) {
      event.preventDefault();
      var value = clamp((parseFloat(ui.zoom.value) || 4) * (event.deltaY < 0 ? 1.15 : 0.87), 1, 12);
      ui.zoom.value = value.toFixed(2);
      ui.zoomValue.textContent = "×" + formatDecimal(value, value % 1 ? 1 : 0);
      state.camera.targetZoom = value;
      animateCamera();
    }, { passive: false });

    var pointers = {};
    var drag = null;
    var pinch = null;
    ui.canvas.addEventListener("pointerdown", function(event) {
      pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
      ui.canvas.setPointerCapture(event.pointerId);
      var ids = Object.keys(pointers);
      if (ids.length === 1) {
        drag = { x: event.clientX, y: event.clientY, focus: state.camera.targetFocus.slice() };
      } else if (ids.length === 2) {
        var a = pointers[ids[0]];
        var b = pointers[ids[1]];
        pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: state.camera.targetZoom };
        drag = null;
      }
    });
    ui.canvas.addEventListener("pointermove", function(event) {
      if (!pointers[event.pointerId]) return;
      pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
      var ids = Object.keys(pointers);
      if (ids.length === 2 && pinch) {
        var a = pointers[ids[0]];
        var b = pointers[ids[1]];
        var distance = Math.hypot(a.x - b.x, a.y - b.y);
        var zoom = clamp(pinch.zoom * distance / Math.max(1, pinch.distance), 1, 12);
        ui.zoom.value = zoom;
        ui.zoomValue.textContent = "×" + formatDecimal(zoom, 1);
        state.camera.targetZoom = zoom;
        animateCamera();
      } else if (ids.length === 1 && drag) {
        var scale = baseRadius() * state.camera.zoom;
        state.camera.focus[0] = drag.focus[0] - (event.clientX - drag.x) / scale;
        state.camera.focus[1] = drag.focus[1] - (event.clientY - drag.y) / scale;
        state.camera.targetFocus = state.camera.focus.slice();
        requestDraw();
      }
    });
    function endPointer(event) {
      delete pointers[event.pointerId];
      drag = null;
      pinch = null;
    }
    ui.canvas.addEventListener("pointerup", endPointer);
    ui.canvas.addEventListener("pointercancel", endPointer);
  }

  function bindControls() {
    [ui.scaleMin, ui.scaleMax, ui.magnitude].forEach(function(element) {
      element.addEventListener("input", function() { scheduleRecompute(); });
      element.addEventListener("change", function() { scheduleRecompute(0); });
    });
    ui.tolerance.addEventListener("input", function() {
      ui.toleranceNumber.value = ui.tolerance.value;
      scheduleRecompute();
    });
    ui.toleranceNumber.addEventListener("input", function() {
      var value = clamp(parseFloat(ui.toleranceNumber.value) || 0.4, 0.1, 3);
      ui.tolerance.value = value;
      scheduleRecompute();
    });
    ui.algorithm.addEventListener("change", function() {
      resetPlayback();
      syncParameterLabels();
    });
    ui.sizeWeight.addEventListener("input", function() {
      syncParameterLabels();
      resetPlayback();
    });
    ui.btnPlay.addEventListener("click", function() { setPlaying(!state.playing); });
    ui.btnStep.addEventListener("click", function() {
      pausePlayback();
      advancePlayback();
    });
    ui.btnReset.addEventListener("click", resetPlayback);
    ui.speed.addEventListener("change", function() {
      if (state.playing) scheduleTick();
    });
    ui.zoom.addEventListener("input", function() {
      var zoom = parseFloat(ui.zoom.value) || 4;
      ui.zoomValue.textContent = "×" + formatDecimal(zoom, zoom % 1 ? 1 : 0);
      state.camera.targetZoom = zoom;
      if (state.current) focusCurrentPair();
      else animateCamera();
    });
  }

  function publishTestState() {
    window.matchingLabTestApi = {
      getState: function() {
        return {
          ready: state.ready,
          starCount: state.stars.length,
          pairCount: state.pairCount,
          previewCount: state.previewAttempts.length,
          validPreviewCount: state.previewAttempts.filter(function(attempt) { return attempt.success; }).length,
          currentPair: state.current ? state.current.attempt.pairIndex : -1,
          revealed: state.current ? state.current.revealed : 0,
          cameraFocus: state.camera.targetFocus.slice(),
          cameraZoom: state.camera.targetZoom,
          playing: state.playing
        };
      },
      step: function() {
        advancePlayback();
        return this.getState();
      }
    };
  }

  function init() {
    ui.btnPlay.disabled = true;
    ui.btnStep.disabled = true;
    bindControls();
    bindCanvasNavigation();
    loadDraft();
    syncParameterLabels();
    resizeCanvas();
    if (window.ResizeObserver) {
      new ResizeObserver(resizeCanvas).observe(ui.stage);
    } else {
      window.addEventListener("resize", resizeCanvas);
    }
    publishTestState();
    loadCatalog();
  }

  init();
})();

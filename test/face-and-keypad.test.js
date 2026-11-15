const { test } = require("node:test");
const assert = require("node:assert/strict");
const { analyzeFaceFrame } = require("../public/face-check");
const {
  STORAGE_KEY,
  MAX_ITEMS,
  emptyHistory,
  loadHistory,
  recordVerificationHistory,
  clearVerificationHistory,
  applyKeypadPress,
} = require("../public/keypad-history");

function makeFrame(width, height, bg = [225, 225, 225]) {
  const buf = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = bg[0];
    buf[i * 4 + 1] = bg[1];
    buf[i * 4 + 2] = bg[2];
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

function drawRealisticFace(width = 160, height = 120, options = {}) {
  const {
    shiftX = 0,
    sunglasses = false,
    mask = false,
    eyesClosed = false,
    darkFrame = false,
  } = options;
  const buf = makeFrame(width, height, darkFrame ? [12, 12, 12] : [235, 232, 225]);
  const cx = width * 0.5 + shiftX;
  const cy = height * 0.48;
  const rx = width * 0.22;
  const ry = height * 0.34;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1.0) {
        const ny = y / height;
        const nx = (x - shiftX) / width;
        const idx = (y * width + x) * 4;
        // Natural skin shading with slight nose-bridge highlight and cheek warmth
        const shade = Math.round(18 * (1 - Math.abs(dx) * 0.7) - 10 * Math.abs(dy));
        let r = darkFrame ? 24 : 204 + shade;
        let g = darkFrame ? 18 : 156 + shade;
        let b = darkFrame ? 15 : 124 + shade;

        // Eyebrows
        if (
          !darkFrame &&
          ny >= 0.26 &&
          ny <= 0.29 &&
          ((nx >= 0.34 && nx <= 0.45) || (nx >= 0.55 && nx <= 0.66))
        ) {
          r = 45;
          g = 35;
          b = 30;
        }

        // Eye sockets / sclera + iris contrast
        if (ny >= 0.31 && ny <= 0.43 && ((nx >= 0.33 && nx <= 0.45) || (nx >= 0.55 && nx <= 0.67))) {
          if (sunglasses) {
            r = 16;
            g = 16;
            b = 18;
          } else if (eyesClosed) {
            // Flat closed eyelid near skin color with no iris contrast
            r = 196;
            g = 148;
            b = 118;
          } else {
            const eyeCx = nx < 0.5 ? 0.39 : 0.61;
            const distEye = Math.hypot((nx - eyeCx) * width, (ny - 0.37) * height);
            if (distEye < 3.5) {
              // Dark iris/pupil
              r = 28;
              g = 24;
              b = 22;
            } else if (distEye < 6.5) {
              // Bright sclera
              r = 245;
              g = 244;
              b = 240;
            }
          }
        }

        // Mouth / lower-face natural skin & lip line
        if (ny >= 0.55 && ny <= 0.78) {
          if (mask) {
            // Flat blue surgical mask blocking lower face
            r = 108;
            g = 164;
            b = 210;
          } else if (ny >= 0.64 && ny <= 0.68 && nx >= 0.43 && nx <= 0.57) {
            r = 152;
            g = 88;
            b = 82;
          }
        }

        buf[idx] = Math.max(0, Math.min(255, r));
        buf[idx + 1] = Math.max(0, Math.min(255, g));
        buf[idx + 2] = Math.max(0, Math.min(255, b));
      }
    }
  }
  return buf;
}

test("classical face verification passes for a clear centered unobstructed face", () => {
  const rgba = drawRealisticFace(160, 120);
  const res = analyzeFaceFrame(rgba, 160, 120);
  assert.equal(res.ok, true, `Expected ready, got ${res.code} (${JSON.stringify(res)})`);
  assert.equal(res.code, "ready");
  assert.deepEqual(res.checks, {
    lighting: true,
    centered: true,
    eyesOpen: true,
    unobstructed: true,
  });

  // Low-light indoor mobile camera frame (darkened 0.16x) still succeeds cleanly
  const dim = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    dim[i] = Math.round(rgba[i] * 0.16);
    dim[i + 1] = Math.round(rgba[i + 1] * 0.16);
    dim[i + 2] = Math.round(rgba[i + 2] * 0.16);
    dim[i + 3] = 255;
  }
  const dimRes = analyzeFaceFrame(dim, 160, 120);
  assert.equal(dimRes.ok, true, `Expected dim low-light ready, got ${dimRes.code} (${JSON.stringify(dimRes)})`);
  assert.equal(dimRes.checks.lighting, true);
  assert.equal(dimRes.checks.eyesOpen, true);
});

test("classical face verification rejects covered lens, sunglasses, closed eyes, mask, and off-center faces", () => {
  const noFrame = analyzeFaceFrame(null, 0, 0);
  assert.equal(noFrame.ok, false);
  assert.equal(noFrame.code, "no_frame");

  const covered = analyzeFaceFrame(makeFrame(160, 120, [8, 8, 8]), 160, 120);
  assert.equal(covered.ok, false);
  assert.equal(covered.code, "too_dark");

  const blankWall = analyzeFaceFrame(makeFrame(160, 120, [220, 220, 220]), 160, 120);
  assert.equal(blankWall.ok, false);
  assert.equal(blankWall.code, "lens_covered");

  const sunglasses = analyzeFaceFrame(
    drawRealisticFace(160, 120, { sunglasses: true }),
    160,
    120,
  );
  assert.equal(sunglasses.ok, false);
  assert.equal(sunglasses.checks.eyesOpen, false);

  const closedEyes = analyzeFaceFrame(
    drawRealisticFace(160, 120, { eyesClosed: true }),
    160,
    120,
  );
  assert.equal(closedEyes.ok, false);
  assert.equal(closedEyes.checks.eyesOpen, false);

  const masked = analyzeFaceFrame(
    drawRealisticFace(160, 120, { mask: true }),
    160,
    120,
  );
  assert.equal(masked.ok, false);
  assert.equal(masked.checks.unobstructed, false);

  const offCenter = analyzeFaceFrame(
    drawRealisticFace(160, 120, { shiftX: 52 }),
    160,
    120,
  );
  assert.equal(offCenter.ok, false);
});

test("keypad-history tracks recent entries, deduplicates, clears cleanly, and applies keypad presses", () => {
  const store = new Map();
  const mockStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  assert.deepEqual(loadHistory(mockStorage), emptyHistory());

  recordVerificationHistory(mockStorage, {
    birthMonth: "1",
    birthYear: "2014",
    grNumber: "4501",
  });
  recordVerificationHistory(mockStorage, {
    birthMonth: "06",
    birthYear: "2012",
    grNumber: "BF-101",
  });
  // Re-adding 4501 should move it to front without duplicates
  recordVerificationHistory(mockStorage, {
    birthMonth: "01",
    birthYear: "2014",
    grNumber: "4501",
  });

  const loaded = loadHistory(mockStorage);
  assert.equal(STORAGE_KEY, "rjc_verify_history_v1");
  assert.deepEqual(loaded.months, ["01", "06"]);
  assert.deepEqual(loaded.years, ["2014", "2012"]);
  assert.deepEqual(loaded.grNumbers, ["4501", "BF-101"]);

  // Invalid month or year ignored
  recordVerificationHistory(mockStorage, {
    birthMonth: "99",
    birthYear: "20",
    grNumber: "4502",
  });
  const afterInvalid = loadHistory(mockStorage);
  assert.deepEqual(afterInvalid.months, ["01", "06"]);
  assert.deepEqual(afterInvalid.years, ["2014", "2012"]);
  assert.equal(afterInvalid.grNumbers[0], "4502");

  // Cap at MAX_ITEMS
  for (let i = 1; i <= 10; i++) {
    recordVerificationHistory(mockStorage, {
      birthMonth: "05",
      birthYear: String(2000 + i),
      grNumber: `GR-${i}`,
    });
  }
  assert.equal(loadHistory(mockStorage).years.length, MAX_ITEMS);
  assert.equal(loadHistory(mockStorage).grNumbers.length, MAX_ITEMS);

  // Clear wipes all history
  const cleared = clearVerificationHistory(mockStorage);
  assert.deepEqual(cleared, emptyHistory());
  assert.deepEqual(loadHistory(mockStorage), emptyHistory());

  // Keypad press helper behavior
  assert.equal(applyKeypadPress("", "0", { numericOnly: true, maxLength: 2 }), "0");
  assert.equal(applyKeypadPress("01", "2", { numericOnly: true, maxLength: 2 }), "01");
  assert.equal(applyKeypadPress("201", "4", { numericOnly: true, maxLength: 4 }), "2014");
  assert.equal(applyKeypadPress("2014", "BACKSPACE", { numericOnly: true, maxLength: 4 }), "201");
  assert.equal(applyKeypadPress("2014", "CLEAR", { numericOnly: true, maxLength: 4 }), "");
  assert.equal(applyKeypadPress("BF-", "A", { numericOnly: true, maxLength: 10 }), "BF-");
  assert.equal(applyKeypadPress("BF-", "A", { numericOnly: false, maxLength: 10 }), "BF-A");
});

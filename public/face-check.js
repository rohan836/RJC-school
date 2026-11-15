(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.RjcFaceCheck = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // Classical non-AI pattern recognition for parent face proof:
  // Checks lighting, frame contrast, center presence, horizontal bilateral balance,
  // upper-band eye contrast, and lower-face natural skin/gradient continuity.
  // Tuned forgivingly so real school office webcams succeed smoothly when a clear
  // face is centered, while blocking covered lenses, dark sunglasses/masks, or empty frames.
  function analyzeFaceFrame(rgba, width, height) {
    if (!rgba || !width || !height || rgba.length < width * height * 4) {
      return {
        ok: false,
        code: "no_frame",
        checks: { lighting: false, centered: false, eyesOpen: false, unobstructed: false },
        metrics: { luma: 0, contrast: 0, centerScore: 0, eyeScore: 0, lowerScore: 0, symmetry: 0 },
      };
    }

    const total = width * height;
    let sumLuma = 0;
    let sumLumaSq = 0;

    // Oval center ROI: x in [0.26, 0.74], y in [0.14, 0.86]
    const cx = width * 0.5;
    const cy = height * 0.48;
    const rx = width * 0.24;
    const ry = height * 0.34;

    let roiCount = 0;
    let roiSkinOrWarm = 0;
    let roiLumaSum = 0;
    let roiLumaSq = 0;

    let bgCount = 0;
    let bgLumaSum = 0;

    // Eye band inside ROI: y in [0.28, 0.46]
    let leftEyeDarkCount = 0;
    let leftEyeCount = 0;
    let leftEyeLumaSum = 0;
    let leftEyeLumaSq = 0;

    let rightEyeDarkCount = 0;
    let rightEyeCount = 0;
    let rightEyeLumaSum = 0;
    let rightEyeLumaSq = 0;

    // Forehead / cheek reference band for eye comparison: y in [0.20, 0.28] & [0.47, 0.56]
    let refSum = 0;
    let refCount = 0;

    // Lower face band: y in [0.54, 0.78], x in [0.32, 0.68]
    let lowerSum = 0;
    let lowerSq = 0;
    let lowerSkin = 0;
    let lowerCount = 0;

    // Bilateral horizontal balance in center box
    let leftMass = 0;
    let rightMass = 0;
    let leftHalfCount = 0;
    let rightHalfCount = 0;

    for (let y = 0; y < height; y++) {
      const ny = y / height;
      for (let x = 0; x < width; x++) {
        const nx = x / width;
        const idx = (y * width + x) * 4;
        const r = rgba[idx];
        const g = rgba[idx + 1];
        const b = rgba[idx + 2];
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;

        sumLuma += luma;
        sumLumaSq += luma * luma;

        // Broad YCbCr skin/natural tone check (inclusive across diverse skin tones & dim mobile webcams)
        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        const isNaturalTone =
          luma > 12 &&
          cb >= 64 &&
          cb <= 146 &&
          cr >= 118 &&
          cr <= 190 &&
          r >= b * 0.72;

        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const inOval = dx * dx + dy * dy <= 1.0;

        if (inOval) {
          roiCount++;
          roiLumaSum += luma;
          roiLumaSq += luma * luma;
          if (isNaturalTone) roiSkinOrWarm++;

          if (nx < 0.5) {
            leftMass += luma;
            leftHalfCount++;
          } else {
            rightMass += luma;
            rightHalfCount++;
          }

          if ((ny >= 0.20 && ny < 0.28) || (ny >= 0.47 && ny < 0.55)) {
            if (nx >= 0.34 && nx <= 0.66) {
              refSum += luma;
              refCount++;
            }
          }
          if (ny >= 0.31 && ny <= 0.45) {
            if (nx >= 0.32 && nx <= 0.47) {
              leftEyeCount++;
              leftEyeLumaSum += luma;
              leftEyeLumaSq += luma * luma;
            } else if (nx >= 0.53 && nx <= 0.68) {
              rightEyeCount++;
              rightEyeLumaSum += luma;
              rightEyeLumaSq += luma * luma;
            }
          }
          if (ny >= 0.54 && ny <= 0.78 && nx >= 0.33 && nx <= 0.67) {
            lowerCount++;
            lowerSum += luma;
            lowerSq += luma * luma;
            if (isNaturalTone) lowerSkin++;
          }
        } else if (nx < 0.16 || nx > 0.84) {
          bgCount++;
          bgLumaSum += luma;
        }
      }
    }

    const meanLuma = sumLuma / total;
    const globalVar = Math.max(0, sumLumaSq / total - meanLuma * meanLuma);
    const contrast = Math.sqrt(globalVar);

    const roiMean = roiCount ? roiLumaSum / roiCount : 0;
    const roiContrast = roiCount
      ? Math.sqrt(Math.max(0, roiLumaSq / roiCount - roiMean * roiMean))
      : 0;
    const skinRatio = roiCount ? roiSkinOrWarm / roiCount : 0;
    const bgMean = bgCount ? bgLumaSum / bgCount : meanLuma;
    const fgSeparation = Math.abs(roiMean - bgMean);

    const refMean = refCount ? refSum / refCount : roiMean;
    const leftEyeMean = leftEyeCount ? leftEyeLumaSum / leftEyeCount : refMean;
    const rightEyeMean = rightEyeCount ? rightEyeLumaSum / rightEyeCount : refMean;

    // Count darker iris/pupil/lash pixels relative to cheek/forehead reference
    const eyeDarkThreshold = Math.max(10, refMean * 0.84);
    for (let y = Math.floor(height * 0.31); y <= Math.ceil(height * 0.45); y++) {
      for (let x = Math.floor(width * 0.32); x <= Math.ceil(width * 0.68); x++) {
        const nx = x / width;
        if (nx > 0.47 && nx < 0.53) continue;
        const idx = (y * width + x) * 4;
        const luma = 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
        if (luma < eyeDarkThreshold) {
          if (nx <= 0.47) leftEyeDarkCount++;
          else rightEyeDarkCount++;
        }
      }
    }

    const leftEyeStd = leftEyeCount
      ? Math.sqrt(Math.max(0, leftEyeLumaSq / leftEyeCount - leftEyeMean * leftEyeMean))
      : 0;
    const rightEyeStd = rightEyeCount
      ? Math.sqrt(Math.max(0, rightEyeLumaSq / rightEyeCount - rightEyeMean * rightEyeMean))
      : 0;
    const leftDarkFrac = leftEyeCount ? leftEyeDarkCount / leftEyeCount : 0;
    const rightDarkFrac = rightEyeCount ? rightEyeDarkCount / rightEyeCount : 0;

    const lowerMean = lowerCount ? lowerSum / lowerCount : 0;
    const lowerStd = lowerCount
      ? Math.sqrt(Math.max(0, lowerSq / lowerCount - lowerMean * lowerMean))
      : 0;
    const lowerSkinRatio = lowerCount ? lowerSkin / lowerCount : 0;

    const leftAvg = leftHalfCount ? leftMass / leftHalfCount : 1;
    const rightAvg = rightHalfCount ? rightMass / rightHalfCount : 1;
    const symmetryDiff = Math.abs(leftAvg - rightAvg) / Math.max(16, (leftAvg + rightAvg) * 0.5);

    const lightingOk = meanLuma >= 10 && meanLuma <= 248 && contrast >= 3.8;
    const centeredOk =
      roiContrast >= 3.2 &&
      (skinRatio >= 0.14 || (fgSeparation >= 7 && roiContrast >= 9)) &&
      symmetryDiff <= 0.50;

    // Open & visible eyes: supports low-light mobile cameras (with dim iris contrast)
    // while catching dark sunglasses or completely flat closed eyelids.
    const bothEyesDetailed =
      Math.min(leftEyeStd, rightEyeStd) >= 4.2 &&
      (leftEyeStd + rightEyeStd) * 0.5 >= 4.8;
    const notDarkSunglasses = leftDarkFrac <= 0.60 && rightDarkFrac <= 0.60;
    const eyesHaveFeature =
      (leftDarkFrac >= 0.01 && rightDarkFrac >= 0.01) ||
      (leftEyeStd >= 9.5 && rightEyeStd >= 9.5);
    const eyesOk = bothEyesDetailed && notDarkSunglasses && eyesHaveFeature;

    // Unobstructed lower face: natural skin tone present below the nose bridge (catches masks/scarves).
    const unobstructedOk = lowerSkinRatio >= 0.08 && lowerStd >= 2.0;

    const centerScore = clamp(
      (skinRatio * 0.65 + clamp(fgSeparation / 30, 0, 1) * 0.35) * (1 - clamp(symmetryDiff, 0, 0.5)),
      0,
      1,
    );
    const eyeScore = clamp(((leftEyeStd + rightEyeStd) / 30) * (notDarkSunglasses ? 1 : 0.2), 0, 1);
    const lowerScore = clamp(lowerSkinRatio * 0.7 + clamp(lowerStd / 24, 0, 1) * 0.3, 0, 1);

    let code = "ready";
    if (!lightingOk) {
      code = meanLuma < 10 ? "too_dark" : meanLuma > 248 ? "too_bright" : "lens_covered";
    } else if (!centeredOk) {
      code = symmetryDiff > 0.50 ? "look_straight" : "center_face";
    } else if (!eyesOk) {
      code = !notDarkSunglasses ? "remove_glasses" : "eyes_unclear";
    } else if (!unobstructedOk) {
      code = "face_covered";
    }

    return {
      ok: code === "ready",
      code,
      checks: {
        lighting: lightingOk,
        centered: centeredOk,
        eyesOpen: eyesOk,
        unobstructed: unobstructedOk,
      },
      metrics: {
        luma: Math.round(meanLuma),
        contrast: Math.round(contrast * 10) / 10,
        centerScore: Math.round(centerScore * 100) / 100,
        eyeScore: Math.round(eyeScore * 100) / 100,
        lowerScore: Math.round(lowerScore * 100) / 100,
        symmetry: Math.round((1 - clamp(symmetryDiff, 0, 1)) * 100) / 100,
      },
    };
  }

  return { analyzeFaceFrame };
});

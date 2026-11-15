(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.RjcKeypadHistory = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STORAGE_KEY = "rjc_verify_history_v1";
  const MAX_ITEMS = 6;

  function emptyHistory() {
    return { months: [], years: [], grNumbers: [] };
  }

  function sanitizeItem(field, value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (field === "months") {
      if (!/^\d{1,2}$/.test(raw)) return "";
      const n = Number(raw);
      return n >= 1 && n <= 12 ? String(n).padStart(2, "0") : "";
    }
    if (field === "years") {
      return /^\d{4}$/.test(raw) ? raw : "";
    }
    if (field === "grNumbers") {
      return raw.slice(0, 64);
    }
    return "";
  }

  function loadHistory(storage) {
    try {
      const raw = storage ? storage.getItem(STORAGE_KEY) : null;
      if (!raw) return emptyHistory();
      const parsed = JSON.parse(raw);
      return {
        months: Array.isArray(parsed.months)
          ? parsed.months.map((v) => sanitizeItem("months", v)).filter(Boolean).slice(0, MAX_ITEMS)
          : [],
        years: Array.isArray(parsed.years)
          ? parsed.years.map((v) => sanitizeItem("years", v)).filter(Boolean).slice(0, MAX_ITEMS)
          : [],
        grNumbers: Array.isArray(parsed.grNumbers)
          ? parsed.grNumbers.map((v) => sanitizeItem("grNumbers", v)).filter(Boolean).slice(0, MAX_ITEMS)
          : [],
      };
    } catch {
      return emptyHistory();
    }
  }

  function saveHistory(storage, history) {
    try {
      if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch {}
  }

  function recordVerificationHistory(storage, { birthMonth, birthYear, grNumber }) {
    const h = loadHistory(storage);
    const pushUnique = (list, field, val) => {
      const clean = sanitizeItem(field, val);
      if (!clean) return list;
      return [clean, ...list.filter((x) => x !== clean)].slice(0, MAX_ITEMS);
    };
    const next = {
      months: pushUnique(h.months, "months", birthMonth),
      years: pushUnique(h.years, "years", birthYear),
      grNumbers: pushUnique(h.grNumbers, "grNumbers", grNumber),
    };
    saveHistory(storage, next);
    return next;
  }

  function clearVerificationHistory(storage) {
    const cleared = emptyHistory();
    try {
      if (storage) storage.removeItem(STORAGE_KEY);
    } catch {}
    return cleared;
  }

  function applyKeypadPress(currentValue, key, { numericOnly = true, maxLength = 64 } = {}) {
    const val = String(currentValue ?? "");
    if (key === "CLEAR") return "";
    if (key === "BACKSPACE") return val.slice(0, -1);
    const ch = String(key || "");
    if (!ch) return val;
    if (numericOnly && !/^\d$/.test(ch)) return val;
    if (val.length >= maxLength) return val;
    return val + ch;
  }

  return {
    STORAGE_KEY,
    MAX_ITEMS,
    emptyHistory,
    loadHistory,
    recordVerificationHistory,
    clearVerificationHistory,
    applyKeypadPress,
  };
});

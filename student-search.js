"use strict";

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
}

function digits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function numericLookalikes(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[oOqQ]/g, "0")
    .replace(/[iIlL]/g, "1")
    .replace(/[zZ]/g, "2")
    .replace(/[sS]/g, "5")
    .replace(/[bB]/g, "8")
    .replace(/[gG]/g, "6");
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a || !b) return Math.max(a.length, b.length);
  let previousPrevious = null;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
      if (
        previousPrevious &&
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      )
        value = Math.min(value, previousPrevious[j - 2] + 1);
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > 2 && Math.abs(a.length - b.length) > 2) return rowMin;
    previousPrevious = previous;
    previous = current;
  }
  return previous[b.length];
}

function tokenScore(query, candidate) {
  if (!query || !candidate) return 0;
  if (query === candidate) return 1;
  if (query.length >= 2 && candidate.startsWith(query))
    return 0.84 + 0.12 * (query.length / candidate.length);
  if (query.length >= 2 && candidate.includes(query))
    return 0.76 + 0.1 * (query.length / candidate.length);
  if (query.length < 3) return 0;
  const distance = editDistance(query, candidate);
  const maxDistance = query.length >= 8 ? 2 : 1;
  if (distance <= maxDistance) return 0.82 - (distance - 1) * 0.1;
  return 0;
}

function wordScore(query, candidate) {
  const queryWords = normalize(query).split(/\s+/).filter(Boolean);
  const candidateWords = normalize(candidate).split(/\s+/).filter(Boolean);
  if (!queryWords.length || !candidateWords.length) return 0;
  const matches = queryWords.map((word) =>
    Math.max(
      0,
      ...candidateWords.map((candidateWord) => tokenScore(word, candidateWord)),
    ),
  );
  const matched = matches.filter((score) => score > 0);
  const coverage = matched.length / queryWords.length;
  if (coverage < (queryWords.length > 1 ? 0.67 : 1)) return 0;
  const average =
    matched.reduce((total, score) => total + score, 0) / matched.length;
  return average - (1 - coverage) * 0.22;
}

function numberScore(query, candidate, kind) {
  if (!query || !candidate) return 0;
  if (candidate === query) return kind === "gr" ? 1 : 0.96;
  if (candidate.startsWith(query)) return kind === "gr" ? 0.94 : 0.84;
  if (query.length >= 4 && candidate.includes(query))
    return kind === "gr" ? 0.91 : 0.84;
  if (kind === "phone" && query.length < 7) return 0;
  if (query.length < 3) return 0;
  let distance = editDistance(query, candidate);
  if (kind === "phone" && query.length < candidate.length) {
    for (let start = 0; start < candidate.length; start++)
      for (const length of [query.length - 1, query.length, query.length + 1]) {
        if (length > 0 && start + length <= candidate.length)
          distance = Math.min(
            distance,
            editDistance(query, candidate.slice(start, start + length)),
          );
      }
  }
  const maxDistance = query.length >= 7 ? 2 : 1;
  if (distance <= maxDistance)
    return kind === "gr"
      ? 0.81 - (distance - 1) * 0.1
      : 0.7 - (distance - 1) * 0.1;
  return 0;
}

function scoreStudent(student, rawQuery) {
  let query = normalize(rawQuery);
  if (query.length < 2) return 0;

  const grPrefix = /^(?:gr|g\s*r)(?:\s+(?:no|number))?\s+(.+)$/i.exec(query);
  if (grPrefix) query = grPrefix[1];
  const compactQuery = query.replace(/\s/g, "");
  const looksNumeric =
    /\d/.test(compactQuery) && /^[\doqilszbg]+$/i.test(compactQuery);
  const queryDigits = numericLookalikes(compactQuery);
  if (looksNumeric) {
    const gr = numericLookalikes(
      normalize(student.gr_number).replace(/\s/g, ""),
    );
    const phoneDigits = digits(student.parent_phone);
    const phone =
      queryDigits.length >= 12 && queryDigits.startsWith("91")
        ? queryDigits.slice(2)
        : queryDigits;
    return Math.max(
      numberScore(queryDigits, gr, "gr"),
      numberScore(phone, phoneDigits, "phone"),
    );
  }

  const name = wordScore(rawQuery, student.full_name);
  const father = wordScore(rawQuery, student.father_name) * 0.9;
  const classDivision =
    wordScore(
      rawQuery,
      `${student.class_name || ""} ${student.division || ""}`,
    ) * 0.76;
  const gr = wordScore(rawQuery, student.gr_number) * 0.9;
  return Math.max(name, father, classDivision, gr);
}

function rankStudents(students, query, limit = 15) {
  const normalizedQuery = normalize(query);
  if (normalizedQuery.length < 2) return [];
  return students
    .map((student) => ({ student, score: scoreStudent(student, query) }))
    .filter(({ score }) => score >= 0.58)
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(a.student.full_name).localeCompare(String(b.student.full_name)),
    )
    .slice(0, limit)
    .map(({ student }) => student);
}

module.exports = { rankStudents, scoreStudent };

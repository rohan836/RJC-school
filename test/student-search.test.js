const { test } = require("node:test");
const assert = require("node:assert/strict");
const { rankStudents } = require("../student-search");

const students = [
  {
    gr_number: "4501",
    full_name: "Aarav Sunil Patil",
    father_name: "Sunil Tukaram Patil",
    class_name: "8th",
    division: "A",
    parent_phone: "9822011111",
  },
  {
    gr_number: "4502",
    full_name: "Rohan Singh",
    father_name: "Aarav Ramesh Singh",
    class_name: "9th",
    division: "B",
    parent_phone: "9822022222",
  },
  {
    gr_number: "4503",
    full_name: "सीता पाटील",
    father_name: "मोहन पाटील",
    class_name: "8th",
    division: "C",
    parent_phone: "9822033333",
  },
  {
    gr_number: "4504",
    full_name: "सिता पाटील",
    father_name: "सोहन पाटील",
    class_name: "8th",
    division: "D",
    parent_phone: "9822044444",
  },
];

test("ranks fuzzy names and numeric matches by strength", () => {
  for (const query of ["Aarv", "Aaraav", "Aarav Patil", "Aarav Sunl Ptail"])
    assert.equal(rankStudents(students, query)[0].gr_number, "4501", query);

  assert.equal(rankStudents(students, "4501")[0].gr_number, "4501");
  assert.equal(rankStudents(students, "45O1")[0].gr_number, "4501");
  assert.equal(rankStudents(students, "982201111")[0].gr_number, "4501");
  assert.equal(rankStudents(students, "9822011112")[0].gr_number, "4501");
  assert.equal(rankStudents(students, "98220111111")[0].gr_number, "4501");
});

test("preserves meaningful Devanagari vowel marks while ranking exact names first", () => {
  const ranked = rankStudents(students, "सीता");
  assert.equal(ranked[0].gr_number, "4503");
});

test("ignores too-short and unrelated queries", () => {
  assert.deepEqual(rankStudents(students, "x"), []);
  assert.deepEqual(rankStudents(students, "zzzz"), []);
});

test("two-letter searches match inside names without broad typo matches", () => {
  for (const query of ["ar", "AR", "ra", "ti"]) assert.equal(rankStudents(students, query)[0].gr_number, "4501", query);
  assert.deepEqual(rankStudents(students, "zz"), []);
});

import test from "node:test";
import assert from "node:assert/strict";

import { QUIZ, scoreQuiz, quizSummary, personaMarkdown, ARCHETYPES } from "./quiz.mjs";

// Оси и их полюса (буквы) — зеркало quiz.mjs (POLES/AXIS_ORDER там приватны). Первый
// полюс = буква при сумме >= 0. Порядок осей = порядок букв в коде.
const POLES = { tone: ["W", "D"], expr: ["V", "C"], init: ["P", "R"], mind: ["F", "N"] };
const AXIS_ORDER = ["tone", "expr", "init", "mind"];

// Все 16 кодов — декартово произведение полюсов по осям.
const ALL_CODES = [];
for (const t of POLES.tone)
  for (const e of POLES.expr)
    for (const i of POLES.init)
      for (const m of POLES.mind) ALL_CODES.push(`${t}${e}${i}${m}`);

// Крайние ответы, гарантированно дающие целевой код. Для каждого вопроса: если целевая
// буква оси — первый полюс, тянем сумму в плюс (учитывая реверс pole=-1), иначе в минус.
// Вес по индексу ответа [+2,+1,-1,-2]: индекс 0 = максимум согласия, 3 = максимум несогласия.
function answersFor(code) {
  return QUIZ.map((q) => {
    const wantFirst = code[AXIS_ORDER.indexOf(q.axis)] === POLES[q.axis][0];
    // pole=1: согласие (idx 0) тянет к первому полюсу; pole=-1 — реверс (idx 3 тянет к первому).
    if (wantFirst) return q.pole === 1 ? 0 : 3;
    return q.pole === 1 ? 3 : 0;
  });
}

test("scoreQuiz возвращает каждый из 16 кодов ровно один раз на крайних ответах", () => {
  const seen = new Set();
  for (const code of ALL_CODES) {
    const res = scoreQuiz(answersFor(code));
    assert.equal(res.code, code, `крайние ответы для ${code} должны дать ${code}, получено ${res.code}`);
    assert.equal(seen.has(res.code), false, `код ${res.code} получен повторно`);
    seen.add(res.code);
  }
  assert.equal(seen.size, 16);
});

test("ARCHETYPES содержит ровно 16 кодов — те же, что перечисляет скоринг", () => {
  assert.deepEqual(new Set(Object.keys(ARCHETYPES)), new Set(ALL_CODES));
  assert.equal(Object.keys(ARCHETYPES).length, 16);
});

test("у каждого кода портрет и персона непусты на ru/en, персона <= 800 символов", () => {
  for (const code of ALL_CODES) {
    for (const lang of ["ru", "en"]) {
      const summary = quizSummary(code, lang);
      assert.equal(typeof summary, "string");
      assert.ok(summary.trim().length > 0, `quizSummary(${code}, ${lang}) пуст`);
      assert.ok(summary.includes(code), `quizSummary(${code}, ${lang}) не содержит код`);

      const persona = personaMarkdown(code, lang);
      assert.equal(typeof persona, "string");
      assert.ok(persona.trim().length > 0, `personaMarkdown(${code}, ${lang}) пуст`);
      assert.ok(persona.length <= 800, `personaMarkdown(${code}, ${lang}) = ${persona.length} > 800`);
      // Самодостаточность: имя архетипа присутствует (персона — инструкция про этот характер).
      assert.ok(persona.includes(ARCHETYPES[code].name[lang]), `personaMarkdown(${code}, ${lang}) без имени архетипа`);
    }
  }
});

test("тай по оси (сумма 0) решается в пользу первого полюса", () => {
  // Пустые/битые ответы: все суммы 0 → все первые полюса → WVPF.
  assert.equal(scoreQuiz([]).code, "WVPF");
  // Все ответы «да» (idx 0): оси expr и mind дают ровно 0 (прямой +2 и реверс -2 гасятся) —
  // это настоящий тай, он обязан выбрать первый полюс (V и F), а не второй.
  const yes = scoreQuiz([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(yes.letters.expr, "V");
  assert.equal(yes.letters.mind, "F");
  assert.equal(yes.code, "WVPF");
});

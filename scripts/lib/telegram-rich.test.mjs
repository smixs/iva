// Self-check for needsRichMessage — run: node scripts/lib/telegram-rich.test.mjs
import { strict as assert } from "node:assert";
import { needsRichMessage } from "./telegram-format.mjs";

// Rich: constructs the HTML path can't render → route to sendRichMessage.
assert.equal(needsRichMessage("| a | b |\n|---|---|\n| 1 | 2 |"), true, "table");
assert.equal(needsRichMessage("col1 | col2\n:--- | ---:\nx | y"), true, "table no outer pipes");
assert.equal(needsRichMessage("- [ ] todo\n- [x] done"), true, "task list");
assert.equal(needsRichMessage("<details><summary>x</summary>y</details>"), true, "details");
assert.equal(needsRichMessage("formula:\n$$E = mc^2$$"), true, "block math");

// Plain: HTML path renders these fine → must stay off rich.
assert.equal(needsRichMessage("**bold** and _italic_ and `code`"), false, "inline fmt");
assert.equal(needsRichMessage("## Heading\n\ntext\n\n> quote"), false, "heading+quote");
assert.equal(needsRichMessage("- bullet\n- list"), false, "plain list");
assert.equal(needsRichMessage("price is $5 and $10"), false, "inline dollars (not $$)");
assert.equal(needsRichMessage("a | b without a delimiter row"), false, "pipe but no table");
assert.equal(needsRichMessage(""), false, "empty");

console.log("telegram-rich: all assertions passed");

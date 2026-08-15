/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  escapeMarkdownUrl,
  extractRichMessageArchivalText,
  extractRichMessageSafeModelText,
  extractRichMessagePhotos,
  isValidUrlScheme,
  MAX_RICH_MESSAGE_NODES,
} from "./telegram-rich-message.ts";
import type { TelegramRawMedia } from "./telegram-parts.ts";

const PROPERTY_SEED = 20260816;

describe("telegram-rich-message", () => {
  describe("escapeMarkdownUrl", () => {
    it("encodes newlines, tabs, spaces, and angle brackets", () => {
      assert.equal(
        escapeMarkdownUrl("https://example.com/a\nb c<d>"),
        "https://example.com/a%0Ab%20c%3Cd%3E",
      );
    });

    it("preserves parentheses and ordinary query parameters", () => {
      assert.equal(
        escapeMarkdownUrl("https://example.com/api?a=1&(b=2)"),
        "https://example.com/api?a=1&\\(b=2\\)",
      );
    });

    it("sanitizes C0 controls, tabs, newlines, DEL, whitespace, and angle brackets in URLs", () => {
      const domain = ["ex", "ample", ".", "com"].join("");
      const input = `https://${domain}/a\t\r\n\0\x1F\x7F b(c)<d>?q=1&v=2\\3`;
      const expected = `https://${domain}/a%09%0D%0A%00%1F%7F%20b\\(c\\)%3Cd%3E?q=1&v=2\\\\3`;
      assert.strictEqual(escapeMarkdownUrl(input), expected);
    });
  });

  describe("extractRichMessageSafeModelText", () => {
    it("returns null for non-record and empty inputs", () => {
      assert.equal(extractRichMessageSafeModelText(null), null);
      assert.equal(extractRichMessageSafeModelText(undefined), null);
      assert.equal(extractRichMessageSafeModelText("string"), null);
      assert.equal(extractRichMessageSafeModelText(123), null);
      assert.equal(extractRichMessageSafeModelText({}), null);
      assert.equal(extractRichMessageSafeModelText({ blocks: [] }), null);
      assert.equal(
        extractRichMessageSafeModelText({ blocks: [{ type: "unknown" }] }),
        null,
      );
    });

    it("parses plain paragraph strings", () => {
      const payload = {
        blocks: [
          { type: "paragraph", text: "First paragraph." },
          { type: "paragraph", text: "Second paragraph." },
        ],
      };
      assert.equal(
        extractRichMessageSafeModelText(payload),
        "First paragraph.\n\nSecond paragraph.",
      );
    });

    it("preserves empty paragraphs and internal formatting", () => {
      const payload = {
        blocks: [
          { type: "paragraph", text: "Header" },
          { type: "paragraph", text: "  " },
          { type: "paragraph", text: "Footer" },
        ],
      };
      assert.equal(
        extractRichMessageSafeModelText(payload),
        "Header\n\n  \n\nFooter",
      );
    });

    it("reconstructs complex inline tokens (url, italic, bold, mention)", () => {
      const payload = {
        blocks: [
          {
            type: "paragraph",
            text: [
              "Intro with ",
              { type: "url", text: "a link", url: "https://example.com" },
              ", some ",
              { type: "italic", text: "italic text" },
              " and ",
              { type: "bold", text: "bold text" },
              ". Mention: ",
              { type: "mention", text: "@dev", username: "dev" },
              "!",
            ],
          },
        ],
      };
      assert.equal(
        extractRichMessageSafeModelText(payload),
        "Intro with [a link](https://example.com), some *italic text* and **bold text**. Mention: @dev!",
      );
    });

    it("handles forward compatibility for unknown token types", () => {
      const payload = {
        blocks: [
          {
            type: "paragraph",
            text: ["Standard ", { type: "future_token", text: "raw content" }],
          },
        ],
      };
      assert.equal(
        extractRichMessageSafeModelText(payload),
        "Standard raw content",
      );
    });

    it("returns null when every paragraph is whitespace-only", () => {
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            { type: "paragraph", text: "   " },
            { type: "paragraph", text: "\n\t" },
          ],
        }),
        null,
      );
    });

    it("falls back to mention text when username is missing", () => {
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            {
              type: "paragraph",
              text: [{ type: "mention", text: "Ada Lovelace" }],
            },
          ],
        }),
        "Ada Lovelace",
      );
    });

    it("keeps an existing @ on mention usernames", () => {
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            {
              type: "paragraph",
              text: [{ type: "mention", username: "@already" }],
            },
          ],
        }),
        "@already",
      );
    });

    it("keeps empty italic and bold wrappers and url without a href", () => {
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            {
              type: "paragraph",
              text: [
                { type: "italic", text: "" },
                { type: "bold", text: "" },
                { type: "url", text: "orphan", url: "   " },
                " kept",
              ],
            },
          ],
        }),
        "******orphan kept",
      );
    });

    it("escapes brackets in labels and parentheses in urls", () => {
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            {
              type: "paragraph",
              text: [
                {
                  type: "url",
                  text: "see [this]",
                  url: "https://example.com/a(b)",
                },
              ],
            },
          ],
        }),
        "[see \\[this\\]](https://example.com/a\\(b\\))",
      );
    });

    it("escapes backslashes before brackets and parentheses", () => {
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            {
              type: "paragraph",
              text: [
                {
                  type: "url",
                  text: "test\\[val\\]",
                  url: "https://example.com/a\\(b\\)",
                },
              ],
            },
          ],
        }),
        "[test\\\\\\[val\\\\\\]](https://example.com/a\\\\\\(b\\\\\\))",
      );
    });

    it("serializes nested tokens and ignores junk inlines", () => {
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            {
              type: "paragraph",
              text: [
                { type: "bold", text: [{ type: "italic", text: "hi" }] },
                12,
                null,
                { type: "url", text: ["nested ", { type: "bold", text: "x" }] },
              ],
            },
          ],
        }),
        "***hi***nested **x**",
      );
    });

    it("treats inner-text markdown as an escaped label when the url is already a scheme", () => {
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            {
              type: "paragraph",
              text: [
                {
                  type: "url",
                  url: "https://example.com",
                  text: "[Label](https://link.example/)",
                },
              ],
            },
          ],
        }),
        "[\\[Label\\](https://link.example/)](https://example.com)",
      );
    });

    it("skips non-record blocks and photo blocks in the text reconstruction", () => {
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            null,
            "nope",
            {
              type: "photo",
              photo: [{ file_id: "p1", width: 10, height: 10 }],
            },
            { type: "paragraph", text: "Only text" },
            7,
          ],
        }),
        "Only text",
      );
    });

    it("extracts text from non-paragraph text-bearing blocks (headers, quotes, lists)", () => {
      const payload = {
        blocks: [
          { type: "header", text: "Header Title" },
          {
            type: "blockquote",
            text: [{ type: "italic", text: "Quoted text" }],
          },
          { type: "list_item", text: "Item 1" },
          { type: "unknown_custom", text: "Custom text" },
        ],
      };
      assert.strictEqual(
        extractRichMessageSafeModelText(payload),
        "Header Title\n\n*Quoted text*\n\nItem 1\n\nCustom text",
      );
    });

    it("ignores blocks without text while extracting text-bearing blocks and photos", () => {
      const payload = {
        blocks: [
          { type: "paragraph", text: "Intro" },
          { type: "divider" }, // no text, ignored
          {
            type: "photo",
            photo: [{ file_id: "p1", width: 100, height: 100 }],
          },
          { type: "callout", text: "Outro" },
        ],
      };
      assert.strictEqual(
        extractRichMessageSafeModelText(payload),
        "Intro\n\nOutro",
      );
      assert.strictEqual(extractRichMessagePhotos(payload).length, 1);
    });

    it("is deterministic on the same payload", () => {
      const payload = {
        blocks: [
          { type: "paragraph", text: "Once" },
          { type: "paragraph", text: [{ type: "bold", text: "twice" }] },
        ],
      };
      assert.equal(
        extractRichMessageSafeModelText(payload),
        extractRichMessageSafeModelText(payload),
      );
    });

    it("returns null for throwing getters without bubbling", () => {
      const hostile = {
        get blocks() {
          throw new Error("hostile");
        },
      };
      assert.equal(extractRichMessageSafeModelText(hostile), null);
      assert.doesNotThrow(() => extractRichMessageSafeModelText(hostile));
      assert.deepEqual(extractRichMessagePhotos(hostile), []);
      assert.doesNotThrow(() => extractRichMessagePhotos(hostile));
      assert.equal(extractRichMessageArchivalText(hostile), null);
      assert.doesNotThrow(() => extractRichMessageArchivalText(hostile));
      assert.equal(extractRichMessageSafeModelText(hostile), null);
      assert.doesNotThrow(() => extractRichMessageSafeModelText(hostile));
    });

    it("handles throwing text getter safely by returning null", () => {
      const hostileBlock = {};
      Object.defineProperty(hostileBlock, "text", {
        get() {
          throw new Error("hostile getter access");
        },
      });
      const payload = { blocks: [hostileBlock] };
      assert.strictEqual(extractRichMessageSafeModelText(payload), null);
      assert.strictEqual(extractRichMessageArchivalText(payload), null);
    });

    it("escapes a preformatted inner label instead of nesting a second link", () => {
      const preformatted =
        "[https://example.com/path](https://example.com/path)";
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            {
              type: "paragraph",
              text: [
                {
                  type: "url",
                  text: preformatted,
                  url: preformatted,
                },
              ],
            },
          ],
        }),
        "[\\[https://example.com/path\\](https://example.com/path)](https://example.com/path)",
      );
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            {
              type: "paragraph",
              text: [
                {
                  type: "url",
                  text: "Example",
                  url: "[https://example.com](https://example.com)",
                },
              ],
            },
          ],
        }),
        "[Example](https://example.com)",
      );
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            {
              type: "paragraph",
              text: [
                {
                  type: "url",
                  text: "https://example.com",
                  url: "https://example.com",
                },
              ],
            },
          ],
        }),
        "[https://example.com](https://example.com)",
      );
    });

    it("enforces protocol allowlist on URLs", () => {
      assert.equal(isValidUrlScheme("https://example.com"), true);
      assert.equal(isValidUrlScheme("http://example.com"), true);
      assert.equal(isValidUrlScheme("tg://resolve?domain=test"), true);
      assert.equal(isValidUrlScheme("javascript:alert(1)"), false);
      assert.equal(isValidUrlScheme("data:text/html,hack"), false);
      assert.equal(isValidUrlScheme("file:///etc/passwd"), false);
      assert.equal(isValidUrlScheme("vbscript:msgbox(1)"), false);

      const payload = {
        blocks: [
          {
            type: "paragraph",
            text: [
              { type: "url", text: "Safe Link", url: "https://example.com" },
              " and ",
              {
                type: "url",
                text: "Malicious Link",
                url: "javascript:alert(1)",
              },
            ],
          },
        ],
      };
      assert.equal(
        extractRichMessageSafeModelText(payload),
        "[Safe Link](https://example.com) and Malicious Link",
      );
    });

    it("unwraps preformatted markdown links safely", () => {
      const payload = {
        blocks: [
          {
            type: "paragraph",
            text: [
              {
                type: "url",
                text: "",
                url: "[https://t.me/example](https://t.me/example)",
              },
            ],
          },
        ],
      };
      assert.equal(
        extractRichMessageSafeModelText(payload),
        "[https://t.me/example](https://t.me/example)",
      );
    });

    it("falls back to escaped plain text for ambiguous or disallowed preformatted links", () => {
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            {
              type: "paragraph",
              text: [
                {
                  type: "url",
                  text: "Ambiguous",
                  url: "[a](https://a.example)[b](https://b.example)",
                },
              ],
            },
          ],
        }),
        "Ambiguous",
      );
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            {
              type: "paragraph",
              text: [
                {
                  type: "url",
                  text: "Click",
                  url: "[click](javascript:alert(1))",
                },
              ],
            },
          ],
        }),
        "Click",
      );
    });

    it("prevents stack overflow on deeply nested tokens (1,001 levels)", () => {
      let root: Record<string, unknown> = { type: "bold", text: "deep_leaf" };
      for (let i = 0; i < 1000; i++) {
        root = { type: "italic", text: [root] };
      }
      const payload = {
        blocks: [{ type: "paragraph", text: [root] }],
      };

      assert.doesNotThrow(() => {
        const text = extractRichMessageSafeModelText(payload);
        assert.equal(typeof text, "string");
        assert.equal(text?.includes("deep_leaf"), true);
      });
      assert.equal(MAX_RICH_MESSAGE_NODES, 50_000);
    });

    it("bounds cyclic tokens by MAX_RICH_MESSAGE_NODES and fail-closes", () => {
      const cycle: Record<string, unknown> = { type: "bold", text: [] };
      cycle.text = [cycle];
      const payload = {
        blocks: [{ type: "paragraph", text: [cycle] }],
      };
      assert.doesNotThrow(() => {
        assert.equal(extractRichMessageSafeModelText(payload), null);
        assert.equal(extractRichMessageArchivalText(payload), null);
      });
    });

    it("fail-closes an over-budget URL label without leaking a partial prefix", () => {
      const inner = Array.from(
        { length: MAX_RICH_MESSAGE_NODES + 8 },
        () => "leak[",
      );
      const payload = {
        blocks: [
          {
            type: "paragraph",
            text: [
              {
                type: "url",
                text: inner,
                url: "https://safe.example",
              },
            ],
          },
        ],
      };
      assert.equal(extractRichMessageSafeModelText(payload), null);
      assert.equal(extractRichMessageArchivalText(payload), null);
    });

    it("fail-closes atomically when the node budget is exhausted across non-paragraph blocks", () => {
      const chunkSize = Math.floor(MAX_RICH_MESSAGE_NODES / 2) + 4;
      const chunk = Array.from({ length: chunkSize }, () => "x");
      const payload = {
        blocks: [
          { type: "header", text: chunk },
          { type: "blockquote", text: chunk },
        ],
      };
      assert.strictEqual(extractRichMessageSafeModelText(payload), null);
      assert.strictEqual(extractRichMessageArchivalText(payload), null);
    });

    it("escapes nested rejected-url brackets exactly once inside an outer valid link", () => {
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            {
              type: "paragraph",
              text: [
                {
                  type: "url",
                  url: "https://safe.example",
                  text: [
                    {
                      type: "url",
                      url: "javascript:void(0)",
                      text: "Inner [Text]",
                    },
                  ],
                },
              ],
            },
          ],
        }),
        "[Inner \\[Text\\]](https://safe.example)",
      );
    });

    it("escapes brackets in nested rejected-URL fallback text when node.text is empty", () => {
      const payload = {
        blocks: [
          {
            type: "paragraph",
            text: [
              {
                type: "url",
                url: "https://safe.example",
                text: [
                  {
                    type: "url",
                    url: "[Inner [Fallback]](javascript:void(0))",
                    text: "",
                  },
                ],
              },
            ],
          },
        ],
      };
      assert.equal(
        extractRichMessageSafeModelText(payload),
        "[Inner \\[Fallback\\]](https://safe.example)",
      );
    });

    it("emits a top-level rejected URL label as-is", () => {
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            {
              type: "paragraph",
              text: [
                {
                  type: "url",
                  url: "javascript:void(0)",
                  text: "Top [Text]",
                },
              ],
            },
          ],
        }),
        "Top [Text]",
      );
    });

    it("escapes brackets in top-level rejected-URL fallback text when node.text is empty", () => {
      const payload = {
        blocks: [
          {
            type: "paragraph",
            text: [
              {
                type: "url",
                url: "[Top [Fallback]](javascript:void(0))",
                text: "",
              },
            ],
          },
        ],
      };
      assert.equal(
        extractRichMessageSafeModelText(payload),
        "Top \\[Fallback\\]",
      );
    });

    it("escapes ]( inside a completed allowlisted label so it cannot close the link", () => {
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            {
              type: "paragraph",
              text: [
                {
                  type: "url",
                  text: "x](javascript:alert(1)",
                  url: "https://safe.example",
                },
              ],
            },
          ],
        }),
        "[x\\](javascript:alert(1)](https://safe.example)",
      );
    });

    it("renders nested bold, italic, and inner URLs as inert label text", () => {
      const payload = {
        blocks: [
          {
            type: "paragraph",
            text: [
              {
                type: "url",
                url: "https://outer.example",
                text: [
                  { type: "bold", text: "B" },
                  " ",
                  { type: "italic", text: "I" },
                  " ",
                  {
                    type: "url",
                    text: "inner",
                    url: "https://inner.example",
                  },
                  " ",
                  {
                    type: "url",
                    text: "js",
                    url: "javascript:alert(1)",
                  },
                ],
              },
            ],
          },
        ],
      };
      assert.equal(
        extractRichMessageSafeModelText(payload),
        "[**B** *I* inner js](https://outer.example)",
      );
      assert.equal(
        extractRichMessageArchivalText(payload),
        "[**B** *I* [inner](https://inner.example) [js](javascript:alert(1))](https://outer.example)",
      );
    });

    it("parses an escaped ]( delimiter and rejects vbscript urls", () => {
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            {
              type: "paragraph",
              text: [
                {
                  type: "url",
                  text: "Escaped",
                  url: "[test\\](label)](https://example.com)",
                },
              ],
            },
          ],
        }),
        "[Escaped](https://example.com)",
      );
      assert.equal(
        extractRichMessageSafeModelText({
          blocks: [
            {
              type: "paragraph",
              text: [{ type: "url", text: "Popup", url: "vbscript:msgbox(1)" }],
            },
          ],
        }),
        "Popup",
      );
    });
  });

  describe("extractRichMessageArchivalText", () => {
    it("preserves exact untrimmed raw URL with whitespace and tabs in archive mode", () => {
      const payload = {
        blocks: [
          {
            type: "paragraph",
            text: [
              {
                type: "url",
                url: "  https://example.com/raw \t ",
                text: "Link",
              },
            ],
          },
        ],
      };
      assert.strictEqual(
        extractRichMessageArchivalText(payload),
        "[Link](  https://example.com/raw \t )",
      );
    });

    it("retains markdown for bold, italic, mention, and url tokens", () => {
      const payload = {
        blocks: [
          {
            type: "paragraph",
            text: [
              { type: "bold", text: "bold" },
              " ",
              { type: "italic", text: "italic" },
              " ",
              { type: "mention", text: "@dev", username: "dev" },
              " ",
              { type: "url", text: "label", url: "https://example.com" },
            ],
          },
        ],
      };
      assert.equal(
        extractRichMessageArchivalText(payload),
        "**bold** *italic* @dev [label](https://example.com)",
      );
    });

    it("retains deep_leaf at depth 1,001 in both archive and safe-model", () => {
      let root: Record<string, unknown> = { type: "bold", text: "deep_leaf" };
      for (let i = 0; i < 1000; i++) {
        root = { type: "italic", text: [root] };
      }
      const payload = {
        blocks: [{ type: "paragraph", text: [root] }],
      };
      const safe = extractRichMessageSafeModelText(payload);
      assert.ok(safe);
      assert.equal(safe.includes("deep_leaf"), true);
      const archive = extractRichMessageArchivalText(payload);
      assert.ok(archive);
      assert.equal(archive.includes("deep_leaf"), true);
      assert.equal(archive.includes("**deep_leaf**"), true);
    });

    it("keeps rejected urls as inert [label](url) text", () => {
      const payload = {
        blocks: [
          {
            type: "paragraph",
            text: [
              { type: "url", text: "Safe Link", url: "https://example.com" },
              " and ",
              {
                type: "url",
                text: "Malicious Link",
                url: "javascript:alert(1)",
              },
            ],
          },
        ],
      };
      assert.equal(
        extractRichMessageSafeModelText(payload),
        "[Safe Link](https://example.com) and Malicious Link",
      );
      assert.equal(
        extractRichMessageArchivalText(payload),
        "[Safe Link](https://example.com) and [Malicious Link](javascript:alert(1))",
      );
      assert.equal(
        extractRichMessageSafeModelText(payload),
        "[Safe Link](https://example.com) and Malicious Link",
      );
    });

    it("keeps a nested allowlisted label when the outer url is disallowed", () => {
      const payload = {
        blocks: [
          {
            type: "paragraph",
            text: [
              {
                type: "url",
                text: "[Nested](https://safe.example)",
                url: "javascript:alert(1)",
              },
            ],
          },
        ],
      };
      assert.equal(
        extractRichMessageArchivalText(payload),
        "[[Nested](https://safe.example)](javascript:alert(1))",
      );
      const safe = extractRichMessageSafeModelText(payload);
      assert.equal(safe, "[Nested](https://safe.example)");
      assert.equal(safe?.includes("javascript:"), false);
    });

    it("falls back to a non-empty plain label when a rejected url has empty text", () => {
      const payload = {
        blocks: [
          {
            type: "paragraph",
            text: [{ type: "url", text: "", url: "javascript:alert(1)" }],
          },
        ],
      };
      assert.equal(
        extractRichMessageArchivalText(payload),
        "[](javascript:alert(1))",
      );
      const safe = extractRichMessageSafeModelText(payload);
      assert.equal(safe, "javascript:alert(1)");
      assert.equal(safe?.includes("]("), false);
      assert.equal(safe?.startsWith("["), false);
    });
  });

  describe("extractRichMessagePhotos", () => {
    it("extracts ordered photo blocks picking the largest size", () => {
      const payload = {
        blocks: [
          {
            type: "photo",
            photo: [
              { file_id: "small_id", width: 100, height: 100, file_size: 1000 },
              {
                file_id: "large_id",
                width: 1200,
                height: 800,
                file_size: 50000,
              },
              {
                file_id: "medium_id",
                width: 600,
                height: 400,
                file_size: 20000,
              },
            ],
          },
          { type: "paragraph", text: "Middle text" },
          {
            type: "photo",
            photo: [
              {
                file_id: "photo2_id",
                file_unique_id: "uniq_2",
                width: 500,
                height: 500,
              },
            ],
          },
        ],
      };

      const photos = extractRichMessagePhotos(payload);
      assert.equal(photos.length, 2);
      assert.deepEqual(photos[0], {
        fileId: "large_id",
        fileUniqueId: undefined,
        tag: "photo",
        transcribe: false,
      });
      assert.deepEqual(photos[1], {
        fileId: "photo2_id",
        fileUniqueId: "uniq_2",
        tag: "photo",
        transcribe: false,
      });
    });

    it("ignores malformed photo blocks gracefully", () => {
      const payload = {
        blocks: [
          { type: "photo", photo: [] },
          { type: "photo", photo: [{ invalid: true }] },
          {
            type: "photo",
            photo: [{ file_id: "valid_id", width: 200, height: 200 }],
          },
        ],
      };
      const photos = extractRichMessagePhotos(payload);
      assert.equal(photos.length, 1);
      assert.equal(photos[0].fileId, "valid_id");
    });

    it("falls back to file_size when dimensions are missing", () => {
      const photos = extractRichMessagePhotos({
        blocks: [
          {
            type: "photo",
            photo: [
              { file_id: "tiny", file_size: 10 },
              { file_id: "fat", file_size: 9999 },
              { file_id: "  ", file_size: 1_000_000 },
            ],
          },
        ],
      });
      assert.equal(photos.length, 1);
      assert.equal(photos[0].fileId, "fat");
    });

    it("ranks a finite-dimension size above a dimensionless larger file", () => {
      const photos = extractRichMessagePhotos({
        blocks: [
          {
            type: "photo",
            photo: [
              {
                file_id: "huge_file",
                width: undefined,
                height: undefined,
                file_size: 999999,
              },
              {
                file_id: "small_frame",
                width: 10,
                height: 10,
                file_size: 100,
              },
            ],
          },
        ],
      });
      assert.equal(photos.length, 1);
      assert.equal(photos[0].fileId, "small_frame");
    });

    it("keeps the first size on a tied area score", () => {
      const photos = extractRichMessagePhotos({
        blocks: [
          {
            type: "photo",
            photo: [
              { file_id: "first", width: 10, height: 10 },
              { file_id: "second", width: 10, height: 10 },
            ],
          },
        ],
      });
      assert.equal(photos[0].fileId, "first");
    });

    it("breaks an equal-area tie with the larger file_size", () => {
      const photos = extractRichMessagePhotos({
        blocks: [
          {
            type: "photo",
            photo: [
              {
                file_id: "thin",
                width: 800,
                height: 600,
                file_size: 10_000,
              },
              {
                file_id: "fat",
                width: 800,
                height: 600,
                file_size: 80_000,
              },
            ],
          },
        ],
      });
      assert.equal(photos.length, 1);
      assert.equal(photos[0].fileId, "fat");
    });

    it("ignores NaN and negative dimensions and file_size when ranking", () => {
      const photos = extractRichMessagePhotos({
        blocks: [
          {
            type: "photo",
            photo: [
              {
                file_id: "nan",
                width: Number.NaN,
                height: 100,
                file_size: 99_999,
              },
              {
                file_id: "neg",
                width: -10,
                height: 10,
                file_size: 99_998,
              },
              {
                file_id: "ok",
                width: 8,
                height: 8,
                file_size: 10,
              },
            ],
          },
        ],
      });
      assert.equal(photos.length, 1);
      assert.equal(photos[0].fileId, "ok");
    });

    it("returns an empty array for junk photo payloads", () => {
      assert.deepEqual(extractRichMessagePhotos(null), []);
      assert.deepEqual(extractRichMessagePhotos({ blocks: "nope" }), []);
      assert.deepEqual(
        extractRichMessagePhotos({
          blocks: [{ type: "photo", photo: { file_id: "obj" } }],
        }),
        [],
      );
    });
  });

  describe("Property-based fuzzing (fast-check)", () => {
    it(`never throws on arbitrary JSON objects (seed=${PROPERTY_SEED})`, () => {
      fc.assert(
        fc.property(fc.anything(), (randomValue) => {
          assert.doesNotThrow(() => {
            extractRichMessagePhotos(randomValue);
            extractRichMessageArchivalText(randomValue);
            extractRichMessageSafeModelText(randomValue);
          });
          const text = extractRichMessageSafeModelText(randomValue);
          assert.ok(text === null || typeof text === "string");
          const archive = extractRichMessageArchivalText(randomValue);
          assert.ok(archive === null || typeof archive === "string");
          const safeModel = extractRichMessageSafeModelText(randomValue);
          assert.ok(safeModel === null || typeof safeModel === "string");
          const photos: readonly TelegramRawMedia[] =
            extractRichMessagePhotos(randomValue);
          for (const photo of photos) {
            assert.equal(typeof photo.fileId, "string");
            assert.ok(photo.fileId.trim().length > 0);
            assert.equal(photo.tag, "photo");
            assert.equal(photo.transcribe, false);
          }
        }),
        { seed: PROPERTY_SEED, numRuns: 200 },
      );
    });

    it(`reconstructs paragraph strings by joining with blank lines (seed=${PROPERTY_SEED})`, () => {
      fc.assert(
        fc.property(
          fc.array(fc.string(), { minLength: 1, maxLength: 8 }),
          (lines) => {
            const payload = {
              blocks: lines.map((text) => ({ type: "paragraph", text })),
            };
            const result = extractRichMessageSafeModelText(payload);
            const expected = lines.join("\n\n");
            if (expected.trim().length === 0) {
              assert.equal(result, null);
            } else {
              assert.equal(result, expected);
            }
          },
        ),
        { seed: PROPERTY_SEED, numRuns: 100 },
      );
    });

    it(`picks the largest area photo and preserves order of blocks (seed=${PROPERTY_SEED})`, () => {
      const sizeArb = fc.record({
        file_id: fc
          .string({ minLength: 1, maxLength: 12 })
          .filter((value) => value.trim().length > 0),
        width: fc.integer({ min: 1, max: 2000 }),
        height: fc.integer({ min: 1, max: 2000 }),
      });
      fc.assert(
        fc.property(
          fc.array(sizeArb, { minLength: 1, maxLength: 5 }),
          (sizes) => {
            const photos: readonly TelegramRawMedia[] =
              extractRichMessagePhotos({
                blocks: [
                  { type: "paragraph", text: "ignore" },
                  { type: "photo", photo: sizes },
                  {
                    type: "photo",
                    photo: [{ file_id: "tail", width: 1, height: 1 }],
                  },
                ],
              });
            assert.equal(photos.length, 2);
            let best = sizes[0];
            for (const size of sizes) {
              if (size.width * size.height > best.width * best.height) {
                best = size;
              }
            }
            assert.equal(photos[0]?.fileId, best.file_id);
            assert.equal(photos[1]?.fileId, "tail");
          },
        ),
        { seed: PROPERTY_SEED, numRuns: 80 },
      );
    });
  });
});

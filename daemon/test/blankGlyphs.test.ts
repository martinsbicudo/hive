import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { z } from "zod";
import { ghDisplay, mailSendDisplay } from "../src/outwardDisplay.ts";
import { classifyGh } from "../src/githubPolicy.ts";
import { mailSendInput } from "../src/macInput.ts";
import { visibleBodyEscapes, visibleEscapes } from "../src/trust.ts";

const hex = z.string().regex(/^[0-9A-F]{4,5}$/);
// notch/Tests/HiveNotchTests/BlankGlyphTests.swift reads the same file, so both sides escape the same blanks.
const GLYPHS = z
  .object({ escapedEverywhere: z.array(hex), escapedOnLinesOnly: z.array(hex), neverEscaped: z.array(hex) })
  .strict()
  .parse(JSON.parse(readFileSync(new URL("./blankGlyphs.json", import.meta.url), "utf8")));

function sample(code: string): { text: string; escaped: string } {
  return { text: `a${String.fromCodePoint(Number.parseInt(code, 16))}b`, escaped: `a[U+${code}]b` };
}

describe("blank glyphs on cards", () => {
  it("escapes the shared list on one-line fields and in bodies, except U+3000 in a body", () => {
    for (const code of GLYPHS.escapedEverywhere) {
      const { text, escaped } = sample(code);
      assert.equal(visibleEscapes(text), escaped, `line ${code}`);
      assert.equal(visibleBodyEscapes(text), escaped, `body ${code}`);
    }
    for (const code of GLYPHS.escapedOnLinesOnly) {
      const { text, escaped } = sample(code);
      assert.equal(visibleEscapes(text), escaped, `line ${code}`);
      assert.equal(visibleBodyEscapes(text), text, `body ${code}`);
    }
    for (const code of GLYPHS.neverEscaped) {
      const { text } = sample(code);
      assert.equal(visibleEscapes(text), text, `line ${code}`);
      assert.equal(visibleBodyEscapes(text), text, `body ${code}`);
    }
  });

  it("lists every space separator but the plain space", () => {
    const listed = new Set([...GLYPHS.escapedEverywhere, ...GLYPHS.escapedOnLinesOnly].map((code) => Number.parseInt(code, 16)));
    const missing: number[] = [];
    for (let point = 0; point <= 0x10ffff; point += 1) {
      if (point !== 0x20 && /\p{Zs}/u.test(String.fromCodePoint(point)) && !listed.has(point)) missing.push(point);
    }
    assert.deepEqual(missing, []);
  });

  it("applies the line rule to subjects and gh values and the body rule to bodies", () => {
    const mail = mailSendDisplay(mailSendInput.parse({ to: ["me@example.com"], subject: "Hi\u{3000}there\u{a0}", body: "Dear\u{3000}team\u{2800}" }));
    assert.deepEqual(mail.fields, [{ label: "Subject", value: "Hi[U+3000]there[U+00A0]" }]);
    assert.equal(mail.body, "Dear\u{3000}team[U+2800]");
    const gh = ghDisplay(classifyGh(["pr", "create", "-R", "o/r", "-t", "Fix\u{2007}it", "-b", "Body\u{3000}ok\u{1d159}"]));
    assert.deepEqual(gh.flags, [{ label: "--title", value: "Fix[U+2007]it" }]);
    assert.equal(gh.body?.text, "Body\u{3000}ok[U+1D159]");
  });
});

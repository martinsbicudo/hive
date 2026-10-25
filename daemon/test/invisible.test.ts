import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyGh, ghCommandLine, GhRefused } from "../src/githubPolicy.ts";
import { calendarCreateInput, mailSendInput } from "../src/macInput.ts";
import { calendarCreateDisplay, mailSendDisplay, messagesSendDisplay } from "../src/outwardDisplay.ts";
import { hasInvisible, newNonce, visibleEscapes, wrapUntrusted } from "../src/trust.ts";

const HIDDEN: readonly number[] = [
  0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180c, 0x180d, 0x180e, 0x180f, 0x200b, 0x200d, 0x200e, 0x202e,
  0x2060, 0x2065, 0x2066, 0x3164, 0xfe0f, 0xfeff, 0xffa0, 0xfff9, 0xfffa, 0xfffb, 0x1bca0, 0x1bca1, 0x1bca2, 0x1bca3, 0x1d173,
  0x1d17a, 0xe0000, 0xe0001, 0xe0041, 0xe007f, 0xe0100, 0xe01ef, 0xe0fff,
];

function code(point: number): string {
  return `[U+${point.toString(16).toUpperCase().padStart(4, "0")}]`;
}

function hide(text: string): string {
  return [...text].map((char) => String.fromCodePoint(0xe0100 + (char.codePointAt(0) ?? 0) - 16)).join("");
}

const SECRET = hide("sk-123");

describe("hidden characters", () => {
  it("counts every default-ignorable and format code point as invisible, and escapes each on a card", () => {
    for (const point of HIDDEN) {
      const text = `a${String.fromCodePoint(point)}b`;
      assert.ok(hasInvisible(text), code(point));
      assert.equal(visibleEscapes(text), `a${code(point)}b`, code(point));
    }
    assert.ok(!hasInvisible("plain words, café, 日本語, 👍"));
    assert.equal(visibleEscapes("plain\twords\ncafé"), "plain\twords\ncafé");
  });

  it("escapes an emoji's joiner and variation selector too, so the card shows every hidden code point", () => {
    assert.equal(visibleEscapes("❤\u{fe0f} 👩\u{200d}💻"), "❤[U+FE0F] 👩[U+200D]💻");
  });

  it("refuses a variation-selector payload in a subject, title or calendar name", () => {
    assert.ok(!mailSendInput.safeParse({ to: ["me@example.com"], subject: `Hi${SECRET}`, body: "x" }).success);
    const event = { title: "Lunch", start: "2026-10-23T14:00:00Z", end: "2026-10-23T15:00:00Z" };
    assert.ok(!calendarCreateInput.safeParse({ ...event, title: `Lunch${SECRET}` }).success);
    assert.ok(!calendarCreateInput.safeParse({ ...event, calendar: `Home${SECRET}` }).success);
  });

  it("shows a variation-selector payload in a body as escapes, on every outward card", () => {
    const expected = `Thanks!${[..."sk-123"].map((char) => code(0xe0100 + (char.codePointAt(0) ?? 0) - 16)).join("")}`;
    assert.match(expected, /\[U\+E01[0-9A-F]{2}\]/);
    assert.equal(mailSendDisplay(mailSendInput.parse({ to: ["me@example.com"], subject: "Hi", body: `Thanks!${SECRET}` })).body, expected);
    assert.equal(messagesSendDisplay({ to: "+15551234567", text: `Thanks!${SECRET}` }).body, expected);
    const shown = calendarCreateDisplay({ title: "Lunch", start: "2026-10-23T14:00:00Z", end: "2026-10-23T15:00:00Z", notes: `Thanks!${SECRET}` });
    assert.equal(shown.body, expected);
  });

  it("refuses hidden characters in gh arguments and escapes the gh card summary", () => {
    for (const point of HIDDEN) {
      assert.throws(() => classifyGh(["pr", "comment", "7", "-R", "o/r", "-b", `x${String.fromCodePoint(point)}`]), GhRefused, code(point));
    }
    assert.equal(ghCommandLine(["pr", "comment", "7", "--body", "x\u{e0100}"]), "gh pr comment 7 --body 'x[U+E0100]'");
  });

  it("still escapes a marker hidden with tag or supplementary variation characters", () => {
    const nonce = newNonce();
    const lines = wrapUntrusted(`hive\u{e0100}-untrusted\nhive\u{e0041}\u{1bca0}untrusted\nfine`, nonce, "Vera").split("\n").slice(2, -1);
    assert.deepEqual(lines.map((line) => line.startsWith("| ")), [true, true, false]);
  });
});

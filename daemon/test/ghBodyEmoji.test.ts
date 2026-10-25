import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyGh, GhRefused } from "../src/githubPolicy.ts";
import { hasInvisibleOutsideEmoji } from "../src/trust.ts";

const FAMILY = "👨\u{200d}👩\u{200d}👧\u{200d}👦";
const HEART = "❤\u{fe0f}";
const KEYCAP = "1\u{fe0f}⃣";
const ENGLAND = "🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}";
const COMMENT = ["pr", "comment", "7", "-R", "o/r"];

function spellings(body: string): string[][] {
  return [[...COMMENT, "--body", body], [...COMMENT, `--body=${body}`], [...COMMENT, "-b", body]];
}

function refused(args: readonly string[], pattern: RegExp = /./): void {
  assert.throws(() => classifyGh(args), (error: unknown) => error instanceof GhRefused && pattern.test(error.message), `expected a refusal for ${JSON.stringify(args)}`);
}

describe("emoji in gh bodies", () => {
  it("runs on a runtime whose v-flag regexes know RGI emoji sequences", () => {
    const rgi = /^\p{RGI_Emoji}$/v;
    for (const emoji of [FAMILY, HEART, KEYCAP, ENGLAND, "👍🏽", "🇧🇷"]) assert.ok(rgi.test(emoji), [...emoji].map((char) => char.codePointAt(0)?.toString(16)).join(" "));
    for (const text of ["👍\u{200d}👍", "x\u{fe0f}", "\u{200d}", "👨\u{200d}"]) assert.ok(!rgi.test(text), text);
  });

  it("accepts a whole RGI family, heart and keycap in every body spelling", () => {
    for (const args of spellings(`Thanks ${FAMILY} ${HEART} ${KEYCAP}\nsecond line`)) {
      assert.equal(classifyGh(args).argv.at(-1), `Thanks ${FAMILY} ${HEART} ${KEYCAP}\nsecond line`, args.join(" "));
    }
    assert.equal(classifyGh(["issue", "create", "-R", "o/r", "-t", "t", "--body", FAMILY]).kind, "ask");
  });

  it("refuses a lone ZWJ, a ZWJ outside RGI, a stray VS16, a tag sequence, a CR, a lone surrogate and a 2001-character body", () => {
    const bad: [string, RegExp][] = [
      ["a\u{200d}b", /standard emoji/],
      ["👍\u{200d}👍", /standard emoji/],
      [`${FAMILY}\u{200d}`, /standard emoji/],
      ["x\u{fe0f}", /standard emoji/],
      [ENGLAND, /tag characters/],
      ["flag 🏴\u{e0041}\u{e007f}", /tag characters/],
      ["a\rb", /carriage returns/],
      ["a\ud83db", /lone surrogate/],
      ["x".repeat(2001), /2000/],
    ];
    for (const [body, pattern] of bad) for (const args of spellings(body)) refused(args, pattern);
  });

  it("keeps the full refusal for every non-body value, flag name and positional", () => {
    refused(["pr", "create", "-R", "o/r", "--title", `Fix ${FAMILY}`], /invisible/);
    refused(["pr", "create", "-R", "o/r", `--title=${HEART}`], /invisible/);
    refused(["pr", "close", "7", "-R", "o/r", "--comment", FAMILY], /invisible/);
    refused(["pr", "list", "-R", "o/r", "--label", HEART], /invisible/);
    refused([...COMMENT, `--bo\u{200d}dy`, "x"], /invisible/);
    refused([...COMMENT, `--body\u{200d}=x`], /invisible/);
    refused(["search", "prs", FAMILY], /invisible/);
    refused(["pr", `comment\u{200d}`, "7"], /invisible/);
    refused([`pr${HEART}`, "list"], /invisible/);
    refused(["pr", "list", "-R", "o/r", "--search", "a\ud800"], /lone surrogate/);
  });

  it("strips joiners only inside a match, so hidden characters elsewhere still count", () => {
    assert.ok(!hasInvisibleOutsideEmoji(`${FAMILY}${HEART}`));
    assert.ok(hasInvisibleOutsideEmoji(`${FAMILY}\u{200b}`));
    assert.ok(hasInvisibleOutsideEmoji(`${HEART}\u{e0100}`));
    assert.ok(hasInvisibleOutsideEmoji(ENGLAND));
  });
});

describe("gh owners and repos", () => {
  it("takes owners GitHub allows and refuses the rest, alone and inside paths", () => {
    for (const owner of ["o", "octo-cat", "a1-b2-c3", "a".repeat(39)]) {
      assert.equal(classifyGh(["pr", "list", "-R", `${owner}/r`]).kind, "read", owner);
      assert.equal(classifyGh(["pr", "view", `https://github.com/${owner}/r/pull/1`]).kind, "read", owner);
      assert.equal(classifyGh(["issue", "close", "3", "-R", "o/r", "--duplicate-of", `https://github.com/${owner}/r/issues/7`]).kind, "ask", owner);
      assert.equal(classifyGh(["pr", "create", "-R", "o/r", "-t", "t", "-H", `${owner}:feature`]).kind, "ask", owner);
    }
    for (const owner of ["-o", "o-", "a--b", "a".repeat(40), "a_b", "a.b"]) {
      refused(["pr", "list", "-R", `${owner}/r`], /owner\/name/);
      refused(["pr", "view", `https://github.com/${owner}/r/pull/1`], /github\.com/);
      refused(["issue", "close", "3", "-R", "o/r", "--duplicate-of", `https://github.com/${owner}/r/issues/7`], /issue number/);
      refused(["pr", "create", "-R", "o/r", "-t", "t", "-H", `${owner}:feature`], /owner:branch/);
    }
  });

  it("refuses the repo names . and ..", () => {
    for (const name of [".", ".."]) {
      refused(["pr", "list", "-R", `o/${name}`], /owner\/name/);
      refused(["repo", "view", `o/${name}`], /owner\/name/);
      refused(["pr", "view", `https://github.com/o/${name}/pull/1`], /github\.com/);
      refused(["issue", "close", "3", "-R", "o/r", "--duplicate-of", `https://github.com/o/${name}/issues/7`], /issue number/);
    }
    for (const name of [".github", "a.b", "..x", "r"]) assert.equal(classifyGh(["pr", "list", "-R", `o/${name}`]).kind, "read", name);
  });
});

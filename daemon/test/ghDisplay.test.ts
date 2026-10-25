import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { classifyGh, GH_MAX_ARG_LENGTH } from "../src/githubPolicy.ts";
import { HttpError } from "../src/httpError.ts";
import { checkedDisplay, ghDisplay, GH_SHOWN_MAX, storedDisplay } from "../src/outwardDisplay.ts";
import { visibleBodyEscapes, visibleEscapes } from "../src/trust.ts";
import type { GhDisplay } from "../src/types.ts";
import { hubEvent } from "../../web/src/schemasState.ts";
import { removeTempDirs } from "./fixtures.ts";
import { ghHarness } from "./githubFixtures.ts";

after(removeTempDirs);

const FAMILY = "👨\u{200d}👩\u{200d}👧\u{200d}👦";
const NBSP = "\u{a0}";

function refusedAt400(run: () => unknown): void {
  assert.throws(run, (error: unknown) => error instanceof HttpError && error.status === 400 && /doesn't fit on an approval card/.test(error.message));
}

function familyBody(room: number = GH_MAX_ARG_LENGTH): string {
  return FAMILY.repeat(Math.floor(room / FAMILY.length));
}

describe("structured gh card", () => {
  it("lays out the command, labelled targets, one row per flag in order, then the body with counts", () => {
    const call = classifyGh(["pr", "create", "-b", "it's\nfine 'quoted'", "-R", "o/r", "-t", "Fix it", "-l", "bug", "--label=ui", "-d", "-H", "me:feature"]);
    assert.deepEqual(ghDisplay(call), {
      kind: "gh",
      command: "gh pr create",
      targets: [{ label: "Repository", value: "o/r" }],
      flags: [
        { label: "--title", value: "Fix it" }, { label: "--label", value: "bug" }, { label: "--label", value: "ui" }, { label: "--draft", value: null },
        { label: "--head", value: "me:feature" },
      ],
      body: { label: "--body", text: "it's\nfine 'quoted'", lines: 2, chars: 18 },
    });
    const edit = ghDisplay(classifyGh(["issue", "edit", "3", "4", "-R", "o/r", "--add-label", "x"]));
    assert.deepEqual(edit.targets, [{ label: "Repository", value: "o/r" }, { label: "Issue", value: "3" }, { label: "Issue", value: "4" }]);
    assert.equal(edit.body, null);
    assert.deepEqual(ghDisplay(classifyGh(["run", "rerun", "5", "-R", "o/r", "--failed"])).targets.map((entry) => entry.label), ["Repository", "Run"]);
    assert.deepEqual(ghDisplay(classifyGh(["pr", "merge", "https://github.com/o/r/pull/9", "--squash"])).targets, [{ label: "Pull request", value: "https://github.com/o/r/pull/9" }]);
  });

  it("keeps allowed emoji joiners visible as escapes and counts code points, not UTF-16 units", () => {
    const shown = ghDisplay(classifyGh(["pr", "comment", "7", "-R", "o/r", "--body", `hi ${FAMILY}`]));
    assert.deepEqual(shown.body, { label: "--body", text: "hi 👨[U+200D]👩[U+200D]👧[U+200D]👦", lines: 1, chars: 10 });
  });

  it("sizes its limits for the worst case: 40 values of 2000 blanks and a body of RGI ZWJ sequences survive storage unchanged", () => {
    const value = visibleEscapes(NBSP.repeat(GH_MAX_ARG_LENGTH));
    assert.equal(value.length, GH_MAX_ARG_LENGTH * 8);
    const body = familyBody();
    const worst: GhDisplay = {
      kind: "gh",
      command: "gh issue create",
      targets: Array.from({ length: 40 }, () => ({ label: "Repository", value })),
      flags: Array.from({ length: 40 }, () => ({ label: "--label", value })),
      body: { label: "--body", text: visibleBodyEscapes(body), lines: 1, chars: [...body].length },
    };
    assert.deepEqual(storedDisplay(JSON.stringify(checkedDisplay(worst))), worst);
    assert.ok(GH_SHOWN_MAX >= "[U+1D159]".length * GH_MAX_ARG_LENGTH);
  });

  it("fits the largest call the classifier lets through", () => {
    const labels = Array.from({ length: 36 }, () => `--label=${NBSP.repeat(GH_MAX_ARG_LENGTH - "--label=".length)}`);
    const call = classifyGh(["issue", "create", "--repo=o/r", `--body=${familyBody(GH_MAX_ARG_LENGTH - "--body=".length)}`, ...labels]);
    const shown = checkedDisplay(ghDisplay(call));
    assert.equal(shown.flags.length, 36);
    assert.deepEqual(storedDisplay(JSON.stringify(shown)), shown);
  });

  it("refuses a display that doesn't fit when it is created, instead of falling back to the summary", () => {
    const fits: GhDisplay = { kind: "gh", command: "gh pr comment", targets: [], flags: [], body: null };
    assert.deepEqual(checkedDisplay(fits), fits);
    refusedAt400(() => checkedDisplay({ ...fits, flags: Array.from({ length: 41 }, () => ({ label: "--label", value: "x" })) }));
    refusedAt400(() => checkedDisplay({ ...fits, targets: [{ label: "Repository", value: "x".repeat(GH_SHOWN_MAX + 1) }] }));
    refusedAt400(() => checkedDisplay({ ...fits, body: { label: "--body", text: "x", lines: 0, chars: 1 } }));
    assert.equal(storedDisplay(JSON.stringify({ ...fits, flags: Array.from({ length: 41 }, () => ({ label: "--label", value: "x" })) })), null);
  });

  it("still decodes a stored mail display, and refuses one mixed with the gh shape", () => {
    const mail = { action: "Send an email", to: ["a@example.com"], fields: [{ label: "Subject", value: "Hi" }], body: "Hello" };
    assert.deepEqual(storedDisplay(JSON.stringify(mail)), mail);
    assert.equal(storedDisplay(JSON.stringify({ ...mail, kind: "gh" })), null);
    assert.equal(storedDisplay(JSON.stringify({ kind: "mail", command: "x", targets: [], flags: [], body: null })), null);
  });

  it("puts the gh display on the approval, stores it, and the web schema parses the hub state that carries it", async () => {
    const h = await ghHarness();
    try {
      const { token } = h.tokenFor(h.reviewer().id);
      const asked = await h.ask(token, ["pr", "comment", "7", "-R", "o/r", "-b", `Looks good ${FAMILY}`]);
      assert.equal(asked.reply.status, 200);
      const card = h.hub.state().approvals.find((approval) => approval.id === asked.approvalId);
      assert.deepEqual(card?.display, {
        kind: "gh", command: "gh pr comment", targets: [{ label: "Repository", value: "o/r" }, { label: "Pull request", value: "7" }], flags: [],
        body: { label: "--body", text: "Looks good 👨[U+200D]👩[U+200D]👧[U+200D]👦", lines: 1, chars: 18 },
      });
      assert.equal(card?.summary, `gh pr comment 7 --repo o/r --body 'Looks good 👨[U+200D]👩[U+200D]👧[U+200D]👦'`);
      assert.deepEqual(h.store.getApproval(asked.approvalId)?.display, card?.display);
      const parsed = hubEvent.parse({ type: "state", state: JSON.parse(JSON.stringify(h.hub.state())) });
      assert.equal(parsed.type, "state");
      const shown = parsed.type === "state" ? parsed.state.approvals[0]?.display : null;
      assert.deepEqual(shown, card?.display);
    } finally {
      await h.close();
    }
  });
});

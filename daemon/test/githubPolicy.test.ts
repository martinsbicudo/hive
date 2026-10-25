import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyGh, ghCommandLine, GhRefused } from "../src/githubPolicy.ts";

function refused(args: readonly string[], pattern: RegExp = /./): void {
  assert.throws(() => classifyGh(args), (error: unknown) => error instanceof GhRefused && pattern.test(error.message), `expected a refusal for ${JSON.stringify(args)}`);
}

function kindAndArgv(args: readonly string[]): { kind: string; argv: readonly string[] } {
  const { kind, argv } = classifyGh(args);
  return { kind, argv };
}

describe("gh classifier", () => {
  it("tells reads from writes", () => {
    assert.deepEqual(kindAndArgv(["pr", "list", "--repo", "o/r"]), { kind: "read", argv: ["pr", "list", "--repo", "o/r"] });
    assert.deepEqual(kindAndArgv(["pr", "comment", "12", "--repo", "o/r", "--body", "LGTM"]), {
      kind: "ask",
      argv: ["pr", "comment", "12", "--repo", "o/r", "--body", "LGTM"],
    });
    for (const args of [
      ["pr", "view", "https://github.com/o/r/pull/1"], ["pr", "diff", "3", "-R", "o/r"], ["pr", "checks", "3", "-R", "o/r"],
      ["pr", "status", "-R", "o/r"], ["issue", "list", "-R", "o/r"], ["issue", "view", "4", "-R", "o/r"], ["repo", "view", "cli/cli"],
      ["run", "list", "-R", "o/r"], ["run", "view", "99", "-R", "o/r"], ["search", "prs", "is:open author:me"], ["search", "issues", "bug"],
      ["search", "repos", "--owner", "cli"], ["api", "repos/o/r"],
    ]) assert.equal(classifyGh(args).kind, "read", args.join(" "));
    for (const args of [
      ["pr", "review", "1", "-R", "o/r", "--approve"], ["pr", "create", "-R", "o/r", "--title", "t", "--body", "b", "--head", "f"],
      ["pr", "edit", "1", "-R", "o/r", "--add-label", "bug"], ["pr", "close", "1", "-R", "o/r"], ["pr", "reopen", "1", "-R", "o/r"],
      ["pr", "merge", "1", "-R", "o/r", "--squash"], ["issue", "comment", "1", "-R", "o/r", "-b", "hi"], ["issue", "create", "-R", "o/r", "-t", "t", "-b", "b"],
      ["issue", "edit", "1", "2", "-R", "o/r", "--add-label", "x"], ["issue", "close", "1", "-R", "o/r"], ["issue", "reopen", "1", "-R", "o/r"],
      ["run", "rerun", "5", "-R", "o/r", "--failed"], ["run", "cancel", "5", "-R", "o/r"],
    ]) assert.equal(classifyGh(args).kind, "ask", args.join(" "));
  });

  it("allows api GET on a REST path and nothing else", () => {
    assert.deepEqual(classifyGh(["api", "repos/o/r", "-q", ".name", "--paginate"]).argv, ["api", "repos/o/r", "--jq", ".name", "--paginate"]);
    refused(["api", "-f", "x=y", "repos/o/r"], /doesn't take -f/);
    refused(["api", "graphql"], /graphql/);
    refused(["api", "/graphql?x=1"], /graphql/);
    refused(["api", "https://x/y"], /URL/);
    refused(["api", "//evil.com/x"], /URL/);
    refused(["api", "repos/o/r", "--method", "POST"], /doesn't take --method/);
    refused(["api", "repos/o/r", "--input", "file"], /doesn't take --input/);
    refused(["api", "repos/o/r", "-F", "body=@/etc/passwd"], /doesn't take -F/);
    refused(["api", "repos/o/r", "-H", "Host: evil"], /doesn't take -H/);
    refused(["api", "repos/o/r", "--hostname", "evil.com"], /--hostname/);
    refused(["api"], /positional/);
  });

  it("keeps every target on github.com", () => {
    refused(["pr", "list", "-R", "evil.com/o/r"], /owner\/name/);
    refused(["pr", "list", "--repo=evil.com/o/r"], /owner\/name/);
    refused(["pr", "view", "https://evil.com/o/r/pull/1"], /github\.com/);
    refused(["pr", "view", "https://github.com.evil.com/o/r/pull/1"], /github\.com/);
    refused(["repo", "view", "evil.com/o/r"], /owner\/name/);
    refused(["issue", "view", "https://github.com@evil.com/o/r/issues/1"], /github\.com/);
    refused(["search", "prs", "x", "--repo", "evil.com/o/r"], /owner\/name/);
  });

  it("refuses github.com URLs whose path could step outside owner/name", () => {
    for (const url of ["https://github.com/o/r/../../evil/x", "https://github.com/o/r/pull/1/../../x", "https://github.com/o/r/%2e%2e/x", "https://github.com/o/r/%2E./x", "https://github.com/o/r/pull%2F1", "https://github.com/o/r/./pull/1", "https://github.com/o/r//pull/1", "https://github.com/o/r/pull/1\\..", "https://github.com/o/r/pull/1%5c"]) {
      refused(["pr", "view", url], /github\.com\/owner\/name/);
    }
    for (const url of ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/1/", "https://github.com/o/r/pull/1#issuecomment-2", "https://github.com/o/r.js/pull/1"]) {
      assert.equal(classifyGh(["pr", "view", url]).kind, "read", url);
    }
    refused(["issue", "close", "1", "-R", "o/r", "--duplicate-of", "https://github.com/o/r/%2e%2e/issues/7"], /issue number/);
  });

  it("needs a repository for repo-scoped calls, since there's no local checkout", () => {
    refused(["pr", "list"], /needs --repo/);
    refused(["pr", "view", "12"], /needs --repo/);
    refused(["issue", "create", "--title", "t"], /needs --repo/);
    refused(["repo", "view"], /positional/);
    assert.equal(classifyGh(["issue", "view", "https://github.com/o/r/issues/2"]).kind, "read");
  });

  it("refuses clusters, --, leading flags, unknown commands and flags, and --web", () => {
    refused(["api", "-XPOST", "repos/o/r"], /clusters/);
    refused(["pr", "list", "-Ro/r"], /clusters/);
    refused(["pr", "list", "-R", "o/r", "-dL", "5"], /clusters/);
    refused(["pr", "list", "-R", "o/r", "--"], /`--`/);
    refused(["pr", "comment", "1", "-R", "o/r", "--body", "--"], /`--`/);
    refused(["-R", "o/r", "pr", "list"], /first argument/);
    refused(["pr", "zz"], /isn't one of the commands/);
    refused(["pr", "ls", "-R", "o/r"], /isn't one of the commands/);
    refused(["co", "1"], /isn't one of the commands/);
    refused(["my-extension"], /needs a subcommand/);
    refused(["pr", "list", "-R", "o/r", "--web"], /--web/);
    refused(["pr", "view", "1", "-R", "o/r", "-w"], /--web/);
    refused(["pr", "list", "-R", "o/r", "--bogus"], /doesn't take --bogus/);
    refused(["pr", "list", "-R", "o/r", "--help"], /doesn't take --help/);
    refused(["run", "view", "1", "-R", "o/r", "--log"], /doesn't take --log/);
    refused(["run", "view", "1", "-R", "o/r", "--log-failed"], /doesn't take --log-failed/);
  });

  it("refuses the dangerous groups and the local-tree writers", () => {
    for (const group of ["auth", "config", "extension", "alias", "secret", "variable", "ssh-key", "gpg-key", "codespace", "gist", "release", "attestation"]) {
      refused([group, "list"], /isn't allowed/);
    }
    for (const name of ["pr checkout", "repo clone", "repo fork", "repo sync", "repo set-default", "run download"]) {
      refused([...name.split(" "), "1", "-R", "o/r"], /local disk/);
    }
  });

  it("refuses file-reading flags on writes", () => {
    refused(["pr", "comment", "1", "-R", "o/r", "--body-file", "/etc/passwd"], /doesn't take --body-file/);
    refused(["pr", "comment", "1", "-R", "o/r", "-F", "/etc/passwd"], /doesn't take -F/);
    refused(["pr", "create", "-R", "o/r", "--attach", "x.png"], /doesn't take --attach/);
    refused(["pr", "create", "-R", "o/r", "--template", "x.md"], /doesn't take --template/);
    refused(["pr", "comment", "1", "-R", "o/r", "--editor"], /doesn't take --editor/);
  });

  it("refuses control and invisible characters, too many args and long args", () => {
    refused(["pr", "comment", "1", "-R", "o/r", "--body", "a\r\nb"], /carriage returns/);
    refused(["pr", "comment", "1", "-R", "o/r", "--body", "a\rb"], /carriage returns/);
    refused(["pr", "comment", "1", "-R", "o/r", "--body", "a\tb"], /control characters/);
    refused(["pr", "comment", "1", "-R", "o/r", "--body", "a\u2028b"], /control characters/);
    refused(["pr", "comment", "1", "-R", "o/r", "--body", "a\u0000b"], /NUL/);
    refused(["pr", "comment", "1", "-R", "o/r", "--body", "a\u202eb"], /invisible/);
    refused(["pr", "comment", "1", "-R", "o/r", "--body", "x".repeat(2001)], /2000/);
    refused(["pr", "list", "-R", "o/r", ...Array.from({ length: 19 }, () => ["--label", "x"]).flat()], /at most 40/);
  });

  it("checks each flag's arity and value", () => {
    refused(["pr", "list", "-R", "o/r", "--draft=false"], /takes no value/);
    refused(["pr", "list", "-R", "o/r", "--limit"], /needs a value/);
    refused(["pr", "list", "-R", "o/r", "--limit", "ten"], /whole number/);
    refused(["pr", "list", "-R", "o/r", "--state", "weird"], /one of/);
    refused(["pr", "list", "-R", "o/r", "--json", "title;rm"], /field names/);
    refused(["pr", "list", "-R", "o/r", "-R", "p/q"], /twice/);
    refused(["pr", "list", "-R", "o/r", "--base", "../x"], /branch/);
    refused(["pr", "list", "-R", "o/r", "extra"], /no positional/);
    refused(["search", "prs", "one", "two"], /positional/);
    assert.deepEqual(classifyGh(["pr", "list", "-R", "o/r", "-l", "a", "--label=b"]).argv, ["pr", "list", "--repo", "o/r", "--label", "a", "--label", "b"]);
  });

  it("holds --duplicate-of and --head to github.com", () => {
    const close = ["issue", "close", "3", "-R", "o/r", "--duplicate-of"];
    for (const value of ["7", "https://github.com/o/r/issues/7"]) assert.equal(classifyGh([...close, value]).kind, "ask");
    for (const value of ["https://evil.example/o/r/issues/7", "https://github.com.evil.example/o/r/issues/7", "http://github.com/o/r/issues/7", "https://github.com/o/r/pull/7", "https://github.com/o/r/issues/7/x", "#7", "07", "o/r#7"]) {
      refused([...close, value], /issue number/);
    }
    const create = ["pr", "create", "-R", "o/r", "-t", "x", "-b", "y", "--head"];
    for (const value of ["feature/x", "octo-cat:feature/x"]) assert.equal(classifyGh([...create, value]).kind, "ask");
    for (const value of ["evil.example:x", "github.com:x", "o/r:x", "-o:x", ":x", "o:", "o:../x", "o:a:b", "a".repeat(40) + ":x", "https://github.com/o/r"]) {
      refused([...create, value], /branch name or owner:branch/);
    }
  });

  it("builds the canonical argv: subcommand, positionals, then --long value", () => {
    const call = classifyGh(["pr", "view", "-R", "o/r", "-q", ".title", "12", "--json=title,body", "-c"]);
    assert.deepEqual(call.argv, ["pr", "view", "12", "--repo", "o/r", "--jq", ".title", "--json", "title,body", "--comments"]);
    assert.ok(Object.isFrozen(call.argv));
    const body = classifyGh(["pr", "comment", "1", "-R", "o/r", "-b", "- a list item, with 'quotes'"]);
    assert.deepEqual(body.argv, ["pr", "comment", "1", "--repo", "o/r", "--body", "- a list item, with 'quotes'"]);
    assert.equal(ghCommandLine(body.argv), "gh pr comment 1 --repo o/r --body '- a list item, with '\\''quotes'\\'''");
  });

  it("allows line feeds only inside --body values of writes", () => {
    const body = "Thanks for this!\n\n- one nit\n- 'quoted' second";
    const comment = classifyGh(["pr", "comment", "1", "-R", "o/r", "--body", body]);
    assert.deepEqual(comment.argv, ["pr", "comment", "1", "--repo", "o/r", "--body", body]);
    assert.equal(ghCommandLine(comment.argv), "gh pr comment 1 --repo o/r --body 'Thanks for this!\n\n- one nit\n- '\\''quoted'\\'' second'");
    assert.deepEqual(classifyGh(["issue", "create", "-R", "o/r", "-t", "t", "--body=a\nb"]).argv, ["issue", "create", "--repo", "o/r", "--title", "t", "--body", "a\nb"]);
    for (const args of [["pr", "review", "1", "-R", "o/r", "-c", "-b", "a\nb"], ["issue", "comment", "1", "-R", "o/r", "-b", "a\nb"], ["pr", "edit", "1", "-R", "o/r", "-b", "a\nb"]]) {
      assert.equal(classifyGh(args).kind, "ask");
    }
    refused(["pr", "create", "-R", "o/r", "--title", "a\nb", "--body", "x"], /--title can't hold line feeds/);
    refused(["pr", "list", "-R", "o/r\n"], /--repo can't hold line feeds/);
    refused(["pr", "list", "-R", "o/r", "--jq", ".[]\n| .title"], /--jq can't hold line feeds/);
    refused(["api", "repos/o/r", "--jq", "$ENV\n"], /--jq can't hold line feeds/);
    refused(["api", "repos/o/r\nx"], /can't hold line feeds/);
    refused(["pr", "view", "1\n2", "-R", "o/r"], /positional arguments can't hold line feeds/);
    refused(["pr", "close", "1", "-R", "o/r", "--comment", "a\nb"], /--comment can't hold line feeds/);
    refused(["pr", "comment\n", "1"], /command can't hold line feeds/);
    refused(["pr", "comment", "1", "-R", "o/r", "--bo\ndy=x"], /flag names can't hold line feeds/);
    refused(["search", "prs", "a\nb"], /line feeds/);
  });
});

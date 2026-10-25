export type GhKind = "read" | "ask";
export type ValueKind = "text" | "body" | "number" | "repo" | "fields" | "branch" | "head" | "issue" | readonly string[];
export type PositionalKind = "pr" | "issue" | "run" | "repo" | "query" | "endpoint";
export type TargetRule = "repo" | "positional" | "none";

export interface FlagSpec {
  long: string;
  short: string | null;
  value: ValueKind | null;
  repeat: boolean;
}

export interface CommandSpec {
  kind: GhKind;
  positional: PositionalKind | null;
  minPositionals: number;
  maxPositionals: number;
  target: TargetRule;
  byLong: ReadonlyMap<string, FlagSpec>;
  byShort: ReadonlyMap<string, FlagSpec>;
}

function valueKind(word: string): ValueKind {
  if (word.includes("|")) return Object.freeze(word.split("|"));
  if (word === "text" || word === "body" || word === "number" || word === "repo" || word === "fields" || word === "branch") return word;
  if (word === "head" || word === "issue") return word;
  throw new Error(`bad gh value kind ${word}`);
}

// One flag per string, as gh defines it: "-L --limit number" takes a value, "--draft" takes none, "text+" repeats,
// and "body" is the only kind whose value may hold line feeds.
function flag(line: string): FlagSpec {
  const words = line.split(" ");
  const short = words[0]?.match(/^-([A-Za-z])$/)?.[1] ?? null;
  const rest = short === null ? words : words.slice(1);
  const long = rest[0]?.match(/^--([a-z][a-z-]*)$/)?.[1];
  if (long === undefined || rest.length > 2) throw new Error(`bad gh flag spec ${line}`);
  const raw = rest[1];
  if (raw === undefined) return { long, short, value: null, repeat: false };
  const repeat = raw.endsWith("+");
  const word = repeat ? raw.slice(0, -1) : raw;
  return { long, short, value: valueKind(word), repeat };
}

interface Shape {
  positional?: PositionalKind;
  min?: number;
  max?: number;
  target?: TargetRule;
}

function command(kind: GhKind, shape: Shape, lines: readonly string[]): CommandSpec {
  const flags = lines.map(flag);
  const byLong = new Map(flags.map((spec) => [spec.long, spec]));
  const byShort = new Map(flags.flatMap((spec): [string, FlagSpec][] => (spec.short === null ? [] : [[spec.short, spec]])));
  if (byLong.size !== flags.length || byShort.size !== flags.filter((spec) => spec.short !== null).length) throw new Error("duplicate gh flag");
  const positional = shape.positional ?? null;
  return {
    kind, positional, byLong, byShort,
    minPositionals: shape.min ?? 0,
    maxPositionals: positional === null ? 0 : (shape.max ?? 1),
    target: shape.target ?? "repo",
  };
}

const REPO = "-R --repo repo";
const OUTPUT = ["-q --jq text", "--json fields", "-t --template text"];
const PR_TARGET: Shape = { positional: "pr", min: 1 };
const ISSUE_TARGET: Shape = { positional: "issue", min: 1 };
const RUN_TARGET: Shape = { positional: "run", min: 1 };
const SEARCH: Shape = { positional: "query", target: "none" };
const SEARCH_COMMON = [
  ...OUTPUT, "-L --limit number", "--owner text+", "--language text", "--order asc|desc", "--created text", "--updated text", "--match text+",
];
const SEARCH_ISSUES = [
  ...SEARCH_COMMON, "-R --repo repo+", "--state open|closed", "--author text", "--assignee text", "--label text+", "--sort text",
  "--involves text", "--mentions text", "--commenter text", "--milestone text", "--no-assignee", "--no-label", "--locked",
];

const TABLE: Readonly<Record<string, CommandSpec>> = {
  "pr list": command("read", {}, [
    REPO, ...OUTPUT, "-L --limit number", "-s --state open|closed|merged|all", "-A --author text", "-a --assignee text", "-B --base branch",
    "-H --head branch", "-l --label text+", "-S --search text", "-d --draft", "--app text",
  ]),
  "pr view": command("read", { positional: "pr" }, [REPO, ...OUTPUT, "-c --comments"]),
  "pr diff": command("read", { positional: "pr" }, [REPO, "--name-only", "--patch", "--color always|never|auto", "-e --exclude text+"]),
  "pr checks": command("read", { positional: "pr" }, [REPO, ...OUTPUT, "--required"]),
  "pr status": command("read", {}, [REPO, ...OUTPUT, "-c --conflict-status"]),
  "issue list": command("read", {}, [
    REPO, ...OUTPUT, "-L --limit number", "-s --state open|closed|all", "-A --author text", "-a --assignee text", "-l --label text+",
    "-S --search text", "--mention text", "-m --milestone text", "--app text", "--type text",
  ]),
  "issue view": command("read", ISSUE_TARGET, [REPO, ...OUTPUT, "-c --comments"]),
  "repo view": command("read", { positional: "repo", min: 1, target: "positional" }, [...OUTPUT, "-b --branch branch"]),
  "run list": command("read", {}, [
    REPO, ...OUTPUT, "-L --limit number", "-b --branch branch", "-c --commit text", "-e --event text", "-s --status text", "-u --user text",
    "--workflow text", "--created text", "-a --all",
  ]),
  "run view": command("read", RUN_TARGET, [REPO, ...OUTPUT, "-a --attempt number", "-j --job number", "-v --verbose", "--exit-status"]),
  "search prs": command("read", SEARCH, [
    ...SEARCH_ISSUES, "-B --base branch", "-H --head branch", "--draft", "--merged", "--review text", "--review-requested text", "--reviewed-by text",
  ]),
  "search issues": command("read", SEARCH, [...SEARCH_ISSUES, "--include-prs"]),
  "search repos": command("read", SEARCH, [
    ...SEARCH_COMMON, "--topic text+", "--sort forks|help-wanted-issues|stars|updated", "--stars text", "--forks text", "--followers text",
    "--visibility text+",
  ]),
  api: command("read", { positional: "endpoint", min: 1, target: "none" }, ["-q --jq text", "-t --template text", "--paginate"]),

  "pr comment": command("ask", PR_TARGET, [REPO, "-b --body body", "--edit-last"]),
  "pr review": command("ask", PR_TARGET, [REPO, "-a --approve", "-c --comment", "-r --request-changes", "-b --body body"]),
  "pr create": command("ask", {}, [
    REPO, "-t --title text", "-b --body body", "-B --base branch", "-H --head head", "-d --draft", "-l --label text+", "-a --assignee text+",
    "-r --reviewer text+", "-m --milestone text", "--no-maintainer-edit",
  ]),
  "pr edit": command("ask", PR_TARGET, [
    REPO, "-t --title text", "-b --body body", "-B --base branch", "--add-label text+", "--remove-label text+", "--add-assignee text+",
    "--remove-assignee text+", "--add-reviewer text+", "--remove-reviewer text+", "-m --milestone text", "--remove-milestone",
  ]),
  "pr close": command("ask", PR_TARGET, [REPO, "-c --comment text"]),
  "pr reopen": command("ask", PR_TARGET, [REPO, "-c --comment text"]),
  "pr merge": command("ask", PR_TARGET, [
    REPO, "-m --merge", "-r --rebase", "-s --squash", "--auto", "--disable-auto", "-t --subject text", "-b --body body", "--match-head-commit text",
  ]),
  "issue comment": command("ask", ISSUE_TARGET, [REPO, "-b --body body", "--edit-last"]),
  "issue create": command("ask", {}, [REPO, "-t --title text", "-b --body body", "-l --label text+", "-a --assignee text+", "-m --milestone text", "--type text"]),
  "issue edit": command("ask", { positional: "issue", min: 1, max: 10 }, [
    REPO, "-t --title text", "-b --body body", "--add-label text+", "--remove-label text+", "--add-assignee text+", "--remove-assignee text+",
    "-m --milestone text", "--remove-milestone",
  ]),
  "issue close": command("ask", ISSUE_TARGET, [REPO, "-c --comment text", "-r --reason text", "--duplicate-of issue"]),
  "issue reopen": command("ask", ISSUE_TARGET, [REPO, "-c --comment text"]),
  "run rerun": command("ask", RUN_TARGET, [REPO, "--failed", "-d --debug", "-j --job number"]),
  "run cancel": command("ask", RUN_TARGET, [REPO, "--force"]),
};

export const GH_COMMANDS: ReadonlyMap<string, CommandSpec> = new Map(Object.entries(TABLE));

export const REFUSED_GROUPS: ReadonlySet<string> = new Set([
  "auth", "config", "extension", "extensions", "ext", "alias", "secret", "variable", "ssh-key", "gpg-key", "codespace", "cs", "gist", "release",
  "attestation", "at",
]);

export const LOCAL_WRITERS: ReadonlySet<string> = new Set(["pr checkout", "repo clone", "repo fork", "repo sync", "repo set-default", "run download"]);

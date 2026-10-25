import { GH_COMMANDS, LOCAL_WRITERS, REFUSED_GROUPS, type CommandSpec, type FlagSpec, type GhKind, type PositionalKind, type ValueKind } from "./githubFlags.ts";
import { hasInvisible, hasInvisibleOutsideEmoji, visibleEscapes } from "./trust.ts";

export const GH_MAX_ARGS = 40;
export const GH_MAX_ARG_LENGTH = 2000;

export class GhRefused extends Error {}

export interface GhFlagUse {
  spec: FlagSpec;
  value: string | null;
}

export interface GhCall {
  kind: GhKind;
  command: string;
  positional: PositionalKind | null;
  positionals: readonly string[];
  flags: readonly GhFlagUse[];
  argv: readonly string[];
}

const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
const OWNER_MAX = 39;
const OWNER_PART = "[A-Za-z0-9](?:-?[A-Za-z0-9])*";
const NAME_PART = "[A-Za-z0-9._-]{1,100}";
const OWNER = new RegExp(`^(?=.{1,${OWNER_MAX}}$)${OWNER_PART}$`);
const REPO = new RegExp(`^(${OWNER_PART})\\/(${NAME_PART})$`);
const GITHUB_URL = new RegExp(`^https:\\/\\/github\\.com\\/(${OWNER_PART})\\/(${NAME_PART})(?:\\/[A-Za-z0-9._~%/#-]*)?$`);
const ISSUE_URL = new RegExp(`^https:\\/\\/github\\.com\\/(${OWNER_PART})\\/(${NAME_PART})\\/issues\\/[1-9][0-9]{0,9}$`);
const GITHUB_PREFIX = "https://github.com/";
const ENCODED_SEPARATOR = /%2e|%2f|%5c/i;
const NUMBER = /^[1-9][0-9]{0,9}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const FIELDS = /^[A-Za-z]{1,40}(?:,[A-Za-z]{1,40}){0,60}$/;
const ENDPOINT = /^[A-Za-z0-9._~%/?=&+,:@{}-]+$/;

function refuse(reason: string): never {
  throw new GhRefused(reason);
}

// The lookahead in OWNER only bounds a whole string, so inside a path the owner's length is checked on its own.
function ownerAndName(pattern: RegExp, value: string): boolean {
  const match = pattern.exec(value);
  const owner = match?.[1];
  const name = match?.[2];
  return owner !== undefined && name !== undefined && owner.length <= OWNER_MAX && name !== "." && name !== "..";
}

function isRepo(value: string): boolean {
  return ownerAndName(REPO, value);
}

// gh and the browser resolve "..", "." and encoded separators, so a path that only starts at owner/name could leave it.
function plainPath(value: string): boolean {
  const path = value.slice(GITHUB_PREFIX.length);
  if (value.includes("\\") || ENCODED_SEPARATOR.test(path)) return false;
  const segments = path.split("/");
  return segments.every((segment, index) => {
    const name = segment.split("#")[0] ?? "";
    if (name === "." || name === "..") return false;
    return segment !== "" || index === segments.length - 1;
  });
}

function isGithubUrl(value: string): boolean {
  return ownerAndName(GITHUB_URL, value) && plainPath(value);
}

function isIssueUrl(value: string): boolean {
  return ownerAndName(ISSUE_URL, value) && plainPath(value);
}

function isBranch(value: string): boolean {
  return BRANCH.test(value) && !value.includes("..") && !value.includes("//") && !value.endsWith("/") && !value.endsWith(".lock");
}

function isHead(value: string): boolean {
  const colon = value.indexOf(":");
  if (colon < 0) return isBranch(value);
  return OWNER.test(value.slice(0, colon)) && isBranch(value.slice(colon + 1));
}

function checkArg(arg: string): void {
  if (arg.length > GH_MAX_ARG_LENGTH) refuse(`each argument must be at most ${GH_MAX_ARG_LENGTH} characters`);
  if (CONTROL.test(arg)) refuse("arguments can't hold carriage returns, NUL or other control characters");
  if (!arg.isWellFormed()) refuse("arguments must be well-formed text; this one holds a lone surrogate");
  if (arg === "--") refuse("`--` isn't allowed");
}

function visibleOnly(text: string): void {
  if (hasInvisible(text)) refuse("arguments can't hold invisible characters");
}

function checkHidden(name: string, kind: ValueKind, value: string): void {
  if (kind !== "body") return visibleOnly(value);
  if (hasInvisibleOutsideEmoji(value)) {
    refuse(`${name} can't hold invisible characters; U+200D and U+FE0F are allowed only inside a standard emoji, and tag characters never are`);
  }
}

function noLineFeed(arg: string, what: string): void {
  if (arg.includes("\n")) refuse(`${what} can't hold line feeds; only --body can`);
}

function checkValue(spec: FlagSpec, kind: ValueKind, value: string): void {
  const name = `--${spec.long}`;
  checkHidden(name, kind, value);
  if (kind !== "body") noLineFeed(value, name);
  if (typeof kind !== "string") {
    if (!kind.includes(value)) refuse(`${name} must be one of ${kind.join(", ")}`);
    return;
  }
  if (kind === "text" || kind === "body") return;
  if (kind === "repo" && !isRepo(value)) refuse(`${name} must be owner/name on github.com, with no host`);
  if (kind === "number" && !NUMBER.test(value)) refuse(`${name} must be a positive whole number`);
  if (kind === "fields" && !FIELDS.test(value)) refuse(`${name} must be a comma-separated list of field names`);
  if (kind === "branch" && !isBranch(value)) refuse(`${name} must be a branch name`);
  if (kind === "head" && !isHead(value)) refuse(`${name} must be a branch name or owner:branch on github.com`);
  if (kind === "issue" && !(NUMBER.test(value) || isIssueUrl(value))) refuse(`${name} must be an issue number or a https://github.com/owner/name/issues/N URL`);
}

function checkEndpoint(endpoint: string): void {
  if (endpoint.includes("://") || endpoint.startsWith("//")) refuse("the api endpoint must be a path on api.github.com, not a URL");
  const path = endpoint.replace(/^\/+/, "").split(/[?#]/)[0]?.toLowerCase() ?? "";
  if (path === "graphql") refuse("gh api graphql isn't allowed; use a REST path");
  if (!ENDPOINT.test(endpoint)) refuse("the api endpoint holds characters Hive doesn't allow");
}

function checkPositional(kind: PositionalKind, value: string): void {
  if (kind === "query") return;
  const url = isGithubUrl(value);
  if (value.includes("://") && !url) refuse("URLs must start with https://github.com/owner/name");
  if (kind === "pr" && !(NUMBER.test(value) || url || isBranch(value))) refuse("name the pull request by number, branch or https://github.com/ URL");
  if (kind === "issue" && !(NUMBER.test(value) || url)) refuse("name the issue by number or https://github.com/ URL");
  if (kind === "run" && !NUMBER.test(value)) refuse("name the run by its numeric id");
  if (kind === "repo" && !(isRepo(value) || url)) refuse("name the repository as owner/name or a https://github.com/ URL");
  if (kind === "endpoint") checkEndpoint(value);
}

function commandOf(args: readonly string[]): { name: string; tokens: readonly string[] } {
  const [group, sub] = args;
  if (group === undefined) refuse("give gh a command, e.g. [\"pr\", \"list\", \"--repo\", \"owner/name\"]");
  if (group.startsWith("-")) refuse("the first argument must be a gh command, not a flag");
  if (REFUSED_GROUPS.has(group)) refuse(`gh ${group} isn't allowed`);
  if (group === "api") return { name: "api", tokens: args.slice(1) };
  if (sub === undefined || sub.startsWith("-")) refuse(`gh ${group} needs a subcommand`);
  const name = `${group} ${sub}`;
  if (LOCAL_WRITERS.has(name)) refuse(`gh ${name} writes to the local disk, so it isn't allowed`);
  return { name, tokens: args.slice(2) };
}

function flagOf(spec: CommandSpec, name: string, token: string): { flag: FlagSpec; inline: string | undefined } {
  const long = token.startsWith("--");
  const eq = token.indexOf("=");
  const label = long && eq > 0 ? token.slice(0, eq) : token;
  if (label === "--web" || label === "-w") refuse("--web isn't allowed: Hive can't open a browser for an agent");
  if (label === "--hostname") refuse("--hostname isn't allowed: Hive's gh only talks to github.com");
  if (!long && token.length !== 2) refuse(`short-flag clusters like ${token.slice(0, 3)}… aren't allowed; write each flag on its own, e.g. --method`);
  const flag = long ? spec.byLong.get(label.slice(2)) : spec.byShort.get(token.slice(1));
  if (flag === undefined) refuse(`gh ${name} doesn't take ${label} here`);
  return { flag, inline: long && eq > 0 ? token.slice(eq + 1) : undefined };
}

function checkCount(spec: CommandSpec, name: string, count: number): void {
  if (count >= spec.minPositionals && count <= spec.maxPositionals) return;
  if (spec.maxPositionals === 0) refuse(`gh ${name} takes no positional arguments`);
  const range = spec.minPositionals === spec.maxPositionals ? `${spec.maxPositionals}` : `${spec.minPositionals} to ${spec.maxPositionals}`;
  refuse(`gh ${name} takes ${range} positional argument(s)`);
}

export function classifyGh(args: readonly string[]): GhCall {
  if (args.length > GH_MAX_ARGS) refuse(`at most ${GH_MAX_ARGS} arguments`);
  for (const arg of args) checkArg(arg);
  for (const word of args.slice(0, 2)) {
    visibleOnly(word);
    noLineFeed(word, "the command");
  }
  const { name, tokens } = commandOf(args);
  const spec = GH_COMMANDS.get(name);
  if (spec === undefined) refuse(`gh ${name} isn't one of the commands Hive allows`);
  const positionals: string[] = [];
  const flags: GhFlagUse[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (!token.startsWith("-")) {
      visibleOnly(token);
      noLineFeed(token, "positional arguments");
      positionals.push(token);
      continue;
    }
    const flagName = token.startsWith("--") ? (token.split("=")[0] ?? "") : token;
    visibleOnly(flagName);
    noLineFeed(flagName, "flag names");
    const { flag, inline } = flagOf(spec, name, token);
    if (seen.has(flag.long) && !flag.repeat) refuse(`--${flag.long} is given twice`);
    seen.add(flag.long);
    if (flag.value === null) {
      if (inline !== undefined) refuse(`--${flag.long} takes no value`);
      flags.push(Object.freeze({ spec: flag, value: null }));
      continue;
    }
    const value = inline ?? tokens[index + 1];
    if (inline === undefined) index += 1;
    if (value === undefined || value === "") refuse(`--${flag.long} needs a value`);
    checkValue(flag, flag.value, value);
    flags.push(Object.freeze({ spec: flag, value }));
  }
  checkCount(spec, name, positionals.length);
  if (spec.positional !== null) for (const value of positionals) checkPositional(spec.positional, value);
  if (spec.target === "repo" && !seen.has("repo") && !positionals.some(isGithubUrl)) {
    refuse(`gh ${name} needs --repo owner/name or a https://github.com/ URL; there is no local checkout`);
  }
  const argv = [...name.split(" "), ...positionals, ...flags.flatMap((use) => (use.value === null ? [`--${use.spec.long}`] : [`--${use.spec.long}`, use.value]))];
  return Object.freeze({
    kind: spec.kind,
    command: name,
    positional: spec.positional,
    positionals: Object.freeze(positionals),
    flags: Object.freeze(flags),
    argv: Object.freeze(argv),
  });
}

const PLAIN = /^[A-Za-z0-9._/:=@%+,-]+$/;

export function ghCommandLine(argv: readonly string[]): string {
  return visibleEscapes(["gh", ...argv.map((arg) => (PLAIN.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`))].join(" "));
}

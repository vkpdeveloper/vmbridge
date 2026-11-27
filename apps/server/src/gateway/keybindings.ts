import { str, type Wire } from "./types.ts";

/**
 * Keyboard shortcuts set from T3's settings, kept by VM Bridge so they are the same whichever VM answers and survive
 * VMs being replaced. Mirrors T3's `keybindings.json` handling (`apps/server/src/keybindings.ts` and
 * `packages/shared/src/keybindings.ts` in T3 Code): the parsing below must match T3's, since clients match key events
 * against the compiled shortcuts VM Bridge sends.
 */

/** A shortcut as `keybindings.json` spells it: `{ key: "mod+k", command, when? }`. */
export interface KeybindingRule {
  key: string;
  command: string;
  when?: string;
}

interface Shortcut {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  modKey: boolean;
}

type WhenNode =
  | { type: "identifier"; name: string }
  | { type: "not"; node: WhenNode }
  | { type: "and"; left: WhenNode; right: WhenNode }
  | { type: "or"; left: WhenNode; right: WhenNode };

/** What T3 servers send clients in `ServerConfig.keybindings`. */
export interface ResolvedKeybinding {
  command: string;
  shortcut: Shortcut;
  whenAst?: WhenNode;
}

/** T3's limits (`MAX_KEYBINDINGS_COUNT` and friends). */
const maxRules = 256;
const maxKeyLength = 64;
const maxWhenLength = 256;
const maxCommandLength = 128;
const maxWhenDepth = 64;

/** A keybinding write T3 refuses with `KeybindingsConfigParseError`. */
export class KeybindingError extends Error {}

function parseShortcut(value: string): Shortcut | null {
  const tokens = value
    .toLowerCase()
    .split("+")
    .map((token) => token.trim());
  // "mod++" binds the plus key: splitting leaves exactly two empty tokens at the end.
  let trailing = 0;
  while (tokens[tokens.length - 1] === "") {
    trailing++;
    tokens.pop();
  }
  if (trailing === 2) tokens.push("+");
  else if (trailing !== 0) return null;
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) return null;

  const shortcut: Shortcut = { key: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: false };
  for (const token of tokens) {
    if (token === "cmd" || token === "meta") shortcut.metaKey = true;
    else if (token === "ctrl" || token === "control") shortcut.ctrlKey = true;
    else if (token === "shift") shortcut.shiftKey = true;
    else if (token === "alt" || token === "option") shortcut.altKey = true;
    else if (token === "mod") shortcut.modKey = true;
    else if (shortcut.key) return null;
    else shortcut.key = token === "space" ? " " : token === "esc" ? "escape" : token;
  }
  return shortcut.key ? shortcut : null;
}

type WhenToken = { type: "identifier"; value: string } | { type: "not" | "and" | "or" | "lparen" | "rparen" };

function tokenizeWhen(expression: string): WhenToken[] | null {
  const tokens: WhenToken[] = [];
  let index = 0;
  while (index < expression.length) {
    const rest = expression.slice(index);
    const symbol = rest.startsWith("&&") ? "and" : rest.startsWith("||") ? "or" : null;
    if (/^\s/.test(rest)) index++;
    else if (symbol) {
      tokens.push({ type: symbol });
      index += 2;
    } else if (rest[0] === "!" || rest[0] === "(" || rest[0] === ")") {
      tokens.push({ type: rest[0] === "!" ? "not" : rest[0] === "(" ? "lparen" : "rparen" });
      index++;
    } else {
      const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(rest)?.[0];
      if (!identifier) return null;
      tokens.push({ type: "identifier", value: identifier });
      index += identifier.length;
    }
  }
  return tokens;
}

/** `a && !(b || c)`: `!` binds tightest, then `&&`, then `||`. */
function parseWhen(expression: string): WhenNode | null {
  const tokens = tokenizeWhen(expression);
  if (!tokens?.length) return null;
  let index = 0;

  const primary = (depth: number): WhenNode | null => {
    const token = tokens[index];
    if (depth > maxWhenDepth || !token) return null;
    if (token.type === "identifier") {
      index++;
      return { type: "identifier", name: token.value };
    }
    if (token.type !== "lparen") return null;
    index++;
    const node = or(depth + 1);
    if (!node || tokens[index]?.type !== "rparen") return null;
    index++;
    return node;
  };
  const unary = (depth: number): WhenNode | null => {
    let nots = 0;
    while (tokens[index]?.type === "not") {
      index++;
      if (++nots > maxWhenDepth) return null;
    }
    let node = primary(depth);
    for (; node && nots > 0; nots--) node = { type: "not", node };
    return node;
  };
  const and = (depth: number): WhenNode | null => {
    let left = unary(depth);
    while (left && tokens[index]?.type === "and") {
      index++;
      const right = unary(depth);
      left = right ? { type: "and", left, right } : null;
    }
    return left;
  };
  const or = (depth: number): WhenNode | null => {
    let left = and(depth);
    while (left && tokens[index]?.type === "or") {
      index++;
      const right = and(depth);
      left = right ? { type: "or", left, right } : null;
    }
    return left;
  };

  const ast = or(0);
  return ast && index === tokens.length ? ast : null;
}

function encodeShortcut(shortcut: Shortcut): string | null {
  if (!shortcut.key || (shortcut.key !== "+" && shortcut.key.includes("+"))) return null;
  const modifiers = [
    shortcut.modKey && "mod",
    shortcut.metaKey && "meta",
    shortcut.ctrlKey && "ctrl",
    shortcut.altKey && "alt",
    shortcut.shiftKey && "shift",
  ].filter((modifier) => modifier !== false);
  return [...modifiers, shortcut.key === " " ? "space" : shortcut.key].join("+");
}

function encodeWhen(node: WhenNode): string {
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!(${encodeWhen(node.node)})`;
    case "and":
      return `(${encodeWhen(node.left)} && ${encodeWhen(node.right)})`;
    case "or":
      return `(${encodeWhen(node.left)} || ${encodeWhen(node.right)})`;
  }
}

function compile(rule: KeybindingRule): ResolvedKeybinding | null {
  const shortcut = parseShortcut(rule.key);
  if (!shortcut) return null;
  if (rule.when === undefined) return { command: rule.command, shortcut };
  const whenAst = parseWhen(rule.when);
  return whenAst ? { command: rule.command, shortcut, whenAst } : null;
}

/** A compiled shortcut spelled back as a rule, as T3 does to save an inherited default. */
function decompile(resolved: ResolvedKeybinding): KeybindingRule | null {
  const key = encodeShortcut(resolved.shortcut);
  if (!key) return null;
  return resolved.whenAst ? { key, command: resolved.command, when: encodeWhen(resolved.whenAst) } : { key, command: resolved.command };
}

/** Rules compare by meaning, not spelling: settings may send "meta+k" for a saved "cmd+k". */
function identity(rule: KeybindingRule): string {
  const shortcut = parseShortcut(rule.key);
  const key = (shortcut && encodeShortcut(shortcut)) ?? rule.key;
  const whenAst = rule.when === undefined ? null : parseWhen(rule.when);
  return JSON.stringify([rule.command, key, rule.when === undefined ? null : whenAst ? encodeWhen(whenAst) : rule.when]);
}

const same = (left: KeybindingRule, right: KeybindingRule) => identity(left) === identity(right);

/** A rule from a client request: the payload's `{ key, command, when? }`. */
function ruleFrom(value: unknown): KeybindingRule {
  const input = (value ?? {}) as Wire;
  const key = str(input.key)?.trim();
  const command = str(input.command)?.trim();
  const when = input.when === undefined ? undefined : str(input.when)?.trim();
  if (!key || key.length > maxKeyLength) throw new KeybindingError("The shortcut is missing or too long.");
  if (!command || command.length > maxCommandLength) throw new KeybindingError("The command is missing or too long.");
  if (input.when !== undefined && (!when || when.length > maxWhenLength)) throw new KeybindingError("The condition is empty or too long.");
  return when === undefined ? { key, command } : { key, command, when };
}

/** What clients see: T3's defaults (as the VM reported them), less those a saved rule overrides, then the saved rules. */
export function resolveKeybindings(defaults: readonly ResolvedKeybinding[], saved: readonly KeybindingRule[]): ResolvedKeybinding[] {
  const custom = saved.flatMap((rule) => compile(rule) ?? []);
  const overridden = new Set(custom.map((binding) => binding.command));
  return [...defaults.filter((binding) => !overridden.has(binding.command)), ...custom].slice(-maxRules);
}

/**
 * The saved rules after `server.upsertKeybinding`, as T3 computes them: the new rule replaces `replace` and any
 * identical rule. The first saved rule for a command overrides all of its defaults, so its other defaults are saved
 * alongside it to keep working.
 */
export function upsertKeybinding(saved: readonly KeybindingRule[], defaults: readonly ResolvedKeybinding[], payload: Wire): KeybindingRule[] {
  const rule = ruleFrom(payload);
  if (!compile(rule)) throw new KeybindingError(`"${rule.key}" is not a valid shortcut or condition.`);
  const replace = payload.replace === undefined ? null : ruleFrom(payload.replace);
  const defaultRules = defaults.flatMap((binding) => decompile(binding) ?? []);
  const inheritsDefaults =
    !saved.some((entry) => entry.command === rule.command) &&
    (!replace || (replace.command === rule.command && defaultRules.some((entry) => same(entry, replace))));
  const siblings = inheritsDefaults
    ? defaultRules.filter((entry) => entry.command === rule.command && !same(entry, rule) && !(replace && same(entry, replace)))
    : [];
  const retained = saved.filter((entry) => !same(entry, rule) && !(replace && same(entry, replace)));
  if (siblings.length > 0 && retained.length + siblings.length > maxRules - 1) {
    throw new KeybindingError("Not enough room to save this shortcut and its inherited shortcuts.");
  }
  return [...siblings, ...retained.slice(-(maxRules - 1)), rule];
}

/** The saved rules after `server.removeKeybinding`. A default can't be removed this way, only overridden. */
export function removeKeybinding(saved: readonly KeybindingRule[], payload: Wire): KeybindingRule[] {
  const target = ruleFrom(payload);
  return saved.filter((entry) => !same(entry, target));
}

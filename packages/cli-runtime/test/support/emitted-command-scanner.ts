// Executable rule for the emitted-command quoting class (see src/command-text.ts).
//
// The class: a value the CLI does not own — a kind convention's `governs`/`path`/field names/enum
// values/link types, a concept id arriving from a shared board, the repo-authored `.agentstate.json`
// binding — interpolated into a string the CLI tells a human or agent to RUN. Bare, and `;`/`$(…)`
// execute. Inside double quotes, `$(…)`, a backtick and `\` still execute and a literal `"` ends the
// quote. A per-site reminder does not survive contact with a new contributor, so the property is
// checked here instead.
//
// The rule, stated once: **inside a command-shaped template literal, every interpolation must have
// passed through src/command-text.ts.** That is decided by TYPE — the producers return the branded
// `CommandText`, and so do `cliInvocation()`/`exactCliInvocation()` — not by matching identifier
// names, so a new helper that renders tokens correctly passes with no allowlist entry, and a raw
// `string` never does. There is no baseline file and no per-site exception list to rot.
//
// A literal is command-shaped when either
//   (a) it interpolates a `CommandText` — in practice the CLI invocation prefix, i.e. it is building
//       a `superbee …` command; or
//   (b) a static chunk ends in a flag (`--type ` or a bare `--`) immediately before an interpolation,
//       which is the shape of a command fragment even when the prefix lives in another literal.
// (b) is what makes `--type ${bundleValue}` fail in a brand-new helper that never mentions the CLI.
//
// The English half of a message that also carries a runnable span is left alone: the scan tracks
// where the runnable span STARTS and ENDS, so "the 'Task' kind" needs no annotation while
// `kind field "${governs}"` in the same sentence is checked. There is no per-site "trust me" marker
// to misapply — the only way to satisfy the rule is to render the value.
//
// `commandLiteral()` is the one producer that returns its input verbatim, so it is additionally
// required to be called with a LITERAL: text the CLI itself authored, never a runtime value.
//
// WHAT THIS CHECK IS, AND IS NOT
//
// The strong layer is the TYPE BRAND: a value reaches an emitted command only by being rendered
// into `CommandText`, and that is enforced by the compiler on every ordinary code path. This
// scanner is the second layer, and its job is narrower than it looks — it catches the shapes an
// HONEST CONTRIBUTOR reaches for while the brand is not in the way, chiefly a template literal that
// interpolates a raw value. It is NOT a barrier against someone deliberately evading it. Anyone who
// wants to can write `as any` and be done; no AST walk closes that, and pretending otherwise would
// be worse than saying so. `test/emitted-command-injection.test.ts` is the layer that does not care
// how the string was built: it executes the emitted command and asserts nothing runs.
//
// KNOWN ESCAPES, enumerated rather than implied. Each was found by review or by the author; all are
// accepted as out of scope for an AST-level check, because closing them properly needs dataflow:
//
//   0'. `shellArg` is banned outside the authority modules, because it THROWS rather than degrading
//       on Windows. The ban resolves the callee by DECLARATION IDENTITY, and it is also
//       CALL-SHAPE-SPECIFIC: it matches a direct call expression, so:
//         • `shellArg.call(null, v)` / `.apply` evade the BAN (the callee is a property access).
//           Both are still reported in practice, by the argument-position rule rather than by the
//           ban — verified, not assumed.
//         • a bare callback reference — `vs.map(shellArg)` — evades the ban too, and if its result
//           is wrapped so no other rule applies (inside `commandFragment`, say) nothing reports it.
//           That one is a genuine escape, measured.
//       `commandQuoted` is the always-quote replacement, byte-identical wherever the value renders.
//   0. IRREDUCIBLE under any type-based checker: a function whose DECLARED return type is
//      `CommandText` satisfies every rule here by definition, because the declaration is the only
//      evidence a type checker has about what a function returns. Identity checks decide WHERE a
//      producer was declared, which closes a foreign module borrowing the authority's NAME; they
//      cannot decide whether a foreign producer's body actually renders. Only reading the body
//      would, and that is dataflow. This is a property of the approach, not a gap in it.
//   1. `function launder(v: string): CommandText { return v as any }` — `as any` in a return
//      position, so no `CommandText` cast appears anywhere for the cast rule to see. A special case
//      of 0 with the lie made locally visible.
//   2. `let out = ""; out += value;` — `+=` accumulation is not a `+` chain.
//   3. `const parts = [inv, "--type", v]; parts.join(" ")` — the join rule requires an ARRAY
//      LITERAL receiver, so a named array escapes it.
//   4. `.concat(" --type ", v)` — not handled at all.
//   5. `"superbee doc write x --type " + v` — the CLI name written as literal TEXT, so no operand
//      carries the brand and the `+` rule has no signal to fire on.
//   6. `[inv, "--type", v].map(String).join(" ")` — `.map` breaks the array-literal receiver.
//   7. `` `superbee doc read ${v}` `` — the same idea in a template: the CLI name as literal text
//      and the value in a POSITIONAL slot, so there is neither a brand nor a flag to key on. The
//      flag-adjacent form of this IS caught; only the positional form escapes.
//   8. Scope: `.ts` files under `packages/cli/src` only. `.js` files inside `src` are skipped, and
//      no other package is scanned. No command emission exists outside this package today; nothing
//      enforces that it stays that way. The coverage canary pins the file set within that scope.
//   9. `-o ${value}` — single-dash flags are not in the flag-adjacency pattern.
//  10. `--${flag} <${value}>` with no invocation prefix in the same literal — the flag-value
//      carry-forward requires the chunk between the two interpolations to be bare whitespace.
//
// Item 0 is structural; items 1-7 and 9-10 all share one property: they require the author to write
// something a reviewer would notice. That is the boundary this check is drawn at, deliberately and
// with the limits stated, rather than an implied guarantee it cannot keep.
//
// What the identity checks DO buy, stated precisely enough to be checked rather than believed:
// NO RULE USES A NAME, A PIECE OF SOURCE TEXT, OR A FILE'S BASENAME AS A PROXY FOR IDENTITY. A
// callee resolves to a SYMBOL and is compared against the authority module's actual export symbols;
// a cast is decided by the asserted type's BRAND; an authority module is identified by RESOLVED
// ABSOLUTE PATH. That closes both directions of the name collision — a foreign module exporting
// `commandToken` does not inherit the whole-argument exemption, a foreign function merely named
// `commandLiteral` is not held to the authority's literal-only contract, and a file named
// `command-text.ts` at some other path is scanned like any other consumer.
//
// Two name comparisons remain and are deliberately NOT identity checks, so they are called out
// here rather than hidden: the file glob (`.ts`, pinned by the coverage canary) and the `join`
// method name in the array rule. Neither can grant anything — a method coincidentally named `join`
// causes MORE checking, not less — so both fail safe.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import ts from "typescript";

/**
 * What a scan found AND what it looked at. `scanned` exists because this whole class of failure is
 * invisible by construction: a scanner that scans less still passes everything it scans, so
 * "0 violations" and "no longer looking" are indistinguishable from the outside. Twice in this
 * change a modification silently dropped files from the scan and nothing failed. The coverage canary
 * in `emitted-command-quoting.test.ts` pins this list so a third time fails loudly.
 */
export interface QuotingScan {
  violations: QuotingViolation[];
  /** Paths, relative to the scan root, of every file actually walked (after the skip). */
  scanned: string[];
}

export interface QuotingViolation {
  file: string;
  line: number;
  /** Source offsets of the offending expression, so a fix can be applied mechanically. */
  start: number;
  end: number;
  expression: string;
  reason: string;
  snippet: string;
}

/**
 * `--name `, `--name="`, or a bare `--`, at the very end of a static chunk: whatever follows is a
 * flag or a flag's value, wherever the literal lives. The optional trailing quote is deliberate —
 * `--text "${linkType}"` must be caught even in a fragment that never names the CLI.
 */
const FLAG_ADJACENT = /(?:^|\s)--[A-Za-z0-9][A-Za-z0-9-]*[ =]["']?$|(?:^|\s)--$/;
/**
 * The double-quote idiom the class hides in: `"${value}"`. Double quotes only — `'${id}'` is this
 * codebase's ENGLISH quoting for an identifier, and `'…'` is genuine shell quoting besides, so
 * treating it as an argument position would flag prose without finding a single real defect.
 */
const OPENS_QUOTE = /"$/;
const CLOSES_QUOTE = /^"/;

/** The value set a string-literal type may draw from to count as inert without being rendered. */
const INERT_LITERAL = /^[A-Za-z0-9_@+=:,./-]+$/;
/**
 * What ENDS the runnable span a command opened. These messages embed a command either as the whole
 * template or inside a delimited run, and every delimiter in use is one of these: a closing backtick
 * (`` `superbee …` `` inside a sentence), a newline, or the em dash / arrow this CLI uses to hand
 * back to prose. A single quote is deliberately NOT a terminator: it is this codebase's prose
 * delimiter AROUND a whole command, so ending the span at one would stop checking the command's own
 * arguments.
 */
const COMMAND_TERMINATOR = /[`\n\u2014\u2192]/;

/** Calls whose argument is rendered as one token, so its internals are not separate arguments. */
const RENDERERS = new Set(["commandToken", "shellArg", "commandLiteral"]);
/** The module that may legitimately mint branded command text out of a raw string. */
/**
 * The modules that own rendering, identified by RESOLVED ABSOLUTE PATH.
 *
 * Not by basename, and not by a path relative to the scan root. Both of those are string comparisons
 * standing in for an identity, and both silently REDUCED COVERAGE when tried: a root-relative form
 * changes meaning when the scan root does, and a basename form makes any file anywhere named
 * `command-text.ts` inherit authority — so a nested one is skipped wholesale and a nested
 * `invocation.ts` gets the cast exemption. A scanner that scans less still passes everything it
 * scans, so neither failure announced itself.
 *
 * Resolved from this file's own location, so it is independent of whatever tree is being scanned.
 */
const AUTHORITY_PATHS = new Set(
  ["command-text.ts", "invocation.ts", "shell-quoting.ts"]
    .map((name) => join(import.meta.dirname, "../../src", name))
    .map((path) => {
      try {
        return canonicalPath(realpathSync(path));
      } catch {
        throw new Error(`quoting authority module is missing: ${path}`);
      }
    }),
);

/** The one module that assembles tokens OUT OF raw values, so it cannot be scanned as a consumer. */
const TOKEN_ASSEMBLY_PATH = join(import.meta.dirname, "../../src/command-text.ts");

/**
 * One canonical spelling for a path, so a comparison never depends on how the caller spelled it.
 * TypeScript hands back `C:/x/y.ts` while `node:path` builds `C:\\x\\y.ts`, and Windows treats the
 * two as the same file — so separators are folded and, on Windows only, case is too. Exported
 * because the property is worth pinning directly rather than only through a scan.
 */
export function canonicalPath(value: string): string {
  const resolved = resolve(value).split("\\").join("/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Paths this scanner REPORTS are always POSIX-shaped, so assertions are platform-independent. */
export function toPosixPath(value: string): string {
  return value.split("\\").join("/");
}

function sameFile(a: string, b: string): boolean {
  const real = (value: string): string => {
    try {
      return canonicalPath(realpathSync(value));
    } catch {
      return canonicalPath(value);
    }
  };
  return real(a) === real(b);
}

/**
 * Report one operand of a `+` chain or an array `join` that reaches command text as a raw value.
 * Literal source text, an inert-by-type value and an already-rendered token are all fine; a
 * template expression is fine too, because the walk checks it on its own.
 */
function reportUnrenderedOperand(
  operand: ts.Expression,
  file: string,
  source: ts.SourceFile,
  violations: QuotingViolation[],
  verb: string,
  approved: (node: ts.Expression) => boolean = () => false,
): void {
  if (ts.isConditionalExpression(operand)) {
    reportUnrenderedOperand(operand.whenTrue, file, source, violations, verb, approved);
    reportUnrenderedOperand(operand.whenFalse, file, source, violations, verb, approved);
    return;
  }
  if (ts.isParenthesizedExpression(operand)) {
    reportUnrenderedOperand(operand.expression, file, source, violations, verb, approved);
    return;
  }
  if (isLiteralText(operand) || ts.isTemplateExpression(operand) || approved(operand)) return;
  const { line } = source.getLineAndCharacterOfPosition(operand.getStart(source));
  violations.push({
    file,
    line: line + 1,
    start: operand.getStart(source),
    end: operand.getEnd(),
    expression: operand.getText(source),
    reason: `raw value ${verb} an emitted command — render it with commandToken()`,
    snippet: operand.getText(source).replace(/\s+/g, " ").slice(0, 160),
  });
}

/** The literal text a `+` operand ENDS with, so a re-wrap can be seen across the operator. */
function trailingLiteralText(operand: ts.Expression | undefined): string {
  if (!operand) return "";
  if (ts.isStringLiteral(operand) || ts.isNoSubstitutionTemplateLiteral(operand)) return operand.text;
  if (ts.isTemplateExpression(operand)) {
    const last = operand.templateSpans[operand.templateSpans.length - 1];
    return last ? last.literal.text : operand.head.text;
  }
  return "";
}

/** The literal text a `+` operand BEGINS with. */
function leadingLiteralText(operand: ts.Expression | undefined): string {
  if (!operand) return "";
  if (ts.isStringLiteral(operand) || ts.isNoSubstitutionTemplateLiteral(operand)) return operand.text;
  if (ts.isTemplateExpression(operand)) return operand.head.text;
  return "";
}

/** Whether a source file IS one of the rendering-authority modules — by identity, not by name. */
function isAuthorityModule(source: ts.SourceFile): boolean {
  try {
    return AUTHORITY_PATHS.has(canonicalPath(realpathSync(source.fileName)));
  } catch {
    return AUTHORITY_PATHS.has(canonicalPath(source.fileName));
  }
}

/** A string literal, or a template with no substitutions: text present in the source, not a value. */
function isLiteralText(node: ts.Expression): boolean {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Type-check `packages/cli/src` and report every command-shaped template literal interpolation that
 * did not come from the quoting authority. `srcDir` is the directory to scan; `tsconfigPath` supplies
 * the same compiler options the package builds with, so the branded type resolves identically.
 */
export function scanEmittedCommandQuoting(srcDir: string, tsconfigPath: string): QuotingScan {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, join(tsconfigPath, ".."));
  const files = sourceFiles(srcDir);
  const program = ts.createProgram(files, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const violations: QuotingViolation[] = [];
  const scanned: string[] = [];

  /**
   * Inert BY TYPE, with no rendering step needed. Two cases, both proven by the compiler rather than
   * asserted by an allowlist:
   *   • a number/bigint/boolean/null/undefined cannot contain a shell metacharacter at all;
   *   • a string LITERAL type (or a union of them) has a value set the compiler enumerates, so a
   *     CLI-owned enum such as `"project" | "user"` is safe without a per-site exception — while a
   *     widened `string` never qualifies, however constant it looks at the call site.
   */
  const inertByType = (t: ts.Type): boolean => {
    const flags = t.getFlags();
    if (flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike
      | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return true;
    if (t.isStringLiteral()) return t.value === "" || INERT_LITERAL.test(t.value);
    return false;
  };

  /**
   * The authority's exported SYMBOLS, indexed by the name each was exported under. Built from the
   * real module symbols, so membership below is decided by symbol identity — the map key is an
   * index for looking a rule's own literal up, never a comparison against anything in the scanned
   * source.
   */
  const authorityExports = new Map<ts.Symbol, string>();
  for (const authorityPath of AUTHORITY_PATHS) {
    const authoritySource = program.getSourceFile(authorityPath);
    const moduleSymbol = authoritySource && checker.getSymbolAtLocation(authoritySource);
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const resolved = exported.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exported)
        : exported;
      authorityExports.set(resolved, exported.getName());
    }
  }

  /**
   * The ONE identity helper every rule below uses: which of the authority's exports, if any, does
   * this reference actually resolve to?
   *
   * No rule anywhere in this file compares a name or a piece of source text against the scanned
   * program. FOUR separate findings in this change came from doing so — an import alias hid
   * `commandLiteral`, a local `const` binding hid it again, a type alias hid the brand cast, and a
   * basename made any file called `command-text.ts` an authority — because a name in the source is
   * not the thing it names. This follows import aliases, namespace imports, re-export chains and
   * one-hop `const` bindings to a symbol, then asks whether that symbol IS one the authority
   * exports.
   */
  const calleeExportName = (node: ts.Node): string | undefined => {
    let symbol = checker.getSymbolAtLocation(node);
    for (let hop = 0; symbol && hop < 8; hop += 1) {
      if (symbol.flags & ts.SymbolFlags.Alias) {
        symbol = checker.getAliasedSymbol(symbol);
        continue;
      }
      const known = authorityExports.get(symbol);
      if (known !== undefined) return known;
      // `const local = commandLiteral;` — the symbol is the VARIABLE, so follow its initializer.
      const initializer = (symbol.declarations ?? [])
        .filter(ts.isVariableDeclaration)
        .map((d) => d.initializer)
        .find((value): value is ts.Expression => value !== undefined);
      if (!initializer) return undefined;
      symbol = checker.getSymbolAtLocation(initializer);
    }
    return undefined;
  };

  const resolvesToAuthorityExport = (node: ts.Node, exportName: string): boolean =>
    calleeExportName(node) === exportName;


  const carriesBrand = (t: ts.Type): boolean =>
    t.getProperties().some((property) => property.getName().includes("commandTextBrand"));

  /** Only the CLI invocation prefix OPENS a runnable span (see CommandPrefix in command-text.ts). */
  const carriesPrefixBrand = (t: ts.Type): boolean =>
    t.getProperties().some((property) => property.getName().includes("commandPrefixBrand"));

  /** Carries either brand — i.e. this expression IS rendered command text. */
  const carriesBrandAt = (node: ts.Expression): boolean => {
    const type = checker.getTypeAtLocation(node);
    return type.isUnion() ? type.types.every(carriesBrand) : carriesBrand(type);
  };

  const opensCommand = (node: ts.Expression): boolean => {
    const type = checker.getTypeAtLocation(node);
    return type.isUnion() ? type.types.every(carriesPrefixBrand) : carriesPrefixBrand(type);
  };

  const isCommandText = (node: ts.Expression): boolean => {
    const type = checker.getTypeAtLocation(node);
    // The brand is a unique-symbol property, so a plain `string` never carries it and no cast-free
    // expression can fake it. Union members must all qualify (a `CommandText | string` is unsafe).
    const approved = (t: ts.Type): boolean => carriesBrand(t) || inertByType(t);
    return type.isUnion() ? type.types.every(approved) : approved(type);
  };

  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    // POSIX-shaped: `relative` yields native separators, so a violation reported on Windows
    // would otherwise be `nested\\command-text.ts` and no cross-platform assertion could match it.
    const relativePath = toPosixPath(relative(srcDir, file));
    // command-text.ts owns the primitives and is the one place raw values are legitimately handled.
    // Only the module that assembles tokens OUT OF raw values is skipped wholesale. The other
    // authority modules stay scanned; they merely get the cast exemption below.
    if (sameFile(source.fileName, TOKEN_ASSEMBLY_PATH)) continue;
    scanned.push(relativePath);

    const visit = (node: ts.Node): void => {
      // A template that is ITSELF an argument to a renderer is quoted as a whole (see the
      // "assembled argument" note in src/command-text.ts) — its pieces are not separate arguments.
      const renderedWhole =
        node.parent !== undefined &&
        ts.isCallExpression(node.parent) &&
        node.parent.arguments[0] === node &&
        RENDERERS.has(calleeExportName(node.parent.expression) ?? "");
      if (ts.isTemplateExpression(node) && !renderedWhole) {
        const spans = node.templateSpans;
        const before = (index: number): string =>
          index === 0 ? node.head.text : spans[index - 1]!.literal.text;
        const after = (index: number): string => spans[index]!.literal.text;

        // An ARGUMENT POSITION independent of any surrounding command: the value is being written
        // as a flag, as a flag's value, or inside the double-quote idiom that reads as quoting and
        // is not. This is what makes `--type ${bundleValue}` fail in a brand-new helper that never
        // mentions the CLI at all.
        // The double-quote half applies only INSIDE a runnable span: `"${label}"` in an ordinary
        // diagnostic is English quoting an identifier, while the same bytes after `superbee kind
        // field ` are an argument that merely LOOKS quoted.
        const argumentPosition = (index: number, insideCommand: boolean): boolean =>
          FLAG_ADJACENT.test(before(index)) ||
          (insideCommand && OPENS_QUOTE.test(before(index)) && CLOSES_QUOTE.test(after(index)));

        const snippet = node.getText(source).replace(/\s+/g, " ").slice(0, 160);
        // Walk the literal left to right tracking whether we are INSIDE the runnable span a command
        // opened. Interpolations outside it are English about the command, not arguments to it, and
        // quoting them would only make diagnostics unreadable — see "THE PROSE / COMMAND LINE" in
        // src/command-text.ts. Modelling the span structurally means there is no per-site "this one
        // is prose" marker to be misused.
        let insideCommand = false;
        // `--${field} ${placeholder}`: the flag NAME is itself interpolated, so the chunk before the
        // VALUE is bare whitespace and the flag-adjacency pattern cannot see it. Carry the position
        // forward one span instead — this is exactly the shape a completing `doc update` command
        // builds, and the enum values it renders are bundle-authored.
        let previousWasFlagName = false;
        spans.forEach((span, index) => {
          if (COMMAND_TERMINATOR.test(before(index))) insideCommand = false;
          const carriedFlagValue = previousWasFlagName && /^[ =]["']?$/.test(before(index));
          previousWasFlagName = /(?:^|\s)--$/.test(before(index));
          const mustRender =
            insideCommand || carriedFlagValue || argumentPosition(index, insideCommand);
          // A RENDERED token (branded — not merely a compile-time-literal value, which is just
          // English being quoted) already carries whatever quoting it needs, and `commandToken`
          // quotes only NON-inert values — so wrapping one in the sentence's own quotes yields `covers`
          // for an ordinary value but `''runs on''` for a multi-word one, which pastes as two
          // arguments. There is no case where re-wrapping a rendered token is correct.
          if (
            carriesBrandAt(span.expression) &&
            /["']$/.test(before(index)) &&
            /^["']/.test(after(index))
          ) {
            const { line } = source.getLineAndCharacterOfPosition(span.expression.getStart(source));
            violations.push({
              file: relativePath,
              line: line + 1,
              start: span.expression.getStart(source),
              end: span.expression.getEnd(),
              expression: span.expression.getText(source),
              reason: "a rendered token is wrapped in quotes again — drop the surrounding quotes, the renderer owns them",
              snippet,
            });
          }
          if (mustRender && !isCommandText(span.expression)) {
            const { line } = source.getLineAndCharacterOfPosition(span.expression.getStart(source));
            violations.push({
              file: relativePath,
              line: line + 1,
              start: span.expression.getStart(source),
              end: span.expression.getEnd(),
              expression: span.expression.getText(source),
              reason: carriedFlagValue || argumentPosition(index, insideCommand)
                ? "unquoted value in an argument position — render it with commandToken()"
                : "raw value inside an emitted command — render it with commandToken()",
              snippet,
            });
          }
          // ONLY the invocation prefix opens a runnable span. A rendered value elsewhere — say the
          // `--out <path>` a warning quotes back — leaves the rest of the sentence prose.
          if (opensCommand(span.expression)) insideCommand = true;
        });
      }
      // A command assembled with `+` or `Array#join` never becomes a TemplateExpression, so
      // the walk above cannot see it. The codebase already mixes templates with `+`, which makes
      // `+ value` the natural next step for a contributor; both shapes are checked here.
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
          && !(node.parent !== undefined && ts.isBinaryExpression(node.parent)
               && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
        const operands: ts.Expression[] = [];
        const flatten = (expression: ts.Expression): void => {
          if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            flatten(expression.left);
            flatten(expression.right);
            return;
          }
          operands.push(expression);
        };
        flatten(node);
        if (operands.some((operand) => carriesBrandAt(operand))) {
          for (const operand of operands) reportUnrenderedOperand(operand, relativePath, source, violations, "concatenated into", isCommandText);
          // The re-wrap guard has to see ACROSS the operator too: moving one quote out of the
          // template and onto the other side of a `+` produced exactly the `''runs on''` defect
          // this rule exists to prevent, with every operand individually well-formed.
          operands.forEach((operand, index) => {
            if (!carriesBrandAt(operand)) return;
            const opens = trailingLiteralText(operands[index - 1]).slice(-1);
            const closes = leadingLiteralText(operands[index + 1]).slice(0, 1);
            if (opens && opens === closes && /["']/.test(opens)) {
              const { line } = source.getLineAndCharacterOfPosition(operand.getStart(source));
              violations.push({
                file: relativePath,
                line: line + 1,
                start: operand.getStart(source),
                end: operand.getEnd(),
                expression: operand.getText(source),
                reason: "a rendered token is wrapped in quotes again — drop the surrounding quotes, the renderer owns them",
                snippet: node.getText(source).replace(/\s+/g, " ").slice(0, 160),
              });
            }
          });
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "join" &&
        ts.isArrayLiteralExpression(node.expression.expression) &&
        node.expression.expression.elements.some((element) => carriesBrandAt(element))
      ) {
        for (const element of node.expression.expression.elements) {
          reportUnrenderedOperand(element, relativePath, source, violations, "joined into", isCommandText);
        }
      }
      // `commandLiteral` renders verbatim, so its contract — CLI-authored text only — is checked
      // rather than trusted. A runtime value passed here would reopen the class in one line.
      if (
        ts.isCallExpression(node) &&
        resolvesToAuthorityExport(node.expression, "commandLiteral") &&
        !(node.arguments.length === 1 && isLiteralText(node.arguments[0]!))
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push({
          file: relativePath,
          line: line + 1,
          start: node.getStart(source),
          end: node.getEnd(),
          expression: node.getText(source),
          reason: "commandLiteral() requires a literal argument — render a runtime value with commandToken()",
          snippet: node.getText(source).replace(/\s+/g, " ").slice(0, 160),
        });
      }
      // `shellArg` THROWS on Windows for a value that has no inert rendering; only `commandToken`
      // and `commandQuoted` absorb that. A direct call therefore turns a diagnostic into an
      // unhandled stack trace on one platform, so it is banned outside the authority modules — use
      // `commandQuoted` (always-quote) or `commandToken`. Resolved by DECLARATION IDENTITY, so an
      // alias or a same-named export elsewhere neither evades nor false-positives.
      if (
        ts.isCallExpression(node) &&
        resolvesToAuthorityExport(node.expression, "shellArg") &&
        !isAuthorityModule(source)
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push({
          file: relativePath,
          line: line + 1,
          start: node.getStart(source),
          end: node.getEnd(),
          expression: node.getText(source),
          reason: "shellArg() outside the quoting authority throws on Windows — use commandQuoted() (always-quote) or commandToken()",
          snippet: node.getText(source).replace(/\s+/g, " ").slice(0, 160),
        });
      }
      // `as CommandText` is the one expression that mints branded text from a raw string, so
      // it stays inside the modules that own rendering. Elsewhere it is how a contributor copying
      // local style lands a raw value in a rendering position with the type checker satisfied.
      if (
        (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
        // Decided by the ASSERTED TYPE'S BRAND, never by how the type was spelled. Resolving a name
        // caught exactly one spelling: `as CT`, `as LocalAlias`, a re-exported alias and — the one
        // that matters — `as ct.CommandText` after a namespace import all slipped through, and that
        // last form is the ORDINARY way to write the cast, so it was an accidental path rather than
        // a deliberate evasion.
        carriesBrand(checker.getTypeFromTypeNode(node.type)) &&
        !isAuthorityModule(source)
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push({
          file: relativePath,
          line: line + 1,
          start: node.getStart(source),
          end: node.getEnd(),
          expression: node.getText(source),
          reason: "casting to CommandText outside the quoting authority — build the value with commandFragment() or commandToken()",
          snippet: node.getText(source).replace(/\s+/g, " ").slice(0, 160),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { violations, scanned: scanned.sort() };
}

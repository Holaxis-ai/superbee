import { parseArgs } from "node:util";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { CliError } from "../errors.js";
import { validateRecipeForAuthor } from "../integration-author/validate.js";
import { render, renderUsage, resolveMode } from "../output.js";

export const RECIPE_VALIDATE_USAGE = `superbee recipe validate — validate a local integration recipe without installing or executing it

Usage:
  superbee recipe validate <path> [--readme] [--json]

Checks the complete local recipe folder, its Kinds, Connector mappings, pins and available source
metadata. Built-in profile specs are checked; registered plugin spec checks are deferred to source
test/bind/run. Prints file/JSON-pointer diagnostics and source method/path/host summaries. No bundle,
account, credential, module import, installation or provider request is used. Unknown profiles
are refused; --profile is available only on the explicitly executable source test command.

Options:
  --readme   Include an author README template with permissions, resources and support blanks
  --json     Compact JSON instead of TOON
  -h, --help Show this help
`;

export async function recipeValidate(argv: string[], deps: { stdout?: (text: string) => void } = {}): Promise<void> {
  const stdout = deps.stdout ?? ((text: string) => void process.stdout.write(text));
  const parsed = parseLeafOrUsage(() => parseArgs({ args: argv, allowPositionals: true, strict: true,
    options: { readme: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } } }), CLI_LEAVES.recipeValidate);
  if (parsed.values.help) { stdout(renderUsage(RECIPE_VALIDATE_USAGE)); return; }
  const report = await validateRecipeForAuthor(parsed.positionals[0]!, { readme: parsed.values.readme });
  stdout(render(report, resolveMode(parsed.values)));
  if (!report.ok) throw new CliError("USAGE", "Recipe validation failed; inspect its diagnostic locations.", { handled: true });
}

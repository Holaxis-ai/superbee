import { parseArgs } from "node:util";
import { parseLeafOrUsage } from "../args.js";
import { CLI_LEAVES } from "../command-spec.js";
import { asHandled, CliError, toEnvelope } from "../errors.js";
import { MCP_APP_INSTALL } from "../integration-guidance.js";
import { renderErrorEnvelope, renderUsage } from "../output.js";

export async function mcp(argv: string[]): Promise<void> {
  const message = `${MCP_APP_INSTALL.description}
${MCP_APP_INSTALL.guide}`;
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(renderUsage(message));
    return;
  }
  try {
    if (!["install", "status", "uninstall"].includes(argv[0] ?? "")) {
      parseLeafOrUsage(() => parseArgs({
        args: argv,
        allowPositionals: true,
      }), CLI_LEAVES.mcp);
    }
    throw new CliError("USAGE", "The local MCP app is installed separately");
  } catch (error) {
    // Old clients still start this command over stdio. Keep stdout free of error text.
    const handled = asHandled(error);
    const { error: diagnostic } = toEnvelope(handled);
    process.stderr.write(renderErrorEnvelope({ error: { ...diagnostic, help: MCP_APP_INSTALL.guide } }));
    throw handled;
  }
}

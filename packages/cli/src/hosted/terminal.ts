// The person's terminal, for the few steps an agent must not take alone: accepting a held mass
// delete (`sync --accept-deletes`) and retiring a hosted bundle (`bundle retire`). Each asks the
// person to type a confirmation, and refuses a shell no person can answer in, telling the agent to
// hand the exact command to the person.
import { createInterface } from "node:readline/promises";

import { CliError } from "../errors.js";

/**
 * Where a person can confirm, by typing, what an agent must not decide alone. The check keeps a
 * person in the loop on the ordinary agent path (an agent's shell has no terminal); it is not a
 * security boundary. Known ways past it: a pseudo-terminal wrapper (`script`, `expect`, a pty
 * module), typing into a person's terminal (`tmux send-keys`), and importing the CLI with another
 * `HostedTerminal`. The refusal and the skill text make each of these an explicit violation.
 */
export interface HostedTerminal {
  /** True only when a person can answer here: standard input and standard error are both a terminal. */
  readonly interactive: boolean;
  /** Show `prompt` (on standard error, so standard output stays the receipt) and read one typed line. */
  ask(prompt: string): Promise<string>;
}

export function processTerminal(): HostedTerminal {
  return {
    interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
    async ask(prompt) {
      const reader = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      try {
        return await reader.question(prompt);
      } finally {
        reader.close();
      }
    },
  };
}

/**
 * The refusal for a step only a person at a terminal may confirm, in a shell where none can:
 * FORBIDDEN, `needs_person_at_terminal`, and help naming the exact command for the person. The
 * caller's details (an `agent_instruction` and the `command_for_person` among them) follow the reason.
 */
export function needsPersonAtTerminal(message: string, command: string, details: Readonly<Record<string, unknown>>): CliError {
  return new CliError("FORBIDDEN", message, {
    details: { reason: "needs_person_at_terminal", ...details },
    help: `ask the person to run in their own terminal: ${command}`,
  });
}

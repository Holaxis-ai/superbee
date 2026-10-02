// A person at a terminal, for the typed confirmation `sync --accept-deletes` asks for. The prompts
// it was shown are kept, so a test can check what the person was asked.
import type { HostedTerminal } from "../../src/hosted/sync.js";

export interface FakeTerminal extends HostedTerminal {
  readonly prompts: string[];
}

/** A terminal whose person types `answer(prompt)`; by default the count the prompt asks for. */
export function personAtTerminal(answer: (prompt: string) => string = typedCount): FakeTerminal {
  const prompts: string[] = [];
  return {
    interactive: true,
    prompts,
    async ask(prompt) {
      prompts.push(prompt);
      return answer(prompt);
    },
  };
}

/** No person: an agent's shell, a pipe or a hook. Asking it anything fails the test. */
export function noTerminal(): FakeTerminal {
  return {
    interactive: false,
    prompts: [],
    async ask() {
      throw new Error("a shell without a terminal must never be asked to confirm");
    },
  };
}

/** What a person types to confirm: the count the prompt names. */
export function typedCount(prompt: string): string {
  const match = /Type (\d+) to remove them/.exec(prompt);
  if (!match) throw new Error(`not a deletion confirmation prompt: ${prompt}`);
  return `${match[1]}\n`;
}

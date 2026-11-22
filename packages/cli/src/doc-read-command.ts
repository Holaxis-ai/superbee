import { commandLiteral, commandToken, joinCommandTokens, type CommandPrefix, type CommandText } from "./command-text.js";

interface ReadPage {
  offset: number;
  expectedVersion?: string;
}

// The caller supplies the board path it has at this point: the original argument or a verified root.
export function docReadCommand(
  invocation: CommandPrefix,
  id: string | undefined,
  boardDir?: string,
  page?: ReadPage,
): CommandText {
  const args: CommandText[] = [invocation, commandLiteral("doc read"), id === undefined ? commandLiteral("<id>") : commandToken(id)];
  if (page) {
    args.push(commandLiteral("--offset"), commandToken(String(page.offset)));
    if (page.expectedVersion !== undefined) args.push(commandLiteral("--expected-version"), commandToken(page.expectedVersion));
  }
  if (boardDir !== undefined) args.push(commandLiteral("--dir"), commandToken(boardDir));
  if (page || boardDir !== undefined) args.push(commandLiteral("--json"));
  return joinCommandTokens(args);
}

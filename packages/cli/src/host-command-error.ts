export class HostCommandError extends Error {
  readonly state: "absent" | "unreadable";
  constructor(state: "absent" | "unreadable", message: string) {
    super(message);
    this.name = "HostCommandError";
    this.state = state;
  }
}

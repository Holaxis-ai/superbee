// The installed CLI checks out a synthetic hosted bundle through its normal entry point.
import { FakeHost, TOKEN } from "../../packages/cli/test/support/fake-hosted-sync.ts";

globalThis.fetch = new FakeHost().fetch;
process.env.SUPERBEE_ACCESS_TOKEN = TOKEN;

/**
 * The Node side of the Chromium harness, shared by the browser specs: the page driver
 * (`driver.ts`) is bundled with esbuild and served by a node:http server on 127.0.0.1, so every
 * page in every context shares one origin and therefore one IndexedDB, and each driver call is
 * one `page.evaluate` whose reply is plain JSON, errors included.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, type Page } from "@playwright/test";
import { build } from "esbuild";

import type { Driver, DriverError } from "./driver.ts";

export interface DriverServer {
  origin: string;
  close(): Promise<void>;
}

export interface DriverServerOptions {
  /** The page script to bundle and serve; the proof driver by default. */
  entry?: URL;
  /**
   * Extra response headers on the page and its script, for a driver that needs a document
   * policy the proof driver does not (the measurement driver asks for cross-origin isolation
   * so `performance.now()` keeps its 5 us resolution). None by default.
   */
  headers?: Record<string, string>;
}

export async function startDriverServer(options: DriverServerOptions = {}): Promise<DriverServer> {
  const bundle = await build({
    entryPoints: [(options.entry ?? new URL("./driver.ts", import.meta.url)).pathname],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: false,
    sourcemap: false,
    write: false,
    logLevel: "silent",
  });
  const script = bundle.outputFiles?.[0]?.text;
  if (!script) throw new Error("browser-local driver build produced no JavaScript.");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>browser-local</title></head><body><script src="/driver.js"></script></body></html>`;
  const extra = options.headers ?? {};
  const server: Server = createServer((request, response) => {
    if (request.url === "/driver.js") {
      response.writeHead(200, { ...extra, "content-type": "text/javascript; charset=utf-8" });
      response.end(script);
      return;
    }
    if (request.url === "/") {
      response.writeHead(200, { ...extra, "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

export async function load(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  await waitForDriver(page);
}

/** After a reload: the driver script has run and installed itself on `window`. */
export async function waitForDriver(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => typeof window.superbeeLocal === "object")).toBe(true);
}

export type DriverMethod = keyof Driver;
export type Reply<M extends DriverMethod> = Awaited<ReturnType<Driver[M]>>;

/** Invoke one driver method in the page; every reply is JSON, errors included. */
export function call<M extends DriverMethod>(page: Page, method: M, ...args: Parameters<Driver[M]>): Promise<Reply<M>> {
  return page.evaluate(
    ([name, params]) => (window.superbeeLocal[name as DriverMethod] as (...inner: unknown[]) => unknown)(...(params as unknown[])),
    [method, args] as const,
  ) as Promise<Reply<M>>;
}

export function ok<T>(reply: T | DriverError, label: string): T {
  if (reply && typeof reply === "object" && "error" in reply) {
    const { error } = reply as DriverError;
    throw new Error(`${label}: ${error.name}: ${error.message}`);
  }
  return reply as T;
}

export function isDriverError(reply: unknown): reply is DriverError {
  return typeof reply === "object" && reply !== null && "error" in reply;
}

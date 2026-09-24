import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { authenticateDeveloperRequest, validateDeveloperToken } from "./auth.js";
import type { AddressConsoleApplication } from "./application.js";

export interface AddressRadarConsoleOptions {
  readonly application: AddressConsoleApplication;
  readonly developerToken?: string;
  readonly host?: string;
  readonly port?: number;
}

export interface AddressRadarConsoleServer {
  readonly url: string;
  close(): Promise<void>;
}

const publicDirectory = resolve(process.cwd(), "apps/console/public");
const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

const respondJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { ...securityHeaders, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("request_body_too_large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

export const startAddressRadarConsole = async (options: AddressRadarConsoleOptions): Promise<AddressRadarConsoleServer> => {
  const host = options.host ?? "127.0.0.1";
  const developerToken = options.developerToken?.trim();
  if (developerToken) validateDeveloperToken(developerToken);
  if (!developerToken && host !== "127.0.0.1" && host !== "::1" && host !== "localhost") throw new Error("Unauthenticated developer console must bind to loopback");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
      if (url.pathname === "/health") {
        respondJson(response, 200, { status: "ok" });
        return;
      }

      if (url.pathname.startsWith("/api/v1/")) {
        if (developerToken && !authenticateDeveloperRequest(request.headers.authorization, developerToken)) {
          respondJson(response, 401, { error: "unauthorized" });
          return;
        }
        if (url.pathname === "/api/v1/events/stream" && request.method === "GET") {
          response.writeHead(200, { ...securityHeaders, "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive" });
          response.write("event: ready\ndata: {}\n\n");
          const unsubscribe = options.application.subscribe(event => response.write(`event: update\ndata: ${JSON.stringify(event)}\n\n`));
          request.once("close", unsubscribe);
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(request);
        } catch (error) {
          respondJson(response, error instanceof SyntaxError ? 400 : 413, { error: error instanceof SyntaxError ? "invalid_json" : "request_body_too_large" });
          return;
        }
        const result = options.application.handle(request.method ?? "GET", url.pathname, body);
        respondJson(response, result.status, result.body);
        return;
      }

      const assets: Record<string, { file: string; type: string }> = {
        "/": { file: "index.html", type: "text/html; charset=utf-8" },
        "/app.ts": { file: "app.ts", type: "text/javascript; charset=utf-8" },
        "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
      };
      const asset = assets[url.pathname];
      if (!asset) {
        respondJson(response, 404, { error: "not_found" });
        return;
      }
      const content = await readFile(resolve(publicDirectory, asset.file));
      response.writeHead(200, { ...securityHeaders, "content-type": asset.type });
      response.end(content);
    } catch (error) {
      respondJson(response, 500, { error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 3211, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Address radar console failed to bind");

  return {
    url: `http://${host}:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      options.application.close();
    },
  };
};

import { promises as fs } from "node:fs";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tomlMcpServersConfig } from "../src/codex-runner.js";
import { gatewayReasoningLevelConfigs } from "../src/gateway-reasoning-levels.js";
import { resolveExplainerReasoning } from "../src/explainer-reasoning.js";
import { preparePiSettings } from "../src/harness-runtime/adapters/pi-adapter.js";
import { normalizeHarnessRuntimeError, proxyFailureError } from "../src/harness-runtime/errors.js";
import { harnessPackageMetadata } from "../src/harness-runtime/installations.js";
import { startProtocolProxy } from "../src/protocol-router.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

// These fixtures never launch a Harness or contact a model service.
describe("offline runtime compatibility", () => {
  it.each([
    ["@earendil-works/pi-coding-agent", "1.6.0", "$SCIENCEEVOLVE_GATEWAY_API_KEY"],
    ["@mariozechner/pi-coding-agent", "0.62.0", "SCIENCEEVOLVE_GATEWAY_API_KEY"]
  ])("identifies %s and writes its credential reference", async (name, version, reference) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-pi-"));
    roots.push(root);
    const packageRoot = path.join(root, "工具 with spaces", "node_modules", ...name!.split("/"));
    const executable = path.join(packageRoot, "dist", "bundle", "cli.js");
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, "// fixture only");
    await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name, version }));
    expect(await harnessPackageMetadata("pi", executable)).toEqual({ packageName: name, version });
    const home = path.join(root, "isolated-home");
    await preparePiSettings(home, "http://127.0.0.1:9/v1", "fixture", 8192, executable);
    const models = JSON.parse(await fs.readFile(path.join(home, "models.json"), "utf8"));
    expect(models.providers.openfars.apiKey).toBe(reference);
  });

  it("reads global npm shim metadata and leaves missing versions unknown", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-shim-"));
    roots.push(root);
    const executable = path.join(root, "pi.cmd");
    await fs.writeFile(executable, "@rem fixture only");
    expect(await harnessPackageMetadata("pi", executable)).toEqual({});
    const directory = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-coding-agent", version: "1.6.0"
    }));
    expect(await harnessPackageMetadata("pi", executable)).toMatchObject({ version: "1.6.0" });
  });

  it.each(["low", "medium", "high", "xhigh", "max"])("sends explicit %s instead of the gateway default", level => {
    const configs = gatewayReasoningLevelConfigs(["fixture"], "responses");
    const selected = resolveExplainerReasoning(configs, "fixture", "responses", level);
    expect(selected).toMatchObject({ optionId: level, value: level, parameter: "reasoning.effort" });
    expect(resolveExplainerReasoning(undefined, "fixture", "chat-completions", level))
      .toMatchObject({ optionId: level, value: level, parameter: "reasoning_effort" });
  });

  it("reads the standalone Codex manifest only when it identifies the selected executable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-codex-standalone-"));
    roots.push(root);
    const directory = path.join(root, "Codex 独立安装 with spaces");
    const executable = path.join(directory, "bin", "codex.exe");
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, "fixture binary; never executed");
    const manifestPath = path.join(directory, "codex-package.json");
    const manifest = { layoutVersion: 1, variant: "codex", version: "0.171.0", entrypoint: "bin/codex.exe" };
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    expect(await harnessPackageMetadata("codex", executable)).toEqual({ version: "0.171.0" });
    expect(await harnessPackageMetadata("pi", executable)).toEqual({});
    await fs.writeFile(path.join(directory, "bin", "other.exe"), "another fixture binary");
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, entrypoint: "bin/other.exe" }));
    expect(await harnessPackageMetadata("codex", executable)).toEqual({});
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, version: "" }));
    expect(await harnessPackageMetadata("codex", executable)).toEqual({});
    await fs.writeFile(manifestPath, "{invalid-json");
    expect(await harnessPackageMetadata("codex", executable)).toEqual({});
  });

  it("keeps npm Codex version detection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-codex-npm-"));
    roots.push(root);
    const directory = path.join(root, "node_modules", "@openai", "codex");
    const executable = path.join(directory, "bin", "codex.js");
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, "// fixture only");
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.171.0" }));
    expect(await harnessPackageMetadata("codex", executable)).toEqual({ packageName: "@openai/codex", version: "0.171.0" });
  });

  it("keeps custom provider values and rejects an unsupported explicit choice", () => {
    const configs = { fixture: { parameter: "thinking.effort" as const,
      defaultOptionId: "high", options: [{ id: "high", label: "High", value: "provider-high" }] } };
    expect(resolveExplainerReasoning(configs, "fixture", "responses"))
      .toMatchObject({ optionId: "high", value: "provider-high", parameter: "thinking.effort" });
    expect(() => resolveExplainerReasoning(configs, "fixture", "responses", "max")).toThrow("max");
    expect(resolveExplainerReasoning(undefined, "fixture", "responses")).toMatchObject({ optionId: "max" });
  });

  it("makes draft tools required and visible in the actual Codex MCP config", () => {
    const url = `http://127.0.0.1:43199/mcp/${"a".repeat(48)}`;
    const config = parse(tomlMcpServersConfig([{ name: "openfars-project-explainer", url }]));
    const servers = config.mcp_servers as Record<string, Record<string, unknown>>;
    expect(servers["openfars-project-explainer"]).toMatchObject({
      url, required: true, omit_tools_from: ["deferred", "code_mode"]
    });
  });

  it.each(["GET", "POST"])("classifies %s local proxy 401 without forwarding to the gateway", async method => {
    const upstream = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Outbound requests are forbidden in this fixture"));
    const proxy = await startProtocolProxy({
      sourceProtocol: "chat-completions", targetProtocol: "responses",
      gatewayUrl: "https://fixture.invalid/v1", gatewayApiKey: "upstream-fixture-secret", force: true
    });
    try {
      const url = `${proxy.baseUrl}/${method === "GET" ? "models" : "chat/completions"}`;
      const response = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
        const request = httpRequest(url, { method, headers: { Authorization: "Bearer wrong-fixture-token" } }, incoming => {
          let body = "";
          incoming.setEncoding("utf8");
          incoming.on("data", chunk => { body += chunk; });
          incoming.on("end", () => resolve({ status: incoming.statusCode, body }));
        });
        request.on("error", reject);
        request.end();
      });
      expect(response.status).toBe(401);
      expect(upstream).not.toHaveBeenCalled();
      expect(response.body).not.toContain("upstream-fixture-secret");
      expect(response.body).not.toContain(proxy.token);
      const failure = proxy.getFailure!()!;
      expect(failure).toMatchObject({ code: "PROTOCOL_PROXY_AUTHENTICATION_FAILED", httpStatus: 401 });
      expect(proxyFailureError(failure, "pi")).toMatchObject({
        source: "adapter", retryable: false, code: "PROTOCOL_PROXY_AUTHENTICATION_FAILED"
      });
      proxy.resetFailure!();
      expect(proxy.getFailure!()).toBeUndefined();
    } finally { await proxy.close(); }
  });

  it("keeps legacy local credential failures separate from upstream authentication", () => {
    const failure = normalizeHarnessRuntimeError(new Error('401: {"message":"protocol proxy credential is invalid"}'), "pi");
    expect(failure).toMatchObject({ code: "PROTOCOL_PROXY_AUTHENTICATION_FAILED", source: "adapter", retryable: false });
    expect(failure.message).toContain("尚未转发至网关");
    expect(proxyFailureError({
      code: "MODEL_AUTHENTICATION_FAILED", httpStatus: 401, message: "Upstream credential rejected",
      sourceProtocol: "chat-completions", targetProtocol: "responses", model: "fixture"
    }, "pi")).toMatchObject({ code: "MODEL_AUTHENTICATION_FAILED", source: "gateway" });
  });
});

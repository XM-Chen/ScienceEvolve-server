import type { AgentProtocol } from "./agent-runtime.js";
import { gatewayReasoningLevelConfig } from "./gateway-reasoning-levels.js";
import { resolveGatewayReasoning, type GatewayModelReasoningConfigs } from "./gateway-reasoning.js";

/** An explicit assistant choice wins; older snapshots use the standard levels. */
export function resolveExplainerReasoning(
  configs: GatewayModelReasoningConfigs | undefined,
  model: string,
  protocol: AgentProtocol,
  effort?: string
) {
  const config = configs?.[model] ?? gatewayReasoningLevelConfig(protocol);
  return resolveGatewayReasoning(
    { [model]: config },
    model,
    effort?.trim() || config.defaultOptionId
  );
}

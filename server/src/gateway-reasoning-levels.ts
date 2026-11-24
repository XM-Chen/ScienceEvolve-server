import type {
  GatewayModelReasoningConfig,
  GatewayModelReasoningConfigs,
  GatewayReasoningParameterPath
} from "./gateway-reasoning.js";

type GatewayProtocol = "responses" | "chat-completions" | "anthropic-messages";

export const GATEWAY_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export function gatewayReasoningLevelConfig(
  protocol: GatewayProtocol,
  level = "max",
  parameter?: GatewayReasoningParameterPath
): GatewayModelReasoningConfig {
  return {
    parameter: parameter ?? (protocol === "responses"
      ? "reasoning.effort"
      : protocol === "anthropic-messages" ? "output_config.effort" : "reasoning_effort"),
    options: GATEWAY_REASONING_LEVELS.map(value => ({ id: value, label: value, value })),
    defaultOptionId: GATEWAY_REASONING_LEVELS.some(value => value === level) ? level : "max"
  };
}

export function gatewayReasoningLevelConfigs(
  models: readonly string[],
  protocol: GatewayProtocol,
  current: GatewayModelReasoningConfigs = {}
): GatewayModelReasoningConfigs {
  return Object.fromEntries(models.map(model => [
    model,
    gatewayReasoningLevelConfig(protocol, current[model]?.defaultOptionId, current[model]?.parameter)
  ]));
}

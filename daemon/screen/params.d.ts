export interface ScreenParams {
  port: number;
  token: string;
  password: string;
}

export const READY_MESSAGE: "hive-screen-ready";

export function screenParams(hash: string): ScreenParams | null;

export function screenParamsFrom(message: unknown): ScreenParams | null;

export function socketUrl(params: ScreenParams): string;

export type OpenerMessage = { kind: "ignore" } | { kind: "invalid" } | { kind: "secrets"; params: ScreenParams };

export function openerMessage(event: { origin: string; source: unknown; data: unknown }, origin: string, opener: unknown): OpenerMessage;

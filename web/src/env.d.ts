declare module "*.css";

interface Window {
  webkit?: { messageHandlers?: { hiveToken?: { postMessage(message: unknown): Promise<unknown> } } };
}

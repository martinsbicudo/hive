import type { EngineSetup } from "./engineSetup.ts";
import { SetupError, SetupRefused } from "./engineSetupPins.ts";
import { setupRequestSchema } from "./engineSetupStatus.ts";
import { HttpError } from "./httpError.ts";

export interface Reply {
  status: number;
  body: unknown;
}

function refused(error: unknown): unknown {
  return error instanceof SetupRefused || error instanceof SetupError ? new HttpError(409, error.message) : error;
}

/** `/api/computers/setup`: reached only with the UI secret; never from `/internal`, MCP or the WebSocket. */
export async function engineSetupApi(setup: EngineSetup, method: string, readBody: () => Promise<Record<string, unknown>>): Promise<Reply> {
  if (method === "GET") return { status: 200, body: await setup.status() };
  if (method === "POST") {
    const parsed = setupRequestSchema.safeParse(await readBody());
    if (!parsed.success) throw new HttpError(400, "expected exactly { provider: \"orbstack\" | \"docker-desktop\" }");
    try {
      return { status: 202, body: await setup.start(parsed.data.provider) };
    } catch (error) {
      throw refused(error);
    }
  }
  if (method === "DELETE") {
    try {
      return { status: 200, body: await setup.cancel() };
    } catch (error) {
      throw refused(error);
    }
  }
  throw new HttpError(404, "not found");
}

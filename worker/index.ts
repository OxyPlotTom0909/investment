/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { readFundamentalBackfillStatus, readSnapshot, readSyncStatus, runFundamentalBackfill, runMarketSync, type MarketEnv } from "./market-data";

interface Env extends MarketEnv {
  MARKET_SYNC_ADMIN_TOKEN?: string;
  ASSETS: Fetcher;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/admin/sync") {
      const expectedToken = env.MARKET_SYNC_ADMIN_TOKEN;
      const authorization = request.headers.get("Authorization");
      if (request.method !== "POST" || !expectedToken || authorization !== `Bearer ${expectedToken}`) {
        return Response.json({ error: "未授權的同步請求" }, { status: 401 });
      }
      ctx.waitUntil(runMarketSync(env));
      return Response.json({ status: "syncing", message: "已啟動市場快照同步。" }, { status: 202 });
    }

    if (url.pathname === "/api/market/status") {
      try {
        return Response.json(await readSyncStatus(env), { headers: { "Cache-Control": "no-store" } });
      } catch {
        return Response.json({ status: "unavailable", message: "同步狀態尚未建立" }, { status: 503 });
      }
    }

    if (url.pathname === "/api/market/backfill-status") {
      try {
        return Response.json(await readFundamentalBackfillStatus(env), { headers: { "Cache-Control": "no-store" } });
      } catch {
        return Response.json({ status: "unavailable", message: "歷史回補狀態尚未建立" }, { status: 503 });
      }
    }

    if (url.pathname === "/api/market") {
      try {
        const snapshot = await readSnapshot(env);
        return Response.json(snapshot, { headers: { "Cache-Control": "public, max-age=300" } });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "市場資料暫時無法使用" }, { status: 503 });
      }
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === "*/10 * * * *") {
      ctx.waitUntil(runFundamentalBackfill(env));
      return;
    }
    ctx.waitUntil(runMarketSync(env));
  },
};

export default worker;

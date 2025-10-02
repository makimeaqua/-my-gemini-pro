// main.ts (或您的入口文件)

import { serve } from "https://deno.land/std@0.196.0/http/server.ts";
import { Buffer } from "https://deno.land/std@0.196.0/io/buffer.ts";

// --- 配置 ---
const PORT = 8000;
// Gemini API 的基础 URL, 注意：已经包含 /v1
const TARGET_GEMINI_API_URL_BASE = "https://generativelanguage.googleapis.com/v1";

// --- 环境变量 ---
const GEMINI_API_KEY = Deno.env.get("MY_GEMINI_API_KEY");
if (!GEMINI_API_KEY) {
  console.error("MY_GEMINI_API_KEY 环境变量未设置！请在 Deno Deploy 中配置。");
}

// --- Websocket 连接状态 ---
let wsConnections = new Set<WebSocket>();

// --- 辅助函数 ---
function getSillyTavernApiKey(req: Request): string | undefined {
  const url = new URL(req.url);
  const headers = req.headers;
  const apiKey =
    headers.get("x-por-api-key") ||
    headers.get("Authorization")?.replace("Bearer ", "") ||
    headers.get("x-goog-api-key") ||
    headers.get("x-api-key") ||
    url.searchParams.get("key");

  if (apiKey) {
    console.log(`[${url.pathname}] 客户端密钥来源: ${headers.get("x-por-api-key") ? "x-por-api-key" : headers.get("Authorization") ? "Authorization" : headers.get("x-goog-api-key") ? "x-goog-api-key" : headers.get("x-api-key") ? "x-api-key" : "URL parameter 'key'"}`);
    console.log(`[${url.pathname}] 捕获到的客户端密钥 (前8位): ${apiKey.substring(0, 8)}...`);
    return apiKey;
  } else {
    console.warn(`[${url.pathname}] 未在请求中找到 API 密钥。`);
    return undefined;
  }
}

// --- 主请求处理函数 ---
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = crypto.randomUUID();

  console.log(`[${requestId}] 收到请求: ${req.method} ${url.pathname}`);
  const clientApiKey = getSillyTavernApiKey(req);

  if (!GEMINI_API_KEY) {
    console.error(`[${requestId}] 致命错误: MY_GEMINI_API_KEY 环境变量未设置。无法继续。`);
    return new Response(JSON.stringify({ error: "Server configuration missing MY_GEMINI_API_KEY." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // --- WebSocket 请求处理 ---
  if (url.pathname === "/ws") {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response(null, { status: 501, headers: { "Sec-WebSocket-Key": req.headers.get("sec-websocket-key") || "" } });
    }

    const { socket, response } = Deno.upgradeWebSocket(req);
    wsConnections.add(socket);
    console.log(`[${requestId}] WebSocket 连接已建立。`);

    socket.onmessage = (event) => {
      console.log(`[${requestId}] WebSocket 收到消息: ${event.data}`);
      // 这里处理 SillyTavern 的 WebSocket 消息，通常 SillyTavern 更常用 HTTP SSE
    };
    socket.onclose = () => {
      wsConnections.delete(socket);
      console.log(`[${requestId}] WebSocket 连接已关闭。`);
    };
    socket.onerror = (error) => {
      console.error(`[${requestId}] WebSocket 错误:`, error);
    };
    return response;
  }

  // --- HTTP 请求处理 ---
  // SillyTavern 期望的 OpenAI 兼容端点通常是 /v1/chat/completions。
  // 我们的 Base URL (TARGET_GEMINI_API_URL_BASE) 已经包含了 /v1。
  // 所以，我们只需要处理 SillyTavern 发送过来的剩余路径，并原样转发给 Gemini API。

  // 检查 SillyTavern 发送的路径是否以 /v1 开头 (这是 OpenAI 兼容 API 的常见约定)
  if (!url.pathname.startsWith("/v1/")) {
    console.warn(`[${requestId}] 收到非预期的路径: ${url.pathname}。期望以 /v1/ 开头。`);
    return new Response(JSON.stringify({ error: "Invalid endpoint. Expected path starting with /v1/." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 提取 SillyTavern 发送的路径（例如：/v1/chat/completions）
  const remainingPath = url.pathname.substring("/v1".length); // 移除 /v1 部分

  // 构造 Gemini API 的完整 URL
  // TARGET_GEMINI_API_URL_BASE 已经是 https://generativelanguage.googleapis.com/v1
  // remainingPath 就是 SillyTavern 自动附加的，例如 /chat/completions
  // Gemini API Key 作为 URL 参数传递
  const geminiRequestUrl = `${TARGET_GEMINI_API_URL_BASE}${remainingPath}?key=${GEMINI_API_KEY}`;

  console.log(`[${requestId}] 转发请求到 Gemini: ${geminiRequestUrl}`);

  try {
    const requestBody = await req.text();
    const geminiReq = new Request(geminiRequestUrl, {
      method: req.method,
      headers: {
        ...Object.fromEntries(req.headers.entries()).reduce((acc, [key, value]) => {
          const lowerKey = key.toLowerCase();
          // 排除可能导致冲突的 Header，转而使用 URL 参数传递 API Key
          if (!["authorization", "x-por-api-key", "x-goog-api-key", "x-api-key", "key", "host", "connection", "content-length", "transfer-encoding", "upgrade"].includes(lowerKey)) {
            acc[key] = value;
          }
          return acc;
        }, {} as Record<string, string>),
        "Content-Type": req.headers.get("content-type") || "application/json",
      },
      body: req.body,
    });

    const geminiResponse = await fetch(geminiReq);

    const responseReader = geminiResponse.body?.getReader();
    if (!responseReader) {
      console.error(`[${requestId}] 无法从 Gemini API 获取响应体。`);
      return new Response(JSON.stringify({ error: "Failed to get response from Gemini API." }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const stream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await responseReader.read();
        if (done) {
          controller.close();
          console.log(`[${requestId}] Gemini API 响应流已关闭。`);
          return;
        }
        controller.enqueue(value);
      },
      cancel() {
        responseReader.cancel();
        console.log(`[${requestId}] Gemini API 响应流被取消。`);
      },
    });

    const headers = new Headers(geminiResponse.headers);
    headers.set("Content-Type", "text/event-stream");
    headers.set("Cache-Control", "no-cache");
    headers.set("Connection", "keep-alive");

    const refererUrl = new URL(req.url);
    const sillyTavernRequestId = refererUrl.searchParams.get("request_id");
    if (sillyTavernRequestId) {
        headers.set("X-SillyTavern-Request-ID", sillyTavernRequestId);
    }
    headers.set("X-Deno-Agent-Request-ID", requestId);

    console.log(`[${requestId}] 成功从 Gemini API 获取响应, 状态: ${geminiResponse.status}`);

    return new Response(stream, {
      status: geminiResponse.status,
      headers: headers,
    });

  } catch (error) {
    console.error(`[${requestId}] 请求转发到 Gemini API 时发生错误:`, error);
    let errorMessage = "An internal server error occurred while proxying the request.";
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

if (import.meta.env.PROD) {
  console.log("正在 Deno Deploy 环境中运行...");
  serve(handler);
} else {
  console.log(`[本地开发] 服务器正在监听 http://localhost:${PORT}`);
  serve(handler, { port: PORT });
}

console.log("Deno 代理服务器已启动。");

// main.ts (或您的入口文件)

import { serve } from "https://deno.land/std@0.196.0/http/server.ts"; // 确保使用一个相对较新的 std 版本
import { Buffer } from "https://deno.land/std@0.196.0/io/buffer.ts"; // 用于处理流

// --- 配置 ---
const PORT = 8000; // Deno Deploy 不需要这个，但本地开发有用
const TARGET_GEMINI_API_URL_BASE = "https://generativelanguage.googleapis.com/v1"; // Gemini API 的基础 URL

// --- 环境变量 ---
// 从 Deno.env 中获取您的 Gemini API 密钥。
// 请确保您在 Deno Deploy 的环境变量中也设置了 MY_GEMINI_API_KEY
const GEMINI_API_KEY = Deno.env.get("MY_GEMINI_API_KEY");
if (!GEMINI_API_KEY) {
  console.error("MY_GEMINI_API_KEY 环境变量未设置！请在 Deno Deploy 中配置。");
  // 在 Deno Deploy 中，直接退出可能会导致部署失败，但在本地开发可以帮助调试
  // Deno.exit(1);
}

// --- Websocket 连接状态 ---
let wsConnections = new Set<WebSocket>();

// --- 辅助函数 ---

// 检查请求是否来自 SillyTavern (通过密钥)
function getSillyTavernApiKey(req: Request): string | undefined {
  const url = new URL(req.url);
  const headers = req.headers;
  const apiKey =
    headers.get("x-por-api-key") ||                                   // 优先检查推荐的 x-por-api-key
    headers.get("Authorization")?.replace("Bearer ", "") ||          // 检查 Authorization Header (SillyTavern 可能使用这个)
    headers.get("x-goog-api-key") ||                                   // Google 官方 API Key Header
    headers.get("x-api-key") ||                                       // 通用 API Key Header
    url.searchParams.get("key");                                      // URL 参数

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
  const requestId = crypto.randomUUID(); // 为每个请求生成一个唯一的 ID

  console.log(`[${requestId}] 收到请求: ${req.method} ${url.pathname}`);
  const clientApiKey = getSillyTavernApiKey(req); // 获取并记录客户端传入的密钥

  // --- Deno Deploy 环境变量检查 ---
  if (!GEMINI_API_KEY) {
    console.error(`[${requestId}] 致命错误: MY_GEMINI_API_KEY 环境变量未设置。无法继续。`);
    return new Response(JSON.stringify({ error: "Server configuration missing MY_GEMINI_API_KEY." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // --- 验证 SillyTavern 发送的密钥 (如果 SillyTavern 发送了) ---
  // 注意: 在这个代理服务中, SillyTavern 发送过来的密钥 (clientApiKey)
  // 并不是用来验证 Deno 部署本身的, 而是用来转发给 Gemini Gemini API 的。
  // 如果您也想验证 SillyTavern 发送过来的密钥, 需要在 Deno.env 中设置一个 'MY_SILTY_TAVERN_EXPECTED_KEY'。
  // 否则, 只要 clientApiKey 存在, 就认为 SillyTavern 配置了某种密钥。
  // 如果您没有在 Deno.env 中设置 MY_SILTY_TAVERN_EXPECTED_KEY, 那么任何 SillyTavern 发送过来的密钥都会被接受。
  // 如果您确实需要一个服务器端验证 SillyTavern 发送的密钥，可以取消下方注释并配置 MY_SILTY_TAVERN_EXPECTED_KEY
  /*
  const MY_SILTY_TAVERN_EXPECTED_KEY = Deno.env.get("MY_SILTY_TAVERN_EXPECTED_KEY");
  if (MY_SILTY_TAVERN_EXPECTED_KEY && clientApiKey !== MY_SILTY_TAVERN_EXPECTED_KEY) {
      console.warn(`[${requestId}] 认证失败: SillyTavern 提供的密钥不匹配。`);
      return new Response(JSON.stringify({ error: "Authentication failed: Invalid SillyTavern API key." }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
      });
  } else if (!clientApiKey && MY_SILTY_TAVERN_EXPECTED_KEY){
      console.warn(`[${requestId}] 认证失败: 未提供 SillyTavern API 密钥。`);
      return new Response(JSON.stringify({ error: "Authentication failed: SillyTavern API key is missing." }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
      });
  }
  */


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
      // 这里可以处理从 SillyTavern 发来的 WebSocket 消息，并发送给 Gemini
      // Gemini API 不直接支持 WebSocket，所以通常 SillyTavern 会通过 HTTP 长轮询或 SSE
      // 如果 SillyTavern 真的通过 WebSocket 发送 chat/completions 的数据，你需要在这里处理
      // Gemini Labs API 响应部分是 SSE (Server-Sent Events)，这个实现不直接支持
    };

    socket.onclose = () => {
      wsConnections.delete(socket);
      console.log(`[${requestId}] WebSocket 连接已关闭。`);
    };

    socket.onerror = (error) => {
      console.error(`[${requestId}] WebSocket 错误:`, error);
    };

    // 返回一个空的 Response，WebSocket 连接已经处理
    return response;
  }

  // --- HTTP 请求处理 ---
  // SillyTavern 发送的聊天补全请求通常是 POST /v1/chat/completions
  // 我们的 Deno 代理将根 URL 配置为 /v1，所以 SillyTavern 会自动附加 /chat/completions

  // 确保请求路径是 /v1/* （由 SillyTavern 自动附加）
  if (!url.pathname.startsWith("/v1")) {
    console.warn(`[${requestId}] 收到非预期的路径: ${url.pathname}`);
    return new Response(JSON.stringify({ error: "Invalid endpoint. Expected /v1/*" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 构造 Gemini API 的完整 URL
  const geminiServicePath = url.pathname.startsWith("/v1/chat/completions") ? "/chat/completions" : url.pathname; // 确保路径是 Gemini API 期望的
  const geminiRequestUrl = `${TARGET_GEMINI_API_URL_BASE}${geminiServicePath}?key=${GEMINI_API_KEY}`; // Gemini API 总是通过 URL 参数传递 key

  console.log(`[${requestId}] 转发请求到 Gemini: ${geminiRequestUrl}`);

  try {
    const requestBody = await req.text(); // 读取 SillyTavern 发送的请求体
    const reader = new Buffer(new TextEncoder().encode(requestBody)); // 将请求体转换为可读流

    // 创建新的请求对象，用于转发给 Gemini API
    const geminiReq = new Request(geminiRequestUrl, {
      method: req.method,
      headers: {
        // 复制 SillyTavern 发送的所有 Header，除了可能的 Authorization 或 api key（因为我们已经用 URL 参数传递了）
        // 避免因重复或不兼容的 Header 导致 Gemini API 错误
        ...Object.fromEntries(req.headers.entries()).reduce((acc, [key, value]) => {
          const lowerKey = key.toLowerCase();
          if (!["authorization", "x-por-api-key", "x-goog-api-key", "x-api-key", "key", "host", "connection", "content-length", "transfer-encoding", "upgrade"].includes(lowerKey)) {
            acc[key] = value;
          }
          return acc;
        }, {} as Record<string, string>),
        "Content-Type": req.headers.get("content-type") || "application/json", // 确保 Content-Type
      },
      body: req.body, // 转发原始请求体
      // body: reader, // 如果 req.body 是 ReadableStream，可能需要用 reader 包装
    });

    const geminiResponse = await fetch(geminiReq);

    // --- 处理 Gemini API 的响应 ---
    const responseReader = geminiResponse.body?.getReader();
    if (!responseReader) {
      console.error(`[${requestId}] 无法从 Gemini API 获取响应体。`);
      return new Response(JSON.stringify({ error: "Failed to get response from Gemini API." }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 构建 Server-Sent Events (SSE) 响应，以支持流式输出
    const stream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await responseReader.read();
        if (done) {
          controller.close();
          console.log(`[${requestId}] Gemini API 响应流已关闭。`);
          return;
        }
        controller.enqueue(value); // 将数据块加入流
      },
      cancel() {
        responseReader.cancel();
        console.log(`[${requestId}] Gemini API 响应流被取消。`);
      },
    });

    // 复制 Gemini API 的响应头，并设置 Content-Type 为 text/event-stream
    const headers = new Headers(geminiResponse.headers);
    headers.set("Content-Type", "text/event-stream");
    headers.set("Cache-Control", "no-cache");
    headers.set("Connection", "keep-alive");

    // 从 SillyTavern 发送的请求中获取 ID，并将其设置到响应中，便于追踪
    const refererUrl = new URL(req.url);
    const sillyTavernRequestId = refererUrl.searchParams.get("request_id"); // SillyTavern 可能通过 URL 参数传递 request_id
    if (sillyTavernRequestId) {
        headers.set("X-SillyTavern-Request-ID", sillyTavernRequestId);
    }
    headers.set("X-Deno-Agent-Request-ID", requestId); // 添加我们自己生成的 Request ID

    console.log(`[${requestId}] 成功从 Gemini API 获取响应, 状态: ${geminiResponse.status}`);

    return new Response(stream, {
      status: geminiResponse.status,
      headers: headers,
    });

  } catch (error) {
    console.error(`[${requestId}] 请求转发到 Gemini API 时发生错误:`, error);
    // 尝试从错误中提取更多信息，如果可能的话
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

// --- 启动服务器 ---
if (import.meta.env.PROD) { // 在 Deno Deploy 上运行
  console.log("正在 Deno Deploy 环境中运行...");
  serve(handler);
} else { // 在本地开发环境
  console.log(`[本地开发] 服务器正在监听 http://localhost:${PORT}`);
  serve(handler, { port: PORT });
}

console.log("Deno 代理服务器已启动。");

// --- Node.js 环境变量警告处理 ---
// 在 NodeJs 中，如果设置了 NODE_TLS_REJECT_UNAUTHORIZED=0，会发出警告。
// 这个警告本身不影响 Deno 的 TLS, 但如果您的 NodeJs 环境发出此警告，请留意。
// Deno 默认会进行 TLS 验证。

// main.ts (或者您的项目入口文件，确保文件名一致)

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

// --- 配置 ---
// Gemini API 的基础 URL，注意：已经包含 /v1
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1";

// 1. 我的服务器的认证密钥，用于验证谁能访问我的代理 (SillyTavern 发送)
const MY_SERVER_SECRET_KEY = Deno.env.get("MY_SERVER_SECRET_KEY");

// 2. Gemini API 密钥 (可以是一个或多个，用逗号分隔)
const GEMINI_API_KEYS_STR = Deno.env.get("GEMINI_API_KEYS");
let GEMINI_AI_KEYS: string[] = [];
if (GEMINI_API_KEYS_STR) {
  GEMINI_AI_KEYS = GEMINI_API_KEYS_STR.split(',').map(key => key.trim()).filter(key => key.length > 0);
}

// --- 日志和启动检查 ---
console.log("========================");
console.log("  Gemini API 代理服务器");
console.log("========================");
console.log("=== 服务器启动配置检查 ===");
console.log(`MY_SERVER_SECRET_KEY 设置状态: ${MY_SERVER_SECRET_KEY ? '已设置' : '未设置 (代理将无法工作)'}`);
console.log(`Gemini API Keys 数量: ${GEMINI_AI_KEYS.length} 个`);
if (GEMINI_AI_KEYS.length > 0) {
  console.log(`Gemini API Keys 长度概览: ${GEMINI_AI_KEYS.map(k => k.length > 0 ? `${k.substring(0, 4)}...` : '空').join(', ')}`);
}
if (!MY_SERVER_SECRET_KEY || GEMINI_AI_KEYS.length === 0) {
  console.error("\n!!! 启动失败：环境变量 MY_SERVER_SECRET_KEY 或 GEMINI_API_KEYS 未正确配置 !!!");
  console.error("请在 Deno Deploy 中设置以上环境变量。\n");
}
console.log("========================");

// 随机选择一个 Gemini API Key
function getRandomGeminiApiKey(): string {
  if (GEMINI_AI_KEYS.length === 0) {
    throw new Error("Gemini API Key 列表为空。请检查环境变量 'GEMINI_API_KEYS'");
  }
  const randomIndex = Math.floor(Math.random() * GEMINI_AI_KEYS.length);
  const selectedKey = GEMINI_AI_KEYS[randomIndex];
  console.log(`[Key Pool] 使用 Gemini API Key #${randomIndex + 1}/${GEMINI_AI_KEYS.length} (长度: ${selectedKey.length}, 前4位: ${selectedKey.substring(0, 4)}...)`);
  return selectedKey;
}

// 尝试从 SillyTavern 发送的请求中获取访问代理的密钥
function getClientSecretKeyFromRequest(req: Request): { key: string | undefined, source: string } {
  const url = new URL(req.url);
  const headers = req.headers;
  let key: string | undefined = undefined;
  let source = "未找到";

  // 优先检查 x-por-api-key (CherryStudio 推荐，SillyTavern 也可能发送)
  const porApiKey = headers.get("x-por-api-key");
  if (porApiKey) {
    key = porApiKey.trim();
    source = "x-por-api-key header";
  }
  // 检查 X-Api-Key (通用)
  const xApiKey = headers.get("x-api-key");
  if (!key && xApiKey) {
    key = xApiKey.trim();
    source = "x-api-key header";
  }
  // 检查 Authorization Header
  const authHeader = headers.get("Authorization");
  if (!key && authHeader) {
    if (authHeader.toLowerCase().startsWith("bearer ")) {
      key = authHeader.substring(7).trim(); // 移除 "bearer "
      source = "Authorization: Bearer";
    } else {
      key = authHeader.trim();
      source = "Authorization (direct)";
    }
  }
   // 检查 x-goog-api-key (Google 服务的 Header)
   const googApiKey = headers.get("x-goog-api-key");
   if (!key && googApiKey) {
       key = googApiKey.trim();
       source = "x-goog-api-key header";
   }
  // 检查 URL 参数
  if (!key) {
    const urlKey = url.searchParams.get("key");
    if (urlKey) {
      key = urlKey.trim();
      source = "URL parameter 'key'";
    }
  }

  return { key, source };
}

// --- 主请求处理函数 ---
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = crypto.randomUUID().substring(0, 8);
  const startTime = Date.now();
  
  console.log(`\n[${requestId}] === 收到请求 ===`);
  console.log(`[${requestId}] 方法: ${req.method}`);
  console.log(`[${requestId}] 原始路径: ${url.pathname}`);
  console.log(`[${requestId}] 原始 URL Search: ${url.search}`);

  // --- CORS 预检请求处理 ---
  const originHeader = req.headers.get("origin");
  // 允许所有来源，但您也可以限制为特定的 SillyTavern 运行地址
  const allowedOrigin = originHeader || "*"; 

  if (req.method === "OPTIONS") {
    console.log(`[${requestId}] 处理 CORS 预检请求 (Origin: ${originHeader})`);
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        // SillyTavern 需要的 Headers，确保包含：
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-goog-api-key, x-por-api-key, MY_SERVER_SECRET_KEY, Origin, Accept",
        "Access-Control-Allow-Credentials": "true", // 如果 SillyTavern 使用 cookie 或其他凭证
        "Access-Control-Max-Age": "86400", // 缓存预检结果 24 小时
      },
    });
  }

  // --- 服务器配置检查 ---
  if (!MY_SERVER_SECRET_KEY || GEMINI_AI_KEYS.length === 0) {
    console.error(`[${requestId}] 错误：服务器环境变量 MY_SERVER_SECRET_KEY 或 GEMINI_API_KEYS 未正确配置。`);
    return new Response(
      JSON.stringify({
        error: "服务器配置错误",
        details: {
          env_configured: {
            MY_SERVER_SECRET_KEY: !!MY_SERVER_SECRET_KEY,
            GEMINI_API_KEYS: GEMINI_AI_KEYS.length > 0
          }},
        message: "请检查Deno Deploy中的环境变量设置。"
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": allowedOrigin,
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-goog-api-key, x-por-api-key, Access-Control-Allow-Origin Source", // 允许客户端读取 Origin
        }
      }
    );
  }

  // --- 1. 验证客户端 (SillyTavern) 发送的访问密钥 ---
  const { key: clientSecretKey, source: keySource } = getClientSecretKeyFromRequest(req);

  console.log(`[${requestId}] 客户端密钥来源: ${keySource}`);

  if (!clientSecretKey) {
    console.log(`[${requestId}] 认证失败：未提供访问代理的密钥`);
    return new Response(
      JSON.stringify({
        error: "认证失败：未提供访问代理密钥",
        hint: "请在 x-por-api-key (推荐), x-api-key, Authorization header, x-goog-api-key 中或 URL 参数 'key' 提供您的密钥。"
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": allowedOrigin,
        }
      }
    );
  }

  if (clientSecretKey !== MY_SERVER_SECRET_KEY) {
    console.log(`[${requestId}] 认证失败：提供给代理的密钥无效`);
    return new Response(
      JSON.stringify({ error: "认证失败：访问代理的密钥无效" }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": allowedOrigin,
        }
      }
    );
  }
  console.log(`[${requestId}] 访问代理认证成功 (密钥来源: ${keySource})`);

  // --- 2. 准备转发给 Gemini API 的请求 ---
  let configuredGeminiApiKey = "";
  try {
    configuredGeminiApiKey = getRandomGeminiApiKey();
  } catch (error) {
    console.error(`[${requestId}] ${error.message}`);
    return new Response(
      JSON.stringify({ error: "服务器内部错误", message: error.message }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": allowedOrigin,
        }
      }
    );
  }
  
  //SilleyTavern 期望的 OpenAI 兼容端点通常是 /v1/chat/completions
  //我们的 Base URL (GEMINI_API_BASE) 已经包含了 /v1。
  //所以，我们只需确保 SillyTavern 发送的路径以 /v1/ 开头，然后将剩下的部分追加到 Gemini API Base URL。

  let geminiServicePath = url.pathname; // 原始路径
  // 确保 SillyTavern 发送的路径是以 /v1/ 开头的
  if (!geminiServicePath.startsWith("/v1/")) {
      console.warn(`[${requestId}] 警告: SillyTavern 发送的路径不符合预期的 OpenAI(/v1/) 格式: ${geminiServicePath}`);
      // 如果 SillyTavern 发送的不是 /v1/chat/completions 而是 /chat/completions, 
      // 并且您的 Deno 环境是根目录监听，您可能需要调整这里的逻辑. 
      // 但根据 SillyTavern 的普遍行为，它会发送 /v1/chat/completions。
      // 如果这里收到 /chat/completions，则追加 /v1
      if(geminiServicePath.startsWith("/chat/completions") || geminiServicePath.startsWith("/completions")) {
          console.log(`[${requestId}] 自动处理 SillyTavern 的 /chat/completions 路径，追加 /v1`);
          geminiServicePath = "/v1" + geminiServicePath;
      }
  }

  // Gemini API Key 作为 URL 参数传递
  // **重点**：移除 URL 中可能存在的旧的 `key` 参数，然后添加新的 Gemini Key
  url.searchParams.delete("key"); 
  url.searchParams.set("key", configuredGeminiApiKey);
  
  // 最终构造的 Gemini API 请求 URL
  const targetUrl = `${GEMINI_API_BASE}${geminiServicePath}${url.search}`;

  console.log(`[${requestId}] 目标 Gemini API URL: ${targetUrl}`);
  console.log(`[${requestId}] Gemini API Key Index: ${GEMINI_AI_KEYS.indexOf(configuredGeminiApiKey) + 1}/${GEMINI_AI_KEYS.length}`);

  // --- 准备发送给 Gemini API 的 Headers ---
  const forwardHeaders = new Headers();
  
  // 复制 SillyTavern 的 Header，但要排除可能引起冲突的 Header
  const headersToExclude = [
    "host", "connection", "content-length", "transfer-encoding", "upgrade",
    "sec-websocket-key", "sec-websocket-protocol", "sec-websocket-version", "sec-websocket-extensions", // WebSocket 相关
    "origin", "access-control-request-headers", "access-control-request-method", // CORS 相关
    // 密钥相关的 Header，因为我们已将其作为 URL 参数传递
    "authorization", "x-api-key", "x-goog-api-key", "x-por-api-key", "key" 
  ];

  for (const [headerName, headerValue] of req.headers.entries()) {
    if (
      !headersToExclude.some(excluded => headerName.toLowerCase() === excluded) &&
      headerValue !== null // 避免 null 值
    ) {
      forwardHeaders.set(headerName, headerValue);
    }
  }
  
  // 明确设置 Content-Type，如果 SillyTavern 未发送或发送不正确
  if (!forwardHeaders.has("Content-Type") && req.headers.get("Content-Type")) {
    forwardHeaders.set("Content-Type", req.headers.get("Content-Type")!);
  } else if (!forwardHeaders.has("Content-Type")) {
      forwardHeaders.set("Content-Type", "application/json"); // 默认 JSON
  }
  // Gemini API 可能需要一些特定的 Header，例如 x-goog-api-client
  // forwardHeaders.set("x-goog-api-client", "gal/1.0 gdcl/2023.09.26"); // 可选，根据需要添加

  // --- 准备请求体 ---
  let requestBodyBuffer: ArrayBuffer | null = null;
  if (req.body) { // 检查 req.body 是否存在
    try {
      requestBodyBuffer = await req.arrayBuffer();
      console.log(`[${requestId}] 请求体大小: ${requestBodyBuffer.byteLength} bytes`);
      // 如果需要，可以在这里打印一部分请求体用于调试
      // console.log(`[${requestId}] 请求体 (前100字节): ${new TextDecoder().decode(requestBodyBuffer.slice(0, 100))}`);
    } catch (e) {
      console.error(`[${requestId}] 读取请求体时发生错误:`, e);
      // 如果读取请求体失败，也返回错误
      return new Response(
        JSON.stringify({ error: "无法读取请求体", message: e.message }),
        { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": allowedOrigin } }
      );
    }
  } else {
      console.log(`[${requestId}] 请求无请求体。`);
  }

  // --- 发送请求到 Gemini API ---
  let geminiResponse: Response;
  try {
    console.log(`[${requestId}] 发送请求到 Gemini API: ${req.method} ${targetUrl}`);
    geminiResponse = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: requestBodyBuffer ? requestBodyBuffer : undefined,
      // body: req.body, // Deno 的 req.body 是 ReadableStream，直接传可能在某些情况下有问题， ArrayBuffer 更保险
    });
    const responseTime = Date.now() - startTime;
    console.log(`[${requestId}] Gemini API 响应状态: ${geminiResponse.status} (${responseTime}ms)`);

    // 检查 Gemini API 的响应状态码
    if (geminiResponse.status >= 400) {
        try {
            const errorBody = await geminiResponse.text();
            console.error(`[${requestId}] Gemini API 错误详情: Status ${geminiResponse.status}, Response: "${errorBody.substring(0, 500)}"`);
        } catch (e) {
            console.error(`[${requestId}] Gemini API 错误响应 (无法读取文本): Status ${geminiResponse.status}, Body size: ${geminiResponse.headers.get("content-length") || "unknown"}`);
        }
    }

  } catch (error) {
    console.error(`[${requestId}] 请求 Gemini API 时发生网络或fetch错误:`, error);
    return new Response(
      JSON.stringify({
        error: "与 Gemini API 通信时发生错误",
        message: error instanceof Error ? error.message : "未知错误",
        targetUrl: targetUrl // 包含目标 URL 方便调试
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": allowedOrigin,
        }
      }
    );
  }

  // --- 准备返回给客户端 (SillyTavern) 的响应 ---
  // 复制 Gemini API 的响应头，并添加 CORS 和调试信息
  const responseHeaders = new Headers();
  const headersToReturn = [
    "Content-Type", "Cache-Control", "Content-Encoding", "Transfer-Encoding",
    "Date", "Server", "Content-Length" // 复制一些标准的响应头
  ];
  for (const header of headersToReturn) {
    const value = geminiResponse.headers.get(header);
    if (value !== null && value !== undefined) {
      responseHeaders.set(header, value);
    }
  }
  
  // 添加 CORS Headers
  responseHeaders.set("Access-Control-Allow-Origin", allowedOrigin);
  responseHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, x-goog-api-key, x-por-api-key, MY_SERVER_SECRET_KEY");
  responseHeaders.set("Access-Control-Allow-Credentials", "true");

  // 添加调试 Headers
  responseHeaders.set("X-Request-ID", requestId);
  responseHeaders.set("X-Gemini-API-Key-Index", `${GEMINI_AI_KEYS.indexOf(configuredGeminiApiKey) + 1}/${GEMINI_AI_KEYS.length}`);

  // --- 处理流式响应 ---
  // Gemini API chat completions 响应通常是 SSE stream
  const contentType = geminiResponse.headers.get("Content-Type");
  if (
    contentType?.includes("event-stream") || 
    geminiResponse.headers.get("Transfer-Encoding") === "chunked" || // chunked 响应也常常是流式
    url.pathname.endsWith("/stream") // 显式要求 stream 的路径 (如果 SillyTavern 有这种模式)
  ) {
    console.log(`[${requestId}] 检测到流式响应 (Content-Type: ${contentType}), 正在处理...`);
    
    // Gemini API 的 SSE 响应是以 'data: ...\n\n' 格式的。
    // Deno 的 fetch 返回的 ReadableStream 已经包含了这些数据。
    // 我们只需要确保 Content-Type 设置为 text/event-stream
    responseHeaders.set("Content-Type", "text/event-stream");
    responseHeaders.set("Cache-Control", "no-cache"); // 缓存控制
    responseHeaders.set("Connection", "keep-alive"); // 保持连接

    return new Response(geminiResponse.body, {
      status: geminiResponse.status,
      headers: responseHeaders,
    });
  }

  // --- 处理非流式响应 ---
  // 如果不是流式响应，则读取整个响应体
  let responseBody: ArrayBuffer;
  try {
      responseBody = await geminiResponse.arrayBuffer();
      console.log(`[${requestId}] 非流式响应体大小: ${responseBody.byteLength} bytes`);
  } catch (e) {
      console.error(`[${requestId}] 读取非流式响应体时发生错误:`, e);
      return new Response(
          JSON.stringify({ error: "服务器内部错误 - 无法读取 Gemini API 响应", message: e.message }),
          { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": allowedOrigin } }
      );
  }

  return new Response(responseBody, {
    status: geminiResponse.status,
    headers: responseHeaders,
  });
}

// --- 启动服务器 ---
console.log("Gemini API 代理服务器已启动。");
serve(handler); // Deno Deploy 会自动处理端口和监听

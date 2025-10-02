import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

// Gemini API 的基础 URL
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";

// --- 环境变量配置 ---
// 代理的“通行证”（认证密钥）。客户端（如 SillyTavern/CherryStudio）必须提供此密钥才能访问代理。
const AUTH_KEY = Deno.env.get("key");

// 你的 Google Gemini API 密钥列表（使用英文逗号 `,` 分隔）。
// 代理将从中随机选择一个来访问 Google API，以避免单个密钥被速率限制。
const GEMINI_API_KEYS_STR = Deno.env.get("apikey");
// --- 环境变量配置结束 ---

// 解析字符串格式的 Gemini API 密钥列表，生成实际的数组
let GEMINI_API_KEYS: string[] = [];
if (GEMINI_API_KEYS_STR) {
  GEMINI_API_KEYS = GEMINI_API_KEYS_STR
    .split(',') // 使用逗号分割
    .map(key => key.trim()) // 去除每个密钥两端的空白字符
    .filter(key => key.length > 0); // 过滤掉空字符串
}

/**
 * 从代理的环境变量 GEMINI_API_KEYS 中随机选择一个 Gemini API Key。
 * @returns 一个随机选择的 Gemini API Key。
 * @throws 如果没有配置环境变量 'apikey'，则抛出错误。
 */
function getRandomGeminiApiKey(): string {
  if (GEMINI_API_KEYS.length === 0) {
    throw new Error("错误：没有可用的 Gemini API Key。请检查并配置 'apikey' 环境变量。");
  }

  const randomIndex = Math.floor(Math.random() * GEMINI_API_KEYS.length);
  const selectedKey = GEMINI_API_KEYS[randomIndex];

  // console.log(`代理：正在使用环境变量中的 Gemini API Key #${randomIndex + 1}/${GEMINI_API_KEYS.length}。`); // 减少日志

  return selectedKey;
}

// --- 服务器启动时的配置检查日志 ---
console.log("=== 服务器启动 - 配置检查 ===");
console.log(`代理的 AUTH_KEY 是否已设置: ${AUTH_KEY ? '是' : '否'}`);                                 // 打印 AUTH_KEY 是否存在
console.log(`代理可用的 Gemini API Keys 数量: ${GEMINI_API_KEYS.length}`);
if (GEMINI_API_KEYS.length > 0) {
  // 打印每个 Gemini API Key 的长度，有助于排查配置问题
  console.log(`代理 API Keys 长度分布: ${GEMINI_API_KEYS.map(k => k.length).join(', ')}`);
}
console.log("==========================");

/**
 * 处理所有传入的 HTTP 请求。
 * @param req 传入的 Request 对象。
 * @returns 一个 Promise，解析为 Response 对象。
 */
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = crypto.randomUUID().substring(0, 8); // 请求ID用于日志追踪

  // --- 1. 处理 CORS 预检请求 (OPTIONS 方法) ---
  // 允许客户端在发送实际请求前发送 OPTIONS 请求以检查服务器是否支持该请求。
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204, // 204 No Content
      headers: {
        "Access-Control-Allow-Origin": "*", // 允许所有来源访问
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", // 允许的方法
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-goog-api-key, key", // 允许的 Headers (包含代理认证可能的 Header)
        "Access-Control-Max-Age": "86400", // Preflight 响应缓存时间 (1 天)
      },
    });
  }

  // --- 2. 检查服务器端的环境变量配置 ---
  // 如果 AUTH_KEY 或 GEMINI_API_KEYS 未设置，则服务器无法正常工作。
  if (!AUTH_KEY || GEMINI_API_KEYS.length === 0) {
    console.error(`[${requestId}] 错误：服务器环境变量未正确配置 ('key' 和 'apikey' 是必需的)。`);
    return new Response(
      JSON.stringify({
        error: "服务器配置错误",
        details: {
          auth_key_configured: !!AUTH_KEY,
          gemini_api_keys_count: GEMINI_API_KEYS.length
        }
      }),
      {
        status: 500, // 500 Internal Server Error
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*", // 允许 CORS
        }
      }
    );
  }

  // --- 3. 提取客户端提供的代理访问密钥（用于认证）---
  // 这个密钥用于验证客户端是否有权限访问此代理。
  let clientAuthKeyCandidate: string = ""; // 存储客户端提供的潜在代理认证密钥
  let authKeySource: string = ""; // 记录认证密钥的来源，用于日志

  // 3a. 尝试从 Authorization Header 中提取 (常见格式: Bearer <proxy_auth_key>)
  const authHeader = req.headers.get("Authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    clientAuthKeyCandidate = authHeader.substring(7).trim(); // "Bearer " 后面是密钥
    authKeySource = "Authorization Bearer";
  }

  // 3b. 如果 Authorization header 未找到，尝试从 x-api-key header 中提取
  if (!clientAuthKeyCandidate) {
    const xApiKey = req.headers.get("x-api-key");
    if (xApiKey) {
      clientAuthKeyCandidate = xApiKey.trim();
      authKeySource = "x-api-key header";
    }
  }

  // 3c. 如果 x-api-key header 未找到，尝试从 x-goog-api-key header 中提取
  //    **重要：在这里，我们仍然是在寻找代理的 AUTH_KEY，而不是 Gemini API Key。**
  //    虽然 x-goog-api-key 通常用于 Gemini API Key，但为了兼容某些旧的或特定的客户端配置，也允许它作为代理密钥。
  if (!clientAuthKeyCandidate) {
    const googApiKey = req.headers.get("x-goog-api-key");
    if (googApiKey) {
      clientAuthKeyCandidate = googApiKey.trim();
      authKeySource = "x-goog-api-key header";
    }
  }

  // 3d. 如果以上 Header 都未找到，尝试从 URL 查询参数中提取 (例如: ?key=...)
  if (!clientAuthKeyCandidate) {
    const urlKey = url.searchParams.get("key");
    if (urlKey) {
      clientAuthKeyCandidate = urlKey.trim();
      authKeySource = "URL parameter";
    }
  }

  // --- 验证客户端提供的密钥是否与代理的 AUTH_KEY 匹配 ---
  if (!clientAuthKeyCandidate) {
    // 如果客户端未提供任何形式的认证密钥
    console.log(`[${requestId}] 认证失败：未提供代理访问密钥 (已检查 ${authKeySource || '请求的 Headers/参数'})。`);
    return new Response(
      JSON.stringify({
        error: "认证失败：代理访问密钥缺失",
        hint: "请在 Authorization (Bearer), x-api-key, x-goog-api-key Header 中，或作为 URL 参数 'key' 提供您的访问密钥。"
      }),
      {
        status: 401, // 401 Unauthorized
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*", // 允许 CORS
        }
      }
    );
  }

  if (clientAuthKeyCandidate !== AUTH_KEY) {
    // 如果提供的密钥与代理配置的 AUTH_KEY 不匹配
    console.log(`[${requestId}] 认证失败：提供的代理访问密钥不匹配。`);
    return new Response(
      JSON.stringify({
        error: "认证失败：无效的代理访问密钥"
      }),
      {
        status: 401, // 401 Unauthorized
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*", // 允许 CORS
        }
      }
    );
  }

  // 如果认证成功
  console.log(`[${requestId}] 代理认证成功 (密钥来源: ${authKeySource})。`);

  // --- 4. 确定要使用的 Gemini API Key ---
  // 在此代理模式下，Gemini API Key 的选择完全由代理控制，
  // 代理会从 'apikey' 环境变量中随机选择一个。
  let finalGeminiApiKey: string;
  let geminiApiKeySource: string;
  try {
      finalGeminiApiKey = getRandomGeminiApiKey();
      const keyIndex = GEMINI_API_KEYS.indexOf(finalGeminiApiKey) + 1;
      geminiApiKeySource = `代理 'apikey' 环境变量 (随机选择, 索引 #${keyIndex}/${GEMINI_API_KEYS.length})`;
      console.log(`[${requestId}] Gemini API Key 来源: ${geminiApiKeySource}`);
  } catch (error: any) {
      // 捕获 getRandomGeminiApiKey() 中可能抛出的错误（例如 apikey 未设置）
      console.error(`[${requestId}] 错误：获取 Gemini API Key 失败: ${error.message}`);
      return new Response(
          JSON.stringify({
              error: "代理内部错误",
              details: error.message,
          }),
          {
              status: 500,
              headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
              },
          }
      );
  }


  // --- 5. 准备转发到 Gemini API 的请求 ---
  const targetPath = url.pathname; // Gemini API 的路径
  // 移除 URL 中可能由客户端添加的 'key' 参数，因为我们即将用上方选择的 Gemini Key 替换它。
  url.searchParams.delete("key");
  // 在 URL 中设置最终要使用的 Gemini API Key
  url.searchParams.set("key", finalGeminiApiKey);
  const targetUrl = `${GEMINI_API_BASE}${targetPath}${url.search}`; // 构建最终的 Gemini API 请求 URL

  // console.log(`[${requestId}] 正在转发请求到: ${targetUrl}`); // 减少日志

  // 准备要转发给 Gemini API 的 Headers
  const forwardHeaders = new Headers();
  // 定义需要转发的关键 Headers
  const headersToForward = [
    "Content-Type",
    "Accept",
    "User-Agent",
    "Accept-Language",
    "Accept-Encoding",
    "x-goog-api-client", // 转发 Google 客户端标识 Header
    "Referer", // 有时也需要转发
    "Origin", // 强制转发 Origin，因为 CORS 允许了 *，但对于某些 API 可能需要
  ];

  for (const header of headersToForward) {
    const value = req.headers.get(header);
    if (value) {
      // 重要：不要转发敏感或可能冲突的 Headers，这些 Header 由代理处理。
      // 例如：Authorization (因为它被用于代理认证), x-api-key, x-goog-api-key, key。
      if (!["Authorization", "X-Api-Key", "X-Goog-Api-Key"].includes(header)) {
           forwardHeaders.set(header, value);
      }
    }
  }

  // 准备请求体
  let body: ArrayBuffer | undefined = undefined;
  const contentLength = req.headers.get("Content-Length") ? parseInt(req.headers.get("Content-Length")!) : undefined;

  // Only read body for methods that typically have one and if Content-Length is present or detectable
  // Note: Deno's Request object provides `body` which is a ReadableStream for actual requests.
  // If the method is not GET/HEAD/OPTIONS and there is a body (or Content-Length), then read it.
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && (contentLength !== undefined && contentLength > 0)) {
      try {
          body = await req.arrayBuffer(); // 读取请求体为 ArrayBuffer
      } catch (e) {
          console.error(`[${requestId}] 错误：读取请求体时发生错误: ${e}`);
          return new Response("Internal Server Error while reading request body", { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
      }
  }


  // --- 6. 发送实际的请求到 Gemini API ---
  const startTime = Date.now(); // 记录请求开始时间
  let geminiResponse: Response;
  try {
    geminiResponse = await fetch(targetUrl, {
      method: req.method, // 使用与原始请求相同的 HTTP 方法
      headers: forwardHeaders, // 使用准备好的 Headers
      body: body ?? undefined, // 设置请求体 (如果存在)
    });
  } catch (error: any) {
      console.error(`[${requestId}] 错误：调用 Gemini API 时发生网络错误: ${error.message}`);
      return new Response(
          JSON.stringify({
              error: "代理未能连接到 Gemini API",
              details: error.message,
          }),
          {
              status: 500,
              headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
              },
          }
      );
  }
  const responseTime = Date.now() - startTime; // 计算响应时间

  console.log(`[${requestId}] Gemini API 响应状态: ${geminiResponse.status} (${responseTime}ms)`);

  // 如果 Gemini API 返回 429 状态码（速率限制），记录警告信息
  if (geminiResponse.status === 429) {
    console.warn(`[${requestId}] ⚠️ Gemini API Key 触发了速率限制 (状态码: ${geminiResponse.status})。`);
  }

  // --- 7. 准备并返回响应给客户端 ---
  const responseHeaders = new Headers(); // 创建一个新的 Headers 对象来存储要返回的响应 Headers
  // 定义需要复制给客户端的Headers
  const headersToReturn = [
    "Content-Type",
    "Content-Length", // 注意：如果响应是流式的，Content-Length 可能不存在或不准确
    "Content-Encoding",
    "Transfer-Encoding", // 对于流式响应，Transfer-Encoding 通常是 chunked
    "X-Server-Timing" // Google API 有时会返回这个，可以转发
  ];

  // 复制必要的 Headers
  for (const header of headersToReturn) {
    const value = geminiResponse.headers.get(header);
    if (value) {
      responseHeaders.set(header, value);
    }
  }

  // 添加 CORS 和诊断用的 Headers
  responseHeaders.set("Access-Control-Allow-Origin", "*"); // 允许所有来源接收响应
  responseHeaders.set("X-Request-ID", requestId); // 代理生成的请求 ID，方便查找日志
  responseHeaders.set("X-Gemini-ApiKey-Source", geminiApiKeySource); // 告知客户端使用的是哪个来源的API Key

  // --- 处理流式响应 vs. 普通响应 ---
  const contentType = geminiResponse.headers.get("Content-Type")?.toLowerCase();
  // 检查 Content-Type 是否包含 "stream" 字样（例如 text/event-stream）
  // 或者检查 URL 参数是否有 ?alt=sse (Server-Sent Events)
  const isStreamingResponse = contentType?.includes("stream") || url.searchParams.get("alt") === "sse";

  if (isStreamingResponse && geminiResponse.body) {
    // console.log(`[${requestId}] 返回流式响应。`);
    // 直接返回 Response Stream，Deno Deploy 会负责处理。
    return new Response(geminiResponse.body, {
      status: geminiResponse.status,
      headers: responseHeaders,
    });
  } else {
    // 对于非流式响应，读取响应体并返回
    try {
      const responseBody = await geminiResponse.arrayBuffer(); // 读取响应体为 ArrayBuffer
      // console.log(`[${requestId}] 响应体大小: ${responseBody.byteLength} bytes`);

      // 如果 Gemini API 返回错误状态码 (4xx 或 5xx)，记录详细信息
      if (geminiResponse.status >= 400) {
        const errorText = new TextDecoder().decode(responseBody); // 解码响应体为文本
        // 截断过长的错误信息，以免日志过多
        console.error(`[${requestId}] Gemini API 返回了错误: ${errorText.substring(0, 500)}`);
      }

      // 返回处理好的响应
      return new Response(responseBody, {
        status: geminiResponse.status,
        headers: responseHeaders,
      });
    } catch (error: any) {
      console.error(`[${requestId}] 错误：处理 Gemini API 非流式响应时发生错误: ${error.message}`);
      return new Response(
        JSON.stringify({
          error: "代理内部错误：无法处理 Gemini API 响应",
          details: error.message,
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
  }
}

console.log("Gemini API 代理服务器已准备就绪，等待连接...");
// 启动 Deno HTTP 服务器，监听所有请求并使用 handler 函数处理
serve(handler);

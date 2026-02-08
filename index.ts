import { startServer, checkCredentials } from "./src/server";
import { getConfig } from "./src/config";
import { isOpenAIPassthroughEnabled } from "./src/openai-passthrough";

const config = getConfig();
const server = startServer();

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                 Claude Code Proxy v2                          ║
╠═══════════════════════════════════════════════════════════════╣
║  Transparent proxy with Cursor-native context management.     ║
║  Routes through Claude Code subscription, falls back to API.  ║
╚═══════════════════════════════════════════════════════════════╝
`);

console.log(`🚀 Server running at http://localhost:${server.port}`);
console.log(`   Anthropic:  http://localhost:${server.port}/v1/messages`);
console.log(
  `   OpenAI:     http://localhost:${server.port}/v1/chat/completions`
);

await checkCredentials();

if (isOpenAIPassthroughEnabled()) {
  console.log(`✓ OpenAI passthrough enabled → ${config.openaiBaseUrl}`);
} else {
  console.log("⚠️  No OPENAI_API_KEY (non-Claude models will fail)");
}

if (process.env.VERBOSE_LOGGING === "true") {
  console.log(`\n📝 Verbose file logging enabled → api.log (gitignored)\n`);
} else {
  console.log(`\n📝 Verbose file logging disabled (set VERBOSE_LOGGING=true to enable)\n`);
}

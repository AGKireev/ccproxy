import { startServer, checkCredentials } from "./src/server";
import { getConfig } from "./src/config";
import { isOpenAIPassthroughEnabled } from "./src/openai-passthrough";

const config = getConfig();
const server = startServer();

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                 Claude Code Proxy (CCProxy)                   ║
╠═══════════════════════════════════════════════════════════════╣
║  Smart proxy with server-side compaction for Opus 4.6.        ║
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

if (config.compactionEnabled) {
  console.log(`✓ Server-side compaction enabled (trigger: ${config.compactionTriggerTokens} tokens, Opus 4.6+ only)`);
} else {
  console.log("⚠️  Server-side compaction disabled (set COMPACTION_ENABLED=true to enable)");
}

if (config.tokenInflationEnabled) {
  console.log(`✓ Token inflation enabled (×4.36 — for MAX Mode ON / 872K denominator)`);
} else {
  console.log(`✓ Token inflation disabled (for MAX Mode OFF / 200K denominator — raw tokens are truthful)`);
}

if (process.env.VERBOSE_LOGGING === "true") {
  console.log(`\n📝 Verbose file logging enabled → api.log (gitignored)\n`);
} else {
  console.log(`\n📝 Verbose file logging disabled (set VERBOSE_LOGGING=true to enable)\n`);
}

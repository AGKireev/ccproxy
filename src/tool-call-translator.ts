/**
 * Tool Call Translator
 * Translates Claude Code's tool call format to Cursor's expected format
 */

// Map of common incorrect parameter names to correct ones
const PARAMETER_NAME_MAP: Record<string, string> = {
  path: "target_file",
  file: "target_file",
  filepath: "target_file",
  filename: "target_file",
  query: "query",
  pattern: "pattern",
  search_query: "query",
};

/**
 * Translates tool calls from Claude Code format to Cursor format
 * 
 * Fixes:
 * - Removes <function_calls> wrapper tags (with all variations)
 * - Converts incorrect tool tags (<search_files>, <read_file>, etc.) to <invoke> format
 * - Fixes incorrect parameter names (e.g., "path" -> "target_file")
 * - Ensures proper <invoke> tag format
 * - Handles multi-line and partial tool calls
 */
export function translateToolCalls(text: string): string {
  let translated = text;

  // More aggressive removal of <function_calls> wrapper tags
  translated = translated.replace(/<function_calls>\s*/gi, "");
  translated = translated.replace(/\s*<\/function_calls>/gi, "");
  translated = translated.replace(/<function_calls\s*\/>/gi, "");

  // Convert <search_files> to <invoke name="codebase_search">
  // Handle multiline format: <search_files>\n<path>...</path>\n<regex>...</regex>\n<file_pattern>...</file_pattern>\n</search_files>
  translated = translated.replace(
    /<search_files>\s*\n?\s*<path>([^<]+)<\/path>\s*\n?\s*<regex>([^<]+)<\/regex>\s*\n?\s*<file_pattern>([^<]+)<\/file_pattern>\s*\n?\s*<\/search_files>/gis,
    (match, path, regex, filePattern) => {
      const query = `files matching pattern ${filePattern.trim()} in ${path.trim()} with regex ${regex.trim()}`;
      return `<invoke name="codebase_search">
<parameter name="query">${query}</parameter>
<parameter name="target_directories">[]</parameter>
</invoke>`;
    }
  );

  // Also handle search_files with just path and regex (no file_pattern)
  translated = translated.replace(
    /<search_files>\s*\n?\s*<path>([^<]+)<\/path>\s*\n?\s*<regex>([^<]+)<\/regex>\s*\n?\s*<\/search_files>/gis,
    (match, path, regex) => {
      const query = `files in ${path.trim()} matching regex ${regex.trim()}`;
      return `<invoke name="codebase_search">
<parameter name="query">${query}</parameter>
<parameter name="target_directories">[]</parameter>
</invoke>`;
    }
  );

  // Convert <read_file> to <invoke name="read_file">
  // Handle multiline format: <read_file>\n<path>...</path>\n<start_line>...</start_line>\n<end_line>...</end_line>\n</read_file>
  translated = translated.replace(
    /<read_file>\s*\n?\s*<path>([^<]+)<\/path>(?:\s*\n?\s*<start_line>(\d+)<\/start_line>)?(?:\s*\n?\s*<end_line>(\d+)<\/end_line>)?\s*\n?\s*<\/read_file>/gis,
    (match, path, startLine, endLine) => {
      let result = `<invoke name="read_file">
<parameter name="target_file">${path.trim()}</parameter>`;
      if (startLine) {
        result += `\n<parameter name="offset">${startLine}</parameter>`;
        if (endLine) {
          const limit = parseInt(endLine) - parseInt(startLine) + 1;
          result += `\n<parameter name="limit">${limit}</parameter>`;
        }
      }
      result += `\n</invoke>`;
      return result;
    }
  );

  // Also handle read_file with just path (no line numbers)
  translated = translated.replace(
    /<read_file>\s*\n?\s*<path>([^<]+)<\/path>\s*\n?\s*<\/read_file>/gis,
    (match, path) => {
      return `<invoke name="read_file">
<parameter name="target_file">${path.trim()}</parameter>
</invoke>`;
    }
  );

  // Convert <grep> to <invoke name="grep"> (if it exists in wrong format)
  translated = translated.replace(
    /<grep>\s*\n?\s*<pattern>([^<]+)<\/pattern>\s*\n?\s*<path>([^<]+)<\/path>\s*\n?\s*<\/grep>/gis,
    (match, pattern, path) => {
      return `<invoke name="grep">
<parameter name="pattern">${pattern.trim()}</parameter>
<parameter name="path">${path.trim()}</parameter>
</invoke>`;
    }
  );

  // Fix common parameter name issues in existing <invoke> tags
  for (const [incorrect, correct] of Object.entries(PARAMETER_NAME_MAP)) {
    translated = translated.replace(
      new RegExp(`<parameter\\s+name=["']${incorrect}["']>`, "gi"),
      `<parameter name="${correct}">`
    );
    translated = translated.replace(
      new RegExp(`<parameter\\s+name=['"]${incorrect}['"]>`, "gi"),
      `<parameter name="${correct}">`
    );
  }

  // Clean up whitespace
  translated = translated.replace(/\n\s*\n\s*\n+/g, "\n\n");
  const lines = translated.split("\n");
  translated = lines.map((line) => line.trimEnd()).join("\n").trim();

  return translated;
}

/**
 * Checks if text contains tool calls that need translation
 */
export function needsTranslation(text: string): boolean {
  // Check for common incorrect patterns
  return (
    /<function_calls/i.test(text) ||
    /<\/function_calls>/i.test(text) ||
    /<parameter\s+name=["'](path|file|filepath|filename)["']>/i.test(text) ||
    /<search_files/i.test(text) ||
    /<read_file/i.test(text) ||
    /<\/search_files>/i.test(text) ||
    /<\/read_file>/i.test(text) ||
    /<grep>/i.test(text) ||
    /<\/grep>/i.test(text)
  );
}


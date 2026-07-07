export const SANITIZED_MESSAGE_MAX_LENGTH = 512;

export interface SanitizeContext {
  homeDir: string;
  corpusDir: string;
}

const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;
const KEY_VALUE_SECRET = /\b(token|api[_-]?key|access[_-]?token|secret|password|authorization)=([^&\s]+)/gi;
const KNOWN_SECRET_PREFIX = /\b(ghp_|gho_|ghs_|xoxb-|xoxp-|sk-)[A-Za-z0-9_-]+/g;

// Scrubs a tool_error message before it is written to the event log AND before it is handed to the
// LLM. Narrow by design: there is no generic long-alphanumeric rule because ULIDs and commit hashes
// legitimately appear in error text (e.g. "supersede target does not exist: <ULID>") and must survive.
export function sanitizeToolErrorMessage(message: string, context: SanitizeContext): string {
  const withoutCorpus = message.split(context.corpusDir).join("<corpus>");
  const withoutHome = withoutCorpus.split(context.homeDir).join("~");
  const withoutUserinfo = withoutHome.replace(URL_USERINFO, "$1");
  const withoutKeyValueSecrets = withoutUserinfo.replace(KEY_VALUE_SECRET, "$1=<redacted>");
  const withoutKnownSecrets = withoutKeyValueSecrets.replace(KNOWN_SECRET_PREFIX, "<redacted>");
  return truncate(withoutKnownSecrets);
}

function truncate(message: string): string {
  if (message.length <= SANITIZED_MESSAGE_MAX_LENGTH) {
    return message;
  }
  return message.slice(0, SANITIZED_MESSAGE_MAX_LENGTH) + "…";
}

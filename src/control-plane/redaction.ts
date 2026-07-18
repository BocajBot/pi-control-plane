/**
 * Deterministic secret redaction for context inspection.
 *
 * Pattern-based redaction reduces risk but cannot guarantee that every secret
 * is identified. That limitation is documented in docs/SECURITY.md and in the
 * warning printed before detailed context output.
 *
 * Ordering matters: multi-line and high-specificity patterns run before
 * generic assignment patterns so that specific categories win.
 */

export interface RedactionResult {
  text: string;
  /** Category -> number of replacements. */
  redactions: Record<string, number>;
  total: number;
}

interface RedactionRule {
  category: string;
  pattern: RegExp;
  /** Replacement; may reference capture groups to preserve key names. */
  replacement: string;
}

const RULES: RedactionRule[] = [
  {
    category: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED:private-key]",
  },
  {
    category: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
    replacement: "[REDACTED:jwt]",
  },
  {
    category: "anthropic-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
    replacement: "[REDACTED:anthropic-key]",
  },
  {
    category: "openai-key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
    replacement: "[REDACTED:openai-key]",
  },
  {
    category: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    replacement: "[REDACTED:github-token]",
  },
  {
    category: "aws-key-id",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED:aws-key-id]",
  },
  {
    category: "authorization-header",
    pattern: /\b(authorization)(\s*[:=]\s*)[^\r\n]{4,}/gi,
    replacement: "$1$2[REDACTED:authorization-header]",
  },
  {
    category: "cookie-header",
    pattern: /\b(cookie|set-cookie)(\s*:\s*)[^\r\n]{4,}/gi,
    replacement: "$1$2[REDACTED:cookie-header]",
  },
  {
    category: "bearer-token",
    pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replacement: "[REDACTED:bearer-token]",
  },
  {
    category: "password",
    pattern:
      /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd)[A-Za-z0-9_.-]*)(\s*[:=]\s*)["']?[^\s"']{3,}["']?/gi,
    replacement: "$1$2[REDACTED:password]",
  },
  {
    category: "env-secret",
    pattern:
      /\b([A-Z0-9_]*(?:SECRET|TOKEN|API_?KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET)[A-Z0-9_]*)(\s*=\s*)["']?[^\s"']{6,}["']?/g,
    replacement: "$1$2[REDACTED:env-secret]",
  },
  {
    category: "generic-credential",
    pattern:
      /\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|auth[_-]?token|access[_-]?token|client[_-]?secret|refresh[_-]?token)[A-Za-z0-9_.-]*)(\s*[:=]\s*)["']?[^\s"']{6,}["']?/gi,
    replacement: "$1$2[REDACTED:credential]",
  },
];

export function redactSecrets(text: string): RedactionResult {
  let output = text;
  const redactions: Record<string, number> = {};
  let total = 0;
  for (const rule of RULES) {
    let count = 0;
    output = output.replace(rule.pattern, (...args) => {
      count++;
      // Rebuild replacement with capture groups when the rule uses them.
      if (rule.replacement.includes("$1")) {
        const groups = args.slice(1, -2) as string[];
        return rule.replacement
          .replace("$1", groups[0] ?? "")
          .replace("$2", groups[1] ?? "");
      }
      return rule.replacement;
    });
    if (count > 0) {
      redactions[rule.category] = (redactions[rule.category] ?? 0) + count;
      total += count;
    }
  }
  return { text: output, redactions, total };
}

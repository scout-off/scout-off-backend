'use strict';

/**
 * jsdocTags.js
 *
 * Parses the canonical route-documentation comment format described in
 * docs/API_DOCUMENTATION.md. A comment block may document a single
 * operation, or several operations on the same `router.route(path)` chain
 * (existing convention in this codebase: one block with an embedded
 * "METHOD /path" header per operation). This module splits a raw JSDoc
 * comment into per-method segments and parses the tags in each.
 *
 * Recognised tags: @summary, @param, @query, @header, @body, @response,
 * @auth, @tag, @deprecated. Anything else (including free text before the
 * first tag) is treated as the operation description.
 *
 * @auth is intentionally NOT used to compute the generated spec's actual
 * `security` requirement — that is derived mechanically from the real
 * middleware chain in scripts/lib/docgen/security.js, which cannot drift
 * from the code the way a hand-written tag can. @auth is preserved as a
 * human-readable supplementary note only (`x-auth-note` in the output).
 */

const METHOD_HEADER = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)/i;
const TAG_LINE = /^@(\w+)\s?(.*)$/;

/**
 * Strip `/** ... *\/` delimiters and leading ` * ` from each line.
 */
function stripCommentSyntax(raw) {
  let text = raw.trim();
  if (text.startsWith('/**')) text = text.slice(3);
  if (text.endsWith('*/')) text = text.slice(0, -2);
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();
}

/**
 * Split a raw comment into segments keyed by HTTP method. A block with no
 * embedded "METHOD /path" headers produces a single segment under key
 * `'*'`, applying to whichever operation it's attached to.
 */
function splitByMethod(commentText) {
  const lines = commentText.split('\n');
  const segments = [];
  let current = { method: '*', lines: [] };

  for (const line of lines) {
    const headerMatch = line.trim().match(METHOD_HEADER);
    if (headerMatch) {
      if (current.lines.some((l) => l.trim().length > 0)) segments.push(current);
      current = { method: headerMatch[1].toUpperCase(), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  segments.push(current);

  return segments.filter((s) => s.lines.some((l) => l.trim().length > 0) || s.method !== '*');
}

/**
 * Parse tags + description out of a segment's lines.
 */
function parseSegment(lines) {
  const doc = {
    description: '',
    summary: undefined,
    params: [],
    query: [],
    headers: [],
    body: undefined,
    responses: [],
    authNote: undefined,
    tagOverride: undefined,
    deprecated: undefined,
  };

  const descriptionLines = [];
  let currentTag = null;
  let currentBuffer = [];

  const flush = () => {
    if (!currentTag) return;
    const text = currentBuffer.join('\n').trim();
    switch (currentTag) {
      case 'summary':
        doc.summary = text;
        break;
      case 'param': {
        const parsed = parseNamedParam(text);
        if (parsed) doc.params.push(parsed);
        break;
      }
      case 'query': {
        const parsed = parseNamedParam(text);
        if (parsed) doc.query.push(parsed);
        break;
      }
      case 'header': {
        const parsed = parseNamedParam(text);
        if (parsed) doc.headers.push(parsed);
        break;
      }
      case 'body':
        doc.body = text;
        break;
      case 'response': {
        const parsed = parseResponse(text);
        if (parsed) doc.responses.push(parsed);
        break;
      }
      case 'auth':
        doc.authNote = text;
        break;
      case 'tag':
        doc.tagOverride = text.trim();
        break;
      case 'deprecated':
        doc.deprecated = text || 'Deprecated.';
        break;
      default:
        break;
    }
    currentTag = null;
    currentBuffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const tagMatch = line.trim().match(TAG_LINE);
    if (tagMatch) {
      flush();
      currentTag = tagMatch[1].toLowerCase();
      currentBuffer = [tagMatch[2]];
    } else if (currentTag) {
      currentBuffer.push(line);
    } else {
      descriptionLines.push(line);
    }
  }
  flush();

  doc.description = descriptionLines.join('\n').trim();
  if (!doc.summary) {
    doc.summary = deriveSummary(doc.description);
  }

  return doc;
}

function parseNamedParam(text) {
  // `name {type} - description` or `name {type} description`
  const m = text.match(/^(\S+)\s*(?:\{([^}]*)\})?\s*-?\s*(.*)$/s);
  if (!m) return null;
  return { name: m[1], type: (m[2] || 'string').trim(), description: (m[3] || '').trim() };
}

function parseResponse(text) {
  const m = text.match(/^(\d{3})\s*(.*)$/s);
  if (!m) return null;
  return { status: m[1], description: m[2].trim() };
}

function deriveSummary(description) {
  if (!description) return undefined;

  // Join the first paragraph (up to the first blank line) into one string
  // before sentence-splitting — a wrapped source line with no terminal
  // punctuation must not be mistaken for a complete sentence.
  const lines = description.split('\n');
  const firstParagraphLines = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      if (firstParagraphLines.length > 0) break;
      continue;
    }
    firstParagraphLines.push(line.trim());
  }
  const firstParagraph = firstParagraphLines.join(' ');

  const sentence = firstParagraph.split(/(?<=[.!?])\s/)[0] || firstParagraph;
  const trimmed = sentence.trim().replace(/\s+/g, ' ');
  return trimmed.length > 140 ? `${trimmed.slice(0, 137)}...` : trimmed || undefined;
}

/**
 * @param {string|null} rawComment raw `/** ... *\/` text, or null if the route has no leading comment
 * @param {string} method HTTP method of the operation being documented
 * @returns parsed doc for that method, or a mostly-empty doc if undocumented
 */
function docFor(rawComment, method) {
  if (!rawComment) {
    return parseSegment([]);
  }
  const stripped = stripCommentSyntax(rawComment);
  const segments = splitByMethod(stripped);

  const methodSegment = segments.find((s) => s.method === method.toUpperCase());
  if (methodSegment) return parseSegment(methodSegment.lines);

  // Single-segment block with no per-method headers (single-operation route)
  const wildcard = segments.find((s) => s.method === '*');
  if (wildcard && segments.length === 1) return parseSegment(wildcard.lines);

  return parseSegment([]);
}

module.exports = { docFor, stripCommentSyntax, splitByMethod, parseSegment };

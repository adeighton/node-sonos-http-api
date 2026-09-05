import { Readable } from 'node:stream';

import flow from 'xml-flow';

/**
 * Thin, typed wrapper around xml-flow (a streaming SAX-based parser).
 *
 * xml-flow lowercases tag and attribute names and "simplifies" nodes: an element with only text
 * becomes a string, an element with only attributes becomes its attribute object, and an element
 * with both keeps `$attrs` and `$text`. Repeated children become arrays when `useArrays` is
 * SOMETIMES (the default). Every consumer in this package was written against that shape, and the
 * JSON fixtures under test/fixtures capture it verbatim.
 *
 * xml-flow is pinned to exactly 1.0.2 in package.json: 1.0.3+ collapses an element with a single
 * attribute (`<TransportState val="PLAYING"/>`) to the bare value string, which silently breaks
 * every `.val` lookup below. `nodeValue()` tolerates both shapes as a safety net.
 */

export interface XmlNode {
  $name?: string;
  $attrs?: Record<string, string>;
  $text?: string;
  [child: string]: unknown;
}

export type XmlInput = string | Readable;

export const XML_ARRAYS = Object.freeze({
  NEVER: flow.NEVER,
  SOMETIMES: flow.SOMETIMES,
  ALWAYS: flow.ALWAYS,
} as const);

/**
 * Only the two options this package relies on are exposed. sax's `strict` mode is deliberately
 * unavailable: xml-flow 1.0.2 pipes into a parser object without `destroy()`, so a strict-mode
 * parse error escalates into an uncaught TypeError that kills the process.
 */
export interface XmlParseOptions {
  preserveMarkup?: flow.parserOptions['preserveMarkup'];
  useArrays?: flow.parserOptions['useArrays'];
}

export type XmlTagHandler = (node: XmlNode) => void;

function toStream(input: XmlInput): Readable {
  return typeof input === 'string' ? Readable.from([input]) : input;
}

/**
 * Parses `input`, calling `handlers[tag]` for every element named `tag` (lowercase, no
 * `tag:` prefix). Resolves once the whole document has been read, rejects on a parse error.
 */
export function parseXmlEvents(
  input: XmlInput,
  handlers: Record<string, XmlTagHandler>,
  options: XmlParseOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = toStream(input);
    const parser = flow(stream, options);
    for (const [tag, handler] of Object.entries(handlers)) {
      parser.on(`tag:${tag}`, handler);
    }

    const fail = (error: unknown): void => {
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    parser.on('end', () => resolve());
    parser.on('error', fail);
    // xml-flow does not forward source errors (a NOTIFY request dying mid-body would otherwise
    // leave this promise pending forever).
    stream.on('error', fail);
  });
}

/** Collects every element named `tag` in document order. */
export async function collectXmlTags(
  input: XmlInput,
  tag: string,
  options?: XmlParseOptions,
): Promise<XmlNode[]> {
  const nodes: XmlNode[] = [];
  await parseXmlEvents(input, { [tag]: (node) => nodes.push(node) }, options);
  return nodes;
}

/** Returns the first element named `tag`, or `undefined` when the document has none. */
export async function firstXmlTag(
  input: XmlInput,
  tag: string,
  options?: XmlParseOptions,
): Promise<XmlNode | undefined> {
  const nodes = await collectXmlTags(input, tag, options);
  return nodes[0];
}

/** The text of a simplified node: a plain string, or the `$text` of a node with attributes. */
export function nodeText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' && value !== null && '$text' in value) {
    const text = (value as XmlNode).$text;
    return typeof text === 'string' ? text : undefined;
  }

  return undefined;
}

/**
 * The attributes of a simplified node: `$attrs` when present, otherwise the node itself when it
 * was reduced to its attribute object (an element with attributes but no content).
 */
export function nodeAttrs(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }

  const node = value as XmlNode;
  if (node.$attrs) {
    return node.$attrs;
  }

  const attrs: Record<string, string> = {};
  for (const [key, child] of Object.entries(node)) {
    if (typeof child === 'string' && !key.startsWith('$')) {
      attrs[key] = child;
    }
  }

  return attrs;
}

/**
 * The `val` attribute of a UPnP LastChange element such as `<Volume channel="Master" val="12"/>`,
 * accepting both the attribute-object shape and a bare string.
 */
export function nodeValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  return nodeAttrs(value).val;
}

/** Normalizes xml-flow's "one child is an object, many are an array" shape to an array. */
export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

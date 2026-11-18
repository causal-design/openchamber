import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { parseMarkdownIntoBlocks } from 'streamdown';
import { remarkMathCompatibility } from './remarkMathCompatibility';

const parser = unified().use(remarkParse).use(remarkMathCompatibility);
// Delimiter candidates only. The actual parser validates Markdown context.
const opener = /^\uFEFF? {0,3}\\\[[\t ]*(?:\n|$)/;
const closer = /(?:^|\n)[\t ]*\\\][\t ]*(?:\n|$)/;

export function splitMarkdownMathBlocks(source: string): string[] {
  const blocks = parseMarkdownIntoBlocks(source);
  if (blocks.length < 2 || !source.includes('\\[')) return blocks;
  const merged: string[] = [];
  for (let first = 0; first < blocks.length; first++) {
    if (!opener.test(blocks[first])) { merged.push(blocks[first]); continue; }
    let last = first;
    // Do not concatenate or parse an incomplete candidate, even in a long reply.
    for (; last < blocks.length; last++) {
      if (last > first && opener.test(blocks[last])) break;
      if (closer.test(blocks[last])) break;
    }
    if (last === first || last === blocks.length || !closer.test(blocks[last])) {
      merged.push(blocks[first]);
      continue;
    }
    const fragment = blocks.slice(first, last + 1).join('');
    const bom = fragment.startsWith('\uFEFF') ? 1 : 0;
    // The candidate starts at its opener and stops at its first closer. Only
    // its first top-level math node can cross the collected native boundaries.
    const math = parser.parse(fragment.slice(bom)).children[0];
    const start = math?.position?.start.offset;
    const end = math?.position?.end.offset;
    const range = math?.type === 'math' && start !== undefined && end !== undefined
      && fragment.startsWith('\\[', start + bom) ? { start: start + bom, end: end + bom } : undefined;
    let offset = 0;
    for (let i = first; i <= last; i++) {
      if (range && range.start < offset && offset < range.end) merged[merged.length - 1] += blocks[i];
      else merged.push(blocks[i]);
      offset += blocks[i].length;
    }
    first = last;
  }
  return merged;
}

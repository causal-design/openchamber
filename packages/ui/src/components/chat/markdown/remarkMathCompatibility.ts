import type { Root, RootContent } from 'mdast';
import type { InlineMath, Math as MathNode } from 'mdast-util-math';
import type { Processor } from 'unified';
import type { Tokenizer, Construct, Code, State } from 'micromark-util-types';
import type { Extension } from 'mdast-util-from-markdown';
import type {} from 'remark-parse';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    ocMath: 'ocMath';
    ocMathFlow: 'ocMathFlow';
    ocMathMarker: 'ocMathMarker';
    ocMathValue: 'ocMathValue';
  }
}

// Flow protects complete displays before CommonMark classifies their lines.
// Text constructs keep code and link destinations under CommonMark's parser.
// Bracket math must occupy its own line so escaped bracket prose stays prose.
// "Own line" is relative to its container: a list item or a quote starts its
// text after the marker, so the line start is the start of the text flow or a
// line ending, never an absolute column.
function backslashMathTokenizer(flow: boolean): Tokenizer {
  return function (effects, ok, nok) {
    if (flow && this.interrupt) return nok;
    const tokenType = flow ? 'ocMathFlow' : 'ocMath';
    const lineStart = this.previous === null || this.previous < -2;
    let bracket = false;
    let hasContent = false;
    let inValue = false;
    function start(code: Code) {
      effects.enter(tokenType);
      effects.enter('ocMathMarker');
      effects.consume(code);
      return opening;
    }
    function opening(code: Code) {
      if (code !== 40 && code !== 91) return nok(code);
      if (flow && code !== 91) return nok(code);
      bracket = code === 91;
      if (bracket && !flow && !lineStart) return nok(code);
      effects.consume(code);
      effects.exit('ocMathMarker');
      return inside;
    }
    function inside(code: Code): State | undefined {
      if (code === null) return nok(code);
      if (code === 92) return effects.check(close, closing, flow ? escapedSlash : content)(code);
      return content(code);
    }
    function content(code: Code) {
      hasContent = true;
      if (code !== null && code <= -3) {
        if (inValue) { effects.exit('ocMathValue'); inValue = false; }
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
        return flow ? continuation : inside;
      }
      if (!inValue) { effects.enter('ocMathValue'); inValue = true; }
      effects.consume(code);
      return inside;
    }
    const continuation = (code: Code) =>
      this.parser.lazy[this.now().line] ? nok(code) : inside(code);
    function escapedSlash(code: Code) {
      hasContent = true;
      if (!inValue) { effects.enter('ocMathValue'); inValue = true; }
      effects.consume(code);
      return afterSlash;
    }
    function afterSlash(code: Code): State | undefined {
      if (code === 91) return nok(code);
      if (code === 92) { effects.consume(code); return inside; }
      return inside(code);
    }
    const close: Construct = { tokenize(closeEffects, closeOk, closeNok) {
      return slash;
      function slash(code: Code) {
        closeEffects.enter('ocMathMarker');
        closeEffects.consume(code);
        return marker;
      }
      function marker(code: Code) {
        if (!hasContent || code !== (bracket ? 93 : 41)) return closeNok(code);
        closeEffects.consume(code);
        return bracket && !flow ? lineEnd : checked;
      }
      function lineEnd(code: Code): State | undefined {
        if (code === 32 || code === 9) { closeEffects.consume(code); return lineEnd; }
        return code === null || code < 0 ? checked(code) : closeNok(code);
      }
      function checked(code: Code) {
        closeEffects.exit('ocMathMarker');
        return closeOk(code);
      }
    } };
    function closing(code: Code) {
      if (inValue) { effects.exit('ocMathValue'); inValue = false; }
      effects.enter('ocMathMarker');
      effects.consume(code);
      return endMarker;
    }
    function endMarker(code: Code) {
      effects.consume(code);
      effects.exit('ocMathMarker');
      effects.exit(tokenType);
      return flow ? trailing : ok;
    }
    function trailing(code: Code): State | undefined {
      if (code === 32 || code === -2 || code === -1) {
        effects.enter('whitespace');
        effects.consume(code);
        effects.exit('whitespace');
        return trailing;
      }
      return code === null || code <= -3 ? ok(code) : nok(code);
    }
    return start;
  };
}

// Guard single-dollar syntax before it can consume Markdown link punctuation.
// Post-parse currency rejection is too late once a pair spans a link label.
const tokenizeDollarMath: Tokenizer = function (effects, ok, nok) {
  const previous = this.previous;
  const angleConstructs = this.parser.constructs.text[60];
  let value = '';
  return start;
  function start(code: number | null) {
    if (previous !== null && previous >= 48 && previous <= 57) return nok(code);
    effects.enter('ocMath');
    effects.consume(code);
    return inside;
  }
  function inside(code: number | null): State | undefined {
    if (code === null || code < 0 || code === 34) return nok(code);
    if (code === 60 && angleConstructs) return effects.check(angleConstructs, nok, content)(code);
    // A real Markdown link boundary ends a candidate; interval brackets and
    // comparison operators remain valid math content.
    if (code === 40 && value.endsWith(']')) return nok(code);
    if (!value && /\s/.test(String.fromCharCode(code))) return nok(code);
    if (code === 36) {
      if (!value || /^\s|\s$/.test(value) || /^[\d.,\s]+$/.test(value)
        || /^\d[\d.,]*(?:[;:]|\s+(?:and|to)\b)/.test(value)) return nok(code);
      effects.consume(code);
      return after;
    }
    return content(code);
  }
  function content(code: Code) {
    if (code === null) return nok(code);
    value += String.fromCharCode(code);
    effects.consume(code);
    return inside;
  }
  function after(code: number | null) {
    if (code !== null && code >= 48 && code <= 57) return nok(code);
    effects.exit('ocMath');
    return ok(code);
  }
};

const fromMarkdown: Extension = {
  enter: {
    ocMathFlow(token) {
      this.enter({ type: 'math', meta: null, value: '', data: {
        hName: 'pre', hChildren: [{ type: 'element', tagName: 'code',
          properties: { className: ['language-math', 'math-display'] }, children: [] }],
      } }, token);
    },
    ocMath(token) {
      const display = this.sliceSerialize(token).startsWith('\\[');
      this.enter({ type: 'inlineMath', value: '', data: {
        hName: 'code', hProperties: { className: ['language-math', display ? 'math-display' : 'math-inline'] },
        hChildren: [],
      } }, token);
    },
  },
  exit: {
    ocMathFlow(token) {
      const value = this.sliceSerialize(token).slice(2, -2);
      const node = this.stack[this.stack.length - 1];
      if (node.type === 'math') {
        node.value = value;
        const code = node.data?.hChildren?.[0];
        if (code?.type === 'element') code.children = [{ type: 'text', value }];
      }
      this.exit(token);
    },
    ocMath(token) {
      const raw = this.sliceSerialize(token);
      const width = raw.startsWith('$') ? 1 : 2;
      const value = raw.slice(width, -width);
      const node = this.stack[this.stack.length - 1];
      if (node.type === 'inlineMath') {
        node.value = value;
        if (node.data) node.data.hChildren = [{ type: 'text', value }];
      }
      this.exit(token);
    },
  },
};

function dollarMathIsFormula(node: InlineMath | MathNode, source: string): boolean {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (start === undefined || end === undefined) return true;
  const raw = source.slice(start, end);
  if (!raw.startsWith('$') || raw.startsWith('$$')) return true;
  return !/^[\d.,\s]+$/.test(node.value)
    && !/^\s|\s$/.test(node.value)
    && !/\d/.test(source.slice(end, end + 1));
}

export function remarkMathCompatibility(this: Processor) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push({ flow: {
    92: { name: 'ocMathFlow', tokenize: backslashMathTokenizer(true), concrete: true },
  }, text: {
    92: { name: 'ocMath', tokenize: backslashMathTokenizer(false) },
    36: { name: 'ocDollarMath', tokenize: tokenizeDollarMath },
  } });
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);
  return (tree: Root, file: { toString(): string }) => {
    const source = file.toString();
    function transform(node: Root | RootContent): void {
      if (!('children' in node)) return;
      const children: RootContent[] = node.children;
      // CommonMark parses explicit link labels as inline Markdown. A URL label
      // must remain a readable URL even when it contains valid math delimiters.
      if (node.type === 'link') {
        const label = children.map(child => child.type === 'inlineMath' || child.type === 'math'
          ? source.slice(child.position?.start?.offset, child.position?.end?.offset)
          : child.type === 'text' ? child.value : '').join('');
        if (label === node.url) {
          node.children = [{ type: 'text', value: label }];
          return;
        }
      }
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.type === 'inlineMath' || child.type === 'math') {
          const start = child.position?.start?.offset;
          const end = child.position?.end?.offset;
          if (!dollarMathIsFormula(child, source)) {
            children.splice(i, 1, { type: 'text', value: source.slice(start, end) });
          } else if (child.type === 'inlineMath' && source.slice(start, end).startsWith('$$')) {
            child.data ??= {};
            child.data.hProperties = { className: ['language-math', 'math-display'] };
          }
        } else transform(child);
      }
    }
    transform(tree);
  };
}

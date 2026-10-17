const patterns = [
  ['doi', /\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+[A-Za-z0-9/]/g],
  ['arxiv', /\barXiv:\s?\d{4}\.\d{4,5}(?:v\d+)?/gi],
  ['url', /\bhttps?:\/\/[^\s<>"'()]+[^\s<>"'().,;:!?]/g],
];

export default {
  manifest: {
    name: 'citations', version: '1.0.0', apiVersion: 1,
    description: 'Extract URLs, DOIs and arXiv identifiers from a readable page snapshot with exact text offsets',
    permissions: { pageRead: true },
    hooks: { 'page-extract': ['citations'] },
  },
  implementation: {
    hooks: {
      'page-extract': {
        citations(snapshot) {
          const items = [];
          const taken = [];
          for (const [kind, pattern] of patterns) {
            for (const match of snapshot.text.matchAll(pattern)) {
              const start = match.index, end = start + match[0].length;
              // A DOI inside a URL is reported once, as the more specific identifier.
              if (taken.some(([a, b]) => start < b && end > a)) continue;
              taken.push([start, end]);
              items.push({ kind, text: match[0].slice(0, 2000), start, end: start + match[0].slice(0, 2000).length });
              if (items.length >= 1000) return { items: items.sort((a, b) => a.start - b.start) };
            }
          }
          return { items: items.sort((a, b) => a.start - b.start) };
        },
      },
    },
  },
};

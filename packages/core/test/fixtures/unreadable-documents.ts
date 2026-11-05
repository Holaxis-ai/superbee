import { FRONTMATTER_LIMITS } from '../../src/bounded-yaml.js';

/** One agreement table for discovery adapters; none of these documents can be authored now. */
export const unreadableDocuments = [
  { name: 'invalid YAML', source: '---\ntype: [unclosed\n---\nbody\n' },
  { name: 'over-limit frontmatter', source: `---\ntype: Note\ntitle: ${'x'.repeat(FRONTMATTER_LIMITS.sourceChars)}\n---\nbody\n` },
  { name: 'self-reference', source: '---\ntype: Note\ncycle: &cycle [*cycle]\n---\nbody\n' },
] as const;

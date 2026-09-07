import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMarkdown } from '../dist/index.js';
import { JSDOM } from 'jsdom';

const bodies = ['See [target](../docs/target.md).', '[contains](../docs/target.md)'];
for (const body of bodies) {
  test(`host routes apply to ${body.startsWith('See') ? 'inline links' : 'relationship rows'}`, () => {
    const ids = [];
    const result = renderMarkdown(body, { fromId: 'tasks/a', onNavigateDoc() {},
      hrefForDoc(id) { ids.push(id); return `/bundles/research/docs/${encodeURIComponent(id)}`; } });
    const doc = new JSDOM(renderToStaticMarkup(result.element)).window.document;
    assert.deepEqual(ids, ['docs/target']);
    assert.equal(doc.querySelector('a').getAttribute('href'), '/bundles/research/docs/docs%2Ftarget');
  });
}

test('default routes are unchanged and inert rendering never invokes host routing', () => {
  const options = { fromId: 'tasks/a', onNavigateDoc() {} };
  const rendered = renderToStaticMarkup(renderMarkdown(bodies[0], options).element);
  assert.match(rendered, /href="\?view=doc&amp;id=docs%2Ftarget"/);
  const inert = renderToStaticMarkup(renderMarkdown(bodies[0], { ...options, profile: 'inert',
    hrefForDoc() { throw new Error('must not run'); } }).element);
  assert.doesNotMatch(inert, /<a /);
});

test('unsafe host routes are refused, including origin-changing relative forms', () => {
  for (const href of ['javascript:alert(1)', 'https://outside.test/x', '//outside.test', '/\\outside.test', '/\noutside', 'relative/path']) {
    assert.throws(() => renderMarkdown(bodies[0], { fromId: 'tasks/a', onNavigateDoc() {}, hrefForDoc: () => href }),
      /same-origin relative URL/);
  }
});

test('modified clicks retain browser navigation for both link forms', () => {
  function anchors(node) {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(anchors);
    return [...(node.type === 'a' ? [node] : []), ...anchors(node.props?.children)];
  }
  for (const body of bodies) {
    let navigated = 0, prevented = 0;
    const [link] = anchors(renderMarkdown(body, { fromId: 'tasks/a', onNavigateDoc() { navigated++; } }).element);
    const event = { button: 0, preventDefault() { prevented++; } };
    link.props.onClick(event);
    assert.equal(navigated, 1); assert.equal(prevented, 1);
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }])
      link.props.onClick({ ...event, ...modifier });
    assert.equal(navigated, 1); assert.equal(prevented, 1);
  }
});

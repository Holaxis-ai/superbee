import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {checkScenario, missingScenarios, runSourceScenario} from '@superbee/core/source-harness';
import {parseRecipeFiles} from '@superbee/core/recipes';
import {recipeFiles} from '../dist/recipes.mjs';
import {githubIssuesProfile} from './profile.js';
const fixture = JSON.parse(await readFile(new URL('../fixtures/author/fixture.json',import.meta.url),'utf8'));
test('recorded GitHub author subset retains explicit outcomes and reports missing qualification', async () => {
  const recipe = parseRecipeFiles(recipeFiles('work-items'),'packed:work-items',{okfVersion:'0.2'});
  assert.ok(recipe.ok);
  const documents = [...recipe.recipe.docs,...fixture.documents];
  const connector = recipe.recipe.connectors!.find(row=>row.connector.id === fixture.connector)!.connector;
  for (const scenario of fixture.scenarios) {
    const result = await runSourceScenario({connector,profile:githubIssuesProfile,spec:connector.sources.find(source=>source.name===fixture.source),feed:fixture.feed,documents},scenario);
    assert.deepEqual(checkScenario(result),[],scenario.name);
    for (const [index,run] of result.runs.entries()) {
      const expected = scenario.expect[index];
      for (const [key,value] of Object.entries(expected.receipt)) assert.deepEqual(run.receipt[key as keyof typeof run.receipt] ?? null,value,`${scenario.name} receipt.${key}`);
      assert.deepEqual(run.received,expected.requests);
      assert.deepEqual(run.changes,expected.changes);
      assert.deepEqual(run.receipt.findings,expected.findings);
      assert.deepEqual(run.receipt.cursor,expected.cursor);
    }
  }
  assert.deepEqual(missingScenarios(fixture.scenarios.map((row:any)=>row.name)),['errors.malformed','complete.disappear','fields.owned-conflict','fields.unmapped','fields.null','identity.missing','hosts.redirect','hosts.undeclared']);
});

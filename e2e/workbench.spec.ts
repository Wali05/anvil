import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('browser flow: initial state, simulation, drill-down, adapter editing, export, MCP check and narrow layout', async ({ page }) => {
  await mkdir('docs/screenshots', { recursive: true });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Anvil', exact: true })).toBeVisible();
  await expect(page.getByText('Start with a measured comparison.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run with a model' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Explore a simulation' }).first()).toBeVisible();
  await expect(page.getByText('Simulation is a deterministic rehearsal; it is not model evidence.')).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/01-first-run-1440.png', fullPage: false });

  // Run a labelled simulation and wait for the run and its matrix to appear.
  await page.getByRole('button', { name: 'Explore a simulation' }).first().click();
  await expect(page.getByText('Scripted simulation — not model evidence')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Attempt outcomes' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Scripted simulation started. It is a rehearsal, not model evidence.')).toBeVisible();
  await expect(page.locator('.condition-card')).toHaveCount(3);
  await expect(page.locator('.condition-card').nth(0).getByText('7/7')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Paired on the same tasks')).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/02-results-1440.png', fullPage: false });

  // Drill into a trial.
  const firstDot = page.locator('.matrix-dot').first();
  await expect(firstDot).toBeVisible();
  await firstDot.click();
  await expect(page.getByText('Trial detail ·')).toBeVisible();
  await expect(page.getByRole('tab', { name: /Checks/ })).toBeVisible();
  await page.getByRole('tab', { name: /Checks/ }).click();
  await expect(page.getByText('Created event matches the requested fields')).toBeVisible();
  await expect(page.getByText('Every existing event is byte-for-byte preserved')).toBeVisible();

  // Switch to the adapted condition for the same task.
  await page.getByRole('button', { name: /Adapted/ }).first().click();
  await expect(page.getByText('Executable adapter').first()).toBeVisible();
  await page.getByRole('tab', { name: /Trace/ }).click();
  await expect(page.getByText('Compiled original call')).toBeVisible();
  await page.getByRole('tab', { name: /State diff/ }).click();
  await expect(page.getByText(/added|No calendar changes/).first()).toBeVisible();
  await page.locator('.trial-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/screenshots/03-trial-detail-1440.png', fullPage: false });

  // Interfaces: validation error next to the editor, then reset.
  await page.getByRole('button', { name: 'Interfaces' }).click();
  await expect(page.getByRole('heading', { name: 'Tool interfaces' })).toBeVisible();
  const editor = page.getByLabel('Adapter specification · anvil.adapter/v1');
  await expect(editor).toBeVisible();
  const original = await editor.inputValue();
  const broken = JSON.parse(original) as { tools: Array<{ target: string }> };
  broken.tools[0]!.target = 'does_not_exist';
  await editor.fill(JSON.stringify(broken, null, 2));
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText('Adapter has errors')).toBeVisible();
  await expect(page.getByText(/is not an original tool/).first()).toBeVisible();

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Reset to default' }).click();
  await expect(page.getByText('Saved adapter removed; the built-in default is active.')).toBeVisible();

  await page.getByLabel('Import adapter JSON file').setInputFiles({
    name: 'adapter.json',
    mimeType: 'application/json',
    buffer: Buffer.from(original),
  });
  await expect(page.getByText('Imported adapter.json. Validate it before saving or running.')).toBeVisible();
  await page.getByLabel('Adapted tool').selectOption('schedule_event');

  // Mapping preview compiles without executing.
  await page.getByRole('button', { name: 'Preview compiled call' }).click();
  await expect(page.getByText('Original call · calendar_create_event')).toBeVisible();
  await expect(page.getByText('Not executed')).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/04-interfaces-1440.png', fullPage: false });

  // Export downloads with a real filename.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Adapter bundle' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('anvil-adapter-calendar.json');

  // Integration: real MCP handshake.
  await page.getByRole('button', { name: 'Integration' }).click();
  await expect(page.getByRole('heading', { name: 'Integration' })).toBeVisible();
  await expect(page.getByText('Not installed').first()).toBeVisible();
  await page.getByRole('button', { name: 'Run MCP handshake' }).click();
  await expect(page.getByText('Handshake succeeded')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('anvil_list_domains', { exact: true }).first()).toBeVisible();
  await page.locator('.mcp-result').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/screenshots/05-integration-1440.png', fullPage: false });

  // Narrow layout: readable, reachable navigation and no page-level horizontal overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Workbench' }).click();
  await expect(page.getByRole('heading', { name: 'Attempt outcomes' })).toBeVisible();
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 2);
  await page.screenshot({ path: 'docs/screenshots/06-narrow-workbench-390.png', fullPage: false });

  await page.getByRole('button', { name: 'Interfaces' }).click();
  await expect(page.getByRole('heading', { name: 'Tool interfaces' })).toBeVisible();
  const interfaceOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
  expect(interfaceOverflow).toBe(true);
  await page.screenshot({ path: 'docs/screenshots/07-narrow-interfaces-390.png', fullPage: false });
});

test('browser flow: keyboard and error states', async ({ page }) => {
  await page.goto('/');
  // The primary action is reachable by keyboard after loading.
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
  // A live run without a configured model opens the model panel, never a misleading start.
  await page.getByRole('button', { name: 'Run experiment' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Keys stay in this server process.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();

  // Invalid JSON in the adapter editor produces an inline error, not a crash.
  await page.getByRole('button', { name: 'Interfaces' }).click();
  const editor = page.getByLabel('Adapter specification · anvil.adapter/v1');
  await editor.fill('{ not json');
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText(/Invalid JSON/)).toBeVisible();
});
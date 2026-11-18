import { expect, test } from '@playwright/test';

test('demo day: import sample, optimize, mark a door, reload offline', async ({ page }) => {
  await page.goto('/README/blockwalk/');
  await page.locator('body[data-ready="1"]').waitFor();
  await page.evaluate(async () => {
    const ready = navigator.serviceWorker?.ready;
    if (ready) await ready;
  });
  await page.reload();
  await page.locator('body[data-ready="1"]').waitFor();
  await expect(page.getByTestId('demo-banner')).toContainText('Demo mode');

  const saves = () => page.locator('body').getAttribute('data-saves').then((v) => Number(v || 0));
  let n = await saves();
  await page.getByRole('button', { name: 'Import sample list' }).click();
  await page.waitForFunction((prev) => Number(document.body.dataset.saves || 0) > prev, n);
  await expect(page.getByTestId('stats')).toContainText(/30 doors/);

  n = await saves();
  await page.getByRole('button', { name: 'Optimize', exact: true }).click();
  await page.waitForFunction((prev) => Number(document.body.dataset.saves || 0) > prev, n);
  await expect(page.getByTestId('stats')).toContainText(/park point/);
  await expect(page.getByTestId('stats')).toContainText(/leave 10:00/);

  await page.getByRole('button', { name: 'Stops', exact: true }).click();
  n = await saves();
  await page.getByRole('button', { name: 'Not home' }).first().click();
  await page.waitForFunction((prev) => Number(document.body.dataset.saves || 0) > prev, n);
  await expect(page.getByTestId('stats')).toContainText(/not home/i);

  n = await saves();
  await page.getByRole('button', { name: 'Come back' }).nth(1).click();
  await page.waitForFunction((prev) => Number(document.body.dataset.saves || 0) > prev, n);
  await expect(page.getByTestId('stop-list')).toContainText(/come back/i);

  await page.context().setOffline(true);
  await page.reload();
  await page.locator('body[data-ready="1"]').waitFor();
  await expect(page.getByTestId('stats')).toContainText(/not home/i);
  await expect(page.getByTestId('demo-banner')).toBeVisible();
});

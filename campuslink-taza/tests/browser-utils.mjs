import {existsSync} from 'node:fs';
export function browserOptions(){const candidate=process.env.CAMPUS_CHROMIUM||'/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';return {headless:true,args:['--no-sandbox'],...(existsSync(candidate)?{executablePath:candidate}:{})};}

// Exercise the interface available at the current viewport, including phone
// settings, rather than clicking controls hidden by responsive styles.
export async function selectLanguage(page, language) {
  const value = language.toLowerCase();
  if (await page.locator('html').getAttribute('lang') === value) return;
  const visible = page.locator('.language-selector').getByRole('button', { name: language.toUpperCase(), exact: true });
  if (await visible.first().isVisible()) {
    await visible.first().click();
  } else if (new URL(page.url()).pathname.startsWith('/app')) {
    const destination = page.url();
    await page.goto(new URL('/app/settings', destination).href);
    const response = page.waitForResponse(r => r.url().endsWith('/api/profile') && r.request().method() === 'PATCH');
    await page.locator(`.study-language-options label:has(input[value="${value}"])`).click();
    const saved = await response;
    if (!saved.ok()) throw new Error(`Language selection failed (${saved.status()}).`);
    await page.goto(destination);
  } else {
    await page.locator('.public-menu').click();
    await page.locator('.public-settings-drawer .language-selector').getByRole('button', { name: language.toUpperCase(), exact: true }).click();
    await page.keyboard.press('Escape');
  }
  await page.waitForFunction(expected => document.documentElement.lang === expected, value);
  if (new URL(page.url()).pathname.startsWith('/app')) {
    await page.locator('.app-shell').waitFor({ state: 'visible' });
  }
}

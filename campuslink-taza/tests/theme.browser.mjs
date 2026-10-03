import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {browserOptions,selectLanguage} from './browser-utils.mjs';
const origin=process.env.CAMPUS_BROWSER_ORIGIN||'http://localhost:5173';
const browser=await chromium.launch(browserOptions());
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
async function appearance(theme){await expect(page.locator('html')).toHaveAttribute('data-theme',theme);assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),theme);}
try {
  await page.goto(origin+'/');await page.locator('.hero-copy h1').waitFor();
  await appearance('dark');
  const toggle=page.getByRole('button',{name:'Activer le mode clair',exact:true});
  await toggle.focus();await page.keyboard.press('Enter');await appearance('light');
  await expect(page.getByRole('button',{name:'Activer le mode sombre',exact:true})).toHaveAttribute('aria-pressed','false');
  await expect.poll(()=>page.evaluate(()=>localStorage.getItem('campus-theme'))).toBe('light');
  await page.reload();await page.locator('.hero-copy h1').waitFor();await appearance('light');
  const other=await context.newPage();await other.goto(origin+'/login');await expect(other.locator('html')).toHaveAttribute('data-theme','light');
  await other.locator('.theme-toggle').click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await other.close();
  await page.locator('.theme-toggle').click();await appearance('light');
  await page.locator('.theme-toggle').click();await appearance('dark');
  console.log('PASS keyboard theme control, saved preference, reload and cross-tab synchronization');
  await page.goto(origin+'/login');await appearance('dark');
  await page.locator('input[autocomplete=username]').fill('admin');
  await page.locator('input[autocomplete=current-password]').fill('Admin2026!');
  await page.locator('.login-form-wrap form >button').click();await page.waitForURL('**/app');
  for(const route of ['/app','/app/chat/general','/app/resources','/app/admin']){
    await page.goto(origin+route);await appearance('dark');await expect(page.locator('.theme-toggle')).toBeVisible();
    const background=await page.locator('.app-header').evaluate(el=>getComputedStyle(el).backgroundColor);
    assert.equal(background,'rgb(29, 27, 24)',route+' uses dark surfaces');
  }
  console.log('PASS dark public pages, login, community, resources and administration');
  await page.setViewportSize({width:390,height:844});
  await selectLanguage(page,'AR');
  await expect(page.locator('html')).toHaveAttribute('dir','rtl');
  await expect(page.locator('.app-header .theme-toggle')).toBeHidden();
  await expect(page.locator('.app-header .language-selector')).toBeHidden();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.goto(origin+'/app/settings');
  await page.locator('.study-appearance-options button[data-theme-option="light"]').click();await appearance('light');
  await selectLanguage(page,'FR');
  await page.request.post(origin+'/api/logout');await page.goto(origin+'/');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await appearance('light');assert.deepEqual(errors,[]);
  await expect(page.locator('.public-header .theme-toggle')).toBeHidden();
  await page.locator('.public-menu').click();
  await expect(page.locator('.public-settings-drawer .theme-toggle')).toBeVisible();
  await page.keyboard.press('Escape');
  console.log('PASS mobile RTL, settings-only appearance controls and return to light mode without overflow');
} finally {await context.close();await browser.close();}

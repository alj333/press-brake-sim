import { expect, test } from '@playwright/test';
import { collectErrors, openApp } from './helpers.ts';

test.use({ hasTouch: true });

test('factory tooling is grouped by stock, labelled by die slot and usable in Thai on touch layouts', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await page.getByTestId('tab-tools').click();

  const punch = page.getByTestId('station-punch-S1');
  const die = page.getByTestId('station-die-S1');
  for (const select of [punch, die]) {
    const groups = select.locator('optgroup');
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0)).toHaveAttribute('label', 'In stock');
    await expect(groups.nth(1)).toHaveAttribute('label', 'Not currently in stock');
    await expect(select.locator('option:checked')).toHaveAttribute('data-stock-status', 'in-stock');
    const box = await select.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  await expect(punch.locator('option:checked')).toContainText('MotionX core punch 86° R0.6');
  await expect(die.locator('option:checked')).toContainText(/Die slot \d+/);
  await expect(page.getByTestId('die-slot-summary')).toContainText(/Die slot \d+/);
  await expect(page.getByTestId('punch-segment-inventory')).toContainText('10 mm × 1, 15 mm × 1, 20 mm × 1, 50 mm × 1, 100 mm × 2, 200 mm × 1, 300 mm × 1, 835 mm × 2');
  await expect(page.getByTestId('setup-warnings')).toContainText('selected higher-quality purchase drawing specifies 86° / R0.6');
  await expect(page.getByTestId('setup-warnings')).toContainText('approximately 90° / R0.2');
  await expect(page.getByTestId('setup-warnings')).toContainText('Confirm the fitted punch geometry before production.');
  await expect(page.getByTestId('setup-warnings')).toContainText('Bend calculations use controller values; collision checks use the A360 mesh-derived outline.');

  const motionXPunchId = await punch.inputValue();
  const unavailablePunch = punch.locator('optgroup').nth(1).locator('option').first();
  const unavailableId = await unavailablePunch.getAttribute('value');
  expect(unavailableId).toBeTruthy();
  await punch.selectOption(unavailableId!);
  await expect(punch.locator('option:checked')).toContainText('Not currently in stock');
  await expect(page.getByTestId('station-punch-S1-stock-warning')).toHaveText('Selected tool is not currently in stock');

  await page.getByTestId('language-toggle').click();
  await expect(punch.locator('optgroup').nth(0)).toHaveAttribute('label', 'มีในสต็อก');
  await expect(punch.locator('optgroup').nth(1)).toHaveAttribute('label', 'ขณะนี้ไม่มีในสต็อก');
  await expect(page.getByTestId('station-punch-S1-stock-warning')).toHaveText('เครื่องมือที่เลือกขณะนี้ไม่มีในสต็อก');
  await punch.selectOption(motionXPunchId);
  await expect(punch.locator('option:checked')).toContainText('MotionX core punch 86° R0.6');
  await expect(page.getByTestId('die-slot-summary')).toContainText('ร่องดายหมายเลข');
  await expect(page.getByTestId('setup-warnings')).toContainText('แบบเอกสารการซื้อที่คมชัดกว่าซึ่งเลือกใช้ระบุ 86° / R0.6');
  await expect(page.getByTestId('setup-warnings')).toContainText('ประมาณ 90° / R0.2');
  await expect(page.getByTestId('setup-warnings')).toContainText('โปรดยืนยันรูปทรงพั้นช์ที่ติดตั้งจริงก่อนผลิต');
  await expect(page.getByTestId('setup-warnings')).toContainText('ระบบใช้ค่าคอนโทรลคำนวณการพับ และใช้แนวรูปทรงที่ถอดจากเมช A360 ตรวจการชน');
  await expect(page.getByTestId('setup-warnings')).toContainText('ยังไม่ได้ยืนยันความยาวและจำนวนท่อนดาย');

  const overflow = await page.evaluate('document.documentElement.scrollWidth - window.innerWidth');
  expect(overflow).toBeLessThanOrEqual(1);
  errors.assertClean();
});

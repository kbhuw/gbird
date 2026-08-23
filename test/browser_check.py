from pathlib import Path
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parent.parent


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
    console_errors = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)

    page.goto("http://127.0.0.1:4189")
    page.wait_for_load_state("networkidle")
    assert page.get_by_role("heading", name="gbird").is_visible()
    assert page.locator(".session-item").count() == 3
    assert page.locator("#connection-line").count() == 0

    page.locator(".filter-trigger").click()
    page.get_by_role("button", name="cookiejar", exact=True).click()
    page.wait_for_load_state("networkidle")
    assert page.locator(".session-item").count() == 1
    assert "1 session · cookiejar" in page.locator("#result-count").inner_text()

    row = page.locator(".show-session").first
    row.click()
    page.wait_for_selector("#session-dialog")
    assert page.get_by_role("heading", name="Add explicit site sign-in verification").is_visible()
    assert page.locator(".timeline-node").count() >= 4
    assert page.get_by_role("link", name="JSON").get_attribute("href").endswith("/export")

    page.screenshot(path=str(ROOT / "timeline.png"), full_page=True)
    page.keyboard.press("Escape")
    assert page.locator("#dialog-layer").is_hidden()
    assert row.evaluate("node => document.activeElement === node")
    assert not console_errors, console_errors
    browser.close()

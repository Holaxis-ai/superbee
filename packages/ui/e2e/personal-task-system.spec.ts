import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { bootUiOverPersonalTaskSystemBundle, CLI_DIST, openRegisteredView } from "./harness.js";

test("the Personal Task System board projects links live and commits a confirmed status change", async ({ page }) => {
  const ui = await bootUiOverPersonalTaskSystemBundle();
  try {
    await page.goto(ui.url);
    await openRegisteredView(page, "views-registry/personal-task-system-board");
    const frame = page.frameLocator("iframe.page-frame-iframe");

    await expect(frame.getByRole("heading", { name: "Personal task board" })).toBeVisible();
    await expect(frame.locator("#summary")).toContainText("6 tasks");
    await expect(frame.locator(".card")).toHaveCount(6);
    await expect(frame.getByRole("heading", { name: "Shape launch message" })).toBeVisible();
    await expect(frame.locator(".chip.project").first()).toHaveText("Product launch");
    await expect(frame.locator('[data-task="tasks/build-demo"] .dependency')).toHaveText("Depends on 1 task");
    await expect(frame.locator('[data-task="constructor"] .dependency')).toHaveText("Depends on 1 task");
    await expect(frame.locator(".column").nth(4).locator('[data-task="tasks/canceled-idea"]')).toBeVisible();

    const canceledCard = frame.locator('[data-task="tasks/canceled-idea"]');
    await canceledCard.getByRole("button", { name: "Reopen" }).click();
    const canceledDialog = page.getByRole("dialog", { name: "Apply this bundle change?" });
    const cancel = canceledDialog.getByRole("button", { name: "Cancel" });
    await expect(cancel).toBeEnabled();
    await cancel.click();
    await expect(frame.locator("#toast")).toHaveText("Change cancelled.");
    await expect(frame.locator("#toast")).toHaveClass("toast show");

    await frame.getByLabel("Filter by project").selectOption("projects/launch");
    await expect(frame.locator(".card")).toHaveCount(2);
    await frame.getByLabel("Filter by project").selectOption("all");

    const todoCard = frame.locator('[data-task="tasks/shape-message"]');
    await expect(todoCard.locator('[data-edit="due"]')).toHaveValue("2026-08-01");
    await todoCard.getByText("Quick edit").click();
    await todoCard.getByRole("button", { name: "Propose priority" }).click();
    await expect(frame.locator("#toast")).toHaveText("Change unchanged.");
    await expect(frame.locator("#toast")).toHaveClass("toast show");
    await todoCard.getByRole("button", { name: "Start" }).click();
    const dialog = page.getByRole("dialog", { name: "Apply this bundle change?" });
    await expect(dialog).toContainText("tasks/shape-message");
    await expect(dialog).toContainText("todo");
    await expect(dialog).toContainText("in_progress");
    const apply = dialog.getByRole("button", { name: "Apply change" });
    await expect(apply).toBeEnabled();
    await apply.click();

    await expect(frame.locator('[data-task="tasks/shape-message"]')).toBeVisible();
    await expect(frame.locator(".column").nth(1).locator('[data-task="tasks/shape-message"]')).toBeVisible();
    const persisted = JSON.parse(
      execFileSync(process.execPath, [CLI_DIST, "doc", "read", "tasks/shape-message", "--dir", ui.dir, "--json"], { encoding: "utf8" }),
    );
    expect(persisted.superbee_progress_status).toBe("in_progress");
    expect(persisted.superbee_updated_by).toBe("e2e/human");
  } finally {
    await ui.cleanup();
  }
});

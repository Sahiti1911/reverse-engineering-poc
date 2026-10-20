#!/usr/bin/env node
// Creates (or extends) Zephyr test cases for the 9_Gaps rows (8_Gaps or 6_Gaps in older workbooks) a reviewer marked "Approve".
// Dry run by default: prints what would happen. --yes performs it. Zephyr has NO delete endpoint.
//   node scripts/create-approved.mjs <workbook.xlsx> [--profile avl] [--yes]
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { loadEnv, loadProfile, requireEnv } from "./lib/config.mjs";
import { readGapSheet, parseSteps } from "./lib/workbook.mjs";
import { zephyrClientFor, caseUrl, toStepItems, bddToHtml } from "./lib/zephyr.mjs";

function planRow(row) {
  const action = row["Action"] || "create";
  const steps = parseSteps(row["Steps (n. action [data: x] => expected)"]);
  const problems = [];
  if (!steps.length) problems.push("no parseable steps (format: 'n. action [data: x] => expected', one per line)");
  if (action === "create") {
    if (!row["Draft name"]) problems.push("Draft name is empty");
    if (!/^\d+$/.test(row["Folder id"] ?? "")) problems.push("Folder id is not a number");
    if (!["Low", "Medium", "High", "Critical"].includes(row["Priority"])) problems.push(`Priority '${row["Priority"]}' is not Low/Medium/High/Critical`);
    if (!/^\d+$/.test(row["Story issue id"] ?? "")) problems.push("Story issue id missing");
  } else if (action === "extend") {
    if (!/^[A-Z][A-Z0-9_]*-T\d+$/.test(row["Extend key"] ?? "")) problems.push(`Extend key '${row["Extend key"]}' is not a test case key`);
  } else {
    problems.push(`Unknown action '${action}'`);
  }
  return { action, steps, problems };
}

export async function createApproved({ file, profileName, yes = false }) {
  loadEnv();
  requireEnv("ZEPHYR_API_TOKEN");
  const abs = path.resolve(file);
  const sheet = await readGapSheet(abs);
  const profile = loadProfile(profileName ?? sheet.profileName);
  const col = Object.fromEntries(sheet.headers.map((h, i) => [h, i]).filter(([h]) => h));
  const approved = sheet.rows.filter((r) => r["Review decision"] === "Approve" && !r["Created key"]);
  const already = sheet.rows.filter((r) => r["Created key"]).length;
  console.log(`${path.basename(abs)}: ${sheet.rows.length} gap rows, ${approved.length} approved and not yet created, ${already} already created.`);
  if (!approved.length) return;

  const plans = approved.map((row) => ({ row, ...planRow(row) }));
  for (const p of plans) {
    const target = p.action === "create" ? `create in folder ${p.row["Folder id"]} and link to ${p.row["Story"]}` : `append ${p.steps.length} step(s) to ${p.row["Extend key"]}`;
    console.log(`  ${p.row["Gap ID"]}: ${p.action === "create" ? `"${p.row["Draft name"]}" — ` : ""}${target}, ${p.steps.length} steps${p.problems.length ? `  ✗ ${p.problems.join("; ")}` : ""}`);
  }
  const valid = plans.filter((p) => !p.problems.length);
  // "Approve" can be the pre-filled suggestion. Say how many nobody has touched, so a bulk --yes is a conscious choice.
  const untouched = approved.filter((r) => r["Suggested decision"] === "Approve" && !r["Reviewer notes"]).length;
  if (!yes) {
    console.log(`\nDry run. ${valid.length} row(s) are ready${valid.length < plans.length ? `, ${plans.length - valid.length} need fixing in the workbook` : ""}.`);
    if (untouched) console.log(`Note: ${untouched} of the approved rows still carry the pre-filled suggestion with no reviewer notes — make sure they were reviewed.`);
    console.log("Zephyr has no delete endpoint. Re-run with --yes to create them.");
    return;
  }

  const client = zephyrClientFor(profile);
  const save = async () => {
    try {
      await sheet.wb.xlsx.writeFile(abs);
    } catch (err) {
      if (err.code === "EBUSY") throw new Error(`${abs} is open in Excel. Close it; created keys so far are printed above — add them by hand or re-run (already-created rows are skipped only if their key was saved).`);
      throw err;
    }
  };
  let done = 0;
  for (const p of valid) {
    const r = p.row;
    let key;
    if (p.action === "create") {
      const created = await client.request("POST", "/testcases", {
        body: {
          projectKey: profile.zephyr.projectKey,
          name: r["Draft name"],
          objective: r["Objective"] || undefined,
          precondition: r["Precondition"] || undefined,
          folderId: Number(r["Folder id"]),
          statusName: profile.zephyr.defaults?.status ?? "Draft",
          priorityName: r["Priority"],
          labels: (r["Labels"] ?? "").split(",").map((l) => l.trim()).filter(Boolean),
          customFields: {
            "BDD Script": bddToHtml(r["BDD"]),
            "Automation Status": profile.zephyr.defaults?.automationStatus ?? "Not Automated",
          },
        },
      });
      key = created.key;
      // Record the key before anything else can fail, so a re-run never creates a duplicate.
      sheet.ws.getCell(r._row, col["Created key"]).value = { text: key, hyperlink: caseUrl(profile, key) ?? "" };
      await save();
      await client.request("POST", `/testcases/${key}/teststeps`, { body: { mode: "OVERWRITE", items: toStepItems(p.steps) } });
      await client.request("POST", `/testcases/${key}/links/issues`, { body: { issueId: Number(r["Story issue id"]) } });
      console.log(`  ✓ ${r["Gap ID"]} → created ${key}, ${p.steps.length} steps, linked to ${r["Story"]}`);
    } else {
      await client.request("POST", `/testcases/${r["Extend key"]}/teststeps`, { body: { mode: "APPEND", items: toStepItems(p.steps) } });
      key = `${r["Extend key"]} (+${p.steps.length} steps)`;
      sheet.ws.getCell(r._row, col["Created key"]).value = key;
      await save();
      console.log(`  ✓ ${r["Gap ID"]} → appended ${p.steps.length} steps to ${r["Extend key"]}`);
    }
    done++;
  }
  console.log(`\n${done} change(s) made in Zephyr. Keys written to the "Created key" column of ${path.basename(abs)}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { profile: { type: "string" }, yes: { type: "boolean" } } });
  if (!positionals[0]) {
    console.error("Usage: node scripts/create-approved.mjs <workbook.xlsx> [--profile <name>] [--yes]");
    process.exit(2);
  }
  createApproved({ file: positionals[0], profileName: values.profile, yes: values.yes }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

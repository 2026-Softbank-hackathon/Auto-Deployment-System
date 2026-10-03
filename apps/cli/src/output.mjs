import { pick } from "./template.mjs";

/** 한글 · 한자 · 가나는 터미널에서 두 칸 */
export function displayWidth(text) {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    const wide = (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xff60);
    width += wide ? 2 : 1;
  }
  return width;
}

const pad = (text, width) => text + " ".repeat(Math.max(0, width - displayWidth(text)));

function cell(value) {
  if (value === undefined || value === null || value === "") return "-";
  if (typeof value === "boolean") return value ? "예" : "아니오";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function printTable(rows, columns) {
  if (!Array.isArray(rows) || rows.length === 0) { console.log("(없음)"); return; }
  const cells = rows.map((row) => columns.map((column) => cell(pick(row, column.key))));
  const widths = columns.map((column, index) => Math.max(displayWidth(column.label), ...cells.map((row) => displayWidth(row[index]))));
  console.log(columns.map((column, index) => pad(column.label, widths[index])).join("  ").trimEnd());
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of cells) console.log(row.map((text, index) => pad(text, widths[index])).join("  ").trimEnd());
}

export function printObject(value, fields) {
  const width = Math.max(...fields.map((field) => displayWidth(field.label)));
  for (const field of fields) console.log(`${pad(field.label, width)}  ${cell(pick(value, field.key))}`);
}

/** 응답 필드로 문장 채우기 — 값이 없으면 "-" */
export function fillMessage(template, value) {
  return template.replace(/\{([\w.]+)\}/g, (_, path) => cell(pick(value, path)));
}

/** 명령 정의의 output 대로 응답을 찍는다 */
export function printResult(output, value) {
  switch (output.kind) {
    case "table":
      printTable(pick(value, output.items) ?? [], output.columns);
      break;
    case "object":
      printObject(value ?? {}, output.fields);
      break;
    case "text": {
      const text = typeof value === "string" ? value : "";
      if (!text) { console.log("(로그 없음)"); break; }
      const pattern = output.stripPattern ? new RegExp(output.stripPattern) : null;
      console.log(text.split("\n").map((line) => (pattern ? line.replace(pattern, "") : line)).join("\n").trimEnd());
      break;
    }
    case "message":
      console.log(fillMessage(output.text, value ?? {}));
      break;
    default:
      break;
  }
}

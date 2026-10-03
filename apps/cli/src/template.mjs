/** 점으로 이어진 경로로 값 꺼내기 ("live.deploymentId"). 경로가 "" 면 값 자체 */
export function pick(value, path) {
  if (!path) return value;
  return path.split(".").reduce((current, key) => (current == null ? undefined : current[key]), value);
}

/**
 * 템플릿의 "{name.sub}" 하나를 값으로. 인자 값이 resolver 로 찾은 객체면
 * "{name}" 은 그 객체의 대표 필드(valueField), "{name.sub}" 는 객체의 하위 필드.
 */
export function lookup(context, expression) {
  const [head, ...rest] = expression.split(".");
  const entry = context[head];
  if (entry && typeof entry === "object" && "resolved" in entry) {
    return rest.length === 0 ? entry.resolved[entry.valueField] : pick(entry.resolved, rest.join("."));
  }
  return rest.length === 0 ? entry : pick(entry, rest.join("."));
}

const SINGLE = /^\{([\w.]+)\}$/;
const ANY = /\{([\w.]+)\}/g;

/** 문자열 안의 "{...}" 를 모두 바꾼다. 하나라도 값이 없으면 undefined (호출한 쪽이 빼거나 오류로 다룬다) */
export function renderString(template, context) {
  let missing = false;
  const out = template.replace(ANY, (_, expression) => {
    const value = lookup(context, expression);
    if (value === undefined || value === null) { missing = true; return ""; }
    return String(value);
  });
  return missing ? undefined : out;
}

/** 경로 — 값이 없으면 무엇이 없는지 알려 준다 */
export function renderPath(template, context) {
  return template.replace(ANY, (_, expression) => {
    const value = lookup(context, expression);
    if (value === undefined || value === null) throw new Error(`${expression} 값이 없어요`);
    return encodeURIComponent(String(value));
  });
}

/** 쿼리 — 값이 없는 항목은 뺀다 */
export function renderQuery(query, context) {
  const params = new URLSearchParams();
  for (const [key, template] of Object.entries(query ?? {})) {
    const value = renderString(template, context);
    if (value !== undefined && value !== "") params.set(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * 본문 — "$name" 은 인자 값을 타입 그대로, "{...}" 는 문자열로. 값이 없는 키는 뺀다. null 은 그대로 둔다(지우기).
 */
export function renderBody(template, context) {
  if (template === null) return null;
  if (typeof template === "string") {
    if (template.startsWith("$")) {
      const entry = context[template.slice(1)];
      const value = entry && typeof entry === "object" && "resolved" in entry ? entry.resolved[entry.valueField] : entry;
      return value === null ? undefined : value;
    }
    return SINGLE.test(template) || template.includes("{") ? renderString(template, context) : template;
  }
  if (Array.isArray(template)) return template.map((item) => renderBody(item, context)).filter((item) => item !== undefined);
  if (typeof template === "object") {
    const out = {};
    for (const [rawKey, rawValue] of Object.entries(template)) {
      const key = renderString(rawKey, context);
      if (key === undefined) continue;
      const value = renderBody(rawValue, context);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  return template;
}

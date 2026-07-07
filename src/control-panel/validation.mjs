export function requireString(value, field, maxLength = 240) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${field} 不能为空`);
  if (text.length > maxLength) throw new Error(`${field} 太长`);
  return text;
}

export function optionalString(value, maxLength = 500) {
  const text = String(value || "").trim();
  if (text.length > maxLength) throw new Error("输入内容太长");
  return text;
}

export function safeInteger(value, field, fallback, min, max) {
  const raw = value == null || value === "" ? fallback : value;
  const number = Number(raw);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${field} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return number;
}
